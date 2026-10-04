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
 * OR is handled, because the models use it for the one lookup where it matters
 * most: login finds a user by `username = $1 OR email = $2`. Treating every
 * predicate as an AND made that match nothing - a row with the right username and
 * a different email was excluded. That failed loudly, which is lucky; the same
 * mistake in a filter that *should* match would have gone the other way and hidden
 * a real bug.
 *
 * Canned rows are raw database rows (snake_case), which is what the SQL
 * identifiers refer to — the model's camelCasing happens after this point.
 */

/** True if the first paren closes exactly at the last character. */
function isWrapped(expr) {
  if (!expr.startsWith('(') || !expr.endsWith(')')) return false;
  let depth = 0;
  for (let i = 0; i < expr.length; i += 1) {
    if (expr[i] === '(') depth += 1;
    else if (expr[i] === ')') {
      depth -= 1;
      if (depth === 0) return i === expr.length - 1;
    }
  }
  return false;
}

/**
 * Splits a WHERE clause on the ORs between its top-level terms.
 *
 * The wrapping parentheses come off first. The SQL compiler emits the whole
 * predicate inside one pair - `(("username" = $1) OR ("email" = $2))` - which
 * leaves the OR nested one level deep. Splitting on depth alone therefore finds
 * nothing, every term lands in one group, and the OR silently behaves as an AND.
 */
function splitOnOr(where) {
  let expr = where.trim();
  while (isWrapped(expr)) expr = expr.slice(1, -1).trim();

  const parts = [];
  let depth = 0;
  let current = '';
  for (let i = 0; i < expr.length; i += 1) {
    const ch = expr[i];
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    if (depth === 0 && expr.slice(i, i + 4).toUpperCase() === ' OR ') {
      parts.push(current);
      current = '';
      i += 3;
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts.filter((p) => p.trim());
}

/** The equality / ANY predicates the models emit, as [column, operand, op]. */
function applyPredicates(rows, sql, params) {
  const where = (sql.match(/ WHERE (.*?)(?: ORDER BY | LIMIT |$)/) || [])[1];
  if (!where) return rows;

  const groups = splitOnOr(where).map((fragment) => {
    const eqs = [];
    fragment.replaceAll(/\(?"(\w+)"\)? = \$(\d+)/g, (_, col, n) => eqs.push([col, params[Number(n) - 1], 'eq']));
    fragment.replaceAll(/\(?"(\w+)"\)? = ANY \(\$(\d+)\)/g, (_, col, n) => eqs.push([col, params[Number(n) - 1], 'in']));
    fragment.replaceAll(/\(?"(\w+)"\)? <> \$(\d+)/g, (_, col, n) => eqs.push([col, params[Number(n) - 1], 'ne']));
    return eqs;
  });

  const matches = (row, eqs) => eqs.every(([col, operand, op]) => {
    const actual = row[col];
    if (op === 'in') return Array.isArray(operand) && operand.map(String).includes(String(actual));
    const eq = String(actual) === String(operand);
    return op === 'ne' ? !eq : eq;
  });

  // One group is the common case and is a plain AND, as before.
  if (groups.length === 1) return rows.filter((row) => matches(row, groups[0]));
  // Several groups means a real OR at the top level.
  return rows.filter((row) => groups.some((eqs) => matches(row, eqs)));
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
        /*
         * The row an UPDATE returns has to be the row that was there. Handing back
         * a blank seedRow instead meant save() wrote its changes and then re-read
         * an all-null document over the top, so every field came back null
         * afterwards - a double that quietly destroyed the record it had just been
         * asked to update, which is how a passing login test was returning a user
         * with no username.
         *
         * Preferring the canned row keeps a save round-tripping faithfully, which
         * is what the real statement does. echoRow still wins where a test wants a
         * specific shape, chiefly the atomic one-shot updates that return a row the
         * canned data does not describe.
         */
        const echo = opts.echoRow
          ? seedRow(table, opts.echoRow)
          : ((pool.rows[table] && pool.rows[table][0]) || seedRow(table));
        return {
          rows: suppressed ? [] : (returning ? [echo] : (opts.deleteReturning ? [echo] : [])),
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