const { Pool } = require('pg');
const env = require('./env');

const pool = new Pool({
  connectionString: env.databaseUrl,
  ssl: env.databaseSsl ? { rejectUnauthorized: false } : undefined,
  max: 10,
});

pool.on('error', (err) => {
  console.error('[db] idle client error:', err.message);
});

/**
 * The pool every caller should use. Exposed through a getter so tests can
 * swap in a double via setPool() without the data layer holding a stale
 * reference captured at require() time.
 */
let activePool = pool;
const getPool = () => activePool;

/** Test seam — injects a pool double. Pass nothing to restore the real one. */
function setPool(next) { activePool = next || pool; }

/**
 * Runs `fn` inside a transaction, rolling back on any throw.
 * Use this for multi-statement writes that must not be observed half-applied.
 */
async function withTransaction(fn) {
  const client = await activePool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* connection already broken */ }
    throw err;
  } finally {
    client.release();
  }
}

async function connectDB() {
  await pool.query(`
    CREATE EXTENSION IF NOT EXISTS pgcrypto;
    CREATE TABLE IF NOT EXISTS users (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), display_name text NOT NULL,
      username text UNIQUE NOT NULL, email text UNIQUE NOT NULL, password text NOT NULL,
      role text NOT NULL DEFAULT 'user', bio text NOT NULL DEFAULT '', library jsonb NOT NULL DEFAULT '[]',
      downloads jsonb NOT NULL DEFAULT '[]', agreed_to_terms_at timestamptz NOT NULL,
      age_confirmed boolean NOT NULL DEFAULT true, is_banned boolean NOT NULL DEFAULT false,
      ban_reason text, last_login_at timestamptz, email_verified_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    -- Added after the initial schema shipped; kept idempotent for upgrades.
    ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified_at timestamptz;
    CREATE TABLE IF NOT EXISTS series (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), title text NOT NULL, slug text UNIQUE NOT NULL,
      type text NOT NULL, owner uuid NOT NULL REFERENCES users(id), author text NOT NULL, artist text,
      genres jsonb NOT NULL DEFAULT '[]', tags jsonb NOT NULL DEFAULT '[]', status text NOT NULL DEFAULT 'Ongoing',
      synopsis text NOT NULL, cover_image text, views jsonb NOT NULL DEFAULT '{"daily":0,"weekly":0,"alltime":0}',
      last_daily_reset timestamptz NOT NULL DEFAULT now(), last_weekly_reset timestamptz NOT NULL DEFAULT now(),
      rating_avg numeric NOT NULL DEFAULT 0, rating_count integer NOT NULL DEFAULT 0, chapter_count integer NOT NULL DEFAULT 0,
      rights_attested_at timestamptz NOT NULL, is_removed boolean NOT NULL DEFAULT false, takedown_reason text,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS chapters (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), series uuid NOT NULL REFERENCES series(id), num integer NOT NULL,
      title text NOT NULL, paragraphs jsonb, pages jsonb, views integer NOT NULL DEFAULT 0, is_removed boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(series,num)
    );
    CREATE TABLE IF NOT EXISTS comments (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), series uuid NOT NULL REFERENCES series(id), "user" uuid NOT NULL REFERENCES users(id),
      rating integer NOT NULL, text text NOT NULL, parent uuid REFERENCES comments(id), is_removed boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS notifications (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "user" uuid NOT NULL REFERENCES users(id), type text NOT NULL,
      message text NOT NULL, series uuid REFERENCES series(id), is_read boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS reading_progress (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "user" uuid NOT NULL REFERENCES users(id), series uuid NOT NULL REFERENCES series(id),
      chapter uuid NOT NULL REFERENCES chapters(id), type text NOT NULL, scroll_pct numeric NOT NULL DEFAULT 0,
      page integer NOT NULL DEFAULT 0, bookmarked boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE("user",series)
    );
    CREATE TABLE IF NOT EXISTS dmca_reports (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), reporter_name text NOT NULL, reporter_email text NOT NULL,
      reporter_organization text, reporter_address text, copyrighted_work_description text NOT NULL, original_work_url text,
      infringing_series uuid REFERENCES series(id), infringing_chapter uuid REFERENCES chapters(id), infringing_url_description text,
      good_faith_statement boolean NOT NULL, accuracy_statement boolean NOT NULL, signature text NOT NULL,
      status text NOT NULL DEFAULT 'pending', admin_notes text, resolved_at timestamptz, resolved_by uuid REFERENCES users(id),
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
    );

    -- One row per (chapter, viewer, window). The UNIQUE constraint is what
    -- makes view counting idempotent: a repeat read inside the same window
    -- conflicts and does not increment anything.
    CREATE TABLE IF NOT EXISTS view_events (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      series uuid NOT NULL REFERENCES series(id) ON DELETE CASCADE,
      chapter uuid NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
      viewer text NOT NULL,
      window_start timestamptz NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(chapter, viewer, window_start)
    );

    -- Long-lived tokens. Only the SHA-256 hash is stored, so a database leak
    -- does not hand an attacker usable sessions.
    CREATE TABLE IF NOT EXISTS refresh_tokens (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "user" uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash text NOT NULL UNIQUE,
      user_agent text, ip text,
      expires_at timestamptz NOT NULL,
      revoked_at timestamptz, replaced_by uuid REFERENCES refresh_tokens(id),
      created_at timestamptz NOT NULL DEFAULT now()
    );

    -- Single-use, expiring tokens for email verification and password reset.
    CREATE TABLE IF NOT EXISTS auth_tokens (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "user" uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      purpose text NOT NULL,
      token_hash text NOT NULL UNIQUE,
      expires_at timestamptz NOT NULL,
      consumed_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now()
    );

    -- Shared rate-limit counters, so limits survive a deploy and work across
    -- instances when RATE_LIMIT_STORE=postgres.
    CREATE TABLE IF NOT EXISTS rate_limit_buckets (
      bucket text PRIMARY KEY,
      hits integer NOT NULL DEFAULT 0,
      window_started_at timestamptz NOT NULL DEFAULT now()
    );

    -- ---- indexes (idempotent) ----
    CREATE INDEX IF NOT EXISTS idx_chapters_series   ON chapters (series, num);
    CREATE INDEX IF NOT EXISTS idx_comments_series   ON comments (series) WHERE is_removed = false;
    CREATE INDEX IF NOT EXISTS idx_comments_user     ON comments ("user");
    CREATE INDEX IF NOT EXISTS idx_notif_user        ON notifications ("user", created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_notif_unread      ON notifications ("user") WHERE is_read = false;
    CREATE INDEX IF NOT EXISTS idx_progress_user     ON reading_progress ("user", updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_series_owner      ON series (owner);
    CREATE INDEX IF NOT EXISTS idx_series_listing    ON series (is_removed, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_series_popular    ON series (((views->>'alltime')::bigint) DESC);
    CREATE INDEX IF NOT EXISTS idx_series_daily      ON series (((views->>'daily')::bigint) DESC);
    CREATE INDEX IF NOT EXISTS idx_series_rating     ON series (rating_avg DESC, rating_count DESC);
    CREATE INDEX IF NOT EXISTS idx_series_title      ON series (title text_pattern_ops);
    CREATE INDEX IF NOT EXISTS idx_series_genres     ON series USING gin (genres);
    CREATE INDEX IF NOT EXISTS idx_series_tags       ON series USING gin (tags);
    CREATE INDEX IF NOT EXISTS idx_users_library     ON users USING gin (library);
    CREATE INDEX IF NOT EXISTS idx_dmca_status       ON dmca_reports (status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_view_events_chap  ON view_events (chapter, window_start);
    CREATE INDEX IF NOT EXISTS idx_refresh_user      ON refresh_tokens ("user", expires_at DESC);
    CREATE INDEX IF NOT EXISTS idx_refresh_active    ON refresh_tokens (token_hash) WHERE revoked_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_authtok_user      ON auth_tokens ("user", purpose);
    CREATE INDEX IF NOT EXISTS idx_authtok_expiry    ON auth_tokens (expires_at);
    CREATE INDEX IF NOT EXISTS idx_ratelimit_window  ON rate_limit_buckets (window_started_at);
  `);
  console.log('[db] Connected to PostgreSQL (schema + indexes ensured)');
}

module.exports = {
  get pool() { return activePool; },
  getPool,
  setPool,
  connectDB,
  withTransaction,
};