'use strict';

/**
 * Column upgrades are conditional, so boot takes no exclusive lock in the
 * steady state.
 *
 * PostgreSQL takes an ACCESS EXCLUSIVE lock for ALTER TABLE even when the
 * statement does nothing. So `ADD COLUMN IF NOT EXISTS` against a column that
 * already exists still locks the table against every reader and writer, and two
 * instances booting at the same time - a rolling deploy, a scale-out, or two
 * test files in one run - deadlock against each other on exactly that.
 *
 * This did happen: the live suite deadlocked with
 * "Process 385 waits for RowShareLock ... blocked by Process 384", 384 waiting
 * for AccessExclusiveLock, which is the signature of an ALTER issued by one
 * process against a table another was reading.
 *
 * The fix reads the catalog first and issues only what is missing. These tests
 * pin the resulting property, because the failure mode it prevents is invisible
 * until two things run at once.
 */

process.env.DATABASE_URL ||= 'postgres://stub/stub';
process.env.DATABASE_SSL = 'false';
process.env.JWT_SECRET ||= 'test-secret';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { createFakePool } = require('./helpers/fakePool');
const { _applyColumnUpgrades, _columnUpgrades } = require('../src/config/db');

/**
 * A pool whose information_schema answers come from `lookup`, and which still
 * records what was issued.
 *
 * The original query is wrapped rather than replaced: replacing it loses the log,
 * and the whole point of these tests is what was and was not sent to the database.
 */
function poolAnswering(lookup) {
  const pool = createFakePool({ rows: {} });
  const original = pool.query.bind(pool);
  pool.query = async (text, params = []) => {
    if (/information_schema\.columns/.test(String(text))) {
      // Recorded by hand, since the double's own query is bypassed here. The log
      // is what these tests read to decide what reached the database.
      pool.log.push({
        sql: String(text).replace(/\s+/g, ' ').trim(),
        params,
        verb: 'SELECT',
      });
      return lookup(params) || { rows: [], rowCount: 0 };
    }
    return original(text, params);
  };
  return pool;
}

/** Every column the upgrade list claims, as the catalog would report it. */
function catalogWithAllPresent() {
  return poolAnswering(() => ({ rows: [{ is_nullable: 'YES' }], rowCount: 1 }));
}

const alters = (pool) => pool.log.filter((e) => /^\s*ALTER/i.test(e.sql));

test('an up-to-date schema issues no ALTER at all', async () => {
  const pool = catalogWithAllPresent();
  const result = await _applyColumnUpgrades(pool);

  assert.equal(result.skipped, true, 'the upgrade step ran on an up-to-date schema');
  assert.deepEqual(result.applied, []);
  assert.deepEqual(
    alters(pool), [],
    'boot issued an ALTER against an up-to-date schema'
  );
});

test('only catalog reads happen on the fast path', async () => {
  const pool = catalogWithAllPresent();
  await _applyColumnUpgrades(pool);

  // One SELECT per column, plus one per nullability relaxation. No locks at all.
  assert.equal(pool.log.length, _columnUpgrades.length + 1);
  assert.ok(
    pool.log.every((e) => /information_schema\.columns/.test(e.sql)),
    'the fast path issued something other than a catalog read'
  );
});

test('a missing column is added', async () => {
  // users.email_verified_at is present; everything else below is missing, which
  // is what a database created before those columns existed looks like.
  const present = new Set(['users.email_verified_at']);
  const pool = poolAnswering((params) => (
    present.has(`${params[0]}.${params[1]}`)
      ? { rows: [{ is_nullable: 'YES' }], rowCount: 1 }
      : { rows: [], rowCount: 0 }
  ));

  const result = await _applyColumnUpgrades(pool);
  assert.equal(result.skipped, false);

  const missing = _columnUpgrades.filter(([t, c]) => !present.has(`${t}.${c}`));
  assert.equal(result.applied.length, missing.length, JSON.stringify(result.applied));
  assert.ok(result.applied.includes('+ chapters.takedown_reason'), JSON.stringify(result.applied));

  const issued = alters(pool);
  assert.equal(issued.length, missing.length, `expected ${missing.length} ALTERs, got ${issued.length}`);
  assert.ok(
    issued.some((a) => /ALTER TABLE "chapters" ADD COLUMN "takedown_reason" text/.test(a.sql)),
    `the chapters ALTER was not issued:\n  ${issued.map((a) => a.sql).join('\n  ')}`
  );
  // And nothing that was already present is touched.
  assert.ok(
    !issued.some((a) => /"users"/.test(a.sql)),
    'an ALTER was issued for a column that already exists'
  );
});

