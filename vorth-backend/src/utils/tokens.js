const crypto = require('crypto');

/**
 * Opaque random tokens, stored only as SHA-256 hashes.
 *
 * Storing the hash means a database dump cannot be replayed as valid
 * sessions or password-reset links — the attacker would need the plaintext,
 * which only ever existed in the emailed link.
 */
const TOKEN_BYTES = 32;

function generateToken() {
  return crypto.randomBytes(TOKEN_BYTES).toString('base64url');
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

/** Constant-time comparison, for anywhere a raw token is compared. */
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function randomId() {
  return crypto.randomUUID();
}

module.exports = { generateToken, hashToken, safeEqual, randomId, TOKEN_BYTES };