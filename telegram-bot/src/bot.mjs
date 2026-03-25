/**
 * Snvr Telegram bot - 6단계 + AI 광고.
 * /start, /help, /swap, /route, /balance, /send, /receive, /link, /myid, /msg, /faucet, /ask(owner only), /adgen, /channels, /addchannel, /postad.
 */
import "dotenv/config";
import { Telegraf } from "telegraf";
import { readFile, writeFile, mkdir } from "fs/promises";
import { join } from "path";

const BOT_TOKEN = process.env.BOT_TOKEN;
const BACKEND_URL = process.env.BACKEND_URL || "";
const OWNER_TELEGRAM_ID = process.env.OWNER_TELEGRAM_ID || "";
const OLLAMA_URL = process.env.OLLAMA_URL || "";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "llama3.2";
const OLLAMA_TIMEOUT_MS = Number(process.env.OLLAMA_TIMEOUT_MS) || 60000;
const SERPER_API_KEY = process.env.SERPER_API_KEY || "";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_SEARCH_MODEL = process.env.GEMINI_SEARCH_MODEL || "gemini-1.5-flash";
const SEARCH_RESULTS_MAX = 7;
const AD_STATE_PATH = join(process.cwd(), "data", "ad-state.json");
/** 일반 POST/GET (채팅 검색 등) */
const BACKEND_FETCH_TIMEOUT_MS = Number(process.env.BACKEND_FETCH_TIMEOUT_MS) || 90000;
/** /wallet/balance 만 체인 LCD 재시도로 오래 걸릴 수 있음 — 봇이 60초에 끊으면 사용자만 타임아웃 당함 */
const BALANCE_FETCH_TIMEOUT_MS = Number(process.env.BALANCE_FETCH_TIMEOUT_MS) || 180000;
/** Telegraf 핸들러 한도 — balance 대기 시간보다 커야 함 */
const TELEGRAM_HANDLER_TIMEOUT_MS = Number(process.env.TELEGRAM_HANDLER_TIMEOUT_MS) || 240000;

const USER_LANG = new Map(); // userId -> "en" | "ko" | "ja"

/** 광고 상태 로드: { lastAd: { [chatId]: string }, channels: { [chatId]: string[] } } */
async function loadAdState() {
  try {
    const raw = await readFile(AD_STATE_PATH, "utf8");
    return JSON.parse(raw);
  } catch {
    return { lastAd: {}, channels: {} };
  }
}
async function saveAdState(state) {
  try {
    await mkdir(join(process.cwd(), "data"), { recursive: true });
    await writeFile(AD_STATE_PATH, JSON.stringify(state, null, 0), "utf8");
  } catch (e) {
    console.warn("saveAdState failed:", e?.message);
  }
}

/** 광고 대상 목록/마지막 광고를 구분할 사용자 키 (1:1이든 그룹이든 동일 유저로 통일) */
function getUserId(ctx) {
  return String(ctx.from?.id ?? ctx.chat?.id ?? "");
}

/** 텔레그램 앱 언어 설정 기반. 기본은 영어(en). */
function getLang(ctx) {
  const forced = USER_LANG.get(getUserId(ctx));
  if (forced === "ko" || forced === "ja" || forced === "en") return forced;
  const code = (ctx.from?.language_code || "en").toLowerCase().split("-")[0];
  if (code === "ko") return "ko";
  if (code === "ja") return "ja";
  return "en";
}

if (!BOT_TOKEN) {
  console.error("Set BOT_TOKEN env var (from @BotFather)");
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN, { handlerTimeout: TELEGRAM_HANDLER_TIMEOUT_MS });

function backendFetchError(e) {
  const n = e?.name || "";
  if (n === "TimeoutError" || n === "AbortError") {
    return { ok: false, data: { error: "⏱ 서버 응답 시간 초과. 잠시 후 다시 시도해 주세요. (Backend timeout)" } };
  }
  return { ok: false, data: { error: "Cannot connect to backend. Check if it's running. (ECONNREFUSED)" } };
}

async function callBackend(path, body) {
  if (!BACKEND_URL) return null;
  const url = `${BACKEND_URL.replace(/\/$/, "")}${path}`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(BACKEND_FETCH_TIMEOUT_MS),
    });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, data };
  } catch (e) {
    return backendFetchError(e);
  }
}

async function callBackendGet(pathWithQuery, timeoutMs) {
  if (!BACKEND_URL) return null;
  const url = `${BACKEND_URL.replace(/\/$/, "")}${pathWithQuery}`;
  const ms = timeoutMs != null && Number(timeoutMs) > 0 ? Number(timeoutMs) : BACKEND_FETCH_TIMEOUT_MS;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(ms) });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, data };
  } catch (e) {
    const n = e?.name || "";
    if (n === "TimeoutError" || n === "AbortError") {
      return { ok: false, data: { error: "⏱ 서버 응답 시간 초과. 잠시 후 다시 시도해 주세요. (Backend timeout)" } };
    }
    return { ok: false, data: {} };
  }
}

/** 웹 검색 (Serper). 실패 시(크레딧 소진 등) throw → Gemini fallback용. */
async function searchWeb(query) {
  if (!SERPER_API_KEY) return "";
  const url = "https://google.serper.dev/search";
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "X-API-KEY": SERPER_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ q: query }),
  });
  if (!res.ok) throw new Error(`Serper ${res.status}`);
  const data = await res.json().catch(() => ({}));
  const organic = data.organic || [];
  const lines = organic.slice(0, SEARCH_RESULTS_MAX).map((o) => `- ${o.title || ""}\n  ${o.snippet || ""}`);
  return lines.length ? "최신 웹 검색 결과:\n" + lines.join("\n\n") : "";
}

