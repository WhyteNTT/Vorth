const express = require('express');
const authController = require('../controllers/authController');
const accountController = require('../controllers/accountController');
const { protect } = require('../middleware/auth');
const { authLimiter } = require('../middleware/rateLimiter');

const router = express.Router();

router.post('/register', authLimiter, authController.register);
router.post('/login', authLimiter, ...authController.loginThrottled);
router.post('/refresh', authController.refresh);
router.post('/logout', authController.logout);
router.post('/logout-all', protect, ...authController.logoutAll);

// --- email verification / password reset ---
// These answer identically whether or not the address is registered, so they
// cannot be used to discover which emails have accounts.
router.post('/forgot-password', authLimiter, ...accountController.forgotPassword);
router.post('/reset-password', authLimiter, ...accountController.resetPassword);
router.post('/verify-email', authLimiter, ...accountController.verifyEmail);
router.post('/resend-verification', protect, ...accountController.resendVerification);

router.get('/me', protect, authController.getMe);
router.patch('/me', protect, ...authController.updateProfile);
router.patch('/me/password', protect, ...authController.changePassword);

module.exports = router;