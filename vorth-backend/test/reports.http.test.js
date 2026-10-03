'use strict';

/**
 * POST /api/reports over real HTTP.
 *
 * The reporting route is what a reader with no account uses to get content
 * removed, so it has to work without a session, and it has to be impossible to
 * abuse into writing columns it should not own.
 *
 * Uses the real routing, validation chains and error handler with only the
 * database replaced by a double, matching test/http.test.js.
 */

process.env.DATABASE_URL ||= 'postgres://stub/stub';
process.env.DATABASE_SSL = 'false';
process.env.JWT_SECRET ||= 'test-secret';
process.env.NODE_ENV = 'test';
process.env.RATE_LIMIT_MAX_REQUESTS = '10000';
process.env.AUTH_RATE_LIMIT_MAX_REQUESTS = '10000';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createFakePool } = require('./helpers/fakePool');

const SERIES_ID = '11111111-1111-4111-8111-111111111111';
const CHAPTER_ID = '33333333-3333-4333-8333-333333333333';

async function withServer(rows, fn) {
  const fake = createFakePool({ rows });
  const db = require('../src/config/db');
  const Base = require('../src/models/_base');
  Base._clearColumnCache();
  db.setPool(fake);

  const app = require('../src/app');
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const { port } = server.address();
  const call = async (method, path, body) => {
    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, json, text };
  };
  try {
    return await fn(call, fake);
  } finally {
    server.close();
  }
}

/** The series/chapter a report can point at. */
function rows() {
  return {
    series: [{
      id: SERIES_ID, type: 'novel', owner: '44444444-4444-4444-8444-444444444444',
      author: 'Someone', title: 'Reported Work', status: 'Ongoing',
      synopsis: 'x', genres: '[]', tags: '[]', views: '{}',
      is_removed: false, rights_attested_at: new Date(),
    }],
    chapters: [{
      id: CHAPTER_ID, series: SERIES_ID, num: 1, title: 'One',
      paragraphs: '[]', pages: null, views: 0, is_removed: false,
    }],
  };
}

function valid(overrides = {}) {
  return {
    category: 'hate_harassment',
    description: 'This chapter contains targeted abuse of a named person.',
    details: 'Paragraph 4.',
    reportedSeries: SERIES_ID,
    ...overrides,
  };
}

test('anyone can report content, with no account', () =>
  withServer(rows(), async (call) => {
    const res = await call('POST', '/api/reports', valid());
    assert.equal(res.status, 201, res.text);
    assert.equal(res.json.success, true);
    assert.ok(res.json.reportId, 'no report id returned');
  }));

test('a report may target a chapter on its own', () =>
  withServer(rows(), async (call) => {
    const res = await call('POST', '/api/reports', valid({ reportedSeries: undefined, reportedChapter: CHAPTER_ID }));
    assert.equal(res.status, 201, res.text);
  }));

test('an unknown category is rejected rather than stored', () =>
  withServer(rows(), async (call) => {
    const res = await call('POST', '/api/reports', valid({ category: 'because_i_said_so' }));
    assert.equal(res.status, 400, res.text);
    assert.match(res.text, /category/i);
  }));

test('every category the policy documents is accepted', () =>
  withServer(rows(), async (call) => {
    const { CATEGORIES } = require('../src/controllers/reportController');
    for (const category of CATEGORIES) {
      const res = await call('POST', '/api/reports', valid({ category }));
      assert.equal(res.status, 201, `${category} was rejected: ${res.text}`);
    }
  }));

test('a report must identify something to act on', () =>
  withServer(rows(), async (call) => {
    const res = await call('POST', '/api/reports', {
      category: 'other', description: 'Vague complaint with no target at all.',
    });
    assert.equal(res.status, 400, res.text);
    assert.match(res.text, /identify/i);
  }));

test('a missing description is rejected', () =>
  withServer(rows(), async (call) => {
    const res = await call('POST', '/api/reports', valid({ description: '' }));
    assert.equal(res.status, 400, res.text);
  }));

test('a report cannot set its own status, resolver or admin notes', () =>
  withServer(rows(), async (call, pool) => {
    await call('POST', '/api/reports', valid({
      status: 'dismissed',
      resolvedBy: '22222222-2222-4222-8222-222222222222',
      adminNotes: 'looks fine to me',
      resolvedAt: '2020-01-01T00:00:00.000Z',
    }));

    const insert = pool.statements.find((s) => /^INSERT INTO "?content_reports"?/i.test(s.sql));
    assert.ok(insert, `no insert issued; saw: ${pool.statements.map((s) => s.sql.slice(0, 50))}`);

    const bound = JSON.stringify(insert.params);
    for (const forbidden of ['status', 'resolvedBy', 'adminNotes', 'resolvedAt']) {
      assert.ok(!bound.includes(forbidden), `${forbidden} was written by the client: ${bound}`);
    }
    assert.ok(bound.includes('hate_harassment'), 'the category should have been written');
  }));

test('a chapter reported against the wrong series is rejected', () =>
  withServer(rows(), async (call) => {
    const otherSeries = '55555555-5555-4555-8555-555555555555';
    const res = await call('POST', '/api/reports', valid({
      reportedSeries: otherSeries, reportedChapter: CHAPTER_ID,
    }));
    assert.equal(res.status, 400, res.text);
    assert.match(res.text, /does not belong/i);
  }));

test('a report naming something that does not exist is a 404', () =>
  withServer(rows(), async (call) => {
    const res = await call('POST', '/api/reports', valid({
      reportedSeries: '66666666-6666-4666-8666-666666666666',
    }));
    assert.equal(res.status, 404, res.text);
  }));

test('a malformed uuid is a 400, not a 500', () =>
  withServer(rows(), async (call) => {
    const res = await call('POST', '/api/reports', valid({ reportedSeries: 'not-a-uuid' }));
    assert.equal(res.status, 400, res.text);
  }));

test('the admin queue is closed without a token', () =>
  withServer(rows(), async (call) => {
    assert.equal((await call('GET', '/api/reports')).status, 401);
    assert.equal((await call('GET', '/api/reports/anything')).status, 401);
    const patched = await call('PATCH', '/api/reports/anything', { status: 'dismissed' });
    assert.equal(patched.status, 401);
  }));

test('the DMCA statutory fields are not required here', () =>
  withServer(rows(), async (call) => {
    // If the two intakes were conflated, a policy report would demand a
    // good-faith statement and a signature.
    const res = await call('POST', '/api/reports', valid());
    assert.equal(res.status, 201, res.text);
    assert.ok(!res.text.includes('goodFaithStatement'), 'the DMCA form leaked into /api/reports');
  }));