/** 웹 검색 폴백: Gemini Google Search grounding. 검색 참고 요약만 반환(답변은 Ollama가 함). */
async function searchViaGemini(query) {
  if (!GEMINI_API_KEY) return "";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_SEARCH_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
  const prompt =
    "다음 질문에 대해 웹 검색을 하고, 검색 결과를 바탕으로 '참고 자료 요약'만 간단히 정리해 주세요. 사용자에게 직접 답하지 말고, 참고 자료 요약만 한국어로 출력하세요.\n\n질문: " +
    query;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: 2048 },
      tools: [{ google_search: {} }],
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Gemini ${res.status}: ${err}`);
  }
  const data = await res.json().catch(() => ({}));
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "";
  return text ? "검색 참고 자료 (Gemini):\n" + (text.length > 3500 ? text.slice(0, 3497) + "..." : text) : "";
}

/** 코인/텔레그램 광고(3·5·7번) 질문일 때 넣을 지식 요약. */
function getAdsKnowledge(question) {
  const q = (question || "").toLowerCase();
  if (!/코인|광고|텔레그램|5번|7번|3번|대형\s*채널|인플루언서|톤코인|홍보/.test(q)) return "";
  return (
    "[참고 지식]\n" +
    "3번(채널 검색 TIP, 막 홍보할 때 무조건 권장): 홍보 멘트 미리 준비·번역해 두고 방출, 스팸 신고 대비. /adgen으로 미리 문구 생성해 두면 좋음.\n" +
    "5번(코인 광고 잘 하기): 대행사 노하우로 효율·저렴 단가 광고 제작. AI는 /adgen으로 문구 생성 가능.\n" +
    "7번(대형 채널 광고): 대형 가상화폐 텔레그램 채널에 유료 게시, 수수료 약 4.5%(VAT 포함) 등. AI는 /channels로 채널 검색·추천, /adgen으로 광고문 생성, 실제 게시는 채널 운영자와 비용 협의 후 진행.\n" +
    "해외 코인 유저 그룹: 해당 그룹에 봇 초대 후 그룹 안에서 /addtarget 하면 /postad 시 해당 그룹에도 광고 전송 가능."
  );
}

/** 검색 컨텍스트: Serper 우선, 실패 시 자동으로 Gemini로 대체. */
async function getSearchContext(question) {
  if (SERPER_API_KEY) {
    try {
      return await searchWeb(question);
    } catch {
      if (GEMINI_API_KEY) {
        try {
          return await searchViaGemini(question);
        } catch (e) {
          console.warn("Gemini search fallback failed:", e?.message || e);
        }
      }
      return "";
    }
  }
  if (GEMINI_API_KEY) {
    try {
      return await searchViaGemini(question);
    } catch (e) {
      console.warn("Gemini search failed:", e?.message || e);
    }
  }
  return "";
}

/** AI 비서: Ollama 호출. searchContext 있으면 검색 결과를 참고하도록 프롬프트에 포함. */
async function askOllama(question, searchContext = "") {
  if (!OLLAMA_URL) return null;
  const url = `${OLLAMA_URL.replace(/\/$/, "")}/api/generate`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OLLAMA_TIMEOUT_MS);
  try {
    let promptWithLang =
      "[중요: 답변은 반드시 한국어(한글)로만 작성하세요. Do not use Turkish, Japanese, or English in your answer. Only Korean.]\n\n";
    if (searchContext) {
      promptWithLang += searchContext + "\n\n위 검색 결과를 참고해서 아래 질문에 답해 주세요.\n\n";
    }
    promptWithLang += "질문: " + question;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        prompt: promptWithLang,
        stream: false,
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) throw new Error(`Ollama ${res.status}`);
    const data = await res.json().catch(() => ({}));
    const text = data.response?.trim() || "(no response)";
    return text.length > 4000 ? text.slice(0, 3997) + "..." : text;
  } catch (e) {
    clearTimeout(timeout);
    throw e;
  }
}

/** 광고 문구 생성 (Ollama). 텔레그램용 짧은 광고 1~2개. */
async function generateAdCopy(topic) {
  if (!OLLAMA_URL) return null;
  const url = `${OLLAMA_URL.replace(/\/$/, "")}/api/generate`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OLLAMA_TIMEOUT_MS);
  const prompt =
    "[답변은 반드시 한국어로만 작성하세요.]\n\n" +
    "다음 주제로 텔레그램에 올릴 수 있는 짧은 광고 문구를 1~2개만 작성해 주세요. " +
    "각 문구는 2~3문장, 이모지 1~2개 사용 가능. 직접적인 답만 출력.\n\n주제: " +
    (topic || "일반 광고");
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: OLLAMA_MODEL, prompt, stream: false }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) throw new Error(`Ollama ${res.status}`);
    const data = await res.json().catch(() => ({}));
    const text = data.response?.trim() || "";
    return text.length > 2000 ? text.slice(0, 1997) + "..." : text;
  } catch (e) {
    clearTimeout(timeout);
    throw e;
  }
}

bot.start(async (ctx) => {
  const hasBackend = BACKEND_URL ? "연동됨" : "미연동(플레이스홀더)";
  if (BACKEND_URL && ctx.from) {
    await callBackend("/wallet/register", {
      platform: "telegram",
      platform_user_id: String(ctx.from.id),
      username: ctx.from.username || null,
      locale: getLang(ctx),
    });
  }
  const lang = getLang(ctx);
  const startMsg = {
    ko:
      "💸 지갑: /balance | /send @친구 금액 | /receive | /link | /link_secret\n" +
      "💬 채팅: /msg @상대 메시지 | /myid (내 ID)\n" +
      "🔄 스왑(0.3%)·프라이버시 라우팅(1%): /swap 금액 @친구 | /route 금액 @친구\n" +
      "📖 /help — 사용법 상세\n",
    ja:
      "💸 ウォレット: /balance | /send @友達 金額 | /receive | /link | /link_secret\n" +
      "💬 チャット: /msg @相手 メッセージ | /myid\n" +
      "🔄 Swap(0.3%)・Privacy Routing(1%): /swap 金額 @友達 | /route 金額 @友達\n" +
      "📖 /help\n",
    en:
      "💸 Wallet: /balance | /send @friend amount | /receive | /link | /link_secret\n" +
      "💬 Chat: /msg @user message | /myid\n" +
      "🔄 Swap (0.3%) & Privacy Routing (1%): /swap amount @friend | /route amount @friend\n" +
      "📖 /help — detailed usage\n",
  };
  let msg = "👋 SNVR Bot\n\n" + (startMsg[lang] || startMsg.en);
  msg += "\n🌐 " + (lang === "ko" ? "언어: 텔레그램 앱 설정(언어)에 따라 자동 변경. Settings → Language에서 바꿀 수 있어요." : lang === "ja" ? "言語: Telegramアプリ設定で自動変更。Settings → Languageで変更できます。" : "Language: Auto by Telegram app. Change in Settings → Language.") + "\n";
  msg += `🔧 Backend: ${BACKEND_URL ? "on" : "off"}`;
  return ctx.reply(msg);
});

/** 고객용 사용법 안내 — 나라별 번역 (ko/ja/en) */
const HELP_MSG = {
  ko:
    "📌 SNVR 봇 사용 방법\n\n" +
    "💰 지갑\n" +
    "/balance — 잔액 조회\n" +
    "/send @친구 금액 — 전송 (또는 /send 받기코드 금액)\n" +
    "/receive — 1회용 받기 코드 생성\n" +
    "/link — 스너버메신저 웹 로그인 연동\n" +
    "/link_secret 주소 뷰키 — Secret Network 체인 연동\n\n" +
    "🔄 스왑·프라이버시 라우팅\n" +
    "/swap 금액 @친구 — 고스트스왑 (수수료 0.3%)\n" +
    "/route 금액 @친구 — 프라이버시 라우팅 (수수료 1%, 0.5% 소각+0.5% 운영)\n" +
    "※ 수령인: @텔레그램아이디, secret1... 주소, 또는 /link_secret 연동된 사용자\n\n" +
    "💬 채팅\n" +
    "/myid — 내 채팅 ID (스너버메신저 새 채팅용)\n" +
    "/msg @상대 메시지 — 메시지 전송\n\n" +
    "🌐 언어: 텔레그램 앱 설정(언어)에 따라 자동 변경",
  ja:
    "📌 SNVR ボットの使い方\n\n" +
    "💰 ウォレット\n" +
    "/balance — 残高照会\n" +
    "/send @友達 金額 — 送金 (/send 受取コード 金額 も可)\n" +
    "/receive — 1回限り受取コード生成\n" +
    "/link — SnvrMessenger Webログイン連携\n" +
    "/link_secret アドレス ビューキー — Secret Network連携\n\n" +
    "🔄 スワップ・プライバシー・ルーティング\n" +
    "/swap 金額 @友達 — GhostSwap (手数料0.3%)\n" +
    "/route 金額 @友達 — プライバシー・ルーティング (手数料1%, 0.5%焼却+0.5%運営)\n" +
    "※ 受取人: @テレグラムID, secret1... アドレス, または /link_secret 連携済み\n\n" +
    "💬 チャット\n" +
    "/myid — 自分のチャットID (SnvrMessenger新規チャット用)\n" +
    "/msg @相手 メッセージ — メッセージ送信\n\n" +
    "🌐 言語: Telegramアプリ設定で自動変更",
  en:
    "📌 SNVR Bot Usage\n\n" +
    "💰 Wallet\n" +
    "/balance — Check SNVR & SCRT balance\n" +
    "/send @friend amount — Send (or /send code amount)\n" +
    "/receive — Generate one-time receive code\n" +
    "/link — SNVR Messenger web login link\n" +
    "/link_secret secret1...address viewing_key — Link your Secret Network address\n\n" +
    "🔄 Swap & Privacy Routing\n" +
    "/swap amount @friend — GhostSwap (0.3% fee)\n" +
    "/route amount @friend — Privacy routing (1% fee, 0.5% burn + 0.5% ops)\n" +
    "※ Recipient: @telegram_id, secret1... address, or /link_secret linked user\n\n" +
    "💬 Chat\n" +
    "/myid — My chat ID (for SNVR Messenger new chat)\n" +
    "/msg @user message — Send message\n\n" +
    "🌐 Language: Auto by Telegram app. Change in Settings → Language.",
};

bot.command("help", async (ctx) => {
  const lang = getLang(ctx);
  return ctx.reply(HELP_MSG[lang] || HELP_MSG.en);
});

const SWAP_MSG = {
  ko: {
    noBackend: "[고스트스왑] BACKEND_URL을 설정하고 백엔드를 실행해 주세요.",
    usage: "사용법: /swap 금액 수령인\n예: /swap 100 @친구\n예: /swap 100 secret1...주소\n(수수료 0.3%)",
    invalidAmount: "금액은 양수로 입력해 주세요.",
    noConnect: "백엔드에 연결할 수 없어요. 백엔드를 실행했는지 확인해 주세요.",
    success: (r) => `✅ 고스트스왑 완료. 수수료 0.3% 차감 후 수령인 입금: ${r} SNVR`,
    successTx: (h) => `✅ 고스트스왑 완료. txHash: ${h}`,
    fail: (e) => `요청 실패: ${e}`,
    err: "처리 중 오류가 났습니다. 잠시 후 다시 시도해 주세요.",
  },
  ja: {
    noBackend: "[GhostSwap] BACKEND_URLを設定し、バックエンドを起動してください。",
    usage: "使い方: /swap 金額 受取人\n例: /swap 100 @友達\n例: /swap 100 secret1...アドレス\n(手数料0.3%)",
    invalidAmount: "金額は正の数で入力してください。",
    noConnect: "バックエンドに接続できません。起動しているか確認してください。",
    success: (r) => `✅ GhostSwap完了。手数料0.3%控除後、受取人入金: ${r} SNVR`,
    successTx: (h) => `✅ GhostSwap完了。txHash: ${h}`,
    fail: (e) => `リクエスト失敗: ${e}`,
    err: "処理中にエラーが発生しました。しばらくして再試行してください。",
  },
  en: {
    noBackend: "[GhostSwap] Set BACKEND_URL and run the backend.",
    usage: "Usage: /swap amount recipient\nEx: /swap 100 @friend\nEx: /swap 100 secret1...address\n(0.3% fee)",
    invalidAmount: "Please enter a positive amount.",
    noConnect: "Cannot connect to backend. Check if it's running.",
    success: (r) => `✅ GhostSwap done. After 0.3% fee, recipient receives: ${r} SNVR`,
    successTx: (h) => `✅ GhostSwap done. txHash: ${h}`,
    fail: (e) => `Request failed: ${e}`,
    err: "An error occurred. Please try again later.",
  },
};

// /lang 명령으로 언어 강제 설정: /lang en | /lang ko | /lang ja
bot.command("lang", async (ctx) => {
  const text = (ctx.message?.text || "").trim();
  const parts = text.split(/\s+/);
  const lang = (parts[1] || "").toLowerCase();
  const userId = getUserId(ctx);
  if (lang === "en" || lang === "ko" || lang === "ja") {
    USER_LANG.set(userId, lang);
    const msg =
      lang === "ko"
        ? "✅ 언어를 한국어로 설정했어요. /start 또는 /help 를 다시 입력해 주세요."
        : lang === "ja"
        ? "✅ 言語を日本語に設定しました。/start または /help を再入力してください。"
        : "✅ Language set to English. Type /start or /help again.";
    return ctx.reply(msg);
  }
  return ctx.reply(
    "Usage: /lang en | ko | ja\n\n" +
      "예시: /lang en (영어)\n" +
      "例: /lang ja (日本語)\n" +
      "예시: /lang ko (한국어)"
  );
});

bot.command("swap", async (ctx) => {
  try {
    const lang = getLang(ctx);
    const m = SWAP_MSG[lang] || SWAP_MSG.en;
    if (!BACKEND_URL) return ctx.reply(m.noBackend);
    const text = ctx.message?.text || "";
    const parts = text.trim().split(/\s+/).slice(1);
    const [amount, recipient] = parts;
    if (!amount || !recipient) return ctx.reply(m.usage);
    const numAmount = parseFloat(amount);
    if (numAmount <= 0) return ctx.reply(m.invalidAmount);
    const result = await callBackend("/swap", {
      amount: numAmount,
      recipient: recipient.trim(),
      platform: "telegram",
      from_platform_user_id: getUserId(ctx),
    });
    if (result === null) return ctx.reply(m.noConnect);
    if (result.ok && result.data?.ok) {
      const toReceive = result.data.to_receive;
      const msg = toReceive != null ? m.success(toReceive) : m.successTx(result.data.txHash || "-");
      return ctx.reply(msg);
    }
    return ctx.reply(m.fail(result.data?.error || result.data?.message || "unknown"));
  } catch (err) {
    const m = SWAP_MSG[getLang(ctx)] || SWAP_MSG.en;
    return ctx.reply(m.err);
  }
});

const MIX_MSG = {
  ko: {
    noBackend: "[Privacy Routing] BACKEND_URL을 설정하고 백엔드를 실행해 주세요.",
    usage: "사용법: /route 금액 수령인\n예: /route 50 @친구\n예: /route 50 secret1...주소\n(수수료 1%, 0.5% 소각+0.5% 운영)",
    invalidAmount: "금액은 양수로 입력해 주세요.",
    noConnect: "백엔드에 연결할 수 없어요. 백엔드를 실행했는지 확인해 주세요.",
    success: (r) => `✅ Privacy routing 완료. 수수료 1% 차감 후 수령인 입금: ${r} SNVR`,
    successTx: (h) => `✅ Privacy routing 완료. txHash: ${h}`,
    fail: (e) => `요청 실패: ${e}`,
    err: "처리 중 오류가 났습니다. 잠시 후 다시 시도해 주세요.",
  },
  ja: {
    noBackend: "[プライバシー・ルーティング] BACKEND_URLを設定し、バックエンドを起動してください。",
    usage: "使い方: /route 金額 受取人\n例: /route 50 @友達\n例: /route 50 secret1...アドレス\n(手数料1%, 0.5%焼却+0.5%運営)",
    invalidAmount: "金額は正の数で入力してください。",
    noConnect: "バックエンドに接続できません。起動しているか確認してください。",
    success: (r) => `✅ プライバシー・ルーティング完了。手数料1%控除後、受取人入金: ${r} SNVR`,
    successTx: (h) => `✅ プライバシー・ルーティング完了。txHash: ${h}`,
    fail: (e) => `リクエスト失敗: ${e}`,
    err: "処理中にエラーが発生しました。しばらくして再試行してください。",
  },
  en: {
    noBackend: "[Privacy Routing] Set BACKEND_URL and run the backend.",
    usage: "Usage: /route amount recipient\nEx: /route 50 @friend\nEx: /route 50 secret1...address\n(1% fee, 0.5% burn + 0.5% ops)",
    invalidAmount: "Please enter a positive amount.",
    noConnect: "Cannot connect to backend. Check if it's running.",
    success: (r) => `✅ Privacy routing done. After 1% fee, recipient receives: ${r} SNVR`,
    successTx: (h) => `✅ Privacy routing done. txHash: ${h}`,
    fail: (e) => `Request failed: ${e}`,
    err: "An error occurred. Please try again later.",
  },
};

bot.command("mix", async (ctx) => {
  try {
    const lang = getLang(ctx);
    const m = MIX_MSG[lang] || MIX_MSG.en;
    if (!BACKEND_URL) return ctx.reply(m.noBackend);
    const text = ctx.message?.text || "";
    const parts = text.trim().split(/\s+/).slice(1);
    const [amount, recipient] = parts;
    if (!amount || !recipient) return ctx.reply(m.usage);
    const numAmount = parseFloat(amount);
    if (numAmount <= 0) return ctx.reply(m.invalidAmount);
    const result = await callBackend("/mix", {
      amount: numAmount,
      recipient: recipient.trim(),
      platform: "telegram",
      from_platform_user_id: getUserId(ctx),
    });
    if (result === null) return ctx.reply(m.noConnect);
    if (result.ok && result.data?.ok) {
      const toReceive = result.data.to_receive;
      const msg = toReceive != null ? m.success(toReceive) : m.successTx(result.data.txHash || "-");
      return ctx.reply(msg);
    }
    return ctx.reply(m.fail(result.data?.error || result.data?.message || "unknown"));
  } catch (err) {
    const m = MIX_MSG[getLang(ctx)] || MIX_MSG.en;
    return ctx.reply(m.err);
  }
});

// /route is an alias of /mix for homepage-friendly wording (routes via the same backend endpoint).
bot.command("route", async (ctx) => {
  try {
    const lang = getLang(ctx);
    const m = MIX_MSG[lang] || MIX_MSG.en;
    if (!BACKEND_URL) return ctx.reply(m.noBackend);
    const text = ctx.message?.text || "";
    const parts = text.trim().split(/\s+/).slice(1);
    const [amount, recipient] = parts;
    if (!amount || !recipient) return ctx.reply(m.usage);
    const numAmount = parseFloat(amount);
    if (numAmount <= 0) return ctx.reply(m.invalidAmount);
    const result = await callBackend("/mix", {
      amount: numAmount,
      recipient: recipient.trim(),
      platform: "telegram",
      from_platform_user_id: getUserId(ctx),
    });
    if (result === null) return ctx.reply(m.noConnect);
    if (result.ok && result.data?.ok) {
      const toReceive = result.data.to_receive;
      const msg = toReceive != null ? m.success(toReceive) : m.successTx(result.data.txHash || "-");
      return ctx.reply(msg);
    }
    return ctx.reply(m.fail(result.data?.error || result.data?.message || "unknown"));
  } catch (err) {
    const m = MIX_MSG[getLang(ctx)] || MIX_MSG.en;
    return ctx.reply(m.err);
  }
});

/** 지갑·채팅 메시지 — 나라별 번역 */
const WALLET_MSG = {
  ko: {
    noBackend: "지갑 기능을 쓰려면 .env에 BACKEND_URL을 설정하고 백엔드를 실행해 주세요.",
    balanceFail: "잔액 조회 실패.",
    balance: (b) => `💰 SNVR 잔액: ${b}`,
    sendUsage: "사용법: /send @친구이름 금액 또는 /send 받기코드 금액\n예: /send @john 10\n예: /send 123456 5",
    sendFail: "송금 실패.",
    sendOk: (a, b) => `✅ ${a} SNVR 보냈어요. 남은 잔액: ${b}`,
    receiveFail: "받기 코드 생성 실패.",
    receiveOk: (sec, code) => `📥 1회용 받기 코드 (${sec}초 유효)\n\n코드: ${code}\n\n친구에게 이 코드를 알려주고, 친구는 /send ${code} 금액 으로 보내면 돼요.`,
    linkNoBackend: "BACKEND_URL을 설정하고 백엔드를 실행해 주세요.",
    linkFail: "연동 코드 생성 실패.",
    linkOk: (sec, code) => `🔗 스너버메신저 로그인 코드 (${sec}초 유효)\n\n코드: ${code}\n\n스너버메신저 웹에서 이 코드를 입력하면 같은 계정으로 로그인돼요.`,
    myid: (key, id) => `💬 내 채팅 ID\n\n${key}\n\n스너버메신저에서 새 채팅 시작할 때 위 ID를 입력하면 나와 대화할 수 있어요. (숫자만 입력해도 돼요: ${id})`,
    msgSent: "전송됐어요. 상대가 봇을 켜면 텔레그램으로도 알림 가고, 스너버메신저에서도 같은 대화 보여요.",
    msgNoBackend: "BACKEND_URL을 설정하고 백엔드를 실행해 주세요.",
    msgUsage: "사용법: /msg @상대이름 메시지  또는  /msg 상대숫자ID 메시지\n예: /msg @john 안녕 거래할게요",
    msgUserNotFound: "해당 사용자를 찾을 수 없어요. 상대가 봇을 한 번이라도 켜 봤어야 해요.",
    msgRoomFail: "채팅 방 만들기 실패.",
    msgSendFail: "메시지 전송 실패.",
    msgNotify: (sender, rest, replyTo) => `📩 ${sender} 님이 메시지를 보냈어요:\n\n${rest}\n\n답장: /msg ${replyTo} 답장내용`,
    received: (sender, amount, balance) => `💰 ${sender} 님이 ${amount} SNVR를 보냈어요!\n\n잔액: ${balance} SNVR`,
    unknown: "알 수 없음",
  },
  ja: {
    noBackend: "ウォレット機能を使うには.envにBACKEND_URLを設定し、バックエンドを起動してください。",
    balanceFail: "残高照会に失敗しました。",
    balance: (b) => `💰 SNVR残高: ${b}`,
    sendUsage: "使い方: /send @友達 金額 または /send 受取コード 金額\n例: /send @john 10\n例: /send 123456 5",
    sendFail: "送金に失敗しました。",
    sendOk: (a, b) => `✅ ${a} SNVR送金しました。残高: ${b}`,
    receiveFail: "受取コード生成に失敗しました。",
    receiveOk: (sec, code) => `📥 1回限り受取コード (${sec}秒有効)\n\nコード: ${code}\n\n友達にこのコードを教え、友達は /send ${code} 金額 で送金できます。`,
    linkNoBackend: "BACKEND_URLを設定し、バックエンドを起動してください。",
    linkFail: "連携コード生成に失敗しました。",
    linkOk: (sec, code) => `🔗 SnvrMessengerログインコード (${sec}秒有効)\n\nコード: ${code}\n\nSnvrMessenger Webでこのコードを入力すると同じアカウントでログインできます。`,
    myid: (key, id) => `💬 自分のチャットID\n\n${key}\n\nSnvrMessengerで新規チャット開始時に上記IDを入力すると私と会話できます。(数字のみ入力可: ${id})`,
    msgSent: "送信しました。相手がボットをオンにするとTelegramにも通知され、SnvrMessengerでも同じ会話が表示されます。",
    msgNoBackend: "BACKEND_URLを設定し、バックエンドを起動してください。",
    msgUsage: "使い方: /msg @相手 メッセージ または /msg 相手ID メッセージ\n例: /msg @john こんにちは 取引します",
    msgUserNotFound: "該当ユーザーが見つかりません。相手がボットを一度でも起動している必要があります。",
    msgRoomFail: "チャットルーム作成に失敗しました。",
    msgSendFail: "メッセージ送信に失敗しました。",
    msgNotify: (sender, rest, replyTo) => `📩 ${sender} からメッセージ:\n\n${rest}\n\n返信: /msg ${replyTo} 返信内容`,
    received: (sender, amount, balance) => `💰 ${sender} から${amount} SNVR届きました!\n\n残高: ${balance} SNVR`,
    unknown: "不明",
  },
  en: {
    noBackend: "Set BACKEND_URL in .env and run the backend for wallet features.",
    balanceFail: "Balance check failed.",
    balance: (b) => `💰 SNVR balance: ${b}`,
    sendUsage: "Usage: /send @friend amount or /send code amount\nEx: /send @john 10\nEx: /send 123456 5",
    sendFail: "Send failed.",
    sendOk: (a, b) => `✅ Sent ${a} SNVR. Balance: ${b}`,
    receiveFail: "Receive code generation failed.",
    receiveOk: (sec, code) => `📥 One-time receive code (valid ${sec}s)\n\nCode: ${code}\n\nShare this code with a friend. They can send: /send ${code} amount`,
    linkNoBackend: "Set BACKEND_URL and run the backend.",
    linkFail: "Link code generation failed.",
    linkOk: (sec, code) => `🔗 SnvrMessenger login code (valid ${sec}s)\n\nCode: ${code}\n\nEnter this code on SnvrMessenger web to log in with the same account.`,
    myid: (key, id) => `💬 My chat ID\n\n${key}\n\nEnter this ID in SnvrMessenger when starting a new chat to talk with me. (numbers only: ${id})`,
    msgSent: "Sent. If the recipient has the bot on, they'll get a Telegram notification and see the same chat in SnvrMessenger.",
    msgNoBackend: "Set BACKEND_URL and run the backend.",
    msgUsage: "Usage: /msg @user message or /msg userID message\nEx: /msg @john Hello, let's trade",
    msgUserNotFound: "User not found. They must have started the bot at least once.",
    msgRoomFail: "Failed to create chat room.",
    msgSendFail: "Failed to send message.",
    msgNotify: (sender, rest, replyTo) => `📩 Message from ${sender}:\n\n${rest}\n\nReply: /msg ${replyTo} your reply`,
    received: (sender, amount, balance) => `💰 ${sender} sent you ${amount} SNVR!\n\nBalance: ${balance} SNVR`,
    unknown: "Unknown",
  },
};

// ——— 지갑: 잔액·송금·받기 (플랫폼 무관 백엔드 → 나중에 스너버메신저로 2초 전환 가능)
bot.command("balance", async (ctx) => {
  const m = WALLET_MSG[getLang(ctx)] || WALLET_MSG.en;
  if (!BACKEND_URL) return ctx.reply(m.noBackend);
  const userId = getUserId(ctx);
  const res = await callBackendGet(
    `/wallet/balance?platform=telegram&platform_user_id=${encodeURIComponent(userId)}&locale=${getLang(ctx)}`,
    BALANCE_FETCH_TIMEOUT_MS
  );
  if (!res?.ok) return ctx.reply(res?.data?.error || m.balanceFail);
  return ctx.reply(m.balance(res.data.balance));
});

bot.command("send", async (ctx) => {
  const m = WALLET_MSG[getLang(ctx)] || WALLET_MSG.en;
  if (!BACKEND_URL) return ctx.reply(m.noBackend);
  const text = ctx.message?.text || "";
  const parts = text.replace(/^\/send\s*/i, "").trim().split(/\s+/);
  const to = parts[0]; // @username or 6-digit code
  const amount = parseFloat(parts[1]);
  if (!to || amount == null || amount <= 0) return ctx.reply(m.sendUsage);
  const userId = getUserId(ctx);
  const body = { platform: "telegram", from_platform_user_id: userId, amount, locale: getLang(ctx) };
  if (/^\d{6}$/.test(to)) body.to_one_time_code = to;
  else if (to.startsWith("@")) body.to_username = to.slice(1);
  else body.to_username = to;
  const res = await callBackend("/wallet/send", body);
  if (!res?.ok) return ctx.reply(res?.data?.error || m.sendFail);
  const recipientId = res.data?.recipient_telegram_id;
  if (recipientId) {
    const senderName = ctx.from?.username ? "@" + ctx.from.username : ctx.from?.first_name || "Someone";
    const recipientLang = res.data?.recipient_locale || "en";
    const m2 = WALLET_MSG[recipientLang] || WALLET_MSG.en;
    try {
      await ctx.telegram.sendMessage(recipientId, m2.received(senderName, amount, res.data.to_balance));
    } catch (_) {
      // recipient blocked bot or never started - ignore
    }
  }
  return ctx.reply(m.sendOk(amount, res.data.from_balance));
});

bot.command("receive", async (ctx) => {
  const m = WALLET_MSG[getLang(ctx)] || WALLET_MSG.en;
  if (!BACKEND_URL) return ctx.reply(m.noBackend);
  const res = await callBackend("/wallet/receive/generate", { platform: "telegram", platform_user_id: getUserId(ctx), locale: getLang(ctx) });
  if (!res?.ok) return ctx.reply(res?.data?.error || m.receiveFail);
  return ctx.reply(m.receiveOk(res.data.expires_in_sec, res.data.one_time_code));
});

// 스너버메신저 로그인용 연동 코드 (웹에서 이 코드 입력하면 같은 계정으로 로그인)
bot.command("link", async (ctx) => {
  const m = WALLET_MSG[getLang(ctx)] || WALLET_MSG.en;
  if (!BACKEND_URL) return ctx.reply(m.linkNoBackend);
  const res = await callBackend("/auth/link/generate", { platform: "telegram", platform_user_id: getUserId(ctx), locale: getLang(ctx) });
  if (!res?.ok) return ctx.reply(res?.data?.error || m.linkFail);
  return ctx.reply(m.linkOk(res.data.expires_in_sec, res.data.code));
});

// Secret Network 주소·뷰키 연동 (체인 잔액 조회, /swap·/route 수령인)
bot.command("link_secret", async (ctx) => {
  const m = WALLET_MSG[getLang(ctx)] || WALLET_MSG.en;
  if (!BACKEND_URL) return ctx.reply(m.linkNoBackend);
  const text = (ctx.message?.text || "").replace(/^\/link_secret\s+/i, "").trim();
  const parts = text.split(/\s+/);
  const [secretAddress, viewingKey] = parts;
  if (!secretAddress || !viewingKey) {
    const lang = getLang(ctx);
    const usage = lang === "ko" ? "사용법: /link_secret secret1...주소 뷰키" : lang === "ja" ? "使い方: /link_secret secret1...アドレス ビューキー" : "Usage: /link_secret secret1...address viewing_key";
    return ctx.reply(usage);
  }
  const res = await callBackend("/wallet/link-secret", {
    platform: "telegram",
    platform_user_id: getUserId(ctx),
    secret_address: secretAddress.trim(),
    viewing_key: viewingKey.trim(),
    locale: getLang(ctx),
  });
  if (!res?.ok) return ctx.reply(res?.data?.error || (m.linkNoBackend ? "Link failed." : "Link failed."));
  const linkOkMsg = { ko: "✅ Secret Network 주소 연동됨. /balance에서 체인 잔액 조회, /swap·/route 수령인으로 사용됩니다.", ja: "✅ Secret Network連携完了。 /balanceでチェーン残高照会、/swap·/routeの受取人に使用できます。", en: "✅ Secret Network address linked. Use /balance for chain balance, /swap·/route for recipient." };
  return ctx.reply(linkOkMsg[getLang(ctx)] || linkOkMsg.en);
});

// 채팅 시 상대가 나를 찾을 때 쓸 ID (스너버메신저 "새 채팅"에 입력)
bot.command("myid", async (ctx) => {
  const key = "telegram:" + getUserId(ctx);
  const m = WALLET_MSG[getLang(ctx)] || WALLET_MSG.en;
  return ctx.reply(m.myid(key, getUserId(ctx)));
});

// 봇으로 메시지 보내기 — 상대가 봇 켜면 텔레그램으로 알림, 같은 대화는 메신저에서도 보임
// 사용: /msg @username 메시지  또는  /msg 123456 메시지
bot.command("msg", async (ctx) => {
  const m = WALLET_MSG[getLang(ctx)] || WALLET_MSG.en;
  if (!BACKEND_URL) return ctx.reply(m.msgNoBackend);
  const text = (ctx.message?.text || "").replace(/^\/msg\s+/i, "").trim();
  const first = text.split(/\s/)[0];
  const rest = text.slice(first.length).trim();
  if (!first || !rest) return ctx.reply(m.msgUsage);
  let otherKey;
  if (/^\d+$/.test(first)) {
    otherKey = "telegram:" + first;
  } else if (first.startsWith("@")) {
    const res = await callBackendGet("/chat/resolve?q=" + encodeURIComponent(first.slice(1)));
    if (!res?.ok || !res?.data?.platform_key) return ctx.reply(res?.data?.error || m.msgUserNotFound);
    otherKey = res.data.platform_key;
  } else {
    const res = await callBackendGet("/chat/resolve?q=" + encodeURIComponent(first));
    if (!res?.ok || !res?.data?.platform_key) return ctx.reply(res?.data?.error || m.msgUserNotFound);
    otherKey = res.data.platform_key;
  }
  const myId = getUserId(ctx);
  const roomRes = await callBackend("/chat/room", { platform: "telegram", platform_user_id: myId, other_key: otherKey, locale: getLang(ctx) });
  if (!roomRes?.ok) return ctx.reply(roomRes?.data?.error || m.msgRoomFail);
  const msgRes = await callBackend("/chat/rooms/" + encodeURIComponent(roomRes.data.room_id) + "/messages", {
    platform: "telegram",
    platform_user_id: myId,
    text: rest,
    locale: getLang(ctx),
  });
  if (!msgRes?.ok) return ctx.reply(msgRes?.data?.error || m.msgSendFail);
  return ctx.reply(m.msgSent);
});

// ——— 광고: 문구 생성
bot.command("adgen", async (ctx) => {
  try {
    const text = ctx.message?.text || "";
    const topic = text.replace(/^\/adgen\s*/i, "").trim() || "일반";
    if (!OLLAMA_URL) return ctx.reply("Ollama가 설정되지 않았어요. .env에 OLLAMA_URL을 넣어 주세요.");
    await ctx.reply("광고 문구 만드는 중...");
    const ad = await generateAdCopy(topic);
    if (!ad) return ctx.reply("생성에 실패했어요. Ollama가 켜져 있는지 확인해 주세요.");
    const userId = getUserId(ctx);
    const state = await loadAdState();
    state.lastAd = state.lastAd || {};
    state.lastAd[userId] = ad;
    await saveAdState(state);
    return ctx.reply(
      "✅ 저장됐어요. /postad 로 등록한 채널·그룹(해외 코인방 등)에 올릴 수 있어요.\n\n" +
        ad +
        "\n\n💡 3번 TIP: 막 홍보할 땐 멘트 미리 준비·번역해 두고 올리면 좋아요. 스팸 신고 대비도 해 두세요."
    );
  } catch (err) {
    return ctx.reply(err?.name === "AbortError" ? "시간 초과예요. Ollama를 확인해 주세요." : "오류: " + (err?.message || "알 수 없음"));
  }
});

// ——— 채널 검색·추천 (웹 검색 후 요약)
bot.command("channels", async (ctx) => {
  try {
    const text = ctx.message?.text || "";
    const keyword = text.replace(/^\/channels\s*/i, "").trim();
    if (!keyword) return ctx.reply("사용법: /channels 키워드\n예: /channels 코인 광고");
    await ctx.reply("채널 검색 중...");
    const searchContext = await getSearchContext("telegram channel " + keyword + " 한국");
    const question = "위 검색 결과에서 텔레그램 채널(t.me, telegram.me 링크) 관련 항목만 골라서, 채널명과 링크를 정리한 추천 목록으로 알려줘. 한국어로만.";
    const answer = await askOllama(question, searchContext);
    return ctx.reply(answer || "검색 결과가 없거나 요약하지 못했어요. 키워드를 바꿔 보세요.");
  } catch (err) {
    return ctx.reply("검색 중 오류가 났어요. " + (err?.message || ""));
  }
});

// ——— 채널·그룹 등록: @채널명 또는 그룹 ID (-100xxxxxxxxxx)
bot.command("addchannel", async (ctx) => {
  try {
    const text = ctx.message?.text || "";
    const atMatch = text.match(/\s*(@[\w]+)/);
    const numMatch = text.match(/\s*(-?\d+)/);
    const target = atMatch ? atMatch[1].trim() : numMatch ? numMatch[1].trim() : "";
    if (!target) {
      return ctx.reply(
        "사용법: /addchannel @채널명 또는 /addchannel 그룹ID\n" +
          "예: /addchannel @mychannel\n" +
          "그룹 ID는 해당 그룹에서 /addtarget 쓰면 자동 등록돼요."
      );
    }
    const userId = getUserId(ctx);
    const state = await loadAdState();
    state.channels = state.channels || {};
    if (!state.channels[userId]) state.channels[userId] = [];
    if (state.channels[userId].includes(target)) return ctx.reply("이미 등록된 대상이에요.");
    state.channels[userId].push(target);
    await saveAdState(state);
    return ctx.reply(
      "등록했어요. 채널이면 봇을 관리자로, 그룹이면 봇을 멤버로 넣어 둔 뒤 /postad 또는 \"광고 해줘\" 로 올릴 수 있어요."
    );
  } catch (err) {
    return ctx.reply("등록 실패: " + (err?.message || ""));
  }
});

// ——— 지금 있는 그룹/채널을 광고 대상으로 추가 (해외 코인 유저방 등)
bot.command("addtarget", async (ctx) => {
  try {
    const chat = ctx.chat;
    if (chat?.type === "private") {
      return ctx.reply("1:1 채팅에서는 사용할 수 없어요. 광고 올릴 그룹이나 채널에 들어가서 /addtarget 을 입력해 주세요.");
    }
    const groupId = String(chat.id);
    const userId = getUserId(ctx);
    const state = await loadAdState();
    state.channels = state.channels || {};
    if (!state.channels[userId]) state.channels[userId] = [];
    if (state.channels[userId].includes(groupId)) return ctx.reply("이미 등록된 그룹/채널이에요.");
    state.channels[userId].push(groupId);
    await saveAdState(state);
    const name = chat.title || groupId;
    return ctx.reply(
      `등록했어요: ${name}. 이제 1:1 채팅에서 /postad 또는 "광고 해줘" 하면 여기에도 광고가 전송돼요. (봇이 이 그룹/채널에 남아 있어야 해요.)`
    );
  } catch (err) {
    return ctx.reply("등록 실패: " + (err?.message || ""));
  }
});

/** 등록된 채널·그룹에 마지막 광고문 포스팅. 결과 메시지 반환. */
async function postAdToChannels(ctx) {
  const userId = getUserId(ctx);
  const state = await loadAdState();
  const ad = state.lastAd?.[userId];
  const channels = state.channels?.[userId];
  if (!ad) return "먼저 /adgen 주제 로 광고 문구를 생성해 주세요.";
  if (!channels?.length) {
    return "먼저 채널/그룹을 등록해 주세요.\n• 채널: /addchannel @채널명\n• 그룹(해외 코인방 등): 해당 그룹에 들어가서 /addtarget 입력";
  }
  const results = [];
  for (const ch of channels) {
    try {
      await ctx.telegram.sendMessage(ch, ad);
      results.push(`${ch} ✅`);
    } catch (e) {
      results.push(`${ch} ❌ ${e?.message || "전송 실패"}`);
    }
  }
  return "광고 전송 결과:\n" + results.join("\n");
}

bot.command("postad", async (ctx) => {
  try {
    const msg = await postAdToChannels(ctx);
    return ctx.reply(msg);
  } catch (err) {
    return ctx.reply("전송 중 오류: " + (err?.message || ""));
  }
});

// AI 비서: OWNER_TELEGRAM_ID만 사용 가능. .env에 OWNER_TELEGRAM_ID=내텔레그램숫자ID 설정.
/** Handler errors default to rethrow + exitCode=1 — keep polling alive and log for Railway. */
bot.catch((err, ctx) => {
  console.error("[snvr-bot handler error]", err?.message || err, "update=", ctx?.update?.update_id);
  if (err?.stack) console.error(err.stack.slice(0, 500));
  const chatId = ctx?.chat?.id;
  if (chatId) {
    const msg =
      "일시적 오류가 났어요. 잠시 후 다시 시도해 주세요.\n(Temporary error — please try again.)";
    ctx.reply(msg).catch(() => {});
  }
});

bot.command("ask", async (ctx) => {
  const ownerId = String(OWNER_TELEGRAM_ID).trim();
  if (!ownerId || String(ctx.from?.id) !== ownerId) {
    const m = { ko: "이 명령은 사용할 수 없어요.", ja: "このコマンドは使用できません。", en: "This command is not available." };
    return ctx.reply(m[getLang(ctx)] || m.en);
  }
  try {
    const text = ctx.message?.text || "";
    const question = text.replace(/^\/ask\s*/i, "").trim();
    if (!question) {
      const usage = { ko: "사용법: /ask 질문내용", ja: "使い方: /ask 質問", en: "Usage: /ask your question" };
      return ctx.reply((usage[getLang(ctx)] || usage.en));
    }
    if (/광고\s*(해줘|올려줘|올려|포스팅)/.test(question)) {
      const msg = await postAdToChannels(ctx);
      return ctx.reply(msg);
    }
    if (OLLAMA_URL) {
      await ctx.reply("검색하고 생각 중이에요...");
      const searchContext = await getSearchContext(question);
      const extraKnowledge = getAdsKnowledge(question);
      const fullContext = [searchContext, extraKnowledge].filter(Boolean).join("\n\n");
      const answer = await askOllama(question, fullContext);
      return ctx.reply(answer || "답변을 생성하지 못했어요. 다시 질문해 주세요.");
    }
    return ctx.reply(
      "AI 비서 기능은 준비 중입니다.\n\n" +
        "Ollama를 쓰려면 .env에 다음을 넣고 봇을 재시작하세요:\n" +
        "OLLAMA_URL=http://localhost:11434\n" +
        "OLLAMA_MODEL=llama3.2\n\n" +
        "지금 질문: \"" + question + "\""
    );
  } catch (err) {
    const msg = err.name === "AbortError"
      ? "응답이 너무 오래 걸렸어요. Ollama가 켜져 있는지, 모델이 받아졌는지 확인해 주세요."
      : "AI 비서 연결에 실패했어요. OLLAMA_URL이 맞는지, Ollama가 실행 중인지 확인해 주세요.";
    return ctx.reply(msg);
  }
});

process.on("unhandledRejection", (reason) => {
  console.error("[snvr-bot unhandledRejection]", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[snvr-bot uncaughtException]", err?.message || err);
  process.exit(1);
});

bot
  .launch()
  .then(() => console.log("Snvr bot running (long polling). Set Railway replicas=1 for same BOT_TOKEN."))
  .catch((e) => {
    console.error("[bot.launch FAILED]", e?.message || e);
    process.exit(1);
  });

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
