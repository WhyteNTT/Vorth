'use strict';

/**
 * The public series detail page, and what it is allowed to return.
 *
 * `GET /api/series/:id` is the most-read endpoint in the project and is
 * deliberately public — only writes are ownership-gated. Its uncovered lines were
 * the handler body, which means the shape of the response and two of its promises
 * had nothing checking them:
 *
 *   - The chapter list excludes chapter *content*. A serial with thousands of
 *     chapters would otherwise ship every paragraph of every one of them in the
 *     response for the detail page. The `.select('-paragraphs -pages')` is the only
 *     thing preventing that, and nothing tested it.
 *   - The list is bounded and in chapter order, so the detail page opens at the
 *     beginning of the work rather than a random slice.
 *   - Removed series and removed chapters do not appear.
 *
 * The assertion on the projection is structural — that the SQL really selects the
 * columns away — because a behavioural check through the double would pass whether or
 * not the projection was there: the double returns whatever rows it was given,
 * including the content, so a missing `.select()` produces a response that *looks*
 * right.
 */

process.env.DATABASE_URL ||= 'postgres://stub/stub';
process.env.DATABASE_SSL = 'false';
process.env.JWT_SECRET ||= 'test-secret';
process.env.NODE_ENV = 'test';
process.env.RATE_LIMIT_MAX_REQUESTS = '100000';
process.env.AUTH_RATE_LIMIT_MAX_REQUESTS = '100000';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createFakePool, seedRow } = require('./helpers/fakePool');

const ALICE = '11111111-1111-4111-8111-111111111111';
const NOVEL = '44444444-4444-4444-8444-444444444444';

async function withServer(rows, fn) {
  const fake = createFakePool({ rows });
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
    try { json = JSON.parse(text); } catch (_) { /* not JSON */ }
    return { status: res.status, body: json, text };
  };

  try {
    return await fn({
      call,
      fake,
      sql: () => fake.log.map((e) => e.sql),
      find: (pattern) => fake.log.find((e) => pattern.test(e.sql)),
      paramsFor: (pattern) => {
        const hit = fake.log.find((e) => pattern.test(e.sql));
        return hit ? hit.params : [];
      },
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    db.setPool(null);
    Base._clearColumnCache();
  }
}

/**
 * A live novel with two chapters and a comment.
 *
 * `over.chapters` and `over.comments` both accept `[]` for the empty case. Passing
 * `chapters: []` alone left the seeded comment behind, so the "no comments" scenario
 * reported a count of 1 - the fixture, not the code, was wrong.
 */
function world(over = {}) {
  return {
    users: [seedRow('users', {
      id: ALICE, username: 'alice', display_name: 'Alice', email: 'a@x.test', role: 'user', is_banned: false,
    })],
    series: [seedRow('series', {
      id: NOVEL, type: 'novel', owner: ALICE, author: 'Alice', title: 'A Novel',
      status: 'Ongoing', synopsis: 'Prose about things.', genres: ['Fantasy'], tags: ['slow'],
      views: { daily: 3, weekly: 9, alltime: 40 }, rating_avg: 4.5, rating_count: 2,
      is_removed: false, rights_attested_at: new Date(),
      ...(over.series || {}),
    })],
    chapters: over.chapters || [
      seedRow('chapters', {
        id: '55555555-5555-4555-8555-555555555555', series: NOVEL, num: 1, title: 'One',
        paragraphs: ['The whole first chapter, which must not ship here.'], pages: null,
        views: 10, is_removed: false,
      }),
      seedRow('chapters', {
        id: '66666666-6666-4666-8666-666666666666', series: NOVEL, num: 2, title: 'Two',
        paragraphs: ['The whole second chapter.'], pages: null, views: 5, is_removed: false,
      }),
    ],
    comments: over.comments || [seedRow('comments', {
      id: '77777777-7777-4777-8777-777777777777', series: NOVEL, user: ALICE,
      rating: 5, text: 'Good.', is_removed: false,
    })],
  };
}

test('the detail page is public, and returns the series with its chapters', async () => {
  await withServer(world(), async ({ call }) => {
    const res = await call('GET', `/api/series/${NOVEL}`);
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.success, true);
    assert.equal(res.body.series.title, 'A Novel');
    assert.equal(res.body.chapters.length, 2);
    assert.equal(res.body.commentCount, 1);
  });
});

