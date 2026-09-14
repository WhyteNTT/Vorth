const express = require('express');
const seriesController = require('../controllers/seriesController');
const chapterController = require('../controllers/chapterController');
const commentController = require('../controllers/commentController');
const { protect } = require('../middleware/auth');
const { requireSeriesOwner } = require('../middleware/ownership');

const router = express.Router();

// --- public catalog ---
router.get('/', seriesController.list);
router.get('/rankings', seriesController.rankings); // must precede '/:id'
router.get('/:id', seriesController.getOne);

// --- creator-only writes ---
router.post('/', protect, seriesController.create);
router.patch('/:id', protect, requireSeriesOwner, seriesController.update);
router.delete('/:id', protect, requireSeriesOwner, seriesController.remove);

// --- chapters nested under a series ---
// Only the series owner (or an admin) can publish a chapter to it —
// everyone else can browse and read but never write here.
router.post('/:seriesId/chapters', protect, requireSeriesOwner, chapterController.create);

// --- comments/reviews nested under a series ---
router.get('/:seriesId/comments', commentController.list);
router.post('/:seriesId/comments', protect, commentController.create);

module.exports = router;
