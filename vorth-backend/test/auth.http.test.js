'use strict';

/**
 * Registration, login, refresh, logout, password change.
 *
 * Two properties here are worth more than the rest of the file combined.
 *
 * Refresh-token rotation: a refresh token that is not revoked when redeemed stays
 * valid until it expires, so one stolen from a log or a proxy is a 30-day
 * account. The handler revokes the presented token before issuing a new one; a
 * test that only checks "refresh returns a token" passes with that line deleted.
 *
 * Enumeration resistance: login must answer identically for an unknown account
 * and a wrong password. The two cases differ internally - one skips the bcrypt
 * comparison entirely - so they are asserted together rather than in isolation.
 */

process.env.DATABASE_URL ||= 'postgres://stub/stub';
process.env.DATABASE_SSL = 'false';
process.env.JWT_SECRET ||= 'test-secret';
process.env.NODE_ENV = 'test';
process.env.MAIL_TRANSPORT = 'disabled';
process.env.REQUIRE_EMAIL_VERIFICATION = 'false';
process.env.RATE_LIMIT_MAX_REQUESTS = '100000';
process.env.AUTH_RATE_LIMIT_MAX_REQUESTS = '100000';
process.env.LOGIN_RATE_LIMIT_MAX_REQUESTS = '100000';

const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const { createFakePool, seedRow } = require('./helpers/fakePool');
const { hashToken } = require('../src/utils/tokens');

const ALICE = '11111111-1111-4111-8111-111111111111';

/** bcrypt at a low cost: these fixtures are verified, not attacked. */
const hashOf = (plain) => bcrypt.hashSync(plain, 4);

