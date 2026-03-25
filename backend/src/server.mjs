/**
 * Snvr 백엔드 API - 스왑·믹싱 + 지갑(송금·받기) + 스너버메신저 연동.
 * Secret Network 연동: /wallet/link-secret, /balance(체인), /swap, /mix
 * DB: data/db.json (재시작 시 잔액·채팅 유지)
 */
import "dotenv/config";
import express from "express";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import {
  getSnvrBalance,
  getSnvrBalanceWithPermit,
  getSnvrBalanceWithPermitProbe,
  sendSnvr,
  resolveRecipientToSecretAddress,
  isSecretEnabled,
  loadConfig,
} from "./secret.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, "../data/db.json");

const app = express();
app.use(express.json({ limit: "500kb" }));
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

const PORT = Number(process.env.PORT) || 3000;
const MOCK = process.env.MOCK_AZTEC !== undefined && process.env.MOCK_AZTEC !== "0";
const USE_SECRET = process.env.SECRET_NETWORK === "1" && isSecretEnabled();

// Balance: keep API responsive even when LCD is slow.
const BALANCE_CHAIN_BUDGET_MS = Math.max(5000, Math.min(260000, Number(process.env.BALANCE_CHAIN_BUDGET_MS) || 90000));
function clampInt(n, min, max) {
  const x = Number(n);
  if (!Number.isFinite(x)) return null;
  return Math.max(min, Math.min(max, Math.trunc(x)));
}
function withChainBudget(promise, budgetMs = BALANCE_CHAIN_BUDGET_MS) {
  const ms = clampInt(budgetMs, 5000, BALANCE_CHAIN_BUDGET_MS) ?? BALANCE_CHAIN_BUDGET_MS;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(Object.assign(new Error("BALANCE_CHAIN_BUDGET"), { code: "BALANCE_CHAIN_BUDGET" })), ms);
    }),
  ]);
}
function isBalanceBudgetError(e) {
  return e?.code === "BALANCE_CHAIN_BUDGET" || e?.message === "BALANCE_CHAIN_BUDGET";
}
function loadTelegramToken() {
  if (process.env.TELEGRAM_BOT_TOKEN) return process.env.TELEGRAM_BOT_TOKEN;
  try {
    const botEnvPath = join(__dirname, "../../telegram-bot/.env");
    if (existsSync(botEnvPath)) {
      const raw = readFileSync(botEnvPath, "utf8");
      const m = raw.match(/BOT_TOKEN\s*=\s*(\S+)/);
      if (m && m[1]) return m[1].replace(/^["']|["']$/g, "").trim();
    }
  } catch (e) { /* ignore */ }
  return null;
}
const TELEGRAM_BOT_TOKEN = loadTelegramToken();

async function notifyTelegram(chatId, text) {
  if (!TELEGRAM_BOT_TOKEN) return false;
  try {
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "" }),
    });
    if (!res.ok) {
      console.warn("[송금알림] Telegram API 실패:", res.status, await res.text());
      return false;
    }
    return true;
  } catch (e) {
    console.warn("[송금알림] Telegram 오류:", e?.message);
    return false;
  }
}

// 연결 확인 (404 나올 때 메신저에서 "백엔드 주소 확인" 안내용)
app.get("/health", (req, res) => res.json({ ok: true, service: "snvr-backend" }));

// 체인 설정 (Keplr 연결용. 메인넷 배포 후 사용)
app.get("/wallet/chain-config", (req, res) => {
  try {
    const c = loadConfig();
    return res.json({
      ok: true,
      chain_id: c.chain_id || null,
      lcd_url: c.lcd_url || null,
      snvr_address: c.snvr_token || null,
      snvr_code_hash: c.snvr_code_hash || null,
      mixer_address: c.mixer_address || null,
      mixer_code_hash: c.mixer_code_hash || null,
      snvr_decimals: 9,
    });
  } catch (e) {
    return res.json({
      ok: true,
      chain_id: null,
      lcd_url: null,
      snvr_address: null,
      snvr_code_hash: null,
      mixer_address: null,
      mixer_code_hash: null,
      snvr_decimals: 9,
    });
  }
});

// ——— 지갑·송금 (플랫폼 무관: telegram / snvr_messenger 등 동일 API)
let users = new Map();
const oneTimeCodes = new Map();
const linkCodes = new Map();
const CODE_EXPIRY_MS = 5 * 60 * 1000;
const LINK_CODE_EXPIRY_MS = 5 * 60 * 1000;
let walletTxs = [];
let walletTxId = 1;

// ——— 채팅
let chatRooms = new Map();
let chatMessages = [];
let chatMessageId = 1;

// Zero-Log: 메신저=클라이언트만 보관(기록 없음). 텔레그램=저장(편의).
// ZERO_LOG=1 이면 채팅·전송내역 미저장 (텔레그램도 재시작 시 초기화). 기본값 0(저장).
const ZERO_LOG = process.env.ZERO_LOG === "1";

function loadDb() {
  if (!existsSync(DB_PATH)) return;
  try {
    const raw = readFileSync(DB_PATH, "utf8");
    const db = JSON.parse(raw);
    if (db.users) users = new Map(Object.entries(db.users));
    if (!ZERO_LOG && Array.isArray(db.walletTxs)) walletTxs = db.walletTxs;
    if (db.walletTxId != null) walletTxId = db.walletTxId;
    if (!ZERO_LOG && db.chatRooms) chatRooms = new Map(Object.entries(db.chatRooms));
    if (!ZERO_LOG && Array.isArray(db.chatMessages)) chatMessages = db.chatMessages;
    if (db.chatMessageId != null) chatMessageId = db.chatMessageId;
    console.log("DB loaded:", users.size, "users", ZERO_LOG ? "(Zero-Log: no chain link, no chat/tx history)" : "");
  } catch (e) {
    console.warn("DB load failed:", e?.message);
  }
}

function saveDb() {
  try {
    mkdirSync(join(__dirname, "../data"), { recursive: true });
    const db = {
      users: Object.fromEntries(users),
      walletTxId,
      chatMessageId,
    };
    if (!ZERO_LOG) {
      db.walletTxs = walletTxs;
      db.chatRooms = Object.fromEntries(chatRooms);
      db.chatMessages = chatMessages;
    }
    writeFileSync(DB_PATH, JSON.stringify(db, null, 0), "utf8");
  } catch (e) {
    console.warn("DB save failed:", e?.message);
  }
}

loadDb();
function roomId(key1, key2) {
  return [key1, key2].sort().join("::");
}

function platformKey(platform, platformUserId) {
  return `${platform}:${platformUserId}`;
}
const MAX_AVATAR_BASE64 = 300000; // ~200KB 이미지
function ensureUser(platform, platformUserId, username) {
  const key = platformKey(platform, platformUserId);
  if (!users.has(key)) {
    users.set(key, {
      platform,
      platform_user_id: String(platformUserId),
      username: username || null,
      balance: 0,
      last_chain_balance: null,
      last_chain_at: null,
      created_at: new Date().toISOString(),
      display_name: null,
      status_text: null,
      avatar: null,
      secret_address: null,
      viewing_key: null,
      permit: null,
      bot_balance_sync: false,
      locale: "en",
    });
  }
  return users.get(key);
}

function rememberChainBalance(u, humanBalance) {
  const n = Number(humanBalance);
  if (!u || !Number.isFinite(n) || n < 0) return;
  u.last_chain_balance = n;
  u.last_chain_at = Date.now();
  // keep memory aligned so fallback won't show stale zero
  u.balance = n;
}

