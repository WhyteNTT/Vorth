'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createFakePool, withPool } = require('./helpers/fakePool');

process.env.DATABASE_URL ||= 'postgres://stub/stub';
process.env.DATABASE_SSL = 'false';
process.env.JWT_SECRET ||= 'test-secret';

const views = require('../src/services/views');

/** Pool double where the first conflictAfter INSERTs succeed and later ones conflict. */
function viewPool({ conflictAfter = 1 } = {}) {
  const fake = createFakePool({ rows: {} });
  let inserts = 0;
  const realQuery = fake.query.bind(fake);
  fake.query = async (text, params) => {
    const sql = text.replace(/\s+/g, ' ');
    if (/INSERT INTO "view_events"/.test(sql)) {
      inserts += 1;
      const conflicted = inserts > conflictAfter;
      fake.log.push({ sql, params, verb: 'INSERT' });
      return { rows: conflicted ? [] : [{ id: 'v1' }], rowCount: conflicted ? 0 : 1 };
    }
    return realQuery(text, params);
  };
  fake.insertCount = () => inserts;
  return fake;
}

test('viewerKey prefers the account id for signed-in readers', () => {
  assert.equal(views.viewerKey({ user: { id: 'u1' } }), 'u:u1');
});

test('viewerKey falls back to a stable ip+agent fingerprint for guests', () => {
  const req = { headers: { 'x-forwarded-for': '203.0.113.9, 10.0.0.1', 'user-agent': 'UA/1' } };
  const key = views.viewerKey(req);
  assert.match(key, /^a:/);
  assert.ok(key.includes('203.0.113.9'), 'should use the first forwarded hop');
  assert.ok(key.includes('UA/1'));
});

test('viewerKey produces the same key for the same anonymous client', () => {
  const req = { headers: { 'user-agent': 'UA/1' } };
  assert.equal(views.viewerKey(req), views.viewerKey(req));
});

test('a first view increments the chapter and series counters', async () => {
  const fake = viewPool({ conflictAfter: 1 });
  await withPool(fake, async () => {
    const result = await views.recordView({ seriesId: 's1', chapterId: 'c1', viewer: 'u:u1' });
    assert.equal(result.counted, true);

    const update = fake.log.filter((e) => e.verb === 'UPDATE');
    assert.equal(update.length, 2, 'one chapter update and one series update');

    const chapterUpdate = update.find((e) => /"chapters"/.test(e.sql));
    assert.match(chapterUpdate.sql, /"views" = "views" \+ 1/);

    const seriesUpdate = update.find((e) => /"series"/.test(e.sql));
    assert.match(seriesUpdate.sql, /jsonb_set/);
    // All three counters must move in one statement.
    assert.match(seriesUpdate.sql, /\{daily\}/);
    assert.match(seriesUpdate.sql, /\{weekly\}/);
    assert.match(seriesUpdate.sql, /\{alltime\}/);
  });
});

test('a repeat view inside the same window counts nothing', async () => {
  const fake = viewPool({ conflictAfter: 1 });
  await withPool(fake, async () => {
    const first = await views.recordView({ seriesId: 's1', chapterId: 'c1', viewer: 'u:u1' });
    const second = await views.recordView({ seriesId: 's1', chapterId: 'c1', viewer: 'u:u1' });

    assert.equal(first.counted, true);
    assert.equal(second.counted, false, 'the second read must be de-duplicated');
    assert.equal(fake.log.filter((e) => e.verb === 'UPDATE').length, 2,
      'only the first read should have written any counter');
  });
});

test('the de-duplication key is enforced by the database', async () => {
  const fake = viewPool({ conflictAfter: 1 });
  await withPool(fake, async () => {
    await views.recordView({ seriesId: 's1', chapterId: 'c1', viewer: 'u:u1' });
    const insert = fake.log.find((e) => /INSERT INTO "view_events"/.test(e.sql));
    assert.match(insert.sql, /ON CONFLICT \("chapter", "viewer", "window_start"\) DO NOTHING/);
  });
});

test('recordView runs inside a transaction', async () => {
  const fake = viewPool({ conflictAfter: 1 });
  await withPool(fake, async () => {
    await views.recordView({ seriesId: 's1', chapterId: 'c1', viewer: 'u:u1' });
    assert.ok(fake.log.some((e) => /BEGIN/.test(e.sql)), 'expected BEGIN');
    assert.ok(fake.log.some((e) => /COMMIT/.test(e.sql)), 'expected COMMIT');
  });
});

test('pruneViewEvents deletes rows older than the retention window', async () => {
  const fake = createFakePool({ rows: {} });
  await withPool(fake, async () => {
    await views.pruneViewEvents(fake, 3);
    const del = fake.log.find((e) => e.verb === 'DELETE');
    assert.match(del.sql, /DELETE FROM "view_events"/);
    assert.match(del.sql, /now\(\) - \(\$1 \|\| ' days'\)::interval/);
  });
});