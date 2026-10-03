'use strict';

/**
 * The DMCA counter-notice lifecycle against real PostgreSQL.
 *
 * The point of the flow is state that spans several tables and a transaction: a
 * takedown is accepted, that records what it removed, the subscriber counters,
 * and then either the complainant's court action keeps the content down or the
 * window lapses and it comes back. A recording double cannot tell you whether
 * any of that holds, because it does not enforce the unique index, does not
 * read back what was written, and has no foreign keys.
 *
 * The cases that matter:
 *
 *   - accepting a takedown records *what* it removed, so restoration has a
 *     target;
 *   - a second counter-notice for the same takedown is refused by the database,
 *     not by a race in application code;
 *   - a window that has not lapsed restores nothing;
 *   - content removed for a *different* reason is never restored, even by a
 *     lapsed counter-notice - this is the court-order case;
 *   - a series stays down while one of its chapters is still removed.
 */

process.env.DATABASE_URL ||= 'postgresql://vorth:vorth@127.0.0.1:5432/vorth_test';
process.env.DATABASE_SSL = 'false';
process.env.JWT_SECRET ||= 'live-secret';
process.env.NODE_ENV = 'test';
// The counter-notice endpoint forwards to the complainant; console transport
// logs instead of sending, which is what a test wants.
process.env.MAIL_TRANSPORT = 'console';

const test = require('node:test');
const { after } = require('node:test');
const assert = require('node:assert');

const { pool, connectDB } = require('../src/config/db');
const User = require('../src/models/User');
const Series = require('../src/models/Series');
const Chapter = require('../src/models/Chapter');
const DMCAReport = require('../src/models/DMCAReport');
const DMCACounterNotice = require('../src/models/DMCACounterNotice');
const Notification = require('../src/models/Notification');
const dmcaController = require('../src/controllers/dmcaController');
const counter = require('../src/controllers/dmcaCounterNoticeController');
const { businessDaysBetween } = require('../src/services/businessDays');

const MARK = `cn${Date.now().toString(36)}`;

/** Minimal Express double, enough for the asyncHandler-wrapped controllers. */
function res() {
  const r = {
    statusCode: 200,
    body: undefined,
    status(c) { r.statusCode = c; return r; },
    json(p) { r.body = p; return r; },
  };
  return r;
}

/**
 * Runs a controller handler.
 *
 * Accepts either shape the controllers use: a bare asyncHandler, or the
 * [validators..., asyncHandler] array, in which case the terminal handler is
 * the one under test. Validation itself is covered by the HTTP suite; this
 * bypasses it deliberately so the state machine can be driven directly.
 *
 * Settles when the handler either responds or calls next(err), whichever comes
 * first. An earlier version fell back to setImmediate, which raced the handler:
 * every assertion ran against a half-finished request and reported success for
 * calls that had in fact thrown.
 */
function invoke(chain, req) {
  const handler = typeof chain === 'function' ? chain : chain[chain.length - 1];
  return new Promise((resolve) => {
    const r = res();
    let settled = false;
    const settle = (error) => {
      if (settled) return;
      settled = true;
      resolve({ res: r, error: error || null });
    };
    const json = r.json.bind(r);
    r.json = (payload) => {
      json(payload);
      settle(null);
      return r;
    };
    handler(req, r, settle);
  });
}

/*
 * The pool is a module singleton, so it is connected once for the whole file and
 * closed once at the end. Ending it per test made every test after the first
 * fail with "Called end on pool more than once", which reads like a cascade of
 * product bugs and is not one.
 */
let connected = false;
async function db() {
  if (!connected) {
    await connectDB();
    connected = true;
  }
}

after(async () => {
  if (!connected) return;
  // Best effort: the admin row is reused across tests, so it is removed once at
  // the end rather than after each. A failure here must not mask a test failure.
  await User.deleteMany({ username: `${MARK}admin` }).catch(() => {});
  await pool.end();
});

