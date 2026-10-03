'use strict';

/**
 * Configuration preflight.
 *
 * These assertions are the point of the module: a deployment that is missing
 * SMTP comes up looking perfectly healthy, every test passes, and password
 * reset silently does nothing. Each case below is a real way to ship that.
 */

process.env.DATABASE_URL ||= 'postgres://stub/stub';
process.env.DATABASE_SSL = 'false';
process.env.JWT_SECRET ||= 'test-secret';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const preflight = require('../src/config/preflight');

/** A configuration that should produce no findings at all. */
const HEALTHY = {
  nodeEnv: 'production',
  jwtSecret: 'a'.repeat(64),
  databaseUrl: 'postgresql://user:pw@db.example.com:5432/vorth',
  mailTransport: 'smtp',
  smtpHost: 'smtp.example.com',
  smtpUser: 'u',
  smtpPass: 'p',
  publicUrl: 'https://vorth.example',
  requireEmailVerification: true,
  storageDriver: 's3',
  s3Bucket: 'vorth',
  s3AccessKeyId: 'k',
  s3SecretAccessKey: 's',
  s3SignedUrls: true,
  s3PublicBaseUrl: '',
  rateLimitStore: 'postgres',
  trustProxy: true,
  clientOrigins: ['https://vorth.example'],
  secureCookies: true,
  dmcaContactEmail: 'dmca@vorth.example',
};

function findingsFor(overrides) {
  return preflight.inspect({ ...HEALTHY, ...overrides });
}

function codes(list, level) {
  return list.filter((f) => f.level === level).map((f) => f.code);
}

/** Asserts nothing a human must act on. */
function assertNoActionable(findings, label) {
  assert.deepEqual(codes(findings, 'error'), [], `${label}: unexpected errors`);
  assert.deepEqual(codes(findings, 'warn'), [], `${label}: unexpected warnings`);
}

test('a complete production configuration has nothing to act on', () => {
  assertNoActionable(findingsFor({}), 'healthy config');
});

test('a default production configuration is reported, not silently accepted', () => {
  // This is the shape of a deployment that was never configured: everything
  // falls back to a default and nothing fails at boot.
  const findings = preflight.inspect({
    nodeEnv: 'production',
    jwtSecret: undefined,
    databaseUrl: undefined,
    mailTransport: 'console',
    smtpHost: '', smtpUser: '', smtpPass: '',
    publicUrl: '',
    storageDriver: 'local',
    rateLimitStore: 'memory',
    trustProxy: false,
    clientOrigins: [],
    secureCookies: false,
    dmcaContactEmail: 'dmca@example.com',
  });
  const errorCodes = codes(findings, 'error');
  for (const expected of ['jwt.missing', 'db.missing', 'mail.console', 'storage.local', 'cookie.insecure']) {
    assert.ok(errorCodes.includes(expected), `expected ${expected}, got ${errorCodes.join(', ')}`);
  }
});

test('MAIL_TRANSPORT=console is an error in production, a warning otherwise', () => {
  assert.ok(codes(findingsFor({ mailTransport: 'console' }), 'error').includes('mail.console'));

  const dev = preflight.inspect({
    ...HEALTHY, nodeEnv: 'development', mailTransport: 'console', smtpHost: '', smtpUser: '', smtpPass: '',
  });
  assert.ok(codes(dev, 'warn').includes('mail.console'));
  assert.ok(!codes(dev, 'error').includes('mail.console'));
});

test('smtp without credentials, or without PUBLIC_URL, is an error', () => {
  assert.ok(codes(findingsFor({ smtpHost: '' }), 'error').includes('mail.incomplete'));
  assert.ok(codes(findingsFor({ smtpUser: '' }), 'error').includes('mail.incomplete'));
  assert.ok(codes(findingsFor({ smtpPass: '' }), 'error').includes('mail.incomplete'));
  assert.ok(codes(findingsFor({ publicUrl: '' }), 'error').includes('mail.no-public-url'));
});

test('requiring verification with mail disabled is reported as impossible', () => {
  const found = findingsFor({ mailTransport: 'disabled', requireEmailVerification: true });
  assert.ok(codes(found, 'error').includes('mail.verification-without-mail'));
});

test('STORAGE_DRIVER=local is an error in production: redeploys lose uploads', () => {
  assert.ok(codes(findingsFor({ storageDriver: 'local' }), 'error').includes('storage.local'));
});

test('s3 without credentials is reported', () => {
  assert.ok(codes(findingsFor({ s3AccessKeyId: '' }), 'error').includes('storage.s3-incomplete'));
});

test('s3 that nothing can read is reported', () => {
  const found = findingsFor({ s3PublicBaseUrl: '', s3SignedUrls: false });
  assert.ok(codes(found, 'error').includes('storage.s3-unreadable'));

  // Either one on its own is fine.
  assertNoActionable(findingsFor({ s3PublicBaseUrl: '', s3SignedUrls: true }), 'signed URLs');
  assertNoActionable(
    findingsFor({ s3PublicBaseUrl: 'https://cdn.example.com', s3SignedUrls: false }),
    'public bucket'
  );
});

