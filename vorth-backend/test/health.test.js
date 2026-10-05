'use strict';

/**
 * `/api/health`, and what it actually proves.
 *
 * This is the endpoint an operator and a platform both use to decide whether the
 * service is working. It had no test, and at 40% branch coverage the uncovered
 * half was the interesting one: what it answers when the database is unreachable.
 *
 * That distinction is the whole reason this file is careful. A health check that
 * reports "ok" with a dead database gets the instance kept in rotation and every
 * request failing; one that reports "down" when the database is merely slow takes
 * a healthy instance out. So both directions are pinned, and so is the promise it
 * makes about not leaking anything while doing it - this is an unauthenticated
 * endpoint, which makes it the most-reachable place in the codebase to disclose
 * from.
 */

process.env.DATABASE_URL ||= 'postgres://stub/stub';
process.env.DATABASE_SSL = 'false';
process.env.JWT_SECRET ||= 'test-secret';
process.env.NODE_ENV = 'test';
process.env.RATE_LIMIT_MAX_REQUESTS = '100000';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createFakePool } = require('./helpers/fakePool');

async function withServer(opts, fn) {
  const fake = createFakePool(opts);
  const db = require('../src/config/db');
  const Base = require('../src/models/_base');
  Base._clearColumnCache();
  db.setPool(fake);

  const app = require('../src/app');
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const { port } = server.address();

  const call = async (method, path) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { method });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (_) { /* not json */ }
    return { status: res.status, json, text };
  };

  try {
    return await fn({ call, fake });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    db.setPool(null);
    Base._clearColumnCache();
  }
}

test('health is 200 and ok when the database answers', async () => {
  await withServer({ rows: {} }, async ({ call, fake }) => {
    const res = await call('GET', '/api/health');
    assert.equal(res.status, 200, res.text);
    assert.equal(res.json.success, true);
    assert.equal(res.json.status, 'ok');
    assert.equal(res.json.database, 'connected');
    // It has to actually ask, rather than assume.
    assert.ok(fake.log.some((e) => /SELECT 1/.test(e.sql)),
      'health reported ok without asking the database');
  });
});

test('health is 503 when the database cannot be reached', async () => {
  /*
   * The important half. A check that stays 200 with a dead database keeps a broken
   * instance in rotation: the platform's own health check passes, traffic arrives,
   * and every request fails. That is the failure mode this endpoint exists to
   * prevent, and it was the untested one.
   */
  await withServer({
    rows: {},
    errors: { 'SELECT 1': Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), {}) },
  }, async ({ call }) => {
    const res = await call('GET', '/api/health');
    assert.equal(res.status, 503, `expected 503, got ${res.status}: ${res.text}`);
    assert.equal(res.json.success, false);
    assert.equal(res.json.status, 'degraded');
    assert.equal(res.json.database, 'disconnected');
  });
});

test('health never discloses why the database failed', async () => {
  /*
   * Unauthenticated, so this is the most reachable place in the codebase to
   * disclose from - and the error it swallows is the most informative one
   * available: a real driver message carries the host, the port and sometimes the
   * user. A health endpoint that echoed it would hand an unauthenticated caller a
   * map of the infrastructure.
   */
  const secrets = [
    'connect ECONNREFUSED 127.0.0.1:5432',
    'password authentication failed for user "vorth"',
    'getaddrinfo ENOTFOUND db.internal.example.com',
    'relation "users" does not exist',
  ];

  for (const message of secrets) {
    await withServer({
      rows: {},
      errors: { 'SELECT 1': new Error(message) },
    }, async ({ call }) => {
      const res = await call('GET', '/api/health');
      assert.equal(res.status, 503);
      assert.ok(!res.text.includes(message),
        `health leaked the database error to an anonymous caller: ${res.text}`);
      assert.ok(!/127\.0\.0\.1|5432|vorth"|db\.internal/.test(res.text),
        `health leaked infrastructure detail: ${res.text}`);
    });
  }
});

test('health needs no session', async () => {
  // A platform health check has no credentials. If this ever required auth it
  // would fail closed for the thing that decides whether the instance lives.
  await withServer({ rows: {} }, async ({ call }) => {
    const res = await call('GET', '/api/health');
    assert.equal(res.status, 200);
  });
});

test('the health response carries nothing but its four documented keys', async () => {
  /*
   * The endpoint is unauthenticated and it answers from the live database, so the
   * shape is the thing worth pinning: it is exactly the four documented keys and
   * nothing else. A future "helpful" addition - a user count, a version, a build
   * id, the last error - would turn an anonymous endpoint into a way to ask the
   * running system questions.
   *
   * The first version of this test compared a hardcoded list against its own
   * sorted copy, which passes whatever the endpoint returns. Asserting the real
   * response is the only version worth having.
   */
  const documented = ['database', 'status', 'success', 'time'];

  for (const [label, opts] of [
    ['healthy', { rows: {} }],
    ['database down', { rows: {}, errors: { 'SELECT 1': new Error('down') } }],
  ]) {
    await withServer(opts, async ({ call }) => {
      const res = await call('GET', '/api/health');
      assert.deepEqual(Object.keys(res.json).sort(), documented,
        `the ${label} health response gained or lost a key: ${Object.keys(res.json).join(', ')}`);
    });
  }
});

test('health reports a time a caller can actually parse', async () => {
  await withServer({ rows: {} }, async ({ call }) => {
    const res = await call('GET', '/api/health');
    const parsed = new Date(res.json.time);
    assert.ok(!Number.isNaN(parsed.getTime()), `"time" is not a date: ${res.json.time}`);
    // And it is now, not a build timestamp baked in at boot.
    assert.ok(Math.abs(Date.now() - parsed.getTime()) < 60_000,
      `health reported a time ${Math.round((Date.now() - parsed.getTime()) / 1000)}s away`);
  });
});

test('the API index is reachable and says where to look', async () => {
  await withServer({ rows: {} }, async ({ call }) => {
    const res = await call('GET', '/api');
    assert.equal(res.status, 200);
    assert.equal(res.json.success, true);
    assert.match(res.json.message, /\/api\/health/,
      'the index does not point at the health endpoint, which is the one thing a '
      + 'stranger arriving at /api needs');
  });
});

test('an unmatched API route is a 404 and not a health-shaped answer', async () => {
  await withServer({ rows: {} }, async ({ call }) => {
    const res = await call('GET', '/api/definitely/not/a/route');
    assert.equal(res.status, 404);
    assert.equal(res.json.success, false);
    assert.ok(!/database|connected/.test(res.text),
      'a 404 body carried health-shaped fields');
  });
});
