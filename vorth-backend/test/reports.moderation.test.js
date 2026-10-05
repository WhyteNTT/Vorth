'use strict';

/**
 * Moderating a content report - the admin half.
 *
 * reports.http.test.js covers what a reader does: submitting a report, and being
 * unable to write columns that are not its own. Nothing covered what a moderator
 * does with one, which is the part that removes content.
 *
 * The behaviour worth pinning is the interaction with the other removal system.
 * When a report is actioned, the removed chapter or series is stamped with a
 * takedown_reason naming the report. That stamp is the only thing stopping a DMCA
 * counter-notice sweep from un-hiding it later: `restoreRemovedContent` only puts
 * back content removed by *that* notice, so a Content Policy removal with no
 * reason reads as "not ours" and stays down. If the stamp were ever dropped, a
 * copyright restoration would silently resurrect content removed for harassment.
 *
 * So the assertions here are about which rows get written, and about the reason
 * being specific rather than a generic flag.
 */

process.env.DATABASE_URL ||= 'postgres://stub/stub';
process.env.DATABASE_SSL = 'false';
process.env.JWT_SECRET ||= 'test-secret';
process.env.NODE_ENV = 'test';
process.env.RATE_LIMIT_MAX_REQUESTS = '100000';
process.env.AUTH_RATE_LIMIT_MAX_REQUESTS = '100000';

const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const { createFakePool, seedRow } = require('./helpers/fakePool');

const JWT_SECRET = process.env.JWT_SECRET;
const ADMIN = '99999999-9999-4999-8999-999999999999';
const OWNER = '44444444-4444-4444-8444-444444444444';
const REPORT = '55555555-5555-4555-8555-555555555555';
const SERIES = '11111111-1111-4111-8111-111111111111';
const CHAPTER = '33333333-3333-4333-8333-333333333333';
const COMMENT = '66666666-6666-4666-8666-666666666666';