/**
 * An admin row that actually exists.
 *
 * resolved_by references users(id) on both tables, so an invented uuid fails the
 * foreign key. It looks harmless against a double and stops working the moment
 * the test touches a database.
 *
 * Reused rather than created per test: username is unique, and a row left behind
 * by an interrupted run would otherwise make every later run fail on the second
 * test instead of on the thing that actually broke.
 */
async function adminUser() {
  const username = `${MARK}admin`;
  const existing = await User.findOne({ username });
  if (existing) return existing;
  return User.create({
    displayName: 'Moderator',
    username,
    email: `${MARK}admin@example.test`,
    password: 'correct horse battery',
    role: 'admin',
    agreedToTermsAt: new Date(),
    ageConfirmed: true,
  });
}

const AFFIRMATIONS = {
  goodFaithStatement: true,
  perjuryStatement: true,
  jurisdictionStatement: true,
};

/** Files a notice against a chapter, then accepts it. Returns the report. */
async function acceptTakedown(admin, chapterId, seriesId) {
  const report = await DMCAReport.create({
    reporterName: 'Ada Rights Holder',
    reporterEmail: 'ada@example.test',
    reporterOrganization: 'Example Press',
    reporterAddress: '1 Press Row',
    copyrightedWorkDescription: 'The Lantern, first edition',
    goodFaithStatement: true,
    accuracyStatement: true,
    signature: 'Ada Rights Holder',
    infringingChapter: chapterId,
    infringingSeries: seriesId,
  });

  const { error } = await invoke(dmcaController.resolve, {
    params: { id: report._id },
    body: { status: 'accepted', adminNotes: 'Takedown accepted in test.' },
    user: { id: admin.id },
  });
  assert.equal(error, null, `resolve failed: ${error && error.message}`);
  return report;
}

function counterNoticeBody(overrides = {}) {
  return Object.assign({
    subscriberName: 'Sam Subscriber',
    subscriberEmail: 'sam@example.test',
    subscriberAddress: '9 Example Street, Springfield',
    identifiedMaterial: 'Chapter 1 of The Lantern, reproduced without permission',
    materialLocation: `https://vorth.example/series/${MARK}/chapter-1`,
    signature: 'Sam Subscriber',
  }, AFFIRMATIONS, overrides);
}

/** A series with one chapter, owned by a throwaway user. */
function scenario(suffix, title) {
  return (async () => {
    const owner = await User.create({
      displayName: `Owner ${suffix}`,
      username: `${MARK}${suffix}`,
      email: `${MARK}${suffix}@example.test`,
      password: 'correct horse battery',
      agreedToTermsAt: new Date(),
      ageConfirmed: true,
    });
    const series = await Series.create({
      title: `${MARK} ${title}`, type: 'novel', owner: owner.id, author: 'A',
      synopsis: 'x', genres: ['Fantasy'], tags: [], rightsAttestedAt: new Date(),
    });
    const chapter = await Chapter.create({
      series: series.id, num: 1, title: 'One', paragraphs: ['p'],
    });
    return { owner, series, chapter };
  })();
}

/**
 * Teardown, in dependency order.
 *
 * Nothing cascades: notifications reference the series, dmca_counter_notices
 * reference the notice, and dmca_reports reference the content. All deliberate
 * for a legal record - a counter-notice is meaningless without its notice, a
 * takedown should outlive the content it references - but it makes the order
 * here load-bearing rather than tidy.
 */
async function cleanup({ owner, series }, report) {
  await Notification.deleteMany({ user: owner.id });
  await DMCACounterNotice.deleteMany({ dmcaReport: report._id });
  await DMCAReport.deleteMany({ id: report._id });
  await Chapter.deleteMany({ series: series.id });
  await Series.deleteMany({ id: series.id });
  await User.deleteMany({ username: owner.username });
}

