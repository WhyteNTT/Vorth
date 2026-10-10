const express = require('express');
const db = require('../config/db');
const env = require('../config/env');
const heartbeat = require('../services/heartbeat');

const router = express.Router();

router.use('/auth', require('./authRoutes'));
router.use('/series', require('./seriesRoutes'));
router.use('/chapters', require('./chapterRoutes'));
router.use('/comments', require('./commentRoutes'));
router.use('/library', require('./libraryRoutes'));
router.use('/progress', require('./progressRoutes'));
router.use('/notifications', require('./notificationRoutes'));
router.use('/uploads', require('./uploadRoutes'));
router.use('/dmca', require('./dmcaRoutes'));
// Content Policy reports, kept separate from DMCA: one is a house rule, the
// other is a copyright claim with statutory weight.
router.use('/reports', require('./reportRoutes'));
router.use('/admin', require('./adminRoutes'));
router.use('/legal', require('./legalRoutes'));

router.get('/', (req, res) => res.json({ success: true, message: 'Vorth API is running. Use /api/health for status.' }));
router.get('/health', async (req, res) => {
  let database = 'connected';
  try { await db.pool.query('SELECT 1'); } catch (_) { database = 'disconnected'; }
  res.status(database === 'connected' ? 200 : 503).json({
    success: database === 'connected',
    status: database === 'connected' ? 'ok' : 'degraded',
    database,
    time: new Date().toISOString(),
  });
});

/*
 * The keep-warm ping, as its own endpoint.
 *
 * Separate from /api/health on purpose. /api/health is polled by Render's own
 * health check, by uptime monitors and by anyone with the URL, and it is cached
 * and rate-limited as a public endpoint should be. A scheduled job that only needs
 * to prove the instance is awake does not want to be one of a crowd, and making it
 * a distinct path means Render's checks cannot be mistaken for the ping.
 */
router.get('/keep-warm', async (req, res) => {
  /*
   * Unauthenticated on purpose. See the note in services/heartbeat.js: a Render
   * cron job can only issue a plain GET, so requiring a secret would mean the
   * real job could never record anything and the site would look permanently
   * unverified. The only consequence of reaching this handler is writing a
   * timestamp, and getting a response already proves the instance is awake.
   */
  try {
    const recorded = await heartbeat.record();
    return res.status(200).json({
      success: true,
      status: 'awake',
      service: heartbeat.SERVICE,
      at: recorded ? recorded.lastPingAt.toISOString() : null,
      // The largest gap ever seen, so a one-off response reveals whether the job
      // has ever lapsed without needing a second call.
      maxGapSeconds: recorded ? recorded.maxGapSeconds : null,
    });
  } catch (_err) {
    /*
     * The endpoint's purpose is served by the request arriving: the instance is
     * awake. Failing here would make Render retry a job whose work is already
     * done, and would report the database as broken when only this one write
     * failed. So the ping is acknowledged, and says so.
     */
    return res.status(200).json({ success: true, status: 'awake', recorded: false });
  }
});

/*
 * Reports whether the keep-warm job is still doing its job.
 *
 * Separate from the ping itself, and this one *does* authenticate - it is read by
 * a person deciding whether to worry, it is not on a schedule, and there is no
 * reason for it to be public. A 503 when unhealthy is deliberate: that is what
 * makes it usable as an alert condition by anything that understands HTTP status
 * codes, which is most uptime monitors, free ones included.
 */
router.get('/keep-warm/status', async (req, res) => {
  const configured = env.keepWarmToken;
  if (!configured) {
    // No token configured means no way to authenticate a caller. Refusing is the
    // only safe answer: reporting the heartbeat's state to anyone who asks would
    // hand out the very evidence an attacker would use to time their requests.
    return res.status(503).json({
      success: false,
      error: 'Keep-warm status is unavailable: no KEEP_WARM_TOKEN is configured.',
    });
  }
  const presented = req.headers['x-keep-warm-token'];
  if (typeof presented !== 'string' || presented !== configured) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }

  try {
    const result = await heartbeat.check();
    return res.status(result.ok ? 200 : 503).json({ success: result.ok, ...result });
  } catch (_err) {
    return res.status(503).json({ success: false, error: 'Heartbeat could not be read.' });
  }
});

module.exports = router;
