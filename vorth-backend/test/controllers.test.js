'use strict';

/**
 * Controller tests. Controllers are invoked directly with a fake req/res so
 * the suite needs neither a live database nor an HTTP listener.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { createFakePool, withPool, seedRow } = require('./helpers/fakePool');

process.env.DATABASE_URL ||= 'postgres://stub/stub';
process.env.DATABASE_SSL = 'false';
process.env.JWT_SECRET ||= 'test-secret';
process.env.NODE_ENV = 'test';

/** Minimal Express-compatible response double. */
function res() {
  const r = {
    statusCode: 200, body: undefined, headers: {},
    status(code) { r.statusCode = code; return r; },
    json(payload) { r.body = payload; return r; },
    send(payload) { r.body = payload; return r; },
    type(t) { r.headers.type = t; return r; },
    set(k, v) { r.headers[k] = v; return r; },
  };
  return r;
}

/** asyncHandler swallows rejections into next(), so drive it via a promise. */
function invoke(handler, req) {
  return new Promise((resolve) => {
    const r = res();
    handler(req, r, (err) => resolve({ res: r, error: err || null }));
    // Success paths resolve synchronously-ish; flush the microtask queue.
    setImmediate(() => resolve({ res: r, error: null }));
  });
}

const adminController = require('../src/controllers/adminController');
const libraryController = require('../src/controllers/libraryController');
const dmcaController = require('../src/controllers/dmcaController');

/* ------------------------------------------------------------------ *
 * GET /api/admin/users leaked bcrypt hashes.
 * ------------------------------------------------------------------ */
test('admin: user list excludes the password column', async () => {
  const fake = createFakePool({
    rows: { users: [seedRow('users', { id: 'u1', username: 'alice', password: '$2b$12$HASH' })] },
  });
  await withPool(fake, async () => {
    const { res: out } = await invoke(adminController.listUsers, {});
    const select = fake.log.find((e) => e.verb === 'SELECT');
    assert.ok(!/\bpassword\b/i.test(select.sql), `password still selected: ${select.sql}`);
    assert.equal(JSON.stringify(out.body).includes('HASH'), false,
      'serialised admin payload must not contain a password hash');
  });
});

test('admin: ban still persists through the data layer', async () => {
  const fake = createFakePool({
    rows: { users: [seedRow('users', { id: 'u1', username: 'alice', role: 'user' })] },
  });
  await withPool(fake, async () => {
    const { res: out } = await invoke(adminController.banUser, {
      params: { id: 'u1' }, body: { reason: 'spam' },
    });
    assert.equal(out.statusCode, 200);
    const update = fake.log.find((e) => e.verb === 'UPDATE');
    assert.ok(update, 'expected an UPDATE');
    assert.match(update.sql, /SET "is_banned" = \$1, "ban_reason" = \$2/);
  });
});

test('admin: admins cannot be banned through the endpoint', async () => {
  const fake = createFakePool({
    rows: { users: [seedRow('users', { id: 'u2', username: 'root', role: 'admin' })] },
  });
  await withPool(fake, async () => {
    const { error } = await invoke(adminController.banUser, { params: { id: 'u2' }, body: {} });
    assert.ok(error, 'expected a rejection');
    assert.equal(error.statusCode, 403);
    assert.equal(fake.log.filter((e) => e.verb === 'UPDATE').length, 0);
  });
});

/* ------------------------------------------------------------------ *
 * Library endpoints returned bare UUIDs because populate() was a no-op.
 * ------------------------------------------------------------------ */
test('library: GET /api/library returns populated series documents', async () => {
  const fake = createFakePool({
    rows: {
      users: [seedRow('users', { id: 'u1', library: ['s1', 's2'] })],
      series: [
        seedRow('series', { id: 's1', title: 'One', is_removed: false }),
        seedRow('series', { id: 's2', title: 'Two', is_removed: false }),
      ],
    },
  });
  await withPool(fake, async () => {
    const { res: out } = await invoke(libraryController.getSaved, {
      params: {}, user: { id: 'u1' },
    });
    assert.equal(out.body.success, true);
    assert.equal(out.body.series.length, 2);
    assert.equal(out.body.series[0].title, 'One', 'series must be documents, not ids');
    // Ordering follows the saved order, not the query order.
    assert.deepEqual(out.body.series.map((s) => s.id), ['s1', 's2']);
  });
});

