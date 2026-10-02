const Base = require('./_base');

/**
 * Refresh tokens for long-lived sessions.
 *
 * Only the SHA-256 hash of each token is stored. On refresh the presented
 * token is looked up by hash, revoked, and replaced — so a stolen refresh
 * token is single-use, and replaying an old one after rotation is detectable
 * via `replacedBy`.
 */
class RefreshToken extends Base {
  static table = 'refresh_tokens';

  static async issue(userId, { userAgent, ip, days, expiresAt } = {}) {
    const { generateToken, hashToken } = require('../utils/tokens');
    const token = generateToken();
    const expiry = expiresAt || new Date(Date.now() + (days || 30) * 86400000);
    const row = await this.create({
      user: userId,
      tokenHash: hashToken(token),
      userAgent: (userAgent || '').slice(0, 255) || null,
      ip: (ip || '').slice(0, 64) || null,
      expiresAt: expiry,
    });
    return { token, record: row, expiresAt: expiry };
  }

  /** The active (not revoked, not expired) token for a presented value. */
  static async findActive(rawToken) {
    const { hashToken } = require('../utils/tokens');
    const row = await this.findOne({
      tokenHash: hashToken(rawToken),
      revokedAt: null,
    }).exec();
    if (!row) return null;
    if (new Date(row.expiresAt).getTime() <= Date.now()) return null;
    return row;
  }

  async revoke() {
    this.revokedAt = new Date();
    await this.save();
  }

  /** Revokes every live token for a user (sign out everywhere, password change). */
  static async revokeAllFor(userId) {
    const { rowCount } = await require('../config/db').pool.query(
      `UPDATE "refresh_tokens" SET "revoked_at" = now()
        WHERE "user" = $1 AND "revoked_at" IS NULL`,
      [userId]
    );
    return rowCount;
  }

  /** Housekeeping: drop tokens that expired more than a week ago. */
  static async pruneExpired(days = 7) {
    const { rowCount } = await require('../config/db').pool.query(
      `DELETE FROM "refresh_tokens" WHERE "expires_at" < now() - ($1 || ' days')::interval`,
      [String(days)]
    );
    return rowCount;
  }
}

module.exports = RefreshToken;