'use strict';

/**
 * DMCA counter-notice: validation, the forwarded text, and route ordering.
 *
 * The full lifecycle needs a real database and lives in
 * test/counterNotice.live.test.js. What is checked here is everything that can
 * be wrong without one: what the endpoint accepts, what the complainant is
 * actually told, and whether the routes resolve the way they read.
 */

process.env.DATABASE_URL ||= 'postgres://stub/stub';
process.env.DATABASE_SSL = 'false';
process.env.JWT_SECRET ||= 'test-secret';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');

const controller = require('../src/controllers/dmcaCounterNoticeController');
const env = require('../src/config/env');
const { addBusinessDays } = require('../src/services/businessDays');

const REPORT_ID = '55555555-5555-4555-8555-555555555555';

const report = {
  _id: REPORT_ID,
  reporterName: 'Ada Rights Holder',
  reporterEmail: 'ada@example.test',
  reporterOrganization: 'Example Press',
  copyrightedWorkDescription: 'The Lantern, first edition',
};

/* ------------------------------------------------------------------ *
 * The text forwarded to the complainant.
 * ------------------------------------------------------------------ */

test('the forwarded text carries every statutory statement verbatim', () => {
  const body = controller._forwardBody(report, {
    subscriberName: 'Sam Subscriber',
    subscriberEmail: 'sam@example.test',
    subscriberAddress: '9 Example Street, Springfield',
    identifiedMaterial: 'Chapter 12, reproduced without permission',
    materialLocation: 'https://vorth.example/series/lantern/chapter-12',
    signature: 'Sam Subscriber',
    responseDeadline: '2026-04-07T00:00:00.000Z',
  });

  // 512(g)(2)(A) requires the counter-notice itself to be provided, so each
  // statement has to appear in full rather than as a summary. The patterns are
  // whitespace-tolerant because the body is hard-wrapped for email.
  const ws = (s) => s.replace(/\s+/g, '\\s+');
  assert.match(body, /Sam Subscriber/, 'the subscriber name is missing');
  assert.match(body, /9 Example Street, Springfield/, 'the service address is missing');
  assert.match(body, /Chapter 12, reproduced without permission/, 'what was removed is missing');
  assert.match(body, /series\/lantern\/chapter-12/, 'where it appeared is missing');
  assert.match(body, new RegExp(ws('good faith belief that the material was removed or disabled as a result of mistake or misidentification')));
  assert.match(body, new RegExp(ws('accept service of process from you')));
  assert.match(body, new RegExp(ws('jurisdiction of the Federal District Court')));
  assert.match(body, /under penalty of perjury/);
  assert.match(body, /FILED A COURT ACTION/, 'the court-action instruction is missing');
  assert.match(body, new RegExp(REPORT_ID), 'the notice must be quotable');
  assert.match(body, /2026-04-07T00:00:00\.000Z/, 'the deadline must be the real one');
});

