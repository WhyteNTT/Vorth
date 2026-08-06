const express = require('express');
const commentController = require('../controllers/commentController');
const { protect } = require('../middleware/auth');

const router = express.Router();

router.delete('/:id', protect, commentController.remove);

module.exports = router;