test('a counter-notice records the window and the takedown records what it removed', { skip: !process.env.VORTH_LIVE_DB }, async () => {
  await db();
  const admin = await adminUser();
  const world = await scenario('a', 'Lantern');
  const report = await acceptTakedown(admin, world.chapter.id, world.series.id);

  try {
    /* --- acceptance records what it removed ---------------------------- */
    const afterAccept = await DMCAReport.findById(report._id);
    assert.equal(afterAccept.status, 'accepted');
    assert.ok(afterAccept.removalAt, 'acceptance must record when the removal happened');
    assert.equal(
      String(afterAccept.removalChapter), world.chapter.id,
      'the removed chapter was not recorded, so there would be nothing to restore'
    );
    assert.equal(String(afterAccept.removalSeries), world.series.id);
    assert.equal(
      String((await Chapter.findById(world.chapter.id)).isRemoved), 'true',
      'the chapter should be down after an accepted takedown'
    );

    /* --- the subscriber counters --------------------------------------- */
    const filed = await invoke(counter.submitCounterNotice, {
      params: { id: report._id },
      body: counterNoticeBody(),
    });
    assert.equal(filed.error, null, `filing failed: ${filed.error && filed.error.message}`);
    assert.equal(filed.res.statusCode, 201);
    assert.ok(filed.res.body.counterNoticeId, 'no counter-notice id was returned');

    const notice = await DMCACounterNotice.findById(filed.res.body.counterNoticeId);
    assert.equal(String(notice.dmcaReport), report._id);
    assert.ok(notice.forwardedAt, 'the forward date was not recorded');
    assert.ok(notice.responseDeadline, 'no response deadline was computed');

    /* --- the window is business days, measured from the forward --------- */
    const span = businessDaysBetween(notice.forwardedAt, notice.responseDeadline);
    assert.equal(
      span, 10,
      `the window must be 10 business days, got ${span} `
      + `(${notice.forwardedAt.toISOString()} -> ${notice.responseDeadline.toISOString()})`
    );
    assert.equal(
      new Date(filed.res.body.responseDeadline).getTime(),
      new Date(notice.responseDeadline).getTime(),
      'the deadline returned to the subscriber must be the stored one'
    );

    /* --- a window that has not lapsed restores nothing ------------------- */
    const early = await counter.restoreLapsed({ now: new Date(), dmcaReport: report._id });
    assert.equal(early.outcomes.length, 0, 'nothing is due yet');
    assert.equal(
      String((await Chapter.findById(world.chapter.id)).isRemoved), 'true',
      'content was restored before the window lapsed'
    );

    /* --- a court action keeps it down ----------------------------------- */
    const contested = await invoke(counter.resolveCounterNotice, {
      params: { id: notice._id },
      body: { outcome: 'court_action', adminNotes: 'They filed.' },
      user: { id: admin.id },
    });
    assert.equal(contested.error, null, contested.error && contested.error.message);
    assert.equal(contested.res.body.counterNotice.status, 'contested');
    assert.equal(
      String((await Chapter.findById(world.chapter.id)).isRemoved), 'true',
      'a contested counter-notice must leave the content down'
    );
  } finally {
    await cleanup(world, report);
  }
});

test('a second counter-notice for the same takedown is refused', { skip: !process.env.VORTH_LIVE_DB }, async () => {
  await db();
  const admin = await adminUser();
  const world = await scenario('b', 'Twice');
  const report = await acceptTakedown(admin, world.chapter.id, world.series.id);

  try {
    const first = await invoke(counter.submitCounterNotice, {
      params: { id: report._id }, body: counterNoticeBody(),
    });
    assert.equal(first.error, null, first.error && first.error.message);

    // The unique index is the only thing that stops two submissions racing past
    // each other and both starting a clock on the same takedown.
    const second = await invoke(counter.submitCounterNotice, {
      params: { id: report._id },
      body: counterNoticeBody({ subscriberEmail: 'other@example.test' }),
    });
    assert.ok(second.error, 'a second counter-notice was accepted');
    assert.equal(second.error.statusCode, 409, `expected 409, got ${second.error.statusCode}`);
    const persisted = await DMCACounterNotice.find({ dmcaReport: report._id }).exec();
    assert.equal(persisted.length, 1, 'more than one counter-notice was persisted');
  } finally {
    await cleanup(world, report);
  }
});

