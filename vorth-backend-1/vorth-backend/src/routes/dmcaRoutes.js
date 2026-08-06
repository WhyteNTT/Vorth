const express = require('express');
const dmcaController = require('../controllers/dmcaController');
const { protect, restrictTo } = require('../middleware/auth');

const router = express.Router();

// Public: anyone (including non-users) can file a takedown notice.
router.post('/', dmcaController.submit);

// Admin only: review queue.
router.get('/', protect, restrictTo('admin'), dmcaController.list);
router.get('/:id', protect, restrictTo('admin'), dmcaController.getOne);
router.patch('/:id', protect, restrictTo('admin'), dmcaController.resolve);

module.exports = router;
