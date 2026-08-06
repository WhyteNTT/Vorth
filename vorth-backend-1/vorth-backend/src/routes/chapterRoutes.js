const express = require('express');
const chapterController = require('../controllers/chapterController');
const { protect } = require('../middleware/auth');
const { requireChapterOwner } = require('../middleware/ownership');

const router = express.Router();

router.get('/:id', chapterController.getOne);
router.patch('/:id', protect, requireChapterOwner, chapterController.update);
router.delete('/:id', protect, requireChapterOwner, chapterController.remove);

module.exports = router;
