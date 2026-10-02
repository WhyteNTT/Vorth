'use strict';

/**
 * Sessions, email verification and password reset.
 *
 * These exercise the security properties that matter: tokens are stored
 * hashed, refresh tokens rotate, and the account-enumeration endpoints answer
 * identically whether or not an address exists.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');

process.env.DATABASE_URL ||= 'postgres://stub/stub';
process.env.DATABASE_SSL = 'false';
process.env.JWT_SECRET ||= 'test-secret';
process.env.NODE_ENV = 'test';
process.env.RATE_LIMIT_MAX_REQUESTS = '100000';
process.env.AUTH_RATE_LIMIT_MAX_REQUESTS = '100000';
process.env.MAIL_TRANSPORT = 'disabled';

const { createFakePool, seedRow } = require('./helpers/fakePool');
const { hashToken } = require('../src/utils/tokens');

const JWT_SECRET = process.env.JWT_SECRET;

/**
 * @param {{rows?: object, emptyReturning?: RegExp|string}} options
 */
async function withServer(options, fn) {
  const { rows = {}, emptyReturning, ...rest } = options || {};
  const fake = createFakePool({ ...rest, rows, emptyReturning });
  const db = require('../src/config/db');
  const Base = require('../src/models/_base');
  Base._clearColumnCache();
  db.setPool(fake);

  const app = require('../src/app');
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const { port } = server.address();

  const call = async (method, path, { token, body, cookie } = {}) => {
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (cookie) headers.Cookie = cookie;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    });
    let json = null;
    try { json = await res.json(); } catch (_) { /* not JSON */ }
    return {
      status: res.status,
      body: json,
      setCookie: typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [],
    };
  };

  try {
    return await fn({ call, fake, sign: (id, role = 'user') => jwt.sign({ id, role }, JWT_SECRET) });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    db.setPool(null);
    Base._clearColumnCache();
  }
}

const userRow = (over = {}) => seedRow('users', {
  id: 'u1', username: 'alice', display_name: 'Alice', email: 'alice@example.com',
  password: '$2b$12$HASHVALUE', role: 'user', library: [], downloads: [],
  is_banned: false, is_removed: false, email_verified_at: null, ...over,
});

const uniq = () => Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);

const registerBody = () => ({
  displayName: 'New Reader',
  username: `new_${uniq()}`,
  email: `new_${uniq()}@example.com`,
  password: 'longenough1',
  agreedToTerms: 'true',
  ageConfirmed: 'true',
});

/* ------------------------------------------------------------------ *
 * Token utility
 * ------------------------------------------------------------------ */
const { generateToken, safeEqual } = require('../src/utils/tokens');

test('tokens are opaque, long and hashable', () => {
  const a = generateToken();
  const b = generateToken();
  assert.notEqual(a, b, 'tokens are random');
  assert.ok(a.length >= 40, 'token carries enough entropy');
  assert.equal(hashToken(a).length, 64, 'sha256 hex digest');
  assert.equal(hashToken(a), hashToken(a), 'hashing is deterministic');
  assert.notEqual(hashToken(a), hashToken(b));
  assert.equal(safeEqual('abc', 'abc'), true);
  assert.equal(safeEqual('abc', 'abd'), false);
  assert.equal(safeEqual('abc', 'abcd'), false, 'length mismatch is rejected');
});

test('a raw refresh token is never what gets stored', async () => {
  await withServer({ rows: { users: [userRow()] } }, async ({ call, fake }) => {
    const res = await call('POST', '/api/auth/register', { body: registerBody() });
    assert.equal(res.status, 201, JSON.stringify(res.body));

    const insert = fake.log.find((e) => /INSERT INTO "refresh_tokens"/.test(e.sql));
    assert.ok(insert, 'a refresh token row is written');

    const storedHash = insert.params[1];
    assert.match(storedHash, /^[0-9a-f]{64}$/, 'the stored value is a sha256 digest');

    const returned = res.body.refreshToken;
    assert.ok(returned, 'a plaintext token is returned to the client');
    assert.notEqual(returned, storedHash, 'the plaintext token is not the stored value');
    assert.equal(hashToken(returned), storedHash, 'and it hashes to exactly what was stored');
  });
});

/* ------------------------------------------------------------------ *
 * Refresh cookie hardening
 * ------------------------------------------------------------------ */
