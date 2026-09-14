const express = require('express');
const adminController = require('../controllers/adminController');
const { protect, restrictTo } = require('../middleware/auth');

const router = express.Router();
router.use(protect, restrictTo('admin'));

router.get('/users', adminController.listUsers);
router.patch('/users/:id/ban', adminController.banUser);
router.patch('/users/:id/unban', adminController.unbanUser);
router.delete('/series/:id', adminController.removeSeries);
router.delete('/comments/:id', adminController.removeComment);

module.exports = router;
