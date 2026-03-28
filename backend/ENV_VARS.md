# 백엔드 환경 변수 (Railway / 로컬)

점(`.`)으로 시작하는 샘플 파일 대신 레포에 올릴 용도. 실제 값은 Railway **Variables** 또는 로컬 `.env`에만 넣는다.

## 일반

| 변수 | 설명 |
|------|------|
| `PORT` | 기본 `3000` |
| `MOCK_AZTEC` | `1`이면 목업 모드 (봇 테스트 등). 실체인은 미설정 또는 `0` |
| `ZERO_LOG` | `1` 권장: 지갑 매칭·채팅·전송 내역 미저장 |
| `WALLET_TX_RETENTION_MS` | `walletTxs` 행 보관 시간(밀리초). 기본 **1800000**(30분). `0`이면 TTL 끔. `loadDb`/`saveDb` 시 오래된 행 제거 |

## Telegram / 메신저

| 변수 | 설명 |
|------|------|
| `TELEGRAM_BOT_TOKEN` | BotFather 토큰 |
| `MESSENGER_URL` | 예: `https://app.snvr.org` — 받기 링크 생성용 |

## Secret Network (SNVR)

| 변수 | 설명 |
|------|------|
| `SECRET_NETWORK` | 실제 체인: `1` |
| `MNEMONIC` | 백엔드 지갑 니모닉 (전송 등에 필요) |
| `CHAIN_ID` | 메인넷: `secret-4` |
| `LCD_URL` | 예: 메인넷 LCD REST 루트 |
| `LCD_URL_FALLBACKS` | 쉼표로 구분한 추가 LCD (선택) |
| `LCD_MAX_URLS` | 후보 개수 상한 (선택) |
| `LCD_PROBE_PER_URL_MS` | LCD 요청당 타임아웃 (선택) |
| `BALANCE_CHAIN_BUDGET_MS` | 잔액 백그라운드 조회 상한 (선택) |
| `BAL_CACHE_TTL_MS` | 잔액 짧은 캐시 TTL (선택) |

배포 시 `Secret-Network/scripts/deploy-full.json` 등이 잡히면 토큰 주소·code hash는 거기서 읽는다. **Railway에서 경로가 안 맞으면** 아래로 명시:

| 변수 | 설명 |
|------|------|
| `SNVR_TOKEN` | SNIP-20 컨트랙트 주소 (예: `secret1d6q...`) |
| `SNVR_CODE_HASH` | 해당 코드 해시 (`deploy-full.json`의 `snvr_code_hash`와 동일) |

## Query Gateway (DigitalOcean 등 VPS)

permit 잔액은 설정 시 Gateway가 LCD 레이스·캐시를 담당하고, 백엔드는 여기로 먼저 요청한다.

| 변수 | 설명 |
|------|------|
| `QUERY_GATEWAY_URL` | 예: `https://query.snvr.org` (끝 슬래시 없이) |
| `QUERY_GATEWAY_TOKEN` | Gateway `AUTH_TOKEN`과 맞출 때만 (Bearer) |
| `QUERY_GATEWAY_CLIENT_TIMEOUT_MS` | Railway→Gateway HTTP 타임아웃, 기본 권장 **25000**~30000 |

Gateway가 켜져 있으면 POST `/wallet/balance` 기본 체인 조회 예산도 길게 잡힌다(타임아웃 연쇄 방지).

## 잔액 API: 한 번에 체인까지 기다리기 (권장)

기본 동작은 **즉시 응답 + 백그라운드 조회**라서 첫 JSON에 `balance=0`, `memory_fallback`이 나올 수 있다.  
폴링 없이 한 요청으로 체인 잔고를 채우려면:

| 엔드포인트 | 파라미터 |
|------------|----------|
| `GET /wallet/balance` | `sync_chain=1` (쿼리). 서버에 지갑(permit)이 저장돼 있어야 함. |
| `POST /wallet/balance` | 본문 `"sync_chain": true` 또는 `"sync_chain": "1"` (주소+permit 포함 시). |

응답은 최대 약 **수십 초** 걸릴 수 있다(게이트웨이·LCD·`budget_ms`에 따름).


## 텔레그램 /pool (릴레이 풀 링크·요약)

| 변수 | 설명 |
|------|------|
| MESSENGER_URL | /routing/telegram-deeplink 가 만드는 베이스 URL (필수) |
| MESSENGER_PRIVACY_ROUTING_PATH | 기본 /wallet — 최종 MESSENGER_URL + 경로 + ?telegram_user_id= |
| MESSENGER_RELAY_API_URL | (선택) 티켓 요약 API 베이스 |
| MESSENGER_RELAY_SUMMARY_PATH | 기본 /api/bot/routing/summary |
| MESSENGER_RELAY_API_TOKEN | (선택) Bearer |
| MESSENGER_RELAY_FETCH_MS | upstream 타임아웃 (기본 25000) |

백엔드 엔드포인트: GET /routing/telegram-deeplink?platform_user_id=, GET /routing/telegram-summary?platform_user_id=

## 참고

- 로컬 개발용 샘플은 같은 폴더의 `.env.example`를 복사해 `.env`로 쓸 수 있다 (레포에는 `.env` 커밋 금지).
- 설계/ Droplet 절차: 상위 디렉터리 `WORKING-STATE.md`, `QUERY-GATEWAY-PLAN.md`
