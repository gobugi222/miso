/**
 * Secret Network + SNVR 연동
 * SNIP-20 잔액, GhostSwap, Mixer
 */
import { SecretNetworkClient, Wallet } from "secretjs";
import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

let config = null;
let queryClient = null;
let txClient = null;

const DECIMALS = 9;

// Permit 조회가 probe 루틴 때문에 느려지는 문제 방지:
// viewing key처럼 "짧은 타임아웃 + LCD 후보 순회"로 바로 getBalance를 시도한다.
const LCD_PROBE_PER_URL_MS = Math.max(4000, Math.min(25000, Number(process.env.LCD_PROBE_PER_URL_MS) || 20000));
const LCD_MAX_URLS = Math.max(1, Math.min(3, Number(process.env.LCD_MAX_URLS) || 2));
function withLcdTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("LCD_TIMEOUT_" + ms + "ms")), ms)),
  ]);
}

// Short cache to smooth LCD jitter (do NOT treat as authoritative long-term).
// Keyed by secret address only; permit must authorize that address anyway.
const BAL_CACHE_TTL_MS = Math.max(3000, Math.min(30000, Number(process.env.BAL_CACHE_TTL_MS) || 12000));
const balCache = new Map(); // address -> { at, amount }

/** mainnet 조회용: 한 LCD가 HTML/502/invalid json을 줄 때 순서대로 재시도 */
function getLcdCandidates() {
  loadConfig();
  const primary = String(process.env.LCD_URL || config.lcd_url || "http://localhost:1317").replace(/\/$/, "");
  const fromEnv = (process.env.LCD_URL_FALLBACKS || "")
    .split(",")
    .map((s) => s.trim().replace(/\/$/, ""))
    .filter(Boolean);
  const chain = String(config.chain_id || "");
  const isMainnet = chain === "secret-4" || chain.includes("secret-4");
  const baked = isMainnet
    ? ["https://rest.lavenderfive.com/secretnetwork", "https://lcd.secret.express"]
    : [];
  const out = [];
  const seen = new Set();
  for (const u of [primary, ...fromEnv, ...baked]) {
    if (!u || seen.has(u)) continue;
    seen.add(u);
    out.push(u);
  }
  return out.slice(0, LCD_MAX_URLS);
}

function forceLcdUrl(url) {
  loadConfig();
  config.lcd_url = String(url).replace(/\/$/, "");
  queryClient = null;
}

function loadConfig() {
  if (config) return config;
  const paths = [
    join(__dirname, "../../Secret-Network/scripts/deploy-full.json"),
    join(process.cwd(), "Secret-Network/scripts/deploy-full.json"),
  ];
  let full = {};
  for (const p of paths) {
    if (existsSync(p)) {
      full = JSON.parse(readFileSync(p, "utf8"));
      break;
    }
  }
  const ghostPaths = [
    join(__dirname, "../../Secret-Network/scripts/deploy-ghostswap.json"),
    join(process.cwd(), "Secret-Network/scripts/deploy-ghostswap.json"),
  ];
  let ghost = {};
  for (const p of ghostPaths) {
    if (existsSync(p)) {
      ghost = JSON.parse(readFileSync(p, "utf8"));
      break;
    }
  }
  config = {
    snvr_token: full.snvr_token || process.env.SNVR_TOKEN || null,
    snvr_code_hash: full.snvr_code_hash || process.env.SNVR_CODE_HASH || null,
    mixer_address: full.mixer_address,
    mixer_code_hash: full.mixer_code_hash,
    router_address: ghost.ghostswap_router_address,
    router_code_hash: ghost.ghostswap_router_code_hash,
    ghostswap_pair_address: ghost.scrt_snvr_pair_address || process.env.GHOSTSWAP_PAIR_ADDRESS || null,
    ghostswap_pair_code_hash: ghost.ghostswap_pair_code_hash || process.env.GHOSTSWAP_PAIR_CODE_HASH || null,
    native_swap_denom: process.env.NATIVE_SWAP_DENOM || "uscrt",
    chain_id: full.chain_id || process.env.CHAIN_ID || "secretdev-1",
    lcd_url: process.env.LCD_URL || "http://localhost:1317",
  };
  return config;
}

