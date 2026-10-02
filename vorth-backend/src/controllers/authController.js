const { body } = require('express-validator');
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const throwIfInvalid = require('../utils/validate');
const generateToken = require('../utils/generateToken');
const env = require('../config/env');
const User = require('../models/User');
const RefreshToken = require('../models/RefreshToken');
const { loginAttemptLimiter } = require('../middleware/rateLimiter');
const { sendVerificationAfterSignup } = require('./accountController');

/**
 * Sets the refresh cookie.
 *
 * SameSite=lax is deliberate: the token is only ever sent on top-level
 * navigation, not on cross-site subrequests, so a CSRF cannot ride on it.
 * `path` is scoped to the auth routes so it is not attached to every request.
 */
function setRefreshCookie(res, token, expiresAt) {
  if (!env.refreshCookieEnabled) return;
  res.cookie(env.refreshCookieName, token, {
    httpOnly: true,
    secure: env.secureCookies,
    sameSite: 'lax',
    path: '/api/auth',
    expires: expiresAt,
  });
}

function clearRefreshCookie(res) {
  res.clearCookie(env.refreshCookieName, { path: '/api/auth' });
}

/** Returns a fresh access token (and refresh token) for a live session. */
async function issueSession(res, user, req) {
  const accessToken = generateToken(user);
  const { token, expiresAt } = await RefreshToken.issue(user.id, {
    userAgent: req.headers['user-agent'],
    ip: req.ip,
    days: env.refreshTokenDays,
  });
  setRefreshCookie(res, token, expiresAt);
  return { accessToken, refreshToken: token, refreshExpiresAt: expiresAt };
}

const registerValidators = [
  body('displayName').trim().notEmpty().withMessage('Display name is required').isLength({ max: 60 }),
  body('username')
    .trim().toLowerCase()
    .matches(/^[a-z0-9_]{3,24}$/).withMessage('Username must be 3-24 characters: lowercase letters, numbers, underscores'),
  body('email').trim().isEmail().withMessage('A valid email is required').normalizeEmail(),
  body('password').isLength({ min: 8 }).withMessage('Password must be at least 8 characters'),
  body('agreedToTerms').custom((value) => value === true || value === 'true')
    .withMessage('You must agree to the Terms of Service and Content Policy'),
  body('ageConfirmed').custom((value) => value === true || value === 'true')
    .withMessage(`You must confirm you are at least ${env.minimumUserAge} years old`),
];

const register = [
  ...registerValidators,
  asyncHandler(async (req, res) => {
    throwIfInvalid(req);
    const { displayName, username, email, password } = req.body;

    const existing = await User.findOne({ $or: [{ username }, { email }] }).exec();
    if (existing) {
      const field = existing.username === username ? 'username' : 'email';
      throw ApiError.conflict(`That ${field} is already taken.`);
    }

    const user = await User.create({
      displayName,
      username,
      email,
      password,
      agreedToTermsAt: new Date(),
      ageConfirmed: true,
      lastLoginAt: new Date(),
    });

    await sendVerificationAfterSignup(user);

    const session = await issueSession(res, user, req);
    res.status(201).json({
      success: true,
      token: session.accessToken,
      refreshToken: session.refreshToken,
      user: user.toSafeObject(),
    });
  }),
];

const loginValidators = [
  body('identifier').trim().notEmpty().withMessage('Username or email is required'),
  body('password').notEmpty().withMessage('Password is required'),
];

const login = [
  ...loginValidators,
  asyncHandler(async (req, res) => {
    throwIfInvalid(req);
    const { identifier, password } = req.body;
    const normalized = identifier.trim().toLowerCase();

    const user = await User.findOne({
      $or: [{ username: normalized }, { email: normalized }],
    }).exec();

    // Same generic message whether the account or the password was wrong,
    // so login attempts can't be used to enumerate valid usernames/emails.
    if (!user || !(await user.comparePassword(password))) {
      throw ApiError.unauthorized('Incorrect username/email or password.');
    }
    if (user.isBanned) throw ApiError.forbidden('This account has been suspended.');

    user.lastLoginAt = new Date();
    await user.save();

    const session = await issueSession(res, user, req);
    res.json({
      success: true,
      token: session.accessToken,
      refreshToken: session.refreshToken,
      user: user.toSafeObject(),
    });
  }),
];