test('an unaccepted takedown cannot be counter-noticed', { skip: !process.env.VORTH_LIVE_DB }, async () => {
  await db();
  const report = await DMCAReport.create({
    reporterName: 'Ada', reporterEmail: 'ada2@example.test',
    copyrightedWorkDescription: 'Something', signature: 'Ada',
    goodFaithStatement: true, accuracyStatement: true,
  });

  try {
    // Nothing was removed, so there is nothing to contest. Accepting this would
    // mean a counter-notice against a takedown that never took anything down.
    const { error } = await invoke(counter.submitCounterNotice, {
      params: { id: report._id }, body: counterNoticeBody(),
    });
    assert.ok(error, 'a pending takedown accepted a counter-notice');
    assert.equal(error.statusCode, 400);
    assert.match(error.message, /nothing to counter-notice/);
  } finally {
    await DMCAReport.deleteMany({ id: report._id });
  }
});

test('a lapsed window restores the chapter but not a series with another chapter removed', { skip: !process.env.VORTH_LIVE_DB }, async () => {
  await db();
  const admin = await adminUser();
  const world = await scenario('c', 'Sweep');
  const other = await Chapter.create({
    series: world.series.id, num: 2, title: 'Two', paragraphs: ['p'],
  });

  const report = await acceptTakedown(admin, world.chapter.id, world.series.id);
  try {
    const filed = await invoke(counter.submitCounterNotice, {
      params: { id: report._id }, body: counterNoticeBody(),
    });
    assert.equal(filed.error, null, filed.error && filed.error.message);
    const notice = await DMCACounterNotice.findById(filed.res.body.counterNoticeId);

    // Somebody separately removed the second chapter. The series must not come
    // back while that chapter is still down, or the removal is undone.
    await Chapter.findByIdAndUpdate(other.id, { isRemoved: true });

    const dueAt = new Date(notice.responseDeadline.getTime() + 60000);

    /* --- a dry run reports what it would do and changes nothing ---------- */
    const dry = await counter.restoreLapsed({ now: dueAt, dryRun: true, dmcaReport: report._id });
    assert.equal(dry.outcomes.length, 1, 'the lapsed notice was not due');
    assert.equal(dry.outcomes[0].action, 'would-restore');
    assert.equal(
      String((await Chapter.findById(world.chapter.id)).isRemoved), 'true',
      'a dry run changed the database'
    );

    /* --- the real sweep -------------------------------------------------- */
    const sweep = await counter.restoreLapsed({ now: dueAt, dmcaReport: report._id });
    assert.equal(sweep.outcomes.length, 1);
    assert.equal(sweep.outcomes[0].action, 'restored');

    assert.equal(
      String((await Chapter.findById(world.chapter.id)).isRemoved), 'false',
      'the countered chapter stayed down'
    );
    assert.equal(
      String((await Series.findById(world.series.id)).isRemoved), 'true',
      'the series was restored while one of its chapters was still removed'
    );
    assert.equal(
      String((await Chapter.findById(other.id)).isRemoved), 'true',
      'a chapter removed for another reason was restored'
    );

    /* --- a resolved notice is never swept twice -------------------------- */
    const again = await counter.restoreLapsed({ now: dueAt, dmcaReport: report._id });
    assert.equal(again.outcomes.length, 0, 'an already-resolved notice was swept twice');
  } finally {
    await cleanup(world, report);
  }
});

