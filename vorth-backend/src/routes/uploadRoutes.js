const express = require('express');
const { uploadCover, uploadPages, serveObject } = require('../controllers/uploadController');
const { protect } = require('../middleware/auth');
const upload = require('../middleware/upload');
const { uploadLimiter } = require('../middleware/rateLimiter');
const { MAX_FILES_PER_REQUEST } = upload;

const router = express.Router();

/*
 * The limiter goes before `protect` so a flood of unauthenticated upload attempts
 * is bounded by IP rather than running a token lookup per attempt. It is keyed by
 * IP for the same reason: req.user is not populated this early.
 */
router.post('/cover', uploadLimiter, protect, upload.single('cover'), uploadCover);
router.post(
  '/pages',
  uploadLimiter,
  protect,
  // The count comes from the shared constant rather than a second literal, so the
  // two cannot drift. They were both 60 before, and nothing tied them together.
  upload.array('pages', MAX_FILES_PER_REQUEST),
  uploadPages,
);

// Reads are public: covers and comic pages are shown to signed-out visitors.
router.get('/:key', serveObject);

module.exports = router;