test('library: empty library short-circuits without querying series', async () => {
  const fake = createFakePool({ rows: { users: [seedRow('users', { id: 'u1', library: [] })] } });
  await withPool(fake, async () => {
    const { res: out } = await invoke(libraryController.getSaved, { params: {}, user: { id: 'u1' } });
    assert.deepEqual(out.body.series, []);
    assert.equal(fake.log.filter((e) => /FROM "series"/.test(e.sql)).length, 0);
  });
});

test('library: GET /downloads resolves both series and chapter ids', async () => {
  const fake = createFakePool({
    rows: {
      users: [seedRow('users', { id: 'u1', downloads: [{ series: 's1', chapter: 'c1' }] })],
      series: [seedRow('series', { id: 's1', title: 'One', is_removed: false })],
      chapters: [seedRow('chapters', { id: 'c1', num: 1, title: 'Ch1', is_removed: false })],
    },
  });
  await withPool(fake, async () => {
    const { res: out } = await invoke(libraryController.getDownloads, {
      params: {}, user: { id: 'u1', downloads: [{ series: 's1', chapter: 'c1' }] },
    });
    assert.equal(out.body.downloads.length, 1);
    const entry = out.body.downloads[0];
    assert.equal(entry.series.title, 'One');
    assert.equal(entry.chapter.title, 'Ch1');
    // The frontend matches on chapter.id; it must be present.
    assert.ok(entry.chapter.id, 'chapter.id is required for client-side matching');
  });
});

test('library: downloads pointing at removed series are dropped', async () => {
  const fake = createFakePool({
    rows: {
      users: [seedRow('users', { id: 'u1', downloads: [{ series: 's1', chapter: 'c1' }] })],
      series: [seedRow('series', { id: 's1', title: 'One', is_removed: true })],
      chapters: [seedRow('chapters', { id: 'c1', is_removed: false })],
    },
  });
  await withPool(fake, async () => {
    const { res: out } = await invoke(libraryController.getDownloads, {
      params: {}, user: { id: 'u1', downloads: [{ series: 's1', chapter: 'c1' }] },
    });
    assert.deepEqual(out.body.downloads, []);
  });
});

test('library: saving a series appends and persists', async () => {
  const fake = createFakePool({
    rows: { series: [seedRow('series', { id: 's1', is_removed: false })] },
  });
  await withPool(fake, async () => {
    const req = {
      params: { seriesId: 's1' },
      user: { id: 'u1', library: [], save: async function () { this.saved = true; } },
    };
    const { res: out } = await invoke(libraryController.save[1], req);
    assert.equal(out.statusCode, 200);
    assert.deepEqual(req.user.library, ['s1']);
    assert.ok(req.user.saved, 'save() must have been called');
  });
});

test('library: saving the same series twice does not duplicate it', async () => {
  const fake = createFakePool({
    rows: { series: [seedRow('series', { id: 's1', is_removed: false })] },
  });
  await withPool(fake, async () => {
    let saved = 0;
    const req = {
      params: { seriesId: 's1' },
      user: { id: 'u1', library: ['s1'], save: async function () { saved += 1; } },
    };
    await invoke(libraryController.save[1], req);
    assert.deepEqual(req.user.library, ['s1']);
    assert.equal(saved, 0, 'no write needed when the entry already exists');
  });
});

// Param validation (isUUID etc.) is exercised in test/http.test.js, where the
// real express-validator chain and error handler run.

/* ------------------------------------------------------------------ *
 * DMCA intake passed req.body straight into an INSERT.
 * ------------------------------------------------------------------ */
test('dmca: submit only inserts whitelisted columns', async () => {
  const fake = createFakePool({ rows: { chapters: [], series: [] } });
  await withPool(fake, async () => {
    const req = {
      body: {
        reporterName: 'R', reporterEmail: 'r@example.com',
        copyrightedWorkDescription: 'a novel', signature: 'R',
        goodFaithStatement: 'true', accuracyStatement: 'true',
        // Smuggled fields the schema does not have:
        status: 'accepted', resolvedBy: 'u1', role: 'admin', is_removed: false,
      },
    };
    const { res: out } = await invoke(dmcaController.submit[dmcaController.submit.length - 1], req);
    assert.equal(out.statusCode, 201);
    const insert = fake.log.find((e) => e.verb === 'INSERT');
    assert.ok(insert, 'expected an INSERT');
    for (const forbidden of ['status', 'resolved_by', 'role', 'is_removed']) {
      assert.ok(!insert.sql.includes(`"${forbidden}"`),
        `smuggled column "${forbidden}" reached the INSERT: ${insert.sql}`);
    }
    assert.ok(insert.sql.includes('"reporter_name"'));
  });
});