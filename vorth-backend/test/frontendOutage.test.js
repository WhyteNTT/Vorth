'use strict';

/**
 * The exact situation in the deployed screenshot: the frontend is served, and
 * nothing serves /api underneath it.
 *
 * Served by a static server that answers /api with the same 404 text a hosting
 * provider returns, because that is what happened. The page must tell the
 * reader the server is unreachable rather than quoting the provider's error and
 * its internal request id.
 *
 * This needs a browser and no database, so it is gated on Chromium being
 * launchable and named in `test:browser`. It used to be gated on VORTH_E2E,
 * which no script that includes this file ever set - so it was skipped by every
 * run, including CI, guarding a bug that had already shipped once.
 */

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const path = require('path');

const FRONTEND = path.join(__dirname, '..', '..', 'vorth-frontend');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
};

/** The provider's 404 body, verbatim from the screenshot. */
const PROVIDER_404 = 'The page could not be found NOT_FOUND cpt1:-lk52k-1791014199690-6a5dcb577272f';

function serve() {
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html';
    if (rel.startsWith('api/')) {
      // Nothing is serving the API. This is the deployed failure mode.
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end(PROVIDER_404);
    }
    const file = path.resolve(FRONTEND, rel);
    if (!file.startsWith(FRONTEND)) { res.writeHead(403); return res.end('forbidden'); }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); return res.end(PROVIDER_404); }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      res.end(data);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

/*
 * Both timeouts below are generous on purpose.
 *
 * The waitForSelector budget is the one that bit: this test launches a browser
 * and waits for a toast, and under `npm run test:coverage` every child process
 * is instrumented and dumps a V8 profile on exit while the end-to-end suite runs
 * its own Chromium instances alongside. The 15s default was picked without that
 * in mind and produced an intermittent timeout whose only symptom was a missing
 * toast - indistinguishable from the regression this test exists to catch.
 *
 * A wait budget here says nothing about the product, so it reflects what the test
 * actually does rather than pretending to a bound it cannot meet on a loaded
 * machine. The outer timeout is the matching safety net, so a launch that never
 * completes fails with a clear message instead of hanging.
 */
test('a reader is told the server is unreachable, not what the host said', { timeout: 180000 }, async (t) => {
  let chromium;
  try {
    ({ chromium } = require('playwright'));
  } catch (_) {
    assert.fail('playwright is not installed');
  }

  const { server, port } = await serve();
  let browser;
  try {
    try {
      browser = await chromium.launch();
    } catch (err) {
      // Same courtesy as the XSS browser suite: a bare checkout with no Chromium
      // skips rather than failing, so `npm test` stays green without a browser.
      return t.skip(`no headless browser available: ${err.message}`);
    }
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle' });

    // Open the catalogue, which is what triggers the API call on load.
    await page.click('button[data-view="browse"]');
    await page.waitForSelector('#toast.show', { timeout: 90000 });
    const toast = (await page.textContent('#toast')) || '';

    assert.match(toast, /not responding/i, `toast read "${toast}"`);
    assert.ok(!/cpt1|lk52k|NOT_FOUND/i.test(toast),
      `the provider's error text reached the reader: "${toast}"`);

    // And the grid should say something honest rather than showing an API error.
    const grid = (await page.textContent('#browseGrid')) || '';
    assert.ok(!/NOT_FOUND|cpt1/i.test(grid), `the grid shows infrastructure text: "${grid}"`);

    await browser.close();
  } finally {
    if (browser) await browser.close().catch(() => {});
    server.close();
  }
});

test('lib/apiError.js is served alongside the app', () => {
  // If this file were missing, the page would throw on the first failure.
  assert.ok(fs.existsSync(path.join(FRONTEND, 'lib', 'apiError.js')));
  const html = fs.readFileSync(path.join(FRONTEND, 'index.html'), 'utf8');
  assert.match(html, /<script src="lib\/apiError\.js"><\/script>\s*<script src="script\.js">/);
});