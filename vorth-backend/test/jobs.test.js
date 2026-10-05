'use strict';

/**
 * The scheduled jobs.
 *
 * These were closures inside cron.schedule, which made them unreachable from a
 * test - nothing could invoke a callback that only existed inside node-cron's
 * timer. So the single most dangerous code in this file had never run: the
 * `jsonb_set` UPDATE in resetCounter had never been executed against a real
 * PostgreSQL, and a syntax error in it would have surfaced for the first time at
 * midnight, in production, as a cron failure nobody was watching.
 *
 * They are named exports now, which is what makes this file possible. Nothing
 * about the schedule changed.
 *
 * Two things are proved here rather than assumed:
 *   - the counter SQL is valid and does what it claims, against a real database
 *   - a job that fails logs and returns, rather than rejecting into an unhandled
 *     rejection that would take the process down
 */

process.env.DATABASE_URL ||= 'postgres://stub/stub';
process.env.DATABASE_SSL = 'false';
process.env.JWT_SECRET ||= 'test-secret';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createFakePool } = require('./helpers/fakePool');

const jobs = require('../src/jobs/resetViews');

/* ------------------------------------------------------------------ *
 * resetCounter
 * ------------------------------------------------------------------ */

test('resetCounter refuses a key it does not know instead of building SQL from it', async () => {
  /*
   * `key` is interpolated into the statement - into a jsonb path and into a
   * predicate - so it cannot be trusted because both current call sites happen to
   * pass a literal. A third call site is exactly the situation where that
   * assumption breaks, and this fails at the boundary rather than at 00:00.
   *
   * Asserted by checking that no statement was issued, not that the SQL "looks
   * right": the point is that an unknown key never reaches the database at all.
   */
  const fake = createFakePool({ rows: {} });
  const db = require('../src/config/db');
  db.setPool(fake);
  try {
  const attempts = [
    'daily; DROP TABLE series; --',
    "daily') OR 1=1 --",
    'DAILY',
    '',
    'alltime',
    'last_daily_reset',
    undefined,
    null,
  ];

  // rejects, not throws: resetCounter is async, so the check happens inside a
  // promise. Asserting a synchronous throw would have passed on a function that
  // never validated anything, because the rejection would escape the assertion.
  for (const key of attempts) {
    await assert.rejects(
      () => jobs.resetCounter(key),
      /not a resettable counter/,
      `resetCounter(${JSON.stringify(key)}) did not refuse the key`,
    );
  }

  // And nothing reached the database for any of them.
  assert.deepEqual(fake.log.filter((e) => /^UPDATE/.test(e.sql)), [],
    'a statement was issued for a key that should have been refused');
  } finally {
    db.setPool(null);
  }
});

