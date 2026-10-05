'use strict';

/**
 * The two admin read endpoints for counter-notices, and one branch of the sweep.
 *
 * Narrower than the resolution path on purpose. `PATCH .../resolve` decides whether
 * copyrighted content goes back up, and it is covered by counterNotice.live.test.js
 * against real PostgreSQL — which is the right place for it, because the restore is a
 * multi-statement transaction whose correctness is the whole point of the statutory
 * process. Duplicating it against a double would test the double.
 *
 * What was uncovered here is the reading half: the admin queue, the single notice,
 * and the sweep's branch for a notice whose takedown row has gone. That last one is
 * worth pinning deliberately. A counter-notice can outlive its DMCA report — the row
 * is deleted, the notice is not — and the sweep has to *skip* it rather than crash
 * or, worse, resolve a notice with no takedown behind it.
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
const ADMIN = '11111111-1111-4111-8111-111111111111';
const READER = '22222222-2222-4222-8222-222222222222';
const NOTICE = '33333333-3333-4333-8333-333333333333';
const REPORT = '44444444-4444-4444-8444-444444444444';

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
      find: (pattern) => fake.log.find((e) => pattern.test(e.sql)),
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    db.setPool(null);
    Base._clearColumnCache();
  }
}

/** An accepted takedown with one counter-notice filed against it. */
function world() {
  return {
    users: [
      seedRow('users', { id: ADMIN, username: 'root', display_name: 'Root', email: 'r@x.test', role: 'admin', is_banned: false }),
      seedRow('users', { id: READER, username: 'reader', display_name: 'Reader', email: 'rd@x.test', role: 'user', is_banned: false }),
    ],
    dmca_reports: [seedRow('dmca_reports', {
      id: REPORT, status: 'accepted', reporter_name: 'Holder', reporter_email: 'holder@example.test',
      original_work_url: 'https://example.test/work', good_faith_statement: 'I believe in good faith.',
      accuracy_statement: 'I state this accurately.', signature: 'Holder',
      removal_series: null, removal_chapter: null, removal_at: new Date(),
    })],
    dmca_counter_notices: [seedRow('dmca_counter_notices', {
      id: NOTICE, dmca_report: REPORT, status: 'pending',
      counter_notice_text: 'The use was fair use.',
      good_faith_statement: 'I believe in good faith.',
      penalty_perjury_statement: 'I accept the statutory penalty.',
      physical_signature: 'Reader',
      submitted_at: new Date(),
    })],
  };
}

/* ================================================================== *
 * The admin queue
 * ================================================================== */

test('the queue is admin-only', async () => {
  await withServer(world(), async ({ call, token }) => {
    assert.equal((await call('GET', '/api/dmca/counter-notices')).status, 401);
    assert.equal((await call('GET', '/api/dmca/counter-notices', {
      token: token(READER),
    })).status, 403, 'a reader saw the counter-notice queue');
  });
});

test('an admin sees the queue', async () => {
  await withServer(world(), async ({ call, token }) => {
    const res = await call('GET', '/api/dmca/counter-notices', { token: token(ADMIN) });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.counterNotices.length, 1);
    assert.equal(res.body.counterNotices[0].id, NOTICE);
  });
});

test('the queue can be filtered by status', async () => {
  await withServer(world(), async ({ call, token, find }) => {
    const res = await call('GET', '/api/dmca/counter-notices?status=pending', {
      token: token(ADMIN),
    });
    assert.equal(res.status, 200, res.text);
    const read = find(/FROM "dmca_counter_notices"/);
    assert.match(read.sql, /"status"/, 'the status filter was not applied');
  });
});

test('the queue is bounded, because a counter-notice caseload only grows', async () => {
  // The same reason the DMCA queue and the report queue are bounded. An admin
  // loading every counter-notice ever filed is an unbounded read on a table that
  // grows with every dispute.
  await withServer(world(), async ({ call, token, find }) => {
    await call('GET', '/api/dmca/counter-notices', { token: token(ADMIN) });
    const read = find(/FROM "dmca_counter_notices"/);
    assert.match(read.sql, /LIMIT \$\d+/, `the queue is unbounded: ${read.sql}`);
  });
});

