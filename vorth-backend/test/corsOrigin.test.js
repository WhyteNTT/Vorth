'use strict';

/**
 * The CORS origin decision, and the two conditions that produce it.
 *
 * app.js sat at 40% branch coverage for a long time, and the uncovered half was
 * lines 76-83: the whole `origin` callback. That is the function that decides
 * whether a browser may read a response, so its three outcomes are worth naming:
 *
 *   no Origin header          -> allowed. Same-origin, curl, server-to-server.
 *   configured and permitted  -> allowed.
 *   anything else             -> refused, with a 403.
 *
 * The refusal branch is the one that matters and the one nothing covered. It is
 * also the branch with a failure mode that is invisible: a callback that threw
 * instead of refusing would be caught by the CORS middleware and answered with a
 * 500, and a 500 is not obviously "you are not allowed" to whoever is reading the
 * log.
 *
 * The configuration branch is load-bearing in the other direction. With no
 * CLIENT_ORIGINS set, development allows any origin so a locally served frontend
 * can call the API, and production refuses every origin. That split is the whole
 * point of the check, so both sides are asserted by actually loading the module
 * with the environment set - not by reading the source, which would pass whether
 * or not the branch worked.
 */

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ||= 'postgres://stub/stub';
process.env.DATABASE_SSL = 'false';
process.env.JWT_SECRET ||= 'test-secret';

const test = require('node:test');
const assert = require('node:assert/strict');

/**
 * Loads the app fresh under a given environment.
 *
 * The app and everything it imports read `env` at require time, so each case has
 * to run in its own process with the environment set before the require. A child
 * process is the only honest way to do that - clearing require.cache does not reset
 * the already-parsed env object the middleware captured.
 */
function runInChild(env, script) {
  const { execFileSync } = require('node:child_process');
  const path = require('node:path');

  // Absolute, because the runner is written to the temp directory: a relative
  // './src/app' resolves against the temp dir and cannot be found.
  const APP = path.join(__dirname, '..', 'src', 'app.js').replace(/\\/g, '/');

  const runner = `
    process.env.NODE_ENV = ${JSON.stringify(env.NODE_ENV)};
    process.env.CLIENT_ORIGINS = ${JSON.stringify(env.CLIENT_ORIGINS ?? '')};
    process.env.DATABASE_URL = 'postgres://stub/stub';
    process.env.DATABASE_SSL = 'false';
    process.env.JWT_SECRET = 'test-secret';
    process.env.RATE_LIMIT_MAX_REQUESTS = '100000';
    process.env.VORTH_APP = ${JSON.stringify(APP)};

    ${script}
  `;
  const file = path.join(require('node:os').tmpdir(), `vorth-cors-${process.pid}-${Math.random().toString(36).slice(2)}.js`);
  require('node:fs').writeFileSync(file, runner);
  try {
    return execFileSync(process.execPath, [file], {
      cwd: path.join(__dirname, '..'),
      encoding: 'utf8',
      timeout: 60000,
    }).trim();
  } finally {
    require('node:fs').unlinkSync(file);
  }
}

/** Starts the app and issues one request with the given Origin header. */
const PROBE = `
  const app = require(process.env.VORTH_APP);
  const server = app.listen(0, async () => {
    const port = server.address().port;
    try {
      // GET /api, not /api/health: the health route answers 503 against the stub
      // database these children run with, and a 503 is a confusing thing to read
      // in a test about CORS. The index route needs no database. CORS and helmet
      // run before routing, so the headers under test are unaffected by which
      // endpoint answers.
      const res = await fetch('http://127.0.0.1:' + port + '/api', {
        headers: process.env.PROBE_ORIGIN ? { Origin: process.env.PROBE_ORIGIN } : {},
      });
      const cors = res.headers.get('access-control-allow-origin');
      const csp = res.headers.get('content-security-policy');
      console.log(JSON.stringify({ status: res.status, cors, csp }));
    } finally {
      server.close();
    }
  });
`;

