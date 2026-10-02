'use strict';

/**
 * Configuration sanity checks, run at boot.
 *
 * Every item here corresponds to a way the application can come up looking
 * healthy while quietly not working:
 *
 *   - MAIL_TRANSPORT=console means password-reset and email-verification links
 *     are printed to the log and delivered to nobody. Both features work in
 *     tests, so nothing fails; they just do not function in production.
 *   - STORAGE_DRIVER=local on a platform with an ephemeral filesystem means
 *     every cover and comic page is lost on the next deploy.
 *   - RATE_LIMIT_STORE=memory means the limiter resets on every deploy and is
 *     per-instance, so it protects nothing behind more than one process.
 *   - A missing PUBLIC_URL puts a relative link in every email, so the
 *     recipient cannot complete verification or a reset.
 *   - TRUST_PROXY off behind a proxy collapses every client onto one IP in the
 *     limiter, which is a self-inflicted denial of service.
 *
 * Problems are reported rather than thrown, because most of them are
 * survivable and a hard failure would block a deploy over a warning. Set
 * VORTH_STRICT_CONFIG=1 to turn warnings into a refusal to boot.
 */

const env = require('./env');

/**
 * @returns {{level: 'error'|'warn'|'info', code: string, message: string, fix: string}[]}
 */
function inspect(env_ = env) {
  const out = [];
  const add = (level, code, message, fix) => out.push({ level, code, message, fix });

  const production = env_.nodeEnv === 'production';

  /* ---------------------------------------------------------------- *
   * Secrets
   * ---------------------------------------------------------------- */
  if (!env_.jwtSecret) {
    add('error', 'jwt.missing',
      'JWT_SECRET is not set. Every token is signed with an empty key, so anyone can mint an admin token.',
      'Generate one: node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"');
  } else if (/(secret|password|change[-_]?me|replace[-_]?me|placeholder|your[-_]?key|example)/i
    .test(env_.jwtSecret)) {
    // Checked before length, so the message names the actual problem rather
    // than just reporting that a placeholder is also too short.
    add('error', 'jwt.obvious',
      'JWT_SECRET looks like a placeholder.',
      'Replace it with a random value before serving real accounts: '
      + 'node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"');
  } else if (production && env_.jwtSecret.length < 32) {
    add('error', 'jwt.weak',
      `JWT_SECRET is only ${env_.jwtSecret.length} characters.`,
      'Use at least 32 bytes of randomness.');
  }

  if (!env_.databaseUrl) {
    add('error', 'db.missing', 'DATABASE_URL is not set.', 'Point it at your PostgreSQL instance.');
  }

  /* ---------------------------------------------------------------- *
   * Mail: the difference between a feature that works and one that does not
   * ---------------------------------------------------------------- */
  if (env_.mailTransport === 'console') {
    if (production) {
      add('error', 'mail.console',
        'MAIL_TRANSPORT is "console" in production. Password reset and email verification links are '
        + 'written to the log and delivered to nobody, so both features are dead.',
        'Set MAIL_TRANSPORT=smtp with SMTP_HOST, SMTP_USER, SMTP_PASS and MAIL_FROM. '
        + 'Or MAIL_TRANSPORT=disabled if you genuinely do not offer them.');
    } else {
      add('warn', 'mail.console',
        'MAIL_TRANSPORT is "console": reset and verification links are printed to stdout instead of sent.',
        'Set MAIL_TRANSPORT=smtp for a real deployment.');
    }
  }
  if (env_.mailTransport === 'smtp') {
    const missing = ['smtpHost', 'smtpUser', 'smtpPass'].filter((k) => !env_[k]);
    if (missing.length) {
      add('error', 'mail.incomplete',
        `MAIL_TRANSPORT=smtp but ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} empty. `
        + 'Every send will fail.',
        'Fill them in, or set MAIL_TRANSPORT=console to see the messages locally.');
    }
    if (!env_.publicUrl) {
      add('error', 'mail.no-public-url',
        'MAIL_TRANSPORT=smtp but PUBLIC_URL is empty, so every email contains a relative link that '
        + 'cannot be clicked.',
        'Set PUBLIC_URL to the site origin, e.g. https://vorth.example');
    }
  }
  if (env_.requireEmailVerification && env_.mailTransport === 'disabled') {
    add('error', 'mail.verification-without-mail',
      'REQUIRE_EMAIL_VERIFICATION is on but MAIL_TRANSPORT is disabled, so nobody can ever verify.',
      'Set MAIL_TRANSPORT=smtp, or turn REQUIRE_EMAIL_VERIFICATION off.');
  }

  /* ---------------------------------------------------------------- *
   * Uploads
   * ---------------------------------------------------------------- */
  if (env_.storageDriver === 'local') {
    if (production) {
      add('error', 'storage.local',
        'STORAGE_DRIVER is "local" in production. On any platform with an ephemeral filesystem '
        + '(Render, Heroku, most container hosts) every cover and comic page is lost on redeploy.',
        'Set STORAGE_DRIVER=s3 with S3_BUCKET and credentials, or S3_PUBLIC_BASE_URL for a '
        + 'world-readable bucket.');
    } else {
      add('warn', 'storage.local', 'STORAGE_DRIVER is "local": uploads live on this disk only.',
        'Fine for development. Set STORAGE_DRIVER=s3 before running more than one instance.');
    }
  }
  if (env_.storageDriver === 's3') {
    const missing = ['s3Bucket', 's3AccessKeyId', 's3SecretAccessKey'].filter((k) => !env_[k]);
    if (missing.length) {
      add('error', 'storage.s3-incomplete',
        `STORAGE_DRIVER=s3 but ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} empty. `
        + 'Every upload will throw.',
        'Fill them in, or set STORAGE_DRIVER=local.');
    }
    if (!env_.s3PublicBaseUrl && !env_.s3SignedUrls) {
      add('error', 'storage.s3-unreadable',
        'STORAGE_DRIVER=s3 with neither S3_PUBLIC_BASE_URL nor signed URLs enabled, so stored '
        + 'objects cannot be fetched.',
        'Set S3_PUBLIC_BASE_URL for a public bucket, or remove S3_SIGNED_URLS=false.');
    }
  }

  /* ---------------------------------------------------------------- *
   * Rate limiting
   * ---------------------------------------------------------------- */
  if (production && env_.rateLimitStore === 'memory') {
    add('warn', 'ratelimit.memory',
      'RATE_LIMIT_STORE is the default "memory": counters reset on every deploy and are not shared '
      + 'between instances.',
      'Set RATE_LIMIT_STORE=postgres if you run more than one instance.');
  }

  /* ---------------------------------------------------------------- *
   * Proxy and origins
   * ---------------------------------------------------------------- */
  if (production && env_.trustProxy) {
    // Informational only. TRUST_PROXY=true is correct on Render, Railway, Fly,
    // Heroku and anything else behind a proxy - and it is the *safe* choice
    // there, because otherwise every client collapses onto one address in the
    // rate limiter. The danger is the opposite case: true with no proxy in
    // front, where a client can spoof X-Forwarded-For and walk through the
    // limiter. That is not detectable from configuration alone, so warning
    // about the correct setting would just teach people to ignore this report.
    add('info', 'proxy.trust',
      'TRUST_PROXY is on, so req.ip is taken from X-Forwarded-For. That is correct behind a proxy '
      + 'and unsafe without one.',
      'Keep it on if a proxy (Render, Railway, nginx) really is in front of the app.');
  }
  if (!env_.clientOrigins.length) {
    if (production) {
      add('warn', 'cors.no-origins',
        'CLIENT_ORIGINS is empty, so no cross-origin frontend is allowed. If the API and the page '
        + 'are served from the same origin this is correct and can be ignored.',
        'Otherwise set CLIENT_ORIGINS to the comma-separated list of allowed origins.');
    }
  }

  /* ---------------------------------------------------------------- *
   * Cookies
   * ---------------------------------------------------------------- */
  if (production && !env_.secureCookies) {
    add('error', 'cookie.insecure',
      'SECURE_COOKIES is false in production, so the refresh token can travel over plain HTTP.',
      'Remove SECURE_COOKIES=false, or terminate TLS in front of the app and keep cookies secure.');
  }

  /* ---------------------------------------------------------------- *
   * Legal
   * ---------------------------------------------------------------- */
  if (production && env_.dmcaContactEmail.endsWith('@example.com')) {
    add('warn', 'legal.dmca-placeholder',
      `DMCA_CONTACT_EMAIL is still the placeholder "${env_.dmcaContactEmail}".`,
      'Set a monitored address, and register a DMCA designated agent with the U.S. Copyright '
      + 'Office before accepting takedown requests.');
  }

  return out;
}

/**
 * Human-readable report for the boot log.
 *
 * Informational findings are omitted unless asked for, so the boot log only
 * shows things a human should actually do something about.
 */
function report(findings = inspect(), { includeInfo = false } = {}) {
  const shown = includeInfo ? findings : findings.filter((f) => f.level !== 'info');
  if (!shown.length) return 'configuration looks sane';
  const lines = [];
  for (const f of shown) {
    lines.push(`  [${f.level.toUpperCase()}] ${f.code}: ${f.message}`);
    lines.push(`      fix: ${f.fix}`);
  }
  return lines.join('\n');
}

/** Throws when there is anything at error level and VORTH_STRICT_CONFIG is set. */
function assertAcceptable(findings = inspect()) {
  const blocking = findings.filter((f) => f.level === 'error');
  if (!blocking.length) return findings;
  if (process.env.VORTH_STRICT_CONFIG === '1' || process.env.VORTH_STRICT_CONFIG === 'true') {
    const error = new Error(
      `Refusing to start: ${blocking.length} configuration error(s).\n${report(findings)}`
    );
    error.findings = findings;
    throw error;
  }
  return findings;
}

module.exports = { inspect, report, assertAcceptable };