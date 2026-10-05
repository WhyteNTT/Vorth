'use strict';

/**
 * The boot guard: the server refuses to start without its two required variables.
 *
 * `src/config/env.js` calls `process.exit(1)` when `DATABASE_URL` or `JWT_SECRET` is
 * absent. That guard was uncovered - lines 9 through 14 are the error message and
 * the exit - and it is the one check in the codebase whose failure is silent in the
 * worst way. Every other module reads `env` at require time, so without this guard a
 * missing secret does not fail at boot: it fails later, per request, as a signing
 * error or a connection attempt, with nothing in the logs saying the variable was
 * never set.
 *
 * Tested by running `node -e "require('./src/config/env')"` in a child process with
 * a chosen environment, because the module reads `process.env` and calls `process.exit`
 * at require time. Neither can be done in-process without taking the test runner down
 * with it, and `process.exit` in a test runner is indistinguishable from a crashed
 * suite.
 *
 * Every case asserts the *exit code* as well as the message. A guard that logs
 * correctly and exits zero has not guarded anything - which is precisely how this
 * class of check fails when someone changes `process.exit(1)` to a warning.
 */

process.env.DATABASE_URL ||= 'postgres://stub/stub';
process.env.DATABASE_SSL = 'false';
process.env.JWT_SECRET ||= 'test-secret';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const BACKEND = path.join(__dirname, '..');
const RUNTIME = path.join(BACKEND, 'src', 'config', 'env.js');

/**
 * Loads the config module in a child process with exactly this environment.
 *
 * `.env` is loaded by the module itself (`dotenv.config()`), which would otherwise
 * repopulate the variables from the developer's local file and make every case here
 * pass for the wrong reason. That is not hypothetical: this repository has a local
 * `.env`, and the CI job that runs without one is why load-time failures are hard to
 * reproduce on a workstation. The child runs in a temporary directory with a copy of
 * nothing, so `dotenv` finds no file.
 */
function loadConfig(env) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'vorth-env-'));
  try {
    const result = spawnSync(
      process.execPath,
      ['-e', `require(${JSON.stringify(RUNTIME)})`],
      {
        cwd,
        encoding: 'utf8',
        timeout: 30000,
        env: {
          // No inherited process.env: a variable the parent has set must not decide
          // the outcome. PATH is the exception Node needs on Windows.
          PATH: process.env.PATH,
          SystemRoot: process.env.SystemRoot,
          ...env,
        },
      },
    );
    return {
      status: result.status,
      stdout: result.stdout || '',
      stderr: result.stderr || '',
    };
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

const BASE = {
  DATABASE_URL: 'postgres://stub/stub',
  DATABASE_SSL: 'false',
  JWT_SECRET: 'test-secret',
};

test('the module boots when both required variables are present', () => {
  const res = loadConfig(BASE);
  assert.equal(res.status, 0, `config refused to load: ${res.stderr}`);
  assert.doesNotMatch(res.stderr, /Missing required environment/);
});

test('a missing DATABASE_URL stops the boot', () => {
  const res = loadConfig({ ...BASE, DATABASE_URL: '' });
  assert.equal(res.status, 1, `the server would have started with no database URL (exit ${res.status})`);
  assert.match(res.stderr, /DATABASE_URL/);
  assert.match(res.stderr, /Missing required environment/);
});

test('a missing signing secret stops the boot', () => {
  /*
   * The dangerous one. Absent this guard the server starts, serves pages, and fails
   * every token operation with a signing error - which looks like a signing bug
   * rather than a missing variable, and sends whoever is on call looking in the
   * wrong module.
   */
  const res = loadConfig({ ...BASE, JWT_SECRET: '' });
  assert.equal(res.status, 1, `the server would have started with no signing secret (exit ${res.status})`);
  assert.match(res.stderr, /JWT_SECRET/);
});

test('both missing are reported together, not one at a time', () => {
  /*
   * Otherwise the fix is iterative: start, read one name, restart, read the second.
   * The whole list is in one message so one restart is enough.
   */
  const res = loadConfig({ DATABASE_SSL: 'false' });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /DATABASE_URL/);
  assert.match(res.stderr, /JWT_SECRET/);
  assert.match(res.stderr, /\.env\.example/,
    'the message does not say how to fix it');
});

test('an empty string counts as missing, not as set', () => {
  /*
   * `!process.env[key]` rather than a `=== undefined` check, so `DATABASE_URL=`
   * in a deploy config is caught. That is the shape a platform's blank-field UI
   * produces, and it is the version that otherwise reaches the driver.
   */
  const res = loadConfig({ ...BASE, DATABASE_URL: '   ' });
  assert.equal(res.status, 1, 'a whitespace-only database URL was accepted as configured');
  assert.match(res.stderr, /DATABASE_URL/);
});

/* ================================================================== *
 * The parsed values, which is the rest of the module
 * ================================================================== */

/**
 * Loads the config and prints every exported key as JSON.
 *
 * Printing rather than returning is the point: the values live in a child process,
 * and a parent that guessed which keys exist would only assert what it already
 * assumed. Whatever the module exports is what gets printed and checked.
 */
