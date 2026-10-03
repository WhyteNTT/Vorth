'use strict';

/**
 * aggregate() against real SQL.
 *
 * The recording double cannot tell you whether the generated statement is legal.
 * Two things here only a database can settle:
 *
 *   - sorting by `_id` used to compile to ORDER BY "_id", and "_id" is not a
 *     column in any table. The double happily recorded it.
 *   - a compound GROUP BY is two columns, and reassembling it into a nested
 *     object is JavaScript, not SQL.
 */

process.env.DATABASE_URL ||= 'postgresql://vorth:vorth@127.0.0.1:5432/vorth_test';
process.env.DATABASE_SSL = 'false';
process.env.JWT_SECRET ||= 'live-secret';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const { pool, connectDB } = require('../src/config/db');
const Series = require('../src/models/Series');
const Comment = require('../src/models/Comment');
const User = require('../src/models/User');

const MARK = `agg${Date.now().toString(36)}`;

async function withDb(fn) {
  try {
    await connectDB();
    await fn();
  } finally {
    await pool.end();
  }
}

test('aggregate() groups, sorts and reassembles against real SQL', { skip: !process.env.VORTH_LIVE_DB }, () =>
  withDb(async () => {
    const owner = await User.create({
      displayName: 'Agg', username: MARK, email: `${MARK}@example.test`,
      password: 'correct horse battery',
      agreedToTermsAt: new Date(), ageConfirmed: true,
    });

    const a = await Series.create({
      title: `${MARK} Alpha`, type: 'novel', owner: owner.id, author: 'A',
      synopsis: 'x', genres: ['Fantasy'], tags: [], rightsAttestedAt: new Date(),
    });
    const b = await Series.create({
      title: `${MARK} Beta`, type: 'comic', owner: owner.id, author: 'B',
      synopsis: 'y', genres: ['Sci-Fi'], tags: [], rightsAttestedAt: new Date(),
    });

    // One at a time: create() takes a single document, not an array.
    for (const c of [
      { series: a.id, rating: 5, text: 'good' },
      { series: a.id, rating: 3, text: 'ok' },
      { series: b.id, rating: 4, text: 'fine' },
    ]) {
      await Comment.create(Object.assign({ user: owner.id }, c));
    }

    /* --- group by an arbitrary column on a non-comments table ---------- */
    const byType = await Series.aggregate([
      { $match: { owner: owner.id } },
      { $group: { _id: '$type', count: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]);
    assert.equal(byType.length, 2, `expected two type buckets, got ${JSON.stringify(byType)}`);
    assert.deepEqual(
      byType.map((r) => r._id).sort(),
      ['comic', 'novel'],
      'sorting by _id must order by the underlying column'
    );

    /* --- sorting by _id descending puts the later value first ---------- */
    const desc = await Series.aggregate([
      { $match: { owner: owner.id } },
      { $group: { _id: '$type', count: { $sum: 1 } } },
      { $sort: { _id: -1 } },
    ]);
    assert.equal(desc[0]._id, 'novel', 'DESC on _id did not reach the database');

    /* --- compound key comes back nested -------------------------------- */
    const compound = await Comment.aggregate([
      { $group: { _id: { series: '$series', user: '$user' }, count: { $sum: 1 } } },
    ]);
    assert.equal(compound.length, 2);
    for (const row of compound) {
      assert.equal(typeof row._id, 'object', 'a compound _id must be an object');
      assert.ok(row._id.series, 'the series part is missing');
      assert.ok(row._id.user, 'the user part is missing');
      assert.ok(!('series' in row), 'the flat part leaked alongside the nested key');
      assert.ok(!('user' in row), 'the flat part leaked alongside the nested key');
    }
    const counts = compound.map((r) => r.count).sort();
    assert.deepEqual(counts, [1, 2], `unexpected per-group counts: ${JSON.stringify(compound)}`);

    /* --- ungrouped rollup on a non-comments table ---------------------- */
    const rollup = await Series.aggregate([
      { $match: { owner: owner.id } },
      { $group: { _id: null, total: { $sum: '$chapterCount' } } },
    ]);
    assert.equal(rollup.length, 1);
    assert.equal(rollup[0]._id, null);
    assert.equal(Number(rollup[0].total), 0, 'no chapters yet, so the sum is zero');

    /* --- the original rating rollup still works ------------------------ */
    const stats = await Comment.aggregate([
      { $match: { series: a.id, isRemoved: false } },
      { $group: { _id: '$series', avg: { $avg: '$rating' }, count: { $sum: 1 } } },
    ]);
    assert.equal(stats.length, 1);
    assert.equal(Number(stats[0].avg), 4);
    assert.equal(Number(stats[0].count), 2);

    /* --- paging and projection compose on the ungrouped path ----------- */
    const projected = await Series.aggregate([
      { $match: { owner: owner.id } },
      { $group: { _id: null, total: { $sum: '$chapterCount' } } },
      { $project: { grand: '$total' } },
    ]);
    assert.deepEqual(projected, [{ grand: 0 }]);

    /* --- clean up in dependency order ---------------------------------- */
    await Comment.deleteMany({ series: { $in: [a.id, b.id] } });
    await Series.deleteMany({ id: { $in: [a.id, b.id] } });
    await User.deleteMany({ username: MARK });
  }));