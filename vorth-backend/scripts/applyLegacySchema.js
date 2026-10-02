#!/usr/bin/env node
/**
 * Rebuilds the PREVIOUS schema in the target database, so the current
 * connectDB() can be exercised against a database that already exists.
 * DESTRUCTIVE — only ever run against a throwaway database.
 *
 *   DATABASE_URL=postgres://.../throwaway node scripts/applyLegacySchema.js
 */
const path = require('path');
const { execSync } = require('child_process');

// Pull the committed schema out of git rather than keeping a stale copy here.
let legacy;
try {
  legacy = execSync('git show HEAD:vorth-backend/src/config/db.js', {
    cwd: path.resolve(__dirname, '..', '..'),
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });
} catch (_) {
  console.error('Could not read the previous schema from git HEAD.');
  console.error('Run this from a checkout of the repository.');
  process.exit(1);
}

const start = legacy.indexOf('await pool.query(`');
const end = legacy.indexOf('`);', start);
if (start < 0 || end < 0) {
  console.error('Could not locate the schema DDL in the previous db.js');
  process.exit(1);
}
const ddl = legacy.slice(start + 'await pool.query(`'.length, end);

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required. Refusing to guess.');
  process.exit(1);
}

const { Pool } = require(path.join(__dirname, '..', 'node_modules', 'pg'));
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'false' ? false : undefined,
});

(async () => {
  console.log('Dropping everything in the target database...');
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  console.log('Applying the PREVIOUS schema (git HEAD)...');
  await pool.query(ddl);
  const tables = await pool.query(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = current_schema() AND table_type = 'BASE TABLE' ORDER BY table_name`
  );
  console.log(`Applied. Tables now present: ${tables.rows.map((r) => r.table_name).join(', ')}`);
  await pool.end();
})().catch((e) => { console.error(e.message); process.exit(1); });