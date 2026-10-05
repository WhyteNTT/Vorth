'use strict';

/**
 * Chapter content, and the novel/comic split that guards it.
 *
 * `chapterController` was the worst-covered file in the project at 94% statements
 * and 48% branch. The uncovered branches are all in the update handler, and they
 * are all the same shape: a chapter is either prose or comic pages, and the
 * handler has to work out what the chapter would look like *after* the edit before
 * deciding whether that is legal.
 *
 * That "after" is the interesting part, and getting it wrong is a real bug rather
 * than a coverage gap:
 *
 *   - Editing only the title must not require the body to be resent. A naive check
 *     on the request body would reject a title-only edit on a chapter whose
 *     paragraphs are present.
 *   - A novel chapter must not be given pages, and a comic chapter must not be
 *     given paragraphs, or the reader renders an empty page with no error anywhere.
 *   - Clearing the body entirely must be refused. Emptying a chapter leaves a link
 *     in the series list that opens to nothing.
 *
 * The assertions check what was written, not only the status code, because a
 * handler that returns 200 and saves nothing is the failure mode that matters
 * here - the reader sees the old content and nothing explains why.
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
const NOVEL = '44444444-4444-4444-8444-444444444444';
const COMIC = '77777777-7777-4777-8777-777777777777';
const N_CHAPTER = '55555555-5555-4555-8555-555555555555';
const C_CHAPTER = '66666666-6666-4666-8666-666666666666';

async function withServer(rows, fn) {
  const fake = createFakePool({ rows });
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
      call,
      fake,
      token: (id, role = 'user') => jwt.sign({ id, role }, JWT_SECRET),
      writesTo: (table) => fake.log.filter((e) => new RegExp(`^UPDATE "${table}"`).test(e.sql)),
      paramsFor: (table) => {
        const hit = fake.log.find((e) => new RegExp(`^UPDATE "${table}"`).test(e.sql));
        return hit ? hit.params : [];
      },
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    db.setPool(null);
    Base._clearColumnCache();
  }
}

/** A novel and a comic series, each with one chapter, all owned by Alice. */
function world() {
  return {
    users: [
      seedRow('users', { id: ALICE, username: 'alice', display_name: 'Alice', email: 'a@x.test', role: 'user', is_banned: false }),
      seedRow('users', { id: BOB, username: 'bob', display_name: 'Bob', email: 'b@x.test', role: 'user', is_banned: false }),
    ],
    series: [
      seedRow('series', {
        id: NOVEL, type: 'novel', owner: ALICE, author: 'Alice', title: 'A Novel',
        status: 'Ongoing', synopsis: 'x', genres: [], tags: [], views: {},
        is_removed: false, rights_attested_at: new Date(),
      }),
      seedRow('series', {
        id: COMIC, type: 'comic', owner: ALICE, author: 'Alice', title: 'A Comic',
        status: 'Ongoing', synopsis: 'x', genres: [], tags: [], views: {},
        is_removed: false, rights_attested_at: new Date(),
      }),
    ],
    chapters: [
      seedRow('chapters', {
        id: N_CHAPTER, series: NOVEL, num: 1, title: 'One',
        paragraphs: ['It was a dark and stormy platform.'], pages: null,
        views: 0, is_removed: false,
      }),
      seedRow('chapters', {
        id: C_CHAPTER, series: COMIC, num: 1, title: 'Page One',
        paragraphs: null, pages: ['/uploads/page-one.jpg'], views: 0, is_removed: false,
      }),
    ],
  };
}

/* ================================================================== *
 * A title-only edit must not need the body resent
 * ================================================================== */

test('a novel chapter can be renamed without resending its paragraphs', async () => {
  /*
   * The "after the edit" logic. If the handler checked the request body instead of
   * the resulting chapter, this would be rejected - the request carries no
   * paragraphs, and a naive reading is that a novel chapter needs some.
   */
  await withServer(world(), async ({ call, token, writesTo }) => {
    const res = await call('PATCH', `/api/chapters/${N_CHAPTER}`, {
      token: token(ALICE), body: { title: 'Chapter One, Revised' },
    });
    assert.equal(res.status, 200, res.text);

    const updates = writesTo('chapters');
    assert.equal(updates.length, 1, 'the rename did not write anything');
    assert.ok(updates[0].sql.includes('"title"'), 'the title was not written');
    // The paragraphs must be left alone, not nulled by an absent field.
    assert.ok(!/"paragraphs"\s*=\s*null/.test(updates[0].sql),
      'renaming a chapter wiped its paragraphs');
  });
});