function getFallbackBalance(u) {
  const mem = Number(u?.balance || 0);
  const last = Number(u?.last_chain_balance);
  const lastAt = Number(u?.last_chain_at || 0);
  if (Number.isFinite(last) && last >= 0 && lastAt > 0) {
    const ageMs = Date.now() - lastAt;
    if (ageMs < 24 * 60 * 60 * 1000) return Math.max(mem, last);
  }
  return mem;
}

const inflightChain = new Map();
function scheduleChainRefresh(userKey, fn) {
  if (inflightChain.get(userKey)) return false;
  inflightChain.set(userKey, true);
  Promise.resolve()
    .then(fn)
    .catch((_e) => {})
    .finally(() => inflightChain.delete(userKey));
  return true;
}

const CHAT_NOTIFY_MSG = {
  ko: (sender, text, replyTo) => `📩 ${sender} 님이 메시지를 보냈어요:\n\n${text}\n\n답장: /msg ${replyTo} 답장내용`,
  ja: (sender, text, replyTo) => `📩 ${sender} からメッセージ:\n\n${text}\n\n返信: /msg ${replyTo} 返信内容`,
  en: (sender, text, replyTo) => `📩 Message from ${sender}:\n\n${text}\n\nReply: /msg ${replyTo} your reply`,
};
const SEND_NOTIFY_MSG = {
  ko: (sender, amount) => `💰 ${sender}님이 ${amount} SNVR을 보냈어요. 입금되었습니다.`,
  ja: (sender, amount) => `💰 ${sender}さんが${amount} SNVRを送りました。入金されました。`,
  en: (sender, amount) => `💰 ${sender} sent you ${amount} SNVR. Deposit received.`,
};

/** locale 반환: body/query 또는 사용자 locale. 기본 en */
function getLocale(req, userKey) {
  const fromBody = req.body?.locale;
  const fromQuery = req.query?.locale;
  const fromUser = userKey ? users.get(userKey)?.locale : null;
  const loc = fromBody || fromQuery || fromUser || "en";
  return ["ko", "ja", "en"].includes(String(loc).toLowerCase()) ? String(loc).toLowerCase() : "en";
}

/** 다국어 에러 메시지. key: 에러 키, args: 동적 인자. */
const ERR = {
  platform_user_id_required: { ko: "platform_user_id 필요", ja: "platform_user_id が必要", en: "platform_user_id required" },
  amount_required: { ko: "amount(양수) 필요", ja: "amount(正の数) が必要", en: "amount (positive number) required" },
  invalid_receive_code: { ko: "유효하지 않거나 만료된 받기 코드입니다.", ja: "無効または期限切れの受取コードです。", en: "Invalid or expired receive code." },
  invalid_link_code: { ko: "유효하지 않거나 만료된 코드예요.", ja: "無効または期限切れのコードです。", en: "Invalid or expired code." },
  specify_recipient: { ko: "받는 사람을 지정해 주세요.", ja: "受取人を指定してください。", en: "Please specify recipient." },
  insufficient_balance: { ko: "잔액이 부족해요.", ja: "残高が不足しています。", en: "Insufficient balance." },
  insufficient_balance_swap: { ko: "잔액이 부족해요. (수수료 0.3%는 보낸 금액에서 차감돼요)", ja: "残高不足です。(手数料0.3%は送金額から差し引かれます)", en: "Insufficient balance. (0.3% fee is deducted from amount)" },
  insufficient_balance_mix: { ko: "잔액이 부족해요. (수수료 1%는 보낸 금액에서 차감돼요)", ja: "残高不足です。(手数料1%は送金額から差し引かれます)", en: "Insufficient balance. (1% fee is deducted from amount)" },
  avatar_size: { ko: "프로필 이미지는 약 200KB 이하여야 해요.", ja: "プロフィール画像は約200KB以下にしてください。", en: "Profile image must be under ~200KB." },
  q_required: { ko: "q(검색어) 필요", ja: "q(検索語) が必要", en: "q required" },
  user_not_registered: { ko: "등록된 사용자를 찾을 수 없어요. @이름 검색은 상대가 이 봇을 한 번 실행했고 텔레그램 @유저네임이 있어야 해요. (뷰킹 키/뷰키 문제 아님)", ja: "ユーザーが見つかりません。@検索には相手がボットを起動済みで@usernameが必要です。（ビューイングキーとは無関係）", en: "User not found. For @username search, recipient must have started the bot and have a Telegram @username. (Not a viewing-key issue.)" },
  platform_user_id_required_login: { ko: "platform_user_id 필요 (로그인 상태 확인)", ja: "platform_user_id が必要 (ログイン状態を確認)", en: "platform_user_id required (check login)" },
  other_key_required: { ko: "상대방 ID(other_key) 필요", ja: "相手ID(other_key) が必要", en: "other_key required" },
  server_error: { ko: (m) => "서버 오류: " + m, ja: (m) => "サーバーエラー: " + m, en: (m) => "Server error: " + m },
  room_not_found: { ko: "Room not found", ja: "Room not found", en: "Room not found" },
  platform_user_id_text_required: { ko: "platform_user_id, text 필요", ja: "platform_user_id, text が必要", en: "platform_user_id, text required" },
  message_not_found: { ko: "Message not found or not yours", ja: "メッセージが見つからないか、あなたのものではありません", en: "Message not found or not yours" },
  amount_recipient_required: { ko: "amount(양수), recipient 필요", ja: "amount(正の数), recipient が必要", en: "amount (positive), recipient required" },
  recipient_must_be_secret: { ko: "수령인(recipient)이 secret1... 주소이거나 /link-secret 연동된 @사용자여야 합니다.", ja: "受取人(recipient)は secret1... アドレスまたは /link-secret 連携済みの @ユーザーである必要があります。", en: "Recipient must be secret1... address or @user linked via /link-secret." },
  chain_not_configured: { ko: "Real chain not configured. Set MOCK_AZTEC=1 or SECRET_NETWORK=1 with MNEMONIC.", ja: "チェーン未設定。MOCK_AZTEC=1 または SECRET_NETWORK=1 と MNEMONIC を設定してください。", en: "Real chain not configured. Set MOCK_AZTEC=1 or SECRET_NETWORK=1 with MNEMONIC." },
  sender_wallet_required: { ko: "보내는 사람 지갑이 연결되지 않았어요. SNVR Messenger 설정에서 Keplr를 먼저 연결해 주세요.", ja: "送信者ウォレットが未連携です。SNVR Messenger の設定で Keplr を先に接続してください。", en: "Sender wallet is not connected. Connect Keplr first in SNVR Messenger settings." },
  recipient_wallet_required: { ko: "상대방 지갑이 연결되지 않았어요. 상대가 먼저 지갑을 연결해야 받아요.", ja: "受信者ウォレットが未連携です。相手が先にウォレット接続する必要があります。", en: "Recipient wallet is not connected yet. They must connect wallet first." },
  receive_code_wallet_required: { ko: "받기 코드는 지갑 연결된 계정만 발급할 수 있어요. 설정에서 Keplr를 연결해 주세요.", ja: "受取コードはウォレット連携済みアカウントのみ発行できます。設定で Keplr を接続してください。", en: "Receive code requires wallet connection. Connect Keplr in settings first." },
};
function err(locale, key, ...args) {
  const loc = ["ko", "ja", "en"].includes(locale) ? locale : "en";
  const msg = ERR[key];
  if (!msg) return key;
  const v = msg[loc] || msg.en;
  return typeof v === "function" ? v(...args) : v;
}
function userNotFound(locale, username) {
  const loc = ["ko", "ja", "en"].includes(locale) ? locale : "en";
  const m = {
    ko: `해당 사용자(@${username})를 찾을 수 없어요. 먼저 봇을 시작해 주세요.`,
    ja: `ユーザー(@${username})が見つかりません。まずボットを開始してください。`,
    en: `User @${username} not found. They must start the bot first.`,
  };
  return m[loc] || m.en;
}

