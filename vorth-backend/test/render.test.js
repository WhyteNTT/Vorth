'use strict';

/**
 * The Render blueprint.
 *
 * A blueprint is configuration nobody exercises until the moment they deploy,
 * so the failure modes are silent and late. The worst of them was real here:
 * DATABASE_URL was `sync: false` while the blueprint declared a database, so a
 * deploy provisioned a running service that had no database to talk to and
 * nothing said so until the first request.
 *
 * These assertions are about intent, not formatting.
 */

process.env.DATABASE_URL ||= 'postgres://stub/stub';
process.env.DATABASE_SSL = 'false';
process.env.JWT_SECRET ||= 'test-secret';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const YAML = require('yaml');

const BLUEPRINT = path.join(__dirname, '..', '..', 'render.yaml');
const raw = fs.readFileSync(BLUEPRINT, 'utf8');
const doc = YAML.parse(raw);

const service = doc.services[0];
const env = Object.fromEntries((service.envVars || []).map((v) => [v.key, v]));

test('the blueprint parses and declares one web service', () => {
  assert.ok(doc.services, 'no services block');
  assert.equal(doc.services.length, 1,
    `expected only a web service, got ${doc.services.map((s) => s.type).join(', ')}`);
  assert.equal(service.type, 'web');
});

test('no cron job is declared, because Render charges for them', () => {
  /*
   * Added after a cron service was committed and then removed: Render gates cron
   * jobs behind a paid plan, so declaring one fails the blueprint apply or starts a
   * bill. The free tier gets its keep-alive from an external uptime monitor
   * instead, which is documented where an operator would look.
   *
   * Asserted as absent rather than merely undocumented - a blueprint that quietly
   * introduces a bill is not something to leave to review.
   */
  const cron = (doc.services || []).find((s) => s.type === 'cron');
  assert.equal(cron, undefined,
    `cron jobs require a paid plan on Render; found ${cron && cron.name}`);
  assert.match(raw, /NO CRON SERVICE IS DECLARED HERE/i,
    'the reason should stay where an operator reading the blueprint will see it');
  // And the replacement should be named, or the reader is left with a problem and
  // no instruction.
  assert.match(raw, /keep-warm/i,
    'the free alternative (an uptime monitor against /api/keep-warm) should be documented here');
});

test('the web service runs on the free plan, and says what that costs', () => {
  /*
   * Pinned because it is a deliberate choice with a real trade-off, not an
   * oversight: a free instance spins down after inactivity.
   *
   * That is acceptable here only because the frontend is deployed separately and
   * serves the page instantly - what a reader can notice is a slow first API
   * call, not a blank page. If someone reverts this to 'starter' the tests should
   * not merely fail on a string; the comment above `plan` is what tells the next
   * person why, so assert it is still there.
   */
  assert.equal(service.plan, 'free',
    'the plan changed; if this is deliberate, update this test and the comment together');
  // Sliced from the start of the service block, not from `plan:` - the explanation
  // is written *above* the key, so slicing at the key would miss it.
  const planComment = raw.slice(raw.indexOf('- type: web'), raw.indexOf('rootDir:'));
  assert.match(planComment, /spins down|sleep|wake/i,
    'the plan comment no longer explains the trade-off, which is the only reason this is safe');
});

test('no database is declared, because production is external', () => {
  /*
   * Was: "the database is on a plan that does not expire" - asserting a Render
   * Postgres exists on a paid plan. Inverted when the block was removed, because
   * the database is Neon and supplied by hand.
   *
   * The old assertion would have failed on the correct file, and the new one would
   * have failed on the old one. Either way it now states the fact that matters:
   * applying this blueprint must not create a database.
   */
  assert.equal(doc.databases, undefined,
    'this blueprint declares no database; a re-applied block would provision a second, empty one for $7/month');
  assert.match(raw, /NEON/i,
    'the reason - an external database - should be recorded where an operator reads it');
});

test('the build targets the backend and installs production dependencies only', () => {
  assert.equal(service.rootDir, 'vorth-backend',
    'without rootDir the build runs in the monorepo root and finds no package.json');
  assert.match(service.buildCommand, /npm ci/);
  assert.match(service.buildCommand, /--omit=dev/,
    'dev dependencies include Playwright and the AWS SDK; they are not needed at runtime');
  assert.equal(service.healthCheckPath, '/api/health');
});

test('DATABASE_URL is the operator\'s to supply, and is not linked to a database this blueprint provisions', () => {
  /*
   * Reversed deliberately. This used to assert the opposite - that DATABASE_URL was
   * linked from a declared `databases:` block - and that assertion was right for a
   * setup nobody ended up using.
   *
   * Production runs on Neon, supplied by hand. The block was never applied, so a
   * blueprint deploy would have provisioned a second, empty, $7/month database
   * that nothing connected to, while the file claimed the two were linked. That is
   * the worst kind of drift: invisible until a bill arrives.
   *
   * So now the failure this guards against is the link coming back without the
   * database behind it, which provisions a service with no database and no
   * warning.
   */
  assert.equal(env.DATABASE_URL.fromDatabase, undefined,
    'DATABASE_URL is a hand-set Neon string; linking it would require a `databases:` block that does not exist');

  const declared = (doc.databases || []).map((d) => d.name);
  assert.equal(declared.length, 0,
    `this blueprint provisions no database, but declares: ${declared.join(', ')}`);
  assert.ok(env.DATABASE_URL.sync === false,
    'DATABASE_URL must be sync:false so re-applying the blueprint leaves the live value alone '
    + 'instead of blanking a production connection string');

  // Any link at all is a bug now, not just this one key.
  const linked = Object.entries(env).filter(([, v]) => v.fromDatabase).map(([k]) => k);
  assert.deepEqual(linked, [], `nothing should be linked from a database now: ${linked.join(', ')}`);
});