/** SCRT↔SNVR 페어가 설정돼 있는지 (deploy-ghostswap.json 또는 env) */
export function isGhostswapPairConfigured() {
  const c = loadConfig();
  return !!(c.ghostswap_pair_address && c.ghostswap_pair_code_hash && c.snvr_token && c.snvr_code_hash);
}

/**
 * GhostSwap AMM: 수령할 SNVR(최소단위) 기준 역시뮬 → 필요한 native(uscrt) 입력량
 */
export async function ghostswapReverseSimulationSnvrOut(snvrOutRaw) {
  const c = loadConfig();
  if (!isGhostswapPairConfigured()) {
    return { ok: false, error_code: "PAIR_NOT_CONFIGURED", error: "GhostSwap pair or SNVR not in config" };
  }
  const raw = String(Math.floor(Number(snvrOutRaw)));
  if (raw === "0" || Number(raw) <= 0) {
    return { ok: false, error_code: "INVALID_AMOUNT", error: "snvrOutRaw must be positive" };
  }
  const ask_asset = {
    info: {
      token: {
        contract_addr: c.snvr_token,
        token_code_hash: c.snvr_code_hash,
        viewing_key: "",
      },
    },
    amount: raw,
  };
  const client = getQueryClient();
  try {
    const r = await client.query.compute.queryContract({
      contract_address: c.ghostswap_pair_address,
      code_hash: c.ghostswap_pair_code_hash,
      query: { reverse_simulation: { ask_asset } },
    });
    const offer = r?.offer_amount != null ? String(r.offer_amount).replace(/\..*$/, "") : null;
    if (!offer || offer === "0") {
      return { ok: false, error_code: "SIM_FAIL", error: "reverse_simulation returned no offer_amount", raw: r };
    }
    return { ok: true, offer_amount: offer, spread_amount: r.spread_amount, commission_amount: r.commission_amount, simulation: r };
  } catch (e) {
    return { ok: false, error_code: "LCD_QUERY", error: String(e?.message || e) };
  }
}

export function isSecretEnabled() {
  const c = loadConfig();
  return !!(c.snvr_token && c.snvr_code_hash);
}

function getQueryClient() {
  if (queryClient) return queryClient;
  const c = loadConfig();
  queryClient = new SecretNetworkClient({
    url: c.lcd_url,
    chainId: c.chain_id,
  });
  return queryClient;
}

function getEphemeralQueryClient(url) {
  const c = loadConfig();
  return new SecretNetworkClient({ url, chainId: c.chain_id });
}

function getTxClient() {
  if (txClient) return txClient;
  const mnemonic = process.env.MNEMONIC;
  if (!mnemonic) return null;
  const wallet = new Wallet(mnemonic);
  const c = loadConfig();
  txClient = new SecretNetworkClient({
    chainId: c.chain_id,
    url: c.lcd_url,
    wallet,
    walletAddress: wallet.address,
  });
  return txClient;
}

async function probeVkBalanceOnLcd(url, address, viewingKey, token, codeHash) {
  try {
    const client = getEphemeralQueryClient(url);
    const result = await withLcdTimeout(
      client.query.snip20.getBalance({
        contract: { address: token, code_hash: codeHash },
        address: String(address).trim(),
        auth: { key: String(viewingKey).trim() },
      }),
      LCD_PROBE_PER_URL_MS
    );
    return { ok: true, amount: result?.balance?.amount ?? "0" };
  } catch (e) {
    const lastMsg = String(e?.message || "");
    console.warn("getSnvrBalance error (" + url + "):", lastMsg);
    if (lastMsg.includes("viewing_key") || lastMsg.includes("Wrong viewing key") || lastMsg.includes("viewing key")) {
      return { ok: false, vkInvalid: true };
    }
    return { ok: false, vkInvalid: false };
  }
}

/** SNIP-20 잔액 조회 (address + viewing_key) — LCD 후보 병렬 시도로 총 소요 시간을 ~1 URL 분량으로 줄임 (ce=budget 완화) */
export async function getSnvrBalance(address, viewingKey) {
  const c = loadConfig();
  if (!c.snvr_token || !c.snvr_code_hash) return null;
  const urls = getLcdCandidates();
  if (urls.length === 0) return null;
  const results = await Promise.all(
    urls.map((url) => probeVkBalanceOnLcd(url, address, viewingKey, c.snvr_token, c.snvr_code_hash))
  );
  const hit = results.find((r) => r.ok);
  if (hit) return hit.amount;
  if (results.some((r) => r.vkInvalid)) throw new Error("VIEWING_KEY_INVALID");
  return null;
}

async function fetchPermitBalanceViaGateway(addr, permit) {
  const base = (process.env.QUERY_GATEWAY_URL || "").trim().replace(/\/$/, "");
  if (!base) return null;
  const c = loadConfig();
  const token = (process.env.QUERY_GATEWAY_TOKEN || "").trim();
  const clientMs = Math.max(5000, Math.min(60000, Number(process.env.QUERY_GATEWAY_CLIENT_TIMEOUT_MS) || 25000));
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), clientMs);
  try {
    const res = await fetch(base + "/v1/snvr/balance", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: "Bearer " + token } : {}),
      },
      body: JSON.stringify({
        chain_id: c.chain_id,
        lcd_urls: getLcdCandidates(),
        contract: { address: c.snvr_token, code_hash: c.snvr_code_hash, decimals: DECIMALS },
        wallet_address: addr,
        permit,
        // Gateway LCD 레이스용; 8s 캡은 slow LCD에서 전부 타임아웃나 permit 조회 실패로 이어짐 (max 20s)
        timeout_ms: Math.min(Math.max(LCD_PROBE_PER_URL_MS, 8000), 20000),
        cache_ttl_ms: BAL_CACHE_TTL_MS,
      }),
      signal: controller.signal,
    });
    const rawText = await res.text().catch(() => "");
    let data = {};
    try {
      data = rawText ? JSON.parse(rawText) : {};
    } catch {
      data = {};
    }
    if (!res.ok) {
      console.warn("[query-gateway] HTTP", res.status, rawText?.slice(0, 240) || "(empty)");
      const err = String(data?.error || "");
      if (err === "permit_invalid" || err.includes("permit")) throw new Error("PERMIT_INVALID");
      return null;
    }
    if (data && data.ok && data.balance_amount != null) {
      const amount = String(data.balance_amount);
      try {
        balCache.set(addr, { at: Date.now(), amount });
      } catch (_e) { /* ignore */ }
      return amount;
    }
    const err = String(data?.error || "");
    if (err === "permit_invalid" || err.includes("permit")) throw new Error("PERMIT_INVALID");
    return null;
  } catch (e) {
    if (e?.message === "PERMIT_INVALID") throw e;
    if (e?.name === "AbortError") console.warn("[query-gateway] fetch aborted (client timeout " + clientMs + "ms)");
    return null;
  } finally {
    clearTimeout(t);
  }
}

/** SNIP-20 잔액 조회 (address + permit) */
export async function getSnvrBalanceWithPermit(address, permit) {
  const c = loadConfig();
  if (!c.snvr_token || !c.snvr_code_hash) return null;
  if (!permit || typeof permit !== "object") throw new Error("PERMIT_INVALID");
  const addr = String(address).trim();

  // 0) Short cache: returns instantly when we recently succeeded.
  try {
    const cached = balCache.get(addr);
    if (cached && Date.now() - Number(cached.at || 0) < BAL_CACHE_TTL_MS) return String(cached.amount ?? "0");
  } catch (_eCache) { /* ignore */ }

  // 1) Query Gateway (US VPS 등) — 설정 시 LCD 직접 호출보다 우선
  try {
    const viaGw = await fetchPermitBalanceViaGateway(addr, permit);
    if (viaGw != null) return viaGw;
  } catch (e) {
    if (e?.message === "PERMIT_INVALID") throw e;
  }

  const urls = getLcdCandidates();
  const queryOnUrl = async (url) => {
    const client = getEphemeralQueryClient(url);
    const r = await withLcdTimeout(
      client.query.snip20.getBalance({
        contract: { address: c.snvr_token, code_hash: c.snvr_code_hash },
        address: addr,
        auth: { permit },
      }),
      LCD_PROBE_PER_URL_MS
    );
    const amount = r?.balance?.amount ?? "0";
    // cache success
    try { balCache.set(addr, { at: Date.now(), amount }); } catch (_eSet) { /* ignore */ }
    return amount;
  };

  // 1) Race the first two LCDs to reduce worst-case latency.
  const a = urls[0];
  const b = urls[1];
  if (a && b) {
    try {
      const amount = await Promise.any([queryOnUrl(a), queryOnUrl(b)]);
      return amount;
    } catch (_eRace) {
      // fall through to sequential attempts
    }
  }

  // 2) Sequential fallback for remaining candidates.
  for (const url of urls) {
    if (!url) continue;
    try {
      return await queryOnUrl(url);
    } catch (e) {
      const msg = String(e?.message || "");
      const low = msg.toLowerCase();
      if (low.includes("permit") || low.includes("signature") || low.includes("permission")) {
        throw new Error("PERMIT_INVALID");
      }
      // else: try next LCD
    }
  }
  return null;
}