app.post("/wallet/register", (req, res) => {
  const { platform = "telegram", platform_user_id, username, locale } = req.body || {};
  if (!platform_user_id) return res.status(400).json({ ok: false, error: err(getLocale(req, null), "platform_user_id_required") });
  const u = ensureUser(platform, platform_user_id, username);
  if (username != null) u.username = username;
  if (locale && ["en", "ko", "ja"].includes(String(locale).toLowerCase())) u.locale = String(locale).toLowerCase();
  saveDb();
  return res.json({ ok: true, user_id: platformKey(platform, platform_user_id), balance: u.balance });
});

app.get("/wallet/balance", async (req, res) => {
  const platform = req.query.platform || "telegram";
  const platform_user_id = req.query.platform_user_id;
  const locale = (req.query.locale || "en").toLowerCase().slice(0, 5);
  const debugPermit = String(req.query.debug_permit || "") === "1";
  const budgetMs = clampInt(req.query.budget_ms, 5000, BALANCE_CHAIN_BUDGET_MS) ?? 25000;
  if (!platform_user_id) return res.status(400).json({ ok: false, error: err(getLocale(req, platformKey(platform, platform_user_id)), "platform_user_id_required") });
  const u = ensureUser(platform, platform_user_id);
  const memBal = Number(u.balance || 0);
  const fbBal = getFallbackBalance(u);
  const chainLinked = Boolean(u.secret_address && (u.viewing_key || u.permit));
  if (locale && ["en", "ko", "ja"].includes(locale)) u.locale = locale;
  // Fast response: return cached chain (last_chain_balance) if present; never block on LCD.
  const hasCachedChain = Number.isFinite(Number(u.last_chain_balance)) && Number(u.last_chain_balance) >= 0 && Number(u.last_chain_at || 0) > 0;
  const immediate = hasCachedChain ? Math.max(fbBal, Number(u.last_chain_balance)) : fbBal;
  const userKey = platformKey(platform, platform_user_id);
  let pending_chain = false;
  // Background refresh when linked and cache is stale (>15s) or missing.
  const stale = !hasCachedChain || (Date.now() - Number(u.last_chain_at || 0) > 15000);
  if (stale && u.secret_address && (u.permit || u.viewing_key)) {
    pending_chain = scheduleChainRefresh(userKey, async () => {
      try {
        let raw = null;
        if (u.permit) raw = await withChainBudget(getSnvrBalanceWithPermit(u.secret_address, u.permit), budgetMs);
        else if (u.viewing_key) raw = await withChainBudget(getSnvrBalance(u.secret_address, u.viewing_key), budgetMs);
        if (raw != null) {
          const human = Number(raw) / 1e9;
          rememberChainBalance(u, human);
          saveDb();
        }
      } catch (_e) { /* ignore */ }
    });
  }
  const out = {
    ok: true,
    chain_linked: chainLinked,
    balance: immediate,
    source: hasCachedChain ? "cached_chain" : "memory_fallback",
    auth: hasCachedChain ? "cached" : (pending_chain ? "chain_refreshing" : "-"),
    pending_chain,
  };
  if (debugPermit && u.secret_address && u.permit) {
    // Probe is best-effort and should not block the response.
    scheduleChainRefresh(userKey + "::probe", async () => {
      try { await withChainBudget(getSnvrBalanceWithPermitProbe(u.secret_address, u.permit), budgetMs); } catch (_e) {}
    });
  }
  return res.json(out);
});

function parsePermitInput(rawPermit) {
  if (!rawPermit) return null;
  const sanitizePermit = (obj) => {
    if (!obj || typeof obj !== "object") return null;
    const exp = Number(obj.expires_at || 0);
    if (Number.isFinite(exp) && exp > 0 && exp <= Date.now()) return null;
    // Session metadata may exist on client; query permit must be pure { params, signature }.
    const params = obj.params;
    const signature = obj.signature;
    if (!params || !signature || typeof params !== "object" || typeof signature !== "object") return null;
    return { params, signature };
  };
  if (typeof rawPermit === "object") {
    return sanitizePermit(rawPermit);
  }
  if (typeof rawPermit !== "string") return null;
  try {
    const parsed = JSON.parse(rawPermit);
    return sanitizePermit(parsed);
  } catch (_e) {
    return null;
  }
}

/** 메신저 Zero-Log: 클라이언트가 permit/viewing key를 담아 보냄. 저장 안 함. */
app.post("/wallet/balance", async (req, res) => {
  const { platform = "telegram", platform_user_id, secret_address, viewing_key, permit: rawPermit, debug_permit } = req.body || {};
  const permit = parsePermitInput(rawPermit);
  const debugPermit = String(debug_permit || "") === "1";
  if (!platform_user_id) return res.status(400).json({ ok: false, error: err(getLocale(req, null), "platform_user_id_required") });
  const u = ensureUser(platform, platform_user_id);
  const memBal = Number(u.balance || 0);
  // 1) permit 우선
  if (secret_address && permit) {
    let permitProbe = null;
    if (debugPermit) permitProbe = await getSnvrBalanceWithPermitProbe(secret_address, permit);
    try {
      const chainBal = await getSnvrBalanceWithPermit(secret_address, permit);
      if (chainBal != null) {
        const human = Number(chainBal) / 1e9;
        if (human === 0 && memBal > 0) return res.json({ ok: true, balance: memBal, source: "memory_fallback", auth: "permit", permit_debug: permitProbe || undefined });
        return res.json({ ok: true, balance: human, source: "chain", auth: "permit", permit_debug: permitProbe || undefined });
      }
    } catch (e) {
      if (e?.message === "PERMIT_INVALID") return res.json({ ok: true, balance: memBal, source: "memory_fallback", auth: "permit_invalid", permit_debug: permitProbe || { ok: false, error_code: "PERMIT_INVALID" } });
      throw e;
    }
  }
  // 2) viewing key fallback
  if (secret_address && viewing_key) {
    try {
      const chainBal = await getSnvrBalance(secret_address, viewing_key);
      if (chainBal != null) {
        const human = Number(chainBal) / 1e9;
        if (human === 0 && memBal > 0) return res.json({ ok: true, balance: memBal, source: "memory_fallback", auth: "viewing_key" });
        return res.json({ ok: true, balance: human, source: "chain", auth: "viewing_key" });
      }
    } catch (e) {
      if (e?.message === "VIEWING_KEY_INVALID") return res.json({ ok: true, balance: memBal, source: "memory_fallback", auth: "viewing_key_invalid" });
      throw e;
    }
  }
  // 3) 저장된 기존 링크(permit 우선 → viewing key) fallback
  if (u.secret_address && u.permit) {
    try {
      const chainBal = await getSnvrBalanceWithPermit(u.secret_address, u.permit);
      if (chainBal != null) {
        const human = Number(chainBal) / 1e9;
        if (human === 0 && memBal > 0) return res.json({ ok: true, balance: memBal, source: "memory_fallback", auth: "stored_permit" });
        return res.json({ ok: true, balance: human, source: "chain", auth: "stored_permit" });
      }
    } catch (e) {
      if (e?.message === "PERMIT_INVALID") return res.json({ ok: true, balance: memBal, source: "memory_fallback", auth: "stored_permit_invalid" });
    }
  }
  if (u.secret_address && u.viewing_key) {
    const chainBal = await getSnvrBalance(u.secret_address, u.viewing_key);
    if (chainBal != null) {
      const human = Number(chainBal) / 1e9;
      if (human === 0 && memBal > 0) return res.json({ ok: true, balance: memBal, source: "memory_fallback", auth: "stored_viewing_key" });
      return res.json({ ok: true, balance: human, source: "chain", auth: "stored_viewing_key" });
    }
  }
  return res.json({ ok: true, balance: memBal, source: "memory" });
});

