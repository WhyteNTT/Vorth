const env = require('./src/config/env');
const { connectDB } = require('./src/config/db');
const app = require('./src/app');
const registerJobs = require('./src/jobs/resetViews');
const preflight = require('./src/config/preflight');

let server;

async function start() {
  // Before anything else: a half-configured deployment should say so.
  const findings = preflight.assertAcceptable();
  const errors = findings.filter((f) => f.level === 'error').length;
  const warnings = findings.filter((f) => f.level === 'warn').length;
  if (errors || warnings) {
    console.warn('[preflight] Configuration findings:');
    console.warn(preflight.report(findings));
    console.warn(`[preflight] ${errors} error(s), ${warnings} warning(s). `
      + 'Set VORTH_STRICT_CONFIG=1 to refuse to start on an error.');
  } else {
    console.log('[preflight] Configuration looks sane.');
  }

  await connectDB();
  registerJobs();

  server = app.listen(env.port, () => {
    console.log(`[server] Vorth API listening on port ${env.port} (${env.nodeEnv})`);
  });
}

// Fail loudly instead of leaving the process in a half-working state.
process.on('unhandledRejection', (err) => {
  console.error('[fatal] Unhandled promise rejection:', err);
  if (server) {
    server.close(() => process.exit(1));
  } else {
    process.exit(1);
  }
});

process.on('SIGTERM', () => {
  console.log('[server] SIGTERM received, shutting down gracefully');
  if (server) server.close(() => process.exit(0));
});

start().catch((err) => {
  console.error('[fatal] Startup failed:', err.message);
  process.exit(1);
});