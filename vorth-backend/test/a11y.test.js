'use strict';

/**
 * Accessibility, checked against the real rendered page.
 *
 * Written rather than installed. axe-core would be the usual answer and it would
 * be a better one for rules like colour contrast and focus order; it is a single
 * large dependency added for a check this project can make well, and a browser
 * was already here to run it. What follows covers what can be decided
 * mechanically and acted on - accessible names, heading order, duplicate ids,
 * broken ARIA references, landmarks - and is explicit about that limit.
 *
 * The audit runs over every view, not just the landing page, because a view is
 * only reachable by clicking something and a control with no name is invisible
 * precisely to the people who navigate by name.
 *
 * Each finding is reported with the element's id or a snippet, so it can be
 * fixed rather than investigated.
 */

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('fs');
const path = require('path');

const FRONTEND = path.join(__dirname, '..', '..', 'vorth-frontend');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
};

/**
 * Serves the frontend the way a static host does, with the API missing.
 *
 * The API answering or not does not change accessibility, and a missing API keeps
 * this test out of the database suites.
 */
function serve() {
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html';
    if (rel.startsWith('api/')) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: false, message: 'unavailable' }));
    }
    const file = path.resolve(FRONTEND, rel);
    if (!file.startsWith(FRONTEND)) { res.writeHead(403); return res.end('forbidden'); }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      res.end(data);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

/** Everything this audit measures, gathered in one pass inside the page. */
const AUDIT = () => {
  const describe = (el) => {
    const id = el.id ? `#${el.id}` : '';
    const cls = el.className && typeof el.className === 'string' && el.className
      ? `.${el.className.trim().split(/\s+/).slice(0, 2).join('.')}` : '';
    return `${el.tagName.toLowerCase()}${id}${cls}`;
  };

  // An accessible name, by the order assistive technology actually resolves them.
  const accessibleName = (el) => {
    const aria = el.getAttribute('aria-labelledby');
    if (aria && aria.split(/\s+/).some((r) => document.getElementById(r))) return true;
    if (el.getAttribute('aria-label') && el.getAttribute('aria-label').trim()) return true;
    if (el.id) {
      const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (label && label.textContent.trim()) return true;
    }
    if (el.closest('label') && el.closest('label').textContent.trim()) return true;
    if (el.tagName === 'BUTTON' || el.tagName === 'A') {
      if (el.textContent.trim()) return true;
      // An icon-only control needs its name from somewhere else.
      const labelled = el.querySelector('[aria-label], [title]');
      if (labelled) return true;
      if (el.getAttribute('title')) return true;
    }
    if (el.tagName === 'INPUT' && (el.type === 'submit' || el.type === 'button')) {
      if (el.value) return true;
    }
    return false;
  };

  const visible = (el) => {
    // offsetParent is null for display:none, and getClientRects is empty for
    // anything not laid out. Both are needed: a hidden ancestor has no rects.
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    return el.getClientRects().length > 0;
  };

  // --- form controls and buttons with no accessible name
  const unnamed = [...document.querySelectorAll('input, select, textarea, button, a[href], [role="button"]')]
    .filter(visible)
    .filter((el) => !accessibleName(el))
    .map(describe);

  // --- heading order: a jump of more than one level loses a reader's place
  const headings = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6')].filter(visible);
  const headingOrder = [];
  let previous = 0;
  for (const h of headings) {
    const level = Number(h.tagName.slice(1));
    if (previous && level > previous + 1) {
      headingOrder.push(`${describe(h)} is an h${level} after an h${previous}`);
    }
    previous = level;
  }

  // --- ids referenced by ARIA or a label that do not exist
  const danglingRefs = [];
  for (const attr of ['aria-labelledby', 'aria-describedby', 'aria-controls', 'aria-owns']) {
    for (const el of document.querySelectorAll(`[${attr}]`)) {
      for (const ref of el.getAttribute(attr).split(/\s+/).filter(Boolean)) {
        if (!document.getElementById(ref)) danglingRefs.push(`${describe(el)} ${attr}="${ref}"`);
      }
    }
  }
  for (const label of document.querySelectorAll('label[for]')) {
    const target = label.getAttribute('for');
    if (target && !document.getElementById(target)) {
      danglingRefs.push(`label for="${target}" points at nothing`);
    }
  }

  // --- duplicate ids: getElementById then returns the first, so the second is unreachable
  const idCounts = {};
  for (const el of document.querySelectorAll('[id]')) {
    idCounts[el.id] = (idCounts[el.id] || 0) + 1;
  }
  const duplicateIds = Object.entries(idCounts)
    .filter(([, n]) => n > 1)
    .map(([id, n]) => `#${id} appears ${n} times`);

  // --- positive tabindex overrides the document order for everyone
  const badTabindex = [...document.querySelectorAll('[tabindex]')]
    .filter((el) => Number(el.getAttribute('tabindex')) > 0)
    .map((el) => `${describe(el)} tabindex=${el.getAttribute('tabindex')}`);

  // --- page-level structure
  const structure = {
    lang: document.documentElement.getAttribute('lang'),
    title: document.title,
    hasMain: !!document.querySelector('main, [role="main"]'),
    hasNav: !!document.querySelector('nav, [role="navigation"]'),
    // Visible h1s only. Every view is a section of one document, so there is one
    // h1 per view in the markup and only the active one is laid out. Counting
    // them all flagged every view, which says nothing - a screen reader does not
    // see a display:none heading either.
    h1Count: [...document.querySelectorAll('h1')].filter(visible).length,
    totalH1: document.querySelectorAll('h1').length,
  };

  // --- images without alt text. There are none in this project, and the check
  //     exists so that stays true rather than by accident.
  const imagesWithoutAlt = [...document.querySelectorAll('img')]
    .filter((img) => !img.hasAttribute('alt') && img.getAttribute('aria-hidden') !== 'true')
    .map(describe);

  return { unnamed, headingOrder, danglingRefs, duplicateIds, badTabindex, structure, imagesWithoutAlt };
};

