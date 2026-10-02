/**
 * Vorth has no seed/mock data by default — a fresh database starts with
 * an empty catalog. This script exists only to clear out Series/Chapter
 * (and optionally Comment) tables if you want a clean slate.
 *
 * Usage:
 *   node scripts/wipeDatabase.js --confirm
 *
 * Add --comments to also clear comments/reviews, and --users to also
 * clear accounts (rarely what you want — off by default).
 */
const { pool, connectDB } = require('../src/config/db');
const Series = require('../src/models/Series');
const Chapter = require('../src/models/Chapter');
const Comment = require('../src/models/Comment');
const User = require('../src/models/User');
const ReadingProgress = require('../src/models/ReadingProgress');
const Notification = require('../src/models/Notification');

// Ordered child -> parent so foreign keys never block a delete.
const PLAN = [
  { flag: null, Model: ReadingProgress, label: 'reading progress' },
  { flag: null, Model: Notification, label: 'notifications' },
  { flag: null, Model: Chapter, label: 'chapters' },
  { flag: null, Model: Series, label: 'series' },
  { flag: '--comments', Model: Comment, label: 'comments' },
  { flag: '--users', Model: User, label: 'users' },
];

async function run() {
  const args = process.argv.slice(2);
  if (!args.includes('--confirm')) {
    console.log('Refusing to run without --confirm. This will permanently delete data.');
    console.log('Usage: node scripts/wipeDatabase.js --confirm [--comments] [--users]');
    process.exit(1);
  }

  await connectDB();

  for (const step of PLAN) {
    if (step.flag && !args.includes(step.flag)) continue;
    const result = await step.Model.deleteMany({});
    console.log(`Removed ${result.deletedCount} ${step.label}.`);
  }

  console.log('Done. The catalog is now empty — no mock books remain.');
  await pool.end();
  process.exit(0);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});