async function getSnvrBalanceWithPermitProbeOnCurrentLcd(address, permit, c) {
  const client = getQueryClient();
  const target = String(address).trim();
  const candidates = [];
  const errors = [];
  const pickAmount = (v) => {
    if (v == null) return;
    const n = Number(v);
    if (Number.isFinite(n) && n >= 0) candidates.push(Math.floor(n));
  };

  try {
    const r1 = await client.query.snip20.getBalance({
      contract: { address: c.snvr_token, code_hash: c.snvr_code_hash },
      address: target,
      auth: { permit },
    });
    pickAmount(r1?.balance?.amount);
  } catch (_e1) {
    errors.push("path1:" + String(_e1?.message || "unknown"));
  }

  try {
    const r2 = await client.query.compute.queryContract({
      contract_address: c.snvr_token,
      code_hash: c.snvr_code_hash,
      query: {
        with_permit: {
          permit,
          query: { balance: { address: target } },
        },
      },
    });
    pickAmount(r2?.balance?.amount);
  } catch (_e2) {
    errors.push("path2:" + String(_e2?.message || "unknown"));
  }

  try {
    const r3 = await client.query.compute.queryContract({
      contract_address: c.snvr_token,
      code_hash: c.snvr_code_hash,
      query: {
        with_permit: {
          permit,
          query: { balance: {} },
        },
      },
    });
    pickAmount(r3?.balance?.amount);
  } catch (_e3) {
    errors.push("path3:" + String(_e3?.message || "unknown"));
  }

  if (!candidates.length) {
    const combined = errors.join(" | ").toLowerCase();
    if (combined.includes("permit") || combined.includes("signature") || combined.includes("permission")) {
      return { ok: false, error_code: "PERMIT_INVALID", errors };
    }
    return { ok: false, error_code: "QUERY_FAILED", errors };
  }
  return { ok: true, amount: String(Math.max(...candidates)), errors };
}

/** Permit 조회 진단용: 어떤 경로에서 실패했는지 상세 반환 */
export async function getSnvrBalanceWithPermitProbe(address, permit) {
  const c = loadConfig();
  if (!c.snvr_token || !c.snvr_code_hash) return { ok: false, error_code: "CONFIG_MISSING", errors: [] };
  if (!permit || typeof permit !== "object") return { ok: false, error_code: "PERMIT_MISSING", errors: [] };
  const urls = getLcdCandidates();
  let last = { ok: false, error_code: "QUERY_FAILED", errors: [] };
  for (const url of urls) {
    forceLcdUrl(url);
    try {
      const once = await getSnvrBalanceWithPermitProbeOnCurrentLcd(address, permit, c);
      if (once.ok) return { ...once, lcd_used: url };
      if (once.error_code === "PERMIT_INVALID") return once;
      last = { ...once, lcd_tried: url };
    } catch (e) {
      const msg = String(e?.message || "");
      const low = msg.toLowerCase();
      const code = (low.includes("permit") || low.includes("signature") || low.includes("permission")) ? "PERMIT_INVALID" : "QUERY_FAILED";
      last = { ok: false, error_code: code, errors: ["fatal:" + msg], lcd_tried: url };
      if (code === "PERMIT_INVALID") return last;
    }
  }
  return last;
}

