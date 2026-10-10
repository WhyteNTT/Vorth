const { Pool } = require('pg');
const env = require('./env');
const { assertSchemaTargetAllowed } = require('./hostGuard');

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

/**
 * Quotes a SQL identifier.
 *
 * The names come from the constants above, so they are trusted - but they are
 * still interpolated, and a future edit should not be able to turn one into an
 * injection. Cheap to enforce, and enforcing it here means the check cannot be
 * forgotten when someone adds an upgrade entry.
 */
function ident(name) {
  if (!/^[a-z_][a-z0-9_]*$/i.test(String(name))) {
    throw new Error(`Unsafe SQL identifier rejected in a column upgrade: ${name}`);
  }
  return `"${name}"`;
}

/**
 * Columns added after their table first shipped.
 *
 * Kept as data rather than DDL in the schema string, because this is the one
 * part of boot that has to run ALTER TABLE. Each entry is applied only if the
 * catalog says the column is missing.
 */
const COLUMN_UPGRADES = [
  ['users', 'email_verified_at', 'timestamptz', 'Email verification timestamp.'],
  [
    'chapters',
    'takedown_reason',
    'text',
    'Why the chapter is removed. is_removed says *that* it is down; without this a '
    + 'DMCA counter-notice cannot tell a chapter it removed from one an admin or a '
    + 'court order removed since, and restoring the first would un-hide the second.',
  ],
  [
    'dmca_reports',
    'removal_series',
    'uuid REFERENCES series(id)',
    'The series this takedown actually removed, so a counter-notice knows what to '
    + 'restore. Set when a takedown is accepted.',
  ],
  [
    'dmca_reports',
    'removal_chapter',
    'uuid REFERENCES chapters(id)',
    'The chapter this takedown actually removed.',
  ],
  [
    'dmca_reports',
    'removal_at',
    'timestamptz',
    'When the takedown removed something.',
  ],
];

/**
 * Relaxes a column that was first created NOT NULL.
 *
 * Listed separately because it is a constraint change rather than an addition, and
 * it is the only unconditional ALTER left: there is no catalog check that means
 * "already nullable", so it is made idempotent by comparing the catalog to the
 * desired state first. On a database created by this version it never fires.
 */
const NULLABILITY_RELAXATIONS = [
  [
    'dmca_counter_notices',
    'response_deadline',
    // First created NOT NULL, on the reading that a counter-notice always has a
    // deadline. It does not: the clock starts when the notice is forwarded to the
    // complainant, and that can fail, so the deadline genuinely may not exist yet.
    'response_deadline',
  ],
];

/**
 * Applies only the column upgrades that are actually outstanding.
 *
 * The point is what it does *not* do. `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`
 * takes an ACCESS EXCLUSIVE lock in PostgreSQL even when the column already
 * exists, so leaving it in the boot path meant two instances starting together -
 * a rolling deploy, a scale-out, or two test files in one run - deadlocked against
 * each other. Reading the catalog first makes the steady state issue no ALTER at
 * all, and so take no lock.
 *
 * Columns are added nullable or with a default, so no existing row is rewritten.
 */