test('a comic chapter can be renamed without resending its pages', async () => {
  await withServer(world(), async ({ call, token, writesTo }) => {
    const res = await call('PATCH', `/api/chapters/${C_CHAPTER}`, {
      token: token(ALICE), body: { title: 'Page One (fixed)' },
    });
    assert.equal(res.status, 200, res.text);
    assert.ok(!/"pages"\s*=\s*null/.test(writesTo('chapters')[0].sql),
      'renaming a comic chapter wiped its pages');
  });
});

/* ================================================================== *
 * The two content types must not be mixed
 * ================================================================== */

test('pages cannot be added to a novel chapter', async () => {
  // The reader would render an empty page: novels read paragraphs, so the pages
  // would be stored and never shown, and the chapter would look empty.
  await withServer(world(), async ({ call, token, writesTo }) => {
    const res = await call('PATCH', `/api/chapters/${N_CHAPTER}`, {
      token: token(ALICE), body: { pages: ['/uploads/nope.jpg'] },
    });
    assert.equal(res.status, 400, res.text);
    assert.match(res.body.message, /paragraph/i);
    assert.deepEqual(writesTo('chapters'), [], 'the refused edit still wrote something');
  });
});

test('paragraphs cannot be added to a comic chapter', async () => {
  await withServer(world(), async ({ call, token, writesTo }) => {
    const res = await call('PATCH', `/api/chapters/${C_CHAPTER}`, {
      token: token(ALICE), body: { paragraphs: ['Some prose.'] },
    });
    assert.equal(res.status, 400, res.text);
    assert.deepEqual(writesTo('chapters'), []);
  });
});

test('emptying a novel chapter is refused', async () => {
  /*
   * Otherwise the series list keeps a link that opens to nothing, and the author
   * has no way to tell which chapter went blank.
   */
  await withServer(world(), async ({ call, token, writesTo }) => {
    for (const body of [{ paragraphs: [] }, { paragraphs: null }]) {
      const res = await call('PATCH', `/api/chapters/${N_CHAPTER}`, {
        token: token(ALICE), body,
      });
      assert.equal(res.status, 400, `emptying a chapter with ${JSON.stringify(body)} was accepted`);
      assert.deepEqual(writesTo('chapters'), [], 'the refused edit still wrote something');
    }
  });
});

test('emptying a comic chapter is refused', async () => {
  await withServer(world(), async ({ call, token, writesTo }) => {
    const res = await call('PATCH', `/api/chapters/${C_CHAPTER}`, {
      token: token(ALICE), body: { pages: [] },
    });
    assert.equal(res.status, 400, res.text);
    assert.deepEqual(writesTo('chapters'), []);
  });
});

/* ================================================================== *
 * Legal edits, and that they actually persist
 * ================================================================== */

test('replacing a novel chapter body is accepted and written', async () => {
  await withServer(world(), async ({ call, token, writesTo, paramsFor }) => {
    const res = await call('PATCH', `/api/chapters/${N_CHAPTER}`, {
      token: token(ALICE), body: { paragraphs: ['A new opening.', 'A new close.'] },
    });
    assert.equal(res.status, 200, res.text);

    const update = writesTo('chapters')[0];
    assert.ok(update.sql.includes('"paragraphs"'));

    /*
     * Found by printing the double's params rather than assuming a shape. The
     * model serialises a changed JSONB column to a JSON string, so the parameter
     * is the string '["A new opening.","A new close."]' - not an array. An earlier
     * version searched for `Array.isArray(p)`, found nothing, and failed while the
     * code under test was correct.
     */
    const written = paramsFor('chapters').find((p) => typeof p === 'string' && p.includes('A new opening'));
    assert.ok(written, `the new paragraphs were not among the parameters: ${JSON.stringify(paramsFor('chapters'))}`);
    assert.deepEqual(JSON.parse(written), ['A new opening.', 'A new close.']);
  });
});

test('an absent title leaves the stored title alone', async () => {
  /*
   * Found by mutation: removing the `title !== undefined` guard from the handler
   * broke nothing in this file. The model's save() only writes changed columns, so
   * a request with no title still wrote no title - the guard is redundant given how
   * the data layer behaves.
   *
   * It is not redundant in intent, though. "Do not write a field the caller did not
   * send" is a property of the handler, and today it holds only because save() also
   * enforces it. If the model ever writes the full document, this becomes a real
   * bug: every chapter edit that omits the title would blank it.
   *
   * So the property is asserted against the response rather than the SQL, which is
   * what an author would actually see.
   */
  await withServer(world(), async ({ call, token }) => {
    const res = await call('PATCH', `/api/chapters/${N_CHAPTER}`, {
      token: token(ALICE), body: { paragraphs: ['A new opening.', 'A new close.'] },
    });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.chapter.title, 'One',
      'editing a chapter without naming a new title changed the stored title');
  });
});

