#!/usr/bin/env node
'use strict';

/**
 * Restores content whose DMCA counter-notice response window has lapsed.
 *
 * 17 U.S.C. 512(g)(2)(C) makes restoration permissive — the provider *may*
 * restore once the window passes without a court action. That is why this is a
 * script an operator runs rather than a cron job that fires on its own: a
 * missed or misconfigured job would silently re-expose material that a court
 * order, or a later complaint, is keeping down.
 *
 * Usage:
 *   npm run dmca:sweep-lapsed -- --dry-run
 *
 * Needs a live database. Refuses a managed production host unless
 * VORTH_ALLOW_SCHEMA_ON_PRODUCTION=1, the same guard connectDB() applies.
 */

const { connectDB, pool } = require('../src/config/db');
const env = require('../src/config/env');
const { restoreLapsed } = require('../src/controllers/dmcaCounterNoticeController');

async function main() {
  const dryRun = process.argv.includes('--dry-run');

  // connectDB() runs the host guard, so a managed production database is refused
  // unless VORTH_ALLOW_SCHEMA_ON_PRODUCTION=1 is set. A sweep that silently
  // re-exposed live content is not the kind of mistake to make easy.
  await connectDB();

  const result = await restoreLapsed({ dryRun });
  console.log(`[dmca] checked ${result.checked} lapsed counter-notice(s)`);
  for (const outcome of result.outcomes) {
    const what = (outcome.restored || []).map((r) => `${r.type} ${r.id}`).join(', ');
    console.log(`[dmca] ${outcome.id}: ${outcome.action}${what ? ` (${what})` : ''}`);
    // Anything the guard declined to put back is the interesting part: it means
    // the window lapsed but something else is still keeping the content down.
    for (const kept of outcome.keptDown || []) {
      console.log(`[dmca]   left down: ${kept.type} ${kept.id} - ${kept.reason}`);
    }
  }
  if (!result.outcomes.length) {
    console.log(dryRun ? '[dmca] nothing would be restored' : '[dmca] nothing was restored');
  }

  // Surface anything that was due but deliberately left down, so a sweep that
  // did not restore is not mistaken for a sweep that had nothing to do.
  const skipped = result.outcomes.filter((o) => o.action === 'skipped');
  for (const s of skipped) console.warn(`[dmca] ${s.id} skipped: ${s.reason}`);

  console.log(`[dmca] window length: ${env.dmcaCounterNoticeDays} business days`
    + `${env.dmcaCounterNoticeHolidays.length
      ? `, holidays: ${env.dmcaCounterNoticeHolidays.join(' ')}` : ''}`);
}

main()
  .then(() => pool.end())
  .then(() => process.exit(0))
  .catch(async (err) => {
    console.error(`[dmca] sweep failed: ${err.message}`);
    await pool.end().catch(() => {});
    process.exit(1);
  });
