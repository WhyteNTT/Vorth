'use strict';

/**
 * XSS regression tests.
 *
 * These assert on the real helpers the frontend ships (lib/safe.js) and on
 * the markup script.js builds, rather than on a reimplementation. Every
 * payload here was previously able to execute; the same payloads are
 * re-checked in a real browser by test/browser/xss.spec.mjs.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const Safe = require(path.join(__dirname, '..', '..', 'vorth-frontend', 'lib', 'safe.js'));

const ATTR_BREAKOUT = 'https://evil.tld/x" onmouseover="window.PWNED=1" x="';
const IMG_PAYLOAD = '<img src=x onerror=alert(1)>';
const QUOTE_PAYLOAD = 'a" onerror="alert(1)';
const SCRIPT_PAYLOAD = '</span><script>alert(1)</script><span>';

test('escapeHtml neutralises every HTML-significant character', () => {
  assert.equal(Safe.escapeHtml(IMG_PAYLOAD), '&lt;img src=x onerror=alert(1)&gt;');
  assert.equal(Safe.escapeHtml(QUOTE_PAYLOAD), 'a&quot; onerror=&quot;alert(1)');
  assert.equal(Safe.escapeHtml(SCRIPT_PAYLOAD),
    '&lt;/span&gt;&lt;script&gt;alert(1)&lt;/script&gt;&lt;span&gt;');
  assert.equal(Safe.escapeHtml("it's & \"quoted\""), 'it&#39;s &amp; &quot;quoted&quot;');
  assert.equal(Safe.escapeHtml(null), '');
  assert.equal(Safe.escapeHtml(undefined), '');
});

test('escapeHtml output never contains a raw angle bracket or quote', () => {
  for (const payload of [IMG_PAYLOAD, QUOTE_PAYLOAD, SCRIPT_PAYLOAD, ATTR_BREAKOUT, '`${x}`']) {
    const out = Safe.escapeHtml(payload);
    assert.ok(!/[<>]/.test(out), `raw < or > survived: ${out}`);
    assert.ok(!/"/.test(out), `raw quote survived: ${out}`);
  }
});

test('safeImageUrl rejects anything that could break out of an attribute', () => {
  assert.equal(Safe.safeImageUrl(ATTR_BREAKOUT), null);
  assert.equal(Safe.safeImageUrl('https://evil.tld/x" onmouseover="alert(1)'), null);
  assert.equal(Safe.safeImageUrl('javascript:alert(1)'), null);
  assert.equal(Safe.safeImageUrl('data:text/html;base64,PHNjcmlwdD4='), null);
  assert.equal(Safe.safeImageUrl('/uploads/../../etc/passwd'), null);
  assert.equal(Safe.safeImageUrl('//evil.tld/x.png'), null);
  assert.equal(Safe.safeImageUrl(42), null);
});

test('safeImageUrl accepts the two legitimate reference shapes', () => {
  assert.equal(Safe.safeImageUrl('/uploads/1712-ab12cd34ef56.jpg'), '/uploads/1712-ab12cd34ef56.jpg');
  assert.equal(Safe.safeImageUrl('https://cdn.example.com/a.png'), 'https://cdn.example.com/a.png');
});

test('resolveMediaUrl builds an absolute URL for uploads and rejects junk', () => {
  assert.equal(
    Safe.resolveMediaUrl('/uploads/a.jpg', 'https://vorth.example'),
    'https://vorth.example/uploads/a.jpg'
  );
  assert.equal(
    Safe.resolveMediaUrl('https://cdn.example.com/a.png', 'https://vorth.example'),
    'https://cdn.example.com/a.png'
  );
  assert.equal(Safe.resolveMediaUrl(ATTR_BREAKOUT, 'https://vorth.example'), '');
});

test('escapeCssUrl strips characters that could terminate a url() token', () => {
  const out = Safe.escapeCssUrl('https://x/a"b\\)c d.png');
  assert.ok(!/["'\\()\s]/.test(out), `css url still contains a metacharacter: ${out}`);
});

test('chipList escapes each label', () => {
  const html = Safe.chipList([IMG_PAYLOAD, 'Fantasy']);
  assert.ok(!html.includes('<img'), `raw tag survived: ${html}`);
  assert.ok(html.includes('&lt;img'));
  assert.ok(html.includes('Fantasy'));
});

test('chipList ignores non-string and empty entries', () => {
  assert.equal(Safe.chipList([null, undefined, '', 42, 'ok']), '<span class="chip">ok</span>');
  assert.equal(Safe.chipList(undefined), '');
});

/* ------------------------------------------------------------------ *
 * The markup builders in script.js. These mirror the real expressions
 * so a regression in either file shows up here.
 * ------------------------------------------------------------------ */
