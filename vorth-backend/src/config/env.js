const dotenv = require('dotenv');
dotenv.config();

const REQUIRED_VARS = ['DATABASE_URL', 'JWT_SECRET'];

function requireEnv() {
  const missing = REQUIRED_VARS.filter((key) => !process.env[key]);
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
  // accounting to stop a single account filling it. The other two expensive
  // classes, auth and DMCA, both had their own limit; this one had the loosest.
  uploadRateLimitMaxRequests: parseInt(process.env.UPLOAD_RATE_LIMIT_MAX_REQUESTS, 10) || 10,
  authRateLimitMaxRequests: parseInt(process.env.AUTH_RATE_LIMIT_MAX_REQUESTS, 10) || 20,
  // DMCA intake is public and sends email to a third party, so it gets its own
  // far tighter budget rather than riding on the general limit.
  dmcaRateLimitMaxRequests: parseInt(process.env.DMCA_RATE_LIMIT_MAX_REQUESTS, 10) || 5,
  // 'postgres' shares counters across instances and survives a deploy.
  // 'memory' is the zero-dependency default for a single process.
  rateLimitStore: process.env.RATE_LIMIT_STORE === 'postgres' ? 'postgres' : 'memory',
  minimumUserAge: parseInt(process.env.MINIMUM_USER_AGE, 10) || 13,
  dmcaContactEmail: process.env.DMCA_CONTACT_EMAIL || 'dmca@example.com',
  supportContactEmail: process.env.SUPPORT_CONTACT_EMAIL || 'support@example.com',

  // ---- DMCA counter-notice (17 U.S.C. 512(g)) ----
  // The statute gives the original complainant 10 to 14 business days to say
  // whether it filed a court action. The default is the earliest bound, so the
  // clock only ever runs in the complainant's favour; 14 is the outer limit and
  // is clamped rather than rejected, because a longer window is legally
  // permitted and a misconfigured value should not stop the server booting.
  dmcaCounterNoticeDays: Math.min(
    14,
    Math.max(10, parseInt(process.env.DMCA_COUNTER_NOTICE_DAYS, 10) || 10)
  ),
  // Public holidays are NOT excluded by default - see businessDays.js for why.
  // A deployment that wants them passes ISO YYYY-MM-DD dates here.
  dmcaCounterNoticeHolidays: (process.env.DMCA_COUNTER_NOTICE_HOLIDAYS || '')
    .split(',')
    .map((d) => d.trim())
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)),

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

  // ---- mail transport ----
  // 'console' logs the message instead of sending it (development default).
  // 'smtp' sends for real; see src/services/mailer.js.
  mailTransport: ['console', 'smtp', 'disabled'].includes(process.env.MAIL_TRANSPORT)
    ? process.env.MAIL_TRANSPORT : 'console',
  mailFrom: process.env.MAIL_FROM || 'no-reply@vorth.example',
  smtpHost: process.env.SMTP_HOST || '',
  smtpPort: parseInt(process.env.SMTP_PORT, 10) || 587,
  smtpUser: process.env.SMTP_USER || '',
  smtpPass: process.env.SMTP_PASS || '',
  smtpSecure: process.env.SMTP_SECURE === 'true',

  // ---- object storage for uploads ----
  // 'local' writes to uploads/; 's3' targets any S3-compatible service
  // (AWS S3, Cloudflare R2, MinIO, Backblaze B2).
  storageDriver: process.env.STORAGE_DRIVER === 's3' ? 's3' : 'local',
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
