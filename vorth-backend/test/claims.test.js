'use strict';

/**
 * vorth-frontend/lib/claims.js, without a browser.
 *
 * The browser suite (test/browser/xss.dom.html) is the one that proves these
 * strings cannot produce executable attributes, because only a real HTML parser
 * can settle that. This file covers the parts that do not need one: the shapes,
 * the states, and the fact that every interpolated value is escaped at all.
 *
 * It also guards the reason the lib exists. The markup was a template string
 * inside script.js, and the browser test could only have checked a hand-kept copy
 * of it - which is how a real escape quietly regresses.
 */

process.env.DATABASE_URL ||= 'postgres://stub/stub';
process.env.DATABASE_SSL = 'false';
process.env.JWT_SECRET ||= 'test-secret';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');

const path = require('path');
const fs = require('fs');

const FRONTEND = path.join(__dirname, '..', '..', 'vorth-frontend');
const claims = require(path.join(FRONTEND, 'lib', 'claims.js'));

const HOSTILE = 'https://evil.tld/x" onmouseover="window.__FIRED__=true" x="';

/* ------------------------------------------------------------------ *
 * Shapes.
 * ------------------------------------------------------------------ */

test('an empty list renders the empty state', () => {
  assert.match(claims.claimList([]), /No copyright claims/);
  assert.match(claims.claimList(null), /No copyright claims/, 'null must not throw');
  assert.match(claims.claimList(undefined), /No copyright claims/);
});

test('an uncontested claim offers the counter-notice route', () => {
  const html = claims.claimList([{
    id: 'abc-123',
    removedAt: '2026-03-06T00:00:00Z',
    copyrightedWorkDescription: 'The Lantern, first edition',
    counterNotice: null,
  }]);

  assert.match(html, /data-counter-notice="abc-123"/, 'no route to counter-notice');
  assert.match(html, /The Lantern, first edition/);
  assert.match(html, /Reference abc-123/);
  assert.ok(!html.includes('Counter-notice sent'), 'a contested label on an open claim');
});

test('a contested claim shows the window and hides the button', () => {
  const html = claims.claimList([{
    id: 'abc-123',
    removedAt: '2026-03-06T00:00:00Z',
    copyrightedWorkDescription: 'The Lantern',
    counterNotice: { id: 'cn1', status: 'pending', responseDeadline: '2026-03-20T00:00:00Z' },
  }]);

  assert.ok(!html.includes('data-counter-notice'), 'a second counter-notice is still offered');
  assert.match(html, /Counter-notice sent/);
  // The deadline is the subscriber's own: how long their material may stay down.
  assert.match(html, /court action/);
  assert.ok(!html.includes('2026-03-20T00:00:00.000Z'), 'the raw ISO date leaked into the page');
});

/* ------------------------------------------------------------------ *
 * Escaping.
 * ------------------------------------------------------------------ */

test('every interpolated value is escaped, so no raw quote or angle survives', () => {
  const html = claims.claimItem({
    id: HOSTILE,
    removedAt: HOSTILE,
    copyrightedWorkDescription: HOSTILE,
    counterNotice: { responseDeadline: HOSTILE },
  });

  // Every quote in the output must be part of the markup or an entity, never a
  // bare " inside an attribute value.
  const attrs = html.match(/="[^"]*"/g) || [];
  for (const attr of attrs) {
    assert.ok(attr.includes('&quot;') || !attr.includes('evil.tld"'),
      `a bare quote escaped an attribute: ${attr}`);
  }
  // No unescaped tag from user text.
  assert.ok(!/<script/i.test(html), 'a raw <script> survived');
  assert.ok(!html.includes('" onmouseover'), 'an event handler was assembled from user text');
});

test('an unparseable date renders an em dash rather than NaN or throwing', () => {
  assert.equal(claims.claimDate('not-a-date'), '—');
  assert.equal(claims.claimDate(null), '—');
  assert.equal(claims.claimDate(undefined), '—');
  assert.equal(claims.claimDate(''), '—');
  assert.notEqual(claims.claimDate('2026-03-06T00:00:00Z'), '—');
});

test('a claim with no description renders rather than printing undefined', () => {
  const html = claims.claimItem({ id: 'x', counterNotice: null });
  assert.ok(!html.includes('undefined'), html);
  assert.ok(!html.includes('null'), html);
});

/* ------------------------------------------------------------------ *
 * The lib is the one that ships.
 * ------------------------------------------------------------------ */

test('index.html loads the lib, and script.js uses it', () => {
  const html = fs.readFileSync(path.join(FRONTEND, 'index.html'), 'utf8');
  assert.match(html, /<script src="lib\/safe\.js"><\/script>/);
  assert.match(html, /<script src="lib\/claims\.js"><\/script>/);

  const script = fs.readFileSync(path.join(FRONTEND, 'script.js'), 'utf8');
  assert.match(script, /VorthClaims\.claimList\(/, 'script.js does not render through the lib');

  // And the markup is not duplicated inline, which is what let it drift before.
  const inline = script.match(/class="claim-item"/);
  assert.equal(
    inline, null,
    'script.js still builds claim markup inline; the browser test would only be '
    + 'checking the copy in the test, not the code that runs'
  );
});
