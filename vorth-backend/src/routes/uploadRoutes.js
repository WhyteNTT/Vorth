const express = require('express');
const { uploadCover, uploadPages, serveObject } = require('../controllers/uploadController');
const { protect } = require('../middleware/auth');
const upload = require('../middleware/upload');

const router = express.Router();

router.post('/cover', protect, upload.single('cover'), uploadCover);
router.post('/pages', protect, upload.array('pages', 60), uploadPages);

// Reads are public: covers and comic pages are shown to signed-out visitors.
router.get('/:key', serveObject);

module.exports = router;