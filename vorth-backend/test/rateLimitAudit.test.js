'use strict';

/**
 * Rate limits, audited by route class.
 *
 * Phase 3 of this work promised an audit of the abuse surface per route class and
 * never ran it. What review can do is check that a limiter is mounted; what it
 * cannot do is know whether the limit is proportionate to what the route costs.
 * A route that writes one row and a route that writes 480 MB can share a number
 * and only one of them is safe.
 *
 * So this classifies every route by what it costs - not by what it returns - and
 * asserts that cost is bounded. Two things are checked, separately:
 *
 *   1. Every /api route sits behind a limiter. Mount-level, derived from the
 *      router rather than restated, so a route added outside the covered mounts
 *      is caught.
 *
 *   2. Every unauthenticated route that mutates state, sends email, or writes to
 *      disk has a limit tighter than the general one, because those are the ones
 *      a stranger can reach. Derived from the reviewed matrix in authMatrix, so
 *      it cannot drift from the access levels already pinned there.
 *
 * The interesting finding is the upload class, which is why the arithmetic is
 * asserted rather than the configuration. Uploads take 60 files of up to 8 MB in
 * a single request - 480 MB - and were behind the general limit of 300 requests
 * per 15 minutes. That is 144 GB per IP per window, on a host with no disk
 * ceiling and no per-user storage accounting anywhere in the schema. Every other
 * expensive class had its own limiter; this one had the loosest.
 */

process.env.DATABASE_URL ||= 'postgres://stub/stub';
process.env.DATABASE_SSL = 'false';
process.env.JWT_SECRET ||= 'test-secret';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '..', 'src');
const ROUTES = path.join(SRC, 'routes');
const APP = path.join(SRC, 'app.js');

/* ================================================================== *
 * Reading the actual configuration
 * ================================================================== */

/** env.js defaults, as parsed numbers rather than as source text. */
function limits() {
  const env = require('../src/config/env');
  return {
    general: env.rateLimitMaxRequests,
    auth: env.authRateLimitMaxRequests,
    dmca: env.dmcaRateLimitMaxRequests,
    upload: env.uploadRateLimitMaxRequests,
    windowMinutes: env.rateLimitWindowMinutes,
    maxUploadMb: env.maxUploadMb,
    maxFilesPerRequest: require('../src/middleware/upload').MAX_FILES_PER_REQUEST,
  };
}

/** Which limiter, if any, each route file mounts on an individual route. */
function perRouteLimiters() {
  const found = new Map();
  for (const file of fs.readdirSync(ROUTES)) {
    if (!file.endsWith('Routes.js')) continue;
    const src = fs.readFileSync(path.join(ROUTES, file), 'utf8');

    /*
     * Mounts in front of a handler: `router.post('/x', someLimiter, handler)`.
     *
     * Keys are built from the file's base name, without the extension. The first
     * version keyed on the filename and the lookups below were written against a
     * prefix without it, so `authRoutes.js:POST /login`.startsWith('authRoutes:')
     * was false - every per-route assertion silently matched nothing and reported
     * "found 0" as though that were a finding about the code. Three assertions in
     * this file were passing on emptiness for as long as it took to notice that
     * "found 0" is not the same as "the guard works".
     */
    const routeFile = file.replace(/\.js$/, '');
    for (const m of src.matchAll(/router\.(get|post|patch|delete|put)\(\s*'([^']*)'\s*,\s*([A-Za-z_$][\w$]*Limiter)/g)) {
      const key = `${routeFile}:${m[1].toUpperCase()} ${m[2]}`;
      found.set(key, m[3]);
    }
    // Mounted for a whole router: `router.use(dmcaLimiter)`.
    for (const m of src.matchAll(/router\.use\(\s*([A-Za-z_$][\w$]*Limiter)\s*\)/g)) {
      found.set(`${routeFile}:router-wide`, m[1]);
    }
  }
  return found;
}

/* ================================================================== *
 * 1. Every route is behind a limiter
 * ================================================================== */

test('the general limiter is mounted on /api, ahead of every route', () => {
  /*
   * Mount-level. The assertion is about position, not presence: a limiter
   * registered after `app.use('/api', routes)` would exist and do nothing,
   * because the routes would already have answered.
   */
  const src = fs.readFileSync(APP, 'utf8');
  const limiterAt = src.indexOf("app.use('/api', generalLimiter)");
  const routesAt = src.indexOf("app.use('/api', routes)");

  assert.ok(limiterAt !== -1, 'the general limiter is not mounted on /api at all');
  assert.ok(routesAt !== -1, 'the api router is not mounted');
  assert.ok(limiterAt < routesAt,
    'the general limiter is mounted after the routes, so it never sees a request');
});

