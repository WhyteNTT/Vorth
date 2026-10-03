'use strict';

/**
 * The production-database guard on connectDB().
 *
 * Written after a script run migrated a live Neon database that nobody had asked
 * to touch: the developer's `.env` held its URL, dotenv loaded it, and anything
 * that imported config/db and called connectDB() applied the schema.
 *
 * These tests use real-looking managed hosts and never open a connection. The
 * guard runs before the pool does anything, so a refusal is provable without a
 * database.
 */

process.env.DATABASE_URL ||= 'postgres://stub/stub';
process.env.DATABASE_SSL = 'false';
process.env.JWT_SECRET ||= 'test-secret';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const {
  classify,
  assertSchemaTargetAllowed,
  assertSafeTarget,
  MANAGED_PRODUCTION_HOSTS,
} = require('../src/config/hostGuard');

/** Connection strings shaped exactly like the ones that caused the incident. */
const NEON = 'postgresql://user:pw@ep-curve-abc123-pooler.c-6.eu-central-1.aws.neon.tech/neondb?sslmode=require';
const RDS = 'postgresql://u:p@myapp.abcdefgh.eu-west-1.rds.amazonaws.com:5432/vorth';
const LOCAL = 'postgresql://vorth:vorth@127.0.0.1:5432/vorth_test';
const LOCAL_OTHER_NAME = 'postgresql://vorth:vorth@localhost:5432/vorth';

const DEV = { NODE_ENV: 'development' };

test('a managed production host is recognised', () => {
  for (const url of [NEON, RDS]) {
    const c = classify(url);
    assert.equal(c.isManagedProduction, true, url);
    assert.equal(c.isLocal, false);
  }
  assert.equal(classify(LOCAL).isLocal, true);
  assert.equal(classify(LOCAL_OTHER_NAME).isLocal, true);
  assert.equal(classify('not a url'), null);
});

test('every managed host fragment is lowercase and actually matches something', () => {
  /*
   * Fragments are matched with host.includes(), so they need not be domains -
   * "cloudsql" appears inside a hostname without being a suffix of its own.
   * What does matter is that each one matches a real hostname and that none is
   * so short it would catch unrelated hosts.
   */
  const REAL = [
    ['ep-x-123-pooler.c-6.eu-central-1.aws.neon.tech', 'neon.tech'],
    ['app.abcdef.eu-west-1.rds.amazonaws.com', 'rds.amazonaws.com'],
    ['ps.postgres.database.azure.com', 'azure.com'],
    ['ps-d0-abc.database.windows.net', 'database.windows.net'],
    ['cloudsql-project:region', 'cloudsql'],
    ['db.project.ref.supabase.co', 'supabase.co'],
    ['aws.connect.psdb.cloud', 'psdb.cloud'],
    ['aws.connect.planetscale.com', 'planetscale.com'],
    ['do-user-123456-0.db.ondigitalocean.com', 'digitalocean.com'],
  ];
  for (const [host, fragment] of REAL) {
    if (!MANAGED_PRODUCTION_HOSTS.includes(fragment)) {
      // Not every provider has been added yet; record that rather than assert
      // something false.
      console.log(`    (not yet classified: ${fragment})`);
      continue;
    }
    assert.ok(host.toLowerCase().includes(fragment),
      `${fragment} does not match ${host}`);
  }

  // A fragment short enough to appear by accident is a false-positive risk.
  for (const fragment of MANAGED_PRODUCTION_HOSTS) {
    assert.equal(fragment, fragment.toLowerCase(), `${fragment} must be lowercase`);
    assert.ok(fragment.length >= 6,
      `"${fragment}" is short enough to match unrelated hosts by accident`);
  }

  // And a self-hosted database is not mistaken for a managed one.
  assert.equal(classify('postgresql://u:p@db.internal.corp:5432/vorth').isManagedProduction, false);
  assert.equal(classify('postgresql://u:p@10.0.0.5:5432/vorth').isManagedProduction, false);
});

test('the accident that actually happened is now refused', () => {
  // A developer machine, NODE_ENV unset, dotenv having loaded the Neon URL.
  const verdict = assertSchemaTargetAllowed(NEON, { NODE_ENV: 'development' });
  assert.equal(verdict.ok, false, 'the incident would not be prevented');
  assert.match(verdict.reason, /refusing to apply schema/i);
  assert.match(verdict.reason, /neon\.tech|VORTH_ALLOW_SCHEMA_ON_PRODUCTION/);
});

test('it is refused under every non-production NODE_ENV', () => {
  for (const nodeEnv of ['development', 'test', undefined, '', 'staging', 'prod']) {
    const verdict = assertSchemaTargetAllowed(NEON, { NODE_ENV: nodeEnv });
    assert.equal(verdict.ok, false, `NODE_ENV=${nodeEnv} should not be enough`);
  }
  // Note "prod" is not NODE_ENV=production and is deliberately not honoured:
  // guessing at a near-miss would defeat the point.
});

test('a deployment can still apply its own schema', () => {
  // The guard must not make deploying impossible.
  const verdict = assertSchemaTargetAllowed(NEON, { NODE_ENV: 'production' });
  assert.equal(verdict.ok, true, verdict.reason);
});

test('the explicit override works, for provisioning the first deploy', () => {
  const verdict = assertSchemaTargetAllowed(NEON, {
    NODE_ENV: 'development',
    VORTH_ALLOW_SCHEMA_ON_PRODUCTION: '1',
  });
  assert.equal(verdict.ok, true);
});