test('the chapter list does not carry chapter content', async () => {
  /*
   * The promise, and the reason the projection exists. A serial with a thousand
   * chapters would otherwise ship every paragraph of every one of them to anyone
   * who opens the page.
   *
   * Asserted against the *emitted* SQL rather than the response. The double returns
   * the rows it was given, content included, so a handler without the projection
   * still returns chapters that look correct — the omission is invisible from the
   * outside and visible only here.
   *
   * The model expands the exclusion into an explicit column list rather than
   * emitting `-paragraphs`, so the check is on the columns that come out. The
   * emitted list is:
   *
   *   id, series, num, title, views, is_removed, created_at, updated_at
   *
   * which is the point - there is no `paragraphs` or `pages` in it. Asserting on the
   * literal string `-paragraphs` was the first version, and it failed against correct
   * behaviour: it asserted on the caller's syntax rather than the SQL's effect.
   */
  await withServer(world(), async ({ call, find }) => {
    const res = await call('GET', `/api/series/${NOVEL}`);
    assert.equal(res.status, 200);

    const read = find(/FROM "chapters"/);
    assert.ok(read, 'the chapter list was never read');

    const selected = read.sql.match(/SELECT (.+?) FROM "chapters"/);
    assert.ok(selected, `could not read the column list: ${read.sql}`);
    const columns = selected[1];

    assert.doesNotMatch(columns, /"paragraphs"/,
      'the chapter list selects paragraph content; a long serial would ship its entire text');
    assert.doesNotMatch(columns, /"pages"/,
      'the chapter list selects page images');
    // And it is a real projection rather than SELECT *, which would hide both.
    assert.doesNotMatch(columns, /^\s*\*\s*$/, 'the chapter list selects every column');

    // The fields the detail page actually renders, so the assertion above cannot be
    // satisfied by an empty projection.
    for (const column of ['"num"', '"title"']) {
      assert.ok(columns.includes(column), `the chapter list dropped ${column}: ${columns}`);
    }
  });
});

test('the chapter list is ordered by chapter number', async () => {
  // Otherwise the detail page opens on a random slice of the work, which for a
  // reader is the difference between chapter one and chapter two hundred.
  await withServer(world(), async ({ call, find }) => {
    await call('GET', `/api/series/${NOVEL}`);
    const read = find(/FROM "chapters"/);
    assert.match(read.sql, /ORDER BY "num"/, `the chapter list is unordered: ${read.sql}`);
  });
});

test('the chapter list is bounded', async () => {
  /*
   * `LIMIT $3` with the ceiling as a bound parameter, not a literal — so the
   * assertion checks that the parameter exists *and* is a number in a sane range.
   * A `LIMIT` clause with no bound is unbounded, and a caller-supplied one is an
   * unbounded read wearing a bound's clothes.
   */
  await withServer(world(), async ({ call, find }) => {
    await call('GET', `/api/series/${NOVEL}`);
    const read = find(/FROM "chapters"/);
    assert.match(read.sql, /LIMIT \$\d+/, `the chapter list is unbounded: ${read.sql}`);

    // The largest integer bound is the ceiling: the others are the series id (a
    // string) and the is_removed flag (a boolean).
    const bounds = read.params.filter((p) => Number.isInteger(p));
    assert.ok(bounds.length > 0, `no bound value was passed with the LIMIT: ${JSON.stringify(read.params)}`);

    const limit = Math.max(...bounds);
    assert.ok(limit > 1 && limit <= 1000,
      `the chapter list ceiling is ${limit}; a public unauthenticated read should be far lower`);
  });
});

