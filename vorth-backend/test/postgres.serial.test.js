'use strict';

/**
 * The schema bootstrap, against a real database.
 *
 * These two tests used to sit at the top of `postgres.live.test.js` and run
 * beside every other live file. Both of them boot the application for real,
 * with VORTH_SKIP_SCHEMA deliberately cleared, because testing the bootstrap
 * under that flag would assert nothing at all: connectDB() returns before
 * issuing any DDL.
 *
 * That put CREATE TABLE / CREATE INDEX into the parallel pass, and every
 * CREATE INDEX takes a ShareLock on its table even when it creates nothing,
 * which conflicts with the RowExclusiveLock any writer holds. It deadlocked for
 * real, against `nullFilter.live.test.js` in the middle of an ordinary INSERT:
 *
 *   Process 1812 waits for RowShareLock on relation 16445; blocked by 1811
 *   Process 1811 waits for ShareLock on relation 16568; blocked by 1812
 *
 * So they live in a `*.serial.test.js` file, which test/run.js runs in a second
 * pass once the parallel files have finished, one file at a time. The tests are
 * unchanged - only when they run.
 */

process.env.JWT_SECRET ||= 'test-secret';
process.env.DATABASE_SSL = 'false';

// Load .env exactly the way the app does, so the guard inspects the same
// connection string the application would use. Without this the guard would
// silently see nothing and skip, which is safe but hides the real risk.
require('dotenv').config();

const test = require('node:test');
const assert = require('node:assert/strict');

const { assertSafeTarget } = require('./helpers/liveGuard');

// This file issues DDL. Never let it run against whatever DATABASE_URL happens
// to be in the environment - that is very often a real remote database loaded
// from .env. The guard is evaluated BEFORE the pool is created, so a skipped run
// never even opens a connection.
const guard = assertSafeTarget(process.env.DATABASE_URL);
const SKIP_REASON = guard.ok ? false : `live database tests disabled — ${guard.reason}`;

if (!guard.ok) {
  // Written to stderr, not stdout: node's test runner multiplexes its IPC
  // stream over the child's stdout, so writing there corrupts the run.
  process.stderr.write(`\n[live tests skipped] ${guard.reason}\n\n`);
}

/** Lazily loaded so requiring this file never opens a database connection. */
let db = null;
function database() {
  if (!db) db = require('../src/config/db');
  return db;
}

let reachable = false;
async function canConnect() {
  if (!guard.ok) return false;
  if (reachable) return true;
  try { await database().pool.query('SELECT 1'); reachable = true; } catch (_) { reachable = false; }
  return reachable;
}

test('schema bootstrap is valid and idempotent', async (t) => {
  if (!guard.ok) return t.skip(SKIP_REASON);
  if (!await canConnect()) return t.skip({ skip: 'no reachable PostgreSQL' });

  /*
   * The flag is cleared for this test on purpose.
   *
   * test/run.js sets VORTH_SKIP_SCHEMA so the parallel live files stop racing
   * each other over the DDL, which is right for them and wrong here: this test
   * exists to check the bootstrap, and under the flag connectDB() returns before
   * issuing any DDL. Left alone it would pass while proving nothing - a false
   * pass in the one test whose whole job is to catch a broken schema.
   *
   * The assertion below is the guard on that: if the flag ever stops being
   * clearable, this test fails instead of quietly checking the wrong code path.
   */
  const flag = process.env.VORTH_SKIP_SCHEMA;
  delete process.env.VORTH_SKIP_SCHEMA;
  t.after(() => {
    if (flag !== undefined) process.env.VORTH_SKIP_SCHEMA = flag;
  });

  assert.notEqual(
    process.env.VORTH_SKIP_SCHEMA, '1',
    'VORTH_SKIP_SCHEMA is still set, so connectDB() would skip the DDL and this '
    + 'test would assert nothing about the bootstrap'
  );

  await database().connectDB();
  await database().connectDB(); // second run must be a no-op

  // And the flag has to work, or run.js's fix is a comment.
  process.env.VORTH_SKIP_SCHEMA = '1';
  const before = await database().pool.query(
    `SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = current_schema()`
  );
  await database().connectDB();
  const after = await database().pool.query(
    `SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = current_schema()`
  );
  assert.equal(after.rows[0].n, before.rows[0].n, 'VORTH_SKIP_SCHEMA still created something');

  const { rows } = await database().pool.query(
    `SELECT count(*)::int AS n FROM pg_tables
      WHERE schemaname = current_schema()
        AND tablename IN ('users','series','chapters','comments','notifications',
                          'reading_progress','dmca_reports','view_events')`
  );
  assert.equal(rows[0].n, 8, 'every model table must exist');
  const idx = await database().pool.query(
    `SELECT count(*)::int AS n FROM pg_indexes WHERE schemaname = current_schema()`
  );
  assert.ok(idx.rows[0].n >= 15, `expected the documented indexes, found ${idx.rows[0].n}`);
});

test('a schema-prepared connection really does no DDL', async (t) => {
  if (!guard.ok) return t.skip(SKIP_REASON);
  if (!await canConnect()) return t.skip({ skip: 'no reachable PostgreSQL' });

  /*
   * The live suite depends on this flag: run.js sets it so N test files do not
   * each run CREATE INDEX against one database, which deadlocks them against each
   * other. If the flag stopped working, the suite would go back to deadlocking -
   * so it is worth a test that would notice immediately rather than a flake.
   */
  await database().connectDB();

  const marker = `vorth_skip_probe_${Date.now().toString(36)}`;
  await database().pool.query(
    `CREATE TABLE IF NOT EXISTS ${marker} (id int PRIMARY KEY)`
  );
  const flag = process.env.VORTH_SKIP_SCHEMA;
  process.env.VORTH_SKIP_SCHEMA = '1';
  try {
    await database().connectDB();
    await database().pool.query(
      `CREATE TABLE IF NOT EXISTS ${marker}_second (id int PRIMARY KEY)`
    );
  } finally {
    await database().pool.query(`DROP TABLE IF EXISTS ${marker}_second`);
    await database().pool.query(`DROP TABLE IF EXISTS ${marker}`);
    if (flag === undefined) delete process.env.VORTH_SKIP_SCHEMA;
    else process.env.VORTH_SKIP_SCHEMA = flag;
  }

  const { rows } = await database().pool.query(
    `SELECT count(*)::int AS n FROM pg_tables
      WHERE schemaname = current_schema() AND tablename LIKE '${marker}%'`
  );
  assert.equal(rows[0].n, 0, `probe tables were left behind: ${marker}`);
});
