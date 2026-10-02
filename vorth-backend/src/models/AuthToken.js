const Base = require('./_base');

/**
 * Single-use tokens for email verification and password reset.
 *
 * `consumedAt` makes them one-shot; `expiresAt` bounds the window. Only the
 * hash is stored, so a leaked table cannot be used to take over accounts.
 */
class AuthToken extends Base {
  static table = 'auth_tokens';

  static async issue(userId, purpose, hours) {
    const { generateToken, hashToken } = require('../utils/tokens');
    const token = generateToken();
    const expiresAt = new Date(Date.now() + hours * 3600000);
    const row = await this.create({
      user: userId,
      purpose,
      tokenHash: hashToken(token),
      expiresAt,
    });
    return { token, record: row, expiresAt };
  }

  /** Consumes a token if it is unexpired, unused and for the given purpose. */
  static async consume(rawToken, purpose) {
    const { hashToken } = require('../utils/tokens');
    const db = require('../config/db');

    // Atomic: the WHERE clause is the guard, so two concurrent redemptions of
    // the same token cannot both succeed.
    const { rows } = await db.pool.query(
      `UPDATE "auth_tokens" SET "consumed_at" = now()
        WHERE "token_hash" = $1 AND "purpose" = $2
          AND "consumed_at" IS NULL AND "expires_at" > now()
        RETURNING *`,
      [hashToken(rawToken), purpose]
    );
    return rows[0] ? this._hydrate(Base._mapRow(rows[0])) : null;
  }

  /** Invalidates any outstanding tokens of a kind (e.g. issue a new reset link). */
  static async invalidateAll(userId, purpose) {
    const db = require('../config/db');
    const { rowCount } = await db.pool.query(
      `UPDATE "auth_tokens" SET "consumed_at" = now()
        WHERE "user" = $1 AND "purpose" = $2 AND "consumed_at" IS NULL`,
      [userId, purpose]
    );
    return rowCount;
  }

  static async pruneExpired(days = 7) {
    const db = require('../config/db');
    const { rowCount } = await db.pool.query(
      `DELETE FROM "auth_tokens" WHERE "expires_at" < now() - ($1 || ' days')::interval`,
      [String(days)]
    );
    return rowCount;
  }
}

module.exports = AuthToken;