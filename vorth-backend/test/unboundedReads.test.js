'use strict';

/**
 * No list endpoint reads the whole table.
 *
 * This is a static check, and it is a rough one: it looks for a `.find(` whose
 * chain has no ceiling anywhere in it. That produces false positives for reads
 * that are bounded by construction - a `$in` over the caller's own ids, a
 * per-user row - so those are listed as exemptions with the reason, which is what
 * makes each one a decision rather than a silence.
 *
 * The alternative was leaving this to review, and review does not catch it. An
 * unbounded read is correct at every size the data happens to be, so nothing about
 * it looks wrong until it is too late, and three of the queues this covers only
 * ever grow.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const CONTROLLERS = path.join(__dirname, '..', 'src', 'controllers');

/** Reads that are bounded by construction rather than by a limit. */
const EXEMPT = [
  {
    file: 'chapterController.js',
    match: /User\.find\(\{ library: series\._id \}\)/,
    why: 'a count of followers, projected to id only; it grows with the series but is '
      + 'a single narrow column and is not rendered as a list',
  },
  {
    file: 'libraryController.js',
    match: /Series\.find\(\{ id: \{ \$in: (?:ids|seriesIds) \}/,
    why: 'bounded by the signed-in user\'s own library, which is a JSONB array on their row',
  },
  {
    file: 'progressController.js',
    match: /ReadingProgress\.find\(\{ user: req\.user\.id \}\)/,
    why: "the caller's own rows, and there is at most one per series they have "
      + 'opened - so the row count is bounded by the catalogue, not by traffic. '
      + 'Capping it would drop a heavy reader\'s history, which is the feature',
  },
  {
    file: 'dmcaCounterNoticeController.js',
    match: /Series\.find\(\{ owner: req\.user\.id \}\)/,
    why: 'the caller\'s own series, and the next read is bounded by their ids',
  },
  {
    file: 'dmcaCounterNoticeController.js',
    match: /Chapter\.find\(\{ series: \{ \$in: seriesIds \} \}\)/,
    why: 'chapters of the caller\'s own series; a publisher\'s back catalogue, not a queue',
  },
  {
    file: 'dmcaCounterNoticeController.js',
    match: /DMCACounterNotice\.find\(\{ dmcaReport: \{ \$in: reportIds \} \}\)/,
    why: 'counter notices against a bounded set of the caller\'s own reports',
  },
  {
    file: 'libraryController.js',
    match: /Chapter\.find\(\{ id: \{ \$in: chapterIds \}/,
    why: 'the caller\'s own offline downloads',
  },
  {
    file: 'dmcaCounterNoticeController.js',
    match: /DMCAReport\.find\(\{ status: 'accepted'/,
    why: 'reports the caller owns, already narrowed by series they published',
  },
];

const isExempt = (file, line) => EXEMPT.some((e) => e.file === file && e.match.test(line));

test('no list read is unbounded', () => {
  const unbounded = [];

  for (const name of fs.readdirSync(CONTROLLERS)) {
    if (!name.endsWith('.js')) continue;
    const lines = fs.readFileSync(path.join(CONTROLLERS, name), 'utf8').split('\n');

    lines.forEach((line, i) => {
      if (!/\.find\(/.test(line)) return;
      // The chain can run onto following lines, so look a few ahead for a bound.
      const chain = lines.slice(i, i + 6).join(' ');
      if (/\.limit\(|pageSize\(|PAGE_MAX|SWEEP_BATCH|\.take\(/.test(chain)) return;
      if (isExempt(name, line)) return;

      unbounded.push(`${name}:${i + 1}: ${line.trim().slice(0, 100)}`);
    });
  }

  assert.deepEqual(unbounded, [],
    'these reads have no ceiling. A list endpoint that grows without bound is fine '
    + 'until it is not, and nothing about it looks wrong until then:\n  '
    + unbounded.join('\n  '));
});

test('every exemption is still used', () => {
  // An exemption for a read that no longer exists is a hole with a comment on it.
  const unused = [];
  for (const rule of EXEMPT) {
    const file = path.join(CONTROLLERS, rule.file);
    const src = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    if (!rule.match.test(src)) unused.push(`${rule.file}: ${rule.match}`);
  }
  assert.deepEqual(unused, [],
    'these exemptions no longer match anything, so they are just silence:\n  '
    + unused.join('\n  '));
});

test('a requested page size is clamped rather than trusted', () => {
  /*
   * `?limit=1000000` is an unbounded read wearing a query parameter. If the
   * ceiling only applied to the default, the endpoint was still unbounded and the
   * helper gave the appearance of having bounded it.
   */
  const { pageSize, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } = require('../src/utils/pagination');

  const req = (q) => ({ query: q || {} });

  assert.equal(pageSize(req()), DEFAULT_PAGE_SIZE);
  assert.equal(pageSize(req({ limit: '50' })), 50);
  assert.equal(pageSize(req({ limit: '1000000' })), MAX_PAGE_SIZE,
    'an enormous ?limit= was honoured');
  assert.equal(pageSize(req({ limit: '-5' })), DEFAULT_PAGE_SIZE);
  assert.equal(pageSize(req({ limit: 'abc' })), DEFAULT_PAGE_SIZE);
  assert.equal(pageSize(req({ limit: '0' })), DEFAULT_PAGE_SIZE);
  assert.equal(pageSize(undefined), DEFAULT_PAGE_SIZE);

  // Whatever is asked for, the answer stays inside the bound.
  for (const asked of ['1', '10', '499', '500', '501', '99999', 'Infinity', '']) {
    const size = pageSize(req({ limit: asked }));
    assert.ok(size > 0 && size <= MAX_PAGE_SIZE, `?limit=${asked} produced ${size}`);
  }
});