'use strict';

/**
 * Test-only PostgreSQL double.
 *
 * It records every statement the data layer emits and answers the small
 * subset of SQL the models generate, so the suite can assert on the exact
 * queries issued (which is where the real bugs lived) without needing a
 * live database.
 */

const COLUMNS = {
  users: ['id', 'display_name', 'username', 'email', 'password', 'role', 'bio', 'library',
    'downloads', 'agreed_to_terms_at', 'age_confirmed', 'is_banned', 'ban_reason',
    'email_verified_at', 'last_login_at', 'created_at', 'updated_at'],
  series: ['id', 'title', 'slug', 'type', 'owner', 'author', 'artist', 'genres', 'tags',
    'status', 'synopsis', 'cover_image', 'views', 'last_daily_reset', 'last_weekly_reset',
    'rating_avg', 'rating_count', 'chapter_count', 'rights_attested_at', 'is_removed',
    'takedown_reason', 'search_vector', 'created_at', 'updated_at'],
  chapters: ['id', 'series', 'num', 'title', 'paragraphs', 'pages', 'views', 'is_removed',
    'created_at', 'updated_at'],
  comments: ['id', 'series', 'user', 'rating', 'text', 'parent', 'is_removed', 'created_at', 'updated_at'],
  notifications: ['id', 'user', 'type', 'message', 'series', 'is_read', 'created_at', 'updated_at'],
  reading_progress: ['id', 'user', 'series', 'chapter', 'type', 'scroll_pct', 'page',
    'bookmarked', 'created_at', 'updated_at'],
  dmca_reports: ['id', 'reporter_name', 'reporter_email', 'reporter_organization',
    'reporter_address', 'copyrighted_work_description', 'original_work_url', 'infringing_series',
    'infringing_chapter', 'infringing_url_description', 'good_faith_statement',
    'accuracy_statement', 'signature', 'status', 'admin_notes', 'resolved_at', 'resolved_by',
    'created_at', 'updated_at'],
  content_reports: ['id', 'category', 'description', 'details', 'reported_series',
    'reported_chapter', 'reported_comment', 'reporter_email', 'reporter_account', 'status',
    'admin_notes', 'resolved_at', 'resolved_by', 'created_at', 'updated_at'],
  view_events: ['id', 'series', 'chapter', 'viewer', 'window_start', 'created_at'],
  refresh_tokens: ['id', 'user', 'token_hash', 'user_agent', 'ip', 'expires_at',
    'revoked_at', 'replaced_by', 'created_at'],
  auth_tokens: ['id', 'user', 'purpose', 'token_hash', 'expires_at', 'consumed_at', 'created_at'],
  rate_limit_buckets: ['bucket', 'hits', 'window_started_at'],
};

/**
 * Applies the simple equality / ANY predicates the models emit, so the double
 * behaves sensibly for filters. Anything more exotic is ignored rather than
 * mis-evaluated.
 *
 * Canned rows are raw database rows (snake_case), which is what the SQL
 * identifiers refer to — the model's camelCasing happens after this point.
 */
function applyPredicates(rows, sql, params) {
  const where = (sql.match(/ WHERE (.*?)(?: ORDER BY | LIMIT |$)/) || [])[1];
  if (!where) return rows;

  const eqs = [];
  where.replaceAll(/\(?"(\w+)"\)? = \$(\d+)/g, (_, col, n) => eqs.push([col, params[Number(n) - 1], 'eq']));
  where.replaceAll(/\(?"(\w+)"\)? = ANY \(\$(\d+)\)/g, (_, col, n) => eqs.push([col, params[Number(n) - 1], 'in']));
  where.replaceAll(/\(?"(\w+)"\)? <> \$(\d+)/g, (_, col, n) => eqs.push([col, params[Number(n) - 1], 'ne']));

  let out = rows;
  for (const [col, operand, op] of eqs) {
    out = out.filter((r) => {
      const actual = r[col];
      if (op === 'in') return Array.isArray(operand) && operand.map(String).includes(String(actual));
      const eq = String(actual) === String(operand);
      return op === 'ne' ? !eq : eq;
    });
  }
  return out;
}