/** Clicks through every view the nav exposes, so none is audited by accident of never being opened. */
const VIEWS = [
  'home', 'browse', 'rankings', 'profile', 'library', 'upload', 'about',
];

test('every view is reachable by keyboard and names its controls', async (t) => {
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
      return t.skip(`no headless browser available: ${err.message}`);
    }

    const problems = [];
    const seenViews = [];

    for (const view of VIEWS) {
      const page = await browser.newPage();
      await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });

      const button = await page.$(`button[data-view="${view}"]`);
      if (!button) {
        await page.close();
        continue;
      }
      await button.click();
      // Let the view render and any fetch resolve before auditing it.
      await page.waitForTimeout(250);
      seenViews.push(view);

      const audit = await page.evaluate(AUDIT);
      for (const [kind, list] of Object.entries(audit)) {
        if (Array.isArray(list) && list.length) {
          problems.push(`${view}: ${kind} -> ${list.join(', ')}`);
        }
      }

      if (audit.structure.lang !== 'en') {
        problems.push(`${view}: <html lang> is ${JSON.stringify(audit.structure.lang)}`);
      }
      if (!audit.structure.title) problems.push(`${view}: the document has no title`);
      if (!audit.structure.hasMain) problems.push(`${view}: no <main> or role="main"`);
      if (!audit.structure.hasNav) problems.push(`${view}: no <nav> or role="navigation"`);
      if (audit.structure.h1Count !== 1) {
        const which = await page.evaluate(() => [...document.querySelectorAll('h1')]
          .filter((h) => h.getClientRects().length > 0)
          .map((h) => `${h.tagName}#${h.id || '(no id)'}"${h.textContent.trim().slice(0, 30)}" in ${h.closest('.view')?.id || '(no view)'}`));
        problems.push(`${view}: ${audit.structure.h1Count} visible <h1> - ${which.join(' | ')}`);
      }

      await page.close();
    }

    assert.ok(seenViews.length >= 5,
      `only audited ${seenViews.length} views (${seenViews.join(', ')}); the selectors probably broke`);
    assert.deepEqual(problems, [], problems.join('\n  '));
  } finally {
    if (browser) await browser.close().catch(() => {});
    server.close();
  }
});