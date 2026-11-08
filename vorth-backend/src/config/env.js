const dotenv = require('dotenv');
dotenv.config();

const REQUIRED_VARS = ['DATABASE_URL', 'JWT_SECRET'];

function requireEnv() {
  /*
   * A variable set to whitespace counts as missing.
   *
   * `!process.env[key]` treats `'   '` as configured, and a blank field is exactly
   * what a platform's environment-variable UI and a hand-edited compose file
   * produce. That value then reaches the driver, which rejects it as a malformed
   * connection string - so the server boots, and the error names the wrong thing.
   * The value itself is not trimmed, so a secret with meaningful whitespace is
   * unaffected; only the emptiness check looks at the trimmed form.
   */
  const missing = REQUIRED_VARS.filter((key) => !String(process.env[key] ?? '').trim());
  if (missing.length) {
    console.error(
      `[config] Missing required environment variable(s): ${missing.join(', ')}\n` +
      `Copy .env.example to .env and fill these in before starting the server.`
    );
    process.exit(1);
  }
}

requireEnv();

module.exports = {
  nodeEnv: process.env.NODE_ENV || 'development',
  // Render (and most hosts) terminate TLS and forward the real protocol/client
  // in headers; without this req.ip is the proxy and every rate limiter sees
  // one shared address.
  trustProxy: process.env.TRUST_PROXY === 'true' || process.env.TRUST_PROXY === '1',
  port: parseInt(process.env.PORT, 10) || 5000,
  databaseUrl: process.env.DATABASE_URL,
  databaseSsl: process.env.DATABASE_SSL !== 'false',
  jwtSecret: process.env.JWT_SECRET,
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '7d',
  clientOrigins: (process.env.CLIENT_ORIGINS || '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean),
  maxUploadMb: parseInt(process.env.MAX_UPLOAD_MB, 10) || 8,
  rateLimitWindowMinutes: parseInt(process.env.RATE_LIMIT_WINDOW_MINUTES, 10) || 15,
  rateLimitMaxRequests: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS, 10) || 300,
  // Uploads are the most expensive thing this service accepts. One request can
  // carry 60 page images of up to MAX_UPLOAD_MB each, so at the general limit of
  // 300 requests per window a single IP could write 144 GB in 15 minutes - and
  // with STORAGE_DRIVER=local there is no disk ceiling and no per-user storage
  // accounting to stop a single account filling it. Auth had its own limit; this
  // one had the loosest.
  uploadRateLimitMaxRequests: parseInt(process.env.UPLOAD_RATE_LIMIT_MAX_REQUESTS, 10) || 10,
  authRateLimitMaxRequests: parseInt(process.env.AUTH_RATE_LIMIT_MAX_REQUESTS, 10) || 20,
  // 'postgres' shares counters across instances and survives a deploy.
  // 'memory' is the zero-dependency default for a single process.
  rateLimitStore: process.env.RATE_LIMIT_STORE === 'postgres' ? 'postgres' : 'memory',
  minimumUserAge: parseInt(process.env.MINIMUM_USER_AGE, 10) || 13,
  supportContactEmail: process.env.SUPPORT_CONTACT_EMAIL || 'support@example.com',

  // ---- schema safety ----
  // Connect without applying the schema, for when it is already known good.
  // Applying schema is not safe from several processes at once, and CREATE INDEX
  // takes a lock on its table even when it creates nothing. Not a deployment
  // mechanism - a real instance must be able to bring its own schema up.
  skipSchema: process.env.VORTH_SKIP_SCHEMA === '1' || process.env.VORTH_SKIP_SCHEMA === 'true',
  allowSchemaOnProduction: process.env.VORTH_ALLOW_SCHEMA_ON_PRODUCTION === '1'
    || process.env.VORTH_ALLOW_SCHEMA_ON_PRODUCTION === 'true',

  // ---- sessions ----
  refreshTokenDays: parseInt(process.env.REFRESH_TOKEN_DAYS, 10) || 30,
  refreshCookieName: process.env.REFRESH_COOKIE_NAME || 'vorth_refresh',
  // When false, refresh tokens are only returned in the JSON body. Useful for
  // clients that cannot hold cookies (native apps).
  refreshCookieEnabled: process.env.REFRESH_COOKIE !== 'false',
  secureCookies: process.env.SECURE_COOKIES !== 'false',

  // ---- email verification / password reset ----
  requireEmailVerification: process.env.REQUIRE_EMAIL_VERIFICATION === 'true',
  emailVerificationHours: parseInt(process.env.EMAIL_VERIFICATION_HOURS, 10) || 24,
  passwordResetHours: parseInt(process.env.PASSWORD_RESET_HOURS, 10) || 1,
  publicUrl: (process.env.PUBLIC_URL || '').replace(/\/$/, ''),
  // Guards GET /api/keep-warm/status. Optional by design: without it that endpoint
  // refuses to answer rather than reporting the heartbeat's state to anyone who
  // asks, so leaving it unset is safe rather than dangerous.
  keepWarmToken: process.env.KEEP_WARM_TOKEN || '',

  // ---- mail transport ----
  // 'console' logs the message instead of sending it (development default).
  // 'smtp' sends for real; see src/services/mailer.js.
  // 'disabled' turns mail off entirely (verification cannot work).
  //
  // An unset variable falls back to 'console' deliberately — that is the
  // development default. But a value that is *set* and not one of the three
  // allowed options is almost certainly a typo (e.g. 'smp' instead of 'smtp'),
  // and silently falling back to 'console' would mask it: password reset would
  // appear to work in tests but deliver nothing in production. So a bad value
  // is preserved as-is and surfaced by preflight as an error, rather than
  // swallowed.
  mailTransport: (() => {
    const raw = process.env.MAIL_TRANSPORT;
    if (!raw) return 'console';
    if (['console', 'smtp', 'disabled'].includes(raw)) return raw;
    return raw; // pass through so preflight can report it as unrecognized
  })(),
  mailFrom: process.env.MAIL_FROM || 'no-reply@vorth.example',
  smtpHost: process.env.SMTP_HOST || '',
  smtpPort: parseInt(process.env.SMTP_PORT, 10) || 587,
  smtpUser: process.env.SMTP_USER || '',
  smtpPass: process.env.SMTP_PASS || '',
  smtpSecure: process.env.SMTP_SECURE === 'true',

  // ---- object storage for uploads ----
  // 'local' writes to uploads/; 's3' targets any S3-compatible service
  // (AWS S3, Cloudflare R2, MinIO, Backblaze B2).
  //
  // Same reasoning as mailTransport: unset defaults to 'local' for
  // development, but a set value that isn't 's3' or 'local' is a typo and
  // is passed through so preflight can flag it rather than silently
  // treating it as 'local'.
  storageDriver: (() => {
    const raw = process.env.STORAGE_DRIVER;
    if (!raw) return 'local';
    if (raw === 's3' || raw === 'local') return raw;
    return raw; // pass through so preflight can report it as unrecognized
  })(),
  s3Bucket: process.env.S3_BUCKET || '',
  s3Region: process.env.S3_REGION || 'auto',
  s3Endpoint: process.env.S3_ENDPOINT || '',
  s3AccessKeyId: process.env.S3_ACCESS_KEY_ID || '',
  s3SecretAccessKey: process.env.S3_SECRET_ACCESS_KEY || '',
  // When the bucket is private, uploads are direct-to-storage via a
  // presigned PUT and reads are served through a presigned GET.
  s3SignedUrls: process.env.S3_SIGNED_URLS !== 'false',
  s3UrlTtlSeconds: parseInt(process.env.S3_URL_TTL_SECONDS, 10) || 3600,
  s3PublicBaseUrl: (process.env.S3_PUBLIC_BASE_URL || '').replace(/\/$/, ''),
};
