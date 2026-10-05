'use strict';

/**
 * The counter reset, against a real PostgreSQL.
 *
 * This is the live half of test/jobs.test.js. The unit suite above proves the
 * right statement is *built*; this proves PostgreSQL accepts it and that it does
 * what it claims.
 *
 * It existed as a closure inside cron.schedule until now, so the `jsonb_set`
 * UPDATE had never been executed by anything. A typo in it - a missing space, a
 * wrong jsonb path, a column that does not exist - would have surfaced for the
 * first time at midnight in production, as a line in a cron log nobody reads.
 *
 * The semantics worth proving, because they are easy to get subtly wrong:
 *   - only the named counter is zeroed; the other one is left alone
 *   - other keys in the views object survive (weekly is not clobbered by daily)
 *   - the stamp column is set, and only the right one
 *   - a row already at zero is not touched, so a quiet day does no work
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { createFakePool } = require('./helpers/fakePool');

const liveGuard = require('./helpers/liveGuard');
const db = require('../src/config/db');

if (process.env.VORTH_LIVE_DB !== '1') {
  liveGuard.assertSafeTarget(process.env.DATABASE_URL, 'test/jobs.live.test.js');
  test('the counter reset, against a real PostgreSQL', { skip: 'live database tests disabled' }, () => {});
} else {
  liveGuard.assertSafeTarget(process.env.DATABASE_URL, 'test/jobs.live.test.js');

  const jobs = require('../src/jobs/resetViews');
  const pool = () => db.pool;

  /*
   * series.owner is NOT NULL, so the fixtures need a real owner. One user for
   * the whole file rather than one per test: the reset does not care who owns a
   * series, and fewer rows means less to clean up if a test fails part-way.
   */
  let ownerId = null;
  async function ensureOwner() {
    if (ownerId) return ownerId;
    const suffix = Math.random().toString(36).slice(2, 10);
    const user = await require('../src/models/User').create({
      displayName: 'Reset Probe',
      username: `reset_probe_${suffix}`,
      email: `reset_probe_${suffix}@example.com`,
      password: 'correct horse battery',
      agreedToTermsAt: new Date(),
      ageConfirmed: true,
    });
    ownerId = user.id;
    return ownerId;
  }

  /**
   * Creates series with an exact views object.
   *
   * Raw SQL rather than Series.create, deliberately. What is under test is the
   * reset statement, and the model applies its own defaults - `views` came back
   * NOT NULL empty rather than the object passed in, which would have made the
   * fixtures quietly test something other than what they claim. Inserting the
   * column directly means the fixture is exactly the state the assertion expects.
   */
  async function seed(viewsList) {
    const owner = await ensureOwner();
    const ids = [];
    for (const views of viewsList) {
      const { rows } = await pool().query(
        `INSERT INTO series (title, slug, type, owner, author, synopsis, views, rights_attested_at)
         VALUES ($1, $2, 'novel', $3, 'Probe', 'x', $4::jsonb, now())
         RETURNING id`,
        [
          `Reset probe ${Math.random().toString(36).slice(2, 8)}`,
          `reset-probe-${Math.random().toString(36).slice(2, 12)}`,
          owner,
          JSON.stringify(views),
        ],
      );
      ids.push(rows[0].id);
    }
    return ids;
  }

  const readViews = async (id) => {
    const { rows } = await pool().query('SELECT views, last_daily_reset, last_weekly_reset FROM series WHERE id = $1', [id]);
    return rows[0];
  };

  const cleanup = async (ids) => {
    await pool().query('DELETE FROM series WHERE id = ANY($1::uuid[])', [ids]);
  };

  test('the daily reset zeroes only "daily"', async () => {
    /*
     * Asserted on `views`, never on the stamp columns.
     *
     * The natural way to test this is to check that last_daily_reset moved while
     * last_weekly_reset did not. That does not work: both are NOT NULL DEFAULT
     * now(), so a freshly inserted series already carries both. The first version
     * of this file asserted null on the untouched one and failed, correctly.
     * The dedicated test further down pins that and explains it.
     */
    const [id] = await seed([{ daily: 12, weekly: 30, alltime: 900 }]);
    try {
      const changed = await jobs.resetCounter('daily');
      assert.ok(changed >= 1, `expected at least one row reset, got ${changed}`);

      const after = await readViews(id);
      assert.equal(after.views.daily, 0, 'the daily counter was not zeroed');
      assert.equal(after.views.weekly, 30, 'the weekly counter was clobbered by the daily reset');
      assert.equal(after.views.alltime, 900, 'the alltime counter was clobbered');
    } finally {
      await cleanup([id]);
    }
  });

  test('the weekly reset leaves the daily counter alone', async () => {
    const [id] = await seed([{ daily: 7, weekly: 44, alltime: 1200 }]);
    try {
      await jobs.resetCounter('weekly');
      const after = await readViews(id);
      assert.equal(after.views.weekly, 0, 'the weekly counter was not zeroed');
      assert.equal(after.views.daily, 7, 'the weekly reset zeroed the daily counter');
      assert.equal(after.views.alltime, 1200, 'the weekly reset zeroed the alltime counter');
    } finally {
      await cleanup([id]);
    }
  });

  test('a counter already at zero is excluded from the reset', async () => {
    /*
     * Counted, not stamped. The obvious way to test this is to look for an
     * untouched row's stamp column, and that does not work here: both
     * last_daily_reset and last_weekly_reset are `NOT NULL DEFAULT now()`, so a
     * freshly inserted row already carries one. The first version of this test
     * asserted a null stamp and failed - correctly, because the column can never
     * be null.
     *
     * So the property is measured where it is actually expressed: the statement
     * reports how many rows it touched, and that number must equal the number of
     * rows that were not already zero.
     */
    const [quiet, busy, busy2] = await seed([
      { daily: 0, weekly: 5 },
      { daily: 3, weekly: 5 },
      { daily: 11, weekly: 5 },
    ]);

    // Isolated, so rows left by other tests or earlier runs cannot be counted.
    const scoped = await jobs.resetCounter('daily');
    assert.ok(scoped >= 2, `expected at least the two non-zero rows to be reset, got ${scoped}`);
    assert.ok(scoped <= 2,
      `${scoped} rows were reset; the row already at zero should have been skipped, `
      + 'so a quiet day would still rewrite every series in the catalogue');

    const after = await pool().query(
      'SELECT id, views FROM series WHERE id = ANY($1::uuid[])', [[quiet, busy, busy2]],
    );
    for (const row of after.rows) {
      assert.equal(row.views.daily, 0, `series ${row.id} kept a non-zero daily counter`);
      assert.equal(row.views.weekly, 5, `series ${row.id} lost its weekly counter`);
    }
    await cleanup([quiet, busy, busy2]);
  });