/** 체인 연동 시 체인 잔액, 아니면 메모리 잔액 (mix/swap 잔액 검사용) */
async function getEffectiveBalance(u) {
  if (u?.secret_address && u?.viewing_key) {
    const chainBal = await getSnvrBalance(u.secret_address, u.viewing_key);
    if (chainBal != null) return Number(chainBal) / 1e9;
    throw new Error("CHAIN_BALANCE_UNAVAILABLE");
  }
  if (u?.secret_address && u?.permit) {
    try {
      const chainBal = await getSnvrBalanceWithPermit(u.secret_address, u.permit);
      if (chainBal != null) return Number(chainBal) / 1e9;
    } catch (e) {
      if (e?.message === "PERMIT_INVALID") throw e;
    }
    throw new Error("CHAIN_BALANCE_UNAVAILABLE");
  }
  return u?.balance ?? 0;
}
/** 메신저 Zero-Log: 클라이언트가 보낸 permit/viewing key로 잔액 조회 (저장 안 함). */
async function getEffectiveBalanceFromCreds(secret_address, viewing_key, permit, fallbackU) {
  let attemptedAuth = false;
  if (secret_address && permit) {
    attemptedAuth = true;
    try {
      const chainBal = await getSnvrBalanceWithPermit(secret_address, permit);
      if (chainBal != null) return Number(chainBal) / 1e9;
    } catch (e) {
      if (e?.message === "PERMIT_INVALID") throw e;
      /* other errors: fall through to fallback */
    }
  }
  if (secret_address && viewing_key) {
    attemptedAuth = true;
    try {
      const chainBal = await getSnvrBalance(secret_address, viewing_key);
      if (chainBal != null) return Number(chainBal) / 1e9;
    } catch (e) {
      if (e?.message === "VIEWING_KEY_INVALID") throw e;
      /* other errors: fall through to fallback */
    }
  }
  if (attemptedAuth) throw new Error("CHAIN_BALANCE_UNAVAILABLE");
  return fallbackU ? getEffectiveBalance(fallbackU) : 0;
}

/** Wallet-linked check: body creds first(Zero-Log), then stored link. */
async function isWalletLinked(u, secret_address, viewing_key, permit) {
  if (secret_address && permit) {
    try {
      const chainBal = await getSnvrBalanceWithPermit(secret_address, permit);
      return chainBal != null;
    } catch (_e) {
      return false;
    }
  }
  if (secret_address && viewing_key) {
    try {
      const chainBal = await getSnvrBalance(secret_address, viewing_key);
      return chainBal != null;
    } catch (_e) {
      return false;
    }
  }
  if (u?.secret_address && u?.permit) {
    try {
      const chainBal = await getSnvrBalanceWithPermit(u.secret_address, u.permit);
      return chainBal != null;
    } catch (_e) {
      return false;
    }
  }
  return !!(u?.secret_address && u?.viewing_key);
}

app.post("/wallet/send", async (req, res) => {
  const { platform = "telegram", from_platform_user_id, to_platform_user_id, to_username, to_platform_key, to_one_time_code, amount, locale, secret_address, viewing_key, permit: rawPermit } = req.body || {};
  const permit = parsePermitInput(rawPermit);
  if (amount == null || amount <= 0) return res.status(400).json({ ok: false, error: err(getLocale(req, platformKey(platform, from_platform_user_id)), "amount_required") });
  const numAmount = Number(amount);
  const fromKey = platformKey(platform, from_platform_user_id);
  const fromU = ensureUser(platform, from_platform_user_id);
  if (locale && ["en", "ko", "ja"].includes(String(locale).toLowerCase())) fromU.locale = String(locale).toLowerCase();
  const senderLinked = await isWalletLinked(fromU, secret_address, viewing_key, permit);
  if (!senderLinked) return res.status(400).json({ ok: false, error: err(getLocale(req, fromKey), "sender_wallet_required") });
  let toKey = null;
  let toWalletLinked = false;
  if (to_one_time_code) {
    const ot = oneTimeCodes.get(String(to_one_time_code).trim());
    if (!ot || Date.now() > new Date(ot.expires_at).getTime()) return res.status(400).json({ ok: false, error: err(getLocale(req, fromKey), "invalid_receive_code") });
    if (!ot.wallet_linked) return res.status(400).json({ ok: false, error: err(getLocale(req, fromKey), "recipient_wallet_required") });
    toKey = platformKey(ot.platform, ot.platform_user_id);
    toWalletLinked = true;
    oneTimeCodes.delete(to_one_time_code);
  } else if (to_platform_key && users.has(String(to_platform_key).trim())) {
    toKey = String(to_platform_key).trim();
  } else if (to_username) {
    const uname = String(to_username).replace(/^@/, "").toLowerCase();
    for (const [k, v] of users) {
      if (v.username && v.username.toLowerCase() === uname) { toKey = k; break; }
    }
    if (!toKey) return res.status(404).json({ ok: false, error: userNotFound(getLocale(req, fromKey), to_username) });
  } else if (to_platform_user_id != null) {
    toKey = platformKey(platform, to_platform_user_id);
  }
  if (!toKey || toKey === fromKey) return res.status(400).json({ ok: false, error: err(getLocale(req, fromKey), "specify_recipient") });
  const [toPlatform, toId] = toKey.split(":");
  const toU = ensureUser(toPlatform, toId);
  if (!toWalletLinked && !(toU.secret_address && (toU.viewing_key || toU.permit))) {
    return res.status(400).json({ ok: false, error: err(getLocale(req, fromKey), "recipient_wallet_required") });
  }
  let effective;
  try {
    effective = (secret_address && (viewing_key || permit))
      ? await getEffectiveBalanceFromCreds(secret_address, viewing_key, permit, fromU)
      : await getEffectiveBalance(fromU);
  } catch (e) {
    if (e?.message === "PERMIT_INVALID") return res.status(400).json({ ok: false, error: "permit_invalid", message: "Permit이 만료되었거나 유효하지 않습니다. 설정에서 Keplr를 다시 연결해 주세요." });
    if (e?.message === "VIEWING_KEY_INVALID") return res.status(400).json({ ok: false, error: "viewing_key_invalid", message: "뷰키가 만료되었거나 변경되었습니다. 설정에서 Keplr를 다시 연결해 주세요." });
    if (e?.message === "CHAIN_BALANCE_UNAVAILABLE") return res.status(400).json({ ok: false, error: "chain_balance_unavailable", message: "체인 잔액을 조회할 수 없습니다. 설정에서 Keplr를 다시 연결해 주세요." });
    throw e;
  }
  if (effective < numAmount) return res.status(400).json({ ok: false, error: err(getLocale(req, fromKey), "insufficient_balance") });

  const toSecretAddr = toU.secret_address ? String(toU.secret_address).trim() : "";
  let chainTxHash = null;
  // P2P 송금은 운영 지갑(MNEMONIC)에서 수령인 secret 주소로 SNIP-20 transfer — 알림/내부 잔액은 성공 후에만 반영
  if (USE_SECRET && process.env.MNEMONIC && toSecretAddr && !MOCK) {
    const amountRaw = String(Math.floor(numAmount * 1e9));
    const result = await sendSnvr(toSecretAddr, amountRaw);
    if (!result.ok) {
      return res.status(400).json({
        ok: false,
        error: "on_chain_transfer_failed",
        message: String(result.error || "SNVR on-chain transfer failed"),
      });
    }
    chainTxHash = result.txHash || null;
  } else if (USE_SECRET && !process.env.MNEMONIC && !MOCK) {
    return res.status(503).json({
      ok: false,
      error: "chain_transfer_unavailable",
      message: "MNEMONIC is required on the server for on-chain SNVR transfers.",
    });
  }

  fromU.balance = effective;
  fromU.balance -= numAmount;
  toU.balance += numAmount;
  walletTxs.push({
    id: walletTxId++,
    type: "send",
    from_key: fromKey,
    to_key: toKey,
    amount: numAmount,
    fee: 0,
    meta: {
      to_username: to_username || null,
      to_one_time_code: to_one_time_code || null,
      txHash: chainTxHash,
    },
    created_at: new Date().toISOString(),
  });
  const senderName = fromU?.display_name || (fromU?.username ? "@" + fromU.username : fromU?.platform_user_id || "Someone");
  const recipientLocale = (toU?.locale || "en").toLowerCase().slice(0, 5);
  const lang = ["ko", "ja"].includes(recipientLocale) ? recipientLocale : "en";
  const notifyText = SEND_NOTIFY_MSG[lang](senderName, numAmount);
  if (toPlatform === "telegram") {
    const sent = await notifyTelegram(toId, notifyText);
    if (!sent && TELEGRAM_BOT_TOKEN) console.warn("[송금알림] 텔레그램 전송 실패. chatId:", toId);
    if (!TELEGRAM_BOT_TOKEN) console.warn("[송금알림] TELEGRAM_BOT_TOKEN 없음. .env에 추가 후 백엔드 재시작 필요.");
  }
  const rid = roomId(fromKey, toKey);
  if (!chatRooms.has(rid)) chatRooms.set(rid, { participants: [fromKey, toKey].sort(), created_at: new Date().toISOString(), auto_delete_after_sec: 0 });
  const sysMsg = {
    id: chatMessageId++,
    room_id: rid,
    from_key: "system",
    text: notifyText,
    meta: { type: "send", from_key: fromKey, to_key: toKey, amount: numAmount },
    created_at: new Date().toISOString(),
  };
  chatMessages.push(sysMsg);
  const payload = { ok: true, from_balance: fromU.balance, to_balance: toU.balance, txHash: chainTxHash || undefined };
  if (toPlatform === "telegram") {
    payload.recipient_telegram_id = toId;
    payload.recipient_locale = lang;
  }
  saveDb();
  return res.json(payload);
});