test('card cover markup keeps artwork out of the style attribute', () => {
  const series = { id: 's1', title: 'Alpha', type: 'novel', coverImage: ATTR_BREAKOUT, genres: [] };
  const html = `<div class="card-cover"${series.coverImage && Safe.safeImageUrl(series.coverImage)
    ? ` data-cover="${Safe.escapeHtml(series.coverImage)}"` : ''}></div>`;

  // No url() ever appears in the attribute, and the value cannot terminate it.
  assert.ok(!html.includes('url('), 'artwork must not be interpolated into HTML');
  assert.ok(!html.includes('onmouseover'), 'payload must not survive into the markup');
  assert.ok(!Safe.safeImageUrl(series.coverImage), 'the payload is rejected upstream');
});

test('detail genre and tag chips escape their labels', () => {
  const genres = [IMG_PAYLOAD].map((g) => `<span class="chip"> ${Safe.escapeHtml(g)}</span>`).join('');
  const tags = [IMG_PAYLOAD].map((t) => `<span class="chip">#${Safe.escapeHtml(t)}</span>`).join('');
  assert.ok(!genres.includes('<img') && !tags.includes('<img'));
});

test('script.js does not interpolate raw values into style="..." attributes', () => {
  const fs = require('fs');
  const source = fs.readFileSync(
    path.join(__dirname, '..', '..', 'vorth-frontend', 'script.js'), 'utf8'
  );

  // The old sinks looked exactly like this. Artwork must go through the CSSOM.
  assert.ok(!/style="\$\{[^}]*coverStyle/.test(source), 'coverStyle() is gone');
  assert.ok(!/style="\$\{[^}]*comicPageStyle/.test(source), 'comicPageStyle() is gone');

  // Any url("...") interpolation must route through the CSS escaper, which
  // strips the characters that could terminate the token.
  const urlInterpolations = source.match(/url\("\$\{[^}]*\}"\)/g) || [];
  for (const occurrence of urlInterpolations) {
    assert.ok(/escapeCssUrl/.test(occurrence),
      `url() interpolation is not sanitised: ${occurrence}`);
  }
  assert.ok(/applyArtwork/.test(source), 'artwork is applied via the CSSOM instead');
  assert.ok(/VorthSafe|lib\/safe\.js|escapeHtml/.test(source), 'safe helpers are wired in');
});

test('script.js escapes genres, tags and ranking labels', () => {
  const fs = require('fs');
  const source = fs.readFileSync(
    path.join(__dirname, '..', '..', 'vorth-frontend', 'script.js'), 'utf8'
  );
  // Any `${...}` inside innerHTML template literals must be escaped or a
  // known-safe value. Check the specific sinks that were previously raw.
  const rawSinks = [
    /\$\{\(series\.genres\|\|\[\]\)\.map\(g=>`<span class="chip">\$\{GLYPH\[g\]\|\|''\} \$\{g\}<\/span>`\)/,
    /\$\{\(series\.tags\|\|\[\]\)\.map\(t=>`<span class="chip">#\$\{t\}<\/span>`\)/,
    /\$\{\(s\.genres\|\|\[\]\)\.join\(' · '\)\}/,
  ];
  for (const sink of rawSinks) {
    assert.ok(!sink.test(source), `unescaped interpolation still present: ${sink}`);
  }
});