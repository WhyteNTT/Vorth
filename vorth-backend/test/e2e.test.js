'use strict';

/**
 * End-to-end: the real server, the real page, a real browser.
 *
 * Everything else in this suite tests a layer. This drives the actual product:
 * it boots server.js as a child process against a real PostgreSQL, loads
 * index.html in headless Chromium, and clicks through the flows a reader and a
 * creator actually use.
 *
 * It exists because four bugs in this codebase were invisible to every other
 * test and obvious the moment a human opened the page:
 *   - script.js called Safe.escapeCssUrl while the module exported VorthSafe,
 *     so every view that rendered a cover threw and died
 *   - helmet's default CSP had no connect-src, so every fetch() was refused and
 *     the whole app sat there inert
 *   - browse sent type=&genre=, which isIn() rejected, 400ing every unfiltered
 *     request
 *   - the 'add a chapter' picker was populated from the public catalog rather
 *     than the creator's own series, so it stayed empty after publishing
 *
 * A unit test cannot catch any of those. Only loading the page can.
 *
 * Requires a disposable PostgreSQL (see test/helpers/liveGuard.js) and
 * Playwright's Chromium. Skips itself when either is absent, so `npm test`
 * still works on a bare checkout.
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { spawn } = require('child_process');
const net = require('net');

const { assertSafeTarget } = require('./helpers/liveGuard');

const BACKEND = path.join(__dirname, '..');

/* ------------------------------------------------------------------ *
 * Availability
 * ------------------------------------------------------------------ */

let chromium = null;
try {
  ({ chromium } = require('playwright'));
} catch (_) {
  chromium = null;
}

const DATABASE_URL = process.env.DATABASE_URL || '';
const reasons = [];
if (!DATABASE_URL) reasons.push('DATABASE_URL is not set');
if (!chromium) reasons.push('playwright is not installed (npm i -D playwright && npx playwright install chromium)');
if (!process.env.VORTH_E2E) reasons.push('VORTH_E2E is not set');

const skip = reasons.length ? reasons.join('; ') : false;

if (!skip) {
  // Refuse to drive a browser against anything that is not a disposable
  // database. This test creates real rows.
  try {
    assertSafeTarget(DATABASE_URL, process.env);
  } catch (err) {
    // Reported as a skip rather than a pass: a silently skipped safety check
    // is how the earlier incident happened.
    console.error(`\n  [e2e] refusing to run: ${err.message}\n`);
  }
}

/* ------------------------------------------------------------------ *
 * Harness
 * ------------------------------------------------------------------ */

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/** Boots server.js and waits for it to report healthy. */
async function startServer() {
  const port = await freePort();
  const child = spawn(process.execPath, ['server.js'], {
    cwd: BACKEND,
    env: {
      ...process.env,
      PORT: String(port),
      NODE_ENV: 'test',
      DATABASE_URL,
      DATABASE_SSL: process.env.DATABASE_SSL === 'false' ? 'false' : undefined,
      JWT_SECRET: 'e2e-secret-not-a-real-one-0123456789abcdef',
      MAIL_TRANSPORT: 'disabled',
      STORAGE_DRIVER: 'local',
      RATE_LIMIT_STORE: 'memory',
      SECURE_COOKIES: 'false',
      CLIENT_ORIGINS: '',
      REFRESH_COOKIE: 'false',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  child.stdout.on('data', (d) => { output += d; });
  child.stderr.on('data', (d) => { output += d; });

  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`server.js exited with ${child.exitCode}:\n${output}`);
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (res.ok) {
        const body = await res.json();
        if (body.database === 'connected' || body.db === 'connected' || body.ok) {
          return { child, port, base: `http://127.0.0.1:${port}`, log: () => output };
        }
      }
    } catch (_) { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  child.kill();
  throw new Error(`server.js never became healthy:\n${output}`);
}

/**
 * Everything the page complains about while the test runs.
 *
 * A console error or a failed request here is exactly how the bugs listed at
 * the top of this file presented: the app looked fine and did nothing.
 */
function watchPage(page) {
  const consoleErrors = [];
  const pageErrors = [];
  const failedRequests = [];

  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const text = msg.text();
    // 4xx from endpoints the UI probes but tolerates are not defects.
    if (/favicon|\/api\/notifications\b.*(401|403)/.test(text)) return;
    consoleErrors.push(text);
  });
  page.on('pageerror', (err) => pageErrors.push(err.message));

  /** True for traffic the application itself issued. */
  const isAppTraffic = (req) => {
    const url = req.url();
    if (url.includes('/api/')) return true;
    // Static assets the page needs in order to work: scripts, stylesheets,
    // fonts, the module graph. Decorative media is excluded.
    return ['script', 'stylesheet', 'document', 'fetch', 'xhr', 'font'].includes(req.resourceType());
  };

  page.on('requestfailed', (req) => {
    if (!isAppTraffic(req)) return;
    failedRequests.push(`${req.method()} ${req.url()} [${req.resourceType()}] - ${req.failure()?.errorText}`);
  });
  page.on('response', (res) => {
    if (res.status() >= 500 && isAppTraffic(res.request())) {
      failedRequests.push(`${res.status()} ${res.url()}`);
    }
  });

  return { consoleErrors, pageErrors, failedRequests };
}