/** SNVR 전송 (백엔드 지갑에서) */
export async function sendSnvr(toAddress, amountRaw) {
  const client = getTxClient();
  if (!client) return { ok: false, error: "MNEMONIC not set" };
  const c = loadConfig();
  if (!c.snvr_token || !c.snvr_code_hash) return { ok: false, error: "SNVR not deployed" };

  const amount = String(Math.floor(Number(amountRaw)));
  if (amount === "0" || Number(amount) <= 0) return { ok: false, error: "Invalid amount" };

  try {
    const tx = await client.tx.snip20.transfer({
      sender: client.address,
      contract_address: c.snvr_token,
      code_hash: c.snvr_code_hash,
      msg: { transfer: { recipient: String(toAddress).trim(), amount } },
    }, { gasLimit: 150_000 });
    const txHash = tx?.transactionHash || tx?.hash;
    return { ok: true, txHash: txHash || "ok" };
  } catch (e) {
    return { ok: false, error: e?.message || "Transfer failed" };
  }
}

/** Mixer MixedWithdraw (owner만 호출 가능) */
export async function mixerWithdraw(recipientAddress, amountRaw) {
  const client = getTxClient();
  if (!client) return { ok: false, error: "MNEMONIC not set" };
  const c = loadConfig();
  if (!c.mixer_address || !c.mixer_code_hash) return { ok: false, error: "Mixer not deployed" };

  const amount = String(Math.floor(Number(amountRaw)));
  if (amount === "0" || Number(amount) <= 0) return { ok: false, error: "Invalid amount" };

  try {
    const tx = await client.tx.compute.executeContract({
      sender: client.address,
      contract_address: c.mixer_address,
      msg: { mixed_withdraw: { recipient: String(recipientAddress).trim(), amount } },
      code_hash: c.mixer_code_hash,
    }, { gasLimit: 300_000 });
    const txHash = tx?.transactionHash || tx?.hash;
    return { ok: true, txHash: txHash || "ok" };
  } catch (e) {
    return { ok: false, error: e?.message || "Mixer withdraw failed" };
  }
}

/** 수령인 해석: @username -> user_key -> secret_address, 또는 secret1... 직접 */
export function resolveRecipientToSecretAddress(recipient, users) {
  const res = getRecipientSecretResolution(recipient, users);
  return res.ok ? res.address : null;
}

/**
 * Swap/Mix 수령인 해석 + 실패 이유(봇 메시지용).
 * 숫자만 입력 시 텔레그램 user id로 간주 (일반적으로 5자리 이상).
 */
export function getRecipientSecretResolution(recipient, users) {
  const r = String(recipient || "").trim();
  if (!r) return { ok: false, reason: "empty" };
  if (r.startsWith("secret1")) return { ok: true, address: r };
  const toKey = resolveRecipientToUserKey(recipient, users);
  if (!toKey) return { ok: false, reason: "unresolved" };
  const u = users.get(toKey);
  if (!u) {
    const idOnly = r.replace(/^@/, "");
    if (/^\d{5,}$/.test(idOnly)) return { ok: false, reason: "telegram_unknown" };
    return { ok: false, reason: "unresolved" };
  }
  if (!u.secret_address) return { ok: false, reason: "no_secret" };
  return { ok: true, address: u.secret_address };
}

function resolveRecipientToUserKey(recipient, users) {
  const r = String(recipient || "").trim();
  if (r.startsWith("@")) {
    const rest = r.slice(1);
    // @뒤가 숫자만이면 텔레그램 user id (공개 @username 이 아님)
    if (/^\d{5,}$/.test(rest)) return "telegram:" + rest;
    const uname = rest.toLowerCase();
    for (const [k, v] of users) {
      if (v.username && v.username.toLowerCase() === uname) return k;
    }
    return null;
  } else if (!r.startsWith("0x") && !r.includes("0x") && !r.startsWith("secret1")) {
    const uname = r.toLowerCase();
    for (const [k, v] of users) {
      if (v.username && v.username.toLowerCase() === uname) return k;
    }
    if (/^\d{5,}$/.test(r)) return "telegram:" + r;
  }
  return null;
}

export { loadConfig, DECIMALS };
