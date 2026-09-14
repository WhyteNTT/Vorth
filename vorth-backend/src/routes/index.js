const express = require('express');
const { pool } = require('../config/db');

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
router.use('/admin', require('./adminRoutes'));
router.use('/legal', require('./legalRoutes'));

router.get('/', (req, res) => res.json({ success: true, message: 'Vorth API is running. Use /api/health for status.' }));
router.get('/health', async (req, res) => {
  let database = 'connected';
  try { await pool.query('SELECT 1'); } catch (_) { database = 'disconnected'; }
  res.status(database === 'connected' ? 200 : 503).json({
    success: database === 'connected',
    status: database === 'connected' ? 'ok' : 'degraded',
    database,
    time: new Date().toISOString(),
  });
});

module.exports = router;
