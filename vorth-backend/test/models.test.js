'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createFakePool, withPool, seedRow } = require('./helpers/fakePool');

process.env.DATABASE_URL ||= 'postgres://stub/stub';
process.env.DATABASE_SSL = 'false';
process.env.JWT_SECRET ||= 'test-secret';

const Comment = require('../src/models/Comment');
const Series = require('../src/models/Series');
const Notification = require('../src/models/Notification');
const User = require('../src/models/User');

/** run({ rows: {...} }, async (pool) => { ... }) */
const run = (opts, fn) => withPool(createFakePool(opts), fn);

/**
 * The recorded statements of one kind, in order, excluding bookkeeping.
 *
 * Models look their table's column list up before building SQL, so the log
 * opens with an information_schema query that is not part of what any of these
 * tests are asserting about. Filtering it out here means an assertion can say
 * "the SELECT" without caring how many lookups precede it.
 */
const statementsOf = (pool, verb) => pool.log.filter(
  (e) => e.verb === verb && !/information_schema/.test(e.sql)
);

/* ------------------------------------------------------------------ *
 * Regression: the old shim loaded whole tables and filtered in JS.
 * ------------------------------------------------------------------ */
test('find() pushes filtering, sorting and paging into SQL', async () => {
  await run({ rows: { series: [] } }, async (pool) => {
    await Series.find({ isRemoved: false })
      .sort({ createdAt: -1 })
      .skip(48)
      .limit(24)
      .populate('owner', 'username displayName')
      .exec();

    const select = statementsOf(pool, 'SELECT').at(-1);
    assert.match(select.sql, /WHERE/);
    assert.match(select.sql, /ORDER BY "created_at" DESC/);
    assert.match(select.sql, /LIMIT \$2 OFFSET \$3/);
    assert.equal(select.params[1], 24);
    assert.equal(select.params[2], 48);
  });
});

test('populate batches into one query per path, not one per row', async () => {
  const rows = Array.from({ length: 25 }, (_, i) =>
    seedRow('series', { id: `s${i}`, owner: `u${i % 5}`, is_removed: false }));
  await run({ rows: { series: rows, users: [seedRow('users', { id: 'u0' })] } }, async (pool) => {
    await Series.find({ isRemoved: false }).populate('owner', 'username').exec();
    const userQueries = pool.log.filter((e) => /FROM "users"/.test(e.sql));
    assert.equal(userQueries.length, 1, 'expected a single batched lookup, got ' + userQueries.length);
    assert.ok(Array.isArray(userQueries[0].params[0]), 'ids are passed as one array parameter');
  });
});

test('countDocuments uses COUNT(*) with the same predicate', async () => {
  await run({ rows: {}, countRows: [1, 2] }, async (pool) => {
    const total = await Series.countDocuments({ isRemoved: false });
    assert.equal(total, 2);
    assert.match(statementsOf(pool, 'SELECT').at(-1).sql, /SELECT COUNT\(\*\)::int AS count FROM "series" WHERE/);
  });
});

/* ------------------------------------------------------------------ *
 * Regression: save() after populate() used to emit a JS object into a
 * uuid column (invalid input syntax for type uuid).
 * ------------------------------------------------------------------ */
test('save() after populate() never writes the populated document', async () => {
  await run({ rows: { comments: [seedRow('comments', { id: 'c1', user: 'u1' })], users: [seedRow('users', { id: 'u1', username: 'alice' })] } },
    async (pool) => {
      const comment = await Comment.findById('c1');
      await comment.populate('user', 'username displayName');

      assert.equal(typeof comment.user, 'object', 'populate should be readable');
      comment.isRemoved = true;
      await comment.save();

      const update = pool.log.find((e) => e.verb === 'UPDATE');
      assert.ok(update, 'expected an UPDATE');
      // Only the columns actually assigned may appear in the SET list.
      assert.equal(update.sql.match(/SET/g).length, 1);
      assert.match(update.sql, /SET "is_removed" = \$1/);
      assert.ok(!/"user"=/.test(update.sql), 'populated user must not be written');
      assert.deepEqual(update.params.slice(0, 1), [true]);
    });
});

test('save() is a no-op when nothing changed', async () => {
  await run({ rows: { comments: [seedRow('comments', { id: 'c1' })] } }, async (pool) => {
    const comment = await Comment.findById('c1');
    await comment.save();
    assert.equal(pool.log.filter((e) => e.verb === 'UPDATE').length, 0);
  });
});

