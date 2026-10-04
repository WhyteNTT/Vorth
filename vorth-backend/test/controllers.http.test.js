'use strict';

/**
 * HTTP coverage for the controllers the other suites barely touch.
 *
 * Measured, not guessed: this project sits at 88.34% statements overall, and
 * src/controllers at 76.06%, with commentController at 36.5% and *zero* of its
 * functions exercised. These are the routes a reader and a creator use on every
 * visit, so a regression in them is not a subtle loss of coverage - it is the
 * product.
 *
 * Every case runs against the real Express app with only the database replaced,
 * so routing, the auth middleware, the validation chains, the model layer and the
 * error handler are all the shipping ones. Where a case is really about SQL, the
 * companion live suite covers it; this file is about the HTTP contract and about
 * who is allowed to do what.
 */

process.env.DATABASE_URL ||= 'postgres://stub/stub';
process.env.DATABASE_SSL = 'false';
process.env.JWT_SECRET ||= 'test-secret';
process.env.NODE_ENV = 'test';
process.env.RATE_LIMIT_MAX_REQUESTS = '100000';
process.env.AUTH_RATE_LIMIT_MAX_REQUESTS = '100000';
process.env.DMCA_RATE_LIMIT_MAX_REQUESTS = '100000';

const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const { createFakePool, seedRow } = require('./helpers/fakePool');

const JWT_SECRET = process.env.JWT_SECRET;