/* ================================================================== *
 * One notice, and the takedown it belongs to
 * ================================================================== */

test('a single notice is admin-only too', async () => {
  // Named separately because the queue and the single notice are two route
  // declarations, and removing the guard from the single-notice one was the only
  // mutation the queue test did not catch. Both carry the complainant's details.
  await withServer(world(), async ({ call, token }) => {
    assert.equal((await call('GET', `/api/dmca/counter-notices/${NOTICE}`)).status, 401);
    assert.equal((await call('GET', `/api/dmca/counter-notices/${NOTICE}`, {
      token: token(READER),
    })).status, 403, 'a reader read a single counter-notice');
  });
});

test('a single notice is returned with the takedown behind it', async () => {
  await withServer(world(), async ({ call, token }) => {
    const res = await call('GET', `/api/dmca/counter-notices/${NOTICE}`, {
      token: token(ADMIN),
    });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.counterNotice.id, NOTICE);
    assert.ok(res.body.report, 'the notice came back with no takedown attached');
  });
});

test('the attached takedown carries the fields a moderator needs', async () => {
  /*
   * The projection. Without an explicit `.select()` the whole report row ships,
   * including the complainant's email — which is fine in a database row and not fine
   * in an admin endpoint that a support agent reads aloud.
   */
  await withServer(world(), async ({ call, token, find }) => {
    await call('GET', `/api/dmca/counter-notices/${NOTICE}`, { token: token(ADMIN) });
    const read = find(/FROM "dmca_reports"/);
    const selected = read.sql.match(/SELECT (.+?) FROM "dmca_reports"/);
    assert.ok(selected, `could not read the column list: ${read.sql}`);

    for (const column of ['"reporter_email"', '"status"', '"removal_at"']) {
      assert.ok(selected[1].includes(column),
        `the takedown detail dropped ${column}: ${selected[1]}`);
    }
    assert.doesNotMatch(selected[1], /"signature"/,
      'the complainant signature ships with the admin detail view');
  });
});

test('a notice that does not exist is a 404', async () => {
  await withServer(world(), async ({ call, token }) => {
    const res = await call('GET', '/api/dmca/counter-notices/88888888-8888-4888-8888-888888888888', {
      token: token(ADMIN),
    });
    assert.equal(res.status, 404);
  });
});

/* ================================================================== *
 * The sweep branch: a notice whose takedown row has gone
 * ================================================================== */

test('a notice whose takedown has been deleted is skipped, not resolved', async () => {
  /*
   * The branch. A DMCA report can be deleted while a counter-notice against it
   * survives — retention rules, a manual purge, an admin action. The sweep must
   * record it as skipped and move on.
   *
   * The two wrong outcomes are both real: throwing takes down the whole sweep and
   * leaves every *other* due counter-notice unresolved, which on a statutory
   * deadline means content that should have come back stays down. And treating a
   * missing takedown as "nothing was removed, so restore nothing" would resolve the
   * notice as restored-with-no-effect, which tells an author their dispute settled
   * when nothing happened.
   */
  const rows = world();
  rows.dmca_reports = [];

  // The sweep is `restoreLapsed` on the controller, not a service of its own -
  // `scripts/sweepLapsedCounterNotices.js` is a thin CLI wrapper over it.
  const { restoreLapsed } = require('../src/controllers/dmcaCounterNoticeController');
  const db = require('../src/config/db');
  db.setPool(createFakePool({ rows }));

  try {
    const result = await restoreLapsed();
    assert.ok(Array.isArray(result.outcomes), 'the sweep returned no outcomes');

    const skipped = result.outcomes.filter((o) => o.action === 'skipped');
    assert.equal(skipped.length, 1,
      `expected the orphan notice to be skipped, outcomes were: ${JSON.stringify(result.outcomes)}`);
    assert.equal(skipped[0].id, NOTICE);
    assert.match(skipped[0].reason, /report/i,
      `the skip reason does not explain itself: ${JSON.stringify(skipped[0])}`);
    assert.ok(!result.outcomes.some((o) => o.action === 'restored'),
      'a notice with no takedown behind it was reported as restored');
  } finally {
    db.setPool(null);
  }
});