'use strict';

/**
 * Ownership, proved by making the request as somebody else.
 *
 * authMatrix.test.js has a static check that ownership logic exists somewhere
 * reachable. It is a tripwire for omission and nothing more, and it is worth
 * being precise about the gap: replacing the guard in requireChapterOwner with
 * `if (false)` - so every non-owner is admitted - leaves the words "owner" and
 * "req.user" in that file, and the static check passes.
 *
 * So this file is the proof. Each route that acts on somebody else's data is
 * called as a signed-in stranger who has no claim on it, and the answer has to be
 * 403 or 404. Never 200, and never 500 - a 500 on this path is information too,
 * and an internal error message would name the table it was working on.
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

const JWT_SECRET = process.env.JWT_SECRET;

/** Alice owns the series. Bob is the stranger. Root is an admin, and a plain one. */
const OWNER = '11111111-1111-4111-8111-111111111111';
const STRANGER = '22222222-2222-4222-8222-222222222222';
const ADMIN = '33333333-3333-4333-8333-333333333333';
const PLAIN = '44444444-4444-4444-8444-444444444444';

const SERIES = '55555555-5555-4555-8555-555555555555';
const CHAPTER = '66666666-6666-4666-8666-666666666666';
const COMMENT = '77777777-7777-4777-8777-777777777777';
const NOTE = '88888888-8888-4888-8888-888888888888';

const user = (id, over = {}) => seedRow('users', {
  id, username: `u${id.slice(0, 4)}`, email: `${id.slice(0, 4)}@example.com`,
  role: 'user', is_banned: false, ...over,
});

/**
 * Alice's world: she owns the series, the comment and the notification.
 *
 * The saved-series list and the offline downloads are JSONB arrays on the user
 * row (`users.library`, `users.downloads`), not tables of their own. Seeding
 * them here rather than as separate fixtures is what made this read correctly the
 * first time - there is no `library` table to seed.
 */
function world(over = {}) {
  const ownerRow = user(OWNER, {
    library: [SERIES],
    downloads: [{ chapter: CHAPTER, series: SERIES }],
  });
  return {
    users: [ownerRow, user(STRANGER), user(ADMIN, { role: 'admin' }), user(PLAIN)],
    series: [seedRow('series', {
      id: SERIES, title: 'A Series', slug: 'a-series', type: 'novel',
      owner: OWNER, author: 'Someone', status: 'Ongoing', synopsis: 'x',
      genres: [], tags: [], views: { daily: 0, weekly: 0, alltime: 0 },
      rating_avg: 0, rating_count: 0, chapter_count: 1, is_removed: false,
    })],
    chapters: [seedRow('chapters', {
      id: CHAPTER, series: SERIES, num: 1, title: 'One',
      paragraphs: ['p'], is_removed: false,
    })],
    comments: [seedRow('comments', {
      id: COMMENT, series: SERIES, user: OWNER, rating: 5, text: 'mine', is_removed: false,
    })],
    notifications: [seedRow('notifications', {
      id: NOTE, user: OWNER, type: 'comment_reply', message: 'x', is_read: false,
    })],
    reading_progress: [seedRow('reading_progress', {
      id: 'rp-1', user: OWNER, series: SERIES, chapter: CHAPTER, type: 'novel',
      scroll_pct: 0.5, page: 1, bookmarked: false,
    })],
    ...over,
  };
}

async function withServer(rows, fn) {
  const fake = createFakePool({ rows });
  const db = require('../src/config/db');
  const Base = require('../src/models/_base');
  Base._clearColumnCache();
  db.setPool(fake);

  const app = require('../src/app');
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const { port } = server.address();

  const call = async (method, path, { as, body } = {}) => {
    const headers = {};
    if (as) headers.Authorization = `Bearer ${jwt.sign({ id: as, role: 'user' }, JWT_SECRET)}`;
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
    return await fn({ call, fake, sql: () => fake.log.map((e) => e.sql) });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    db.setPool(null);
    Base._clearColumnCache();
  }
}

/**
 * Every route that *changes* another person's data, and what a stranger must get.
 *
 * 403 and 404 are both acceptable: 404 is often the better answer, since it does
 * not confirm the thing exists. 200 is never acceptable. 500 is not either - it
 * means the guard threw rather than answered.
 *
 * Only mutating routes are here. A read of a per-user collection correctly
 * answers 200 with an empty list rather than a refusal, so those are proved
 * separately below.
 */
const CASES = [
  {
    method: 'PATCH', path: `/api/series/${SERIES}`, body: { title: 'Hijacked' },
    why: 'only the publisher may edit a series',
  },
  {
    method: 'DELETE', path: `/api/series/${SERIES}`,
    why: 'only the publisher may delete a series',
  },
  {
    method: 'POST', path: `/api/series/${SERIES}/chapters`,
    body: { title: 'Injected', paragraphs: ['x'] },
    why: 'only the publisher may add a chapter',
  },
  {
    method: 'PATCH', path: `/api/chapters/${CHAPTER}`, body: { title: 'Hijacked' },
    why: 'only the publisher may edit a chapter',
  },
  {
    method: 'DELETE', path: `/api/chapters/${CHAPTER}`,
    why: 'only the publisher may delete a chapter',
  },
  {
    method: 'DELETE', path: `/api/comments/${COMMENT}`,
    why: "only the comment's author or an admin may remove it",
  },
  {
    method: 'PATCH', path: `/api/notifications/${NOTE}/read`,
    why: "only the notification's recipient may mark it read",
  },
];

