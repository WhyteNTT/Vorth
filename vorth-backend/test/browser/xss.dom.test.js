'use strict';

/**
 * Real-browser XSS regression.
 *
 * The unit tests prove the escaping functions behave; this proves the
 * browser's HTML parser cannot turn a payload into an executable attribute
 * using the shipped helpers. Runs against the real vorth-frontend/lib/safe.js.
 *
 * Skipped automatically when no browser bridge is available, so it never
 * blocks CI on a headless-less runner.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');

const PAGE = path.join(__dirname, 'xss.dom.html');
// Defaults to the in-repo bridge; it self-skips when no headless browser is
// installed, so `npm test` stays green on a bare checkout.
const BRIDGE = process.env.VORTH_BROWSER_BRIDGE || './test/browser/run.mjs';

test('browser: payloads cannot produce executable attributes or elements', async (t) => {
  const resolved = BRIDGE.startsWith('.')
    ? path.resolve(__dirname, '..', '..', BRIDGE)
    : BRIDGE;
  if (!fs.existsSync(resolved)) {
    t.skip(`bridge not found: ${resolved}`);
    return;
  }
  let runPage;
  try {
    // A bare Windows path is not a valid ESM specifier; it must be a file URL.
    ({ runPage } = await import(pathToFileURL(resolved).href));
  } catch (err) {
    t.skip(`browser bridge unavailable: ${err.message}`);
    return;
  }

  let result;
  try {
    result = await runPage(PAGE);
  } catch (err) {
    t.skip(`no headless browser available: ${err.message}`);
    return;
  }

  assert.ok(
    result.cases.length >= 12,
    `expected the full case list, got ${result.cases.length}`
  );
  for (const c of result.cases) {
    assert.ok(c.ok, `${c.name}\n    DOM: ${c.detail}`);
  }
  assert.equal(result.failed, 0, `${result.failed} case(s) failed`);
});