'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sql = require('../src/models/_sql');

/** Minimal stand-in for a model class: just enough for the builder. */
const model = (json = []) => ({ isJson: (k) => json.includes(String(k).split('.')[0]) });

const build = (filter, json) => {
  const params = new sql.Params();
  const { text, params: p } = sql.buildWhere(filter, model(json), params);
  return { text, params: p.values };
};

test('SQL builder: plain equality is parameterised', () => {
  const { text, params } = build({ isRemoved: false });
  assert.equal(text, ' WHERE ("is_removed" = $1)');
  assert.deepEqual(params, [false]);
});

test('SQL builder: values never appear inline in the SQL string', () => {
  const evil = "'; DROP TABLE users; --";
  const { text, params } = build({ title: evil });
  assert.ok(!text.includes('DROP'), 'SQL text must not contain the value');
  assert.deepEqual(params, [evil]);
});

test('SQL builder: comparison operators', () => {
  for (const [op, sym] of [['$gt', '>'], ['$gte', '>='], ['$lt', '<'], ['$lte', '<=']]) {
    const { text } = build({ ratingAvg: { [op]: 4 } });
    assert.equal(text, ` WHERE ("rating_avg" ${sym} $1)`);
  }
});

test('SQL builder: $ne and $in', () => {
  assert.equal(build({ id: { $ne: 'a' } }).text, ' WHERE ("id" <> $1)');
  assert.equal(build({ status: { $in: ['Ongoing', 'Hiatus'] } }).text, ' WHERE ("status" = ANY ($1))');
  assert.deepEqual(build({ status: { $in: ['Ongoing'] } }).params, [['Ongoing']]);
});

test('SQL builder: $in with an empty list is a constant, not invalid SQL', () => {
  assert.equal(build({ status: { $in: [] } }).text, ' WHERE FALSE');
  // $nin against an empty list matches everything, so the clause is dropped.
  assert.equal(build({ status: { $nin: [] } }).text, '');
});

test('SQL builder: $exists and $regex', () => {
  assert.match(build({ artist: { $exists: true } }).text, /"artist" IS NOT NULL.*= \$1/);
  assert.match(build({ title: { $regex: 'alpha' } }).text, /"title"::text ~\* \$1/);
});

test('SQL builder: $or / $and / $not', () => {
  const { text, params } = build({ $or: [{ username: 'a' }, { email: 'a@x.com' }] });
  assert.equal(text, ' WHERE (("username" = $1) OR ("email" = $2))');
  assert.deepEqual(params, ['a', 'a@x.com']);
  assert.match(build({ $not: { isRemoved: true } }).text, /NOT \(\("is_removed" = \$1\)\)/);
});

test('SQL builder: equality against a jsonb array means "contains"', () => {
  const { text, params } = build({ genres: 'Fantasy' }, ['genres', 'tags', 'views']);
  assert.equal(text, ' WHERE ("genres" ? $1)');
  assert.deepEqual(params, ['Fantasy']);
});

test('SQL builder: dotted jsonb path casts numerically for comparison', () => {
  const { text } = build({ 'views.alltime': { $gte: 100 } }, ['genres', 'tags', 'views']);
  assert.match(text, /\("views"->>'alltime'\)::double precision >= \$1/);
});

test('SQL builder: jsonb array membership uses ?|', () => {
  const { text } = build({ genres: { $in: ['Fantasy', 'Horror'] } }, ['genres']);
  assert.match(text, /\("genres" \?\| \$1::text\[\]\)/);
});

test('SQL builder: unsupported operators throw instead of matching nothing', () => {
  // This was the original defect: an unknown operator fell through to a
  // string comparison and silently returned zero rows.
  assert.throws(() => build({ ratingAvg: { $wat: 1 } }), /Unsupported query operator "\$wat"/);
  assert.throws(() => build({ $where: '1' }), /Unsupported query operator "\$where"/);
});

test('SQL builder: traversing a non-jsonb column is rejected', () => {
  assert.throws(() => build({ 'title.nested': 'x' }, []), /cannot be traversed/);
});

