'use strict';

/**
 * Keep-warm heartbeat.
 *
 * The question this exists to answer is "is the scheduled ping still arriving?",
 * and the interesting part is that it has two failure modes rather than one:
 *
 *   - the job stops and stays stopped. Caught by comparing now against the last
 *     recorded ping.
 *   - the job stops, someone notices days later, pokes the endpoint by hand, and
 *     that poke is indistinguishable from a healthy job. Caught only by keeping the
 *     largest gap ever seen, which no amount of hand-poking can reset.
 *
 * The second is why the tests below spend so much time on a counter that only ever
 * increases. It is the one piece of evidence that survives an investigation.
 *
 * Run against a real PostgreSQL, because the gap arithmetic happens in SQL
 * (GREATEST, EXTRACT, ON CONFLICT) and a fake pool would let every one of those be
 * wrong.
 */

process.env.DATABASE_URL ||= 'postgres://stub/stub';
process.env.DATABASE_SSL = 'false';
process.env.JWT_SECRET ||= 'test-secret';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');

const liveGuard = require('./helpers/liveGuard');

/** Guards first: a mistyped DATABASE_URL must fail loudly, not silently skip. */
liveGuard.assertSafeTarget(process.env.DATABASE_URL, 'test/heartbeat.live.test.js');

const db = require('../src/config/db');
const heartbeat = require('../src/services/heartbeat');

/*
 * Pure assertions run either way, so the constants they pin are still checked on a
 * machine with no database.
 */
test('the tolerance is twice the 5-minute schedule', () => {
  /*
   * The whole point of the number. One late run is scheduler jitter; two in a row
   * means the job stopped. And 10 minutes is still under the 15-minute spin-down,
   * so the alarm fires while there is still time to act.
   */
  assert.equal(heartbeat.TOLERANCE_SECONDS, 600);
  assert.ok(heartbeat.TOLERANCE_SECONDS < 900, 'must fire before the instance sleeps');
  assert.ok(heartbeat.TOLERANCE_SECONDS >= 600, 'must tolerate a single missed slot');
});

test('the service key is constant', () => {
  // A configurable key would let a misconfiguration write rows nobody reads.
  assert.equal(heartbeat.SERVICE, 'vorth-api');
});