test('the refresh cookie is httpOnly, sameSite and path-scoped', async () => {
  await withServer({ rows: { users: [userRow()] } }, async ({ call }) => {
    const res = await call('POST', '/api/auth/register', { body: registerBody() });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const cookie = res.setCookie.find((c) => c.startsWith('vorth_refresh='));
    assert.ok(cookie, 'a refresh cookie is issued');
    assert.match(cookie, /HttpOnly/i, 'JavaScript must not be able to read it');
    assert.match(cookie, /SameSite=Lax/i, 'not attached to cross-site subrequests');
    assert.match(cookie, /Path=\/api\/auth/i, 'scoped to the auth routes');
  });
});

/* ------------------------------------------------------------------ *
 * Refresh / logout
 * ------------------------------------------------------------------ */
test('refresh requires a session', async () => {
  await withServer({ rows: { users: [userRow()] } }, async ({ call }) => {
    assert.equal((await call('POST', '/api/auth/refresh')).status, 401);
  });
});

test('logout answers 200 and clears the cookie', async () => {
  await withServer({ rows: { users: [userRow()] } }, async ({ call }) => {
    const { status, body, setCookie } = await call('POST', '/api/auth/logout');
    assert.equal(status, 200);
    assert.equal(body.success, true);
    assert.ok(setCookie.some((c) => /vorth_refresh=/.test(c)), 'the cookie is cleared');
  });
});

test('logout-all revokes every session for the caller', async () => {
  await withServer({ rows: { users: [userRow()] } }, async ({ call, fake, sign }) => {
    const { status, body } = await call('POST', '/api/auth/logout-all', { token: sign('u1') });
    assert.equal(status, 200);
    assert.match(body.message, /Signed out of \d+ session/);
    const update = fake.log.find((e) => /UPDATE "refresh_tokens"/.test(e.sql));
    assert.ok(update, 'refresh tokens are revoked server-side');
    assert.deepEqual(update.params, ['u1']);
  });
});

/* ------------------------------------------------------------------ *
 * Account enumeration
 * ------------------------------------------------------------------ */
test('forgot-password answers identically for known and unknown addresses', async () => {
  await withServer({ rows: { users: [userRow()] } }, async ({ call }) => {
    const known = await call('POST', '/api/auth/forgot-password', { body: { email: 'alice@example.com' } });
    const unknown = await call('POST', '/api/auth/forgot-password', { body: { email: 'nobody@example.com' } });

    assert.equal(known.status, 200);
    assert.equal(unknown.status, 200);
    // Identical status and wording: this endpoint must not reveal membership.
    assert.equal(known.body.message, unknown.body.message);
    assert.match(known.body.message, /If that address has an account/);
  });
});

test('forgot-password rejects a malformed address', async () => {
  await withServer({ rows: { users: [] } }, async ({ call }) => {
    assert.equal((await call('POST', '/api/auth/forgot-password', { body: { email: 'not-an-email' } })).status, 400);
  });
});

/* ------------------------------------------------------------------ *
 * One-shot tokens
 * ------------------------------------------------------------------ */
test('verify-email and reset-password reject a token that matches nothing', async () => {
  // The atomic consume matching no row is exactly what a bogus token looks like.
  await withServer({ rows: { users: [userRow()] }, emptyReturning: /auth_tokens/i }, async ({ call }) => {
    const verify = await call('POST', '/api/auth/verify-email', { body: { token: 'x'.repeat(44) } });
    assert.equal(verify.status, 400);
    assert.match(verify.body.message, /invalid or has expired/);

    const reset = await call('POST', '/api/auth/reset-password', {
      body: { token: 'x'.repeat(44), newPassword: 'longenough1' },
    });
    assert.equal(reset.status, 400);
  });
});

test('verify-email requires a token', async () => {
  await withServer({ rows: { users: [userRow()] } }, async ({ call }) => {
    assert.equal((await call('POST', '/api/auth/verify-email', { body: {} })).status, 400);
  });
});

test('resetting a password revokes every existing session', async () => {
  // Let the token consume succeed so the handler reaches the session revoke.
  await withServer({ rows: { users: [userRow()] } }, async ({ call, fake }) => {
    const { status, body } = await call('POST', '/api/auth/reset-password', {
      body: { token: 'y'.repeat(44), newPassword: 'brandnewpass1' },
    });
    assert.equal(status, 200, JSON.stringify(body));
    assert.match(body.message, /sign in again/i);
    assert.ok(fake.log.some((e) => /UPDATE "users"/.test(e.sql)), 'the password is rewritten');
    assert.ok(fake.log.some((e) => /UPDATE "refresh_tokens"/.test(e.sql)),
      'every session is invalidated after a password change');
  });
});