test('static files are served without the limiter, and that is deliberate', () => {
  // Browsers request many assets per page view. Throttling them would break the
  // site without protecting anything. Asserted so a later "move the limiter up"
  // edit is a decision rather than an accident.
  const src = fs.readFileSync(APP, 'utf8');
  const limiterAt = src.indexOf("app.use('/api', generalLimiter)");
  const staticAt = src.indexOf('express.static(frontendRoot)');
  assert.ok(limiterAt < staticAt, 'the limiter now sits ahead of static file serving');
});

/* ================================================================== *
 * 2. The amplification each class can reach
 * ================================================================== */

test('an upload request is bounded in size and in count', () => {
  const { maxFilesPerRequest, maxUploadMb } = limits();
  const perRequestMb = maxFilesPerRequest * maxUploadMb;

  // Both bounds have to exist. An absent one reads as undefined and multiplies to
  // NaN, which would pass a truthiness check and prove nothing.
  assert.ok(Number.isFinite(perRequestMb) && perRequestMb > 0,
    `a single upload request is unbounded: ${maxFilesPerRequest} files x ${maxUploadMb} MB`);
  assert.equal(maxFilesPerRequest, 60, 'the per-request file cap changed; re-check the arithmetic');
});

test('the upload class is limited to what a real chapter needs, not to the general budget', () => {
  /*
   * The finding. Before this, uploads rode the general limiter: 300 requests per
   * 15 minutes at 480 MB each, which is 144 GB per IP per window, on local disk
   * with no ceiling and no per-user accounting to stop a single account filling
   * it.
   *
   * The comparison is against the general budget rather than a fixed number, so
   * raising RATE_LIMIT_MAX_REQUESTS does not silently make this pass.
   */
  const { upload, general, maxFilesPerRequest, maxUploadMb, windowMinutes } = limits();
  const perRequestMb = maxFilesPerRequest * maxUploadMb;

  assert.ok(Number.isFinite(upload) && upload > 0,
    `uploads have no limit of their own (upload=${upload}); they fall back to the `
    + `general limit of ${general} requests per ${windowMinutes} minutes, which at `
    + `${perRequestMb} MB per request is ${(perRequestMb * general / 1000).toFixed(0)} GB `
    + 'per IP per window');

  assert.ok(upload < general,
    `the upload limit (${upload}) is not tighter than the general limit (${general}); `
    + 'the most expensive route class has the least protection');

  // And the budget it does have must still allow a real chapter: one request's
  // worth of pages, several times over, for the page-images workflow.
  assert.ok(upload >= 3,
    `the upload limit of ${upload} per ${windowMinutes} minutes is too tight to upload `
    + 'a chapter and correct a mistake without waiting out the window');
});

test('unauthenticated routes that cost more than a row read have a tighter limit', () => {
  const { general, auth, dmca } = limits();

  // Each of these is reachable by a stranger and each does more than one cheap
  // thing per call: the auth routes are the credential-stuffing surface, the DMCA
  // routes send email to an address the caller chooses.
  assert.ok(auth < general,
    `the auth limit (${auth}) is not tighter than the general limit (${general}); `
    + 'credential stuffing is then limited no harder than browsing');
  assert.ok(dmca < general,
    `the DMCA limit (${dmca}) is not tighter than the general limit (${general}); `
    + 'sending mail to arbitrary addresses is then limited no harder than browsing');
});

/* ================================================================== *
 * 3. The limiters actually reach the routes
 * ================================================================== */

test('the upload routes carry the upload limiter', () => {
  const perRoute = perRouteLimiters();

  const uploads = [...perRoute.entries()]
    .filter(([key]) => key.startsWith('uploadRoutes:'))
    .map(([key, limiter]) => ({ key, limiter }));

  assert.ok(uploads.length >= 2,
    `expected the upload routes to be registered, found ${uploads.length}: `
    + `${uploads.map((u) => u.key).join(', ')}`);

  for (const { key, limiter } of uploads.filter((u) => u.key.includes('POST'))) {
    assert.equal(limiter, 'uploadLimiter',
      `${key} is behind ${limiter}, not uploadLimiter; the POSTs are what write to disk`);
  }
});

test('the unauthenticated DMCA routes carry the DMCA limiter', () => {
  const perRoute = perRouteLimiters();
  const dmcaPosts = [...perRoute.entries()]
    .filter(([key]) => key.startsWith('dmcaRoutes:POST'))
    .map(([, limiter]) => limiter);

  assert.ok(dmcaPosts.length >= 2, `expected both DMCA intake routes, found ${dmcaPosts.length}`);
  for (const limiter of dmcaPosts) {
    assert.equal(limiter, 'dmcaLimiter', `a DMCA intake route is behind ${limiter}`);
  }
});

