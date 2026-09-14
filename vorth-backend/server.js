const env = require('./src/config/env');
const connectDB = require('./src/config/db');
const app = require('./src/app');
const registerJobs = require('./src/jobs/resetViews');

let server;

async function start() {
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

start();