test('the in-memory rate limit store is flagged for production', () => {
  const found = findingsFor({ rateLimitStore: 'memory' });
  assert.ok(codes(found, 'warn').includes('ratelimit.memory'));
  assertNoActionable(findingsFor({ rateLimitStore: 'postgres' }), 'postgres store');
});

test('a weak or placeholder JWT secret is refused', () => {
  assert.ok(codes(findingsFor({ jwtSecret: 'short' }), 'error').includes('jwt.weak'));
  // A placeholder is reported as a placeholder, not merely as "too short":
  // the actionable message is the specific one.
  assert.ok(codes(findingsFor({ jwtSecret: 'change-me' }), 'error').includes('jwt.obvious'));
  assert.ok(!codes(findingsFor({ jwtSecret: 'change-me' }), 'error').includes('jwt.weak'));
  assert.ok(codes(findingsFor({ jwtSecret: 'replace-me-with-something' }), 'error')
    .includes('jwt.obvious'));
  assert.ok(codes(findingsFor({ jwtSecret: 'my-super-secret-password' }), 'error').includes('jwt.obvious'));
  assert.ok(codes(findingsFor({ jwtSecret: undefined }), 'error').includes('jwt.missing'));
  // A long random value in development is not worth a warning.
  assertNoActionable(preflight.inspect({ ...HEALTHY, nodeEnv: 'development', jwtSecret: 'short' }),
    'short secret in development');
});

test('insecure cookies in production are refused', () => {
  assert.ok(codes(findingsFor({ secureCookies: false }), 'error').includes('cookie.insecure'));
});

test('TRUST_PROXY is informational, not a warning', () => {
  // TRUST_PROXY=true is the *correct* setting behind Render, Railway, nginx.
  // Warning about it would be a false positive on a correct deployment, and a
  // report full of false positives is one people learn to ignore.
  const trusted = findingsFor({ trustProxy: true });
  assert.ok(codes(trusted, 'info').includes('proxy.trust'));
  assertNoActionable(trusted, 'behind a proxy');

  assert.deepEqual(codes(findingsFor({ trustProxy: false }), 'info'), []);
  // And the boot log does not show it.
  assert.ok(!preflight.report(trusted).includes('proxy.trust'));
  assert.ok(preflight.report(trusted, { includeInfo: true }).includes('proxy.trust'));
});

test('the placeholder DMCA address is flagged in production', () => {
  assert.ok(codes(findingsFor({ dmcaContactEmail: 'dmca@example.com' }), 'warn')
    .includes('legal.dmca-placeholder'));
  assert.ok(!codes(findingsFor({ dmcaContactEmail: 'abuse@vorth.example' }), 'warn')
    .includes('legal.dmca-placeholder'));
});

test('every finding carries an actionable fix', () => {
  const findings = preflight.inspect({
    nodeEnv: 'production', jwtSecret: undefined, databaseUrl: undefined,
    mailTransport: 'console', smtpHost: '', smtpUser: '', smtpPass: '', publicUrl: '',
    storageDriver: 'local', rateLimitStore: 'memory', clientOrigins: [],
    secureCookies: false, dmcaContactEmail: 'dmca@example.com',
    requireEmailVerification: true, trustProxy: true,
  });
  assert.ok(findings.length >= 8);
  for (const f of findings) {
    assert.ok(f.code && f.message && f.fix, `incomplete finding: ${JSON.stringify(f)}`);
    assert.ok(f.fix.length > 20, `fix is not actionable: ${f.code}`);
  }
});

test('VORTH_STRICT_CONFIG turns errors into a refusal to boot', () => {
  const findings = findingsFor({ mailTransport: 'console' });
  // Warnings alone never block.
  assert.doesNotThrow(() => preflight.assertAcceptable(findingsFor({ rateLimitStore: 'memory' })));

  const saved = process.env.VORTH_STRICT_CONFIG;
  try {
    process.env.VORTH_STRICT_CONFIG = '1';
    assert.throws(() => preflight.assertAcceptable(findings), /Refusing to start/);
    assert.throws(() => preflight.assertAcceptable(findings), /mail\.console/);
  } finally {
    if (saved === undefined) delete process.env.VORTH_STRICT_CONFIG;
    else process.env.VORTH_STRICT_CONFIG = saved;
  }
  // Not strict: reported but survivable.
  assert.doesNotThrow(() => preflight.assertAcceptable(findings));
});

test('the report is readable', () => {
  const text = preflight.report(findingsFor({ mailTransport: 'console' }));
  assert.match(text, /\[ERROR\] mail\.console/);
  assert.match(text, /fix: Set MAIL_TRANSPORT=smtp/);
  assert.equal(preflight.report([]), 'configuration looks sane');
});