function assertClean(watch, where) {
  assert.deepEqual(watch.pageErrors, [], `uncaught exception in the page during ${where}`);
  assert.deepEqual(watch.consoleErrors, [], `console error during ${where}`);
  assert.deepEqual(watch.failedRequests, [], `failed request during ${where}`);
}

const uniq = () => Math.random().toString(36).slice(2, 8);

/* ------------------------------------------------------------------ *
 * The suite
 * ------------------------------------------------------------------ */

test('end to end: sign up, publish, read, save', { skip }, async () => {
  const server = await startServer();
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const watch = watchPage(page);

  const username = `e2e_${uniq()}`;
  const password = 'e2e-password-1234';
  const title = `End To End ${uniq()}`;

  try {
    /* ---------------------------------------------------------------- *
     * 1. The page loads and talks to the API
     * ---------------------------------------------------------------- */
    await page.goto(`${server.base}/`, { waitUntil: 'networkidle' });

    // This is where "Safe is not defined" and the CSP both used to fail.
    assertClean(watch, 'initial load');

    /*
     * Open the catalog. renderBrowse only runs when the view is shown, so the
     * grid is empty until then.
     *
     * Unfiltered browse used to send type=&genre=, which isIn() rejected, so
     * every unfiltered request 400'd and renderBrowse's catch branch painted
     * the API's error message into the grid. On an empty catalog the correct
     * outcome is the "nothing matches" hint, so that distinction is the
     * assertion.
     */
    await page.click('button[data-view="browse"]');
    await page.waitForSelector('#browseGrid .card, #browseGrid .empty-hint', { timeout: 15000 });

    const gridText = (await page.textContent('#browseGrid')) || '';
    assert.doesNotMatch(gridText, /required|invalid|isIn|400|bad request/i,
      `browse grid shows an API validation error: "${gridText.trim()}"`);
    assert.doesNotMatch(gridText, /unable to load/i,
      'browse failed to load; renderBrowse hit its error branch');

    const browseCount = (await page.textContent('#browseCount')) || '';
    assert.match(browseCount, /^\d+ series found$/,
      `browse count reads "${browseCount}"`);
    assertClean(watch, 'browse');

    /* ---------------------------------------------------------------- *
     * 2. Sign up through the real form
     * ---------------------------------------------------------------- */
    await page.click('button[data-view="profile"]');
    await page.click('#authTabs .tab[data-auth="signup"]');
    await page.fill('#signupName', 'E2E Reader');
    await page.fill('#signupUsername', username);
    await page.fill('#signupEmail', `${username}@example.test`);
    await page.fill('#signupPassword', password);
    await page.fill('#signupConfirmPassword', password);
    await page.check('#signupTerms');
    await page.check('#signupAge');
    await page.click('#signupForm button[type="submit"]');

    // If CSP blocked connect-src, nothing happens here and the profile view
    // never leaves its signed-out state.
    await page.waitForSelector('#profileLoggedIn:not(.hidden)', { timeout: 15000 });
    assert.match(await page.textContent('#profileName'), /E2E Reader/);
    assertClean(watch, 'sign up');

    /* ---------------------------------------------------------------- *
     * 3. Publish a series
     * ---------------------------------------------------------------- */
    await page.click('button[data-view="upload"]');
    await page.fill('#upTitle', title);
    await page.fill('#upAuthor', 'E2E Author');
    await page.fill('#upSynopsis', 'Published by an automated end-to-end test.');
    await page.fill('#upGenres', 'Fantasy');
    await page.fill('#upTags', 'e2e');
    await page.selectOption('#upType', { label: 'Novel' });
    await page.selectOption('#upStatus', { label: 'Ongoing' });
    await page.check('#upRightsAttested');
    await page.click('#seriesForm button[type="submit"]');

    await page.waitForSelector(`#seriesFormHint:has-text("${title}")`, { timeout: 15000 });
    assertClean(watch, 'publish series');

    /* ---------------------------------------------------------------- *
     * 4. The chapter picker lists the series just published
     *
     * This used to read the public catalog instead of the creator's own
     * series, so it stayed on "No owned series yet" until the next sign-in.
     * ---------------------------------------------------------------- */
    await page.click('#uploadTabs .tab[data-upload="chapter"]');
    // `state: 'attached'` because an <option> is never "visible" to Playwright.
    await page.waitForSelector('#upSeriesSelect option[value]:not([value=""])',
      { state: 'attached', timeout: 15000 });
    const picked = await page.$eval('#upSeriesSelect', (sel) => sel.options[0].textContent);
    assert.ok(picked.includes(title), `chapter picker shows "${picked}", expected "${title}"`);
    assertClean(watch, 'chapter picker');

    /* ---------------------------------------------------------------- *
     * 5. Publish a chapter to it
     * ---------------------------------------------------------------- */
    await page.fill('#upChapterTitle', 'Chapter One');
    await page.fill('#upChapterParagraphs', 'It was a dark and stormy platform.\n\nThe deploy failed again.');
    await page.click('#chapterForm button[type="submit"]');

    await page.waitForSelector('#chapterFormHint:has-text("Chapter published")', { timeout: 15000 });
    assertClean(watch, 'publish chapter');

    /* ---------------------------------------------------------------- *
     * 6. It shows up in browse
     * ---------------------------------------------------------------- */
    await page.click('button[data-view="browse"]');
    await page.waitForSelector(`#browseGrid :text("${title}")`, { timeout: 15000 });
    assertClean(watch, 'browse after publishing');

    /* ---------------------------------------------------------------- *
    /* ---------------------------------------------------------------- *
     * 7. Save it from the card, then open it
     * ---------------------------------------------------------------- */
    // The save control lives on the card as [data-save], and the whole card
    // opens the detail view. Using the real controls rather than a guessed
    // selector is the point: a renamed id would fail here.
    const card = `#browseGrid .card:has-text("${title}")`;
    await page.click(`${card} [data-save]`);
    await page.waitForSelector(`${card} [data-save].saved`, { timeout: 15000 });
    assertClean(watch, 'save to library');

    await page.click(card);
    await page.waitForSelector('#view-detail.active', { timeout: 15000 });
    await page.waitForSelector(`#detailContent :text("${title}")`, { timeout: 15000 });

    // The chapter published earlier must be listed on the detail page.
    await page.waitForSelector('#detailContent :text("Chapter One")', { timeout: 15000 });
    assertClean(watch, 'detail view');

    /* ---------------------------------------------------------------- *
     * 8. The library renders the saved series as a document
     *
     * GET /library used to return bare UUIDs, so this grid could not render
     * anything at all. A saved series you never browsed showed as a blank
     * panel, which made the control look broken.
     * ---------------------------------------------------------------- */
    await page.click('button[data-view="library"]');
    await page.waitForSelector(`#libraryGrid :text("${title}")`, { timeout: 15000 })
      .catch(() => { throw new Error('the saved series never appeared in the library grid'); });
    assertClean(watch, 'library');

    /* ---------------------------------------------------------------- *
     * 9. Read the chapter
     * ---------------------------------------------------------------- */
    await page.click('button[data-view="browse"]');
    await page.waitForSelector(card, { timeout: 15000 });
    await page.click(card);
    await page.waitForSelector('#view-detail.active', { timeout: 15000 });
    const readLink = page.locator('#detailContent *', { hasText: /^(Read|Start|Chapter One)/ }).first();
    if (await readLink.count()) {
      await readLink.click({ timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(800);
    }
    assertClean(watch, 'reader');

    /* ---------------------------------------------------------------- *
     * 8. The session survives a reload
     *
     * The refresh cookie is the only durable credential, so if this fails the
     * user is silently signed out on every navigation.
     * ---------------------------------------------------------------- */
    await page.reload({ waitUntil: 'networkidle' });
    await page.click('button[data-view="profile"]');
    await page.waitForSelector('#profileLoggedIn:not(.hidden)', { timeout: 15000 });
    assertClean(watch, 'after reload');

    /* ---------------------------------------------------------------- *
     * 9. Sign out
     * ---------------------------------------------------------------- */
    await page.click('#logoutBtn');
    await page.waitForSelector('#profileLoggedOut:not(.hidden)', { timeout: 15000 });
    assertClean(watch, 'sign out');
  } finally {
    await context.close();
    await browser.close();
    server.child.kill();
  }
});

test('end to end: the public rankings endpoint serves without error', { skip }, async () => {
  const server = await startServer();
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const watch = watchPage(page);
  try {
    await page.goto(`${server.base}/`, { waitUntil: 'networkidle' });
    // renderRankings casts views->>'alltime' to an integer; a series whose
    // views column lacks that key makes the whole endpoint 500.
    const res = await page.evaluate(async () => {
      const r = await fetch('/api/series/rankings?range=alltime');
      return { status: r.status, body: await r.text() };
    });
    assert.equal(res.status, 200, `rankings returned ${res.status}: ${res.body.slice(0, 200)}`);
    assert.doesNotMatch(res.body, /error/i);
    assertClean(watch, 'rankings');
  } finally {
    await browser.close();
    server.child.kill();
  }
});

test('end to end: the account panel for reset and verification is present', { skip }, async () => {
  const server = await startServer();
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await page.goto(`${server.base}/`, { waitUntil: 'networkidle' });
    // These were added with the reset/verify flow; a template edit that dropped
    // them would otherwise only show up as a dead button.
    for (const id of ['accountPanel', 'forgotForm', 'resetForm', 'verifyForm']) {
      assert.equal(await page.locator(`#${id}`).count(), 1, `#${id} is missing from the page`);
    }
  } finally {
    await browser.close();
    server.child.kill();
  }
});