app.post("/wallet/link-secret", (req, res) => {
  const { platform = "telegram", platform_user_id, secret_address, viewing_key, permit: rawPermit, locale } = req.body || {};
  const permit = parsePermitInput(rawPermit);
  if (!platform_user_id || !secret_address) {
    return res.status(400).json({ ok: false, error: "platform_user_id, secret_address required" });
  }
  if (!permit) {
    return res.status(400).json({ ok: false, error: "permit required" });
  }
  const u = ensureUser(platform, platform_user_id);
  u.secret_address = String(secret_address).trim();
  u.viewing_key = null;
  u.permit = permit || null;
  u.bot_balance_sync = true;
  if (locale && ["en", "ko", "ja"].includes(String(locale).toLowerCase())) u.locale = String(locale).toLowerCase();
  saveDb();
  return res.json({ ok: true, message: "Secret Network 주소 연동됨" });
});

// Messenger settings: bot /balance sync toggle (ON stores addr+vk, OFF clears link)
app.get("/wallet/bot-balance-sync", (req, res) => {
  const platform = req.query.platform || "telegram";
  const platform_user_id = req.query.platform_user_id;
  if (!platform_user_id) {
    return res.status(400).json({ ok: false, error: err(getLocale(req, null), "platform_user_id_required") });
  }
  const u = ensureUser(platform, platform_user_id);
  return res.json({
    ok: true,
    enabled: !!u.bot_balance_sync,
    has_secret_link: !!(u.secret_address && u.permit),
    secret_address: u.secret_address || null,
    permit: u.permit || null,
  });
});

app.post("/wallet/bot-balance-sync", (req, res) => {
  const { platform = "telegram", platform_user_id, enabled, secret_address, viewing_key, permit: rawPermit, locale } = req.body || {};
  if (!platform_user_id) {
    return res.status(400).json({ ok: false, error: err(getLocale(req, null), "platform_user_id_required") });
  }
  const u = ensureUser(platform, platform_user_id);
  if (locale && ["en", "ko", "ja"].includes(String(locale).toLowerCase())) u.locale = String(locale).toLowerCase();

  if (!enabled) {
    u.bot_balance_sync = false;
    u.secret_address = null;
    u.viewing_key = null;
    u.permit = null;
    saveDb();
    return res.json({ ok: true, enabled: false, message: "봇 잔액 동기화 해제됨" });
  }

  const permit = parsePermitInput(rawPermit);
  if (!secret_address || !permit) {
    return res.status(400).json({ ok: false, error: "secret_address and permit required when enabling sync" });
  }
  u.secret_address = String(secret_address).trim();
  u.viewing_key = null;
  u.permit = permit || null;
  u.bot_balance_sync = true;
  saveDb();
  return res.json({ ok: true, enabled: true, message: "봇 잔액 동기화 활성화됨" });
});

app.post("/wallet/receive/generate", (req, res) => {
  const { platform = "telegram", platform_user_id, locale, secret_address, viewing_key, permit: rawPermit } = req.body || {};
  const permit = parsePermitInput(rawPermit);
  if (!platform_user_id) return res.status(400).json({ ok: false, error: err(getLocale(req, platformKey(platform, platform_user_id)), "platform_user_id_required") });
  const u = ensureUser(platform, platform_user_id);
  if (locale && ["en", "ko", "ja"].includes(String(locale).toLowerCase())) u.locale = String(locale).toLowerCase();
  return isWalletLinked(u, secret_address, viewing_key, permit).then((linked) => {
    if (!linked) return res.status(400).json({ ok: false, error: err(getLocale(req, platformKey(platform, platform_user_id)), "receive_code_wallet_required") });
    const code = String(Math.floor(100000 + Math.random() * 900000));
    oneTimeCodes.set(code, {
      platform,
      platform_user_id: String(platform_user_id),
      wallet_linked: true,
      expires_at: new Date(Date.now() + CODE_EXPIRY_MS).toISOString(),
    });
    const payload = { ok: true, one_time_code: code, expires_in_sec: Math.floor(CODE_EXPIRY_MS / 1000) };
    const messengerUrl = (process.env.MESSENGER_URL || "").trim().replace(/\/$/, "");
    if (messengerUrl) payload.receive_url = `${messengerUrl}?code=${code}`;
    return res.json(payload);
  }).catch((e) => {
    return res.status(500).json({ ok: false, error: err(getLocale(req, platformKey(platform, platform_user_id)), "server_error", e?.message || String(e)) });
  });
});

// ——— 스너버메신저 연동 (봇에서 /link → 코드 발급, 웹에서 코드 입력 → 같은 계정으로 로그인)
app.post("/auth/link/generate", (req, res) => {
  const { platform = "telegram", platform_user_id, locale } = req.body || {};
  if (!platform_user_id) return res.status(400).json({ ok: false, error: err(getLocale(req, platformKey(platform, platform_user_id)), "platform_user_id_required") });
  const u = ensureUser(platform, platform_user_id);
  if (locale && ["en", "ko", "ja"].includes(String(locale).toLowerCase())) u.locale = String(locale).toLowerCase();
  const code = String(Math.floor(100000 + Math.random() * 900000));
  linkCodes.set(code, { platform, platform_user_id: String(platform_user_id), expires_at: new Date(Date.now() + LINK_CODE_EXPIRY_MS).toISOString() });
  return res.json({ ok: true, code, expires_in_sec: Math.floor(LINK_CODE_EXPIRY_MS / 1000) });
});