test('the unauthenticated auth routes carry the auth limiter', () => {
  const perRoute = perRouteLimiters();
  const authPosts = [...perRoute.entries()]
    .filter(([key]) => key.startsWith('authRoutes:POST'))
    .map(([, limiter]) => limiter);

  // login and logout are the ones without: logout revokes nothing for a stranger
  // and login has its own per-account throttle.
  assert.ok(authPosts.length >= 4,
    `expected most auth routes to carry a limiter, found ${authPosts.length}`);
  for (const limiter of authPosts) {
    assert.equal(limiter, 'authLimiter', `an auth route is behind ${limiter}`);
  }
});

/* ================================================================== *
 * 4. What this cannot prove
 * ================================================================== */

/** Each limiter's block of source, keyed by the constant it defines. */
function limiterBlocks() {
  const src = fs.readFileSync(path.join(SRC, 'middleware', 'rateLimiter.js'), 'utf8');
  const blocks = new Map();
  const re = /const (\w+Limiter)\s*=\s*limiterFor\(\{([\s\S]*?)\}\);/g;
  for (const m of src.matchAll(re)) blocks.set(m[1], m[2]);
  return blocks;
}

test('every limiter is keyed by address, and none of them by account', () => {
  /*
   * Every limiter is keyed by IP or by a submitted identifier. On a shared address
   * that is one reader's traffic throttling everyone else's, and a caller who
   * rotates source addresses has no ceiling at all.
   *
   * Not fixed here. Keying by account needs a real users row on the request, which
   * the unauthenticated routes do not have, and per-user storage accounting that
   * this schema does not carry. Both are schema-shaped decisions rather than a
   * middleware change, so this asserts the current keying so that changing it is a
   * decision rather than an oversight - and so a limiter keyed by something
   * unexpected is caught here rather than in production.
   */
  const blocks = limiterBlocks();

  assert.ok(blocks.size >= 5,
    `expected every limiter to be defined through limiterFor, found ${blocks.size}: `
    + `${[...blocks.keys()].join(', ')}`);

  for (const [name, body] of blocks) {
    assert.match(body, /keyGenerator:/, `${name} has no keyGenerator`);
    assert.doesNotMatch(body, /req\.user/,
      `${name} is keyed by the account; that needs a loaded users row, which the `
      + 'unauthenticated routes do not have, so this would fall back to undefined');
    assert.doesNotMatch(body, /authorization/i,
      `${name} keys on the Authorization header, which an attacker chooses freely`);
    assert.match(body, /req\.ip/, `${name} is not keyed by address at all`);
  }
});

