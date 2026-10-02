#!/usr/bin/env node
'use strict';

/**
 * Optional browser bridge for the DOM-level XSS regression.
 *
 * Serves the repository root over HTTP and drives the page through whichever
 * headless browser is available (Playwright, then Puppeteer, then a CDP
 * endpoint). Returns { cases, passed, failed }.
 *
 * Point VORTH_BROWSER_BRIDGE at this file to enable it in `npm test`:
 *   set VORTH_BROWSER_BRIDGE=./test/browser/run.mjs   (Windows)
 *   VORTH_BROWSER_BRIDGE=./test/browser/run.mjs npm test
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
};

function serve() {
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '');
    const file = path.resolve(ROOT, rel);
    // Never serve outside the repository.
    if (!file.startsWith(ROOT)) { res.writeHead(403).end('forbidden'); return; }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404).end('not found'); return; }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      res.end(data);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

/** @returns {Promise<{cases: Array, passed: number, failed: number}>} */
export async function runPage(pagePath) {
  const rel = path.relative(ROOT, pagePath).replace(/\\/g, '/');
  const { server, port } = await serve();
  const url = `http://127.0.0.1:${port}/${rel}`;

  try {
    const browser = await launch();
    try {
      const tab = await browser.newPage();
      await tab.goto(url, { waitUntil: 'load' });
      await tab.waitForFunction(() => window.__DONE__ === true, { timeout: 10000 });
      return await tab.evaluate(() => window.__RESULT__);
    } finally {
      await browser.close();
    }
  } finally {
    server.close();
  }
}

/** Adapts Playwright and Puppeteer to a single tiny interface. */
async function launch() {
  try {
    const { chromium } = await import('playwright');
    const browser = await chromium.launch();
    return {
      newPage: async () => {
        const page = await browser.newPage();
        return {
          goto: (u, o) => page.goto(u, o),
          waitForFunction: (fn, o) => page.waitForFunction(fn, o),
          evaluate: (fn) => page.evaluate(fn),
        };
      },
      close: () => browser.close(),
    };
  } catch (_) { /* fall through to puppeteer */ }

  const puppeteer = await import('puppeteer').catch(() => null);
  if (!puppeteer) {
    throw new Error('No headless browser available. Install playwright or puppeteer, '
      + 'or unset VORTH_BROWSER_BRIDGE to skip the browser suite.');
  }
  const browser = await puppeteer.launch({ headless: true });
  return {
    newPage: async () => {
      const page = await browser.newPage();
      return {
        goto: (u, o) => page.goto(u, { waitUntil: o.waitUntil }),
        waitForFunction: (fn, o) => page.waitForFunction(fn, { timeout: o.timeout, polling: 50 }),
        evaluate: (fn) => page.evaluate(fn),
      };
    },
    close: () => browser.close(),
  };
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}`) {
  const page = process.argv[2] || path.join(HERE, 'xss.dom.html');
  runPage(path.resolve(page))
    .then((r) => {
      console.log(`${r.passed}/${r.passed + r.failed} browser cases passed`);
      for (const c of r.cases) console.log(`  ${c.ok ? 'PASS' : 'FAIL'}  ${c.name}`);
      process.exit(r.failed ? 1 : 0);
    })
    .catch((err) => { console.error(err.message); process.exit(1); });
}