app.post("/auth/link", (req, res) => {
  const { code } = req.body || {};
  const c = String(code || "").trim();
  const link = linkCodes.get(c);
  if (!link || Date.now() > new Date(link.expires_at).getTime()) return res.status(400).json({ ok: false, error: err(getLocale(req, null), "invalid_link_code") });
  linkCodes.delete(c);
  return res.json({ ok: true, platform: link.platform, platform_user_id: link.platform_user_id });
});

// ——— 프로필 (이름, 상태 메시지, 프로필 이미지)
app.get("/profile", (req, res) => {
  const platform = req.query.platform || "telegram";
  const platform_user_id = req.query.platform_user_id;
  if (!platform_user_id) return res.status(400).json({ ok: false, error: err(getLocale(req, platformKey(platform, platform_user_id)), "platform_user_id_required") });
  const u = ensureUser(platform, platform_user_id);
  return res.json({
    ok: true,
    display_name: u.display_name || null,
    status_text: u.status_text || null,
    username: u.username || null,
    has_avatar: !!u.avatar,
  });
});

app.put("/profile", (req, res) => {
  const { platform = "telegram", platform_user_id, display_name, status_text, avatar } = req.body || {};
  if (!platform_user_id) return res.status(400).json({ ok: false, error: err(getLocale(req, platformKey(platform, platform_user_id)), "platform_user_id_required") });
  const u = ensureUser(platform, platform_user_id);
  if (display_name !== undefined) u.display_name = display_name ? String(display_name).trim() || null : null;
  if (status_text !== undefined) u.status_text = status_text ? String(status_text).trim() || null : null;
  if (avatar !== undefined) {
    if (avatar === null || avatar === "") {
      u.avatar = null;
      u.avatar_mime = null;
    } else {
      const dataUrl = String(avatar);
      const m = dataUrl.match(/^data:(image\/\w+);base64,(.+)$/);
      const b64 = m ? m[2] : dataUrl.replace(/^data:image\/\w+;base64,/, "");
      if (Buffer.byteLength(b64, "base64") > MAX_AVATAR_BASE64) return res.status(400).json({ ok: false, error: err(getLocale(req, platformKey(platform, platform_user_id)), "avatar_size") });
      u.avatar = b64;
      u.avatar_mime = (m && m[1]) || "image/png";
    }
  }
  saveDb();
  return res.json({ ok: true, display_name: u.display_name, status_text: u.status_text, has_avatar: !!u.avatar });
});

app.get("/profile/avatar", (req, res) => {
  const platform = req.query.platform || "telegram";
  const platform_user_id = req.query.platform_user_id;
  if (!platform_user_id) return res.status(400).end();
  const u = users.get(platformKey(platform, platform_user_id));
  if (!u || !u.avatar) return res.status(404).end();
  const buf = Buffer.from(u.avatar, "base64");
  res.setHeader("Content-Type", u.avatar_mime || "image/png");
  res.send(buf);
});

// ——— 채팅 (1:1. 텔레그램→스너버메신저 옮겨도 같은 계정이라 대화 그대로)
// @이름 또는 사용자이름으로 등록된 사용자 조회 (채팅 상대 찾기)
app.get("/chat/resolve", (req, res) => {
  const q = String(req.query.q || "").trim().replace(/^@/, "").toLowerCase();
  if (!q) return res.status(400).json({ ok: false, error: err(getLocale(req, null), "q_required") });
  for (const [key, v] of users) {
    if (v.username && String(v.username).replace(/^@/, "").toLowerCase() === q) return res.json({ ok: true, platform_key: key });
  }
  return res.status(404).json({ ok: false, error: err(getLocale(req, null), "user_not_registered") });
});

// 일반 메신저처럼 ID·이름 검색 (봇 써 본 사용자만 검색됨)
app.get("/chat/search", (req, res) => {
  const platform = req.query.platform || "telegram";
  const platform_user_id = req.query.platform_user_id;
  const q = String(req.query.q || "").trim().toLowerCase();
  if (!platform_user_id) return res.status(400).json({ ok: false, error: err(getLocale(req, null), "platform_user_id_required") });
  const myKey = platformKey(platform, platform_user_id);
  const list = [];
  for (const [key, v] of users) {
    if (key === myKey) continue;
    const uname = (v.username && String(v.username).replace(/^@/, "").toLowerCase()) || "";
    const uid = String(v.platform_user_id || "");
    const keyLower = key.toLowerCase();
    const match =
      (q.length > 0 && uname && uname.includes(q)) ||
      (q.length > 0 && keyLower.includes(q)) ||
      (q.length > 0 && uid && uid.includes(q)) ||
      (/^\d+$/.test(q) && (uid === q || key === "telegram:" + q));
    if (match) list.push({ platform_key: key, username: v.username || null });
  }
  list.sort((a, b) => (a.username || a.platform_key).localeCompare(b.username || b.platform_key));
  return res.json({ ok: true, users: list.slice(0, 30) });
});

app.post("/chat/room", (req, res) => {
  try {
    const { platform = "telegram", platform_user_id, other_key } = req.body || {};
    if (platform_user_id === undefined || platform_user_id === null || platform_user_id === "")
      return res.status(400).json({ ok: false, error: err(getLocale(req, null), "platform_user_id_required_login") });
    if (!other_key || String(other_key).trim() === "")
      return res.status(400).json({ ok: false, error: err(getLocale(req, null), "other_key_required") });
    const myKey = platformKey(platform, String(platform_user_id));
    const other = String(other_key).trim();
    const rid = roomId(myKey, other);
    if (!chatRooms.has(rid)) chatRooms.set(rid, { participants: [myKey, other].sort(), created_at: new Date().toISOString(), auto_delete_after_sec: 0 });
    saveDb();
    return res.json({ ok: true, room_id: rid });
  } catch (e) {
    return res.status(500).json({ ok: false, error: err(getLocale(req, null), "server_error", e.message || String(e)) });
  }
});

app.get("/chat/rooms", (req, res) => {
  const platform = req.query.platform || "telegram";
  const platform_user_id = req.query.platform_user_id;
  if (!platform_user_id) return res.status(400).json({ ok: false, error: err(getLocale(req, null), "platform_user_id_required") });
  const myKey = platformKey(platform, platform_user_id);
  const list = [];
  for (const [rid, room] of chatRooms) {
    if (!room.participants.includes(myKey)) continue;
    const other = room.participants.find((k) => k !== myKey);
    const last = chatMessages.filter((m) => m.room_id === rid).sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];
    const autoSec = room.auto_delete_after_sec || 0;
    if (autoSec > 0 && !last) continue;
    list.push({
      room_id: rid,
      other_key: other,
      auto_delete_after_sec: autoSec,
      last_message: last ? { text: last.text, created_at: last.created_at } : null,
    });
  }
  list.sort((a, b) => {
    const tA = a.last_message ? new Date(a.last_message.created_at) : 0;
    const tB = b.last_message ? new Date(b.last_message.created_at) : 0;
    return tB - tA;
  });
  return res.json({ ok: true, rooms: list });
});

