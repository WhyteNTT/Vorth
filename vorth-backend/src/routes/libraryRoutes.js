const express = require('express');
const libraryController = require('../controllers/libraryController');
const { protect } = require('../middleware/auth');

const router = express.Router();
router.use(protect);

router.get('/', libraryController.getSaved);
// Concrete sub-paths are registered before '/:seriesId' so they are not
// swallowed by the parameterised route.
router.post('/downloads', libraryController.addDownload);
router.get('/downloads', libraryController.getDownloads);
router.delete('/downloads/:chapterId', libraryController.removeDownload);

router.post('/:seriesId', libraryController.save);
router.delete('/:seriesId', libraryController.unsave);

module.exports = router;