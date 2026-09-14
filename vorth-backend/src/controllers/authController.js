const { body } = require('express-validator');
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const throwIfInvalid = require('../utils/validate');
const generateToken = require('../utils/generateToken');
const User = require('../models/User');
const env = require('../config/env');

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

    const existing = await User.findOne({ $or: [{ username }, { email }] });
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

    const token = generateToken(user);
    res.status(201).json({ success: true, token, user: user.toSafeObject() });
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
    }).select('+password');

    // Same generic message whether the account or the password was wrong,
    // so login attempts can't be used to enumerate valid usernames/emails.
    if (!user || !(await user.comparePassword(password))) {
      throw ApiError.unauthorized('Incorrect username/email or password.');
    }
    if (user.isBanned) throw ApiError.forbidden('This account has been suspended.');

    user.lastLoginAt = new Date();
    await user.save();

    const token = generateToken(user);
    res.json({ success: true, token, user: user.toSafeObject() });
  }),
];

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
    const user = await User.findById(req.user.id).select('+password');
    if (!(await user.comparePassword(currentPassword))) {
      throw ApiError.unauthorized('Current password is incorrect.');
    }
    user.password = newPassword;
    await user.save();
    res.json({ success: true, message: 'Password updated.' });
  }),
];

module.exports = { register, login, getMe, updateProfile, changePassword };
