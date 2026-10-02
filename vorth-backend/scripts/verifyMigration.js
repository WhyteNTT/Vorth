'use strict';

/**
 * Upgrades a database created by the PREVIOUS schema to the current one.
 *
 * This is the migration path the deployed Neon database will actually take:
 * it already has the old tables, so `connectDB()` must add what is new without
 * dropping or rewriting anything that exists.
 *
 * Run against a throwaway database only. See test/helpers/liveGuard.js.
 */
const { pool, connectDB } = require('../src/config/db');

const REQUIRED_TABLES = [
  'users', 'series', 'chapters', 'comments', 'notifications',
  'reading_progress', 'dmca_reports',
  'view_events', 'refresh_tokens', 'auth_tokens', 'rate_limit_buckets',
];

async function main() {
  await connectDB();

  const tables = await pool.query(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'`
  );
  const present = new Set(tables.rows.map((r) => r.table_name));

  const missing = REQUIRED_TABLES.filter((name) => !present.has(name));
  const cols = await pool.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'users'`
  );
  const userCols = new Set(cols.rows.map((r) => r.column_name));
  const indexes = await pool.query(
    `SELECT indexname FROM pg_indexes WHERE schemaname = current_schema()`
  );

  const checks = [
    ['all 11 tables exist', missing.length === 0, missing.length ? `missing: ${missing.join(', ')}` : `${present.size} tables`],
    ['users.email_verified_at added', userCols.has('email_verified_at'), userCols.has('email_verified_at') ? 'present' : 'MISSING'],
    ['indexes created', indexes.rowCount >= 20, `${indexes.rowCount} indexes`],
    ['pre-existing rows preserved',
      Number((await pool.query('SELECT count(*)::int AS n FROM users')).rows[0].n) === 1,
      `${(await pool.query('SELECT count(*)::int AS n FROM users')).rows[0].n} legacy user row(s) still present`],
    ['legacy columns untouched',
      ['id', 'username', 'email', 'password', 'library', 'downloads', 'created_at', 'updated_at']
        .every((c) => userCols.has(c)),
      'original users columns all intact'],
  ];

  console.log('\n  MIGRATION CHECK (old schema -> current)');
  console.log('  ' + '-'.repeat(58));
  let failed = 0;
  for (const [name, ok, detail] of checks) {
    if (!ok) failed += 1;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(34)} ${detail}`);
  }
  console.log('  ' + '-'.repeat(58));
  console.log(`  ${checks.length - failed}/${checks.length} passed\n`);

  await pool.end();
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });