const cron = require('node-cron');
const Series = require('../models/Series');

function registerJobs() {
  // Every day at 00:00 server time — resets the "daily" ranking counter.
  cron.schedule('0 0 * * *', async () => {
    try {
      const result = await Series.updateMany({}, { $set: { 'views.daily': 0, lastDailyReset: new Date() } });
      console.log(`[cron] Daily view counters reset (${result.modifiedCount} series)`);
    } catch (err) {
      console.error('[cron] Daily reset failed:', err.message);
    }
  });

  // Every Sunday at 00:05 server time — resets the "weekly" ranking counter.
  cron.schedule('5 0 * * 0', async () => {
    try {
      const result = await Series.updateMany({}, { $set: { 'views.weekly': 0, lastWeeklyReset: new Date() } });
      console.log(`[cron] Weekly view counters reset (${result.modifiedCount} series)`);
    } catch (err) {
      console.error('[cron] Weekly reset failed:', err.message);
    }
  });

  console.log('[cron] View counter reset jobs registered');
}

module.exports = registerJobs;