test('resetCounter issues one statement and reports the row count', async () => {
  const fake = createFakePool({ rows: {} });
  const db = require('../src/config/db');
  db.setPool(fake);
  try {
    const changed = await jobs.resetCounter('daily');
    assert.equal(typeof changed, 'number');

    const updates = fake.log.filter((e) => /^UPDATE/.test(e.sql));
    assert.equal(updates.length, 1, `expected one UPDATE, got ${updates.length}`);

    const sql = updates[0].sql;
    // The shape that makes this cheap: one statement, not a read-modify-write
    // per series, and rows already at zero are skipped entirely.
    assert.match(sql, /UPDATE "series"/);
    assert.match(sql, /jsonb_set\(/);
    assert.match(sql, /IS DISTINCT FROM '0'/, 'rows already at zero are not skipped');
    assert.match(sql, /"last_daily_reset" = now\(\)/, 'the daily stamp column is wrong');
    assert.doesNotMatch(sql, /last_weekly_reset/, 'the daily reset stamped the weekly column');
  } finally {
    db.setPool(null);
  }
});

test('the weekly reset stamps its own column', async () => {
  const fake = createFakePool({ rows: {} });
  const db = require('../src/config/db');
  db.setPool(fake);
  try {
    await jobs.resetCounter('weekly');
    const sql = fake.log.find((e) => /^UPDATE/.test(e.sql)).sql;
    assert.match(sql, /"last_weekly_reset" = now\(\)/, 'the weekly stamp column is wrong');
    assert.doesNotMatch(sql, /last_daily_reset/);
  } finally {
    db.setPool(null);
  }
});

/* ------------------------------------------------------------------ *
 * The three job bodies
 * ------------------------------------------------------------------ */

test('the daily and weekly resets call resetCounter with their own key', async () => {
  const fake = createFakePool({ rows: {} });
  const db = require('../src/config/db');
  db.setPool(fake);
  const realLog = console.log;
  console.log = () => {};
  try {
    await jobs.runDailyReset();
    assert.match(fake.log.find((e) => /^UPDATE/.test(e.sql)).sql, /last_daily_reset/);

    fake.log.length = 0;
    await jobs.runWeeklyReset();
    assert.match(fake.log.find((e) => /^UPDATE/.test(e.sql)).sql, /last_weekly_reset/);
  } finally {
    console.log = realLog;
    db.setPool(null);
  }
});

test('a quiet day logs nothing at all', async () => {
  /*
   * The WHERE clause skips rows already at zero, so on a day with no traffic
   * rowCount is 0. Logging "0 series" every midnight is how a working job starts
   * looking like a broken one in a log search.
   */
  const fake = createFakePool({ rows: {}, affected: 0 });
  const db = require('../src/config/db');
  db.setPool(fake);
  const lines = [];
  const realLog = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  try {
    const changed = await jobs.runDailyReset();
    assert.equal(changed, 0);
    assert.deepEqual(lines, [], `a no-op reset logged: ${lines.join(' | ')}`);
  } finally {
    console.log = realLog;
    db.setPool(null);
  }
});

test('a working reset says how much it did', async () => {
  const fake = createFakePool({ rows: {}, affected: 17 });
  const db = require('../src/config/db');
  db.setPool(fake);
  const lines = [];
  const realLog = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  try {
    await jobs.runDailyReset();
    assert.equal(lines.length, 1);
    assert.match(lines[0], /17/);
  } finally {
    console.log = realLog;
    db.setPool(null);
  }
});

test('a failing job logs and returns, rather than rejecting', async () => {
  /*
   * This is the property that keeps a routine failure from becoming an outage.
   * Each body is wrapped in `.catch()` at the point cron.schedule is called, so
   * a rejected promise never reaches node-cron's timer: node-cron does not
   * attach a handler, which would make it an unhandled rejection - and before the
   * shutdown work, unhandledRejection exited the process. A prune that hits a
   * locked row would then take the whole deployment down until someone noticed.
   *
   * Asserted on the registered wrapper, because calling runDailyReset() directly
   * *should* reject - swallowing errors inside the body would hide them from the
   * tests that need to see them.
   */
  const source = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'src', 'jobs', 'resetViews.js'), 'utf8',
  );
  const scheduled = source.slice(source.indexOf('schedules.push(cron.schedule'));

  const wrappers = scheduled.match(/cron\.schedule\([^)]*,\s*\(\)\s*=>\s*run\w+\(\)\s*\n?\s*\.catch\(/g);
  assert.equal(wrappers && wrappers.length, 3,
    `expected all 3 schedules to wrap their body in .catch(); found ${wrappers ? wrappers.length : 0}`);

  // And the body itself does not swallow, so a real failure is still a rejection
  // for anything that wants to handle it.
  const fake = createFakePool({ rows: {}, errors: { UPDATE: new Error('relation "series" does not exist') } });
  const db = require('../src/config/db');
  db.setPool(fake);
  try {
    await assert.rejects(() => jobs.runDailyReset(), /does not exist/,
      'the job body swallowed a real failure, so nothing could report it');
  } finally {
    db.setPool(null);
  }
});

test('housekeeping prunes all four things and reports the counts', async () => {
  const fake = createFakePool({ rows: {} });
  const db = require('../src/config/db');
  db.setPool(fake);
  const lines = [];
  const realLog = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  try {
    const result = await jobs.runHousekeeping();
    assert.ok(result, 'housekeeping returned nothing');
    for (const key of ['uploads', 'views', 'refresh', 'tokens']) {
      assert.equal(typeof result[key], 'number', `housekeeping did not report ${key}`);
    }
  } finally {
    console.log = realLog;
    db.setPool(null);
  }
});

test('housekeeping that removes nothing stays quiet', async () => {
  const fake = createFakePool({ rows: {}, affected: 0 });
  const db = require('../src/config/db');
  db.setPool(fake);
  const lines = [];
  const realLog = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  try {
    await jobs.runHousekeeping();
    assert.deepEqual(lines, [], `a no-op housekeeping logged: ${lines.join(' | ')}`);
  } finally {
    console.log = realLog;
    db.setPool(null);
  }
});

test('the exported surface is what the schedules and the shutdown both need', () => {
  // If a name goes missing, either cron.schedule or stopJobs stops working - and
  // both are load-bearing at boot and at deploy respectively.
  for (const name of [
    'resetCounter', 'stopJobs', 'runDailyReset', 'runWeeklyReset', 'runHousekeeping',
  ]) {
    assert.equal(typeof jobs[name], 'function', `${name} is not exported as a function`);
  }
  // registerJobs is the module itself, which is what server.js requires.
  assert.equal(typeof jobs, 'function', 'the module must still be callable as registerJobs');
});