'use strict';

/**
 * Where does this DATABASE_URL point, and is it safe to write to?
 *
 * One classifier, used by two very different callers:
 *
 *   - connectDB(), before it runs CREATE TABLE / ALTER TABLE / CREATE INDEX.
 *   - the destructive live test suite, before it runs DELETE.
 *
 * They were separate lists at first and could drift. They now share this.
 *
 * Why connectDB needs a guard at all: DATABASE_URL in a local `.env` is very
 * often a real, remote, production database. A developer machine runs
 * scripts that import config/db, dotenv loads that URL, and a boot applies the
 * schema to production without anybody intending it. That is not
 * hypothetical - it happened while building this.
 *
 * The distinction the guard draws is *deployment versus accident*, not local
 * versus remote. A real deployment must be able to apply the schema on boot,
 * and it cannot be asked to set an opt-in flag to do its job. So:
 *
 *   NODE_ENV=production                  -> allowed. This is a deployment.
 *   local or disposable-looking database -> allowed. This is development.
 *   managed production host, anything else -> refused.
 *
 * VORTH_ALLOW_SCHEMA_ON_PRODUCTION=1 overrides the last case for the rare
 * deliberate case, such as provisioning the very first deploy.
 */

const LOCAL_HOSTS = ['localhost', '127.0.0.1', '::1', '0.0.0.0', 'host.docker.internal'];

/** Hostname fragments that indicate a managed production database. */
const MANAGED_PRODUCTION_HOSTS = [
  'neon.tech', 'rds.amazonaws.com', 'azure.com', 'database.windows.net',
  'cloudsql', 'digitalocean.com', 'supabase.co', 'planetscale.com',
  'psdb.cloud', 'xata.io', 'cockroachlabs.com', 'turso.io', 'appwrite.io',
];

/** Database-name fragments that indicate a disposable database. */
const TEST_NAME_MARKERS = ['test', 'ci', 'tmp', 'temp', 'local', 'dev', 'scratch', 'dummy'];

function parseDatabaseUrl(raw) {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return {
      host: u.hostname,
      port: u.port || '5432',
      database: decodeURIComponent(u.pathname.replace(/^\//, '')),
    };
  } catch (_) {
    return null;
  }
}

/**
 * Classifies a target.
 *
 * @returns {{host: string, database: string, isLocal: boolean,
 *            isManagedProduction: boolean, nameLooksDisposable: boolean}}
 */
function classify(rawUrl) {
  const target = parseDatabaseUrl(rawUrl);
  if (!target) return null;
  const host = target.host.toLowerCase();
  const database = target.database.toLowerCase();
  return {
    ...target,
    isLocal: LOCAL_HOSTS.includes(host),
    isManagedProduction: MANAGED_PRODUCTION_HOSTS.some((m) => host.includes(m)),
    nameLooksDisposable: TEST_NAME_MARKERS.some((m) => database.includes(m)),
  };
}

/**
 * May schema be applied here?
 *
 * @returns {{ok: boolean, reason?: string, target?: object}}
 */
function assertSchemaTargetAllowed(rawUrl, env = process.env) {
  const target = classify(rawUrl);
  if (!target) {
    return { ok: false, reason: 'DATABASE_URL is missing or unparseable' };
  }

  // A deployment is expected to bring its own schema up to date on boot.
  // This is the one case where writing to production is the whole point.
  if (env.NODE_ENV === 'production') return { ok: true, target };

  if (env.VORTH_ALLOW_SCHEMA_ON_PRODUCTION === '1') return { ok: true, target };

  if (!target.isManagedProduction) return { ok: true, target };

  return {
    ok: false,
    reason: `refusing to apply schema to a managed production host (${target.host}) from a `
      + `${env.NODE_ENV || 'development'} process. `
      + 'A local DATABASE_URL pointing at production means any script that boots the app '
      + 'will migrate it without you intending to. '
      + 'Set NODE_ENV=production for a real deployment, or VORTH_ALLOW_SCHEMA_ON_PRODUCTION=1 '
      + 'if you really mean to migrate it now.',
    target,
  };
}

/**
 * May destructive statements run here?
 *
 * Stricter than assertSchemaTargetAllowed on purpose: the live suite issues
 * DELETEs, so it also needs an explicit opt-in even against a local database.
 *
 * @returns {{ok: boolean, reason?: string, target?: object}}
 */
function assertSafeTarget(rawUrl, env = process.env) {
  const target = classify(rawUrl);
  if (!target) return { ok: false, reason: 'DATABASE_URL is missing or unparseable' };

  if (env.VORTH_LIVE_DB !== '1') {
    return {
      ok: false,
      reason: 'refusing to touch a live database without VORTH_LIVE_DB=1',
      target,
    };
  }

  if (env.VORTH_LIVE_DB_ALLOW_REMOTE === '1') return { ok: true, target };

  if (target.isManagedProduction) {
    return {
      ok: false,
      reason: `refusing to run against a managed production host (${target.host}). `
        + 'This suite deletes rows. Point DATABASE_URL at a local or disposable database.',
      target,
    };
  }

  if (!target.isLocal && !target.nameLooksDisposable) {
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

module.exports = {
  parseDatabaseUrl,
  classify,
  assertSchemaTargetAllowed,
  assertSafeTarget,
  LOCAL_HOSTS,
  MANAGED_PRODUCTION_HOSTS,
  TEST_NAME_MARKERS,
};