test('the forwarded text does not leak an internal placeholder', () => {
  const body = controller._forwardBody(report, {
    subscriberName: 'S', subscriberEmail: 's@example.test', subscriberAddress: 'A',
    identifiedMaterial: 'M', materialLocation: 'L', signature: 'S',
    responseDeadline: '2026-04-07T00:00:00.000Z',
  });
  // A draft of this used to render "Response deadline: <unset>", which would
  // have been forwarded to a real rights holder.
  assert.ok(!/<unset>|undefined|\[object/.test(body), 'a placeholder leaked into the forwarded text');
});

/* ------------------------------------------------------------------ *
 * The takedown-ownership guard.
 * ------------------------------------------------------------------ */

test('only content still removed by this report is owned by it', () => {
  const reason = `DMCA takedown accepted (report ${REPORT_ID})`;

  assert.equal(
    controller._ownedByThisReport({ isRemoved: true, takedownReason: reason }, reason),
    true,
  );
  // Removed again for another reason, e.g. a court order or a fresh complaint.
  assert.equal(
    controller._ownedByThisReport(
      { isRemoved: true, takedownReason: 'DMCA takedown accepted (report other-id)' }, reason
    ),
    false,
  );
  assert.equal(
    controller._ownedByThisReport({ isRemoved: true, takedownReason: null }, reason),
    false,
  );
  // Already restored by hand.
  assert.equal(controller._ownedByThisReport({ isRemoved: false }, reason), false);
  assert.equal(controller._ownedByThisReport(null, reason), false);
});

/* ------------------------------------------------------------------ *
 * Configuration.
 * ------------------------------------------------------------------ */

test('the response window defaults to the earliest statutory bound', () => {
  // 512(g)(2)(C) allows 10 to 14 business days. Anything shorter would strip
  // the complainant of time they are entitled to.
  assert.equal(env.dmcaCounterNoticeDays, 10);
});

test('the response window is clamped to the statutory range', () => {
  // Verified against a fresh module instance per value, because env is read
  // once at require time.
  const load = (value) => {
    const key = 'DMCA_COUNTER_NOTICE_DAYS';
    const previous = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
    delete require.cache[require.resolve('../src/config/env')];
    const loaded = require('../src/config/env').dmcaCounterNoticeDays;
    delete require.cache[require.resolve('../src/config/env')];
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
    return loaded;
  };

  assert.equal(load(undefined), 10, 'the default is 10');
  assert.equal(load('14'), 14, 'the outer bound is allowed');
  assert.equal(load('20'), 14, 'above the outer bound is clamped, not honoured');
  assert.equal(load('3'), 10, 'below the inner bound is clamped, not honoured');
  assert.equal(load('nonsense'), 10, 'junk falls back to the default');
});

/* ------------------------------------------------------------------ *
 * The window arithmetic the endpoint depends on.
 * ------------------------------------------------------------------ */

test('the deadline is ten business days from the forward, not ten calendar days', () => {
  // A Friday forward: ten calendar days would be the following Thursday, which
  // is only six business days and would cut the window short.
  const forwarded = '2026-03-06T15:00:00Z';
  const deadline = addBusinessDays(forwarded, env.dmcaCounterNoticeDays);
  assert.equal(deadline.toISOString().slice(0, 10), '2026-03-20');
});

/* ------------------------------------------------------------------ *
 * Route ordering.
 * ------------------------------------------------------------------ */

test('the counter-notice collection routes are declared before /:id', () => {
  /*
   * Express matches in declaration order, so if "/counter-notices" came after
   * "/:id" it would be read as a report id called "counter-notices" and fail
   * the UUID check. Asserting the layer order is the only way this is caught
   * without a live request.
   */
  const router = require('../src/routes/dmcaRoutes');
  const layers = router.stack
    .filter((l) => l.route)
    .map((l) => `${Object.keys(l.route.methods)[0].toUpperCase()} ${l.route.path}`);

  // Exact match, not substring: "/:id" is a substring of "/:id/counter-notice",
  // so matching loosely compares the wrong two layers and reports a failure
  // that does not exist.
  const idx = (method, path) => {
    const at = layers.indexOf(`${method} ${path}`);
    assert.notEqual(at, -1, `route not declared: ${method} ${path}\n  ${layers.join('\n  ')}`);
    return at;
  };

  assert.ok(
    idx('GET', '/counter-notices') < idx('GET', '/:id'),
    `"GET /counter-notices" must be declared before "GET /:id". Order was:\n  ${layers.join('\n  ')}`
  );
  assert.ok(
    idx('GET', '/counter-notices/:id') < idx('GET', '/:id'),
    `"GET /counter-notices/:id" must be declared before "GET /:id". Order was:\n  ${layers.join('\n  ')}`
  );
  assert.ok(
    idx('PATCH', '/counter-notices/:id') < idx('PATCH', '/:id'),
    `"PATCH /counter-notices/:id" must be declared before "PATCH /:id". Order was:\n  ${layers.join('\n  ')}`
  );
  // The publisher-facing list has the same hazard: "mine" is not a UUID.
  assert.ok(
    idx('GET', '/mine') < idx('GET', '/:id'),
    `"GET /mine" must be declared before "GET /:id". Order was:\n  ${layers.join('\n  ')}`
  );
  assert.equal(
    layers.filter((l) => l === 'POST /').length, 1,
    'the takedown notice endpoint must be declared exactly once'
  );
});

test('the public DMCA endpoints are the only ones without a session', () => {
  const router = require('../src/routes/dmcaRoutes');
  const { protect } = require('../src/middleware/auth');

  /*
   * Compared by identity, not by function name: protect is wrapped in
   * asyncHandler, so its .name is not 'protect' and a name check silently
   * reports every route as unprotected.
   */
  const chains = router.stack.filter((l) => l.route).map((l) => ({
    method: Object.keys(l.route.methods)[0].toUpperCase(),
    path: l.route.path,
    guarded: l.route.stack.some((s) => s.handle === protect),
  }));

  const unsecured = chains.filter((c) => !c.guarded);
  assert.deepEqual(
    unsecured.map((c) => `${c.method} ${c.path}`).sort(),
    ['POST /', 'POST /:id/counter-notice'],
    'only the takedown notice and the counter-notice may be public'
  );
  assert.equal(chains.length, 9, `expected 9 DMCA routes, found ${chains.length}`);
});

test('the publisher takedown list is scoped to a signed-in user', () => {
  // An unauthenticated caller must not be able to enumerate takedowns. The
  // handler reads req.user.id, so the route must have protect() in front of it.
  const router = require('../src/routes/dmcaRoutes');
  const { protect } = require('../src/middleware/auth');
  const layer = router.stack.filter((l) => l.route).find(
    (l) => l.route.path === '/mine' && Object.keys(l.route.methods).includes('get')
  );
  assert.ok(layer, 'GET /mine is not declared');
  assert.ok(
    layer.route.stack.some((s) => s.handle === protect),
    'GET /mine has no protect()'
  );
});

test('both public DMCA endpoints are rate limited', () => {
  const router = require('../src/routes/dmcaRoutes');
  const publicPosts = router.stack.filter(
    (l) => l.route && l.route.methods.post
  );
  assert.equal(publicPosts.length, 2, 'expected the notice and counter-notice posts');
  for (const layer of publicPosts) {
    // The limiter sits in the handler chain for each; an empty chain would mean
    // the endpoint is reachable at the general limit.
    assert.ok(
      layer.route.stack.length >= 2,
      `${layer.route.path} has no rate limiter in its handler chain`
    );
  }
});