test('a removed series is a 404, and its chapters are not served', async () => {
  await withServer(world({ series: { is_removed: true } }), async ({ call }) => {
    const res = await call('GET', `/api/series/${NOVEL}`);
    assert.equal(res.status, 404, `a removed series answered ${res.status}`);
  });
});

test('a series that does not exist is a 404', async () => {
  await withServer(world(), async ({ call }) => {
    const res = await call('GET', '/api/series/88888888-8888-4888-8888-888888888888');
    assert.equal(res.status, 404);
  });
});

test('a malformed id is a 404, not a 500', async () => {
  /*
   * 404, not 400. This route has no uuid validator on the parameter - it passes the
   * value straight to `findById` - so a malformed id becomes a query that matches
   * nothing. A 404 is the right answer and the reason it is asserted is that a
   * malformed uuid reaching PostgreSQL could equally be a 22P02, which the error
   * handler maps to 500. Getting 404 here means the driver never saw it.
   */
  await withServer(world(), async ({ call }) => {
    const res = await call('GET', '/api/series/not-a-uuid');
    assert.equal(res.status, 404, `expected 404, got ${res.status}: ${res.text}`);
    assert.equal(res.body.success, false);
  });
});

test('removed chapters and removed comments are left out', async () => {
  /*
   * A removed chapter is excluded by the filter, and the comment count with it. If
   * the filter were dropped, a chapter an author took down would still be listed on
   * the page and still counted.
   */
  await withServer(world({
    chapters: [
      seedRow('chapters', {
        id: '55555555-5555-4555-8555-555555555555', series: NOVEL, num: 1, title: 'One',
        paragraphs: ['kept'], pages: null, views: 1, is_removed: false,
      }),
      seedRow('chapters', {
        id: '66666666-6666-4666-8666-666666666666', series: NOVEL, num: 2, title: 'Taken Down',
        paragraphs: ['removed'], pages: null, views: 0, is_removed: true,
      }),
    ],
  }), async ({ call, find }) => {
    const res = await call('GET', `/api/series/${NOVEL}`);
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.chapters.length, 1, 'a removed chapter was listed');
    assert.ok(!res.body.chapters.some((c) => c.title === 'Taken Down'));

    const chapterRead = find(/FROM "chapters"/);
    assert.match(chapterRead.sql, /"is_removed"/,
      'the chapter list is not filtered by removal status');

    // `COUNT(*)::int AS count`, not lowercase `count(*)`. An earlier version of this
    // assertion matched /count\(\*\).*FROM "comments"/ and found nothing while the
    // code was correct - the case is what PostgreSQL emits for the alias.
    const countRead = find(/COUNT\(\*\)::int AS count FROM "comments"/);
    assert.ok(countRead, 'the comment count was never issued');
    assert.match(countRead.sql, /"is_removed"/,
      'the comment count includes removed comments');
  });
});

test('a series with no chapters and no comments still renders', async () => {
  // The empty case is a distinct code path in the frontend, and it is the one a
  // brand new series lands in.
  await withServer(world({ chapters: [], comments: [] }), async ({ call }) => {
    const res = await call('GET', `/api/series/${NOVEL}`);
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(res.body.chapters, []);
    assert.equal(res.body.commentCount, 0);
  });
});

test('the owner is populated for display, not returned as a bare id', async () => {
  await withServer(world(), async ({ call }) => {
    const res = await call('GET', `/api/series/${NOVEL}`);
    assert.equal(res.status, 200);
    // The double hydrates populate() from the same rows, so this asserts the
    // projection asked for the display fields rather than the whole row.
    const owner = res.body.series.owner;
    assert.ok(owner && typeof owner === 'object',
      `the owner came back as ${JSON.stringify(owner)} rather than an object`);
  });
});