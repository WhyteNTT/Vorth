'use strict';

/**
 * Null handling in the filter compiler.
 *
 * Both cases here compiled to SQL that matched *no rows at all*, which is the
 * worst possible failure: a query that looks right, returns empty, and reads as
 * "there is nothing to do".
 *
 * The cause is SQL's three-valued logic. `x <> NULL` is UNKNOWN, not TRUE, so
 * { field: { $ne: null } } - the standard Mongo idiom for "this field has a
 * value" - became a predicate that excluded every row, including the rows it
 * was written to find. The same applies to a null inside a $nin list.
 *
 * Checked against real PostgreSQL as well as the recording double, because the
 * whole point is what the database does with the emitted predicate. The double
 * cannot tell you that.
 */

process.env.DATABASE_URL ||= 'postgres://stub/stub';
process.env.DATABASE_SSL = 'false';
process.env.JWT_SECRET ||= 'test-secret';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const { Params, buildWhere, columnExpr } = require('../src/models/_sql');
const Comment = require('../src/models/Comment');

/** The WHERE clause a filter compiles to. */
function compile(filter) {
  const params = new Params();
  const out = buildWhere(
    filter, Comment, params,
    ['id', 'series', 'user', 'text', 'rating', 'is_removed', 'status', 'resolved_at', 'deleted_at', 'a', 'b', 'c', 'd']
  );
  return { text: out.text, values: params.values };
}

/* ------------------------------------------------------------------ *
 * $ne: null
 * ------------------------------------------------------------------ */

test('$ne null compiles to IS NOT NULL, not <> a bound null', () => {
  const { text, values } = compile({ resolvedAt: { $ne: null } });
  assert.match(text, /"resolved_at" IS NOT NULL/);
  // The whole bug was the bound null: there is no value to bind here.
  assert.ok(!values.includes(null), 'a parameter was bound for a null comparison');
});

test('$ne with a real value is unchanged', () => {
  const { text, values } = compile({ series: { $ne: 's1' } });
  assert.match(text, /"series" <> \$1/);
  assert.deepEqual(values, ['s1']);
});

test('$ne null combines with other predicates under AND', () => {
  const { text } = compile({ status: 'pending', responseDeadline: { $ne: null } });
  assert.match(text, /"status" = \$1/);
  assert.match(text, /"response_deadline" IS NOT NULL/);
  assert.match(text, /AND/);
});

/* ------------------------------------------------------------------ *
 * $nin containing null
 * ------------------------------------------------------------------ */

test('$nin with a null in the list keeps the value comparison and adds IS NOT NULL', () => {
  const { text, values } = compile({ status: { $nin: ['pending', null] } });
  // "status is not pending AND status is not null"
  assert.match(text, /"status" IS NOT NULL/);
  assert.match(text, /NOT \("status" = ANY \(\$1\)\)/);
  // The null must not remain in the bound array.
  assert.deepEqual(values, [['pending']], 'the null leaked into the bound array');
});

test('$nin with only a null becomes IS NOT NULL', () => {
  const { text, values } = compile({ deletedAt: { $nin: [null] } });
  assert.match(text, /"deleted_at" IS NOT NULL/);
  assert.equal(values.length, 0, 'a parameter was bound with nothing to compare');
});

test('$nin without a null is unchanged', () => {
  const { text, values } = compile({ status: { $nin: ['pending', 'contested'] } });
  assert.match(text, /NOT \("status" = ANY \(\$1\)\)/);
  assert.deepEqual(values, [['pending', 'contested']]);
});

test('$in with a null matches a null column', () => {
  const { text } = compile({ resolvedBy: { $in: [null] } });
  assert.match(text, /"resolved_by" IS NULL/);
});

test('$in with a null among values keeps the value comparison', () => {
  const { text, values } = compile({ status: { $in: ['pending', null] } });
  assert.match(text, /"status" = ANY \(\$1\)/);
  assert.match(text, /"status" IS NULL/);
  assert.deepEqual(values, [['pending']]);
});

