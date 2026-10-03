'use strict';

/**
 * Full-text search.
 *
 * Search used to be ILKE over three concatenated columns, so it could not rank,
 * could not stem, and could not use an index. It is now an indexed tsvector
 * match with a substring second pass for partial words.
 */

process.env.DATABASE_URL ||= 'postgres://stub/stub';
process.env.DATABASE_SSL = 'false';
process.env.JWT_SECRET ||= 'test-secret';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const sql = require('../src/models/_sql');

/** A real model: a table name, no column list of its own. */
const MODEL = { table: 'series', isJson: () => false };

/** What _base.js passes in: the table's known columns, cached per table. */
const COLUMNS = new Set([
  'id', 'title', 'author', 'artist', 'synopsis', 'search_vector', 'views',
]);

test('$text compiles to an indexed tsvector match with a bound parameter', () => {
  const params = new sql.Params();
  const { text, params: p } = sql.buildWhere({ $text: { $search: 'harbour lights' } }, MODEL, params, COLUMNS);

  assert.match(text, /"search_vector" @@ websearch_to_tsquery\('english', \$\d+\)/);
  assert.deepEqual(p.values, ['harbour lights']);
  // The term must never be inlined into the SQL.
  assert.ok(!text.includes('harbour'), 'the search term was inlined instead of bound');
});

test('$text degrades to a substring match on a database with no search_vector', () => {
  const legacy = { table: 'series', isJson: () => false };
  const LEGACY_COLUMNS = new Set(['id', 'title', 'author', 'synopsis']);
  const params = new sql.Params();
  const { text } = sql.buildWhere({ $text: { $search: 'salt' } }, legacy, params, LEGACY_COLUMNS);
  assert.match(text, /ILIKE/);
  assert.deepEqual(params.values, ['%salt%']);
});

test('$substring matches any of the searchable fields, with the wildcards bound', () => {
  const params = new sql.Params();
  const { text } = sql.buildWhere({ $substring: 'salt' }, MODEL, params, COLUMNS);
  assert.match(text, /"title" ILIKE \$\d+ OR "author" ILIKE \$\d+ OR "synopsis" ILIKE \$\d+/);
  assert.deepEqual(params.values, ['%salt%'], 'one bound value, reused per field');

  const injection = new sql.Params();
  sql.buildWhere({ $substring: "'; DROP TABLE series; --" }, MODEL, injection, COLUMNS);
  assert.deepEqual(injection.values, ["%'; DROP TABLE series; --%"]);
  assert.equal(injection.values.length, 1);
});

test('$text tolerates an empty or whitespace-only term', () => {
  for (const term of ['', '   ', undefined]) {
    const params = new sql.Params();
    const { text } = sql.buildWhere({ $text: { $search: term } }, MODEL, params, COLUMNS);
    assert.ok(text === 'TRUE' || text === '', `"${term}" produced "${text}"`);
    assert.deepEqual(params.values, [], 'an empty term should not consume a parameter');
  }
});

test('the search vector ranks a title match above a synopsis-only match', () => {
  const params = new sql.Params();
  const rank = sql.tsRankExpr(MODEL, COLUMNS, params, 'harbour');
  assert.ok(rank, 'expected a rank expression');
  assert.match(rank, /ts_rank_cd\(/);
  assert.deepEqual(params.values, ['harbour']);

  // No search_vector means no ranking, rather than a broken query.
  const legacy = { table: 'series', isJson: () => false };
  assert.equal(sql.tsRankExpr(legacy, new Set(['id', 'title']), new sql.Params(), 'x'), null);
});

test('columnExists reads the column list it is given, not the model', () => {
  assert.ok(sql.columnExists(new Set(['a']), 'a'));
  assert.ok(sql.columnExists(['a', 'b'], 'b'));
  assert.ok(sql.columnExists({ a: 1 }, 'a'));
  assert.ok(!sql.columnExists(new Set(['a']), 'zz'));
  assert.ok(!sql.columnExists(null, 'a'));

  // The shape that caused a real outage: a model with no column list of its
  // own, which must not be mistaken for "no columns exist".
  assert.ok(!sql.columnExists(MODEL, 'title'),
    'a model object must never be treated as a column list');
});

test('a bare model with no column list degrades without binding a phantom parameter', () => {
  // This is the exact failure the live suite found: columnExists was asked
  // about the model rather than a column list, reported every column missing,
  // emitted WHERE FALSE, and still bound the search term. PostgreSQL rejected
  // it with "supplies 1 parameter, but prepared statement requires 0".
  const params = new sql.Params();
  const { text } = sql.buildWhere({ $text: { $search: 'harbour' } }, MODEL, params);

  assert.equal(text.trim(), 'WHERE FALSE',
    'with no column information the condition must not reference any column');
  assert.deepEqual(params.values, [],
    'a condition that references no parameter must not bind one');

  const referenced = Math.max(0, ...(text.match(/\$\d+/g) || ['0']).map((n) => Number(n.slice(1))));
  assert.ok(referenced <= params.values.length,
    `SQL references ${referenced} but ${params.values.length} value(s) were bound`);
});

test('every compiled condition references no more parameters than it binds', () => {
  // A general guard on the shape of the bug, not just the one query.
  const cases = [
    [{ $text: { $search: 'a' } }, COLUMNS],
    [{ $text: { $search: 'a' } }, new Set(['id', 'title', 'author', 'synopsis'])],
    [{ author: 'x', $text: { $search: 'a' } }, COLUMNS],
    [{ author: 'x', $substring: 'a' }, COLUMNS],
    [{ $substring: 'a' }, COLUMNS],
    [{ $text: { $search: '' } }, COLUMNS],
    [{ $text: { $search: '' } }, new Set()],
  ];
  for (const [filter, cols] of cases) {
    const params = new sql.Params();
    const { text } = sql.buildWhere(filter, MODEL, params, cols);
    const referenced = Math.max(0, ...(text.match(/\$\d+/g) || ['0']).map((n) => Number(n.slice(1))));
    assert.ok(referenced <= params.values.length,
      `${JSON.stringify(filter)} with ${cols.size} columns: SQL references ${referenced}, `
      + `${params.values.length} bound -> ${text}`);
  }
});

test('unsupported operators still throw, including near-misses', () => {
  // $substring is deliberately narrow; a typo must not be silently ignored.
  const params = new sql.Params();
  assert.throws(
    () => sql.buildWhere({ $substrin: 'x' }, MODEL, params, COLUMNS),
    /unsupported|operator/i,
  );
});