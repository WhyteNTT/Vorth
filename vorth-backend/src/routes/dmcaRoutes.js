const express = require('express');
const dmcaController = require('../controllers/dmcaController');
const counterNoticeController = require('../controllers/dmcaCounterNoticeController');
const { protect, restrictTo } = require('../middleware/auth');
const { dmcaLimiter } = require('../middleware/rateLimiter');

const router = express.Router();

/*
 * Order matters here. Express matches in declaration order, so a literal path
 * declared after a "/:id" pattern never runs: "/counter-notices" would be read
 * as the id "counter-notices" and rejected as a bad UUID. The counter-notice
 * collection paths are therefore declared before "/:id".
 */

// Public: anyone (including non-users) can file a takedown notice.
router.post('/', dmcaLimiter, dmcaController.submit);

// Public: the alleged infringer may counter-notice without an account, exactly
// like the complainant files without one.
router.post(
  '/:id/counter-notice',
  dmcaLimiter,
  counterNoticeController.submitCounterNotice
);

// Admin only: counter-notice queue. Before "/:id", deliberately.
router.get('/counter-notices', protect, restrictTo('admin'), counterNoticeController.listCounterNotices);
router.get('/counter-notices/:id', protect, restrictTo('admin'), counterNoticeController.getCounterNotice);
router.patch(
  '/counter-notices/:id',
  protect,
  restrictTo('admin'),
  counterNoticeController.resolveCounterNotice
);

// Admin only: review queue.
router.get('/', protect, restrictTo('admin'), dmcaController.list);
router.get('/:id', protect, restrictTo('admin'), dmcaController.getOne);
router.patch('/:id', protect, restrictTo('admin'), dmcaController.resolve);

module.exports = router;
