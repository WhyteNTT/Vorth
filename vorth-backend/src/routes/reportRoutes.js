'use strict';

/**
 * Content Policy reports.
 *
 * A house-rule violation report. No sworn good-faith or accuracy statements,
 * no signature block, and no requirement to identify yourself for the report
 * to be read. A reporter address is still collected so that an author can be
 * told their work was reported and why, which the policy requires.
 */

const express = require('express');
const reportController = require('../controllers/reportController');
const { protect, restrictTo } = require('../middleware/auth');

const router = express.Router();

/** Public: anyone, including a signed-out reader, can report content. */
router.post('/', reportController.submit);

/** Admin review queue. */
router.get('/', protect, restrictTo('admin'), reportController.list);
router.get('/:id', protect, restrictTo('admin'), reportController.getOne);
router.patch('/:id', protect, restrictTo('admin'), reportController.resolve);

module.exports = router;