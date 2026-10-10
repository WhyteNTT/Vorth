'use strict';

/**
 * config.js: which API base the frontend points at, and in which environments.
 *
 * This file decides where every API request goes. Getting it wrong in one
 * direction sends a reader's traffic somewhere unexpected; getting it wrong in the
 * other leaves a deployed frontend sitting inert with no error of its own, which
 * is the state the current Vercel deployment is in.
 *
 * Run in a vm context rather than a real browser so every branch is reachable
 * without a host. The bare `window` identifier config.js uses is satisfied by
 * pointing the context's global at itself, which a plain object property would
 * not do.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const CONFIG = path.join(__dirname, '..', '..', 'vorth-frontend', 'config.js');
const API = 'https://vorth-api.onrender.com/api';

/**
 * Runs config.js as if the page were served from `hostname`/`origin`.
 * `apiBase` replaces the placeholder, simulating the operator having configured it.
 * Returns what config.js set on window, or null if it set nothing.
 */
function runConfig({ hostname, origin, apiBase } = {}) {
  let source = fs.readFileSync(CONFIG, 'utf8');
  if (apiBase) {
    source = source.replace(
      "'https://REPLACE-WITH-YOUR-API-HOST/api'",
      `'${apiBase}'`,
    );
  }
  const win = { window: null, location: { hostname, origin } };
  win.window = win;
  vm.createContext(win);
  vm.runInContext(source, win, { filename: 'config.js' });
  return win.VORTH_API_BASE === undefined ? null : win.VORTH_API_BASE;
}

/* ================================================================== *
 * The deployed frontend
 * ================================================================== */

test('a Vercel-hosted page points at the configured API', () => {
  assert.equal(
    runConfig({ hostname: 'vorth.vercel.app', origin: 'https://vorth.vercel.app', apiBase: API }),
    API,
    'the split deployment would sit inert against its own origin',
  );
});

test('an unconfigured placeholder leaves the page on same-origin', () => {
  /*
   * The guard that matters before the backend exists.
   *
   * With the placeholder in place, the correct behaviour is to do nothing and stay
   * same-origin - the historical behaviour. Any other outcome would mean a
   * half-finished deployment sending traffic to a URL that does not resolve.
   */
  assert.equal(
    runConfig({ hostname: 'vorth.vercel.app', origin: 'https://vorth.vercel.app' }),
    null,
  );
});

test('the configured base has no trailing slash left on it', () => {
  // script.js strips one, but the value is also read directly for media URLs, so a
  // doubled slash would surface as //api in a request URL.
  const result = runConfig({
    hostname: 'vorth.vercel.app', origin: 'https://vorth.vercel.app', apiBase: `${API}/`,
  });
  assert.ok(result !== null, 'a configured base was ignored');
  assert.ok(!result.endsWith('/'), `the base kept a trailing slash: ${result}`);
});

/* ================================================================== *
 * Local development is never redirected
 * ================================================================== */

test('local development keeps talking to the local backend', () => {
  /*
   * The one that would be genuinely damaging: a developer's own testing silently
   * pointed at production, where they could write real data.
   */
  for (const [hostname, origin] of [
    ['localhost', 'http://localhost:8080'],
    ['127.0.0.1', 'http://127.0.0.1:8080'],
    ['::1', 'http://[::1]:8080'],
    ['app.localhost', 'http://app.localhost:3000'],
    ['127.0.0.2', 'http://127.0.0.2:8080'],
  ]) {
    assert.equal(
      runConfig({ hostname, origin, apiBase: API }), null,
      `${hostname} was redirected to the deployed backend`,
    );
  }
});

/* ================================================================== *
 * Same-origin deployments are left alone
 * ================================================================== */

test('a page served by the backend itself stays same-origin', () => {
  /*
   * Render serves both halves here. Pointing the page at an absolute URL would be
   * harmless but pointless, and would turn same-origin requests into cross-origin
   * ones - requiring CORS and a cross-site cookie where neither is needed.
   */
  assert.equal(
    runConfig({ hostname: 'vorth-api.onrender.com', origin: 'https://vorth-api.onrender.com', apiBase: API }),
    null,
  );
});

test('a trailing slash on the configured base still matches its own origin', () => {
  // The self-match has to survive the same slash stripping, or this deployment
  // would be redirected to itself and cross-origin for no reason.
  assert.equal(
    runConfig({ hostname: 'vorth-api.onrender.com', origin: 'https://vorth-api.onrender.com', apiBase: `${API}/` }),
    null,
  );
});

/* ================================================================== *
 * Deployed Vercel aliases must all be handled
 * ================================================================== */

test('every Vercel alias for this project is redirected', () => {
  // All three URLs in the deploy notice serve the same project, so all three have
  // to reach the API rather than only the primary one.
  for (const host of ['vorth.vercel.app', 'vorth-uche1.vercel.app', 'vorth-git-main-uche1.vercel.app']) {
    assert.equal(
      runConfig({ hostname: host, origin: `https://${host}`, apiBase: API }), API,
      `${host} was not redirected to the API`,
    );
  }
});

/* ================================================================== *
 * It never throws
 * ================================================================== */

test('a missing location does not take the page down', () => {
  // config.js runs before anything else, so a throw here is a blank page with no
  // error message - the hardest possible failure to diagnose.
  const win = { window: null };
  win.window = win;
  vm.createContext(win);
  const source = fs.readFileSync(CONFIG, 'utf8')
    .replace("'https://REPLACE-WITH-YOUR-API-HOST/api'", `'${API}'`);
  assert.doesNotThrow(() => vm.runInContext(source, win, { filename: 'config.js' }));
});

test('the placeholder is documented where the operator will look for it', () => {
  const source = fs.readFileSync(CONFIG, 'utf8');
  assert.match(source, /REPLACE-WITH-YOUR-API-HOST/);
  assert.match(source, /https:\/\/vorth-api\.onrender\.com\/api/,
    'no example of the real value to copy');
});