'use strict';

/**
 * What a visitor is told when a request fails.
 *
 * This came from a screenshot of the deployed site, which showed a reader:
 *
 *   "The page could not be found NOT_FOUND cpt1:-lk52k-1791014199690-6a5dcb..."
 *
 * The front-end host was answering for /api because no backend was deployed, and
 * that text was passed straight through. An infrastructure string with an
 * internal request id in it is not an error message.
 *
 * The wording lives in vorth-frontend/lib/apiError.js, loadable via require() the
 * same way lib/safe.js is, so this tracks the shipped file rather than a copy.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const FRONTEND = path.join(__dirname, '..', '..', 'vorth-frontend');
const { looksLikeMissingApi, apiErrorMessage } = require(path.join(FRONTEND, 'lib', 'apiError.js'));

/** Exactly what the deployed host replied with. */
const VERCEL_404 = 'The page could not be found NOT_FOUND cpt1:-lk52k-1791014199690-6a5dcb577272f';

test('a hosting provider 404 is reported as an unreachable server', () => {
  const message = apiErrorMessage(404, VERCEL_404);
  assert.match(message, /not responding/i, `got: ${message}`);
  // The provider's request id must not reach the reader.
  assert.ok(!/cpt1|lk52k|NOT_FOUND/i.test(message), `leaked infrastructure text: ${message}`);
});

test('a JSON 404 carrying the provider marker is also recognised', () => {
  assert.ok(looksLikeMissingApi({ message: 'NOT_FOUND' }));
  assert.ok(looksLikeMissingApi({ error: 'DEPLOYMENT_NOT_FOUND' }));
  assert.match(apiErrorMessage(404, { message: 'NOT_FOUND' }), /not responding/i);
});

test('a non-JSON body means nothing is serving the API', () => {
  assert.ok(looksLikeMissingApi('<html><body>404</body></html>'));
  assert.ok(looksLikeMissingApi('Service Unavailable'));
  // JSON is what this API speaks, so JSON is never "not the API".
  assert.ok(!looksLikeMissingApi({ message: 'Series not found.' }));
  assert.ok(!looksLikeMissingApi('{"message":"nope"}'));
});

test("a genuine API rejection keeps its own wording", () => {
  // Validation errors, auth failures and 404s from the API itself all carry
  // messages written for this interface. They must survive intact.
  const cases = [
    [400, { message: 'A valid email is required' }, /valid email is required/i],
    [401, { error: 'Incorrect password' }, /incorrect password/i],
    [404, { message: 'Series not found.' }, /series not found/i],
    [429, { message: 'Too many requests. Try again later.' }, /too many requests/i],
    [400, 'Please complete all fields.', /complete all fields/i],
    [400, { message: 'Chapter numbering conflict, please retry.' }, /numbering conflict/i],
  ];
  for (const [status, payload, expected] of cases) {
    assert.match(apiErrorMessage(status, payload), expected,
      `${status}: got "${apiErrorMessage(status, payload)}"`);
  }
});

test('a database error never reaches the reader', () => {
  // A 5xx carrying a Postgres message would otherwise be shown verbatim, which
  // leaks schema and file names.
  const leaks = [
    'relation "series" does not exist',
    'column "email_verified_at" does not exist',
    'ECONNREFUSED 127.0.0.1:5432',
    'duplicate key value violates unique constraint "users_email_key"',
  ];
  for (const message of leaks) {
    const shown = apiErrorMessage(500, { message });
    assert.match(shown, /server had a problem/i, `"${message}" became "${shown}"`);
  }
  // A 5xx from the provider is the "not responding" case, not the generic one.
  assert.match(apiErrorMessage(503, 'Service Unavailable'), /not responding/i);
});

test('an unrecognised failure still says something useful', () => {
  assert.match(apiErrorMessage(418, null), /request failed \(418\)/i);
  assert.match(apiErrorMessage(403, ''), /request failed \(403\)/i);
  assert.match(apiErrorMessage(400, {}), /request failed \(400\)/i);
});

test('the status code is always reported when nothing better is available', () => {
  for (const status of [400, 401, 403, 409, 418, 422]) {
    assert.match(apiErrorMessage(status, null), new RegExp(`\\(${status}\\)`));
  }
});

test('script.js delegates to the module rather than duplicating the wording', () => {
  const script = fs.readFileSync(path.join(FRONTEND, 'script.js'), 'utf8');
  assert.match(script, /VorthApiError\.apiErrorMessage\(/,
    'script.js should call the tested module, not reimplement it');
  assert.ok(!/NOT_FOUND\|DEPLOYMENT_NOT_FOUND/.test(script),
    'the provider markers live in the module, not in script.js');

  const html = fs.readFileSync(path.join(FRONTEND, 'index.html'), 'utf8');
  const apiErrorAt = html.indexOf('src="lib/apiError.js"');
  const scriptAt = html.indexOf('src="script.js"');
  assert.ok(apiErrorAt > -1, 'index.html does not load lib/apiError.js');
  assert.ok(scriptAt > -1, 'index.html does not load script.js');
  assert.ok(apiErrorAt < scriptAt, 'lib/apiError.js must load before script.js');
});

test('config.js loads before everything that reads the API base', () => {
  /*
   * Anchored on the src attribute, not the bare filename.
   *
   * The previous version searched for 'script.js' and 'lib/apiError.js', which
   * matches the first occurrence anywhere in the file - including inside an HTML
   * comment explaining the load order. Adding an explanatory comment about
   * load order therefore broke the assertion, which is a sign the assertion was
   * matching prose rather than markup.
   */
  const html = fs.readFileSync(path.join(FRONTEND, 'index.html'), 'utf8');
  const configAt = html.indexOf('src="config.js"');
  const scriptAt = html.indexOf('src="script.js"');
  assert.ok(configAt > -1, 'index.html does not load config.js');
  assert.ok(configAt < scriptAt,
    'config.js must load before script.js, which reads VORTH_API_BASE at startup');
});

test('config.js sets no API base until one is actually configured', () => {
  /*
   * The placeholder guard is the thing that stops a half-finished deployment from
   * sending traffic somewhere unexpected, so it is asserted rather than trusted.
   */
  const config = fs.readFileSync(path.join(FRONTEND, 'config.js'), 'utf8');
  assert.match(config, /REPLACE-WITH-YOUR-API-HOST/,
    'config.js no longer documents the placeholder to replace');
  assert.match(config, /indexOf\('REPLACE-WITH-YOUR-API-HOST'\)/,
    'config.js must stay inert while the placeholder is unreplaced');
  // Local development must never be pointed at a remote host.
  for (const local of ['localhost', '127.0.0.1']) {
    assert.ok(config.includes(`'${local}'`),
      `config.js does not exempt ${local} from the configured base`);
  }
});

test('script.js still catches a network-level failure', () => {
  // fetch() rejecting is not an HTTP response, so apiErrorMessage never sees it.
  // Assert that path exists so it cannot regress into an unhandled rejection.
  const script = fs.readFileSync(path.join(FRONTEND, 'script.js'), 'utf8');
  const body = script.slice(script.indexOf('async function apiFetch('));
  assert.match(body.slice(0, 2500), /catch\s*\(netErr\)/);
});