/**
 * Optional PostgreSQL persistence for the in-memory `users` Map only.
 * Enabled when DATABASE_URL is set. Chat / walletTxs stay in db.json.
 */
import pg from "pg";

const { Pool } = pg;

function clampPgTimeout(raw, min, max, fallback) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min) return fallback;
  return Math.min(max, Math.trunc(n));
}

let pool = null;
let syncTimer = null;
const DEBOUNCE_MS = 2000;

export function isPgUsersEnabled() {
  return Boolean(String(process.env.DATABASE_URL || "").trim());
}

export async function initPgUsers() {
  if (!isPgUsersEnabled()) return;
  const url = String(process.env.DATABASE_URL).trim();
  const connectMs = clampPgTimeout(process.env.PG_CONNECTION_TIMEOUT_MS, 8000, 60000, 8000);
  pool = new Pool({
    connectionString: url,
    max: Math.min(10, Math.max(2, Number(process.env.PG_POOL_MAX) || 5)),
    connectionTimeoutMillis: connectMs,
  });
  await pool.query(`
    CREATE TABLE IF NOT EXISTS snv_users (
      user_key TEXT PRIMARY KEY,
      data JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS snv_users_updated_at_idx ON snv_users (updated_at DESC);
  `);
}

/**
 * If Postgres has no rows, seed from the current users Map (typically from db.json).
 * If Postgres has rows, replace the Map contents from the database.
 */
export async function hydrateUsersFromPostgres(usersMap) {
  if (!isPgUsersEnabled()) return { source: "off", count: usersMap.size };
  if (!pool) throw new Error("initPgUsers not called");

  const { rows: countRows } = await pool.query("SELECT COUNT(1)::int AS n FROM snv_users");
  const n = countRows[0]?.n ?? 0;

  if (n === 0) {
    const entries = [...usersMap.entries()];
    if (entries.length === 0) return { source: "empty", count: 0 };
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      for (const [key, data] of entries) {
        await client.query(
          `INSERT INTO snv_users (user_key, data, updated_at)
           VALUES ($1, $2::jsonb, NOW())
           ON CONFLICT (user_key) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
          [key, JSON.stringify(data)]
        );
      }
      await client.query("COMMIT");
    } catch (e) {
      try {
        await client.query("ROLLBACK");
      } catch (_r) {
        /* ignore */
      }
      throw e;
    } finally {
      client.release();
    }
    return { source: "seeded", count: entries.length };
  }

  const { rows } = await pool.query("SELECT user_key, data FROM snv_users");
  usersMap.clear();
  for (const r of rows) {
    const payload = r.data;
    usersMap.set(
      r.user_key,
      typeof payload === "object" && payload !== null ? payload : JSON.parse(String(payload))
    );
  }
  return { source: "postgres", count: rows.length };
}

async function flushUsersToPostgres(usersMap) {
  if (!pool || usersMap.size === 0) return;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const [key, data] of usersMap.entries()) {
      await client.query(
        `INSERT INTO snv_users (user_key, data, updated_at)
         VALUES ($1, $2::jsonb, NOW())
         ON CONFLICT (user_key) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
        [key, JSON.stringify(data)]
      );
    }
    await client.query("COMMIT");
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch (_r) {
      /* ignore */
    }
    throw e;
  } finally {
    client.release();
  }
}

export function scheduleSyncUsersToPostgres(usersMap) {
  if (!isPgUsersEnabled() || !pool) return;
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    syncTimer = null;
    flushUsersToPostgres(usersMap).catch((e) =>
      console.error("[pg_users] sync failed:", e?.message || e)
    );
  }, DEBOUNCE_MS);
}
