'use strict';
/**
 * READ-ONLY impact assessment. Runs SELECT-only statements; makes no writes.
 * Usage: node scripts/inspectCounts.js
 */
const db = require('../src/config/db');

const TABLES = ['users', 'series', 'chapters', 'comments', 'notifications',
  'reading_progress', 'dmca_reports', 'view_events'];

(async () => {
  for (const t of TABLES) {
    const r = await db.pool.query(`SELECT count(*)::int AS n FROM "${t}"`);
    console.log(t.padEnd(20), r.rows[0].n);
  }
  const users = await db.pool.query(
    'SELECT username, display_name, role, created_at FROM users ORDER BY created_at LIMIT 30'
  );
  console.log('--- users ---');
  users.rows.forEach((u) => console.log(' ', u.username, '|', u.display_name, '|', u.role, '|', u.created_at));
  const series = await db.pool.query('SELECT title, slug, created_at FROM series ORDER BY created_at LIMIT 30');
  console.log('--- series ---');
  series.rows.forEach((s) => console.log(' ', s.title, '|', s.slug, '|', s.created_at));
  await db.pool.end();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });