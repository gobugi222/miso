# 서버 배포 가이드 (텔레그램 봇)

VPS·클라우드 서버(Ubuntu 등 Linux)에 봇을 올려 24시간 실행하는 방법.

---

## 1. 서버 준비

- Node.js 18 이상 설치
  ```bash
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
  node -v
  ```
- (선택) PM2 전역 설치 — 재시작·로그 관리
  ```bash
  sudo npm install -g pm2
  ```

---

## 2. 프로젝트 올리기

서버에 `telegram-bot` 폴더를 복사합니다.

- **Git 사용 시:** 서버에서 `git clone` 후 `telegram-bot`만 복사하거나, 봇만 있는 저장소 사용
- **직접 복사:** PC에서 `aztec-dev/telegram-bot` 폴더를 scp/sftp로 서버에 업로드
  ```bash
  scp -r aztec-dev/telegram-bot user@서버IP:/home/user/
  ```

`.env`는 **서버에서 새로 만듭니다** (토큰을 Git/업로드에 넣지 않기 위해).

---

## 3. 서버에서 설정

```bash
cd /home/user/telegram-bot   # 실제 경로로 변경

# 의존성 설치
npm install

# .env 생성 (nano 또는 vim)
nano .env
```

**.env 내용 예시:**
```env
BOT_TOKEN=발급받은_봇_토큰
BACKEND_URL=http://localhost:3000
```
저장 후 종료.

---

## 4. 실행 (PM2 권장)

```bash
# PM2로 백그라운드 실행
pm2 start ecosystem.config.cjs

# 재부팅 후에도 자동 실행하려면 (한 번만)
pm2 save
pm2 startup
# 나오는 명령어를 복사해서 실행
```

**PM2 자주 쓰는 명령:**
- 상태: `pm2 status`
- 로그: `pm2 logs snvr-bot`
- 중지: `pm2 stop snvr-bot`
- 재시작: `pm2 restart snvr-bot`

---

## 5. PM2 없이 실행 (간단 테스트)

```bash
npm start
```
터미널을 닫으면 봇이 종료됩니다. 상시 운영은 PM2 사용 권장.

---

## 6. 백엔드도 같은 서버에서 돌릴 때

봇이 `BACKEND_URL=http://localhost:3000` 을 쓰는 경우, 같은 서버에서 백엔드를 띄우려면:

1. `aztec-dev/backend` 도 서버에 복사
2. 터미널 1 또는 PM2로 백엔드 실행:
   ```bash
   cd backend && MOCK_AZTEC=1 npm start
   ```
3. PM2로 백엔드도 등록하려면 `backend/ecosystem.config.cjs` 를 따로 만들거나, 같은 ecosystem에 app 두 개로 추가하면 됨.

---

이 가이드는 `aztec-dev/telegram-bot` 폴더 기준입니다.