function seedRow(table, values = {}) {
  const row = {};
  for (const col of COLUMNS[table]) {
    row[col] = col === 'id' ? `${table}-1` : col === 'created_at' || col === 'updated_at'
      ? new Date('2024-01-01T00:00:00Z') : null;
  }
  return Object.assign(row, values);
}

/**
 * @param {object} opts.rows       canned rows returned for SELECT (per table)
 * @param {object} opts.errors     map of regex -> Error to throw on match
 */
function createFakePool(opts = {}) {
  const log = [];
  let counter = 0;

  const pool = {
    log,
    rows: opts.rows || {},
    /** Statements whose text matches this regex, in order. */
    matching(re) { return log.filter((e) => re.test(e.text)); },
    reset() { log.length = 0; },
    async query(text, params = []) {
      const sql = text.replace(/\s+/g, ' ').trim();
      const entry = { sql, params, verb: sql.split(' ')[0].toUpperCase() };
      log.push(entry);

      for (const [pattern, err] of Object.entries(opts.errors || {})) {
        if (new RegExp(pattern, 'i').test(sql)) throw err;
      }

      // Column introspection
      if (/information_schema\.columns/i.test(sql)) {
        const table = params[0];
        return { rows: (COLUMNS[table] || []).map((column_name) => ({ column_name })), rowCount: 0 };
      }
      if (/COUNT\(\*\)::int AS count/i.test(sql)) {
        const table = (sql.match(/FROM "(\w+)"/) || [])[1];
        const matched = applyPredicates(pool.rows[table] || [], sql, params);
        const n = opts.countRows ? opts.countRows.length : matched.length;
        return { rows: [{ count: n }], rowCount: 1 };
      }
      if (entry.verb === 'SELECT') {
        const table = (sql.match(/FROM "(\w+)"/) || [])[1];
        const canned = pool.rows[table] || [];
        let filtered = applyPredicates(canned, sql, params);

        // LIMIT / OFFSET are bound parameters, so read them from params.
        const limitMatch = sql.match(/ LIMIT \$(\d+)/);
        if (limitMatch) filtered = filtered.slice(0, params[Number(limitMatch[1]) - 1]);
        const offsetMatch = sql.match(/ OFFSET \$(\d+)/);
        if (offsetMatch) filtered = filtered.slice(params[Number(offsetMatch[1]) - 1]);

        return { rows: filtered, rowCount: filtered.length };
      }
      if (entry.verb === 'INSERT') {
        const table = (sql.match(/INTO "(\w+)"/) || [])[1];
        counter += 1;
        return { rows: [seedRow(table, { id: `${table}-new-${counter}` })], rowCount: 1 };
      }
      if (entry.verb === 'UPDATE' || entry.verb === 'DELETE') {
        const table = (sql.match(/(?:UPDATE|DELETE FROM) "(\w+)"/) || [])[1];
        // UPDATE ... RETURNING * always yields a row in the real database.
        const returning = /RETURNING/.test(sql);
        // ...unless a test asks for the "no rows matched" shape, which is how
        // conditional atomic writes (e.g. consuming a one-shot token) are
        // exercised.
        const suppressed = opts.emptyReturning && new RegExp(opts.emptyReturning, 'i').test(sql);
        const row = seedRow(table, opts.echoRow || {});
        return {
          rows: suppressed ? [] : (returning ? [row] : (opts.deleteReturning ? [row] : [])),
          rowCount: suppressed ? 0 : (opts.affected === undefined ? 1 : opts.affected),
        };
      }
      return { rows: [], rowCount: 0 };
    },
    async connect() {
      const client = { query: pool.query, release() {} };
      return client;
    },
  };

  // Alias, because `log` reads like a logger and these are the captured
  // statements tests assert against.
  pool.statements = log;
  return pool;
}

/** Swaps in the double for the duration of `fn`, then restores the real pool. */
async function withPool(fake, fn) {
  const db = require('../../src/config/db');
  const Base = require('../../src/models/_base');
  Base._clearColumnCache();
  db.setPool(fake);
  try {
    return await fn(fake);
  } finally {
    db.setPool(null);
    Base._clearColumnCache();
  }
}

module.exports = { createFakePool, withPool, COLUMNS, seedRow };