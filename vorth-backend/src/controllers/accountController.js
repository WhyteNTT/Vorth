const { body } = require('express-validator');
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const throwIfInvalid = require('../utils/validate');
const env = require('../config/env');
const mailer = require('../services/mailer');
const User = require('../models/User');
const AuthToken = require('../models/AuthToken');
const RefreshToken = require('../models/RefreshToken');

/* ------------------------------------------------------------------ *
 * Email verification
 * ------------------------------------------------------------------ */

async function sendVerification(user) {
  const { token } = await AuthToken.issue(user.id, 'email_verification', env.emailVerificationHours);
  const url = mailer.link(`/verify-email?token=${encodeURIComponent(token)}`);
  await mailer.send({
    to: user.email,
    subject: 'Confirm your Vorth account',
    text: [
      `Hi ${user.displayName},`,
      '',
      'Confirm your email address to finish setting up your Vorth account:',
      '',
      url,
      '',
      `This link expires in ${env.emailVerificationHours} hours and can be used once.`,
      'If you did not create an account, you can ignore this message.',
    ].join('\n'),
  });
  return url;
}

/** Issues a fresh verification mail, invalidating any previous link. */
const resendVerification = [
  asyncHandler(async (req, res) => {
    const user = await User.findOne({ email: req.user.email }).exec();
    // Always 200: whether an address is registered is not this endpoint's
    // business to disclose.
    if (!user || user.emailVerifiedAt) {
      return res.json({ success: true, message: 'If that address needs verifying, a link is on its way.' });
    }
    await AuthToken.invalidateAll(user.id, 'email_verification');
    await sendVerification(user);
    return res.json({ success: true, message: 'Verification link sent.' });
  }),
];

const verifyValidators = [
  body('token').isString().notEmpty().withMessage('A token is required').isLength({ min: 10, max: 200 }),
];

const verifyEmail = [
  ...verifyValidators,
  asyncHandler(async (req, res) => {
    throwIfInvalid(req);
    const record = await AuthToken.consume(req.body.token, 'email_verification');
    if (!record) throw ApiError.badRequest('This verification link is invalid or has expired.');

    const user = await User.findById(record.user);
    if (!user) throw ApiError.badRequest('This verification link is invalid or has expired.');

    user.emailVerifiedAt = new Date();
    await user.save();

    res.json({ success: true, message: 'Your email address is verified.' });
  }),
];

/** Send a verification link immediately after registration. */
async function sendVerificationAfterSignup(user) {
  if (!env.requireEmailVerification) {
    // Still mark it verified so downstream checks have a single meaning.
    user.emailVerifiedAt = new Date();
    await user.save();
    return;
  }
  try {
    await sendVerification(user);
  } catch (err) {
    // Never fail registration because the mail server is down; the user can
    // request a new link.
    console.error('[auth] could not send verification mail:', err.message);
  }
}

/* ------------------------------------------------------------------ *
 * Password reset
 * ------------------------------------------------------------------ */

const forgotValidators = [
  body('email').trim().isEmail().withMessage('A valid email is required').normalizeEmail(),
];

/**
 * Always answers the same way regardless of whether the address exists, so
 * this cannot be used to enumerate accounts.
 */
const forgotPassword = [
  ...forgotValidators,
  asyncHandler(async (req, res) => {
    throwIfInvalid(req);
    const email = req.body.email;
    const user = await User.findOne({ email }).exec();

    const generic = 'If that address has an account, a reset link is on its way.';

    if (user && !user.isBanned) {
      await AuthToken.invalidateAll(user.id, 'password_reset');
      const { token } = await AuthToken.issue(user.id, 'password_reset', env.passwordResetHours);
      const url = mailer.link(`/reset-password?token=${encodeURIComponent(token)}`);
      try {
        await mailer.send({
          to: user.email,
          subject: 'Reset your Vorth password',
          text: [
            `Hi ${user.displayName},`,
            '',
            'Use the link below to choose a new password:',
            '',
            url,
            '',
            `This link expires in ${env.passwordResetHours} hour(s) and can be used once.`,
            'If you did not request this, nothing has changed and you can ignore this message.',
          ].join('\n'),
        });
      } catch (err) {
        console.error('[auth] could not send reset mail:', err.message);
      }
    }

    res.json({ success: true, message: generic });
  }),
];

const resetValidators = [
  body('token').isString().notEmpty().withMessage('A token is required').isLength({ min: 10, max: 200 }),
  body('newPassword').isLength({ min: 8 }).withMessage('New password must be at least 8 characters'),
];

const resetPassword = [
  ...resetValidators,
  asyncHandler(async (req, res) => {
    throwIfInvalid(req);
    const record = await AuthToken.consume(req.body.token, 'password_reset');
    if (!record) throw ApiError.badRequest('This reset link is invalid or has expired.');

    const user = await User.findById(record.user);
    if (!user) throw ApiError.badRequest('This reset link is invalid or has expired.');

    user.password = req.body.newPassword;
    await user.save();

    // A password change invalidates every existing session.
    await RefreshToken.revokeAllFor(user.id);

    res.json({ success: true, message: 'Your password has been changed. Please sign in again.' });
  }),
];

module.exports = {
  resendVerification,
  verifyEmail,
  forgotPassword,
  resetPassword,
  sendVerificationAfterSignup,
  sendVerification,
};