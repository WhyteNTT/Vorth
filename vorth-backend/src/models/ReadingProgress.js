const Base = require('./_base');

class ReadingProgress extends Base {
  static table = 'reading_progress';

  /** UNIQUE(user, series) — the natural upsert conflict target. */
  static _defaultConflict() { return ['user', 'series']; }
}

module.exports = ReadingProgress;