if (process.env.VORTH_LIVE_DB !== '1') {
  test('the keep-warm heartbeat, against a real PostgreSQL', { skip: 'live database tests disabled' }, () => {});
} else {
  /*
   * The schema is applied here rather than assumed. This file talks to a table
   * that only exists once connectDB() has run the DDL, and pointing it at an
   * unprepared database produces eight identical "relation does not exist"
   * failures that read as broken assertions rather than a missing setup step.
   */
  const { connectDB } = require('../src/config/db');
  /*
   * A `before` hook rather than a bare call: node:test starts the first test on
   * the next tick, so a floating connectDB() promise loses the race and every
   * assertion fails with "relation does not exist" - eight identical errors that
   * look like broken tests rather than a missing schema.
   */
  test.before(async () => {
    try {
      await connectDB();
    } catch (err) {
      // Thrown, not logged: a run that cannot reach its schema has proved nothing,
      // so it must not look like a pass.
      throw new Error(`schema could not be applied: ${err.message}`);
    }
  });

  test('a heartbeat is never reported before one has been recorded', async () => {
      await db.pool.query('DELETE FROM service_heartbeat WHERE service = $1', [heartbeat.SERVICE]);
      assert.equal(await heartbeat.ageSeconds(), null,
        'no ping yet must read as null, not 0 - "never" and "just now" are different');
      const result = await heartbeat.check();
      assert.equal(result.ok, false);
      assert.match(result.verdict, /no ping has ever/i);
    });

  test('recording a ping reports it as recent', async () => {
    const recorded = await heartbeat.record();
    assert.ok(recorded, 'record() returned nothing');
    const age = await heartbeat.ageSeconds();
    assert.ok(age >= 0 && age < 30, `age after a ping should be ~0, got ${age}`);
  });

  test('recording twice keeps one row', async () => {
    await heartbeat.record();
    await heartbeat.record();
    const { rows } = await db.pool.query(
      'SELECT count(*)::int AS n FROM service_heartbeat WHERE service = $1', [heartbeat.SERVICE],
    );
    assert.equal(rows[0].n, 1, 'the heartbeat must be a single row, not a log');
  });

  test('check is healthy while pings keep arriving', async () => {
    await heartbeat.record();
    const result = await heartbeat.check();
    assert.equal(result.ok, true, `unexpected: ${result.verdict}`);
    assert.equal(result.verdict, 'ok');
    assert.ok(result.maxGapSeconds <= result.toleranceSeconds);
  });

  test('a lapsed ping stays reported even though the endpoint was just called', async () => {
    /*
     * The case that makes the max_gap column worth having, and the reason this runs
     * against real SQL rather than a fake pool: the gap arithmetic is in SQL.
     *
     * The real sequence is a job that dies, and a poke an hour later. The poke is
     * a genuine one-hour gap, so recording it is honest - and it is why the answer
     * is "unhealthy" rather than "recovered". A manual poke cannot declare the job
     * healthy, because it is not evidence the job ran.
     */
    await db.pool.query('DELETE FROM service_heartbeat WHERE service = $1', [heartbeat.SERVICE]);
    await db.pool.query(
      `INSERT INTO service_heartbeat (service, last_ping_at, max_gap_seconds)
            VALUES ($1, now() - interval '1 hour', 0)`,
      [heartbeat.SERVICE],
    );

    await heartbeat.record();

    const result = await heartbeat.check();
    assert.ok(result.ageSeconds < 60, 'a ping just arrived');
    assert.ok(result.maxGapSeconds >= 3600,
      `the one-hour gap must be recorded, got maxGap=${result.maxGapSeconds}`);
    assert.equal(result.ok, false,
      'a poke is not evidence the scheduled job ran, so it cannot declare health');
    assert.match(result.verdict, /lapsed at least once|job may have stopped/i);
  });

test('a ping that keeps arriving reports healthy again', async () => {
    /*
     * The other direction, so the test above cannot pass by reporting unhealthy
     * unconditionally: once pings are arriving on schedule, the check must say so.
     */
    await db.pool.query('DELETE FROM service_heartbeat WHERE service = $1', [heartbeat.SERVICE]);
    await heartbeat.record();
    const result = await heartbeat.check();
    assert.equal(result.ok, true, `expected healthy, got: ${result.verdict}`);
    assert.equal(result.maxGapSeconds, 0, 'no gap has been observed');
  });

  test('the largest gap only ever increases', async () => {
    await heartbeat.record();
    const first = await heartbeat.worstGapSeconds();
    // Rapid pings cannot lower it.
    await heartbeat.record();
    await heartbeat.record();
    const second = await heartbeat.worstGapSeconds();
    assert.ok(second >= first, `max gap fell from ${first} to ${second}`);
  });

  test('two pings far apart record a gap of roughly that distance', async () => {
    await db.pool.query('DELETE FROM service_heartbeat WHERE service = $1', [heartbeat.SERVICE]);
    await heartbeat.record();
    await db.pool.query(
      'UPDATE service_heartbeat SET last_ping_at = now() - interval \'45 seconds\' WHERE service = $1',
      [heartbeat.SERVICE],
    );
    await heartbeat.record();
    const gap = await heartbeat.worstGapSeconds();
    assert.ok(gap >= 40 && gap < 70, `expected roughly 45s, got ${gap}`);
  });

  test('the recorded timestamp is the newest one written', async () => {
    /*
     * Compared as timestamps, not as ages in seconds. Two pings a few milliseconds
     * apart both floor to an age of 0, so asserting on `age` here would compare 0
     * with 0 and pass or fail on timing noise rather than on behaviour.
     */
    const readStamp = async () => {
      const { rows } = await db.pool.query(
        'SELECT last_ping_at FROM service_heartbeat WHERE service = $1', [heartbeat.SERVICE],
      );
      return new Date(rows[0].last_ping_at).getTime();
    };

    await heartbeat.record();
    const first = await readStamp();

    // Backdate the row, then re-record. The new write must win.
    await db.pool.query(
      'UPDATE service_heartbeat SET last_ping_at = now() - interval \'5 minutes\' WHERE service = $1',
      [heartbeat.SERVICE],
    );
    await heartbeat.record();
    const second = await readStamp();

    assert.ok(second > first,
      `re-recording must overwrite the backdated stamp: ${first} then ${second}`);
    assert.ok(Date.now() - second < 5000, 'the surviving stamp should be the newest');
  });
}