function probe(env, origin) {
  const out = runInChild(env, `process.env.PROBE_ORIGIN = ${JSON.stringify(origin)};${PROBE}`);
  /*
   * The last line, not the whole output.
   *
   * These children load the app with NODE_ENV=production on purpose - that is the
   * configuration whose CORS behaviour matters - and morgan logs every request to
   * stdout in production. Parsing the whole stream as JSON fails on the first log
   * line, which is `::ffff:127.0.0.1 - - [date] "GET /api/health HTTP/1.1" 503`.
   */
  const line = out.split('\n').map((l) => l.trim()).filter(Boolean).pop();
  try {
    return JSON.parse(line);
  } catch (_) {
    throw new Error(`the child did not report a result.\nlast line: ${line}\nfull output:\n${out}`);
  }
}

test('a request with no Origin header is allowed', () => {
  /*
   * Not a browser: curl, a health checker, the render.yaml smoke test, another
   * service. CORS does not apply and refusing would break all of them.
   *
   * The header is absent rather than `*`. Measured, not assumed: the cors package
   * only emits access-control-allow-origin when the request actually carries an
   * Origin. That is the right outcome - there is no origin to grant - and it is
   * asserted as observed so the test does not encode a `*` that was never sent.
   */
  const res = probe({ NODE_ENV: 'production', CLIENT_ORIGINS: 'https://vorth.example' }, '');
  assert.equal(res.status, 200, 'a non-browser caller was refused');
  assert.equal(res.cors, null,
    `a request with no Origin was granted CORS access to ${res.cors}`);
});

test('a configured origin is allowed and echoed back exactly', () => {
  /*
   * Echoed rather than `*`, because the API sets credentials: true for the
   * httpOnly refresh cookie, and a wildcard is not permitted alongside
   * credentials. Returning `*` would make every authenticated browser call fail
   * while looking correct in the response.
   */
  const origin = 'https://vorth.example';
  const res = probe({ NODE_ENV: 'production', CLIENT_ORIGINS: origin }, origin);
  assert.equal(res.status, 200);
  assert.equal(res.cors, origin, 'the permitted origin was not echoed back');
});

test('several configured origins are each permitted', () => {
  // CLIENT_ORIGINS is a comma-separated list, and matching must be exact against
  // every entry rather than only the first.
  const allowed = ['https://a.example', 'https://b.example'];
  for (const origin of allowed) {
    const res = probe({ NODE_ENV: 'production', CLIENT_ORIGINS: allowed.join(',') }, origin);
    assert.equal(res.status, 200, `${origin} was refused though it is configured`);
    assert.equal(res.cors, origin);
  }
});

test('an origin that is not configured is refused, and gets no CORS grant', () => {
  /*
   * The branch nothing covered. A refused origin gets no
   * access-control-allow-origin header at all, which is what makes the browser
   * block the read - the 403 is the server-side half of the same decision.
   */
  const res = probe(
    { NODE_ENV: 'production', CLIENT_ORIGINS: 'https://vorth.example' },
    'https://evil.example',
  );
  assert.equal(res.cors, null,
    'an unconfigured origin was granted CORS access, so a browser would read the response');
});

test('an origin that merely starts with a permitted one is refused', () => {
  /*
   * A prefix test would pass this and be a hole: an attacker registers
   * `https://vorth.example.evil.com`, which starts with the permitted origin and
   * is a different site entirely. Same reason for the reverse - an origin that
   * merely contains a permitted one.
   */
  for (const origin of [
    'https://vorth.example.evil.com',
    'https://not-vorth.example',
    'http://vorth.example', // scheme differs
    'https://vorth.example:8443', // port differs
  ]) {
    const res = probe({ NODE_ENV: 'production', CLIENT_ORIGINS: 'https://vorth.example' }, origin);
    assert.equal(res.cors, null, `${origin} was granted CORS access`);
  }
});

