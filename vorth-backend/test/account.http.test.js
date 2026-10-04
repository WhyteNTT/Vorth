'use strict';

/**
 * The success paths of email verification and password reset.
 *
 * session.test.js already covers the failures: a token that matches nothing, a
 * malformed address, a missing token, resend behind auth. Those are the easy
 * half. This file covers the half that changes an account, where the assertions
 * have to be about what got written and what got revoked - a reset that returns
 * 200 without revoking sessions is indistinguishable from a working one from the
 * outside, and leaves a stolen session alive.
 */

process.env.DATABASE_URL ||= 'postgres://stub/stub';
process.env.DATABASE_SSL = 'false';
process.env.JWT_SECRET ||= 'test-secret';
process.env.NODE_ENV = 'test';
process.env.MAIL_TRANSPORT = 'disabled';
process.env.RATE_LIMIT_MAX_REQUESTS = '100000';
process.env.AUTH_RATE_LIMIT_MAX_REQUESTS = '100000';

const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const { createFakePool, seedRow } = require('./helpers/fakePool');

const mailer = require('../src/services/mailer');
const JWT_SECRET = process.env.JWT_SECRET;

const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';

/** A well-formed token: long enough to pass the length validators. */
const GOOD_TOKEN = 'k'.repeat(44);

async function withServer(opts, fn) {
  const fake = createFakePool(opts);
  const db = require('../src/config/db');
  const Base = require('../src/models/_base');
  Base._clearColumnCache();
  db.setPool(fake);

  const app = require('../src/app');
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const { port } = server.address();

  const call = async (method, path, { token, body } = {}) => {
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (_) { /* not JSON */ }
    return { status: res.status, body: json, text };
  };

  try {
    return await fn({
      call, fake,
      sql: () => fake.log.map((e) => e.sql),
      updates: (re) => fake.log.filter((e) => e.verb === 'UPDATE' && re.test(e.sql)),
      token: (id, role = 'user') => jwt.sign({ id, role }, JWT_SECRET),
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    db.setPool(null);
    Base._clearColumnCache();
  }
}

const alice = (over = {}) => seedRow('users', {
  id: ALICE, username: 'alice', display_name: 'Alice',
  email: 'alice@example.com', role: 'user', is_banned: false, ...over,
});

/** Runs `fn` with mailer.send replaced, restoring the real one afterwards. */
async function withMail(stub, fn) {
  const real = mailer.send;
  const sent = [];
  mailer.send = async (msg) => { sent.push(msg); return stub(msg, sent); };
  try {
    return await fn(sent);
  } finally {
    mailer.send = real;
  }
}

/* ================================================================== *
 * Password reset
 * ================================================================== */

test('a valid reset token changes the password and kills every session', async () => {
  await withServer({
    rows: { users: [alice({ password: 'old-hash' })] },
    // The consume() UPDATE yields the token row, so the happy path runs.
    echoRow: { id: 'tok-1', user: ALICE, purpose: 'password_reset' },
  }, async ({ call, sql, updates }) => {
    const res = await call('POST', '/api/auth/reset-password', {
      body: { token: GOOD_TOKEN, newPassword: 'a-much-longer-password' },
    });

    assert.equal(res.status, 200, `reset failed: ${res.status} ${res.text}`);

    // The token was consumed, not merely looked at.
    const consume = updates(/UPDATE "auth_tokens"/);
    assert.equal(consume.length, 1, 'the token was not consumed');
    assert.match(consume[0].sql, /"consumed_at" = now\(\)/);
    assert.match(consume[0].sql, /"consumed_at" IS NULL/,
      'the consume lost its single-use guard');
    assert.match(consume[0].sql, /"expires_at" > now\(\)/,
      'the consume lost its expiry guard');

    // The password was rewritten - as a hash. Asserting the plaintext is absent
    // matters more than asserting it is present: this is the one statement where
    // a password could reach the database in the clear.
    const wrote = updates(/UPDATE "users"/);
    assert.equal(wrote.length, 1, 'the password was not written');
    const params = wrote[0].params.map(String);
    assert.ok(!params.includes('a-much-longer-password'),
      'the new password was written to the database in plaintext');
    assert.ok(params.some((p) => p.startsWith('$2')),
      `no bcrypt hash reached the database; params were ${JSON.stringify(params)}`);

    // And every existing session was revoked. This is the assertion that makes
    // the endpoint worth having: without it, a reset leaves stolen refresh
    // tokens working, and the user believes they have locked the attacker out.
    const revoked = sql().filter((s) => /UPDATE "refresh_tokens"/.test(s));
    assert.equal(revoked.length, 1, 'sessions survived a password change');
    assert.ok(revoked[0].includes('"revoked_at" = now()'),
      'refresh tokens were touched but not revoked');
  });
});

test('a reset that finds no usable token changes nothing', async () => {
  await withServer({
    rows: { users: [alice()] },
    emptyReturning: /UPDATE "auth_tokens"/,
  }, async ({ call, sql }) => {
    const res = await call('POST', '/api/auth/reset-password', {
      body: { token: GOOD_TOKEN, newPassword: 'a-much-longer-password' },
    });

    assert.equal(res.status, 400);
    assert.match(res.body.message, /invalid or has expired/);
    assert.equal(sql().some((s) => /UPDATE "users"/.test(s)), false,
      'a password was written without a valid token');
    assert.equal(sql().some((s) => /UPDATE "refresh_tokens"/.test(s)), false,
      'sessions were revoked for a reset that never happened');
  });
});

test('a reset token cannot be redeemed for a different purpose', async () => {
  // The consume guard carries the purpose, so an email-verification token is
  // not a password-reset token. Asserted against the statement, because the
  // double answers every UPDATE identically and a 200 here would look like a
  // broken double rather than a broken guard.
  await withServer({
    rows: { users: [alice()] },
    echoRow: { id: 'tok-1', user: ALICE, purpose: 'email_verification' },
  }, async ({ call, sql }) => {
    await call('POST', '/api/auth/reset-password', {
      body: { token: GOOD_TOKEN, newPassword: 'a-much-longer-password' },
    });

    const consume = sql().find((s) => /UPDATE "auth_tokens"/.test(s));
    assert.ok(consume, 'the token was not looked up at all');
    assert.match(consume, /"purpose" = \$2/, 'the purpose is not part of the consume guard');
  });
});

test('reset refuses a password the account policy would not accept', async () => {
  await withServer({
    rows: { users: [alice()] },
    echoRow: { id: 'tok-1', user: ALICE, purpose: 'password_reset' },
  }, async ({ call, sql }) => {
    for (const newPassword of ['short', '', '       ']) {
      const res = await call('POST', '/api/auth/reset-password', {
        body: { token: GOOD_TOKEN, newPassword },
      });
      assert.equal(res.status, 400, `"${newPassword}" was accepted as a password`);
    }
    assert.equal(sql().some((s) => /UPDATE "auth_tokens"/.test(s)), false,
      'the token was consumed by a request that then failed validation');
  });
});

/* ================================================================== *
 * Email verification
 * ================================================================== */

test('a valid verification token marks the address verified', async () => {
  await withServer({
    rows: { users: [alice({ email_verified_at: null })] },
    echoRow: { id: 'tok-2', user: ALICE, purpose: 'email_verification' },
  }, async ({ call, updates }) => {
    const res = await call('POST', '/api/auth/verify-email', { body: { token: GOOD_TOKEN } });
    assert.equal(res.status, 200, `verify failed: ${res.status} ${res.text}`);

    const wrote = updates(/UPDATE "users"/);
    assert.equal(wrote.length, 1, 'the verified timestamp was not written');
    assert.match(wrote[0].sql, /"email_verified_at"/);
  });
});

test('verification for an account that no longer exists is refused', async () => {
  // A live token outliving the account it points at must not 500.
  await withServer({
    rows: { users: [] },
    echoRow: { id: 'tok-3', user: '99999999-9999-4999-8999-999999999999', purpose: 'email_verification' },
  }, async ({ call, sql }) => {
    const res = await call('POST', '/api/auth/verify-email', { body: { token: GOOD_TOKEN } });
    assert.equal(res.status, 400);
    assert.equal(sql().some((s) => /UPDATE "users"/.test(s)), false);
  });
});

test('resend-verification can only ever probe the caller\'s own address', async () => {
  /*
   * The wording does differ between the branches - "Verification link sent."
   * against "If that address needs verifying, a link is on its way." - which looks
   * like an account-state oracle. It is not one, and the reason is worth pinning,
   * because the comment in the controller credits the wrong property:
   *
   *   - the route is behind protect, so the caller must hold a session;
   *   - the lookup key is req.user.email, not anything in the request body.
   *
   * So the only address that can be probed is the caller's own, which they
   * already know. Change the key to req.body.email and this test starts failing,
   * which is exactly the regression that would matter.
   */
  await withServer({
    rows: { users: [alice({ email_verified_at: null }), seedRow('users', {
      id: BOB, username: 'bob', email: 'bob@example.com', role: 'user',
      email_verified_at: null,
    })] },
  }, async ({ call, sql }) => withMail(async () => {}, async (sent) => {
    // Alice asks. Bob's address is supplied in the body, as attacker input.
    const res = await call('POST', '/api/auth/resend-verification', {
      token: jwt.sign({ id: ALICE, role: 'user' }, JWT_SECRET),
      body: { email: 'bob@example.com' },
    });

    assert.equal(res.status, 200);
    assert.equal(sent.length, 1, 'no verification mail was sent to an unverified account');
    assert.equal(sent[0].to, 'alice@example.com',
      'the link went to an address taken from the request rather than the session');

    const looked = sql().filter((s) => /FROM "users"/.test(s) && /"email" =/.test(s));
    assert.ok(looked.length > 0, 'no user was looked up at all');
    assert.ok(
      looked.every((s) => !s.includes('bob@example.com')),
      'bob@example.com reached the lookup, so the endpoint can probe other accounts'
    );
  }));
});

test('resending answers 200 whether or not there is anything to do', async () => {
  /*
   * Two cases, not three. The controller also branches on !user, but that branch
   * cannot be reached over HTTP: protect has already loaded the row for this
   * session, and the handler looks the account up by req.user.email. A caller
   * with no account gets 401 from protect before the handler runs. The branch is
   * still correct as a guard against the row vanishing between the two queries,
   * but asserting it here would only be asserting that the double is permissive.
   */
  for (const [label, rows] of [
    ['unverified', [alice({ email_verified_at: null })]],
    ['already verified', [alice({ email_verified_at: new Date('2024-05-05T00:00:00Z') })]],
  ]) {
    await withServer({ rows: { users: rows } },
      async ({ call }) => withMail(async () => {}, async (sent) => {
        const res = await call('POST', '/api/auth/resend-verification', {
          token: jwt.sign({ id: ALICE, role: 'user' }, JWT_SECRET),
        });
        assert.equal(res.status, 200, `the "${label}" case answered ${res.status}`);
        if (label !== 'unverified') {
          assert.equal(sent.length, 0, `the "${label}" case was sent a needless mail`);
        }
      })
    );
  }

  // And the unreachable case is unreachable for the stated reason, not by luck.
  await withServer({ rows: { users: [] } }, async ({ call }) => {
    const res = await call('POST', '/api/auth/resend-verification', {
      token: jwt.sign({ id: ALICE, role: 'user' }, JWT_SECRET),
    });
    assert.equal(res.status, 401, 'a session with no account reached the handler');
  });
});

/* ================================================================== *
 * Mail failure
 * ================================================================== */

test('a mail server outage does not fail a reset request', async () => {
  /*
   * The mail is inside a try/catch on purpose. A reset that 500s because SMTP is
   * down tells the user nothing useful and, worse, is retried - so the tokens
   * keep being invalidated and the mail never arrives. The endpoint has to
   * succeed either way; what the user sees is identical by design.
   */
  await withServer({ rows: { users: [alice({ is_banned: false })] } },
    async ({ call, sql }) => withMail(async () => { throw new Error('ECONNREFUSED 10.0.0.25:587'); },
      async () => {
        const res = await call('POST', '/api/auth/forgot-password', {
          body: { email: 'alice@example.com' },
        });
        assert.equal(res.status, 200, `a mail outage turned a reset request into ${res.status}`);
        assert.match(res.body.message, /If that address has an account/);
        // The token was still issued, so the link the user is waiting for is
        // recoverable by resending.
        assert.ok(sql().some((s) => /INSERT INTO "auth_tokens"/.test(s)),
          'no reset token was issued, so the request can never be completed');
      }));
});

test('a banned account is told nothing happens', async () => {
  await withServer({ rows: { users: [alice({ is_banned: true })] } },
    async ({ call, sql }) => withMail(async () => {}, async (sent) => {
      const res = await call('POST', '/api/auth/forgot-password', { body: { email: 'alice@example.com' } });
      assert.equal(res.status, 200);
      assert.equal(sent.length, 0, 'a suspended account was sent a reset link');
      assert.equal(sql().some((s) => /INSERT INTO "auth_tokens"/.test(s)), false,
        'a reset token was issued for a suspended account');
    }));
});

test('forgot-password invalidates any outstanding reset link first', async () => {
  // Otherwise the older link still works, which is the opposite of what a
  // second request means: "I did not ask for that one."
  await withServer({ rows: { users: [alice({ is_banned: false })] } },
    async ({ call, sql }) => withMail(async () => {}, async () => {
      await call('POST', '/api/auth/forgot-password', { body: { email: 'alice@example.com' } });

      const order = sql();
      const invalidate = order.findIndex((s) => /UPDATE "auth_tokens"/.test(s));
      const issue = order.findIndex((s) => /INSERT INTO "auth_tokens"/.test(s));
      assert.ok(invalidate >= 0, 'the previous reset links were not invalidated');
      assert.ok(issue >= 0, 'no new reset token was issued');
      assert.ok(invalidate < issue, 'the new token was issued before the old ones were revoked');
    }));
});