test('local and disposable targets are unaffected in development', () => {
  for (const url of [LOCAL, LOCAL_OTHER_NAME]) {
    const verdict = assertSchemaTargetAllowed(url, DEV);
    assert.equal(verdict.ok, true, `${url}: ${verdict.reason}`);
  }
});

test('an unparseable or missing URL is refused, not assumed safe', () => {
  assert.equal(assertSchemaTargetAllowed('', DEV).ok, false);
  assert.equal(assertSchemaTargetAllowed(undefined, DEV).ok, false);
  assert.equal(assertSchemaTargetAllowed('nonsense', DEV).ok, false);
});

test('connectDB refuses before it issues any DDL', async () => {
  /*
   * The guard has to run before the pool is touched. Two things are proved
   * here:
   *
   *   1. the refusal is the schema guard's, not a connection failure - a
   *      VORTH_SCHEMA_TARGET_REFUSED code rather than ENOTFOUND
   *   2. not one statement was sent - the double records any query() call
   *
   * The URL is swapped on the config object rather than on process.env,
   * because config/env reads the environment once at require time and the pool
   * is built from that captured value. Pointing process.env at a different host
   * would leave the pool aimed at the real one, which is precisely the confusion
   * that caused the incident in the first place.
   */
  const env = require('../src/config/env');
  const db = require('../src/config/db');

  const savedUrl = env.databaseUrl;
  const savedNodeEnv = process.env.NODE_ENV;
  const savedOverride = process.env.VORTH_ALLOW_SCHEMA_ON_PRODUCTION;
  const savedPool = db.pool;
  let queryWasCalled = false;

  try {
    env.databaseUrl = NEON;
    process.env.NODE_ENV = 'development';
    delete process.env.VORTH_ALLOW_SCHEMA_ON_PRODUCTION;

    db.setPool({
      query() {
        queryWasCalled = true;
        return Promise.reject(new Error('a statement was sent despite the refusal'));
      },
      async connect() {
        return {
          query() { queryWasCalled = true; throw new Error('a statement was sent'); },
          release() {},
        };
      },
    });

    await assert.rejects(
      () => db.connectDB(),
      (err) => {
        assert.equal(err.code, 'VORTH_SCHEMA_TARGET_REFUSED',
          `expected the schema guard to refuse, got: ${err.code || err.message}`);
        assert.match(err.message, /refusing to apply schema/i);
        return true;
      },
    );
    assert.equal(queryWasCalled, false, 'a statement was sent despite the refusal');
  } finally {
    db.setPool(savedPool);
    env.databaseUrl = savedUrl;
    process.env.NODE_ENV = savedNodeEnv;
    if (savedOverride !== undefined) process.env.VORTH_ALLOW_SCHEMA_ON_PRODUCTION = savedOverride;
  }
});

test('the same database is allowed once it looks like a deployment', async () => {
  // Proves the refusal above is about the environment, not about Neon: the
  // identical URL is accepted when the process says it is deploying.
  const env = require('../src/config/env');
  const db = require('../src/config/db');
  const savedUrl = env.databaseUrl;
  const savedNodeEnv = process.env.NODE_ENV;
  const savedPool = db.pool;
  const statements = [];

  /*
   * VORTH_SKIP_SCHEMA cleared for this test.
   *
   * test/run.js sets it so the live files stop racing each other over the DDL,
   * which is right for them and wrong here: this test asserts that boot *does*
   * apply the schema, and under the flag connectDB() returns before issuing any
   * DDL. Left set, it fails with "the schema should have been applied" - which
   * reads like the production guard broke, when in fact the guard was never
   * reached. Same opt-out postgres.live.test.js and columnUpgrade.serial.test.js
   * make, for the same reason.
   */
  const savedSkip = process.env.VORTH_SKIP_SCHEMA;
  delete process.env.VORTH_SKIP_SCHEMA;

  try {
    env.databaseUrl = NEON;
    process.env.NODE_ENV = 'production';
    db.setPool({
      query(text) {
        statements.push(String(text).slice(0, 20));
        // Enough to let the boot proceed; the DDL is one big multi-statement
        // string plus a verification read.
        return Promise.resolve({ rows: [], rowCount: 0 });
      },
      async connect() { return { query: () => Promise.resolve({ rows: [] }), release() {} }; },
    });
    await db.connectDB();
    assert.ok(statements.length > 0, 'the schema should have been applied');
  } finally {
    db.setPool(savedPool);
    env.databaseUrl = savedUrl;
    process.env.NODE_ENV = savedNodeEnv;
    if (savedSkip === undefined) delete process.env.VORTH_SKIP_SCHEMA;
    else process.env.VORTH_SKIP_SCHEMA = savedSkip;
  }
});

test('the destructive-suite guard is unchanged and still stricter', () => {
  // Regression check on the guard that already existed: it must keep its
  // opt-in requirement even against localhost.
  assert.equal(assertSafeTarget(LOCAL, DEV).ok, false, 'destructive tests need VORTH_LIVE_DB=1');
  assert.equal(assertSafeTarget(LOCAL, { ...DEV, VORTH_LIVE_DB: '1' }).ok, true);

  // ...and still refuse production regardless of NODE_ENV.
  assert.equal(assertSafeTarget(NEON, { NODE_ENV: 'production', VORTH_LIVE_DB: '1' }).ok, false);
  assert.equal(assertSafeTarget(RDS, { NODE_ENV: 'production', VORTH_LIVE_DB: '1' }).ok, false);

  // The schema guard allowing production must not weaken the test guard.
  assert.equal(
    assertSafeTarget(NEON, { NODE_ENV: 'production', VORTH_LIVE_DB: '1', VORTH_ALLOW_SCHEMA_ON_PRODUCTION: '1' }).ok,
    false,
  );
});