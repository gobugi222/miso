/**
 * PM2 설정 — 서버에서 백그라운드 실행 시 사용.
 * 사용법: pm2 start ecosystem.config.cjs
 */
module.exports = {
  apps: [
    {
      name: "snvr-bot",
      script: "src/bot.mjs",
      cwd: __dirname,
      interpreter: "node",
      env: { NODE_ENV: "production" },
      autorestart: true,
      max_restarts: 10,
      min_uptime: "10s",
    },
  ],
};
