#!/usr/bin/env node
'use strict';

/**
 * Asserts the schema a normal boot produces is actually in place, and that the
 * constraints the application relies on for correctness exist.
 *
 * This replaces a `psql ... | grep -qx 11` line that passed for the wrong
 * reason: the query compared schemaname against the *string* 'current_schema'
 * instead of calling current_schema(), so it counted zero tables and grep was
 * the only thing that failed - with no indication of which table was missing.
 *
 * Deliberately does NOT call connectDB(). Boot re-creates any missing index,
 * so verifying after a boot would silently repair the very thing being checked
 * and the index assertions could never fail. connectDB also only ever runs
 * CREATE TABLE IF NOT EXISTS, so it will not restore a dropped UNIQUE
 * constraint - which is why that assertion had teeth and the others did not.
 * Here the schema is inspected exactly as it stands.
 *
 * Run against a throwaway database. See test/helpers/liveGuard.js for the guard
 * that protects real ones.
 */

const { pool } = require('../src/config/db');

/** Every table the models map onto. */
const TABLES = [
  'users', 'series', 'chapters', 'comments', 'notifications',
  'reading_progress', 'dmca_reports', 'dmca_counter_notices', 'view_events',
  'refresh_tokens', 'auth_tokens', 'rate_limit_buckets', 'content_reports',
];

/**
 * Constraints that are not cosmetic. Each backs an invariant that was
 * previously enforced in application code and could race:
 *   - chapter numbering was computed with a SELECT then an INSERT
 *   - view counting could double-count a concurrent request
 *   - a spent refresh token could be redeemed twice
 */
const UNIQUE_CONSTRAINTS = [
  ['chapters_series_num_key', 'one chapter number per series'],
  ['series_slug_key', 'slug is unique'],
  ['users_email_key', 'email is unique'],
  ['users_username_key', 'username is unique'],
  ['refresh_tokens_token_hash_key', 'a token hash is stored once'],
  ['auth_tokens_token_hash_key', 'a token hash is stored once'],
  ['view_events_chapter_viewer_window_start_key', 'one view per reader per window'],
  ['reading_progress_user_series_key', 'one progress row per user+series'],
  // Without this, a second counter-notice for the same takedown would start a
  // second clock and let a subscriber hold content down indefinitely. The
  // controller also checks, but only the database can settle a race.
  ['idx_counter_notice_unique_report', 'one counter-notice per takedown'],
];

/** Indexes that keep the hot read paths off a sequential scan. */
const REQUIRED_INDEXES = [
  'idx_series_owner', 'idx_series_listing', 'idx_series_popular',
  'idx_series_rating', 'idx_series_title', 'idx_series_genres', 'idx_series_tags',
  // The GIN index over the tsvector. Search is the reason it exists: without it
  // every query falls back to a sequential scan of `series` and nothing else
  // fails visibly - search still returns the right answers, just slowly, on a
  // table that grows without limit.
  'idx_series_search',
  // Backs the daily ranking, which orders on a jsonb expression rather than a
  // column, so it needs its own index to be usable at all.
  'idx_series_daily',
  'idx_chapters_series', 'idx_comments_series', 'idx_comments_user',
  'idx_progress_user', 'idx_notif_user', 'idx_notif_unread',
  'idx_refresh_user', 'idx_refresh_active',
  'idx_authtok_user', 'idx_authtok_expiry',
  'idx_view_events_chap', 'idx_ratelimit_window', 'idx_users_library',
  'idx_dmca_status', 'idx_reports_status', 'idx_reports_series', 'idx_reports_chapter',
  'idx_counter_notice_pending',
];

/** Columns the code reads unconditionally. */
const REQUIRED_COLUMNS = [
  ['users', 'email_verified_at'],
  // Recording what a takedown removed is what makes restoration possible at
  // all; is_removed on its own does not say why content is down.
  ['dmca_reports', 'removal_series'],
  ['dmca_reports', 'removal_chapter'],
  ['dmca_reports', 'removal_at'],
];

async function main() {
  const tables = await pool.query(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'`
  );
  const present = new Set(tables.rows.map((r) => r.table_name));

  if (present.size === 0) {
    console.error('\n  The database has no tables at all.');
    console.error('  Start the server once so the schema is applied, then re-run:\n');
    console.error('    npm start          # or: npm run dev\n');
    console.error('    npm run db:verify-schema\n');
    await pool.end();
    process.exit(1);
  }

  const indexes = await pool.query(
    'SELECT indexname FROM pg_indexes WHERE schemaname = current_schema()'
  );
  const indexNames = new Set(indexes.rows.map((r) => r.indexname));

  const columns = await pool.query(
    `SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = current_schema()`
  );
  const columnSet = new Set(columns.rows.map((r) => `${r.table_name}.${r.column_name}`));

  const missingTables = TABLES.filter((t) => !present.has(t));
  const missingColumns = REQUIRED_COLUMNS
    .filter(([t, c]) => !columnSet.has(`${t}.${c}`))
    .map(([t, c]) => `${t}.${c}`);
  const missingUnique = UNIQUE_CONSTRAINTS
    .filter(([idx]) => !indexNames.has(idx))
    .map(([idx, why]) => `${idx} (${why})`);
  const missingIndexes = REQUIRED_INDEXES.filter((i) => !indexNames.has(i));

  const report = [
    [`all ${TABLES.length} tables exist`, missingTables.length === 0],
    [`${REQUIRED_COLUMNS.length} required column(s) exist`, missingColumns.length === 0],
    [`${UNIQUE_CONSTRAINTS.length} correctness-critical UNIQUE constraints exist`, missingUnique.length === 0],
    [`${REQUIRED_INDEXES.length} read-path indexes exist`, missingIndexes.length === 0],
  ];

  console.log('\n  SCHEMA CHECK (inspected as-is; nothing is created or repaired)');
  console.log('  ' + '-'.repeat(66));
  console.log(`  ${present.size} table(s), ${indexNames.size} index(es), ${columns.rowCount} column(s)\n`);
  for (const [label, ok] of report) console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  console.log('  ' + '-'.repeat(66));

  const failures = [
    missingTables.length && `missing tables: ${missingTables.join(', ')}`,
    missingColumns.length && `missing columns: ${missingColumns.join(', ')}`,
    missingUnique.length && `missing UNIQUE constraints: ${missingUnique.join(', ')}`,
    missingIndexes.length && `missing indexes: ${missingIndexes.join(', ')}`,
  ].filter(Boolean);

  if (failures.length) {
    console.error('\n  Details:');
    for (const f of failures) console.error(`    - ${f}`);
    console.error('');
    await pool.end();
    process.exit(1);
  }

  console.log(`  ${report.length}/${report.length} passed\n`);
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });