const express = require('express');
const libraryController = require('../controllers/libraryController');
const { protect } = require('../middleware/auth');

const router = express.Router();
router.use(protect);

router.get('/', libraryController.getSaved);
router.post('/downloads', libraryController.addDownload); // must precede '/:seriesId'
router.get('/downloads', libraryController.getDownloads);
router.delete('/downloads/:chapterId', libraryController.removeDownload);

router.post('/:seriesId', libraryController.save);
router.delete('/:seriesId', libraryController.unsave);

module.exports = router;