test('save() writes only the dirty columns', async () => {
  await run({ rows: { series: [seedRow('series', { id: 's1', title: 'Old', synopsis: 'Keep' })] }, echoRow: { id: 's1' } },
    async (pool) => {
      const series = await Series.findById('s1');
      series.title = 'New';
      await series.save();
      const update = pool.log.find((e) => e.verb === 'UPDATE');
      assert.match(update.sql, /SET "title" = \$1, "updated_at" = now\(\)/);
      assert.ok(!update.sql.includes('synopsis'));
    });
});

/* ------------------------------------------------------------------ *
 * Regression: deleteMany() ignored its filter and emptied the table.
 * ------------------------------------------------------------------ */
test('deleteMany() honours its filter', async () => {
  await run({ rows: {} }, async (pool) => {
    await Comment.deleteMany({ series: 's1' });
    const del = pool.log.find((e) => e.verb === 'DELETE');
    assert.equal(del.sql, 'DELETE FROM "comments" WHERE ("series" = $1)');
    assert.deepEqual(del.params, ['s1']);
  });
});

test('deleteMany() with no filter is explicit about being a full wipe', async () => {
  await run({ rows: {} }, async (pool) => {
    await Comment.deleteMany();
    assert.equal(statementsOf(pool, 'DELETE')[0].sql, 'DELETE FROM "comments"');
  });
});

/* ------------------------------------------------------------------ *
 * Regression: updateMany issued one UPDATE per row, rewriting every
 * column each time.
 * ------------------------------------------------------------------ */
test('updateMany() is a single statement with the predicate', async () => {
  await run({ rows: { notifications: [] } }, async (pool) => {
    await Notification.updateMany({ user: 'u1', isRead: false }, { $set: { isRead: true } });
    assert.equal(statementsOf(pool, 'UPDATE').length, 1);
    const update = statementsOf(pool, 'UPDATE')[0];
    assert.match(update.sql, /UPDATE "notifications" SET "is_read" = \$1 WHERE/);
    assert.deepEqual(update.params, [true, 'u1', false]);
  });
});

