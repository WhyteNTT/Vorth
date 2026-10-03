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
  assert.equal(doc.services.length, 1);
  assert.equal(service.type, 'web');
});

test('the build targets the backend and installs production dependencies only', () => {
  assert.equal(service.rootDir, 'vorth-backend',
    'without rootDir the build runs in the monorepo root and finds no package.json');
  assert.match(service.buildCommand, /npm ci/);
  assert.match(service.buildCommand, /--omit=dev/,
    'dev dependencies include Playwright and the AWS SDK; they are not needed at runtime');
  assert.equal(service.healthCheckPath, '/api/health');
});

test('DATABASE_URL is wired to the database the blueprint declares', () => {
  const link = env.DATABASE_URL.fromDatabase;
  assert.ok(link, 'DATABASE_URL must be linked, not left as sync:false — otherwise a '
    + 'blueprint deploy provisions a service with no database and no warning');
  assert.equal(link.property, 'connectionString');
  const declared = (doc.databases || []).map((d) => d.name);
  assert.ok(declared.includes(link.name),
    `DATABASE_URL points at "${link.name}", which is not declared (have: ${declared.join(', ')})`);
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

test('the database is not reachable from the internet', () => {
  for (const d of doc.databases) {
    assert.deepEqual(d.ipAllowList, [], `${d.name} has a non-empty ipAllowList`);
  }
});