test('every test that exercises a limited route raises that limiter', () => {
  /*
   * Found by this: adding the upload limit made uploads.http.test.js fail with 429
   * on a test about image formats. The failure was real - the limit was working -
   * and it was about nothing the test was checking. Anything that makes many
   * requests to a rate-limited route in one file needs the limit raised, or the
   * suite starts failing for reasons unrelated to what it asserts.
   *
   * The cost of forgetting is a confusing failure, and the cost of remembering is
   * one line. This asserts the pairing so the next limiter added does not have to
   * be rediscovered by watching a suite go red.
   */
  const LIMITERS = {
    authLimiter: 'AUTH_RATE_LIMIT_MAX_REQUESTS',
    uploadLimiter: 'UPLOAD_RATE_LIMIT_MAX_REQUESTS',
    dmcaLimiter: 'DMCA_RATE_LIMIT_MAX_REQUESTS',
  };

  const perRoute = perRouteLimiters();

  /*
 * The mount each router is actually served at, read from src/routes/index.js.
 *
 * Not derived from the file name. It looks like it should work - `uploadRoutes`
 * obviously means `/uploads` - and it silently does not: the mount is `uploads`,
 * plural, while the name minus `Routes` is `upload`. Every call to `/api/uploads`
 * missed, so the guard bound to the four auth test files and never once to the
 * upload test that actually broke. A guard that is wired to nothing looks exactly
 * like a guard that passes.
 */
function mountPoints() {
  const index = fs.readFileSync(path.join(ROUTES, 'index.js'), 'utf8');
  const found = new Map();
  for (const m of index.matchAll(/router\.use\(\s*'\/([^']+)'\s*,\s*require\('\.\/(\w+)'/g)) {
    // Keyed the same way perRouteLimiters keys them: base name, no extension.
    // `authRoutes.js` against `authRoutes` matched nothing, which is how the first
    // version of this reported every route as unmounted.
    found.set(m[2], m[1]);
  }
  assert.ok(found.size >= 8,
    `could not read the router mounts, found ${found.size}: ${[...found.keys()].join(', ')}`);
  return found;
}

/** Which limiter each route file mounts, and the mount path that reaches it. */
function limitedRoutes() {
  const mounts = mountPoints();
  const byFile = new Map();

  for (const [key, limiter] of perRoute) {
    const routeFile = key.split(':')[0];
    const mount = mounts.get(routeFile);
    assert.ok(mount, `${routeFile} is not mounted in src/routes/index.js, so no test `
      + 'can reach the limiter this audit is checking');
    if (!byFile.has(routeFile)) byFile.set(routeFile, { mount, limiters: new Set() });
    byFile.get(routeFile).limiters.add(limiter);
  }
  return byFile;
}

  /*
   * Whether a file actually *calls* a route, as opposed to mentioning it.
   *
   * Two earlier versions got this wrong and both produced noise rather than
   * findings. Matching a bare path picked up a documented URL in
   * `coverImage: '/uploads/...'` and an escaped `/api\/dmca/` inside a regex, and
   * demanding every limiter for every route made a test that touches auth report
   * that it must also raise the upload limit.
   *
   * So the match requires a call - `call(` or `fetch(` - with the path among its
   * arguments, and only the limiter for the route actually called.
   */
  const callsRoute = (src, mount) => new RegExp(
    `(?:call|fetch|request)\\([^)]*['"\`][^'"\`]*\\/api\\/${mount}(?:/|['"\`])`,
  ).test(src);

  /*
   * Raised properly or not at all. An earlier version of this accepted "raises
   * the general limit" as good enough, which would have passed on the exact file
   * that broke - it raised RATE_LIMIT_MAX_REQUESTS to 100000 and not the upload
   * one, so the guard would have reported the suite as fine while it was still
   * red.
   */
  const byFile = limitedRoutes();

  assert.ok(byFile.size >= 3,
    `expected several rate-limited route files, found ${byFile.size}: ${[...byFile.keys()].join(', ')}`);

  const misses = [];
  let bound = 0;

  for (const file of fs.readdirSync(__dirname).filter((f) => f.endsWith('.test.js'))) {
    const src = fs.readFileSync(path.join(__dirname, file), 'utf8');

    for (const [routeFile, { mount, limiters }] of byFile) {
      if (!callsRoute(src, mount)) continue;

      for (const limiter of limiters) {
        const variable = LIMITERS[limiter];
        if (!variable) continue;
        bound += 1;
        if (!new RegExp(`${variable}\\s*(=|\\|\\|)`).test(src)) {
          misses.push(`${file} exercises ${routeFile} but does not raise ${variable}`);
        }
      }
    }
  }

  assert.deepEqual(misses, [], misses.join('\n  '));

  /*
   * And the guard must be attached to something. The first version derived the
   * mount from the file name - `uploadRoutes` minus `Routes` is `upload`, while
   * the real mount is `uploads` - so it matched no upload calls at all and bound
   * only to the auth tests. It reported no problems, which is the correct output
   * for a guard that is watching nothing. Requiring a minimum number of bindings
   * turns that silence into a failure.
   */
  assert.ok(bound >= 5,
    `this guard is bound to ${bound} route/test pairs; it is watching almost nothing, `
    + 'so a passing result means nothing');
});

test('when trust proxy is on, it is the hop count 1 and not `true`', () => {
  /*
   * Every limiter is keyed by req.ip, so this setting decides whether the limit
   * means anything.
   *
   * Off: req.ip is the socket address. Behind Render's load balancer that is the
   * balancer, so every caller shares one key and the general limit of 300 becomes
   * 300 requests for the whole service - a self-inflicted denial of service. That
   * is why TRUST_PROXY is on in render.yaml and why preflight reports it.
   *
   * On as `true`: the entire forwarded chain is trusted left-to-right, so a client
   * that appends to X-Forwarded-For chooses the result and walks past any limit.
   * On as the hop count `1`, only the entry the real proxy wrote is read. app.js
   * already does this; asserted because the failure mode of getting it wrong is
   * invisible - every test in the suite passes either way.
   *
   * TRUST_PROXY is a deliberate flag, so "off" is a valid state (no proxy in
   * front). Both branches are asserted rather than only the deployed one.
   */
  const { trustProxy } = require('../src/config/env');
  const app = require('../src/app');
  const effective = app.get('trust proxy');

  if (!trustProxy) {
    assert.ok(effective === false || effective === undefined,
      `trust proxy is off but the app is set to ${JSON.stringify(effective)}`);
    assert.ok(app.get('trust proxy fn') === undefined
      || typeof app.get('trust proxy fn') === 'function',
    'trust proxy is off but a trust function is installed anyway');
    return;
  }

  assert.equal(effective, 1,
    `TRUST_PROXY is on but trust proxy is ${JSON.stringify(effective)}; it must be the `
    + 'hop count 1. `true` trusts the whole X-Forwarded-For chain, which a client '
    + 'controls by appending to it.');
});