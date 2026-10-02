const slugify = require('slugify');
const crypto = require('crypto');
const Base = require('./_base');

class Series extends Base {
  static table = 'series';
  static json = ['genres', 'tags', 'views'];

  /**
   * Slugs are unique. Two series can legitimately share a title, so a
   * collision is resolved by retrying with a short suffix rather than
   * failing — but only the slug violation is retried; every other error
   * propagates.
   */
  static async create(data) {
    const payload = { ...data };
    const base = payload.slug
      || slugify(payload.title || '', { lower: true, strict: true })
      || 'untitled';

    let attempt = 0;
    for (;;) {
      const candidate = attempt === 0 ? base : `${base}-${attempt}-${crypto.randomBytes(3).toString('hex')}`;
      try {
        return await super.create({ ...payload, slug: candidate });
      } catch (err) {
        const slugConflict = err && err.code === '23505' && /slug/.test(String(err.detail || err.message));
        if (!slugConflict || attempt >= 4) throw err;
        attempt += 1;
      }
    }
  }

  /**
   * Atomically reserves the next chapter number.
   *
   * The old implementation read `chapterCount` in JavaScript and added one,
   * which meant two concurrent creators both computed the same number and one
   * INSERT lost to UNIQUE(series, num). Letting the database do the
   * increment means the counter can never be read stale.
   */
  static async nextChapterNumber(seriesId, client) {
    const db = require('../config/db');
    const exec = client || db.pool;
    const { rows } = await exec.query(
      `UPDATE "series" SET "chapter_count" = "chapter_count" + 1, "updated_at" = now()
        WHERE "id" = $1 RETURNING "chapter_count"`,
      [seriesId]
    );
    if (!rows[0]) throw new Error(`Series ${seriesId} not found`);
    return rows[0].chapter_count;
  }
}

module.exports = Series;