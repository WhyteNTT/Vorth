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

    // Diagnostics, kept permanently. A timeout with no explanation is
    // indistinguishable from a regression, which is how this test spent an
    // afternoon being blamed for something else.
    const pageLog = [];
    page.on('console', (m) => pageLog.push(`console.${m.type()}: ${m.text()}`));
    page.on('pageerror', (e) => pageLog.push(`pageerror: ${e.message}`));
    page.on('requestfailed', (r) => pageLog.push(`requestfailed: ${r.url()} ${r.failure()?.errorText}`));

    /*
     * Record every state the toast passes through, installed before any document
     * exists so it cannot miss the first one.
     *
     * Waiting for the toast was the whole difficulty, and every approach that
     * waits fails: `toast()` sets the text, adds `.show`, and removes `.show`
     * 2200ms later, so polling for `.toast.show` is a race against a 2.2 second
     * window - it failed once in three full runs, with the correct message
     * sitting in the element and the class already gone, which reads exactly like
     * the regression this test exists to catch. Polling for non-empty text is
     * worse: `toast()` never clears its text, so it latches onto the earlier
     * toast that init() already showed.
     *
     * A MutationObserver sidesteps both. It is installed via addInitScript, so it
     * exists before the first script runs, and it records each transition as it
     * happens rather than looking for a state at an arbitrary moment. Nothing has
     * to be caught within any window.
     */
    await page.addInitScript(() => {
      window.__toasts = [];
      const attach = () => {
        const el = document.querySelector('#toast');
        if (!el) return false;
        const record = () => {
          const last = window.__toasts[window.__toasts.length - 1];
          const text = el.textContent || '';
          const shown = el.classList.contains('show');
          if (last && last.text === text && last.shown === shown) return;
          window.__toasts.push({ text, shown });
        };
        new MutationObserver(record).observe(el, {
          childList: true, characterData: true, subtree: true, attributes: true,
        });
        record();
        return true;
      };
      if (!attach()) document.addEventListener('DOMContentLoaded', attach, { once: true });
    });

    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle' });
    await page.click('button[data-view="browse"]');

    // The catalogue grid renders the message persistently; the toast is the
    // transient one. Both are what a reader sees, so both are checked.
    await page.waitForFunction(
      () => (document.querySelector('#browseGrid')?.textContent || '').length > 0,
      null, { timeout: 30000, polling: 50 },
    ).catch(() => {});

    const toasts = await page.evaluate(() => window.__toasts);
    const shown = toasts.filter((t) => t.shown && t.text);
    assert.ok(shown.length > 0,
      `the toast never appeared in a shown state. Recorded states: ${JSON.stringify(toasts)}`
      + `\n  page log:\n    ${pageLog.join('\n    ') || '(nothing logged)'}`);

    const toast = shown[shown.length - 1].text;

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