async function withServer(opts, fn) {
  const fake = createFakePool(opts);
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
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (_) { /* not JSON */ }
    return { status: res.status, body: json, text, headers: res.headers };
  };

  try {
    return await fn({
      call, fake,
      sql: () => fake.log.map((e) => e.sql),
      updates: (re) => fake.log.filter((e) => e.verb === 'UPDATE' && re.test(e.sql)),
      jwt: require('jsonwebtoken'),
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    db.setPool(null);
    Base._clearColumnCache();
  }
}

const alice = (over = {}) => seedRow('users', {
  id: ALICE, username: 'alice', display_name: 'Alice', email: 'alice@example.com',
  role: 'user', is_banned: false, password: hashOf('correct horse'), ...over,
});

/**
 * A live refresh token row for `raw`.
 *
 * findActive looks the row up by `tokenHash = hashToken(raw)` and then checks the
 * expiry in JavaScript, so seeding an arbitrary hash or a past date makes the
 * lookup miss for reasons that have nothing to do with the handler. Both fields
 * therefore have to be real.
 */
const liveToken = (user, raw, over = {}) => seedRow('refresh_tokens', {
  id: 'rt-1', user, token_hash: hashToken(raw), revoked_at: null,
  expires_at: new Date(Date.now() + 86400000), ...over,
});

/**
 * Parses Set-Cookie headers.
 *
 * Attribute names are lower-cased; values keep their case, because an Expires
 * date contains a colon and would otherwise be split into nonsense. `raw` is
 * kept so a test can ask about an attribute whose shape a map would flatten.
 */
function setCookies(res) {
  const raw = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : [res.headers.get('set-cookie')].filter(Boolean);
  return raw.map((c) => {
    const parts = c.split(';').map((p) => p.trim());
    const [pair, ...attrs] = parts;
    const i = pair.indexOf('=');
    const map = Object.fromEntries(attrs.map((a) => {
      const j = a.indexOf('=');
      return j === -1
        ? [a.split(':')[0].toLowerCase(), true]
        : [a.slice(0, j).trim().toLowerCase(), a.slice(j + 1).trim()];
    }));
    map.name = i === -1 ? '' : pair.slice(0, i).trim();
    map.value = i === -1 ? '' : pair.slice(i + 1).trim();
    map.raw = c;
    return map;
  });
}

/** A Set-Cookie that instructs the browser to drop the cookie now. */
const isClearing = (c) => /expires=thu, 01 jan 1970/i.test(c.raw)
  || /max-age=0/i.test(c.raw)
  || (c.value === '' && c.path);

/* ================================================================== *
 * Login
 * ================================================================== */

test('login answers identically for an unknown account and a wrong password', async () => {
  const wrong = await withServer({ rows: { users: [] } }, async ({ call }) => call('POST', '/api/auth/login', {
    body: { identifier: 'nobody', password: 'whatever' },
  }));

  const badPass = await withServer({ rows: { users: [alice()] } }, async ({ call }) => call('POST', '/api/auth/login', {
    body: { identifier: 'alice', password: 'not the password' },
  }));

  assert.equal(wrong.status, badPass.status);
  assert.deepEqual(wrong.body, badPass.body,
    'the two cases differ, so login can be used to enumerate accounts');

  const known = await withServer({ rows: { users: [alice()] } }, async ({ call }) => call('POST', '/api/auth/login', {
    body: { identifier: 'alice', password: 'wrong too' },
  }));
  assert.deepEqual(known.body, badPass.body,
    'the email form of the identifier behaves differently from the username form');
});

test('login works with either the username or the email, case-insensitively', async () => {
  for (const identifier of ['alice', 'ALICE', 'Alice', 'alice@example.com', 'ALICE@EXAMPLE.COM']) {
    const res = await withServer({ rows: { users: [alice()] } },
      async ({ call }) => call('POST', '/api/auth/login', {
        body: { identifier, password: 'correct horse' },
      }));
    assert.equal(res.status, 200, `"${identifier}" did not sign in`);
    assert.equal(res.body.user.username, 'alice');
  }
});

test('a successful login issues a session and returns nothing secret', async () => {
  await withServer({ rows: { users: [alice({ password: hashOf('correct horse') })] } },
    async ({ call, sql }) => {
      const res = await call('POST', '/api/auth/login', {
        body: { identifier: 'alice', password: 'correct horse' },
      });

      assert.equal(res.status, 200);
      assert.equal(res.body.success, true);
      assert.ok(res.body.token, 'no access token was returned');

      // The user object goes to the client. It must not contain the hash.
      const serialised = JSON.stringify(res.body.user);
      assert.ok(!('password' in res.body.user), 'the user object carries a password field');
      assert.doesNotMatch(serialised, /\$2[aby]\$/, 'a bcrypt hash reached the client');
      assert.ok(sql().some((s) => /INSERT INTO "refresh_tokens"/.test(s)),
        'no refresh token row was written');
    });
});

test('the refresh cookie is httpOnly, path-scoped and SameSite=Lax', async () => {
  await withServer({ rows: { users: [alice()] } }, async ({ call }) => {
    const res = await call('POST', '/api/auth/login', {
      body: { identifier: 'alice', password: 'correct horse' },
    });

    const cookie = setCookies(res).find((c) => c.name === 'vorth_refresh');
    assert.ok(cookie, `no refresh cookie was set; got ${JSON.stringify(setCookies(res))}`);

    assert.equal(cookie.httponly, true,
      'the refresh cookie is readable by JavaScript, which defeats the point of it');
    assert.equal(cookie.samesite, 'Lax');
    assert.equal(cookie.path, '/api/auth',
      'the cookie is not scoped to the auth routes');
    assert.ok(cookie.value.length > 0, 'the refresh cookie was set empty');
  });
});

test('a banned account is refused with a reason, not a generic failure', async () => {
  const res = await withServer({ rows: { users: [alice({ is_banned: true })] } },
    async ({ call }) => call('POST', '/api/auth/login', {
      body: { identifier: 'alice', password: 'correct horse' },
    }));
  assert.equal(res.status, 403);
  assert.match(res.body.message, /suspended/);
});

test('login refuses empty credentials before touching the database', async () => {
  await withServer({ rows: { users: [alice()] } }, async ({ call, sql }) => {
    for (const body of [{}, { identifier: 'alice' }, { password: 'x' }, { identifier: '   ', password: 'x' }]) {
      const res = await call('POST', '/api/auth/login', { body });
      assert.equal(res.status, 400, `${JSON.stringify(body)} was not refused`);
    }
    assert.equal(sql().some((s) => /FROM "users"/.test(s)), false,
      'an invalid login reached the database');
  });
});

/* ================================================================== *
 * Registration
 * ================================================================== */

test('registration requires the legal confirmations, and they must be affirmative', async () => {
  await withServer({ rows: { users: [] } }, async ({ call, sql }) => {
    const complete = {
      displayName: 'Alice', username: 'alice', email: 'alice@example.com',
      password: 'long enough', agreedToTerms: 'true', ageConfirmed: 'true',
    };

    for (const missing of ['agreedToTerms', 'ageConfirmed']) {
      const body = { ...complete };
      delete body[missing];
      const res = await call('POST', '/api/auth/register', { body });
      assert.equal(res.status, 400, `registering without ${missing} was allowed`);
    }

    for (const value of ['false', false, 'no', '', '1', 0]) {
      const res = await call('POST', '/api/auth/register', {
        body: { ...complete, agreedToTerms: value, ageConfirmed: value },
      });
      assert.equal(res.status, 400,
        `agreedToTerms=${JSON.stringify(value)} was accepted as consent`);
    }

    assert.equal(sql().some((s) => /INSERT INTO "users"/.test(s)), false);
  });
});

test('the username is normalised and its format enforced', async () => {
  await withServer({ rows: { users: [] } }, async ({ call, fake }) => {
    await call('POST', '/api/auth/register', {
      body: {
        displayName: 'Alice', username: '  MiXeD_Case  ', email: 'a@example.com',
        password: 'long enough', agreedToTerms: true, ageConfirmed: true,
      },
    });

    const insert = fake.log.find((e) => /INSERT INTO "users"/.test(e.sql));
    assert.ok(insert, 'no user row was inserted');
    assert.ok(insert.params.includes('mixed_case'),
      `the username was not lowercased before storage: ${JSON.stringify(insert.params)}`);
  });

  await withServer({ rows: { users: [] } }, async ({ call }) => {
    for (const username of ['ab', 'a'.repeat(25), 'has space', 'has-dash', 'emoji✨', '']) {
      const res = await call('POST', '/api/auth/register', {
        body: {
          displayName: 'Alice', username, email: 'a@example.com',
          password: 'long enough', agreedToTerms: true, ageConfirmed: true,
        },
      });
      assert.equal(res.status, 400, `username ${JSON.stringify(username)} was accepted`);
    }
  });
});

test('registering over an existing account names the colliding field', async () => {
  // Unlike login, this has to say which field collided: the caller is claiming a
  // name, not probing for one, and "that username is taken" is the whole point.
  const byName = await withServer({ rows: { users: [alice()] } }, async ({ call }) => call('POST', '/api/auth/register', {
    body: {
      displayName: 'Impostor', username: 'alice', email: 'other@example.com',
      password: 'long enough', agreedToTerms: true, ageConfirmed: true,
    },
  }));
  assert.equal(byName.status, 409);
  assert.match(byName.body.message, /username/);

  const byEmail = await withServer({ rows: { users: [alice()] } }, async ({ call }) => call('POST', '/api/auth/register', {
    body: {
      displayName: 'Impostor', username: 'impostor', email: 'alice@example.com',
      password: 'long enough', agreedToTerms: true, ageConfirmed: true,
    },
  }));
  assert.equal(byEmail.status, 409);
  assert.match(byEmail.body.message, /email/);
});

/* ================================================================== *
 * Refresh
 * ================================================================== */

test('refreshing revokes the presented token before issuing a new one', async () => {
  const presented = 'a'.repeat(64);
  await withServer({
    rows: { users: [alice()], refresh_tokens: [liveToken(ALICE, presented)] },
    echoRow: { id: 'rt-2', user: ALICE, token_hash: hashToken('b'.repeat(64)) },
  }, async ({ call, sql }) => {
    const res = await call('POST', '/api/auth/refresh', { body: { refreshToken: presented } });
    assert.equal(res.status, 200, `refresh failed: ${res.status} ${res.text}`);

    const revoke = sql().filter((s) => /UPDATE "refresh_tokens"/.test(s));
    assert.equal(revoke.length, 1, 'the presented refresh token was not revoked');
    assert.match(revoke[0], /"revoked_at"/, 'the revoke did not set revoked_at');

    const order = sql();
    assert.ok(
      order.findIndex((s) => /UPDATE "refresh_tokens"/.test(s))
        < order.findIndex((s) => /INSERT INTO "refresh_tokens"/.test(s)),
      'the new token was issued before the old one was revoked, so a replay window exists'
    );
  });
});

test('refresh refuses when there is no session to refresh', async () => {
  await withServer({ rows: { users: [alice()] } }, async ({ call }) => {
    const res = await call('POST', '/api/auth/refresh', { body: {} });
    assert.equal(res.status, 401);
    assert.match(res.body.message, /no session/i);
  });
});

test('an unknown or already-used refresh token is refused and clears the cookie', async () => {
  await withServer({ rows: { users: [alice()] } }, async ({ call, sql }) => {
    // findActive finds nothing, so the handler must clear the cookie - otherwise
    // the browser keeps presenting a dead token on every request.
    const res = await call('POST', '/api/auth/refresh', { body: { refreshToken: 'b'.repeat(64) } });
    assert.equal(res.status, 401);
    assert.match(res.body.message, /expired/i);

    const cleared = setCookies(res).find(isClearing);
    assert.ok(cleared, `the dead cookie was not cleared: ${JSON.stringify(setCookies(res))}`);
    assert.equal(sql().some((s) => /INSERT INTO "refresh_tokens"/.test(s)), false,
      'a new token was issued for a refresh that failed');
  });
});

test('a banned account cannot refresh, and its token is revoked as it fails', async () => {
  const presented = 'c'.repeat(64);
  await withServer({
    rows: { users: [alice({ is_banned: true })], refresh_tokens: [liveToken(ALICE, presented)] },
  }, async ({ call, sql }) => {
    const res = await call('POST', '/api/auth/refresh', { body: { refreshToken: presented } });
    assert.equal(res.status, 403);
    assert.ok(sql().some((s) => /UPDATE "refresh_tokens"/.test(s)),
      'the token of a banned account was left usable');
    assert.equal(sql().some((s) => /INSERT INTO "refresh_tokens"/.test(s)), false);
  });
});

/* ================================================================== *
 * Logout
 * ================================================================== */

test('logout revokes the presented token and always succeeds', async () => {
  const presented = 'd'.repeat(64);
  await withServer({
    rows: { users: [alice()], refresh_tokens: [liveToken(ALICE, presented)] },
  }, async ({ call, sql }) => {
    const res = await call('POST', '/api/auth/logout', { body: { refreshToken: presented } });
    assert.equal(res.status, 200);
    assert.ok(sql().some((s) => /UPDATE "refresh_tokens"/.test(s)), 'the token was not revoked');
  });

  // Logging out with nothing to revoke is not an error: signing out twice, or on
  // a device that never had a session, must still clear the client.
  await withServer({ rows: { users: [alice()] } }, async ({ call }) => {
    const res = await call('POST', '/api/auth/logout', { body: {} });
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
  });
});

test('logout-all needs a session and revokes everything for the caller', async () => {
  await withServer({ rows: { users: [alice()] } }, async ({ call, sql, jwt }) => {
    const anon = await call('POST', '/api/auth/logout-all');
    assert.equal(anon.status, 401);

    const res = await call('POST', '/api/auth/logout-all', {
      token: jwt.sign({ id: ALICE, role: 'user' }, process.env.JWT_SECRET),
    });
    assert.equal(res.status, 200);

    const revoke = sql().filter((s) => /UPDATE "refresh_tokens"/.test(s));
    assert.equal(revoke.length, 1, 'logout-all did not revoke the sessions');
    assert.match(revoke[0], /"revoked_at"/);
    // Scoped to the caller: revoking "all sessions" must not mean all users.
    assert.ok(revoke[0].includes('$1'), 'the revocation is not parameterised');
  });
});

/* ================================================================== *
 * Password change and profile
 * ================================================================== */

test('changing a password ends every session but keeps this one signed in', async () => {
  await withServer({ rows: { users: [alice()] } }, async ({ call, sql, jwt }) => {
    const res = await call('PATCH', '/api/auth/me/password', {
      token: jwt.sign({ id: ALICE, role: 'user' }, process.env.JWT_SECRET),
      body: { currentPassword: 'correct horse', newPassword: 'a new long password' },
    });

    assert.equal(res.status, 200, `change failed: ${res.status} ${res.text}`);
    assert.ok(sql().some((s) => /UPDATE "refresh_tokens"/.test(s)),
      'other sessions survived a password change');
    assert.ok(sql().some((s) => /INSERT INTO "refresh_tokens"/.test(s)),
      'this device was signed out by its own password change');

    const updated = sql().filter((s) => /UPDATE "users"/.test(s));
    assert.equal(updated.length, 1, 'the password was not written');
    assert.ok(!updated[0].includes('a new long password'),
      'the new password reached the database un-hashed');
  });
});

test('a password change refuses the wrong current password and changes nothing', async () => {
  await withServer({ rows: { users: [alice()] } }, async ({ call, sql, jwt }) => {
    const res = await call('PATCH', '/api/auth/me/password', {
      token: jwt.sign({ id: ALICE, role: 'user' }, process.env.JWT_SECRET),
      body: { currentPassword: 'not it', newPassword: 'a new long password' },
    });

    assert.equal(res.status, 401);
    assert.match(res.body.message, /current password is incorrect/i);
    assert.equal(sql().some((s) => /UPDATE "users"/.test(s)), false, 'the password changed anyway');
    assert.equal(sql().some((s) => /UPDATE "refresh_tokens"/.test(s)), false,
      'sessions were revoked by a change that did not happen');
  });
});

test('a short new password is refused before the current one is checked', async () => {
  await withServer({ rows: { users: [alice()] } }, async ({ call, sql, jwt }) => {
    const res = await call('PATCH', '/api/auth/me/password', {
      token: jwt.sign({ id: ALICE, role: 'user' }, process.env.JWT_SECRET),
      body: { currentPassword: 'correct horse', newPassword: 'short' },
    });
    assert.equal(res.status, 400);
    assert.equal(sql().some((s) => /UPDATE "users"/.test(s)), false);
  });
});

test('GET /me returns the caller and never the password', async () => {
  await withServer({ rows: { users: [alice()] } }, async ({ call, jwt }) => {
    assert.equal((await call('GET', '/api/auth/me')).status, 401);

    const res = await call('GET', '/api/auth/me', {
      token: jwt.sign({ id: ALICE, role: 'user' }, process.env.JWT_SECRET),
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.user.id, ALICE);
    assert.ok(!('password' in res.body.user), 'the password field reached the client');
    assert.doesNotMatch(res.text, /\$2[aby]\$/, 'a bcrypt hash reached the client');
  });
});

test('the profile is bounded, so a biography is not a storage attack', async () => {
  await withServer({ rows: { users: [alice()] } }, async ({ call, jwt }) => {
    const auth = { token: jwt.sign({ id: ALICE, role: 'user' }, process.env.JWT_SECRET) };

    for (const body of [{ bio: 'x'.repeat(301) }, { displayName: 'x'.repeat(61) }, { displayName: '   ' }]) {
      const res = await call('PATCH', '/api/auth/me', { ...auth, body });
      assert.equal(res.status, 400, `${JSON.stringify(body).slice(0, 30)} was accepted`);
    }

    const ok = await call('PATCH', '/api/auth/me', { ...auth, body: { bio: 'Reads a lot.' } });
    assert.equal(ok.status, 200);
  });
});