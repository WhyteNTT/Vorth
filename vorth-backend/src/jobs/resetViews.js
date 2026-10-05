const cron = require('node-cron');
const db = require('../config/db');
const env = require('../config/env');
const { pruneViewEvents } = require('../services/views');
const { pruneOrphanUploads } = require('../services/uploads');
const RefreshToken = require('../models/RefreshToken');
const AuthToken = require('../models/AuthToken');

/**
 * The only counters that can be reset, and the column each one stamps.
 *
 * Not a type union - a runtime check, because `key` is interpolated into SQL
 * below. Both call sites pass a literal today, so this is not a live
 * vulnerability; it is that an exported function taking a string and building
 * SQL from it is a trap for whoever adds the third call site, and it fails
 * loudly here rather than silently issuing a broken UPDATE at 00:00.
 */
const RESETTABLE = {
  daily: '"last_daily_reset"',
  weekly: '"last_weekly_reset"',
};

/**
 * Both counter resets are a single UPDATE with a jsonb_set assignment, rather
 * than loading every series and rewriting each row in turn.
 *
 * The WHERE clause skips rows that are already zero, so a quiet day does no
 * work at all.
 */
async function resetCounter(key) {
  const stampColumn = RESETTABLE[key];
  if (!stampColumn) {
    throw new Error(
      `resetCounter: "${key}" is not a resettable counter (expected one of: `
      + `${Object.keys(RESETTABLE).join(', ')})`,
    );
  }

  const { rowCount } = await db.pool.query(
    `UPDATE "series"
        SET "views" = jsonb_set(COALESCE("views", '{}'::jsonb), '{${key}}', '0'::jsonb, true),
            ${stampColumn} = now()
      WHERE "views" ->> '${key}' IS DISTINCT FROM '0'`,
    []
  );
  return rowCount;
}

/**
 * The three scheduled bodies, as named functions rather than closures.
 *
 * They were inline arrow functions passed to cron.schedule, which made them
 * unreachable from a test: nothing could invoke a callback that only exists
 * inside node-cron's timer. Extracting them changes no behaviour and no
 * schedule - it is the difference between a job that can only be verified by
 * waiting for midnight and one that can be called directly.
 *
 * Each keeps its own try/catch. A cron callback that throws is an unhandled
 * rejection and, before the shutdown work, would have taken the process down:
 * a routine housekeeping failure should log and be retried in 30 minutes, not
 * end the deployment.
 */
async function runDailyReset() {
  const changed = await resetCounter('daily');
  if (changed) console.log(`[cron] Daily view counters reset (${changed} series)`);
  return changed;
}

async function runWeeklyReset() {
  const changed = await resetCounter('weekly');
  if (changed) console.log(`[cron] Weekly view counters reset (${changed} series)`);
  return changed;
}

/** Unreferenced uploads, stale view counters, and spent tokens. */
async function runHousekeeping() {
  const [uploads, views, refresh, tokens] = await Promise.all([
    pruneOrphanUploads(db.pool),
    pruneViewEvents(db.pool),
    RefreshToken.pruneExpired(7),
    AuthToken.pruneExpired(7),
  ]);
  if (uploads || views || refresh || tokens) {
    console.log(`[cron] Housekeeping: ${uploads} orphan upload(s), ${views} view event(s), `
      + `${refresh} refresh token(s), ${tokens} auth token(s) removed`);
  }
  return { uploads, views, refresh, tokens };
}

/**
 * The schedules this module registered, so a shutdown can stop them.
 *
 * node-cron keeps its timers alive, which keeps the event loop alive. Without
 * this, a drain that finishes would leave the process running and the deploy
 * would have to kill it - turning a graceful shutdown into a forceful one.
 */
const schedules = [];

/** Stops every registered job. Safe to call when none were registered. */
function stopJobs() {
  for (const task of schedules.splice(0)) {
    try { task.stop(); } catch (_) { /* already stopped */ }
  }
}

function registerJobs() {
  // Every day at 00:00 server time — resets the "daily" ranking counter.
  schedules.push(cron.schedule('0 0 * * *', () => runDailyReset()
    .catch((err) => console.error('[cron] Daily reset failed:', err.message))));

  // Every Sunday at 00:05 server time — resets the "weekly" ranking counter.
  schedules.push(cron.schedule('5 0 * * 0', () => runWeeklyReset()
    .catch((err) => console.error('[cron] Weekly reset failed:', err.message))));

  // Housekeeping: unreferenced uploads, stale view counters, spent tokens.
  schedules.push(cron.schedule('*/30 * * * *', () => runHousekeeping()
    .catch((err) => console.error('[cron] Housekeeping failed:', err.message))));

  console.log(`[cron] Jobs registered (storage=${env.storageDriver}, rate-limit=${env.rateLimitStore})`);
}

module.exports = registerJobs;
module.exports.resetCounter = resetCounter;
module.exports.stopJobs = stopJobs;
module.exports.runDailyReset = runDailyReset;
module.exports.runWeeklyReset = runWeeklyReset;
module.exports.runHousekeeping = runHousekeeping;