test('KEEP_WARM_TOKEN is declared, so the heartbeat can be checked in production', () => {
  /*
   * Added because the endpoint is useless without it: unset, it refuses to answer
   * rather than reporting the heartbeat's state to anyone who asks. Declared as
   * sync:false because the value is a secret the operator generates.
   */
  assert.ok(env.KEEP_WARM_TOKEN, 'KEEP_WARM_TOKEN is not declared');
  assert.equal(env.KEEP_WARM_TOKEN.sync, false,
    'KEEP_WARM_TOKEN must be sync:false; a committed value would be a published secret');
});

test('the blueprint does not promise a database it does not provision', () => {
  // The header comment and the body must agree. This drifted once: the header said
  // the database was declared and linked, and it was neither.
  const header = raw.slice(0, raw.indexOf('services:'));
  assert.doesNotMatch(header, /database is declared below and linked/i,
    'the header still claims a linked database');
  assert.match(header, /does not provision one/i,
    'the header should say plainly that no database is provisioned');
  assert.match(raw, /NO `databases:` BLOCK, DELIBERATELY/i,
    'the reason the block is absent should stay recorded in the file');
});

test('PORT is left to Render, which injects it', () => {
  assert.ok(!env.PORT, 'hardcoding PORT is wrong: Render assigns it and the service must bind it');
});

test('settings preflight rejects in production are declared, not defaulted', () => {
  // Each of these is an error-level finding in production. Leaving one out of
  // the blueprint means the operator never learns it is required.
  for (const key of ['CLIENT_ORIGINS', 'PUBLIC_URL', 'MAIL_TRANSPORT', 'STORAGE_DRIVER']) {
    assert.ok(env[key], `${key} is not declared at all`);
  }
});

test('mail and storage are not pinned into a state where the feature is dead', () => {
  assert.equal(env.MAIL_TRANSPORT.sync, false,
    "MAIL_TRANSPORT=console ships password reset that reaches nobody");
  assert.equal(env.STORAGE_DRIVER.sync, false,
    "STORAGE_DRIVER=local loses every upload on redeploy, because Render's disk is ephemeral");
});

test('the security-relevant defaults are right for production', () => {
  assert.equal(env.SECURE_COOKIES.value, 'true');
  assert.equal(env.REFRESH_COOKIE.value, 'true');
  assert.equal(env.TRUST_PROXY.value, 'true', 'correct behind Render\'s proxy');
  assert.equal(env.RATE_LIMIT_STORE.value, 'postgres',
    'the in-memory store resets on every deploy and is per-instance');
  assert.equal(env.JWT_SECRET.generateValue, true);
  // Verification is off until SMTP works; on with no mail means nobody can
  // ever verify and every account is locked out.
  assert.equal(env.REQUIRE_EMAIL_VERIFICATION.value, 'false');
});

test('the strict config gate is documented and defaults off for a first deploy', () => {
  // A first deploy cannot yet have working mail or object storage, so the gate
  // starts off and the service reports what is missing in its log. Turning it on
  // is a deliberate act before going public - see the comment in the blueprint.
  assert.equal(env.VORTH_STRICT_CONFIG.value, '0');
  assert.match(raw, /Set it to '1' before serving the public/,
    'the blueprint must say when to turn the gate on');
  assert.match(raw, /crash loop/,
    'the reason for the default should be stated where an operator will read it');
});

test('nothing secret is committed', () => {
  for (const needle of ['AKIA', 'wJalr', 'postgres://', 'BEGIN RSA', 'eyJhbGci']) {
    assert.ok(!raw.includes(needle), `the blueprint contains what looks like a secret: ${needle}`);
  }
  // Every value is either a literal this test has asserted on, or operator-set.
  for (const [key, value] of Object.entries(env)) {
    const isOperatorSet = value.sync === false;
    const isGenerated = value.generateValue === true;
    const isLinked = Boolean(value.fromDatabase);
    assert.ok(isOperatorSet || isGenerated || isLinked || value.value !== undefined,
      `${key} has neither a value nor a way to supply one`);
  }
});

test('if a database is ever declared here, it must not be reachable from the internet', () => {
  /*
   * Now a conditional rather than a loop over a known database.
   *
   * This assertion was passing vacuously once the block was removed - a loop over an
   * empty array checks nothing and looks identical to a real pass. It is written so
   * that it still says something if a block is ever added back, which is the only
   * time it matters.
   */
  const declared = doc.databases || [];
  for (const d of declared) {
    assert.deepEqual(d.ipAllowList, [],
      `${d.name} has a non-empty ipAllowList: the database would be reachable from the internet`);
  }
  // And say so out loud, so an empty pass cannot be mistaken for a verified one.
  assert.ok(declared.length === 0 || declared.every((d) => Array.isArray(d.ipAllowList)),
    'every declared database must state its ipAllowList explicitly');
});