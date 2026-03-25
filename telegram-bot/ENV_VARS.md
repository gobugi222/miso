# Environment variables (Telegram bot)

If your Git client or OS hides dotfiles, copy the values below into `.env` (do not commit `.env`).

See also `.env.example` in this folder (same content).

```
BOT_TOKEN=
BACKEND_URL=http://localhost:3000
# BACKEND_FETCH_TIMEOUT_MS=45000
# TELEGRAM_HANDLER_TIMEOUT_MS=180000
# OWNER_TELEGRAM_ID=
OLLAMA_URL=http://localhost:11434
OLLAMA_MODEL=llama3.2
# SERPER_API_KEY=
# GEMINI_API_KEY=
```

## Git ignore rules (if `.gitignore` will not upload)

This folder includes `gitignore.template` (no leading dot). After upload, on GitHub use **Rename** to `.gitignore`, or locally: copy it to `.gitignore` in the same directory.