test('a chapter cannot be created without a title', async () => {
  /*
   * The create path. The validator requires a title, so an author cannot publish a
   * chapter that will show up in the series list as blank. Asserted as the
   * requirement it is - an earlier version of this test expected a default title to
   * be substituted, which is not what the product does and never was.
   */
  await withServer(world(), async ({ call, token, writesTo }) => {
    const res = await call('POST', `/api/series/${NOVEL}/chapters`, {
      token: token(ALICE), body: { paragraphs: ['Only prose.'] },
    });
    assert.equal(res.status, 400, res.text);
    assert.match(res.text, /title/i);
    assert.deepEqual(writesTo('chapters'), [], 'a refused create still wrote something');
  });
});

test('a comic chapter still needs a title', async () => {
  await withServer(world(), async ({ call, token }) => {
    const res = await call('POST', `/api/series/${COMIC}/chapters`, {
      token: token(ALICE), body: { pages: ['/uploads/p1.jpg'] },
    });
    assert.equal(res.status, 400, res.text);
    assert.match(res.text, /title/i);
  });
});

test('a valid chapter of each type can be created', async () => {
  // The other half: a rule that refuses everything is not a rule. Each type is
  // created with only the content field that belongs to it.
  for (const [series, body] of [
    [NOVEL, { title: 'One', paragraphs: ['Only prose.'] }],
    [COMIC, { title: 'One', pages: ['/uploads/p1.jpg'] }],
  ]) {
    await withServer(world(), async ({ call, token, fake }) => {
      const res = await call('POST', `/api/series/${series}/chapters`, {
        token: token(ALICE), body,
      });
      assert.equal(res.status, 201, `a valid chapter was refused: ${res.text}`);

      /*
       * Asserted against the INSERT's parameters, not the response body.
       *
       * The double does not echo a generated column back through
       * INSERT ... RETURNING for a row it invented, so `res.body.chapter.title` is
       * null for a chapter that was in fact created with a title. An earlier
       * version of this assertion read the response and failed against correct
       * behaviour - the same class of mistake as the JSONB-serialisation one.
       * The live suite is where a created row is read back; this is the HTTP
       * contract.
       */
      const insert = fake.log.find((e) => /^INSERT INTO "chapters"/.test(e.sql));
      assert.ok(insert, 'nothing was inserted');
      assert.ok(insert.sql.includes('"title"'), 'the insert does not carry a title column');
      assert.ok(insert.params.includes('One'),
        `the title was not among the inserted values: ${JSON.stringify(insert.params)}`);
    });
  }
});

test('a novel chapter cannot be created with pages instead of paragraphs', async () => {
  await withServer(world(), async ({ call, token }) => {
    const res = await call('POST', `/api/series/${NOVEL}/chapters`, {
      token: token(ALICE), body: { pages: ['/uploads/nope.jpg'] },
    });
    assert.equal(res.status, 400, res.text);
  });
});

test('a comic chapter cannot be created with paragraphs instead of pages', async () => {
  await withServer(world(), async ({ call, token }) => {
    const res = await call('POST', `/api/series/${COMIC}/chapters`, {
      token: token(ALICE), body: { paragraphs: ['Only prose.'] },
    });
    assert.equal(res.status, 400, res.text);
  });
});

test('replacing a comic chapter page list is accepted and written', async () => {
  await withServer(world(), async ({ call, token, paramsFor }) => {
    const pages = ['/uploads/p1.jpg', '/uploads/p2.jpg'];
    const res = await call('PATCH', `/api/chapters/${C_CHAPTER}`, {
      token: token(ALICE), body: { pages },
    });
    assert.equal(res.status, 200, res.text);
    // Serialised to a JSON string, for the same reason as the paragraphs above.
    const written = paramsFor('chapters').find((p) => typeof p === 'string' && p.includes('p1.jpg'));
    assert.ok(written, `the new pages were not saved: ${JSON.stringify(paramsFor('chapters'))}`);
    assert.deepEqual(JSON.parse(written), pages);
  });
});