test('a NOT NULL column is relaxed only when it is still NOT NULL', async () => {
  let nullable = 'NO';
  const pool = poolAnswering((params) => ({
    rows: [{ is_nullable: params[0] === 'dmca_counter_notices' ? nullable : 'YES' }],
    rowCount: 1,
  }));

  const first = await _applyColumnUpgrades(pool);
  assert.equal(first.skipped, false);
  assert.ok(
    first.applied.some((a) => /dmca_counter_notices\.response_deadline is now nullable/.test(a)),
    JSON.stringify(first.applied)
  );

  // Second pass, as if the column had already been relaxed: no further ALTER.
  nullable = 'YES';
  pool.log.length = 0;
  const second = await _applyColumnUpgrades(pool);
  assert.equal(second.skipped, true);
  assert.deepEqual(alters(pool), []);
});

test('the upgrade step runs after the schema, never before it', async () => {
  /*
   * Order is load-bearing. An ALTER against a table that does not exist yet
   * fails, so on a brand new database the upgrade step has to follow the CREATE
   * statements. Running it first would break the first boot of every fresh
   * deployment - and the failure would look like a schema bug, not an ordering one.
   */
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'config', 'db.js'),
    'utf8'
  );
  const createIndex = source.indexOf('CREATE TABLE IF NOT EXISTS users');
  const upgradeCall = source.indexOf('await applyColumnUpgrades(pool)');
  assert.ok(createIndex > -1, 'the schema statement was not found');
  assert.ok(upgradeCall > -1, 'applyColumnUpgrades is not called from connectDB');
  assert.ok(
    upgradeCall > createIndex,
    'applyColumnUpgrades runs before the schema is created, so the first boot on a '
    + 'fresh database would ALTER a table that does not exist yet'
  );
});

test('every upgraded column is also in its CREATE TABLE, for a fresh database', () => {
  /*
   * Belt and braces, deliberately. The conditional upgrade handles a table that
   * already exists; the CREATE definition handles one that does not. Relying on
   * either alone leaves a gap: the upgrade alone breaks the first boot, the
   * CREATE alone never reaches an existing database.
   */
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'config', 'db.js'),
    'utf8'
  );
  const creates = [...source.matchAll(/CREATE TABLE IF NOT EXISTS (\w+) \(([\s\S]*?)\n {4}\);/g)]
    .reduce((acc, m) => Object.assign(acc, { [m[1]]: m[2] }), {});

  for (const [table, column] of _columnUpgrades) {
    const body = creates[table];
    assert.ok(body, `no CREATE TABLE found for ${table}`);
    assert.ok(
      new RegExp(`\\b${column}\\b`).test(body),
      `${table}.${column} is only added by the conditional upgrade, so a fresh `
      + 'database depends on an ALTER running immediately after CREATE'
    );
  }
});

test('identifiers in the upgrade list are validated, not trusted', async () => {
  // The tampered column has to be reported missing, or the upgrade step never
  // reaches the identifier check - the guard only runs on the path that issues
  // an ALTER.
  const pool = poolAnswering((params) => (
    params[0] === 'users'
      ? { rows: [], rowCount: 0 }
      : { rows: [{ is_nullable: 'YES' }], rowCount: 1 }
  ));

  // A malformed entry must be refused rather than interpolated. The constants are
  // hardcoded, so this guards a future edit, not user input.
  const bad = _columnUpgrades;
  const original = bad[0][1];
  bad[0][1] = 'email_verified_at; DROP TABLE users; --';
  try {
    await assert.rejects(() => _applyColumnUpgrades(pool), /Unsafe SQL identifier/);
    assert.deepEqual(
      alters(pool), [],
      'a rejected identifier still reached the database'
    );
  } finally {
    bad[0][1] = original;
  }
});