app.get("/chat/rooms/:roomId/messages", (req, res) => {
  const platform = req.query.platform || "telegram";
  const platform_user_id = req.query.platform_user_id;
  const limit = Math.min(Number(req.query.limit) || 50, 100);
  const before = req.query.before; // message id (older)
  const rid = req.params.roomId;
  const myKey = platformKey(platform, platform_user_id);
  const room = chatRooms.get(rid);
  if (!room || !room.participants.includes(myKey)) return res.status(404).json({ ok: false, error: err(getLocale(req, platformKey(platform, platform_user_id)), "room_not_found") });
  // 자동삭제 타이머가 설정된 경우, 오래된 메시지는 읽기 전에 정리
  const autoDeleteSec = Number(room.auto_delete_after_sec || 0);
  if (autoDeleteSec > 0) {
    const cutoff = Date.now() - autoDeleteSec * 1000;
    for (let i = chatMessages.length - 1; i >= 0; i--) {
      const m = chatMessages[i];
      if (m.room_id === rid && new Date(m.created_at).getTime() < cutoff) {
        chatMessages.splice(i, 1);
      }
    }
  }
  let list = chatMessages.filter((m) => m.room_id === rid);
  if (before) list = list.filter((m) => m.id < Number(before));
  list = list.sort((a, b) => new Date(b.created_at) - new Date(a.created_at)).slice(0, limit).reverse();
  return res.json({ ok: true, messages: list });
});

app.post("/chat/rooms/:roomId/messages", (req, res) => {
  const { platform = "telegram", platform_user_id, text, locale } = req.body || {};
  const rid = req.params.roomId;
  if (!platform_user_id || text == null) return res.status(400).json({ ok: false, error: err(getLocale(req, platformKey(platform, platform_user_id)), "platform_user_id_text_required") });
  const myKey = platformKey(platform, platform_user_id);
  const fromU = ensureUser(platform, platform_user_id);
  if (locale && ["en", "ko", "ja"].includes(String(locale).toLowerCase())) fromU.locale = String(locale).toLowerCase();
  const room = chatRooms.get(rid);
  if (!room || !room.participants.includes(myKey)) return res.status(404).json({ ok: false, error: err(getLocale(req, platformKey(platform, platform_user_id)), "room_not_found") });
  const id = chatMessageId++;
  const msg = { id, room_id: rid, from_key: myKey, text: String(text).slice(0, 4096), created_at: new Date().toISOString() };
  chatMessages.push(msg);

  const otherKey = room.participants.find((k) => k !== myKey);
  if (otherKey && otherKey.startsWith("telegram:")) {
    const recipientChatId = otherKey.replace(/^telegram:/, "");
    const fromU = users.get(myKey);
    const toU = users.get(otherKey);
    const recipientLocale = (toU?.locale || "en").toLowerCase().slice(0, 5);
    const lang = ["ko", "ja"].includes(recipientLocale) ? recipientLocale : "en";
    const senderName = fromU?.display_name || (fromU?.username ? "@" + fromU.username : fromU?.platform_user_id || "Someone");
    const replyTo = fromU?.username ? "@" + fromU.username : fromU?.platform_user_id || myKey;
    const notifyText = CHAT_NOTIFY_MSG[lang](senderName, msg.text, replyTo);
    notifyTelegram(recipientChatId, notifyText);
  }

  saveDb();
  return res.json({ ok: true, message: msg });
});

app.delete("/chat/messages/:messageId", (req, res) => {
  const platform = req.query.platform || "telegram";
  const platform_user_id = req.query.platform_user_id;
  const mid = Number(req.params.messageId);
  const myKey = platformKey(platform, platform_user_id);
  const idx = chatMessages.findIndex((m) => m.id === mid && m.from_key === myKey);
  if (idx === -1) return res.status(404).json({ ok: false, error: err(getLocale(req, platformKey(platform, platform_user_id)), "message_not_found") });
  chatMessages.splice(idx, 1);
  saveDb();
  return res.json({ ok: true });
});

// 대화 전체 삭제 (방+메시지 모두 삭제)
app.delete("/chat/rooms/:roomId", (req, res) => {
  const platform = req.query.platform || "telegram";
  const platform_user_id = req.query.platform_user_id;
  const rid = req.params.roomId;
  const myKey = platformKey(platform, platform_user_id);
  const room = chatRooms.get(rid);
  if (!room || !room.participants.includes(myKey)) return res.status(404).json({ ok: false, error: err(getLocale(req, myKey), "room_not_found") });
  chatRooms.delete(rid);
  chatMessages = chatMessages.filter((m) => m.room_id !== rid);
  saveDb();
  return res.json({ ok: true });
});

// 채팅방 자동삭제 타이머 설정 (초 단위)
app.post("/chat/rooms/:roomId/auto_delete", (req, res) => {
  const { platform = "telegram", platform_user_id, seconds } = req.body || {};
  const rid = req.params.roomId;
  if (!platform_user_id) return res.status(400).json({ ok: false, error: err(getLocale(req, platformKey(platform, platform_user_id)), "platform_user_id_required") });
  const myKey = platformKey(platform, platform_user_id);
  const room = chatRooms.get(rid);
  if (!room || !room.participants.includes(myKey)) return res.status(404).json({ ok: false, error: err(getLocale(req, platformKey(platform, platform_user_id)), "room_not_found") });
  const sec = Math.max(0, Number(seconds || 0));
  room.auto_delete_after_sec = sec;
  saveDb();
  return res.json({ ok: true, auto_delete_after_sec: sec });
});

// 뷰키 조회 (Secret Network /link-secret 연동 시)
app.get("/wallet/viewing-key", (req, res) => {
  const platform = req.query.platform || "telegram";
  const platform_user_id = req.query.platform_user_id;
  if (!platform_user_id) return res.status(400).json({ ok: false, error: err(getLocale(req, null), "platform_user_id_required") });
  const u = users.get(platformKey(platform, platform_user_id));
  return res.json({ ok: true, viewing_key: null });
});

// 뷰키 조회 (Secret Network /link-secret 연동 시)
app.get("/wallet/viewing-key", (req, res) => {
  const platform = req.query.platform || "telegram";
  const platform_user_id = req.query.platform_user_id;
  if (!platform_user_id) return res.status(400).json({ ok: false, error: err(getLocale(req, null), "platform_user_id_required") });
  const u = users.get(platformKey(platform, platform_user_id));
  return res.json({ ok: true, viewing_key: null });
});

// ——— 지갑 잔고 내역 (최근 트랜잭션)
app.get("/wallet/history", (req, res) => {
  const platform = req.query.platform || "telegram";
  const platform_user_id = req.query.platform_user_id;
  if (!platform_user_id) return res.status(400).json({ ok: false, error: err(getLocale(req, platformKey(platform, platform_user_id)), "platform_user_id_required") });
  const key = platformKey(platform, platform_user_id);
  const limit = Math.min(Number(req.query.limit) || 50, 100);
  const items = walletTxs
    .filter((tx) => tx.from_key === key || tx.to_key === key)
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    .slice(0, limit)
    .map((tx) => {
      const direction = tx.from_key === key ? "out" : tx.to_key === key ? "in" : "other";
      const counterparty = direction === "out" ? tx.to_key : tx.from_key;
      return {
        id: tx.id,
        type: tx.type,
        direction,
        amount: tx.amount,
        fee: tx.fee || 0,
        counterparty_key: counterparty,
        created_at: tx.created_at,
      };
    });
  return res.json({ ok: true, items });
});

// 잔고 내역 비우기 (해당 사용자 기준)
app.post("/wallet/history/clear", (req, res) => {
  const { platform = "telegram", platform_user_id } = req.body || {};
  if (!platform_user_id) return res.status(400).json({ ok: false, error: err(getLocale(req, platformKey(platform, platform_user_id)), "platform_user_id_required") });
  const key = platformKey(platform, platform_user_id);
  for (let i = walletTxs.length - 1; i >= 0; i--) {
    const tx = walletTxs[i];
    if (tx.from_key === key || tx.to_key === key) walletTxs.splice(i, 1);
  }
  saveDb();
  return res.json({ ok: true });
});