// Per-account throttle, applied only once the password check has failed.
const loginThrottled = [loginAttemptLimiter, login];

const getMe = asyncHandler(async (req, res) => {
  res.json({ success: true, user: req.user.toSafeObject() });
});

const updateProfileValidators = [
  body('displayName').optional().trim().isLength({ min: 1, max: 60 }),
  body('bio').optional().trim().isLength({ max: 300 }),
];

const updateProfile = [
  ...updateProfileValidators,
  asyncHandler(async (req, res) => {
    throwIfInvalid(req);
    const { displayName, bio } = req.body;
    if (displayName !== undefined) req.user.displayName = displayName;
    if (bio !== undefined) req.user.bio = bio;
    await req.user.save();
    res.json({ success: true, user: req.user.toSafeObject() });
  }),
];

const changePasswordValidators = [
  body('currentPassword').notEmpty(),
  body('newPassword').isLength({ min: 8 }).withMessage('New password must be at least 8 characters'),
];

const changePassword = [
  ...changePasswordValidators,
  asyncHandler(async (req, res) => {
    throwIfInvalid(req);
    const { currentPassword, newPassword } = req.body;
    const user = await User.findById(req.user.id);
    if (!(await user.comparePassword(currentPassword))) {
      throw ApiError.unauthorized('Current password is incorrect.');
    }
    user.password = newPassword;
    await user.save();

    // Changing a password ends every other session, then issues a fresh one
    // for this device so the user is not signed out of the tab they are in.
    await RefreshToken.revokeAllFor(user.id);
    const session = await issueSession(res, user, req);

    res.json({
      success: true,
      message: 'Password updated.',
      token: session.accessToken,
      refreshToken: session.refreshToken,
    });
  }),
];

/** Reads the refresh token from the httpOnly cookie, or the body as a fallback. */
function presentedRefreshToken(req) {
  const fromCookie = req.cookies ? req.cookies[env.refreshCookieName] : undefined;
  if (fromCookie) return fromCookie;
  return (req.body && req.body.refreshToken) || null;
}

/**
 * POST /api/auth/refresh — exchanges a refresh token for a new access token.
 * The presented token is revoked and replaced, so it cannot be replayed.
 */
const refresh = asyncHandler(async (req, res) => {
  const presented = presentedRefreshToken(req);

  if (!presented) throw ApiError.unauthorized('No session to refresh.');

  const record = await RefreshToken.findActive(presented);
  if (!record) {
    clearRefreshCookie(res);
    throw ApiError.unauthorized('Your session has expired. Please sign in again.');
  }

  const user = await User.findById(record.user);
  if (!user) throw ApiError.unauthorized('The account for this session no longer exists.');
  if (user.isBanned) {
    await record.revoke();
    clearRefreshCookie(res);
    throw ApiError.forbidden('This account has been suspended.');
  }

  await record.revoke();
  const session = await issueSession(res, user, req);

  res.json({
    success: true,
    token: session.accessToken,
    refreshToken: session.refreshToken,
    user: user.toSafeObject(),
  });
});

/** POST /api/auth/logout — revokes the presented refresh token. */
const logout = asyncHandler(async (req, res) => {
  const presented = presentedRefreshToken(req);
  if (presented) {
    const record = await RefreshToken.findActive(presented);
    if (record) await record.revoke();
  }
  clearRefreshCookie(res);
  res.json({ success: true, message: 'Signed out.' });
});

/** POST /api/auth/logout-all — revokes every session for the caller. */
const logoutAll = [
  asyncHandler(async (req, res) => {
    const count = await RefreshToken.revokeAllFor(req.user.id);
    clearRefreshCookie(res);
    res.json({ success: true, message: `Signed out of ${count} session(s).` });
  }),
];

module.exports = {
  register, login, loginThrottled, getMe, updateProfile, changePassword,
  refresh, logout, logoutAll,
};