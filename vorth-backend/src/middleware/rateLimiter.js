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

/**
 * DMCA intake.
 *
 * Both the takedown notice and the counter-notice are unauthenticated and
 * unauthenticated endpoints that send email to a third party, which makes them
 * a cheap way to get this deployment to send mail to arbitrary addresses. The
 * general limit is far too loose for that.
 *
 * Keyed by IP *and* the target report id, so one client cannot spray a
 * thousand different reports, and one report cannot be spammed from many hosts.
 */
const dmcaLimiter = limiterFor({
  windowMs: env.rateLimitWindowMinutes * 60 * 1000,
  max: env.dmcaRateLimitMaxRequests,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const target = (req.params && req.params.id) || 'new';
    return `dmca|${req.ip}|${String(target).toLowerCase()}`;
  },
  message: {
    success: false,
    message: 'Too many DMCA submissions. Please wait before trying again.',
  },
});

/**
 * Uploads.
 *
 * The only authenticated route class that writes unbounded user-controlled bytes
 * to disk in a single request: up to 60 images at MAX_UPLOAD_MB each, which is
 * 480 MB. The general limiter budgets requests, and every other route spends at
 * most a few hundred bytes of disk per request, so 300 requests per window was
 * affordable everywhere except here.
 *
 * Keyed by IP like the general limiter rather than by account: req.user is not
 * populated when a middleware on the router runs, so an account key would need the
 * lookup moved after `protect`. Per-account limiting is the better answer and is
 * recorded as a known gap in test/rateLimitAudit.test.js, which asserts the key
 * so the change is made deliberately.
 *
 * The floor is 3 per window rather than 1: a chapter is uploaded as many page
 * images, and someone correcting a mistake or re-uploading after a failed page
 * should not have to wait out the window.
 */
const uploadLimiter = limiterFor({
  windowMs: env.rateLimitWindowMinutes * 60 * 1000,
  max: env.uploadRateLimitMaxRequests,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `upload|${req.ip}`,
  message: {
    success: false,
    message: 'Too many uploads. Please wait before trying again.',
  },
});

module.exports = {
  generalLimiter, authLimiter, loginAttemptLimiter, dmcaLimiter, uploadLimiter,
};