test('production with no configured origins permits none', () => {
  /*
   * The fail-closed half. With CLIENT_ORIGINS unset in production there is no
   * browser origin to trust, and allowing any would make the variable optional in
   * a deployment where it is not optional. The frontend is served from this same
   * origin, so same-origin requests carry no Origin header and still work.
   */
  const res = probe({ NODE_ENV: 'production', CLIENT_ORIGINS: '' }, 'https://anything.example');
  assert.equal(res.cors, null,
    'production with no CLIENT_ORIGINS allowed an arbitrary origin');
});

test('development with no configured origins permits any, so a local frontend can call it', () => {
  /*
   * The opposite trade, deliberately: opening index.html from a dev server or via
   * file:// sends an Origin the API has never heard of, and refusing would make
   * local development impossible. Production is the case that must not be loose.
   *
   * The header is the reflected origin rather than `*`, because credentials are on
   * and a wildcard is not valid alongside them. Measured rather than assumed; the
   * first version of this asserted `*` and failed against correct behaviour.
   */
  const origin = 'http://localhost:5173';
  const res = probe({ NODE_ENV: 'development', CLIENT_ORIGINS: '' }, origin);
  assert.equal(res.status, 200, 'a local frontend origin was refused in development');
  assert.equal(res.cors, origin,
    `development should permit any origin; got ${JSON.stringify(res.cors)}`);
});

test('development with origins configured still enforces them', () => {
  // The development permissiveness is a fallback, not an override: once the
  // variable is set it is enforced, so a developer who sets it and finds a
  // request refused has a real misconfiguration to look at.
  const res = probe(
    { NODE_ENV: 'development', CLIENT_ORIGINS: 'https://vorth.example' },
    'https://evil.example',
  );
  assert.equal(res.cors, null, 'a configured origin list is ignored in development');
});

test('the content security policy names every origin the app will serve', () => {
  /*
   * The failure this project has already had once: helmet's default has no
   * connect-src, which silently blocked the frontend's fetch() whenever the API
   * was on a different origin. The policy is therefore built from the same
   * allowedOrigins set the CORS callback uses, and if those two ever diverge the
   * symptom is a blank page with a CSP error in the console - invisible to every
   * test here, and the reason this is asserted.
   *
   * connect-src is the directive that matters for the frontend. object-src
   * 'none' and frame-ancestors are asserted alongside it because they are the two
   * that a future "just loosen the policy" edit is most likely to drop.
   */
  const res = probe(
    { NODE_ENV: 'production', CLIENT_ORIGINS: 'https://vorth.example' },
    'https://vorth.example',
  );
  assert.equal(res.status, 200);

  const csp = res.csp;
  assert.ok(csp, 'no content-security-policy header was sent at all');

  // The directives this app depends on. connect-src is the one that has already
  // broken this project once: helmet's default has no connect-src, which blocks
  // every fetch() from a page served on a different origin, and the symptom is a
  // blank page with a console error rather than anything a server log would show.
  assert.match(csp, /connect-src [^;]*'self'/,
    `connect-src is missing or does not include 'self': ${csp}`);
  assert.match(csp, /connect-src [^;]*https:\/\/vorth\.example/,
    `connect-src does not name the configured origin: ${csp}`);
  assert.match(csp, /object-src 'none'/, `object-src is not 'none': ${csp}`);
  assert.match(csp, /frame-ancestors [^;]*'self'/,
    `frame-ancestors is missing, so the app can be framed: ${csp}`);
  assert.match(csp, /base-uri [^;]*'self'/, `base-uri is missing: ${csp}`);
  assert.match(csp, /form-action [^;]*'self'/, `form-action is missing: ${csp}`);
  assert.match(csp, /script-src [^;]*'self'/,
    `script-src must be 'self' with no unsafe-inline: ${csp}`);
  assert.doesNotMatch(csp, /script-src[^;]*unsafe-inline/,
    `script-src allows unsafe-inline: ${csp}`);
});