'use strict';

/**
 * POST /api/reports — the Content Policy intake.
 *
 * Public, like the DMCA form: the person reporting is often a reader who has no
 * account, and requiring one would suppress reports.
 */

process.env.DATABASE_URL ||= 'postgres://stub/stub';
process.env.DATABASE_SSL = 'false';
process.env.JWT_SECRET ||= 'test-secret';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const { CATEGORIES } = require('../src/controllers/reportController');

test('the category list is closed, so a report can be triaged', () => {
  assert.ok(CATEGORIES.length >= 5);
  assert.ok(CATEGORIES.includes('other'), 'there must be a catch-all');
  assert.equal(new Set(CATEGORIES).size, CATEGORIES.length, 'categories must be unique');
  for (const c of CATEGORIES) assert.match(c, /^[a-z0-9_]+$/, `${c} is not a safe slug`);
});

test('every category corresponds to something the policy prohibits', () => {
  // A category the policy never mentions, or a prohibited item with no
  // category, both mean a reporter is forced to pick something that does not
  // describe what they actually saw.
  const fs = require('fs');
  const path = require('path');
  const policy = fs.readFileSync(
    path.join(__dirname, '..', 'legal', 'CONTENT_POLICY.md'), 'utf8'
  ).toLowerCase();

  const expectations = {
    sexual_minors: ['sexualizes minors', 'sexualisation of minors'],
    child_safety: ['child grooming'],
    non_consensual_intimate: ['non-consensual intimate'],
    violent_extremism: ['terrorism', 'violent extremism'],
    hate_harassment: ['harasses, threatens'],
    malware_phishing: ['malware, phishing'],
    copyright_or_trademark: ['copyright or trademark'],
  };

  for (const [category, needles] of Object.entries(expectations)) {
    assert.ok(CATEGORIES.includes(category), `no category for ${category}`);
    assert.ok(needles.some((n) => policy.includes(n)),
      `the policy never mentions "${needles.join('" or "')}" for ${category}`);
  }
});

test('every prohibited item in section 1 has a category', () => {
  const fs = require('fs');
  const path = require('path');
  const policy = fs.readFileSync(
    path.join(__dirname, '..', 'legal', 'CONTENT_POLICY.md'), 'utf8'
  );
  const section1 = policy.slice(
    policy.indexOf('## 1. Prohibited content'),
    policy.indexOf('## 2. Age-gated content'),
  );

  // One bullet per prohibited item. Each must be reachable through a category.
  const bullets = section1.split('\n').filter((l) => /^\s*-\s/.test(l));
  assert.ok(bullets.length >= 6, `expected the prohibited list, found ${bullets.length} bullets`);
  assert.equal(bullets.length, Object.keys({
    sexual_minors: 1, child_safety: 1, non_consensual_intimate: 1,
    violent_extremism: 1, hate_harassment: 1, malware_phishing: 1,
    copyright_or_trademark: 1,
  }).length,
  'the prohibited list and the category list have drifted apart');
});

test('the policy documents the endpoint and separates it from DMCA', () => {
  const fs = require('fs');
  const path = require('path');
  const policy = fs.readFileSync(
    path.join(__dirname, '..', 'legal', 'CONTENT_POLICY.md'), 'utf8'
  );

  assert.match(policy, /POST \/api\/reports/, 'the policy does not document the endpoint');
  assert.match(policy, /POST \/api\/dmca/, 'the policy does not point copyright claims elsewhere');
  assert.ok(!/needs to\s*\n?\s*be built/i.test(policy),
    'the policy still says the reporting endpoint needs building');
  for (const c of CATEGORIES) {
    assert.ok(policy.includes(`\`${c}\``), `category ${c} is undocumented in the policy`);
  }
});
