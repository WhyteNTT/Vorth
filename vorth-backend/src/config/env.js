const dotenv = require('dotenv');
dotenv.config();

const REQUIRED_VARS = ['MONGO_URI', 'JWT_SECRET'];

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
  port: parseInt(process.env.PORT, 10) || 5000,
  mongoUri: process.env.MONGO_URI,
  jwtSecret: process.env.JWT_SECRET,
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '7d',
  clientOrigins: (process.env.CLIENT_ORIGINS || '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean),
  maxUploadMb: parseInt(process.env.MAX_UPLOAD_MB, 10) || 8,
  rateLimitWindowMinutes: parseInt(process.env.RATE_LIMIT_WINDOW_MINUTES, 10) || 15,
  rateLimitMaxRequests: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS, 10) || 300,
  authRateLimitMaxRequests: parseInt(process.env.AUTH_RATE_LIMIT_MAX_REQUESTS, 10) || 20,
  minimumUserAge: parseInt(process.env.MINIMUM_USER_AGE, 10) || 13,
  dmcaContactEmail: process.env.DMCA_CONTACT_EMAIL || 'dmca@example.com',
  supportContactEmail: process.env.SUPPORT_CONTACT_EMAIL || 'support@example.com',
};
