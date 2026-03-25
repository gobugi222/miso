# Environment variables (backend)

If your Git client or OS hides dotfiles, copy the values below into a file named `.env` (do not commit `.env`).

See also `.env.example` in this folder (same content).

```
PORT=3000
MOCK_AZTEC=1
# ZERO_LOG=1
# TELEGRAM_BOT_TOKEN=
# MESSENGER_URL=
# SECRET_NETWORK=1
# MNEMONIC=
# CHAIN_ID=secret-4
# LCD_URL=https://lcd.secret.express
# LCD_URL_FALLBACKS=https://rest.lavenderfive.com/secretnetwork
```

Contract addresses usually come from `Secret-Network/scripts/deploy-full.json` (and ghostswap JSON) after deploy.
