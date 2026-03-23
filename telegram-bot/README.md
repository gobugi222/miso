# Snvr Telegram Bot (6단계)

고스트스왑·믹싱을 텔레그램에서 호출. 백엔드 연동 시 `/swap`, `/mix`에서 실제 API 호출.

## 1. 봇 만들고 실행하기

### 1) BotFather에서 토큰 발급

1. 텔레그램에서 [@BotFather](https://t.me/BotFather) 연다.
2. `/newbot` 입력 후 봇 이름·username 지정 (예: `Snvr Bot`, `snvr_snvr_bot`).
3. 발급된 **토큰**을 복사 (예: `7123456789:AAH...`).
4. `/setdescription` → 봇 선택 → 아래 설명 붙여넣기:
   ```
   SNVR wallet, swap, mix, chat. Language auto by Telegram app (Settings → Language).
   ```

### 2) 환경 설정

```bash
cd aztec-dev/telegram-bot
cp .env.example .env
# .env 에 BOT_TOKEN=발급받은토큰 입력
# (선택) OWNER_TELEGRAM_ID=내텔레그램숫자ID — /ask 명령은 이 ID만 사용 가능
```

### 3) 실행

```bash
npm install
npm start
```

터미널에 `Snvr bot running` 나오면 텔레그램에서 봇 검색 후 `/start` 입력해 보기.

### 4) 백엔드 켜 두고 연동 (스왑/믹싱 호출)

1. **터미널 1 — 백엔드**
   ```bash
   cd aztec-dev/backend
   npm install
   MOCK_AZTEC=1 npm start
   ```
2. **터미널 2 — 봇** (`.env`에 `BACKEND_URL=http://localhost:3000` 추가 후)
   ```bash
   cd aztec-dev/telegram-bot
   npm start
   ```
3. 텔레그램에서 `/swap 100 0x...` 또는 `/mix 50 0x...` 입력 시 백엔드 API 호출 (mock 시 txHash 플레이스홀더 응답).

## 명령

- `/start` — 환영 메시지 + 메뉴
- `/swap 금액 수령인주소` — 고스트스왑 (백엔드 `/swap` 호출)
- `/mix 금액 수령인주소` — 믹싱 (백엔드 `/mix` 호출)

예: `/swap 100 0x123...` , `/mix 50 0x456...` (수령인은 Aztec 주소 형식. mock 시 아무 문자열 가능)

## 서버 배포 (24시간 실행)

서버(VPS 등)에 올려 두려면 **DEPLOY.md** 참고.

- 프로젝트 복사 → 서버에서 `.env` 생성(BOT_TOKEN) → `npm install` → `pm2 start ecosystem.config.cjs`
- 재부팅 후 자동 실행: `pm2 save` 후 `pm2 startup` 실행

## 보안

- 키는 봇/서버에 저장하지 않음. 가이드: `phase2/aztec/6단계_텔레그램_연동_가이드.md`
