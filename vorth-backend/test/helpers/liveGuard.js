'use strict';

/**
 * Guard for tests that touch a real database.
 *
 * `test/postgres.live.test.js` executes destructive statements (TRUNCATE,
 * DELETE) against whatever DATABASE_URL points at — including the value
 * loaded from a developer's local `.env`, which is very often a real,
 * remote, production database. Getting that wrong destroys real data, so the
 * live suite is refused unless the target is unambiguously a throwaway.
 *
 * Two independent conditions must hold:
 *   1. explicit opt-in via VORTH_LIVE_DB=1
 *   2. the connection string looks like a local or disposable test database
 *
 * Set VORTH_LIVE_DB_ALLOW_REMOTE=1 to override (2) when you really do mean to
 * run against a shared scratch database — never for a production one.
 */

const LOCAL_HOSTS = ['localhost', '127.0.0.1', '::1', '0.0.0.0', 'host.docker.internal'];

/** Hostname fragments that indicate a managed production database. */
const MANAGED_PRODUCTION_HOSTS = [
  'neon.tech', 'rds.amazonaws.com', 'azure.com', 'database.windows.net',
  'cloudsql', 'digitalocean.com', 'supabase.co', 'planetscale.com', 'xata.io',
];

/** Database-name fragments that indicate a disposable database. */
const TEST_NAME_MARKERS = ['test', 'ci', 'tmp', 'temp', 'local', 'dev', 'scratch', 'dummy'];

function parseDatabaseUrl(raw) {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return { host: u.hostname, port: u.port || '5432', database: decodeURIComponent(u.pathname.replace(/^\//, '')) };
  } catch (_) {
    return null;
  }
}

/**
 * @returns {{ ok: boolean, reason?: string, target?: object }}
 */
function assertSafeTarget(rawUrl, env = process.env) {
  const target = parseDatabaseUrl(rawUrl);
  if (!target) return { ok: false, reason: 'DATABASE_URL is missing or unparseable' };

  if (env.VORTH_LIVE_DB !== '1') {
    return {
      ok: false,
      reason: 'refusing to touch a live database without VORTH_LIVE_DB=1',
      target,
    };
  }

  if (env.VORTH_LIVE_DB_ALLOW_REMOTE === '1') return { ok: true, target };

  const host = target.host.toLowerCase();
  const database = target.database.toLowerCase();

  const isManagedProduction = MANAGED_PRODUCTION_HOSTS.some((m) => host.includes(m));
  if (isManagedProduction) {
    return {
      ok: false,
      reason: `refusing to run against a managed production host (${host}). `
        + 'This suite truncates tables. Point DATABASE_URL at a local or disposable database.',
      target,
    };
  }

  const looksLocal = LOCAL_HOSTS.includes(host);
  const nameLooksDisposable = TEST_NAME_MARKERS.some((m) => database.includes(m));

  if (!looksLocal && !nameLooksDisposable) {
    return {
      ok: false,
      reason: `database "${target.database}" on host "${target.host}" does not look like a `
        + 'throwaway test database. Name it *test*/*ci*/*tmp*, use localhost, or set '
        + 'VORTH_LIVE_DB_ALLOW_REMOTE=1 if this really is a scratch database.',
      target,
    };
  }

  return { ok: true, target };
}

module.exports = { assertSafeTarget, parseDatabaseUrl, LOCAL_HOSTS, MANAGED_PRODUCTION_HOSTS, TEST_NAME_MARKERS };