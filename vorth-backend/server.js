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

/**
 * How long a drain may take before the process gives up waiting.
 *
 * `server.close()` waits for in-flight requests and for every keep-alive
 * connection to close on its own, which is unbounded. Render sends SIGTERM and
 * then SIGKILLs after a grace period, so an unbounded drain means the platform
 * kills the process instead - a hard restart that looks identical in the logs to
 * a crash, and loses whatever the last in-flight request was doing. Better to
 * finish cleanly and, if something will not finish, say so and exit anyway.
 */
const SHUTDOWN_DEADLINE_MS = Number(process.env.SHUTDOWN_TIMEOUT_MS) || 10_000;

/**
 * Stops accepting work, lets what is in flight finish, then closes the database
 * pool and the scheduled jobs before exiting.
 *
 * Order matters. The listener closes first so no new request arrives; the pool
 * closes after that so an in-flight request still has a connection to finish on;
 * the jobs stop last so a sweep that is part-way through is not cut off mid-write.
 */
function shutdown(code, reason) {
  console.log(`[server] ${reason}, shutting down gracefully (deadline ${SHUTDOWN_DEADLINE_MS}ms)`);

  const forceTimer = setTimeout(() => {
    // Cut the sockets first. process.exit() alone leaves the kernel to clean up,
    // which is the forceful shutdown this whole path exists to avoid doing
    // quietly; closing them first at least gets the server's own bookkeeping in
    // order before the process goes.
    console.error('[server] Shutdown deadline reached with connections still open; '
      + 'closing them and exiting');
    if (server && typeof server.closeAllConnections === 'function') server.closeAllConnections();
    process.exit(code);
  }, SHUTDOWN_DEADLINE_MS);
  // Do not let the deadline itself be the reason the process stays alive.
  forceTimer.unref();

  const finish = async () => {
    try {
      const { stopJobs } = require('./src/jobs/resetViews');
      stopJobs();
      await require('./src/config/db').closePool();
      console.log('[server] Shutdown complete');
    } catch (err) {
      console.error('[server] Shutdown step failed:', err.message);
    }
    process.exit(code);
  };

  if (!server) return finish();

  server.close(finish);

  /*
   * Reap idle sockets as they appear.
   *
   * `server.close()` waits for every connection to go away, and a keep-alive
   * connection does not go away just because the response was sent - it sits
   * there waiting for the next request. Calling closeIdleConnections() once, up
   * front, does not help: a socket that is mid-request when the drain starts is
   * not idle yet, so it is skipped, and by the time it is idle nothing is left
   * to reap it. The drain then waits out the whole deadline and gives up.
   *
   * That is what happened here, caught by the shutdown test on Linux: the test's
   * own request to /api/health was in flight when SIGTERM arrived, and the
   * process logged "Shutdown deadline reached" instead of "Shutdown complete".
   *
   * So this polls until the server is actually closed. It is cheap - a timer that
   * fires a few times over a drain measured in milliseconds - and it means a
   * normal shutdown finishes on its own rather than on the backstop.
   */
  const reaper = setInterval(() => {
    if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections();
  }, 50);

  const stopReaping = () => clearInterval(reaper);
  reaper.unref();
  process.once('beforeExit', stopReaping);
}

// Fail loudly instead of leaving the process in a half-working state.
process.on('unhandledRejection', (err) => {
  console.error('[fatal] Unhandled promise rejection:', err);
  shutdown(1, 'Unhandled promise rejection');
});

process.on('uncaughtException', (err) => {
  console.error('[fatal] Uncaught exception:', err);
  shutdown(1, 'Uncaught exception');
});

process.on('SIGTERM', () => shutdown(0, 'SIGTERM received'));
process.on('SIGINT', () => shutdown(0, 'SIGINT received'));

start().catch((err) => {
  console.error('[fatal] Startup failed:', err.message);
  process.exit(1);
});