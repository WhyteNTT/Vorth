#!/usr/bin/env node
'use strict';

/**
 * Rebuilds the PREVIOUS schema in the target database, so the current
 * connectDB() can be exercised against a database that already exists.
 *
 * DESTRUCTIVE — it drops the public schema. Only ever run against a throwaway
 * database; see test/helpers/liveGuard.js for the guard on the live suite.
 *
 *   DATABASE_URL=postgres://.../throwaway node scripts/applyLegacySchema.js
 *
 * The schema is read out of git at a pinned commit rather than copied in here,
 * so there is no second copy to drift.
 */

const path = require('path');
const { execSync } = require('child_process');

/**
 * The last commit before the schema was extended. Pinning matters: reading
 * HEAD would now return the *current* schema, so the upgrade check would apply
 * the new DDL and then assert the new DDL was present - passing while proving
 * nothing.
 */
const PREVIOUS_SCHEMA_COMMIT = 'cfd488b';
const DB_FILE = 'vorth-backend/src/config/db.js';

const repoRoot = path.resolve(__dirname, '..', '..');

let legacy;
try {
  legacy = execSync(`git show ${PREVIOUS_SCHEMA_COMMIT}:${DB_FILE}`, {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });
} catch (_) {
  console.error(`Could not read ${DB_FILE} at commit ${PREVIOUS_SCHEMA_COMMIT}.`);
  console.error('Run this from a full clone of the repository.');
  process.exit(1);
}

const OPEN = 'await pool.query(`';
const start = legacy.indexOf(OPEN);
const end = legacy.indexOf('`);', start);
if (start < 0 || end < 0) {
  console.error(`Could not locate the schema DDL in ${DB_FILE} at ${PREVIOUS_SCHEMA_COMMIT}.`);
  process.exit(1);
}
const ddl = legacy.slice(start + OPEN.length, end);

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required. Refusing to guess.');
  process.exit(1);
}

// Guard against the obvious footgun: this drops the public schema.
if (/[?&](host|hostaddr)=?(?!localhost|127\.0\.0\.1)/i.test(process.env.DATABASE_URL)
  && process.env.VORTH_LIVE_DB_ALLOW_REMOTE !== '1') {
  console.error('Refusing to run against a remote database.');
  console.error('Set VORTH_LIVE_DB_ALLOW_REMOTE=1 if this really is a throwaway host.');
  process.exit(1);
}

const { Pool } = require(path.join(__dirname, '..', 'node_modules', 'pg'));
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'false' ? false : undefined,
});

(async () => {
  console.log(`Dropping everything in the target database...`);
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');

  console.log(`Applying the schema as of ${PREVIOUS_SCHEMA_COMMIT}...`);
  await pool.query(ddl);

  const tables = await pool.query(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = current_schema() AND table_type = 'BASE TABLE' ORDER BY table_name`
  );
  const names = tables.rows.map((r) => r.table_name);

  // If the current schema ever gains a table, this stops being a legacy
  // database and the upgrade check would be vacuous again. Say so loudly.
  const CURRENT_ONLY = ['view_events', 'refresh_tokens', 'auth_tokens', 'rate_limit_buckets'];
  const leaked = CURRENT_ONLY.filter((t) => names.includes(t));
  if (leaked.length) {
    console.error(`\nThe pinned commit already contains: ${leaked.join(', ')}`);
    console.error('It is no longer the pre-upgrade schema. Update PREVIOUS_SCHEMA_COMMIT.');
    await pool.end();
    process.exit(1);
  }

  console.log(`Applied ${names.length} tables: ${names.join(', ')}`);
  console.log('This is now a pre-upgrade database. Boot the app, then run:');
  console.log('  npm run db:verify-schema && npm run db:verify-migration');
  await pool.end();
})().catch((e) => { console.error(e.message); process.exit(1); });