test('content removed for another reason survives a lapsed counter-notice', { skip: !process.env.VORTH_LIVE_DB }, async () => {
  await db();
  const admin = await adminUser();
  const world = await scenario('d', 'Court');
  const report = await acceptTakedown(admin, world.chapter.id, world.series.id);

  try {
    const filed = await invoke(counter.submitCounterNotice, {
      params: { id: report._id }, body: counterNoticeBody(),
    });
    assert.equal(filed.error, null, filed.error && filed.error.message);
    const notice = await DMCACounterNotice.findById(filed.res.body.counterNoticeId);

    /*
     * A court order supersedes the DMCA outcome. This is the case the ownership
     * guard exists for: without it the sweep un-hides material a court is
     * keeping down, which is the one failure with no safe default.
     *
     * Both the chapter and the series have to be re-removed *with a reason*.
     * Setting is_removed alone would leave the DMCA reason in place, and
     * restoring would then be the correct behaviour - the guard can only judge
     * ownership by what the row says, and a row that says DMCA is DMCA's.
     */
    await Chapter.findByIdAndUpdate(world.chapter.id, {
      isRemoved: true,
      takedownReason: 'Removed by court order (see docket 2026-CV-1)',
    });
    await Series.findByIdAndUpdate(world.series.id, {
      isRemoved: true,
      takedownReason: 'Removed by court order (see docket 2026-CV-1)',
    });

    const sweep = await counter.restoreLapsed({
      now: new Date(notice.responseDeadline.getTime() + 60000),
      dmcaReport: report._id,
    });
    assert.equal(sweep.outcomes.length, 1);

    assert.equal(
      String((await Chapter.findById(world.chapter.id)).isRemoved), 'true',
      'the chapter was restored despite being re-removed under a court order'
    );
    const series = await Series.findById(world.series.id);
    assert.equal(
      String(series.isRemoved), 'true',
      'the series was restored despite a court order keeping it down'
    );
    assert.equal(
      String(series.takedownReason), 'Removed by court order (see docket 2026-CV-1)',
      'the court order reason was overwritten'
    );
    assert.equal(
      String((await Chapter.findById(world.chapter.id)).takedownReason),
      'Removed by court order (see docket 2026-CV-1)',
      "the chapter's court order reason was overwritten"
    );
    // The counter-notice is still resolved - the window did lapse - but nothing
    // was put back, so the outcome has to say so rather than reporting success.
    const outcomes = sweep.outcomes[0].restored;
    assert.equal(
      outcomes.length, 0,
      `the sweep reported restoring ${JSON.stringify(outcomes)} but nothing was owned by this report`
    );
  } finally {
    await cleanup(world, report);
  }
});

