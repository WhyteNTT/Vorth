const express = require('express');
const chapterController = require('../controllers/chapterController');
const { protect, optionalAuth } = require('../middleware/auth');
const { requireChapterOwner } = require('../middleware/ownership');

const router = express.Router();

// optionalAuth so signed-in readers are de-duplicated by account rather than
// by IP when a view is recorded. Guests are still served.
router.get('/:id', optionalAuth, chapterController.getOne);
router.patch('/:id', protect, requireChapterOwner, chapterController.update);
router.delete('/:id', protect, requireChapterOwner, chapterController.remove);

module.exports = router;