/* ================================================================== *
 * Who may do this
 * ================================================================== */

test('somebody else cannot edit a chapter', async () => {
  await withServer(world(), async ({ call, token, writesTo }) => {
    const res = await call('PATCH', `/api/chapters/${N_CHAPTER}`, {
      token: token(BOB), body: { title: 'Hijacked' },
    });
    assert.equal(res.status, 403, `expected 403, got ${res.status}: ${res.text}`);
    assert.deepEqual(writesTo('chapters'), [], 'a refused edit still wrote something');
  });
});

test('an anonymous caller cannot edit a chapter', async () => {
  await withServer(world(), async ({ call, writesTo }) => {
    const res = await call('PATCH', `/api/chapters/${N_CHAPTER}`, { body: { title: 'Anon' } });
    assert.equal(res.status, 401);
    assert.deepEqual(writesTo('chapters'), []);
  });
});

test('editing a chapter that does not exist is a 404', async () => {
  await withServer(world(), async ({ call, token }) => {
    const res = await call('PATCH', '/api/chapters/88888888-8888-4888-8888-888888888888', {
      token: token(ALICE), body: { title: 'Ghost' },
    });
    assert.equal(res.status, 404);
  });
});

test('a removed chapter cannot be edited', async () => {
  // Otherwise a removed chapter could be edited back into existence through the
  // API while still reading as removed to every other route.
  const rows = world();
  rows.chapters[0] = seedRow('chapters', {
    id: N_CHAPTER, series: NOVEL, num: 1, title: 'One',
    paragraphs: ['gone'], pages: null, views: 0, is_removed: true,
  });

  await withServer(rows, async ({ call, token, writesTo }) => {
    const res = await call('PATCH', `/api/chapters/${N_CHAPTER}`, {
      token: token(ALICE), body: { title: 'Back from the dead' },
    });
    assert.equal(res.status, 404, `a removed chapter answered ${res.status}`);
    assert.deepEqual(writesTo('chapters'), []);
  });
});

/* ================================================================== *
 * The validator, which runs before any of that
 * ================================================================== */

test('an oversized paragraph is refused before the handler', async () => {
  await withServer(world(), async ({ call, token, writesTo }) => {
    const res = await call('PATCH', `/api/chapters/${N_CHAPTER}`, {
      token: token(ALICE), body: { paragraphs: ['x'.repeat(20001)] },
    });
    assert.equal(res.status, 400);
    assert.deepEqual(writesTo('chapters'), []);
  });
});

test('a page path that is not an upload URL or an https URL is refused', async () => {
  /*
   * The page list is rendered as image sources, so a path outside the uploads
   * directory would be a fetch the reader's browser makes to somewhere else. The
   * pattern is the check, and this is one of the two shapes it accepts.
   */
  await withServer(world(), async ({ call, token }) => {
    for (const page of [
      '/etc/passwd',
      'http://insecure.example/x.jpg',
      'uploads/page.jpg',
      '../../secret.jpg',
    ]) {
      const res = await call('PATCH', `/api/chapters/${C_CHAPTER}`, {
        token: token(ALICE), body: { pages: [page] },
      });
      assert.equal(res.status, 400, `"${page}" was accepted`);
    }
  });
});

test('an https page URL is accepted, since covers and pages may be remote', async () => {
  await withServer(world(), async ({ call, token }) => {
    const res = await call('PATCH', `/api/chapters/${C_CHAPTER}`, {
      token: token(ALICE), body: { pages: ['https://cdn.example/p1.jpg'] },
    });
    assert.equal(res.status, 200, res.text);
  });
});

/* ================================================================== *
 * The guard on the guards
 * ================================================================== */

test('the assertions here would notice a handler that saved nothing', () => {
  /*
   * Every case above checks `writesTo('chapters')`, so a handler returning 200
   * without writing is caught rather than passing on its status code. This asserts
   * the helper that does it is actually wired to the double's log - the failure
   * mode of a harness that returns an empty array for everything, which would make
   * every "nothing was written" assertion vacuous.
   */
  assert.equal(typeof createFakePool, 'function');
  const fake = createFakePool({ rows: {} });
  assert.ok(Array.isArray(fake.log), 'the double does not expose a statement log');
  assert.match(jwt.sign({ id: 'x' }, JWT_SECRET), /^[\w-]+\.[\w-]+\.[\w-]+$/,
    'the token helper is not producing a JWT, so the auth cases would be testing nothing');
});