/** A pending report naming a chapter, a series and a comment. */
function world(over = {}) {
  return {
    // OWNER is here as a real row: protect() 401s on a session whose account it
    // cannot load, which would make the non-admin case look like a missing user
    // rather than a refused permission.
    users: [
      seedRow('users', { id: ADMIN, username: 'root', email: 'root@example.com', role: 'admin', is_banned: false }),
      seedRow('users', { id: OWNER, username: 'writer', email: 'writer@example.com', role: 'user', is_banned: false }),
    ],
    content_reports: [seedRow('content_reports', {
      id: REPORT,
      category: 'hate_harassment',
      description: 'Targeted abuse of a named person.',
      reported_series: SERIES,
      reported_chapter: CHAPTER,
      reported_comment: COMMENT,
      status: 'pending',
      resolved_at: null,
      resolved_by: null,
      ...over,
    })],
    series: [seedRow('series', {
      id: SERIES, type: 'novel', owner: OWNER, author: 'Someone', title: 'Reported Work',
      status: 'Ongoing', synopsis: 'x', genres: [], tags: [], views: {},
      is_removed: false, takedown_reason: null, rights_attested_at: new Date(),
    })],
    chapters: [seedRow('chapters', {
      id: CHAPTER, series: SERIES, num: 1, title: 'One',
      paragraphs: [], views: 0, is_removed: false, takedown_reason: null,
    })],
    comments: [seedRow('comments', {
      id: COMMENT, series: SERIES, user: OWNER, rating: 1, text: 'nasty', is_removed: false,
    })],
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

  const call = async (method, path, { body, token } = {}) => {
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (_) { /* not json */ }
    return { status: res.status, json, text };
  };

  try {
    return await fn({
      call,
      fake,
      admin: jwt.sign({ id: ADMIN, role: 'admin' }, JWT_SECRET),
      writes: () => fake.log.filter((e) => /^(INSERT|UPDATE|DELETE)\b/.test(e.sql)),
      updatesOn: (table) => fake.log.filter((e) => new RegExp(`^UPDATE "${table}"`).test(e.sql)),
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    db.setPool(null);
    Base._clearColumnCache();
  }
}

/* ================================================================== *
 * Who may moderate
 * ================================================================== */

test('only an admin may act on a report', async () => {
  await withServer(world(), async ({ call, admin }) => {
    assert.equal((await call('PATCH', `/api/reports/${REPORT}`, { body: { status: 'actioned' } })).status, 401);

    const asUser = await call('PATCH', `/api/reports/${REPORT}`, {
      token: jwt.sign({ id: OWNER, role: 'user' }, JWT_SECRET), body: { status: 'actioned' },
    });
    assert.equal(asUser.status, 403, 'a normal user resolved a report');

    const asAdmin = await call('PATCH', `/api/reports/${REPORT}`, {
      token: admin, body: { status: 'actioned', target: 'none' },
    });
    assert.equal(asAdmin.status, 200, asAdmin.text);
  });
});

test('the admin queue and a single report are readable', async () => {
  await withServer(world(), async ({ call, admin, fake }) => {
    const list = await call('GET', '/api/reports', { token: admin });
    assert.equal(list.status, 200, list.text);
    assert.equal(list.json.reports.length, 1);

    // Filters are passed through, and the ceiling applies.
    fake.log.length = 0;
    const filtered = await call('GET', '/api/reports?status=pending&category=hate_harassment', { token: admin });
    assert.equal(filtered.status, 200);
    const read = fake.log.find((e) => /FROM "content_reports"/.test(e.sql));
    assert.match(read.sql, /"status"/);
    assert.match(read.sql, /"category"/);

    const one = await call('GET', `/api/reports/${REPORT}`, { token: admin });
    assert.equal(one.status, 200);
    assert.equal(one.json.report.id, REPORT);

    const missing = await call('GET', '/api/reports/88888888-8888-4888-8888-888888888888', { token: admin });
    assert.equal(missing.status, 404, 'a report that does not exist answered 200');
  });
});

/* ================================================================== *
 * What "actioned" does to content
 * ================================================================== */

test('actioning a report removes the chapter and stamps it with the reason', async () => {
  /*
   * The stamp is the whole point. A DMCA counter-notice sweep restores content
   * removed by *that* notice; a Content Policy removal carries no notice, so
   * without a reason it reads as "not ours" and stays down, and with a reason it
   * is explicitly not that notice's to restore. Losing the stamp would let a
   * copyright restoration silently resurrect content removed for harassment.
   */
  await withServer(world(), async ({ call, admin, updatesOn }) => {
    const res = await call('PATCH', `/api/reports/${REPORT}`, {
      token: admin, body: { status: 'actioned', target: 'chapter' },
    });
    assert.equal(res.status, 200, res.text);

    const chapters = updatesOn('chapters');
    assert.equal(chapters.length, 1, 'the chapter was not removed');
    assert.match(chapters[0].sql, /"is_removed"/);
    assert.match(chapters[0].sql, /"takedown_reason"/,
      'the removal carries no reason, so a DMCA restore could undo it');

    // The reason names the report, so an operator can trace it back.
    const reason = chapters[0].params.find((p) => typeof p === 'string' && p.includes('Content Policy'));
    assert.ok(reason, `the reason does not identify the report: ${JSON.stringify(chapters[0].params)}`);
    assert.match(reason, new RegExp(REPORT), 'the reason does not name the report it came from');

    // target: 'chapter' must not also take the series down.
    assert.equal(updatesOn('series').length, 0,
      'target=chapter removed the series as well');
  });
});

test('with no target, everything the report named comes down', async () => {
  // The option's own documentation: "Defaults to everything reported". The old
  // conditions left the comment up for `all`, so a report naming a comment and
  // actioned with no target resolved the report without removing anything.
  await withServer(world(), async ({ call, admin, updatesOn }) => {
    const res = await call('PATCH', `/api/reports/${REPORT}`, {
      token: admin, body: { status: 'actioned' },
    });
    assert.equal(res.status, 200, res.text);
    assert.equal(updatesOn('chapters').length, 1, 'the chapter was left up');
    assert.equal(updatesOn('series').length, 1, 'the series was left up');
    assert.equal(updatesOn('comments').length, 1, 'the comment was left up by a default action');
  });
});

test('target=comment takes down only the comment', async () => {
  await withServer(world(), async ({ call, admin, updatesOn }) => {
    const res = await call('PATCH', `/api/reports/${REPORT}`, {
      token: admin, body: { status: 'actioned', target: 'comment' },
    });
    assert.equal(res.status, 200, res.text);
    assert.equal(updatesOn('comments').length, 1, 'the comment was not removed');
    // The point of the fix: choosing a target removes exactly that thing. Before it,
    // this fell through both other branches and took the whole work down.
    assert.equal(updatesOn('chapters').length, 0,
      'target=comment removed the chapter as well - a moderator removing one comment '
      + 'took down the entire serial');
    assert.equal(updatesOn('series').length, 0,
      'target=comment removed the series as well');
  });
});

test('target=none removes nothing but still records the decision', async () => {
  // The useful case: upheld on the report, but the content stays. Used when a
  // report is technically valid but the content does not breach anything.
  await withServer(world(), async ({ call, admin, updatesOn }) => {
    const res = await call('PATCH', `/api/reports/${REPORT}`, {
      token: admin, body: { status: 'actioned', target: 'none', adminNotes: 'Reviewed; not a breach.' },
    });
    assert.equal(res.status, 200, res.text);

    for (const table of ['chapters', 'series', 'comments']) {
      assert.equal(updatesOn(table).length, 0, `target=none still removed a ${table}`);
    }
    // The report itself must still be updated, or the moderator's decision is lost.
    assert.equal(updatesOn('content_reports').length, 1,
      'the report was not updated, so the decision to remove nothing was not recorded');
  });
});

/* ================================================================== *
 * Bookkeeping
 * ================================================================== */

test('only a terminal status records who resolved it and when', async () => {
  /*
   * under_review is a holding state, not a resolution. Stamping resolvedAt on it
   * would make a report look closed to an auditor while a moderator is still
   * looking at it.
   */
  await withServer(world(), async ({ call, admin, updatesOn }) => {
    const held = await call('PATCH', `/api/reports/${REPORT}`, {
      token: admin, body: { status: 'under_review' },
    });
    assert.equal(held.status, 200, held.text);
    const update = updatesOn('content_reports')[0];
    assert.match(update.sql, /"status"/);
    assert.doesNotMatch(update.sql, /"resolved_at"/,
      'a report merely marked under_review was stamped as resolved');
    assert.doesNotMatch(update.sql, /"resolved_by"/);
  });

  for (const status of ['actioned', 'dismissed']) {
    await withServer(world(), async ({ call, admin, updatesOn }) => {
      const res = await call('PATCH', `/api/reports/${REPORT}`, { token: admin, body: { status } });
      assert.equal(res.status, 200, res.text);
      const update = updatesOn('content_reports')[0];
      assert.match(update.sql, /"resolved_at"/, `${status} did not stamp resolved_at`);
      assert.match(update.sql, /"resolved_by"/, `${status} did not record who resolved it`);
      assert.ok(
        update.params.includes(ADMIN) || /"resolved_by" = \$/.test(update.sql),
        `${status} did not record the moderator`,
      );
    });
  }
});

test('a dismissed report removes nothing at all', async () => {
  await withServer(world(), async ({ call, admin, updatesOn }) => {
    const res = await call('PATCH', `/api/reports/${REPORT}`, {
      token: admin, body: { status: 'dismissed', adminNotes: 'No breach.' },
    });
    assert.equal(res.status, 200, res.text);
    for (const table of ['chapters', 'series', 'comments']) {
      assert.equal(updatesOn(table).length, 0, `dismissing a report removed a ${table}`);
    }
  });
});

test('an unknown status or target is refused rather than stored', async () => {
  await withServer(world(), async ({ call, admin, writes }) => {
    for (const body of [
      { status: 'closed' },
      { status: 'ACTIONED' },
      { status: 'actioned', target: 'everything' },
      { status: 'actioned', target: 'chapter,series' },
      {},
    ]) {
      const res = await call('PATCH', `/api/reports/${REPORT}`, { token: admin, body });
      assert.equal(res.status, 400, `${JSON.stringify(body)} was accepted: ${res.text}`);
    }
    assert.deepEqual(writes(), [], 'a refused moderation call still wrote something');
  });
});

test('resolving a report that does not exist is a 404', async () => {
  await withServer(world(), async ({ call, admin }) => {
    const res = await call('PATCH', '/api/reports/88888888-8888-4888-8888-888888888888', {
      token: admin, body: { status: 'actioned' },
    });
    assert.equal(res.status, 404);
  });
});

test('actioning a report on already-removed content records the new reason', async () => {
  /*
   * A chapter removed by a DMCA notice and then reported: the moderation still
   * has to record its decision, and it overwrites takedown_reason with the
   * Content Policy one.
   *
   * That overwrite is defensible and is asserted here rather than wished away.
   * The content is now down for a Content Policy reason, so a DMCA counter-notice
   * that arrives later must *not* restore it - a copyright restoration must not be
   * able to bring back content that was independently removed for harassment. The
   * cost is that the original DMCA reason is no longer on the row, so the two
   * reasons are not both visible. Recording both would need a reasons table, which
   * is a schema change and not something to slip in here.
   *
   * What this pins is the current behaviour precisely, so that a change to it is
   * a decision rather than an accident.
   */
  await withServer(world({
    chapters: [seedRow('chapters', {
      id: CHAPTER, series: SERIES, num: 1, title: 'One', paragraphs: [],
      views: 0, is_removed: true, takedown_reason: 'DMCA takedown accepted (report d1)',
    })],
  }), async ({ call, admin, updatesOn }) => {
    const res = await call('PATCH', `/api/reports/${REPORT}`, {
      token: admin, body: { status: 'actioned', target: 'chapter' },
    });
    assert.equal(res.status, 200, res.text);

    const updates = updatesOn('chapters');
    assert.equal(updates.length, 1, 'the chapter was not touched at all');
    const reason = updates[0].params.find((p) => typeof p === 'string' && p.includes('Content Policy'));
    assert.ok(reason, `the reason was not replaced: ${JSON.stringify(updates[0].params)}`);
    assert.match(reason, new RegExp(REPORT), 'the new reason does not name its report');
  });
});

test('admin notes are bounded', async () => {
  await withServer(world(), async ({ call, admin }) => {
    const res = await call('PATCH', `/api/reports/${REPORT}`, {
      token: admin, body: { status: 'dismissed', adminNotes: 'x'.repeat(1001) },
    });
    assert.equal(res.status, 400);
  });
});