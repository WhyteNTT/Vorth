'use strict';

/**
 * The column-upgrade path, against a real database.
 *
 * Destructive on purpose: it drops the columns connectDB() is responsible for
 * adding, then boots again and checks they came back. There is no way to test
 * "boot repairs a schema that is missing a column" without actually removing one.
 *
 * That makes it unsafe to run beside tests that are writing rows - a dropped
 * column turns another file's INSERT into "relation has no column", which reads
 * as a cascade of unrelated product failures. So it lives in a `*.serial.test.js`
 * file, and test/run.js runs those in a second pass once the parallel ones have
 * finished. Nothing else in the suite may drop a column it does not restore.
 */

process.env.DATABASE_URL ||= 'postgresql://vorth:vorth@127.0.0.1:5432/vorth_test';
process.env.DATABASE_SSL = 'false';
process.env.JWT_SECRET ||= 'live-secret';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const { after } = require('node:test');
const assert = require('node:assert');

const { pool, connectDB, _columnUpgrades } = require('../src/config/db');
const { assertSafeTarget } = require('./helpers/liveGuard');

const guard = assertSafeTarget(process.env.DATABASE_URL, process.env);
const SKIP_REASON = guard.ok ? false : `live database tests disabled — ${guard.reason}`;

/*
 * The pool is a module singleton. Ending it in one test left the next one holding
 * a closed pool, which fails with "Called end on pool more than once" and reads
 * like a product bug.
 */
let connected = false;
async function db() {
  if (!connected) {
    await connectDB();
    connected = true;
  }
}

after(async () => {
  if (connected) await pool.end();
});

/** Whether a column exists, so absence is asserted rather than assumed. */
async function hasColumn(table, column) {
  const { rows } = await pool.query(
    `SELECT 1 FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = $1 AND column_name = $2`,
    [table, column]
  );
  return rows.length === 1;
}

/** connectDB() must actually run the DDL for any of this to mean anything. */
function withoutSkip() {
  const flag = process.env.VORTH_SKIP_SCHEMA;
  delete process.env.VORTH_SKIP_SCHEMA;
  return () => {
    if (flag === undefined) delete process.env.VORTH_SKIP_SCHEMA;
    else process.env.VORTH_SKIP_SCHEMA = flag;
  };
}

test('boot adds every column it is responsible for, to a database missing them', { skip: !process.env.VORTH_LIVE_DB }, async (t) => {
  if (!guard.ok) return t.skip(SKIP_REASON);
  t.after(withoutSkip());
  await db();

  const dropped = [];
  try {
    // Sequential: each DROP takes an exclusive lock on its own table.
    for (const [table, column] of _columnUpgrades) {
      await pool.query(`ALTER TABLE "${table}" DROP COLUMN IF EXISTS "${column}" CASCADE`);
      dropped.push([table, column]);
    }
    assert.ok(dropped.length >= 5, `expected several columns, got ${dropped.length}`);

    // Gone, as intended. Asserted so the test cannot pass by dropping nothing.
    for (const [table, column] of dropped) {
      assert.equal(
        await hasColumn(table, column), false,
        `${table}.${column} was not actually dropped, so this proves nothing`
      );
    }

    // Boot again, the way a redeploy would. connected is already true, so call
    // connectDB directly rather than db().
    await connectDB();

    for (const [table, column] of dropped) {
      assert.equal(
        await hasColumn(table, column), true,
        `${table}.${column} is listed as an upgrade but boot did not add it back`
      );
    }
  } finally {
    for (const [table, column] of dropped) {
      await pool.query(`ALTER TABLE "${table}" DROP COLUMN IF EXISTS "${column}" CASCADE`)
        .catch(() => {});
    }
    // Leave the database as we found it, and prove it rather than assume it.
    await connectDB();
    for (const [table, column] of dropped) {
      assert.equal(
        await hasColumn(table, column), true,
        `the database was not left in its original shape (${table}.${column})`
      );
    }
  }
});

test('an already-current schema issues no ALTER, so boot takes no exclusive lock', { skip: !process.env.VORTH_LIVE_DB }, async (t) => {
  if (!guard.ok) return t.skip(SKIP_REASON);
  t.after(withoutSkip());
  await db();

  /*
   * The property that stops two instances booting at once from deadlocking: an
   * up-to-date database gets no ALTER, so no ACCESS EXCLUSIVE lock.
   *
   * The sharp version of this assertion is in columnUpgrade.test.js, which
   * inspects the statements issued against a recording double. This one asks the
   * real server, because the claim is about what PostgreSQL does with the
   * statement - and it catches a regression where the fast path stops being taken
   * at all, which a double would happily keep recording.
   */
  const statements = [];
  const original = pool.query.bind(pool);
  pool.query = async (text, params) => {
    const sql = String(text);
    if (/^\s*ALTER\b/i.test(sql)) statements.push(sql.slice(0, 120));
    return original(text, params);
  };
  try {
    await connectDB();
  } finally {
    pool.query = original;
  }

  assert.deepEqual(
    statements, [],
    'boot issued ALTER against an already-current schema, which takes an '
    + 'ACCESS EXCLUSIVE lock and can deadlock a second instance booting alongside it'
  );
});

test('VORTH_SKIP_SCHEMA really does skip the schema', { skip: !process.env.VORTH_LIVE_DB }, async (t) => {
  if (!guard.ok) return t.skip(SKIP_REASON);
  await db();

  /*
   * The live suite and test/run.js both depend on this flag: if it stopped
   * working, every parallel live file would bootstrap the schema again and the
   * suite would go back to deadlocking. Worth a test that notices immediately
   * rather than a flake.
   *
   * Measured by dropping an index the schema string owns, booting with the flag
   * set, and checking the index is *still* missing. Dropping a table and finding
   * it gone proves nothing - the test would have cleaned that up itself.
   */
  const INDEX = 'idx_dmca_status';
  await pool.query(`DROP INDEX IF EXISTS "${INDEX}"`);

  process.env.VORTH_SKIP_SCHEMA = '1';
  try {
    await connectDB();
    const { rows } = await pool.query(
      `SELECT to_regclass($1) IS NULL AS missing`, [INDEX]
    );
    assert.equal(
      rows[0].missing, true,
      'the index came back, so VORTH_SKIP_SCHEMA did not skip the schema'
    );
  } finally {
    delete process.env.VORTH_SKIP_SCHEMA;
    // Put it back the way a normal boot would, then confirm.
    await connectDB();
    const { rows } = await pool.query(
      `SELECT to_regclass($1) IS NULL AS missing`, [INDEX]
    );
    assert.equal(
      rows[0].missing, false,
      'a normal boot did not recreate the index, so the schema string is incomplete'
    );
  }
});
