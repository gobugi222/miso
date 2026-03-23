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
    snvr_token: full.snvr_token,
    snvr_code_hash: full.snvr_code_hash,
    mixer_address: full.mixer_address,
    mixer_code_hash: full.mixer_code_hash,
    router_address: ghost.ghostswap_router_address,
    router_code_hash: ghost.ghostswap_router_code_hash,
    chain_id: full.chain_id || process.env.CHAIN_ID || "secretdev-1",
    lcd_url: process.env.LCD_URL || "http://localhost:1317",
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

/** SNIP-20 잔액 조회 (address + viewing_key) */
export async function getSnvrBalance(address, viewingKey) {
  const c = loadConfig();
  if (!c.snvr_token || !c.snvr_code_hash) return null;
  try {
    const client = getQueryClient();
    const result = await client.query.snip20.getBalance({
      contract: { address: c.snvr_token, code_hash: c.snvr_code_hash },
      address: String(address).trim(),
      auth: { key: String(viewingKey).trim() },
    });
    const amount = result?.balance?.amount ?? "0";
    return amount;
  } catch (e) {
    console.warn("getSnvrBalance error:", e?.message);
    const msg = String(e?.message || "");
    if (msg.includes("viewing_key") || msg.includes("Wrong viewing key") || msg.includes("viewing key")) {
      throw new Error("VIEWING_KEY_INVALID");
    }
    return null;
  }
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
