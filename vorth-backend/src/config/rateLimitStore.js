const env = require('./env');

/**
 * Rate-limit counters.
 *
 * 'memory' is the default and needs no extra infrastructure, but it resets on
 * every deploy and is per-process — useless behind more than one instance.
 * 'postgres' keeps counters in a table, which fixes both problems at the cost
 * of one small query per request.
 *
 * Both implement the express-rate-limit Store contract:
 *   init(options), increment(key), decrement(key), resetKey(key), resetAll()
 * and `increment` resolves to { totalHits, resetTime }.
 */

class BaseStore {
  constructor() { this.windowMs = 60_000; }

   
  init(options = {}) {
    if (options.windowMs) this.windowMs = options.windowMs;
  }
}

class MemoryStore extends BaseStore {
  constructor() { super(); this.buckets = new Map(); }

  async increment(key) {
    const now = Date.now();
    let bucket = this.buckets.get(key);
    if (!bucket || bucket.resetTime <= now) {
      bucket = { totalHits: 0, resetTime: now + this.windowMs };
      this.buckets.set(key, bucket);
    }
    bucket.totalHits += 1;
    return { totalHits: bucket.totalHits, resetTime: new Date(bucket.resetTime) };
  }

  /** Used by skipSuccessfulRequests. */
  async decrement(key) {
    const bucket = this.buckets.get(key);
    if (bucket && bucket.totalHits > 0) bucket.totalHits -= 1;
  }

  async resetKey(key) { this.buckets.delete(key); }
  async resetAll() { this.buckets.clear(); }
  async shutdown() { this.buckets.clear(); }
}

class PostgresStore extends BaseStore {
  async increment(key) {
    const db = require('./db');
    const windowSeconds = Math.max(1, Math.round(this.windowMs / 1000));
    // One statement bumps the counter and returns the new total, so concurrent
    // requests cannot lose an increment to a read-then-write race.
    const { rows } = await db.pool.query(
      `INSERT INTO "rate_limit_buckets" ("bucket", "hits", "window_started_at")
       VALUES ($1, 1, now())
       ON CONFLICT ("bucket") DO UPDATE
         SET "hits" = CASE
               WHEN "rate_limit_buckets"."window_started_at"
                    < now() - make_interval(secs => $2)
                 THEN 1
               ELSE "rate_limit_buckets"."hits" + 1
             END,
             "window_started_at" = CASE
               WHEN "rate_limit_buckets"."window_started_at"
                    < now() - make_interval(secs => $2)
                 THEN now()
               ELSE "rate_limit_buckets"."window_started_at"
             END
       RETURNING "hits", now() + make_interval(secs => $2) AS "reset_at"`,
      [key, windowSeconds]
    );
    const row = rows[0];
    return { totalHits: row.hits, resetTime: new Date(row.reset_at) };
  }

  async decrement(key) {
    const db = require('./db');
    await db.pool.query(
      'UPDATE "rate_limit_buckets" SET "hits" = GREATEST("hits" - 1, 0) WHERE "bucket" = $1',
      [key]
    );
  }

  async resetKey(key) {
    const db = require('./db');
    await db.pool.query('DELETE FROM "rate_limit_buckets" WHERE "bucket" = $1', [key]);
  }

  async resetAll() {
    const db = require('./db');
    await db.pool.query('DELETE FROM "rate_limit_buckets"');
  }

  async shutdown() { /* the pool is owned by the app, not by this store */ }
}

function createRateLimitStore(driver = env.rateLimitStore) {
  return driver === 'postgres' ? new PostgresStore() : new MemoryStore();
}

module.exports = { createRateLimitStore, MemoryStore, PostgresStore, BaseStore };