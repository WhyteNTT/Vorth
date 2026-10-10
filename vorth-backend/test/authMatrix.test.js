'use strict';

/**
 * The authorisation matrix: what is the effective access level of every route?
 *
 * A hand-written version of this check exists nowhere - I wrote one earlier in
 * this work and it reported 34 unguarded routes, all of them false, because it
 * could not see `router.use(protect)`. `protect` applied at the top of a route
 * file guards everything mounted below it, and a checker that misses that is
 * worse than no checker: it produces noise, and noise trains people to ignore the
 * finding. So this resolves file-level middleware properly rather than scanning
 * for a token on the same line.
 *
 * The matrix itself is an explicit, reviewed list. That is the point: this is not
 * asking "does a route look guarded" but "does the effective level match what a
 * person decided". A new route is unreviewed until it is added, and adding it is
 * where the decision gets made.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROUTES = path.join(__dirname, '..', 'src', 'routes');
const APP = path.join(__dirname, '..', 'src', 'app.js');
const INDEX = path.join(ROUTES, 'index.js');

/**
 * Mount prefixes, resolved through both files.
 *
 * app.js mounts a single router at /api and routes/index.js mounts each
 * sub-router under it. Reading only app.js found three mounts, none of them a
 * route file - the first version of this check matched `app.use(express.json())`
 * as a mount and reported every route as missing. So both hops are followed, and
 * the test below fails loudly if either shape changes.
 */
function mountPoints() {
  const out = [];
  const base = (fs.readFileSync(APP, 'utf8').match(/app\.use\(\s*'(\/api)'\s*,\s*routes\s*\)/) || [])[1];
  assert.ok(base, 'app.js no longer mounts the router at /api; this checker needs updating');

  const index = fs.readFileSync(INDEX, 'utf8');
  for (const m of index.matchAll(/router\.use\(\s*'([^']*)'\s*,\s*require\(\s*'\.\/([A-Za-z]+)'\s*\)/g)) {
    out.push({ prefix: `${base}${m[1]}`, router: m[2] });
  }

  // Routes defined directly on the index router rather than a file.
  for (const m of index.matchAll(/router\.(get|post|patch|put|delete)\(\s*'([^']*)'/g)) {
    out.push({ prefix: `${base}${m[2]}`, verb: m[1].toUpperCase(), inline: true });
  }
  return out;
}

/** Removes comments so a guard mentioned in prose is not read as a guard. */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/**
 * The middleware a route file applies to everything below it.
 * Returns { protect, restrictTo, optionalAuth }.
 */
function fileLevelGuards(src) {
  const code = stripComments(src);
  const guards = { protect: false, restrictTo: false, optionalAuth: false };
  for (const m of code.matchAll(/router\.use\(\s*([^)]*)\)/g)) {
    const args = m[1];
    if (/\bprotect\b/.test(args)) guards.protect = true;
    if (/\boptionalAuth\b/.test(args)) guards.optionalAuth = true;
    if (/\brestrictTo\s*\(/.test(args)) guards.restrictTo = true;
  }
  return guards;
}