test('accepting a takedown notifies the publisher and lets them find it', { skip: !process.env.VORTH_LIVE_DB }, async () => {
  await db();
  const admin = await adminUser();
  const world = await scenario('f', 'Notify');

  const report = await acceptTakedown(admin, world.chapter.id, world.series.id);

  try {
    /*
     * DMCA_POLICY.md promises the publishing user is notified. If nothing creates
     * that notification the policy is asserting something false - and the
     * subscriber loses their chance to contest before they know anything
     * happened.
     */
    const notifications = await Notification.find({ user: world.owner.id }).exec();
    assert.equal(notifications.length, 1, 'the publisher was not notified');
    const note = notifications[0];
    assert.equal(note.type, 'dmca_takedown');
    // The id has to be in the message: the counter-notice endpoint is keyed on
    // it and nothing else exposes it, so a notification without it is a dead end.
    assert.match(note.message, new RegExp(report._id), 'the notice does not carry the takedown id');
    assert.match(note.message, /counter-notice/, 'the notice does not mention the remedy');

    /*
     * And the publisher can actually reach it: the endpoint is keyed on the
     * takedown id, so without this list the flow exists but cannot be used.
     */
    const listed = await invoke(counter.listMyTakedowns, {
      user: { id: world.owner.id },
    });
    assert.equal(listed.error, null, listed.error && listed.error.message);
    assert.equal(listed.res.body.takedowns.length, 1, 'the publisher cannot see their own takedown');

    const mine = listed.res.body.takedowns[0];
    assert.equal(mine.id, report._id);
    assert.equal(mine.canCounterNotice, true, 'the endpoint says the publisher cannot counter-notice');
    assert.equal(mine.removedChapter, world.chapter.id);
    // 512(g)(3)(B) needs the subscriber to know what was claimed.
    assert.equal(mine.copyrightedWorkDescription, 'The Lantern, first edition');

    /*
     * The complainant's personal data must not be here. The subscriber needs to
     * identify the material; they do not need the reporter's address.
     */
    const serialised = JSON.stringify(mine);
    for (const field of ['reporterName', 'reporterEmail', 'reporterAddress', 'reporterOrganization']) {
      assert.ok(!(field in mine), `${field} was exposed to the publisher`);
    }
    assert.ok(!serialised.includes('ada@example.test'), 'the complainant email leaked');
    assert.ok(!serialised.includes('Example Press'), 'the complainant organisation leaked');
    assert.ok(!serialised.includes('1 Press Row'), 'the complainant address leaked');

    /* --- a stranger cannot see someone else's takedown --------------------- */
    const stranger = await User.create({
      displayName: 'Stranger', username: `${MARK}g`, email: `${MARK}g@example.test`,
      password: 'correct horse battery',
      agreedToTermsAt: new Date(), ageConfirmed: true,
    });
    const theirs = await invoke(counter.listMyTakedowns, { user: { id: stranger.id } });
    assert.equal(theirs.error, null);
    assert.equal(
      theirs.res.body.takedowns.length, 0,
      "one user's takedown list showed another user's content"
    );
    await User.deleteMany({ username: `${MARK}g` });

    /* --- once countered, it is no longer open, and shows the deadline ------ */
    const filed = await invoke(counter.submitCounterNotice, {
      params: { id: report._id }, body: counterNoticeBody(),
    });
    assert.equal(filed.error, null, filed.error && filed.error.message);

    const after = await invoke(counter.listMyTakedowns, { user: { id: world.owner.id } });
    const row = after.res.body.takedowns[0];
    assert.equal(row.canCounterNotice, false, 'a second counter-notice would be offered');
    assert.ok(row.counterNotice, 'the publisher cannot see their own counter-notice');
    assert.ok(
      row.counterNotice.responseDeadline,
      'the publisher cannot see the window their material may stay down for'
    );
  } finally {
    await cleanup(world, report);
    await User.deleteMany({ username: `${MARK}admin` });
  }
});

test('a counter-notice cannot be resolved twice', { skip: !process.env.VORTH_LIVE_DB }, async () => {
  await db();
  const admin = await adminUser();
  const world = await scenario('e', 'Once');
  const report = await acceptTakedown(admin, world.chapter.id, world.series.id);

  try {
    const filed = await invoke(counter.submitCounterNotice, {
      params: { id: report._id }, body: counterNoticeBody(),
    });
    assert.equal(filed.error, null, filed.error && filed.error.message);

    const first = await invoke(counter.resolveCounterNotice, {
      params: { id: filed.res.body.counterNoticeId },
      body: { outcome: 'court_action' },
      user: { id: admin.id },
    });
    assert.equal(first.error, null, first.error && first.error.message);

    const second = await invoke(counter.resolveCounterNotice, {
      params: { id: filed.res.body.counterNoticeId },
      body: { outcome: 'restore' },
      user: { id: admin.id },
    });
    assert.ok(second.error, 'a resolved counter-notice was resolved again');
    assert.equal(second.error.statusCode, 409);
    assert.equal(
      String((await Chapter.findById(world.chapter.id)).isRemoved), 'true',
      'the second resolution undid the first'
    );
  } finally {
    await cleanup(world, report);
  }
});