const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const ADMIN = '33333333-3333-4333-8333-333333333333';
const SERIES = '44444444-4444-4444-8444-444444444444';
const CHAPTER = '55555555-5555-4555-8555-555555555555';
const COMMENT = '66666666-6666-4666-8666-666666666666';
const PARENT = '77777777-7777-4777-8777-777777777777';

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
    const text = await res.text();
    try { json = JSON.parse(text); } catch (_) { /* not JSON */ }
    return { status: res.status, body: json, text };
  };

  try {
    return await fn({
      call,
      fake,
      token: (id, role = 'user') => jwt.sign({ id, role }, JWT_SECRET),
      /** Every statement the pool was asked to run, as SQL. */
      statements: () => fake.log.map((e) => e.sql),
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    db.setPool(null);
    Base._clearColumnCache();
  }
}

const users = () => [
  seedRow('users', { id: ALICE, username: 'alice', display_name: 'Alice', email: 'a@x.test', role: 'user' }),
  seedRow('users', { id: BOB, username: 'bob', display_name: 'Bob', email: 'b@x.test', role: 'user' }),
  seedRow('users', { id: ADMIN, username: 'root', display_name: 'Root', email: 'r@x.test', role: 'admin' }),
];

const seriesRow = (over = {}) => seedRow('series', {
  id: SERIES, title: 'A Series', slug: 'a-series', type: 'novel', owner: ALICE,
  author: 'Someone', status: 'Ongoing', synopsis: 'x', genres: [], tags: [],
  views: { daily: 0, weekly: 0, alltime: 0 }, rating_avg: 0, rating_count: 0,
  chapter_count: 1, is_removed: false, rights_attested_at: new Date(), ...over,
});

/* ================================================================== *
 * Comments
 * ================================================================== */

test('GET comments is public, and hides a removed series behind 404', async () => {
  await withServer({
    users: users(),
    series: [seriesRow()],
    comments: [seedRow('comments', {
      id: COMMENT, series: SERIES, user: BOB, rating: 4, text: 'ok', is_removed: false,
    })],
  }, async ({ call }) => {
    const open = await call('GET', `/api/series/${SERIES}/comments`);
    assert.equal(open.status, 200, 'listing comments must not require a session');
    assert.equal(open.body.comments.length, 1);

    const gone = await call('GET', '/api/series/99999999-9999-4999-8999-999999999999/comments');
    assert.equal(gone.status, 404, 'an unknown series must 404, not return an empty list');
  });

  await withServer({
    users: users(),
    series: [seriesRow({ is_removed: true })],
    comments: [],
  }, async ({ call }) => {
    const hidden = await call('GET', `/api/series/${SERIES}/comments`);
    assert.equal(hidden.status, 404, 'a removed series must not serve its comments');
  });
});

test('POST comment requires a session and a valid rating', async () => {
  await withServer({ users: users(), series: [seriesRow()], comments: [] }, async ({ call, token }) => {
    const anon = await call('POST', `/api/series/${SERIES}/comments`, { body: { rating: 4, text: 'hi' } });
    assert.equal(anon.status, 401, 'posting a comment must require a session');

    for (const rating of [0, 6, 'four', null]) {
      const bad = await call('POST', `/api/series/${SERIES}/comments`, {
        token: token(BOB), body: { rating, text: 'hi' },
      });
      assert.equal(bad.status, 400, `rating ${JSON.stringify(rating)} should be refused`);
    }

    const empty = await call('POST', `/api/series/${SERIES}/comments`, {
      token: token(BOB), body: { rating: 4, text: '   ' },
    });
    assert.equal(empty.status, 400, 'whitespace-only text must be refused');
  });
});

test('POST comment refuses a parent that belongs to another series', async () => {
  await withServer({
    users: users(),
    series: [seriesRow()],
    // The parent exists, but not on this series.
    comments: [seedRow('comments', {
      id: PARENT, series: '88888888-8888-4888-8888-888888888888', user: BOB,
      rating: 3, text: 'parent', is_removed: false,
    })],
  }, async ({ call, token }) => {
    const res = await call('POST', `/api/series/${SERIES}/comments`, {
      token: token(ADMIN),
      body: { rating: 5, text: 'reply', parent: PARENT },
    });
    assert.equal(res.status, 400);
    assert.match(res.body.message, /not part of this series/);
  });
});

test('POST comment notifies the series owner, never the author of their own comment', async () => {
  // Alice owns the series. Commenting as Alice must not notify Alice.
  await withServer({
    users: users(),
    series: [seriesRow()],
    comments: [],
    notifications: [],
  }, async ({ call, token, fake }) => {
    const own = await call('POST', `/api/series/${SERIES}/comments`, {
      token: token(ALICE), body: { rating: 5, text: 'my own series' },
    });
    assert.equal(own.status, 201);
    const inserts = fake.log.filter((e) => /INSERT INTO "notifications"/.test(e.sql));
    assert.equal(inserts.length, 0, 'a user was notified about their own comment');

    // Now as Bob, who does not own it.
    fake.log.length = 0;
    const other = await call('POST', `/api/series/${SERIES}/comments`, {
      token: token(BOB), body: { rating: 4, text: 'nice work' },
    });
    assert.equal(other.status, 201);
    const notified = fake.log.filter((e) => /INSERT INTO "notifications"/.test(e.sql));
    assert.equal(notified.length, 1, 'the series owner was not notified');
    // (user, type, message, series) - the owner of the series, not the commenter.
    assert.equal(notified[0].params[0], ALICE);
    assert.equal(notified[0].params[1], 'comment_reply');
    assert.equal(notified[0].params[3], SERIES);
  });
});

test('DELETE comment is allowed for the author and an admin, and for nobody else', async () => {
  const rows = () => ({
    users: users(),
    series: [seriesRow()],
    comments: [seedRow('comments', {
      id: COMMENT, series: SERIES, user: BOB, rating: 4, text: 'mine', is_removed: false,
    })],
  });

  // The comment belongs to bob. Alice owns the series but not the comment, and
  // is not an admin, so she has no claim on it.
  await withServer({
    ...rows(),
    users: users().map((u) => (u.id === ADMIN ? { ...u, role: 'user' } : u)),
  }, async ({ call, token }) => {
    const anon = await call('DELETE', `/api/comments/${COMMENT}`);
    assert.equal(anon.status, 401);

    const byOther = await call('DELETE', `/api/comments/${COMMENT}`, { token: token(ALICE) });
    assert.equal(byOther.status, 403, 'a non-author, non-admin must be refused');
    assert.match(byOther.body.message, /only delete your own/);
  });

  await withServer(rows(), async ({ call, token, fake }) => {
    const asAuthor = await call('DELETE', `/api/comments/${COMMENT}`, { token: token(BOB) });
    assert.equal(asAuthor.status, 200);
    assert.ok(
      fake.log.some((e) => /UPDATE "comments"/.test(e.sql)),
      'the comment was not soft-removed'
    );
  });
});

test('a banned account is refused immediately, not when its token expires', async () => {
  /*
   * Found by mutation testing: deleting the isBanned check from `protect` broke
   * no test that existed. Without this, a suspended account kept working until
   * its token ran out, which for a refresh token is days.
   */
  const banned = () => users().map((u) => (u.id === BOB ? { ...u, is_banned: true } : u));

  for (const route of [
    ['GET', '/api/library'],
    ['GET', '/api/notifications'],
    ['GET', '/api/progress'],
    ['PATCH', `/api/admin/users/${ALICE}/ban`],
  ]) {
    const [method, path] = route;
    await withServer({ users: banned(), series: [seriesRow()], library: [] },
      async ({ call, token }) => {
        const res = await call(method, path, { token: token(BOB) });
        assert.equal(res.status, 403,
          `${method} ${path} still served a banned account`);
        assert.match(res.body.message, /suspended/);
      });
  }
});

test('an already-removed comment 404s rather than deleting twice', async () => {
  // Seeded in the removed state rather than deleting twice in one server: the
  // recording pool answers SELECTs from fixed rows and does not apply the UPDATE
  // it logs, so deleting twice here would prove nothing about the real handler.
  await withServer({
    users: users(),
    series: [seriesRow()],
    comments: [seedRow('comments', {
      id: COMMENT, series: SERIES, user: BOB, rating: 4, text: 'gone', is_removed: true,
    })],
  }, async ({ call, token, fake }) => {
    const res = await call('DELETE', `/api/comments/${COMMENT}`, { token: token(BOB) });
    assert.equal(res.status, 404, 'a removed comment must not still be found');
    assert.equal(
      fake.log.filter((e) => /UPDATE "comments"/.test(e.sql)).length, 0,
      'a removed comment was written to again'
    );
  });
});

test('the role is re-read from the database, not trusted from the token', async () => {
  /*
   * A JWT is a bearer credential: anyone holding it can present it. If the role
   * were taken from the token, demoting or banning a user would not take effect
   * until the token expired, and a stolen admin token would stay useful for its
   * whole lifetime. Both are reasons to read the row on every request, so the
   * behaviour is pinned from both directions rather than assumed.
   */
  const rows = (role) => ({
    users: users().map((u) => (u.id === ADMIN ? { ...u, role } : u)),
    series: [seriesRow()],
    comments: [seedRow('comments', {
      id: COMMENT, series: SERIES, user: BOB, rating: 4, text: 'x', is_removed: false,
    })],
  });

  // Token says "user"; the row says "admin". The row wins.
  await withServer(rows('admin'), async ({ call, token }) => {
    const res = await call('DELETE', `/api/comments/${COMMENT}`, { token: token(ADMIN, 'user') });
    assert.equal(res.status, 200, 'the role came from the token, not the database row');
  });

  // Token says "admin"; the row says "user". The row wins, and wins immediately.
  await withServer(rows('user'), async ({ call, token }) => {
    const res = await call('DELETE', `/api/comments/${COMMENT}`, { token: token(ADMIN, 'admin') });
    assert.equal(res.status, 403, 'a demoted user kept admin rights until the token expired');
  });
});

/* ================================================================== *
 * Chapters
 * ================================================================== */

test('GET chapter is public; PATCH and DELETE require ownership', async () => {
  const rows = () => ({
    users: users(),
    series: [seriesRow()],
    chapters: [seedRow('chapters', {
      id: CHAPTER, series: SERIES, num: 1, title: 'One', paragraphs: ['p'], is_removed: false,
    })],
  });

  await withServer(rows(), async ({ call, token }) => {
    assert.equal((await call('GET', `/api/chapters/${CHAPTER}`)).status, 200);

    const anonPatch = await call('PATCH', `/api/chapters/${CHAPTER}`, { body: { title: 'x' } });
    assert.equal(anonPatch.status, 401);

    const stranger = await call('PATCH', `/api/chapters/${CHAPTER}`, {
      token: token(BOB), body: { title: 'Hijacked' },
    });
    assert.equal(stranger.status, 403, 'a non-owner must not be able to edit a chapter');

    const owner = await call('PATCH', `/api/chapters/${CHAPTER}`, {
      token: token(ALICE), body: { title: 'One, revised' },
    });
    assert.equal(owner.status, 200);

    const strangerDelete = await call('DELETE', `/api/chapters/${CHAPTER}`, { token: token(BOB) });
    assert.equal(strangerDelete.status, 403);
    const ownerDelete = await call('DELETE', `/api/chapters/${CHAPTER}`, { token: token(ALICE) });
    assert.equal(ownerDelete.status, 200);
  });
});

/* ================================================================== *
 * Reading progress
 * ================================================================== */

test('reading progress is per user, and one user cannot read another\'s', async () => {
  const rows = () => ({
    users: users(),
    series: [seriesRow()],
    reading_progress: [seedRow('reading_progress', {
      id: '99999999-9999-4999-8999-999999999999',
      user: ALICE, series: SERIES, chapter: CHAPTER, type: 'novel',
      scroll_pct: 0.42, page: 3, bookmarked: false,
    })],
  });

  await withServer(rows(), async ({ call, token }) => {
    const anon = await call('GET', '/api/progress');
    assert.equal(anon.status, 401, 'progress must require a session');

    const mine = await call('GET', '/api/progress', { token: token(ALICE) });
    assert.equal(mine.status, 200);
    assert.equal(mine.body.progress.length, 1);

    const theirs = await call('GET', '/api/progress', { token: token(BOB) });
    assert.equal(theirs.status, 200);
    assert.equal(theirs.body.progress.length, 0, "bob saw alice's reading progress");

    const one = await call('GET', `/api/progress/${SERIES}`, { token: token(ALICE) });
    assert.equal(one.status, 200);
    // scrollPct is a fraction of the scrollable range, not a 0-100 percentage.
    // The column is called scroll_pct, which reads like a percentage and is how
    // it was taken for one while writing these tests; the frontend sends
    // scrollTop/scrollable and restores by multiplying, so the fraction is the
    // contract and the name is the only thing misleading about it.
    assert.equal(Number(one.body.progress.scrollPct), 0.42);
  });
});

test('PUT progress upserts and DELETE clears it', async () => {
  await withServer({
    users: users(),
    series: [seriesRow()],
    chapters: [seedRow('chapters', {
      id: CHAPTER, series: SERIES, num: 1, title: 'One', paragraphs: ['p'], is_removed: false,
    })],
    reading_progress: [],
  }, async ({ call, token, fake }) => {
    const anon = await call('PUT', `/api/progress/${SERIES}`, { body: { chapterId: CHAPTER } });
    assert.equal(anon.status, 401);

    // A percentage is not a valid fraction. The bound is load-bearing, so it is
    // asserted rather than assumed.
    const asPct = await call('PUT', `/api/progress/${SERIES}`, {
      token: token(BOB), body: { chapterId: CHAPTER, scrollPct: 55 },
    });
    assert.equal(asPct.status, 400, 'scrollPct is a 0-1 fraction and 55 was accepted');

    const saved = await call('PUT', `/api/progress/${SERIES}`, {
      token: token(BOB),
      body: { chapterId: CHAPTER, scrollPct: 0.55, page: 4 },
    });
    assert.equal(saved.status, 200, `expected a saved progress row, got ${saved.status}: ${saved.text}`);
    assert.ok(
      fake.log.some((e) => /INSERT INTO "reading_progress"/.test(e.sql)),
      'progress was not written'
    );

    fake.log.length = 0;
    const cleared = await call('DELETE', `/api/progress/${SERIES}`, { token: token(BOB) });
    assert.equal(cleared.status, 200);
    assert.ok(fake.log.some((e) => /DELETE FROM "reading_progress"/.test(e.sql)), 'progress was not cleared');
  });
});

/* ================================================================== *
 * Notifications
 * ================================================================== */

test('notifications are private to their owner and can be marked read', async () => {
  const NOTE = 'abababab-abab-4bab-8bab-abababababab';
  const rows = () => ({
    users: users(),
    notifications: [
      seedRow('notifications', { id: NOTE, user: ALICE, type: 'comment_reply', message: 'Bob commented.', is_read: false }),
      seedRow('notifications', { id: 'cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd', user: ALICE, type: 'dmca_takedown', message: 'Your content was removed.', is_read: true }),
    ],
  });

  await withServer(rows(), async ({ call, token, fake }) => {
    assert.equal((await call('GET', '/api/notifications')).status, 401);

    const mine = await call('GET', '/api/notifications', { token: token(ALICE) });
    assert.equal(mine.status, 200);
    assert.equal(mine.body.notifications.length, 2);
    assert.equal(mine.body.unreadCount, 1, 'the unread count must exclude read notifications');

    const bobs = await call('GET', '/api/notifications', { token: token(BOB) });
    assert.equal(bobs.body.notifications.length, 0, "bob saw alice's notifications");

    // Marking somebody else's notification read must not succeed.
    const stolen = await call('PATCH', `/api/notifications/${NOTE}/read`, { token: token(BOB) });
    assert.ok([403, 404].includes(stolen.status),
      `marking another user's notification read returned ${stolen.status}`);

    const mine2 = await call('PATCH', `/api/notifications/${NOTE}/read`, { token: token(ALICE) });
    assert.equal(mine2.status, 200);

    fake.log.length = 0;
    const all = await call('PATCH', '/api/notifications/read-all', { token: token(ALICE) });
    assert.equal(all.status, 200);
    const update = fake.log.filter((e) => /UPDATE "notifications"/.test(e.sql));
    assert.ok(update.length >= 1, 'read-all did not issue an update');
    // Scoped to the caller: bob's notifications must not be in the statement.
    assert.ok(
      update.some((e) => e.params.includes(ALICE)),
      'read-all did not scope the update to the caller'
    );
  });
});

/* ================================================================== *
 * Admin
 * ================================================================== */

test('every admin route refuses a non-admin and an anonymous caller', async () => {
  const cases = [
    ['GET', '/api/admin/users'],
    ['PATCH', `/api/admin/users/${BOB}/ban`],
    ['PATCH', `/api/admin/users/${BOB}/unban`],
    ['DELETE', `/api/admin/series/${SERIES}`],
    ['DELETE', `/api/admin/comments/${COMMENT}`],
  ];

  await withServer({
    users: users(),
    series: [seriesRow()],
    comments: [seedRow('comments', {
      id: COMMENT, series: SERIES, user: BOB, rating: 4, text: 'x', is_removed: false,
    })],
  }, async ({ call, token }) => {
    for (const [method, path] of cases) {
      // A GET cannot carry a body; only send one where the verb allows it.
      const payload = method === 'GET' ? {} : { body: {} };
      const anon = await call(method, path, payload);
      assert.equal(anon.status, 401, `${method} ${path} answered an anonymous caller`);

      const asUser = await call(method, path, { ...payload, token: token(ALICE) });
      assert.equal(asUser.status, 403, `${method} ${path} answered a normal user`);

      const asAdmin = await call(method, path, { ...payload, token: token(ADMIN, 'user') });
      assert.ok(asAdmin.status < 400,
        `${method} ${path} refused an admin: ${asAdmin.status} ${asAdmin.text}`);
    }
  });
});

test('banning a user records a reason, and unbanning clears it', async () => {
  await withServer({ users: users() }, async ({ call, token, fake }) => {
    const ban = await call('PATCH', `/api/admin/users/${BOB}/ban`, {
      token: token(ADMIN, 'admin'), body: { reason: 'Spam' },
    });
    assert.equal(ban.status, 200, `ban failed: ${ban.status} ${ban.text}`);

    fake.log.length = 0;
    const unban = await call('PATCH', `/api/admin/users/${BOB}/unban`, { token: token(ADMIN, 'admin') });
    assert.equal(unban.status, 200);
    const update = fake.log.find((e) => /UPDATE "users"/.test(e.sql));
    assert.ok(update, 'unban did not update the user row');
    assert.ok(
      update.params.includes('Spam') === false || update.params.includes(null),
      'the ban reason was not cleared on unban'
    );
  });
});

/* ================================================================== *
 * Library
 * ================================================================== */

test('the library is per user, and a save is idempotent', async () => {
  await withServer({
    users: users(),
    series: [seriesRow()],
    library: [],
  }, async ({ call, token }) => {
    assert.equal((await call('GET', '/api/library')).status, 401);

    const saved = await call('POST', `/api/library/${SERIES}`, { token: token(BOB) });
    assert.equal(saved.status, 200, `save failed: ${saved.status} ${saved.text}`);

    // Alice's library is untouched by Bob saving.
    const alices = await call('GET', '/api/library', { token: token(ALICE) });
    assert.equal(alices.status, 200);
    assert.equal((alices.body.series || []).length, 0, "bob's save leaked into alice's library");

    const removed = await call('DELETE', `/api/library/${SERIES}`, { token: token(BOB) });
    assert.equal(removed.status, 200);

    // Removing something that was never saved must not be a 500.
    const again = await call('DELETE', `/api/library/${SERIES}`, { token: token(BOB) });
    assert.ok(again.status < 500, `unsave returned ${again.status}`);
  });
});
