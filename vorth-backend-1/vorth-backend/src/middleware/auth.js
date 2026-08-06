const jwt = require('jsonwebtoken');
const env = require('../config/env');
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const User = require('../models/User');

// Requires a valid Bearer token. Attaches the full user document (minus
// password) to req.user, and rejects banned accounts.
const protect = asyncHandler(async (req, res, next) => {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    throw ApiError.unauthorized('You must be signed in to do this.');
  }
  const token = header.split(' ')[1];

  let payload;
  try {
    payload = jwt.verify(token, env.jwtSecret);
  } catch (err) {
    throw ApiError.unauthorized('Your session is invalid or has expired. Please sign in again.');
  }

  const user = await User.findById(payload.id);
  if (!user) throw ApiError.unauthorized('The account for this session no longer exists.');
  if (user.isBanned) throw ApiError.forbidden('This account has been suspended.');

  req.user = user;
  next();
});

// Attaches req.user if a valid token is present, but never blocks the
// request — for endpoints that behave differently for logged-in users
// without requiring login (e.g. personalized recommendations later).
const optionalAuth = asyncHandler(async (req, res, next) => {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return next();
  try {
    const payload = jwt.verify(header.split(' ')[1], env.jwtSecret);
    const user = await User.findById(payload.id);
    if (user && !user.isBanned) req.user = user;
  } catch (err) {
    // invalid/expired token on an optional route — just proceed as a guest
  }
  next();
});

function restrictTo(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return next(ApiError.forbidden('You do not have permission to perform this action.'));
    }
    next();
  };
}

module.exports = { protect, optionalAuth, restrictTo };
