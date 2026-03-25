# Snvr Backend API

스왑·믹싱 + 지갑 + 스너버메신저 연동. 텔레그램 봇이 이 API를 호출합니다.

## Mock 모드 (체인 없이 테스트)

```bash
cd backend
npm install
MOCK_AZTEC=1 npm start
```

- `POST /swap` — body: `{ "amount": 100, "recipient": "@friend" }` → `{ "ok": true, "txHash": "mock-..." }`
- `POST /mix` — body: `{ "amount": 50, "recipient": "@friend" }` → `{ "ok": true, "txHash": "mock-..." }`
- `GET /wallet/balance` — `{ "ok": true, "balance": 0, "source": "memory" }`
- `GET /health` — `{ "ok": true, "mock": true }`

## Secret Network 연동 (SNVR)

```bash
SECRET_NETWORK=1 MNEMONIC=your_mnemonic npm start
```

- `Secret-Network/scripts/deploy-full.json`, `deploy-ghostswap.json` 필요
- `POST /wallet/link-secret` — body: `{ platform_user_id, secret_address, viewing_key }` (체인 잔액 조회용)
- `GET /wallet/balance` — 연동 시 SNIP-20 체인 잔액 반환
- `POST /swap`, `POST /mix` — 수령인이 secret1... 주소 또는 /link_secret 연동된 @사용자면 실제 체인 전송
- 백엔드 지갑(MNEMONIC)에 SNVR 보유 필요
