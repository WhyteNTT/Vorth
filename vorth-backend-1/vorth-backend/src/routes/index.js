const express = require('express');

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
router.get('/health', (req, res) => res.json({ success: true, status: 'ok', time: new Date().toISOString() }));

module.exports = router;