test('every emitted placeholder is bound', () => {
  // A query with an unbound placeholder is a runtime error in PostgreSQL, and
  // the compiler silently produced them before.
  const params = new Params();
  const out = buildWhere(
    { a: { $ne: null }, b: { $nin: [null] }, c: { $nin: ['x', null] }, d: 1 },
    Comment,
    params,
    ['id', 'series', 'user', 'text', 'rating', 'is_removed', 'a', 'b', 'c', 'd']
  );
  const placeholders = (out.text.match(/\$\d+/g) || []).map((p) => Number(p.slice(1)));
  const highest = placeholders.length ? Math.max(...placeholders) : 0;
  assert.equal(
    highest, params.values.length,
    `text references $${highest} but only ${params.values.length} values were bound: ${out.text}`
  );
});

/* ------------------------------------------------------------------ *
 * Against a real database.
 * ------------------------------------------------------------------ */

test('$ne null returns the rows that have a value, and only those', { skip: !process.env.VORTH_LIVE_DB }, async () => {
  const { pool, connectDB } = require('../src/config/db');
  const User = require('../src/models/User');
  const Series = require('../src/models/Series');
  const DMCAReport = require('../src/models/DMCAReport');

  try {
    await connectDB();

    const mark = `nn${Date.now().toString(36)}`;
    const user = await User.create({
      displayName: 'Nulls', username: mark, email: `${mark}@example.test`,
      password: 'correct horse battery',
      agreedToTermsAt: new Date(), ageConfirmed: true,
    });
    const withDate = await DMCAReport.create({
      reporterName: 'Resolved', reporterEmail: 'r@example.test',
      copyrightedWorkDescription: 'x', signature: 's',
      goodFaithStatement: true, accuracyStatement: true,
      status: 'rejected', resolvedAt: new Date(),
    });
    const withoutDate = await DMCAReport.create({
      reporterName: 'Unresolved', reporterEmail: 'u@example.test',
      copyrightedWorkDescription: 'y', signature: 's',
      goodFaithStatement: true, accuracyStatement: true,
      status: 'pending',
    });

    /*
     * Before the fix this returned an empty array: <> NULL is UNKNOWN, so the
     * predicate rejected every row including the one it was written to find.
     */
    const hasDate = await DMCAReport.find({ id: { $in: [withDate.id, withoutDate.id] }, resolvedAt: { $ne: null } });
    assert.equal(hasDate.length, 1, 'expected exactly the report with a resolution date');
    assert.equal(hasDate[0].id, withDate.id);

    const noDate = await DMCAReport.find({ id: { $in: [withDate.id, withoutDate.id] }, resolvedAt: { $ne: null } });
    assert.equal(noDate.length, 1, 'the broken predicate would have returned zero rows');

    // $nin with a null behaves the same way.
    const viaNin = await DMCAReport.find({
      id: { $in: [withDate.id, withoutDate.id] },
      resolvedAt: { $nin: [null] },
    });
    assert.equal(viaNin.length, 1, '$nin with a null returned the wrong rows');
    assert.equal(viaNin[0].id, withDate.id);

    // And the negation: pending reports have no resolution date.
    const pending = await DMCAReport.find({
      id: { $in: [withDate.id, withoutDate.id] },
      status: { $nin: ['pending', null] },
    });
    assert.equal(pending.length, 1, '$nin with a null on a non-null column is wrong');
    assert.equal(pending[0].id, withDate.id);

    await DMCAReport.deleteMany({ id: { $in: [withDate.id, withoutDate.id] } });
    await Series.deleteMany({ owner: user.id });
    await User.deleteMany({ username: mark });
  } finally {
    await pool.end();
  }
});

test('columnExpr keeps the same identifier it always did', () => {
  // Guards against the null fix having changed identifier quoting.
  assert.equal(columnExpr('resolvedAt', Comment), '"resolved_at"');
});