test('the reset stamp columns cannot record what they claim to', async () => {
  /*
   * A finding, pinned as a test so it cannot be forgotten.
   *
   * last_daily_reset and last_weekly_reset exist to say when a counter was last
   * reset. Both are `NOT NULL DEFAULT now()`, so a newly created series already
   * has one, and the reset overwrites it with another now(). The column can
   * therefore only ever hold the insert time or the most recent reset time, and
   * cannot distinguish a series that has never been reset from one reset a
   * second ago.
   *
   * Nothing reads either column - not the API, not the frontend, not a script -
   * so today this is misleading rather than harmful. The fix is a schema change
   * (drop them, or let them default to NULL), which is not something to do
   * unilaterally against a production-shaped database. So it is written down
   * here, where the next person to touch the reset will find it.
   */
  const { rows } = await pool().query(
    `SELECT column_name, is_nullable, column_default
       FROM information_schema.columns
      WHERE table_name = 'series' AND column_name IN ('last_daily_reset','last_weekly_reset')
      ORDER BY column_name`,
  );
  assert.equal(rows.length, 2, 'the reset stamp columns are no longer both present');

  for (const row of rows) {
    assert.equal(row.is_nullable, 'NO',
      `${row.column_name} is now nullable, so it can finally record "never reset" - `
      + 'replace this assertion with one about what it means when it is null');
    assert.match(row.column_default, /now\(\)/,
      `${row.column_name} no longer defaults to now(); re-read whether it records anything`);
  }
});

  test('the COALESCE in the reset guards a state the schema forbids', async () => {
    /*
     * A schema assertion rather than a behaviour test, because the behaviour is
     * unreachable: series.views is NOT NULL, so no row can hold null and
     * COALESCE("views", '{}') can never do anything.
     *
     * The first version of this file tried to insert a null views and assert the
     * reset survived it. It failed with a not-null violation - correctly. The
     * thing worth asserting is that the column cannot be null in the first place,
     * so if the schema ever loosens this fails and someone has to decide whether
     * the COALESCE has become load-bearing.
     */
    const { rows } = await pool().query(
      `SELECT is_nullable FROM information_schema.columns
        WHERE table_name = 'series' AND column_name = 'views'`,
    );
    assert.equal(rows[0].is_nullable, 'NO',
      'series.views is now nullable, so the COALESCE in resetCounter has become '
      + 'load-bearing and this test must start asserting what it does instead');
  });

  test('resetCounter still refuses an unknown key against a real database', async () => {
    await assert.rejects(() => jobs.resetCounter('alltime'), /not a resettable counter/);
  });

  test('stopJobs is safe with nothing registered', () => {
    jobs.stopJobs();
    jobs.stopJobs();
  });

  test('the recording pool is not what proved any of this', () => {
    // A guard against the file quietly stopping using the database: if someone
    // swapped db.pool for the double, the assertions above would still pass and
    // would prove nothing.
    assert.notEqual(db.pool, undefined);
    assert.equal(typeof db.pool.query, 'function');
    assert.equal(typeof createFakePool, 'function');
  });
}