test('SQL builder: identifiers are allow-listed', () => {
  assert.throws(() => sql.ident('a"; DROP TABLE users;--'), /Unsafe SQL identifier/);
  assert.throws(() => sql.ident('1bad'), /Unsafe SQL identifier/);
  assert.equal(sql.ident('user'), '"user"');
});

test('SQL builder: order by supports multi-key and jsonb paths', () => {
  const params = new sql.Params();
  const text = sql.buildOrderBy({ ratingAvg: -1, ratingCount: -1 }, model([]), params);
  assert.equal(text, ' ORDER BY "rating_avg" DESC NULLS LAST, "rating_count" DESC NULLS LAST');

  const jsonParams = new sql.Params();
  const jsonText = sql.buildOrderBy({ 'views.alltime': -1 }, model(['views']), jsonParams);
  assert.match(jsonText, /\("views"->>'alltime'\)::double precision DESC NULLS LAST/);
});

test('SQL builder: select honours inclusion and exclusion', () => {
  const all = ['id', 'title', 'paragraphs', 'password'];
  assert.equal(sql.buildSelect(['title', 'author'], all), ' "id", "title", "author"');
  assert.equal(sql.buildSelect('-password', all), ' "id", "title", "paragraphs"');
  assert.equal(sql.buildSelect(['-paragraphs', '-password'], all), ' "id", "title"');
});

test('SQL builder: id is always selected so documents are never id-less', () => {
  const all = ['id', 'title', 'synopsis'];
  // A projection used to drop `id`, leaving doc._id undefined — which turned
  // downstream `series._id` filter values into null.
  assert.match(sql.buildSelect(['title'], all), /^ "id", "title"$/);
  assert.match(sql.buildSelect(['isRemoved'], all), /^ "id", "is_removed"$/);
  assert.doesNotMatch(sql.buildSelect(['title'], all), /"id", "id"/, 'no duplicate id column');
  assert.match(sql.buildSelect(['id', 'title'], all), /^ "id", "title"$/);
});

test('SQL builder: jsonb assignment is cast and dotted paths use jsonb_set', () => {
  const params = new sql.Params();
  const [genre, view] = sql.buildAssignments({ genres: ['Fantasy'], 'views.daily': 0 }, model(['genres', 'views']), params);
  assert.equal(genre, '"genres" = $1::jsonb');
  assert.match(view, /"views" = jsonb_set\(COALESCE\("views", '\{\}'::jsonb\), '\{daily\}', \$2::jsonb, true\)/);
  assert.deepEqual(params.values, ['["Fantasy"]', '0']);
});

test('SQL builder: updateMany rejects an empty $set', () => {
  assert.throws(() => sql.buildUpdate(model([]), { $set: {} }), /non-empty \$set/);
});

test('SQL builder: paging clamps and parameterises', () => {
  const params = new sql.Params();
  assert.equal(sql.buildPaging({ limit: 10, skip: 0 }, params), ' LIMIT $1 OFFSET $2');
  assert.deepEqual(params.values, [10, 0]);

  const neg = new sql.Params();
  assert.equal(sql.buildPaging({ limit: -5, skip: -9 }, neg), ' LIMIT $1 OFFSET $2');
  assert.deepEqual(neg.values, [0, 0]);
});

test('SQL builder: insert quotes every identifier and casts jsonb', () => {
  const params = new sql.Params();
  const stmt = sql.buildInsert('users', { username: 'alice', library: ['a'] }, model(['library']), params);
  assert.equal(stmt, 'INSERT INTO "users" ("username", "library") VALUES ($1, $2::jsonb) RETURNING *');
  assert.deepEqual(params.values, ['alice', '["a"]']);
});

test('SQL builder: insert refuses an empty document', () => {
  assert.throws(() => sql.buildInsert('users', {}, model([]), new sql.Params()), /no columns/);
});

test('SQL builder: camel/snake round trip', () => {
  assert.equal(sql.snake('displayName'), 'display_name');
  assert.equal(sql.camel('display_name'), 'displayName');
  assert.equal(sql.snake('views.daily'), 'views.daily');
});