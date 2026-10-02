const rateLimit = require('express-rate-limit');
const env = require('../config/env');
const { createRateLimitStore } = require('../config/rateLimitStore');

/**
 * Each limiter gets its own store instance. express-rate-limit keeps per-limiter
 * state inside the store, so sharing one would mix the general and auth budgets.
 */
function limiterFor(options) {
  return rateLimit({ ...options, store: createRateLimitStore(env.rateLimitStore) });
}

if (env.rateLimitStore === 'postgres') {
  console.log('[rate-limit] using the shared PostgreSQL store');
}

const generalLimiter = limiterFor({
  windowMs: env.rateLimitWindowMinutes * 60 * 1000,
  max: env.rateLimitMaxRequests,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.ip,
  message: { success: false, message: 'Too many requests. Please slow down and try again shortly.' },
});

// Tighter limit on auth routes to slow down credential-stuffing / brute force.
// Keyed by IP *and* the submitted identifier so one attacker cannot lock out an
// entire NAT, and one account cannot be sprayed from many hosts.
const authLimiter = limiterFor({
  windowMs: env.rateLimitWindowMinutes * 60 * 1000,
  max: env.authRateLimitMaxRequests,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const body = req.body || {};
    const identifier = body.identifier || body.email || body.username;
    return identifier ? `${req.ip}|${String(identifier).toLowerCase()}` : String(req.ip);
  },
  message: { success: false, message: 'Too many attempts. Please wait before trying again.' },
});

// Per-account throttle. Successful logins are not counted, so a legitimate
// user who signs in repeatedly is never locked out by their own activity.
const loginAttemptLimiter = limiterFor({
  windowMs: env.rateLimitWindowMinutes * 60 * 1000,
  max: env.authRateLimitMaxRequests,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  keyGenerator: (req) => {
    const identifier = req.body && req.body.identifier;
    return identifier ? `acct|${String(identifier).toLowerCase()}` : `acct|${req.ip}`;
  },
  message: { success: false, message: 'Too many failed sign-in attempts for this account.' },
});

module.exports = { generalLimiter, authLimiter, loginAttemptLimiter };