/**
 * Routes that act on the caller's own state, where there is nothing to enforce
 * because the operation is scoped to req.user by construction.
 *
 * They are listed because "a stranger gets a 403" is the wrong expectation for
 * them: removing something you do not have is a no-op that should succeed, not a
 * refusal. What matters is that it touches nobody else's row, which is asserted
 * by checking the response echoes the caller's own - empty - state.
 *
 * The download list is the interesting one. It is a JSONB array on the user row,
 * and this is the exact case that caught the double handing a save() somebody
 * else's row: the answer came back carrying another user's downloads.
 */
const CALLER_SCOPED = [
  { method: 'DELETE', path: `/api/library/downloads/${CHAPTER}`, field: 'downloads' },
  { method: 'DELETE', path: `/api/library/${SERIES}`, field: 'library' },
];

test('a caller-scoped route touches only the caller\'s own state', async () => {
  for (const c of CALLER_SCOPED) {
    await withServer(world(), async ({ call }) => {
      const res = await call(c.method, c.path, { as: STRANGER, body: c.body });
      assert.ok(res.status < 400,
        `${c.method} ${c.path} refused a harmless no-op with ${res.status}`);

      const value = res.body ? res.body[c.field] : undefined;
      assert.ok(value === undefined || value === null || (Array.isArray(value) && value.length === 0),
        `${c.method} ${c.path} returned another user's ${c.field} to a stranger: `
        + JSON.stringify(value));
      assert.doesNotMatch(JSON.stringify(res.body), new RegExp(SERIES),
        `${c.method} ${c.path} echoed the owner's series back to a stranger`);
    });
  }
});

test('a stranger cannot touch another user\'s data, on any route', async () => {
  for (const c of CASES) {
    await withServer(world(), async ({ call, sql }) => {
      const res = await call(c.method, c.path, { as: STRANGER, body: c.body });

      assert.ok(
        res.status === 403 || res.status === 404,
        `${c.method} ${c.path} answered a stranger with ${res.status} - ${c.why}. `
        + `Body: ${res.text.slice(0, 200)}`
      );

      // And nothing was written. A guard that refuses with 403 and then mutates
      // the row anyway has still leaked the change; only the statement log shows
      // that, so the status code alone is not enough.
      const writes = sql().filter((s) => /^(INSERT|UPDATE|DELETE)\b/.test(s));
      assert.deepEqual(writes, [],
        `${c.method} ${c.path} answered ${res.status} but still ran:\n  ${writes.join('\n  ')}`);
    });
  }
});

test('a stranger sees empty per-user collections rather than another user\'s rows', async () => {
  const reads = [
    { path: '/api/library', pick: (b) => (b.library || b.series || []).length },
    { path: '/api/progress', pick: (b) => (b.progress || []).length },
    { path: '/api/notifications', pick: (b) => (b.notifications || []).length },
  ];

  for (const r of reads) {
    await withServer(world(), async ({ call }) => {
      const mine = await call('GET', r.path, { as: OWNER });
      const theirs = await call('GET', r.path, { as: STRANGER });

      assert.equal(mine.status, 200);
      assert.equal(theirs.status, 200);
      assert.ok(r.pick(mine.body) > 0, `${r.path} returned nothing for the owner; the test proves nothing`);
      assert.equal(r.pick(theirs.body), 0,
        `${r.path} returned another user's rows to a stranger`);
    });
  }
});

test('an admin may act on another user\'s series, and a plain user may not', async () => {
  // The other half of the contract. An ownership check that also refuses admins
  // is a broken product, and only testing the refusal would not notice.
  await withServer(world(), async ({ call }) => {
    const asAdmin = await call('DELETE', `/api/series/${SERIES}`, { as: ADMIN });
    assert.ok(asAdmin.status < 400,
      `an admin could not delete a series: ${asAdmin.status} ${asAdmin.text}`);
  });

  await withServer(world(), async ({ call }) => {
    const asPlain = await call('DELETE', `/api/series/${SERIES}`, { as: PLAIN });
    assert.ok(asPlain.status === 403 || asPlain.status === 404,
      `a normal user deleted a series they do not own: ${asPlain.status}`);
  });
});

test('an owner may act on their own series', async () => {
  // The refusal tests would all still pass against a handler that refuses
  // everyone. Without this, "ownership enforced" and "ownership broken" are the
  // same passing state.
  await withServer(world(), async ({ call }) => {
    assert.equal((await call('PATCH', `/api/series/${SERIES}`, {
      as: OWNER, body: { title: 'A Series, revised' },
    })).status, 200);

    assert.equal((await call('PATCH', `/api/chapters/${CHAPTER}`, {
      as: OWNER, body: { title: 'One, revised' },
    })).status, 200);

    assert.equal((await call('POST', `/api/series/${SERIES}/chapters`, {
      as: OWNER, body: { title: 'Two', paragraphs: ['x'] },
    })).status, 201);

    assert.equal((await call('DELETE', `/api/comments/${COMMENT}`, { as: OWNER })).status, 200,
      "the comment's own author could not remove it");
  });
});

test('a refusal names the caller\'s own action, not the other user\'s data', async () => {
  // Low value as a security property and high value as a leak check: an error
  // message is often the first place a database column name escapes.
  const leaks = /email_verified_at|users_email_key|relation |column |SELECT |INSERT INTO/i;

  for (const c of CASES.filter((x) => x.method !== 'GET')) {
    await withServer(world(), async ({ call }) => {
      const res = await call(c.method, c.path, { as: STRANGER, body: c.body });
      assert.ok(!leaks.test(res.text),
        `${c.method} ${c.path} leaked internals in its refusal: ${res.text.slice(0, 200)}`);
    });
  }
});