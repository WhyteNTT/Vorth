'use strict';

/**
 * aggregate() grouping.
 *
 * Grouping used to be hardcoded to `series` and a pipeline with no $group only
 * worked on comments. Both restrictions are gone: any column, any table, a
 * compound key, or no grouping at all.
 *
 * Also covers a bug the generalisation surfaced: sorting grouped results by
 * `_id` compiled to ORDER BY "_id", and "_id" is not a column in any table, so
 * the database rejected the statement.
 */

process.env.DATABASE_URL ||= 'postgres://stub/stub';
process.env.DATABASE_SSL = 'false';
process.env.JWT_SECRET ||= 'test-secret';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createFakePool, withPool } = require('./helpers/fakePool');

const Comment = require('../src/models/Comment');
const Series = require('../src/models/Series');

const run = (opts, fn) => withPool(createFakePool(opts), fn);

/** The last SELECT the model issued, ignoring schema lookups. */
const lastSelect = (pool) => pool.log.filter(
  (e) => e.verb === 'SELECT' && !/information_schema/.test(e.sql)
).at(-1);

test('groups by any single column, not just series', async () => {
  await run({ rows: {} }, async (pool) => {
    await Comment.aggregate([
      { $match: { isRemoved: false } },
      { $group: { _id: '$user', count: { $sum: 1 } } },
    ]);
    const sql = lastSelect(pool).sql;
    assert.match(sql, /"user" AS "_id"/);
    assert.match(sql, /GROUP BY "user"/);
    assert.ok(!/GROUP BY "series"/.test(sql));
  });
});

test('groups by a column on a table other than comments', async () => {
  // The old code refused aggregate() without $group on any table but comments,
  // and hardcoded the rating rollup. Both applied to $group too.
  await run({ rows: {} }, async (pool) => {
    await Series.aggregate([
      { $match: { isRemoved: false } },
      { $group: { _id: '$type', total: { $sum: '$chapterCount' } } },
    ]);
    const sql = lastSelect(pool).sql;
    assert.match(sql, /FROM "series"/);
    assert.match(sql, /"type" AS "_id"/);
    assert.match(sql, /GROUP BY "type"/);
    assert.match(sql, /COALESCE\(SUM\("chapter_count"\), 0\) AS "total"/);
  });
});

test('groups by a compound key and returns it as an object', async () => {
  await run({ rows: { comments: [
    { series: 's1', user: 'u1', count: 2 },
    { series: 's2', user: 'u2', count: 5 },
  ] } }, async (pool) => {
    const out = await Comment.aggregate([
      { $group: { _id: { series: '$series', user: '$user' }, count: { $sum: 1 } } },
    ]);
    const sql = lastSelect(pool).sql;
    assert.match(sql, /GROUP BY "series", "user"/);
    // The parts are selected, not concatenated into one string.
    assert.match(sql, /"series" AS "series"/);
    assert.match(sql, /"user" AS "user"/);

    // ...and reassembled into a nested _id, matching Mongo's shape.
    assert.deepEqual(out, [
      { _id: { series: 's1', user: 'u1' }, count: 2 },
      { _id: { series: 's2', user: 'u2' }, count: 5 },
    ]);
    // The flat parts must not leak alongside the assembled key.
    assert.ok(!('series' in out[0]), 'the flat part leaked into the result');
    assert.ok(!('user' in out[0]), 'the flat part leaked into the result');
  });
});

test('a compound key can be renamed in the _id document', async () => {
  await run({ rows: { comments: [{ book: 's1', reader: 'u1', count: 1 }] } }, async () => {
    const out = await Comment.aggregate([
      { $group: { _id: { book: '$series', reader: '$user' }, count: { $sum: 1 } } },
    ]);
    assert.deepEqual(out, [{ _id: { book: 's1', reader: 'u1' }, count: 1 }]);
  });
});

