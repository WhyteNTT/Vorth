const express = require('express');
const { uploadCover, uploadPages } = require('../controllers/uploadController');
const { protect } = require('../middleware/auth');
const upload = require('../middleware/upload');

const router = express.Router();
router.use(protect);

router.post('/cover', upload.single('cover'), uploadCover);
router.post('/pages', upload.array('pages', 60), uploadPages);

module.exports = router;