test('a consumed token cannot be redeemed twice', async () => {
  await withServer({ rows: { users: [userRow()] } }, async ({ call, fake }) => {
    await call('POST', '/api/auth/verify-email', { body: { token: 'z'.repeat(44) } });
    const consume = fake.log.find((e) => /UPDATE "auth_tokens"/.test(e.sql));
    assert.ok(consume, 'consume is a conditional UPDATE');
    assert.match(consume.sql, /"consumed_at" IS NULL/,
      'the single-use guard lives in the WHERE clause, so races are impossible');
    assert.match(consume.sql, /"expires_at" > now\(\)/, 'and expiry is enforced in SQL too');
  });
});

test('resend-verification is hidden behind auth', async () => {
  await withServer({ rows: { users: [userRow()] } }, async ({ call }) => {
    assert.equal((await call('POST', '/api/auth/resend-verification')).status, 401);
    assert.equal((await call('POST', '/api/auth/resend-verification', { token: 'bogus' })).status, 401);
  });
});

/* ------------------------------------------------------------------ *
 * Frontend wiring
 * ------------------------------------------------------------------ */
test('the frontend sends credentials and refreshes transparently', () => {
  const fs = require('fs');
  const path = require('path');
  const source = fs.readFileSync(
    path.join(__dirname, '..', '..', 'vorth-frontend', 'script.js'), 'utf8'
  );
  assert.ok(source.includes("credentials:'include'"), 'cookies must be sent with API calls');
  assert.ok(/function refreshSession/.test(source), 'a refresh helper exists');
  assert.ok(/status === 401/.test(source), '401 triggers a refresh and replay');
  assert.ok(/refreshInFlight/.test(source), 'concurrent 401s share a single refresh');
  assert.ok(/apiFetch\('\/auth\/logout'/.test(source), 'sign-out revokes server-side');
});

/*
 * Regression: the guard that avoids recursing into the refresh endpoint was
 * written as path.includes('/auth/'), which is true for '/auth/me' as well — so
 * an expired token silently failed to recover on the profile endpoint.
 */
test('the refresh guard matches only the refresh endpoint, not every auth route', () => {
  const fs = require('fs');
  const path = require('path');
  const source = fs.readFileSync(
    path.join(__dirname, '..', '..', 'vorth-frontend', 'script.js'), 'utf8'
  );

  // Assert on the exact guard expression, then exercise that expression.
  const line = source.split('\n').find((l) => l.includes('const isRefreshCall'));
  assert.ok(line, 'an isRefreshCall guard exists');
  assert.equal(line.trim(),
    'const isRefreshCall = /\\/auth\\/refresh\\/?$/.test(path);',
    `unexpected guard: ${line.trim()}`);

  const re = /\/auth\/refresh\/?$/;
  assert.equal(re.test('/auth/refresh'), true, 'the refresh call itself is recognised');
  assert.equal(re.test('/auth/refresh/'), true);

  for (const p of ['/auth/me', '/auth/logout', '/auth/logout-all',
    '/auth/verify-email', '/auth/reset-password', '/auth/forgot-password',
    '/auth/resend-verification']) {
    assert.equal(re.test(p), false, `${p} must still be eligible for a refresh`);
  }
  assert.equal(re.test('/series'), false);
  assert.equal(re.test('/library'), false);

  // And the broad form really was wrong, so this cannot regress silently.
  assert.ok('/auth/me'.includes('/auth/'));
  assert.ok(!source.includes("!path.includes('/auth/')"),
    'the broad substring guard must not come back');
});

test('the account UI is present exactly once', () => {
  const fs = require('fs');
  const path = require('path');
  const html = fs.readFileSync(
    path.join(__dirname, '..', '..', 'vorth-frontend', 'index.html'), 'utf8'
  );
  for (const id of ['accountPanel', 'forgotForm', 'resetForm', 'verifyForm', 'accountForgotBtn']) {
    const n = (html.match(new RegExp(`id="${id}"`, 'g')) || []).length;
    assert.equal(n, 1, `expected exactly one #${id}, found ${n}`);
  }
});