test('no grouping applies the declared accumulators on any table', async () => {
  await run({ rows: { series: [{ is_removed: false, total: 7, worst: 2 }] } }, async (pool) => {
    const out = await Series.aggregate([
      { $match: { isRemoved: false } },
      { $group: { _id: null, total: { $sum: '$chapterCount' }, worst: { $min: '$ratingAvg' } } },
    ]);
    const sql = lastSelect(pool).sql;
    assert.match(sql, /COALESCE\(SUM\("chapter_count"\), 0\) AS "total"/);
    assert.match(sql, /MIN\("rating_avg"\) AS "worst"/);
    assert.ok(!/GROUP BY/.test(sql), 'no grouping should emit no GROUP BY');
    // Asserted field by field rather than deepEqual: the recording double
        // returns the whole canned row, while PostgreSQL would return only the
        // selected aggregates. The $project test below pins the shape exactly.
        assert.equal(out.length, 1);
        assert.equal(out[0]._id, null, 'an ungrouped result has no key');
        assert.equal(out[0].total, 7);
        assert.equal(out[0].worst, 2);
  });
});

test('a pipeline with no grouping and no accumulator is refused', () => {
  // An empty SELECT would otherwise compile to invalid SQL.
  assert.rejects(
    () => Comment.aggregate([{ $match: { isRemoved: false } }]),
    /at least one accumulator/
  );
});

test('sorting by _id sorts by the underlying column', async () => {
  // This compiled to ORDER BY "_id", which no table has. The database would
  // have rejected the statement; nothing exercised it before.
  await run({ rows: {} }, async (pool) => {
    await Comment.aggregate([
      { $group: { _id: '$series', count: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]);
    const sql = lastSelect(pool).sql;
    assert.match(sql, /ORDER BY "series" ASC NULLS LAST/);
    assert.ok(!/ORDER BY "_id"/.test(sql), 'the alias was sent to the database');
  });
});

test('sorting by a compound key part works, and by an accumulator works', async () => {
  await run({ rows: {} }, async (pool) => {
    await Comment.aggregate([
      { $group: { _id: { series: '$series', user: '$user' }, count: { $sum: 1 } } },
      { $sort: { user: -1, count: 1 } },
    ]);
    const sql = lastSelect(pool).sql;
    assert.match(sql, /ORDER BY "user" DESC NULLS LAST, "count" ASC NULLS LAST/);
  });
});

test('sorting by something outside the group output is still refused', async () => {
  await assert.rejects(
    () => Comment.aggregate([
      { $group: { _id: '$series', count: { $sum: 1 } } },
      { $sort: { text: 1 } },
    ]),
    /cannot sort by "text"/
  );
  // A compound key's parts are the only extra sortable names.
  await assert.rejects(
    () => Comment.aggregate([
      { $group: { _id: { series: '$series', user: '$user' }, count: { $sum: 1 } } },
      { $sort: { rating: 1 } },
    ]),
    /cannot sort by "rating"/
  );
});

test('an ungrouped pipeline still supports paging and projection', async () => {
  await run({ rows: { series: [{ is_removed: false, total: 9, junk: 1 }] } }, async () => {
    const out = await Series.aggregate([
      { $group: { _id: null, total: { $sum: '$chapterCount' } } },
      { $skip: 0 },
      { $limit: 10 },
      { $project: { grand: '$total', junk: 0 } },
    ]);
    assert.deepEqual(out, [{ grand: 9 }]);
  });
});

test('malformed group keys are refused with an explanation', async () => {
  const cases = [
    [[{ $group: { _id: 'series' } }], /must be a field reference/],
    [[{ $group: { _id: { a: 'series' } } }], /must be a field reference/],
    [[{ $group: { _id: {} } }], /document is empty/],
    [[{ $group: { _id: '$' } }], /is empty/],
    [[{ $group: { _id: 42 } }], /must be a field reference/],
    [[{ $group: { _id: '$series', n: { $push: '$rating' } } }], /unsupported accumulator/],
    [[{ $group: { _id: '$series', n: { $avg: 'rating' } } }], /must reference a field/],
  ];
  for (const [pipeline, expected] of cases) {
    await assert.rejects(() => Comment.aggregate(pipeline), expected, JSON.stringify(pipeline));
  }
});

test('stage ordering is still enforced', async () => {
  await assert.rejects(
    () => Comment.aggregate([{ $limit: 5 }, { $match: { series: 's1' } }]),
    /must be ordered/
  );
  await assert.rejects(
    () => Comment.aggregate([{ $unwind: '$text' }]),
    /unsupported stage/
  );
});