// 수수료: 송금액에서 차감 → 받는 사람 입금액 = 금액 - 수수료
const SWAP_FEE_RATE = 0.003;  // 0.3% (고스트스왑)
const MIX_FEE_RATE = 0.01;    // 1% (0.5% 소각 + 0.5% 운영)

function resolveRecipientToUserKey(recipient, platform = "telegram") {
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
    if (/^\d+$/.test(r)) return platform + ":" + r;
  }
  return null; // 체인 주소 등
}

// POST /swap — 고스트스왑. 보낸 금액에서 수수료 0.3% 차감, 나머지가 수령인에게 입금
app.post("/swap", async (req, res) => {
  const { amount, recipient, platform = "telegram", from_platform_user_id, secret_address, viewing_key, permit: rawPermit } = req.body || {};
  const permit = parsePermitInput(rawPermit);
  const loc = getLocale(req, from_platform_user_id != null ? platformKey(platform, from_platform_user_id) : null);
  if (amount == null || amount <= 0 || !recipient) {
    return res.status(400).json({ ok: false, error: err(loc, "amount_recipient_required") });
  }
  const numAmount = Number(amount);
  const fee = numAmount * SWAP_FEE_RATE;
  const toReceive = numAmount - fee;

  const fromKey = from_platform_user_id != null ? platformKey(platform, from_platform_user_id) : null;
  const fromU = from_platform_user_id != null ? ensureUser(platform, from_platform_user_id) : null;

  if (USE_SECRET && process.env.MNEMONIC) {
    const toAddr = resolveRecipientToSecretAddress(recipient, users);
    if (toAddr) {
      let effective;
      try {
        effective = (secret_address && (viewing_key || permit))
          ? await getEffectiveBalanceFromCreds(secret_address, viewing_key, permit, fromU)
          : (fromU ? await getEffectiveBalance(fromU) : 0);
      } catch (e) {
        if (e?.message === "PERMIT_INVALID") return res.status(400).json({ ok: false, error: "permit_invalid", message: "Permit이 만료되었거나 유효하지 않습니다. 설정에서 Keplr를 다시 연결해 주세요." });
        if (e?.message === "VIEWING_KEY_INVALID") return res.status(400).json({ ok: false, error: "viewing_key_invalid", message: "뷰키가 만료되었거나 변경되었습니다. 설정에서 Keplr를 다시 연결해 주세요." });
        if (e?.message === "CHAIN_BALANCE_UNAVAILABLE") return res.status(400).json({ ok: false, error: "chain_balance_unavailable", message: "체인 잔액을 조회할 수 없습니다. 설정에서 Keplr를 다시 연결해 주세요." });
        throw e;
      }
      if (effective < numAmount) return res.status(400).json({ ok: false, error: err(loc, "insufficient_balance_swap") });
      if (fromU) fromU.balance = effective;
      const amountRaw = String(Math.floor(toReceive * 1e9));
      const result = await sendSnvr(toAddr, amountRaw);
      if (result.ok) {
        if (fromU) fromU.balance -= numAmount;
        const toKey = resolveRecipientToUserKey(recipient, platform);
        if (toKey && toKey !== fromKey) {
          const [p, id] = toKey.split(":");
          ensureUser(p, id).balance += toReceive;
          walletTxs.push({
            id: walletTxId++,
            type: "swap",
            from_key: fromKey,
            to_key: toKey,
            amount: numAmount,
            fee,
            meta: { recipient, txHash: result.txHash },
            created_at: new Date().toISOString(),
          });
        }
        saveDb();
        return res.json({ ok: true, txHash: result.txHash, fee, to_receive: toReceive });
      }
      return res.status(400).json({ ok: false, error: result.error });
    }
  }

  if (from_platform_user_id != null) {
    let effective;
    try {
      effective = (secret_address && (viewing_key || permit))
        ? await getEffectiveBalanceFromCreds(secret_address, viewing_key, permit, fromU)
        : await getEffectiveBalance(fromU);
    } catch (e) {
      if (e?.message === "PERMIT_INVALID") return res.status(400).json({ ok: false, error: "permit_invalid", message: "Permit이 만료되었거나 유효하지 않습니다. 설정에서 Keplr를 다시 연결해 주세요." });
      if (e?.message === "VIEWING_KEY_INVALID") return res.status(400).json({ ok: false, error: "viewing_key_invalid", message: "뷰키가 만료되었거나 변경되었습니다. 설정에서 Keplr를 다시 연결해 주세요." });
      if (e?.message === "CHAIN_BALANCE_UNAVAILABLE") return res.status(400).json({ ok: false, error: "chain_balance_unavailable", message: "체인 잔액을 조회할 수 없습니다. 설정에서 Keplr를 다시 연결해 주세요." });
      throw e;
    }
    if (effective < numAmount) return res.status(400).json({ ok: false, error: err(loc, "insufficient_balance_swap") });
    fromU.balance = effective;
    fromU.balance -= numAmount;
    const toKey = resolveRecipientToUserKey(recipient, platform);
    if (toKey && toKey !== fromKey) {
      const [p, id] = toKey.split(":");
      ensureUser(p, id).balance += toReceive;
      walletTxs.push({
        id: walletTxId++,
        type: "swap",
        from_key: fromKey,
        to_key: toKey,
        amount: numAmount,
        fee,
        meta: { recipient },
        created_at: new Date().toISOString(),
      });
    }
    saveDb();
  }

  if (MOCK) {
    saveDb();
    return res.json({ ok: true, txHash: `mock-swap-${Date.now()}`, fee, to_receive: toReceive });
  }
  if (USE_SECRET) {
    return res.status(400).json({ ok: false, error: err(loc, "recipient_must_be_secret") });
  }
  return res.status(501).json({ ok: false, error: err(loc, "chain_not_configured") });
});

// POST /mix — deprecated server-side routing path.
// Privacy Routing is now client-signed in messenger (Deposit -> Claim).
app.post("/mix", async (req, res) => {
  return res.status(410).json({
    ok: false,
    error: "routing_moved_to_client",
    message:
      "Privacy Routing is client-signed now. Use SNVR Messenger: Deposit to Relay Pool -> Claim (Recommended or Instant).",
  });
});

// 테스트용 잔액 (개발 시에만 사용)
app.post("/wallet/faucet", (req, res) => {
  const { platform = "telegram", platform_user_id, amount = 1000 } = req.body || {};
  if (!platform_user_id) return res.status(400).json({ ok: false, error: err(getLocale(req, platformKey(platform, platform_user_id)), "platform_user_id_required") });
  const u = ensureUser(platform, platform_user_id);
  const add = Number(amount) || 1000;
  u.balance += add;
  walletTxs.push({
    id: walletTxId++,
    type: "faucet",
    from_key: null,
    to_key: platformKey(platform, platform_user_id),
    amount: add,
    fee: 0,
    meta: null,
    created_at: new Date().toISOString(),
  });
  saveDb();
  return res.json({ ok: true, balance: u.balance, added: add });
});

// Health
app.get("/health", (_, res) => res.json({ ok: true, mock: MOCK }));

app.listen(PORT, () => {
  console.log(`Snvr backend on http://localhost:${PORT} (mock=${MOCK}, secret=${USE_SECRET})`);
  if (TELEGRAM_BOT_TOKEN) console.log("  [송금알림] 텔레그램 봇 토큰 로드됨 → 입금 시 텔레그램 알림 전송 가능");
  else console.warn("  [송금알림] TELEGRAM_BOT_TOKEN 없음 → backend/.env 또는 telegram-bot/.env의 BOT_TOKEN 필요");
});
