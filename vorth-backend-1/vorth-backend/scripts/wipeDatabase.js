/**
 * Vorth has no seed/mock data by default — a fresh database starts with
 * an empty catalog. This script exists only to clear out Series/Chapter
 * (and optionally Comment) collections if you were previously running
 * the old mock-data version and want a clean slate.
 *
 * Usage:
 *   node scripts/wipeDatabase.js --confirm
 *
 * Add --comments to also clear comments/reviews, and --users to also
 * clear accounts (rarely what you want — off by default).
 */
const env = require('../src/config/env');
const connectDB = require('../src/config/db');
const Series = require('../src/models/Series');
const Chapter = require('../src/models/Chapter');
const Comment = require('../src/models/Comment');
const User = require('../src/models/User');
const mongoose = require('mongoose');

async function run() {
  const args = process.argv.slice(2);
  if (!args.includes('--confirm')) {
    console.log('Refusing to run without --confirm. This will permanently delete data.');
    console.log('Usage: node scripts/wipeDatabase.js --confirm [--comments] [--users]');
    process.exit(1);
  }

  await connectDB();

  const seriesResult = await Series.deleteMany({});
  const chapterResult = await Chapter.deleteMany({});
  console.log(`Removed ${seriesResult.deletedCount} series and ${chapterResult.deletedCount} chapters.`);

  if (args.includes('--comments')) {
    const commentResult = await Comment.deleteMany({});
    console.log(`Removed ${commentResult.deletedCount} comments.`);
  }

  if (args.includes('--users')) {
    const userResult = await User.deleteMany({});
    console.log(`Removed ${userResult.deletedCount} users.`);
  }

  console.log('Done. The catalog is now empty — no mock books remain.');
  await mongoose.connection.close();
  process.exit(0);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
