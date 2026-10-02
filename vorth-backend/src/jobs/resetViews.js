const cron = require('node-cron');
const db = require('../config/db');
const env = require('../config/env');
const { pruneViewEvents } = require('../services/views');
const { pruneOrphanUploads } = require('../services/uploads');
const RefreshToken = require('../models/RefreshToken');
const AuthToken = require('../models/AuthToken');

/**
 * Both counter resets are a single UPDATE with a jsonb_set assignment, rather
 * than loading every series and rewriting each row in turn.
 *
 * The WHERE clause skips rows that are already zero, so a quiet day does no
 * work at all.
 */
async function resetCounter(key) {
  const { rowCount } = await db.pool.query(
    `UPDATE "series"
        SET "views" = jsonb_set(COALESCE("views", '{}'::jsonb), '{${key}}', '0'::jsonb, true),
            ${key === 'daily' ? '"last_daily_reset"' : '"last_weekly_reset"'} = now()
      WHERE "views" ->> '${key}' IS DISTINCT FROM '0'`,
    []
  );
  return rowCount;
}

function registerJobs() {
  // Every day at 00:00 server time — resets the "daily" ranking counter.
  cron.schedule('0 0 * * *', async () => {
    try {
      const changed = await resetCounter('daily');
      if (changed) console.log(`[cron] Daily view counters reset (${changed} series)`);
    } catch (err) {
      console.error('[cron] Daily reset failed:', err.message);
    }
  });

  // Every Sunday at 00:05 server time — resets the "weekly" ranking counter.
  cron.schedule('5 0 * * 0', async () => {
    try {
      const changed = await resetCounter('weekly');
      if (changed) console.log(`[cron] Weekly view counters reset (${changed} series)`);
    } catch (err) {
      console.error('[cron] Weekly reset failed:', err.message);
    }
  });

  // Housekeeping: unreferenced uploads, stale view counters, spent tokens.
  cron.schedule('*/30 * * * *', async () => {
    try {
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
    } catch (err) {
      console.error('[cron] Housekeeping failed:', err.message);
    }
  });

  console.log(`[cron] Jobs registered (storage=${env.storageDriver}, rate-limit=${env.rateLimitStore})`);
}

module.exports = registerJobs;
module.exports.resetCounter = resetCounter;