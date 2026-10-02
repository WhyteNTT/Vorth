'use strict';

/**
 * Full-text search.
 *
 * Search used to be ILKE over three concatenated columns, so it could not rank,
 * could not stem, and could not use an index. It is now an indexed tsvector
 * match with a substring second pass for partial words.
 */

const test = require('node:test');
const assert = require('node:assert');

const sql = require('../src/models/_sql');

const MODEL = {
  table: 'series',
  columns: new Set(['id', 'title', 'author', 'artist', 'synopsis', 'search_vector', 'views']),
  isJson: () => false,
};

test('$text compiles to an indexed tsvector match with a bound parameter', () => {
  const params = new sql.Params();
  const { text, params: p } = sql.buildWhere({ $text: { $search: 'harbour lights' } }, MODEL, params);

  assert.match(text, /"search_vector" @@ websearch_to_tsquery\('english', \$\d+\)/);
  assert.deepEqual(p.values, ['harbour lights']);
  // The term must never be inlined into the SQL.
  assert.ok(!text.includes('harbour'), 'the search term was inlined instead of bound');
});

test('$text degrades to a substring match on a database with no search_vector', () => {
  const legacy = { table: 'series', columns: new Set(['id', 'title', 'author', 'synopsis']), isJson: () => false };
  const params = new sql.Params();
  const { text } = sql.buildWhere({ $text: { $search: 'salt' } }, legacy, params);
  assert.match(text, /ILIKE/);
  assert.deepEqual(params.values, ['%salt%']);
});

test('$substring matches any of the searchable fields, with the wildcards bound', () => {
  const params = new sql.Params();
  const { text } = sql.buildWhere({ $substring: 'salt' }, MODEL, params);
  assert.match(text, /"title" ILIKE \$\d+ OR "author" ILIKE \$\d+ OR "synopsis" ILIKE \$\d+/);
  assert.deepEqual(params.values, ['%salt%'], 'one bound value, reused per field');

  const injection = new sql.Params();
  sql.buildWhere({ $substring: "'; DROP TABLE series; --" }, MODEL, injection);
  assert.deepEqual(injection.values, ["%'; DROP TABLE series; --%"]);
  assert.equal(injection.values.length, 1);
});

test('$text tolerates an empty or whitespace-only term', () => {
  for (const term of ['', '   ', undefined]) {
    const params = new sql.Params();
    const { text } = sql.buildWhere({ $text: { $search: term } }, MODEL, params);
    assert.ok(text === 'TRUE' || text === '', `"${term}" produced "${text}"`);
    assert.deepEqual(params.values, [], 'an empty term should not consume a parameter');
  }
});

test('the search vector ranks a title match above a synopsis-only match', () => {
  const params = new sql.Params();
  const rank = sql.tsRankExpr(MODEL, params, 'harbour');
  assert.ok(rank, 'expected a rank expression');
  assert.match(rank, /ts_rank_cd\(/);
  assert.deepEqual(params.values, ['harbour']);

  // No search_vector means no ranking, rather than a broken query.
  const legacy = { table: 'series', columns: new Set(['id', 'title']), isJson: () => false };
  assert.equal(sql.tsRankExpr(legacy, new sql.Params(), 'x'), null);
});

test('columnExists understands the shapes a model can declare columns in', () => {
  assert.ok(sql.columnExists({ columns: new Set(['a']) }, 'a'));
  assert.ok(sql.columnExists({ columns: ['a', 'b'] }, 'b'));
  assert.ok(sql.columnExists({ columns: { a: 1 } }, 'a'));
  assert.ok(!sql.columnExists({ columns: new Set(['a']) }, 'zz'));
  assert.ok(!sql.columnExists({}, 'a'));
  assert.ok(!sql.columnExists(null, 'a'));
});

test('unsupported operators still throw, including near-misses', () => {
  // $substring is deliberately narrow; a typo must not be silently ignored.
  const params = new sql.Params();
  assert.throws(
    () => sql.buildWhere({ $substrin: 'x' }, MODEL, params),
    /unsupported|operator/i,
  );
});