/**
 * Secret Network + SNVR ?곕룞
 * SNIP-20 ?붿븸, GhostSwap, Mixer
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

/** ??LCD URL?먯꽌 ?붿븸 議고쉶 ??理쒕? ?湲?(臾댁쓳???몃뱶濡?10遺? 嫄몃━??寃?諛⑹?) */
// LCD가 순간 장애/지연되면 permit 조회가 오래 물려서 UI가 멈추는 문제가 생긴다.
// 기본값을 줄여서 실패가 빨리 나고, 후보 URL도 줄여 전체 지연을 제한한다.
const LCD_PROBE_PER_URL_MS = Math.max(4000, Math.min(20000, Number(process.env.LCD_PROBE_PER_URL_MS) || 8000));
const LCD_MAX_URLS = Math.max(1, Math.min(3, Number(process.env.LCD_MAX_URLS) || 2));

function withLcdTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("LCD_TIMEOUT_" + ms + "ms")), ms)),
  ]);
}

/** mainnet 議고쉶?? ??LCD媛 HTML/502/invalid json??以????쒖꽌?濡??ъ떆??*/
function getLcdCandidates() {
  loadConfig();
  const primary = String(process.env.LCD_URL || config.lcd_url || "http://localhost:1317").replace(/\/$/, "");
  const fromEnv = (process.env.LCD_URL_FALLBACKS || "")
    .split(",")
    .map((s) => s.trim().replace(/\/$/, ""))
    .filter(Boolean);
  const chain = String(config.chain_id || "");
  const isMainnet = chain === "secret-4" || chain.includes("secret-4");
  /** secret-4: Railway LCD_URL???먮┛ ?몃뱶硫?泥?URL?먯꽌 ?덉궛留??쒖? ??express 癒쇱? */
  const mainnetFast = "https://lcd.secret.express";
  const mainnetBaked = [];
  const out = [];
  const seen = new Set();
  const ordered = isMainnet
    ? [mainnetFast, primary, ...fromEnv, ...mainnetBaked]
    : [primary, ...fromEnv];
  for (const u of ordered) {
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
  // Railway에 `deploy-*.json`이 포함되지 않아 loadConfig가 full/ghost를 못 읽는 경우가 있어
  // 최소 동작을 위해 fallback(배포 고정값)을 code에 박아둔다.
  const fallbackFull = {
    snvr_token: "secret1d6qvapy96q94etwlnc7j33dlzmenz4j70w3ew7",
    snvr_code_hash: "ff84f11b7639a1012126559dad4b41d5bf698b69657b09d7aea8483fe372c500",
    mixer_address: "secret1xlk86ftw8ljfxr95y2eg28jetp8umfvkv8hf8j",
    mixer_code_hash: "39a7c0a41abc0f00cb7ccea95947bf805e1a37cea20cffdd43536c78be06e770",
    chain_id: "secret-4",
  };
  const fallbackGhost = {
    ghostswap_router_address: "secret1kcr3s86rfehq5cykpnpccdsgkcp5dzcjrmkq3g",
    ghostswap_router_code_hash: "ab8d67fa0a341dfe78a0c54c1e3b31ddf21e9271b609dda352ebbb6a7a14bb21",
  };
  const chainId = full.chain_id || process.env.CHAIN_ID || "secretdev-1";
  const isSecretMainnet = chainId === "secret-4" || String(chainId).includes("secret-4");
  const defaultLcd = isSecretMainnet ? "https://lcd.secret.express" : "http://localhost:1317";
  config = {
    snvr_token: full.snvr_token || fallbackFull.snvr_token,
    snvr_code_hash: full.snvr_code_hash || fallbackFull.snvr_code_hash,
    mixer_address: full.mixer_address || fallbackFull.mixer_address,
    mixer_code_hash: full.mixer_code_hash || fallbackFull.mixer_code_hash,
    router_address: ghost.ghostswap_router_address || fallbackGhost.ghostswap_router_address,
    router_code_hash: ghost.ghostswap_router_code_hash || fallbackGhost.ghostswap_router_code_hash,
    chain_id: chainId,
    lcd_url: process.env.LCD_URL || defaultLcd,
  };
  return config;
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

/** SNIP-20 ?붿븸 議고쉶 (address + viewing_key) */
export async function getSnvrBalance(address, viewingKey) {
  const c = loadConfig();
  if (!c.snvr_token || !c.snvr_code_hash) return null;
  const urls = getLcdCandidates();
  let lastMsg = "";
  for (const url of urls) {
    forceLcdUrl(url);
    try {
      const client = getQueryClient();
      const result = await withLcdTimeout(
        client.query.snip20.getBalance({
          contract: { address: c.snvr_token, code_hash: c.snvr_code_hash },
          address: String(address).trim(),
          auth: { key: String(viewingKey).trim() },
        }),
        LCD_PROBE_PER_URL_MS
      );
      const amount = result?.balance?.amount ?? "0";
      return amount;
    } catch (e) {
      lastMsg = String(e?.message || "");
      console.warn("getSnvrBalance error (" + url + "):", lastMsg);
      if (lastMsg.includes("viewing_key") || lastMsg.includes("Wrong viewing key") || lastMsg.includes("viewing key")) {
        throw new Error("VIEWING_KEY_INVALID");
      }
    }
  }
  return null;
}

/** SNIP-20 ?붿븸 議고쉶 (address + permit) */
export async function getSnvrBalanceWithPermit(address, permit) {
  const probe = await getSnvrBalanceWithPermitProbe(address, permit);
  if (probe.ok) return probe.amount;
  if (probe.error_code === "PERMIT_INVALID") throw new Error("PERMIT_INVALID");
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
    // 가장 싼 경로(path1)가 성공하면 r2/r3(무거운 compute 조회)를 생략해서 속도를 확보합니다.
    if (candidates.length) {
      return { ok: true, amount: String(Math.max(...candidates)), errors };
    }
  } catch (_e1) {
    errors.push("path1:" + String(_e1?.message || "unknown"));
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

/** Permit 議고쉶 吏꾨떒?? ?대뼡 寃쎈줈?먯꽌 ?ㅽ뙣?덈뒗吏 ?곸꽭 諛섑솚 */
export async function getSnvrBalanceWithPermitProbe(address, permit) {
  const c = loadConfig();
  if (!c.snvr_token || !c.snvr_code_hash) return { ok: false, error_code: "CONFIG_MISSING", errors: [] };
  if (!permit || typeof permit !== "object") return { ok: false, error_code: "PERMIT_MISSING", errors: [] };
  const urls = getLcdCandidates();
  let last = { ok: false, error_code: "QUERY_FAILED", errors: [] };
  for (const url of urls) {
    forceLcdUrl(url);
    try {
      const once = await withLcdTimeout(
        getSnvrBalanceWithPermitProbeOnCurrentLcd(address, permit, c),
        LCD_PROBE_PER_URL_MS * 2
      ).catch((e) => ({
        ok: false,
        error_code: "QUERY_FAILED",
        errors: [String(e?.message || "lcd_probe_failed")],
      }));
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

/** SNVR ?꾩넚 (諛깆뿏??吏媛묒뿉?? */
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

/** Mixer MixedWithdraw (owner留??몄텧 媛?? */
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

/** ?섎졊???댁꽍: @username -> user_key -> secret_address, ?먮뒗 secret1... 吏곸젒 */
export function resolveRecipientToSecretAddress(recipient, users) {
  const r = String(recipient || "").trim();
  if (r.startsWith("secret1")) return r;
  const toKey = resolveRecipientToUserKey(recipient, users);
  if (!toKey) return null;
  const u = users.get(toKey);
  return u?.secret_address || null;
}

function resolveRecipientToUserKey(recipient, users) {
  const r = String(recipient || "").trim();
  if (r.startsWith("@")) {
    const uname = r.slice(1).toLowerCase();
    for (const [k, v] of users) {
      if (v.username && v.username.toLowerCase() === uname) return k;
    }
  } else if (!r.startsWith("0x") && !r.includes("0x") && !r.startsWith("secret1")) {
    const uname = r.toLowerCase();
    for (const [k, v] of users) {
      if (v.username && v.username.toLowerCase() === uname) return k;
    }
    if (/^\d+$/.test(r) && users.has("telegram:" + r)) return "telegram:" + r;
  }
  return null;
}

export { loadConfig, DECIMALS };