test('updateMany() supports dotted jsonb paths via jsonb_set', async () => {
  await run({ rows: { series: [] } }, async (pool) => {
    await Series.updateMany({}, { $set: { 'views.daily': 0, lastDailyReset: new Date(0) } });
    assert.match(statementsOf(pool, 'UPDATE')[0].sql, /"views" = jsonb_set\(/);
  });
});

/* ------------------------------------------------------------------ *
 * Regression: upsert did INSERT then a second UPDATE.
 * ------------------------------------------------------------------ */
test('findOneAndUpdate with upsert is one INSERT ... ON CONFLICT', async () => {
  const ReadingProgress = require('../src/models/ReadingProgress');
  await run({ rows: { reading_progress: [] } }, async (pool) => {
    await ReadingProgress.findOneAndUpdate(
      { user: 'u1', series: 's1' },
      { $set: { chapter: 'c1', type: 'novel' } },
      { upsert: true, new: true }
    );
    const writes = pool.log.filter((e) => ['INSERT', 'UPDATE'].includes(e.verb));
    assert.equal(writes.length, 1, 'expected exactly one write');
    assert.equal(writes[0].verb, 'INSERT');
    assert.match(writes[0].sql, /ON CONFLICT \("user", "series"\) DO UPDATE SET/);
  });
});

/* ------------------------------------------------------------------ *
 * Regression: GET /api/admin/users returned bcrypt hashes because rows
 * were serialised without going through toSafeObject().
 * ------------------------------------------------------------------ */
test('toJSON strips the password hash', async () => {
  await run({ rows: { users: [seedRow('users', { id: 'u1', password: '$2b$12$REALHASH' })] } }, async () => {
    const user = await User.findById('u1');
    assert.equal(user.password, '$2b$12$REALHASH', 'the model still has it internally');
    assert.equal(user.toJSON().password, undefined);
    assert.equal(user.toSafeObject().password, undefined);
    assert.equal(JSON.stringify(user).includes('REALHASH'), false,
      'serialising a user must never include the hash');
  });
});

test('toJSON does not leak internal bookkeeping keys', async () => {
  await run({ rows: { users: [seedRow('users', { id: 'u1' })] } }, async () => {
    const user = await User.findById('u1');
    const json = user.toJSON();
    assert.ok(!Object.keys(json).some((k) => k.startsWith('$')));
    assert.equal(json.id, 'u1');
  });
});

/* ------------------------------------------------------------------ *
 * Regression: populate({ path, match }) was silently a no-op, so the
 * library endpoints returned bare UUIDs.
 * ------------------------------------------------------------------ */
test('populate({ path, match }) on a jsonb array resolves the ids', async () => {
  await run({
    rows: {
      users: [seedRow('users', { id: 'u1', library: ['s1', 's2'] })],
      series: [
        seedRow('series', { id: 's1', title: 'One', is_removed: false }),
        seedRow('series', { id: 's2', title: 'Two', is_removed: true }),
      ],
    },
  }, async (pool) => {
    const user = await User.findById('u1');
    await user.populate({ path: 'library', match: { isRemoved: false } });

    assert.ok(Array.isArray(user.library));
    assert.equal(user.library.length, 1, 'the removed series should be filtered out');
    assert.equal(user.library[0].title, 'One');
    assert.match(pool.log.find((e) => /FROM "series"/.test(e.sql)).sql, /"is_removed" = \$1/);
  });
});

test('populate on a jsonb array-of-objects resolves each entry', async () => {
  await run({
    rows: {
      users: [seedRow('users', {
        id: 'u1',
        downloads: [{ series: 's1', chapter: 'c1' }],
      })],
      series: [seedRow('series', { id: 's1', title: 'One', is_removed: false })],
    },
  }, async () => {
    const user = await User.findById('u1');
    await user.populate({ path: 'downloads.series', match: { isRemoved: false } });
    assert.equal(user.downloads[0].series.title, 'One');
    assert.equal(user.downloads[0].chapter, 'c1', 'sibling keys are preserved');
  });
});

test('populate leaves the underlying id untouched for later saves', async () => {
  await run({
    rows: { comments: [seedRow('comments', { id: 'c1', user: 'u1' })], users: [seedRow('users', { id: 'u1' })] },
  }, async (pool) => {
    const comment = await Comment.findById('c1');
    await comment.populate('user');
    comment.text = 'edited';
    await comment.save();
    const update = pool.log.find((e) => e.verb === 'UPDATE');
    assert.ok(!/"user"=/.test(update.sql));
    assert.match(update.sql, /SET "text" = \$1/);
  });
});

test('a projected document still exposes id and _id', async () => {
  await run({ rows: { series: [seedRow('series', { id: 's1', title: 'Alpha' })] } }, async () => {
    const series = await Series.findById('s1').select('title').exec();
    assert.equal(series.id, 's1', 'id must survive a projection');
    assert.equal(series._id, 's1', '_id must survive a projection');
    assert.equal(series.title, 'Alpha');
  });
});

test('populate keeps ids on the projected target document', async () => {
  await run({
    rows: {
      users: [seedRow('users', { id: 'u1', library: ['s1'] })],
      series: [seedRow('series', { id: 's1', title: 'One', is_removed: false })],
    },
  }, async () => {
    const user = await User.findById('u1');
    await user.populate({ path: 'library', select: 'title', match: { isRemoved: false } });
    assert.equal(user.library[0].id, 's1', 'a projected populate target must keep its id');
    assert.equal(user.library[0].title, 'One');
  });
});

/* ------------------------------------------------------------------ *
 * Aggregate is now real SQL, not a hardcoded rating calculator.
 * ------------------------------------------------------------------ */
test('aggregate() computes the rating rollup in SQL', async () => {
  await run({ rows: {}, affected: 0 }, async (pool) => {
    await Comment.aggregate([
      { $match: { series: 's1', isRemoved: false } },
      { $group: { _id: '$series', avg: { $avg: '$rating' }, count: { $sum: 1 } } },
    ]);
    const stmt = statementsOf(pool, 'SELECT').at(-1);
    assert.match(stmt.sql, /AVG\("rating"\).*::float8 AS "avg"/);
    assert.match(stmt.sql, /GROUP BY "series"/);
    assert.match(stmt.sql, /WHERE \("series" = \$1 AND "is_removed" = \$2\)/);
  });
});

test('aggregate() rejects a pipeline it cannot honour', async () => {
  await run({ rows: {} }, async () => {
    // Grouping by an arbitrary field used to throw. It is now supported, so what
    // must still be refused is a key shape that cannot be expressed: a bare
    // string with no field reference, and a compound document whose values are
    // not field references.
    await assert.rejects(
      () => Comment.aggregate([{ $group: { _id: 'author' } }]),
      /must be a field reference/
    );
    await assert.rejects(
      () => Comment.aggregate([{ $group: { _id: { author: 'author' } } }]),
      /must be a field reference/
    );
    await assert.rejects(
      () => Comment.aggregate([{ $unwind: '$text' }]),
      /unsupported stage "\$unwind"/
    );
    await assert.rejects(
      () => Comment.aggregate([{ $group: { _id: '$series', total: { $push: '$rating' } } }]),
      /unsupported accumulator/
    );
    // Out-of-order stages would compose into wrong SQL, so refuse them.
    await assert.rejects(
      () => Comment.aggregate([{ $limit: 5 }, { $match: { series: 's1' } }]),
      /must be ordered/
    );
  });
});

test('aggregate() supports sort, skip, limit and $project', async () => {
  await run({ rows: {} }, async (pool) => {
    await Comment.aggregate([
      { $match: { isRemoved: false } },
      { $group: { _id: '$series', count: { $sum: 1 }, rating: { $max: '$rating' } } },
      { $sort: { count: -1 } },
      { $skip: 1 },
      { $limit: 5 },
    ]);
    const stmt = statementsOf(pool, 'SELECT').at(-1);
    const sql = stmt.sql;
    assert.match(sql, /MAX\("rating"\)/, '$max accumulator');
    assert.match(sql, /ORDER BY "count" DESC/);
    assert.match(sql, /LIMIT \$2 OFFSET \$3/, 'paging params follow the $match param');
    assert.deepEqual(stmt.params, [false, 5, 1]);
  });
});

test('aggregate() $project renames and drops fields', async () => {
  await run({ rows: { comments: [{ _id: 's1', avg: 4.5, count: 2, junk: 1 }] } }, async () => {
    const out = await Comment.aggregate([
      { $group: { _id: '$series', avg: { $avg: '$rating' }, count: { $sum: 1 } } },
      { $project: { seriesId: '$_id', average: '$avg', dropMe: 0 } },
    ]);
    assert.deepEqual(out[0], { seriesId: 's1', average: 4.5 });
  });
});

test('aggregate() refuses to sort by a field it did not group', async () => {
  await run({ rows: {} }, async () => {
    await assert.rejects(
      () => Comment.aggregate([
        { $group: { _id: '$series', count: { $sum: 1 } } },
        { $sort: { text: 1 } },
      ]),
      /cannot sort by "text"/
    );
  });
});

/* ------------------------------------------------------------------ *
 * insertMany is one statement.
 * ------------------------------------------------------------------ */
test('insertMany is a single multi-row INSERT', async () => {
  await run({ rows: { notifications: [] } }, async (pool) => {
    await Notification.insertMany([
      { user: 'u1', type: 'new_chapter', message: 'a', series: 's1' },
      { user: 'u2', type: 'new_chapter', message: 'b', series: 's1' },
    ]);
    const inserts = pool.log.filter((e) => e.verb === 'INSERT');
    assert.equal(inserts.length, 1);
    assert.match(inserts[0].sql, /VALUES \(\$1, \$2, \$3, \$4\), \(\$5, \$6, \$7, \$8\)/);
  });
});

/* ------------------------------------------------------------------ *
 * Atomic chapter numbering.
 * ------------------------------------------------------------------ */
test('nextChapterNumber delegates the increment to the database', async () => {
  await run({ rows: {} }, async (pool) => {
    pool.query = async (text, params) => {
      pool.log.push({ sql: text.replace(/\s+/g, ' ').trim(), params, verb: 'UPDATE' });
      return { rows: [{ chapter_count: 7 }], rowCount: 1 };
    };
    const num = await Series.nextChapterNumber('s1');
    assert.equal(num, 7);
    assert.match(statementsOf(pool, 'UPDATE')[0].sql, /SET "chapter_count" = "chapter_count" \+ 1/);
    assert.match(statementsOf(pool, 'UPDATE')[0].sql, /RETURNING "chapter_count"/);
  });
});