async function applyColumnUpgrades(pool) {
  const missing = [];
  for (const [table, column, type] of COLUMN_UPGRADES) {
    const { rows } = await pool.query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = $1 AND column_name = $2`,
      [table, column]
    );
    if (!rows.length) missing.push([table, column, type]);
  }

  const notNull = [];
  for (const [table, column] of NULLABILITY_RELAXATIONS) {
    const { rows } = await pool.query(
      `SELECT is_nullable FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = $1 AND column_name = $2`,
      [table, column]
    );
    if (rows.length && rows[0].is_nullable === 'NO') notNull.push([table, column]);
  }

  if (!missing.length && !notNull.length) return { applied: [], skipped: true };

  const applied = [];
  // Sequential on purpose: each ALTER takes an exclusive lock on its own table,
  // and issuing them concurrently turns a schema upgrade into a deadlock against
  // itself. There are five of them and they run once per deploy.
  for (const [table, column, type] of missing) {
    await pool.query(`ALTER TABLE ${ident(table)} ADD COLUMN ${ident(column)} ${type}`);
    applied.push(`+ ${table}.${column}`);
  }
  for (const [table, column] of notNull) {
    await pool.query(`ALTER TABLE ${ident(table)} ALTER COLUMN ${ident(column)} DROP NOT NULL`);
    applied.push(`~ ${table}.${column} is now nullable`);
  }
  return { applied, skipped: false };
}

/**
 * Opens the pool and brings the schema up to date.
 *
 * This issues CREATE TABLE, ALTER TABLE and CREATE INDEX, so before it does
 * anything it checks that the target is one where writing schema is expected.
 *
 * A local `.env` frequently points at a real production database. Any script
 * that boots the app - a health check, a script, a stray REPL - then migrates
 * production silently, because dotenv loaded that URL. That is not
 * hypothetical: it happened here, applying four new tables and two indexes to a
 * live Neon database that nobody had asked to touch.
 *
 * The rule is deployment versus accident, not local versus remote, because a
 * real deployment must be able to bring its own schema up on boot:
 *
 *   NODE_ENV=production                   allowed - this is a deployment
 *   local or non-managed host             allowed - this is development
 *   managed production host, otherwise    refused
 *
 * Set VORTH_ALLOW_SCHEMA_ON_PRODUCTION=1 to override the last case.
 */
/**
 * Closes the connection pool. A no-op when there is nothing to close, so the
 * unit suite and a failed boot can both call it without caring.
 */
async function closePool() {
  if (!activePool) return;
  const closing = activePool;
  activePool = null;
  try {
    await closing.end();
  } catch (_) {
    // Already closed, or the connection is already gone. Either way there is
    // nothing left to do, and a shutdown must not fail over this.
  }
}

async function connectDB() {
  const verdict = assertSchemaTargetAllowed(env.databaseUrl, process.env);
  if (!verdict.ok) {
    const error = new Error(`[db] ${verdict.reason}`);
    error.code = 'VORTH_SCHEMA_TARGET_REFUSED';
    throw error;
  }  if (process.env.VORTH_SCHEMA_GUARD_DEBUG === '1' && verdict.target) {
    console.log(`[db] schema target ${verdict.target.database}@${verdict.target.host} allowed`);
  }

  // Through getPool(), not the captured `pool`, so setPool() is honoured here
  // as it is everywhere else.
  const pool = getPool();

  /*
   * VORTH_SKIP_SCHEMA: connect, do not touch the schema.
   *
   * Every CREATE INDEX takes a ShareLock on its table even when it creates
   * nothing, which conflicts with the RowExclusiveLock any writer holds. Boot is
   * therefore not safe to run from several processes against one database at the
   * same time - a rolling deploy, a scale-out, or several test files in one
   * `node --test` run all deadlock against each other, which is exactly how the
   * live suite failed here.
   *
   * This flag exists for the case where the schema is already known good and
   * only a connection is wanted. It is not a way to deploy: a real instance must
   * be able to bring its own schema up, which is the whole reason the DDL lives
   * here rather than in a separate migration step.
   */
  /*
   * Read from process.env rather than the `env` snapshot, deliberately.
   *
   * Everything else in this module goes through env, which is read once at
   * require() time. This flag is different: it is a behavioural switch consulted
   * at the moment of the call, and a test has to be able to clear it after the
   * module is loaded and still get the real bootstrap. Reading the snapshot made
   * that impossible, and quietly turned "schema bootstrap is valid and
   * idempotent" into a test that asserted nothing.
   */
  const skipSchema = process.env.VORTH_SKIP_SCHEMA === '1' || process.env.VORTH_SKIP_SCHEMA === 'true';
  if (skipSchema) {
    console.log('[db] Connected to PostgreSQL (VORTH_SKIP_SCHEMA set; schema untouched)');
    return;
  }

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
      -- Same role as series.takedown_reason: is_removed says *that* content is
      -- down, this says *why*. Without it a DMCA counter-notice cannot tell a
      -- chapter it removed from one an admin or a court order removed since, and
      -- restoring the first would un-hide the second. Also added by the
      -- conditional upgrade below, for a table created before this column existed.
      takedown_reason text,
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
      -- Records that this takedown actually removed something, so a counter-notice
      -- knows what to restore. is_removed on its own does not say *why* content is
      -- down. Set when a takedown is accepted, and also added by the conditional
      -- upgrade below for a table created before these columns existed.
      removal_series uuid REFERENCES series(id), removal_chapter uuid REFERENCES chapters(id), removal_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
    );

    -- One row per (chapter, viewer, window). The UNIQUE constraint is what
    -- makes view counting idempotent: a repeat read inside the same window
    -- conflicts and does not increment anything.
    /*
   * Content Policy reports.
   *
   * Separate from dmca_reports on purpose. A DMCA notice is a copyright claim
   * carrying statutory weight and sworn statements; a policy report is a house
   * rule. Keeping them apart stops the two being confused, and stops a policy
   * report being dismissed because it lacks the elements a takedown notice
   * needs.
   *
   * Add a partial index for the queue: moderation only ever looks at unresolved
   * rows, and they are a small fraction of the table once it has any history.
   */
  CREATE TABLE IF NOT EXISTS content_reports (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    category text NOT NULL,
    description text NOT NULL,
    details text,
    reported_series uuid REFERENCES series(id),
    reported_chapter uuid REFERENCES chapters(id),
    reported_comment uuid REFERENCES comments(id),
    reporter_email text,
    reporter_account uuid REFERENCES users(id),
    status text NOT NULL DEFAULT 'pending',
    admin_notes text,
    resolved_at timestamptz,
    resolved_by uuid REFERENCES users(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );

  CREATE INDEX IF NOT EXISTS idx_reports_status ON content_reports (status, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_reports_series ON content_reports (reported_series);
  CREATE INDEX IF NOT EXISTS idx_reports_chapter ON content_reports (reported_chapter);

  -- Full-text search vector over the three fields a reader would search by.
  -- Generated and stored: no application code updates it, and adding it to a
  -- populated table computes it for the existing rows.
  ALTER TABLE series
    ADD COLUMN IF NOT EXISTS search_vector tsvector
    GENERATED ALWAYS AS (
      setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
      setweight(to_tsvector('english', coalesce(author, '')), 'B') ||
      setweight(to_tsvector('english', coalesce(artist, '')), 'B') ||
      setweight(to_tsvector('english', coalesce(synopsis, '')), 'C')
    ) STORED;

  CREATE INDEX IF NOT EXISTS idx_series_search ON series USING GIN (search_vector);

  /*
   * A counter-notice is the alleged infringer's reply to an accepted takedown.
   *
   * The three booleans are the statutory statements in 512(g)(3)(A)-(C), each
   * of which is made under penalty of perjury. They are stored as affirmations
   * rather than free text so a record cannot exist without them.
   *
   * status:
   *   pending   filed; the complainant has until response_deadline to say
   *             whether they filed a court action
   *   contested the complainant notified us that court proceedings began;
   *             content stays down
   *   restored  the window lapsed with no court action, so 512(g)(2)(C) permits
   *             the material to be put back
   *   withdrawn the subscriber retracted it
   */
  CREATE TABLE IF NOT EXISTS dmca_counter_notices (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    dmca_report uuid NOT NULL REFERENCES dmca_reports(id),
    subscriber_name text NOT NULL,
    subscriber_email text NOT NULL,
    subscriber_address text NOT NULL,
    identified_material text NOT NULL,
    material_location text NOT NULL,
    good_faith_statement boolean NOT NULL,
    perjury_statement boolean NOT NULL,
    jurisdiction_statement boolean NOT NULL,
    signature text NOT NULL,
    status text NOT NULL DEFAULT 'pending',
    -- Nullable on purpose. 512(g)(2)(A) requires the counter-notice to be
    -- forwarded to the complainant, and only the day it is forwarded starts
    -- their 10-to-14 business day clock. If the forward fails there is no
    -- deadline yet, so this stays null until it succeeds and the notice can be
    -- re-forwarded rather than being treated as already running.
    response_deadline timestamptz,
    forwarded_at timestamptz,
    forwarded_note text,
    resolved_at timestamptz,
    resolved_by uuid REFERENCES users(id),
    admin_notes text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );

  -- One counter-notice per takedown: a second would restart the clock and let a
  -- subscriber extend the deadline indefinitely.
  CREATE UNIQUE INDEX IF NOT EXISTS idx_counter_notice_unique_report
    ON dmca_counter_notices (dmca_report);
  -- The restoration sweep looks for lapsed windows.
  CREATE INDEX IF NOT EXISTS idx_counter_notice_pending
    ON dmca_counter_notices (status, response_deadline);

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

    -- Proof that the keep-warm ping is actually arriving.
    --
    -- A scheduled job that fires every 5 minutes exists to stop the free instance
    -- spinning down after 15. If it silently stops firing - the scheduler is
    -- missed, the job errors, the URL changed - nothing breaks immediately, and
    -- the only symptom is a reader hitting a cold instance weeks later. So each
    -- ping records itself, and the recorded gap is the evidence.
    --
    -- One row, updated in place. Not a log: the question is always "when did a
    -- ping last arrive", and a table that grows forever would answer a question
    -- nobody asks.
    CREATE TABLE IF NOT EXISTS service_heartbeat (
      service text PRIMARY KEY,
      last_ping_at timestamptz NOT NULL DEFAULT now(),
      -- The largest gap ever seen between two pings. Only ever increases, so
      -- evidence that the keep-warm job lapsed survives anyone poking the endpoint
      -- by hand afterwards.
      max_gap_seconds integer NOT NULL DEFAULT 0
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

  /*
   * Column upgrades, after the CREATE statements above and not before them.
   *
   * Order matters: an ALTER against a table that does not exist yet fails, so on
   * a brand new database this has to follow the schema. Running it first would
   * break the first boot of every fresh deployment.
   *
   * PostgreSQL takes an ACCESS EXCLUSIVE lock for ALTER TABLE even when the
   * statement does nothing, so `ADD COLUMN IF NOT EXISTS` against a column that
   * already exists still locks the table against every reader and writer. That
   * made two instances booting at the same time deadlock against each other - a
   * rolling deploy, a scale-out, or simply two processes in one test run. Reading
   * the catalog first means the steady state issues no ALTER at all, and so takes
   * no lock.
   */
  const upgrades = await applyColumnUpgrades(pool);
  if (!upgrades.skipped) console.log(`[db] column upgrades applied: ${upgrades.applied.join(', ')}`);

  console.log('[db] Connected to PostgreSQL (schema + indexes ensured)');
}

module.exports = {
  get pool() { return activePool; },
  getPool,
  setPool,
  connectDB,
  /**
   * Closes the pool, so a shutdown does not leave connections for the OS to
   * reclaim.
   *
   * Not cosmetic: Render sends SIGTERM before it recycles an instance, and a
   * process that exits with the pool still open reports the shutdown as abrupt in
   * the logs even when every request completed. Safe to call when there is no
   * pool, which is what happens in the unit suite.
   */
  closePool,
  withTransaction,
  // Exported for tests: the upgrade step has to be provable as a no-op on an
  // up-to-date schema, which is the property that keeps boot lock-free.
  _applyColumnUpgrades: applyColumnUpgrades,
  _columnUpgrades: COLUMN_UPGRADES,
};