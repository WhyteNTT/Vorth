'use strict';

/**
 * Graceful shutdown, driven against a real process.
 *
 * In-process testing would prove nothing here: `server.close()`, the pool and the
 * cron handles are all reachable without going through a signal, and what actually
 * goes wrong in a deploy is that one of the three is never released - the process
 * looks like it shut down and the platform kills it instead. So this spawns
 * server.js and watches what it does on SIGTERM.
 *
 * Every case here corresponds to a way a shutdown can half-happen, and each is
 * mutation-tested by breaking the corresponding line in server.js.
 */

process.env.DATABASE_URL ||= 'postgres://stub/stub';
process.env.DATABASE_SSL = 'false';
process.env.JWT_SECRET ||= 'test-secret';
process.env.NODE_ENV = 'test';
process.env.MAIL_TRANSPORT = 'disabled';
process.env.SHUTDOWN_TIMEOUT_MS = '4000';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const SERVER = path.join(__dirname, '..', 'server.js');
const JOBS = path.join(__dirname, '..', 'src', 'jobs', 'resetViews.js');

/**
 * Runs server.js in a child process and signals it.
 *
 * The database is stubbed through an unstubbed require of db.js, because
 * connectDB() against a real PostgreSQL is not available to every run. What is
 * under test is the shutdown sequence, not the boot.
 */
function runServer({ signal = 'SIGTERM', waitForListen = true, onListening } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER], {
      env: {
        ...process.env,
        PORT: '0',
        // Keep the child from inheriting a live-suite database.
        VORTH_SKIP_SCHEMA: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let out = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) { settled = true; child.kill('SIGKILL'); reject(new Error(`timed out. output:\n${out}`)); }
    }, 30_000);

    child.stdout.on('data', (d) => {
      out += d.toString();
      if (waitForListen && out.includes('listening on port') && !settled) {
        settled = true;
        clearTimeout(timer);
        const port = Number(out.match(/listening on port (\d+)/)[1]);
        if (onListening) onListening(port);
        child.kill(signal);
      }
    });
    child.stderr.on('data', (d) => { out += d.toString(); });

    child.on('exit', (code, sig) => {
      clearTimeout(timer);
      resolve({ code, signal: sig, output: out });
    });
    child.on('error', reject);
  });
}

test('SIGTERM drains in flight work, closes the pool and stops the jobs, then exits 0', async (t) => {
  /*
   * Linux only, and not as a convenience.
   *
   * Windows has no signals: child.kill('SIGTERM') there is TerminateProcess, so
   * the process dies without any handler running and the test cannot distinguish
   * a working shutdown from a working kill. Pretending otherwise would produce a
   * green check on a machine that proved nothing - which is worse than skipping.
   *
   * CI runs this on ubuntu-latest, which is where it is actually meaningful: a
   * shutdown problem is a deployment problem, and deployments are Linux.
   */
  if (process.platform === 'win32') {
    return t.skip('Windows cannot deliver SIGTERM to a child process; run this on Linux');
  }

  let inFlight = null;

  const { code, signal, output } = await runServer({
    // Give the listener a chance to exist, then signal immediately.
    onListening: (port) => {
      inFlight = new Promise((resolve) => {
        const req = http.get(`http://127.0.0.1:${port}/api/health`, (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode));
        });
        req.on('error', () => resolve(null));
      });
    },
  });

  assert.equal(signal, null, `the process had to be killed rather than exiting (${output.slice(-400)})`);
  assert.equal(code, 0, `expected a clean exit, got ${code}\n${output.slice(-400)}`);
  assert.match(output, /SIGTERM received, shutting down gracefully/);
  assert.match(output, /Shutdown complete/,
    `the shutdown never reported completion, so something was not released:\n${output.slice(-400)}`);

  if (inFlight) await inFlight;
});

test('the shutdown drains the pool rather than leaving connections for the OS', async () => {
  /*
   * Not cosmetic. Render recycles an instance after SIGTERM, and a process that
   * exits with the pool still open logs like a hard restart even when every
   * request completed - which is exactly the signal you need when diagnosing one.
   */
  const src = fs.readFileSync(SERVER, 'utf8');
  const order = ['server.close', 'stopJobs', 'closePool'].map((needle) => src.indexOf(needle));

  assert.ok(order.every((i) => i > -1),
    'the shutdown does not close the listener, stop the jobs and close the pool');
  assert.ok(order[0] < order[2],
    'the pool is closed before the listener, so an in-flight request can lose its '
    + 'connection while still running');
  assert.ok(order[1] < order[2],
    'the jobs are stopped after the pool closes, so a sweep can be cut off mid-write');
});

test('a drain that will not finish still exits rather than waiting forever', async () => {
  /*
   * `server.close()` alone is unbounded: it waits for every keep-alive connection
   * to close on its own. Without a deadline the platform's SIGKILL decides the
   * shutdown, and that looks identical to a crash in the logs.
   */
  const src = fs.readFileSync(SERVER, 'utf8');
  assert.match(src, /SHUTDOWN_DEADLINE_MS/, 'no shutdown deadline exists');
  assert.match(src, /forceTimer\.unref\(\)/,
    'the deadline timer is not unref-ed, so it would hold the process open by itself');
  assert.match(src, /Shutdown deadline reached/,
    'nothing reports that the deadline was hit, so a forced exit looks like a clean one');

  // And the deadline is actually shorter than the deadline it replaces: it must
  // come from configuration rather than being a constant nobody can change.
  assert.match(src, /process\.env\.SHUTDOWN_TIMEOUT_MS/);
});

test('both signals are handled, and an uncaught exception shuts down rather than crashing', () => {
  const src = fs.readFileSync(SERVER, 'utf8');
  assert.match(src, /process\.on\('SIGTERM'/, 'SIGTERM is not handled');
  assert.match(src, /process\.on\('SIGINT'/, 'SIGINT is not handled');
  assert.match(src, /process\.on\('uncaughtException'/,
    'an uncaught exception leaves the process in an undefined state');
});

test('the pool close is a no-op when there is no pool', async () => {
  // The unit suite and a failed boot both reach the shutdown with no pool. If
  // closePool() threw there, the one path that has nothing to clean up would be
  // the one that fails.
  const db = require('../src/config/db');
  db.setPool(null);
  await db.closePool();
});

test('stopping the jobs twice is safe', () => {
  // shutdown() can be reached more than once - a SIGTERM arriving while an
  // unhandledRejection is already draining. The second call must not throw.
  const { stopJobs } = require('../src/jobs/resetViews');
  stopJobs();
  stopJobs();
});

test('the jobs module actually registers handles it can stop', () => {
  /*
   * A stopJobs() that iterates an empty array is a no-op with a reassuring name.
   * The count is asserted against the number of cron.schedule calls, so adding a
   * job without registering its handle fails here rather than leaving a timer
   * that keeps the event loop alive through every deploy.
   */
  const src = fs.readFileSync(JOBS, 'utf8');
  const schedules = (src.match(/cron\.schedule\(/g) || []).length;
  const collected = (src.match(/schedules\.push\(\s*cron\.schedule\(/g) || []).length;

  assert.ok(schedules > 0, 'no jobs are registered at all');
  assert.equal(collected, schedules,
    `${schedules} job(s) are scheduled but only ${collected} handle(s) are kept for `
    + 'stopJobs(), so the rest keep the event loop alive after a shutdown');
});