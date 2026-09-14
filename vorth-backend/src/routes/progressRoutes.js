const express = require('express');
const progressController = require('../controllers/progressController');
const { protect } = require('../middleware/auth');

const router = express.Router();
router.use(protect);

router.get('/', progressController.list);
router.get('/:seriesId', progressController.getForSeries);
router.put('/:seriesId', progressController.upsert);
router.delete('/:seriesId', progressController.remove);

module.exports = router;