/** Guard middleware named on the route's own definition. */
function inlineGuards(src) {
  const code = stripComments(src);
  const out = [];
  for (const m of code.matchAll(/router\.(get|post|patch|put|delete)\(\s*(['"])(.*?)\2(.*?)\)\s*;/gs)) {
    const [, verb, , route, rest] = m;
    out.push({
      verb: verb.toUpperCase(),
      route,
      inline: {
        protect: /\bprotect\b/.test(rest),
        restrictTo: /\brestrictTo\s*\(/.test(rest),
        optionalAuth: /\boptionalAuth\b/.test(rest),
      },
      // upload.single / upload.array sit between the guard and the handler.
      multipart: /upload\.(single|array|fields)\(/.test(rest),
    });
  }
  return out;
}

/** Builds every route with its effective access level. */
function resolveMatrix() {
  const mounts = mountPoints();
  const byRouter = new Map();
  for (const f of fs.readdirSync(ROUTES)) {
    if (!f.endsWith('.js') || f === 'index.js') continue;
    byRouter.set(f.replace(/\.js$/, ''), f);
  }

  const matrix = [];
  for (const mount of mounts) {
    if (mount.inline) {
      matrix.push({
        method: mount.verb, path: mount.prefix || '/', file: 'index.js',
        multipart: false, protect: false, restrictTo: false, optionalAuth: false,
      });
      continue;
    }
    const file = byRouter.get(mount.router);
    if (!file) continue;
    const src = fs.readFileSync(path.join(ROUTES, file), 'utf8');
    const fileGuards = fileLevelGuards(src);
    for (const r of inlineGuards(src)) {
      const effective = {
        protect: fileGuards.protect || r.inline.protect,
        restrictTo: fileGuards.restrictTo || r.inline.restrictTo,
        optionalAuth: fileGuards.optionalAuth || r.inline.optionalAuth,
      };
      matrix.push({
        method: r.verb,
        path: `${mount.prefix}${r.route}`.replace(/\/+$/, '') || mount.prefix,
        multipart: r.multipart,
        file,
        ...effective,
      });
    }
  }
  return matrix;
}

const LEVEL = (r) => {
  if (r.restrictTo) return 'admin';
  if (r.protect) return 'authenticated';
  if (r.optionalAuth) return 'optional';
  return 'public';
};

const routeKey = (method, p) => `${method} ${p.replace(/\/+$/, '') || '/'}`;

/* ------------------------------------------------------------------ *
 * The reviewed matrix
 * ------------------------------------------------------------------ */

/**
 * Every route and the access level a person decided it should have.
 *
 * Public is a deliberate choice, not an absence: a novel has to be readable by
 * someone who is not signed in. Anything missing from this list fails the build,
 * which is the mechanism - a route nobody looked at should not reach production
 * because nobody wrote a line about it.
 *
 * Built from the resolved matrix at the time of writing, then reviewed by hand.
 * The list is long on purpose; that is the cost of knowing rather than assuming.
 */
const REVIEWED = {
  // --- sessions. The unauthenticated ones are how a session comes into being;
  //     logout is included because signing out with nothing to revoke must still
  //     clear the client, so refusing an anonymous caller would leave a stale
  //     cookie in the browser.
  'POST /api/auth/register': 'public',
  'POST /api/auth/login': 'public',
  'POST /api/auth/refresh': 'public',
  'POST /api/auth/logout': 'public',
  'POST /api/auth/forgot-password': 'public',
  'POST /api/auth/reset-password': 'public',
  'POST /api/auth/verify-email': 'public',
  'POST /api/auth/logout-all': 'authenticated',
  'POST /api/auth/resend-verification': 'authenticated',
  'GET /api/auth/me': 'authenticated',
  'PATCH /api/auth/me': 'authenticated',
  'PATCH /api/auth/me/password': 'authenticated',

  // --- catalogue
  'GET /api/series': 'public',
  'GET /api/series/rankings': 'public',
  'GET /api/series/mine': 'authenticated',
  'POST /api/series': 'authenticated',
  'GET /api/series/:id': 'public',
  'PATCH /api/series/:id': 'authenticated',
  'DELETE /api/series/:id': 'authenticated',
  'POST /api/series/:seriesId/chapters': 'authenticated',

  // --- chapters. The read is optionalAuth rather than plainly public: a
  //     signed-out reader gets the chapter, and a signed-in one gets it with their
  //     own read state attached. Recorded as it is, not flattened to "public",
  //     because the difference is what the route is for.
  'GET /api/chapters/:id': 'optional',
  'PATCH /api/chapters/:id': 'authenticated',
  'DELETE /api/chapters/:id': 'authenticated',

  // --- comments
  'GET /api/series/:seriesId/comments': 'public',
  'POST /api/series/:seriesId/comments': 'authenticated',
  'DELETE /api/comments/:id': 'authenticated',

  // --- library and offline downloads. Downloads live under /library because
  //     they are a library feature, not a separate resource.
  'GET /api/library': 'authenticated',
  'POST /api/library/:seriesId': 'authenticated',
  'DELETE /api/library/:seriesId': 'authenticated',
  'GET /api/library/downloads': 'authenticated',
  'POST /api/library/downloads': 'authenticated',
  'DELETE /api/library/downloads/:chapterId': 'authenticated',

  // --- per-user state
  'GET /api/progress': 'authenticated',
  'GET /api/progress/:seriesId': 'authenticated',
  'PUT /api/progress/:seriesId': 'authenticated',
  'DELETE /api/progress/:seriesId': 'authenticated',
  'GET /api/notifications': 'authenticated',
  'PATCH /api/notifications/read-all': 'authenticated',
  'PATCH /api/notifications/:id/read': 'authenticated',

  // --- uploads. Writes need a session; reads are public because covers and
  //     comic pages are shown to signed-out visitors.
  'POST /api/uploads/cover': 'authenticated',
  'POST /api/uploads/pages': 'authenticated',
  'GET /api/uploads/:key': 'public',

  // --- copyright claims
  'POST /api/dmca': 'public',
  'POST /api/dmca/:id/counter-notice': 'public',
  'GET /api/dmca/mine': 'authenticated',
  'GET /api/dmca': 'admin',
  'GET /api/dmca/:id': 'admin',
  'PATCH /api/dmca/:id': 'admin',
  'GET /api/dmca/counter-notices': 'admin',
  'GET /api/dmca/counter-notices/:id': 'admin',
  'PATCH /api/dmca/counter-notices/:id': 'admin',

  // --- content policy reports
  'POST /api/reports': 'public',
  'GET /api/reports': 'admin',
  'GET /api/reports/:id': 'admin',
  'PATCH /api/reports/:id': 'admin',

  // --- moderation
  'GET /api/admin/users': 'admin',
  'PATCH /api/admin/users/:id/ban': 'admin',
  'PATCH /api/admin/users/:id/unban': 'admin',
  'DELETE /api/admin/series/:id': 'admin',
  'DELETE /api/admin/comments/:id': 'admin',

  // --- static text and health
  'GET /api/legal': 'public',
  'GET /api/legal/:doc': 'public',
  'GET /api': 'public',
  'GET /api/health': 'public',
  /*
   * The keep-warm ping is public by necessity, not by accident.
   *
   * A Render cron job can only issue a plain GET: it cannot send a request header
   * and it cannot read a value generated at boot. So requiring a credential here
   * would mean the scheduled job could never reach it, the instance would go cold,
   * and nothing would look wrong. The endpoint's only effect is writing a
   * timestamp, and returning a response already proves the instance is awake.
   */
  'GET /api/keep-warm': 'public',
  // Guarded by X-Keep-Warm-Token rather than a session. The matrix records the
  // router-level decision; the header check is in the handler and in keepWarm.test.js.
  'GET /api/keep-warm/status': 'public',
};

/* ------------------------------------------------------------------ *
 * The check
 * ------------------------------------------------------------------ */

test('the router mounts are all resolvable to a file on disk', () => {
  // If a mount names a router this cannot find, every route under it silently
  // drops out of the matrix and the check below passes over a hole.
  const mounts = mountPoints().filter((m) => !m.inline);
  assert.ok(mounts.length >= 12, `only ${mounts.length} mounts found; the regex probably broke`);
  for (const { prefix, router } of mounts) {
    assert.ok(fs.existsSync(path.join(ROUTES, `${router}.js`)),
      `routes/index.js mounts "${router}" at "${prefix}" but src/routes/${router}.js does not exist`);
  }
});

test('every route is resolved to an access level, and matches the reviewed matrix', () => {
  const matrix = resolveMatrix();
  assert.ok(matrix.length >= 40, `only ${matrix.length} routes resolved; parsing probably broke`);

  const seen = new Set();
  const problems = [];
  const unreviewed = [];

  for (const route of matrix) {
    const key = routeKey(route.method, route.path);
    if (seen.has(key)) problems.push(`${key} is defined more than once`);
    seen.add(key);

    if (!(key in REVIEWED)) { unreviewed.push(key); continue; }
    const actual = LEVEL(route);
    const expected = REVIEWED[key];
    if (actual !== expected) {
      problems.push(`${key}: reviewed as "${expected}" but resolves to "${actual}" (${route.file})`);
    }
  }

  assert.deepEqual(unreviewed, [],
    'these routes are not in the reviewed matrix. Either it was never decided what '
    + 'they should require, or the route changed and the decision did not:\n  '
    + unreviewed.join('\n  '));

  assert.deepEqual(problems, [], problems.join('\n'));
});

test('every route in the reviewed matrix still exists', () => {
  // The other direction. Without this, deleting a route leaves its entry behind
  // and the matrix looks complete while covering less than it claims.
  const actual = new Set(resolveMatrix().map((r) => routeKey(r.method, r.path)));
  const stale = Object.keys(REVIEWED).filter((k) => !actual.has(k));
  assert.deepEqual(stale, [],
    'these are in the reviewed matrix but no longer exist as routes:\n  ' + stale.join('\n  '));
});

/**
 * The public routes that change state, each with the reason it is public.
 *
 * A reader with no account has to be able to report content, and 17 U.S.C. 512(c)
 * requires the ability to submit a copyright claim - and the publisher who is
 * removed has to be able to answer it before the 10-day window closes, which they
 * may not be able to do from a signed-in session.
 *
 * The session endpoints are also public by nature: they are how a session comes
 * into being, and logout has to clear a stale cookie from a caller who no longer
 * has a valid one.
 */
const PUBLIC_WRITES_JUSTIFIED = new Set([
  'POST /api/auth/register',
  'POST /api/auth/login',
  'POST /api/auth/refresh',
  'POST /api/auth/logout',
  'POST /api/auth/forgot-password',
  'POST /api/auth/reset-password',
  'POST /api/auth/verify-email',
  'POST /api/reports',
  'POST /api/dmca',
  'POST /api/dmca/:id/counter-notice',
]);

test('a route that mutates state and is public is justified in writing', () => {
  const offenders = resolveMatrix()
    .filter((r) => r.method !== 'GET' && r.method !== 'HEAD' && LEVEL(r) === 'public')
    .map((r) => routeKey(r.method, r.path))
    .filter((k) => !PUBLIC_WRITES_JUSTIFIED.has(k));

  assert.deepEqual(offenders, [],
    'these routes change state without a session and are not justified above:\n  '
    + offenders.join('\n  '));
});

test('every route acting on one user\'s data has ownership logic somewhere reachable', () => {
  /*
   * What this is: a tripwire for *omission*. It fails when a route on per-user
   * data has no ownership logic anywhere in its route file, its controller, or
   * the middleware it uses - which is what a newly written handler that forgot
   * the check looks like.
   *
   * What this is not: proof that ownership is enforced. That claim needs a
   * behaviour, and mutation testing showed why. Replacing the guard in
   * requireChapterOwner with `if (false)` - so every non-owner is admitted -
   * leaves `const isOwner = String(series.owner) === String(req.user.id)` in the
   * file, the word "owner" is still there, and this test passes. It cannot see a
   * decision removed, only a decision absent.
   *
   * So it is not asked to carry that. ownership.http.test.js makes each request
   * as a stranger and checks it is refused; that is the proof, and it is the
   * mutation that fails.
   *
   * Reading only the route file got this wrong at first and reported six routes
   * as unguarded - commentRoutes.js has no req.user in it, because the ownership
   * decision is made in commentController.remove. A check that looks in the wrong
   * place is worse than none, so it follows the handlers now, and the middleware
   * directory too: chapter ownership is enforced by requireChapterOwner, so a
   * check that never read ownership.js was passing for the wrong reason.
   */
  const PER_USER = [
    { path: '/api/progress', reason: 'reading progress belongs to the caller' },
    { path: '/api/library', reason: 'a saved series belongs to the caller' },
    { path: '/api/notifications', reason: 'a notification belongs to the caller' },
    { path: '/api/chapters', reason: 'only the series owner may edit or delete a chapter' },
    { path: '/api/series', reason: 'only the owner may edit or delete a series' },
    { path: '/api/comments', reason: 'only the comment author or an admin may remove it' },
  ];

  // Words that indicate an ownership decision somewhere in the reachable code.
  const CHECKS = /req\.user|\bowner\b|isAuthor|isAdmin|restrictTo|ownership|userId|user:/i;

  /**
   * Every module a route file or controller can reach that could make the
   * decision: its own controllers, and the middleware directory.
   *
   * The middleware directory is not optional. Chapter ownership is enforced by
   * requireChapterOwner, not by anything in the controller, so a check that only
   * read the handlers passed for the wrong reason - it was reading a file that
   * never contained the decision.
   */
  const srcDir = path.join(__dirname, '..', 'src');
  const load = (dir) => {
    const out = new Map();
    for (const f of fs.readdirSync(dir)) {
      if (f.endsWith('.js')) out.set(f, stripComments(fs.readFileSync(path.join(dir, f), 'utf8')));
    }
    return out;
  };
  const controllerSrc = load(path.join(srcDir, 'controllers'));
  const middlewareSrc = load(path.join(srcDir, 'middleware'));

  const unguarded = [];
  for (const route of resolveMatrix()) {
    if (route.method === 'GET' || route.file === 'index.js') continue;
    const relevant = PER_USER.find((p) => route.path.startsWith(p.path));
    if (!relevant) continue;

    const routeSrc = stripComments(fs.readFileSync(path.join(ROUTES, route.file), 'utf8'));
    if (CHECKS.test(routeSrc)) continue;

    // Nothing in the route file. Follow it into what it requires.
    const referenced = new Set();
    for (const m of routeSrc.matchAll(/require\('\.\.\/controllers\/([A-Za-z]+)'\)/g)) {
      referenced.add(`controllers/${m[1]}.js`);
    }
    const combined = [...referenced].map((f) => controllerSrc.get(path.basename(f)) || '').join('\n');

    // ...and into the middleware those controllers use.
    const middlewareReached = [...middlewareSrc.entries()]
      .filter(([f]) => combined.includes(`require('../middleware/${f.replace(/\.js$/, '')}')`))
      .map(([, src]) => src).join('\n');

    if (!CHECKS.test(`${combined}\n${middlewareReached}`)) {
      unguarded.push(`${routeKey(route.method, route.path)} - ${relevant.reason} `
        + `(checked ${route.file}, ${[...referenced].join(', ') || 'no controller'})`);
    }
  }

  assert.deepEqual(unguarded, [],
    'these mutating routes sit on per-user data and no ownership check appears in '
    + 'their route file, their controller, or the middleware they use:\n  '
    + unguarded.join('\n  '));
});