function readConfig(env) {
  const script = `
    const cfg = require(${JSON.stringify(RUNTIME)});
    for (const [k, v] of Object.entries(cfg)) {
      console.log('__' + k + '__:' + JSON.stringify(v === undefined ? null : v));
    }
  `;
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'vorth-env-'));
  try {
    const result = spawnSync(process.execPath, ['-e', script], {
      cwd,
      encoding: 'utf8',
      timeout: 30000,
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        ...env,
      },
    });
    assert.equal(result.status, 0, `config refused to load: ${result.stderr}`);

    const out = {};
    for (const m of (result.stdout || '').matchAll(/^__(\w+)__:(.*)$/gm)) {
      out[m[1]] = JSON.parse(m[2]);
    }
    return out;
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

test('every limit falls back to its documented default', () => {
  /*
   * The `parseInt(...) || N` pattern means a variable set to a non-number, zero, or
   * empty silently becomes the default. That is the right behaviour for a limit -
   * a typo should not disable the rate limiter - but it is only right if the default
   * is what the README claims, which is why the numbers are asserted rather than the
   * expression.
   */
  const cfg = readConfig(BASE);
  assert.equal(cfg.rateLimitMaxRequests, 300);
  assert.equal(cfg.authRateLimitMaxRequests, 20);
  assert.equal(cfg.dmcaRateLimitMaxRequests, 5);
  assert.equal(cfg.uploadRateLimitMaxRequests, 10);
  assert.equal(cfg.rateLimitWindowMinutes, 15);
  assert.equal(cfg.maxUploadMb, 8);
});

test('a limit set to zero falls back rather than disabling the limiter', () => {
  /*
   * `0` is falsy, so `parseInt('0') || 300` is 300. Worth pinning deliberately: a
   * deployer reading "set this to 0 to turn it off" would get the opposite of what
   * they asked for, and there is no error to explain it. The safe reading is the
   * current one - the default protects them from their own typo - but it should be a
   * known decision, not an accident of `||`.
   */
  const cfg = readConfig({ ...BASE, RATE_LIMIT_MAX_REQUESTS: '0' });
  assert.equal(cfg.rateLimitMaxRequests, 300, 'a zero limit disabled the rate limiter');
});

test('a limit set to a non-number falls back rather than becoming NaN', () => {
  const cfg = readConfig({ ...BASE, RATE_LIMIT_MAX_REQUESTS: 'lots' });
  assert.equal(cfg.rateLimitMaxRequests, 300,
    'a nonsense limit was passed through instead of the default');
});

test('a valid limit is honoured', () => {
  const cfg = readConfig({ ...BASE, RATE_LIMIT_MAX_REQUESTS: '42', AUTH_RATE_LIMIT_MAX_REQUESTS: '7' });
  assert.equal(cfg.rateLimitMaxRequests, 42);
  assert.equal(cfg.authRateLimitMaxRequests, 7);
});

test('TRUST_PROXY accepts the two forms a platform actually sets', () => {
  /*
   * Render's UI and most docker-compose files write `1`; a .env written by hand says
   * `true`. Only the exact strings count - `TRUE`, `yes` and `on` are not accepted,
   * because a value that looks enabled but is not leaves every rate limiter keyed on
   * the load balancer's address. Asserted so that is a decision rather than an
   * oversight.
   */
  for (const value of ['true', '1']) {
    const cfg = readConfig({ ...BASE, TRUST_PROXY: value });
    assert.equal(cfg.trustProxy, true, `TRUST_PROXY=${value} did not enable it`);
  }
  for (const value of ['TRUE', 'yes', 'on', 'false', '', '0']) {
    const cfg = readConfig({ ...BASE, TRUST_PROXY: value });
    assert.equal(cfg.trustProxy, false, `TRUST_PROXY=${value} enabled it unexpectedly`);
  }
});

test('CLIENT_ORIGINS is split, trimmed, and emptied of blanks', () => {
  const cfg = readConfig({ ...BASE, CLIENT_ORIGINS: ' https://a.example , ,https://b.example ' });
  assert.deepEqual(cfg.clientOrigins, ['https://a.example', 'https://b.example']);

  const empty = readConfig({ ...BASE, CLIENT_ORIGINS: '' });
  assert.deepEqual(empty.clientOrigins, [],
    'an unset CLIENT_ORIGINS should be an empty list, not a list of blanks');
});

test('DATABASE_SSL defaults to on, and only the exact string "false" turns it off', () => {
  /*
   * Defaulting to SSL-on is the safe direction: a deployment that forgets the
   * variable gets an encrypted connection attempt rather than an unencrypted one.
   *
   * The "unset" case is built without DATABASE_SSL rather than by blanking it,
   * because BASE sets it to 'false' for the rest of this file - which is what
   * happened the first time, and made this assertion report the opposite of the
   * behaviour it describes.
   */
  const { DATABASE_SSL: _omitted, ...withoutSsl } = BASE;
  assert.equal(readConfig(withoutSsl).databaseSsl, true, 'SSL should default to on');
  assert.equal(readConfig({ ...BASE, DATABASE_SSL: 'false' }).databaseSsl, false);
  assert.equal(readConfig({ ...BASE, DATABASE_SSL: 'FALSE' }).databaseSsl, true,
    'only the exact string "false" should disable SSL');
});

test('NODE_ENV defaults to development when unset', () => {
  const cfg = readConfig(BASE);
  assert.equal(cfg.nodeEnv, 'development');
});

test('PORT falls back to 5000, and a numeric port is used as given', () => {
  assert.equal(readConfig(BASE).port, 5000);
  assert.equal(readConfig({ ...BASE, PORT: '8080' }).port, 8080);
  assert.equal(readConfig({ ...BASE, PORT: 'not-a-port' }).port, 5000,
    'a nonsense PORT was passed through');
});