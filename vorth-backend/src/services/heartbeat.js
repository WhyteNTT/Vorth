'use strict';

/**
 * Keep-warm heartbeat: proof that the scheduled ping is arriving.
 *
 * The free Render instance spins down after 15 minutes idle. A job hitting the app
 * every 5 minutes prevents that, and nothing else about the job is observable: if
 * it silently stops - a missed schedule, an error, a changed URL - the site keeps
 * working perfectly and the only symptom is that the instance starts going cold
 * weeks later.
 *
 * So each ping records itself, and the gap between consecutive pings is the
 * evidence.
 *
 * TWO PROBLEMS, AND WHAT IS DONE ABOUT EACH
 *
 * 1. "When did a ping last arrive?" answers "is it running now", which forgets the
 *    answer. Manual curl, a browser bookmark, an uptime monitor hitting the path
 *    - anything resets last_ping_at and erases the fact that the job had lapsed.
 *    So the largest gap ever observed is kept alongside it. That value only ever
 *    increases, and it cannot be reset by anyone who is not deliberately editing
 *    the database, so evidence of a lapse survives the very act of investigating
 *    it.
 *
 * 2. The original design authenticated the ping with a token generated at boot.
 *    A Render cron job can only issue a plain GET - it cannot set a request
 *    header, and it cannot read a runtime-generated value - so the real job could
 *    never have authenticated and the heartbeat could never have recorded
 *    anything. The site would have looked permanently unverified while a token sat
 *    in the code looking load-bearing.
 *
 *    Authentication was therefore dropped rather than kept as decoration. It was
 *    never protecting anything meaningful: the only consequence of recording a
 *    heartbeat is writing a timestamp, and a successful response to this endpoint
 *    already proves the instance is awake, which is the entire point of the job.
 *
 * One row, not a log. The question is always "is the ping still arriving, and did
 * it ever stop"; a table growing without bound would answer questions nobody asks.
 */

const db = require('../config/db');

/** The service key. Constant: there is exactly one service. */
const SERVICE = 'vorth-api';

/**
 * How long a gap is tolerated before it counts as a lapse.
 *
 * Twice the 5-minute schedule. One late run is scheduler jitter and would raise
 * an alert that turns out to be nothing; two consecutive misses means the job has
 * genuinely stopped. The instance still has not slept at 10 minutes, so this fires
 * with time in hand rather than after a reader has already met a cold start.
 */
const TOLERANCE_SECONDS = 600;

/**
 * Records that a ping arrived, and how long since the previous one.
 *
 * One statement, upsert, no read first. A SELECT-then-write would race two
 * concurrent pings and could leave the row holding the older timestamp - the one
 * value that must never move backwards.
 *
 * The greatest-gap calculation deliberately only ever increases. Comparing against
 * GREATEST() makes that true even if two pings arrive out of order.
 *
 * @returns {Promise<{lastPingAt: Date, maxGapSeconds: number}|null>}
 */
async function record() {
  const { rows } = await db.pool.query(
    `INSERT INTO service_heartbeat (service, last_ping_at, max_gap_seconds)
          VALUES ($1, now(), 0)
     ON CONFLICT (service) DO UPDATE SET
       max_gap_seconds = GREATEST(
         service_heartbeat.max_gap_seconds,
         EXTRACT(EPOCH FROM (now() - service_heartbeat.last_ping_at))::integer
       ),
       last_ping_at = now()
     RETURNING last_ping_at, max_gap_seconds`,
    [SERVICE],
  );
  if (!rows.length) return null;
  return {
    lastPingAt: new Date(rows[0].last_ping_at),
    maxGapSeconds: Number(rows[0].max_gap_seconds) || 0,
  };
}

/**
 * How long ago a ping arrived, in whole seconds.
 *
 * @returns {Promise<number|null>} null when no ping has ever been recorded. Null
 *   is deliberately distinct from 0: "never" and "just now" are different answers,
 *   and conflating them would report a job that never ran as a healthy one.
 */
async function ageSeconds() {
  const { rows } = await db.pool.query(
    'SELECT last_ping_at FROM service_heartbeat WHERE service = $1',
    [SERVICE],
  );
  if (!rows.length) return null;
  const last = new Date(rows[0].last_ping_at).getTime();
  if (Number.isNaN(last)) return null;
  return Math.max(0, Math.floor((Date.now() - last) / 1000));
}

/** The largest gap ever observed between two pings, in seconds. */
async function worstGapSeconds() {
  const { rows } = await db.pool.query(
    'SELECT max_gap_seconds FROM service_heartbeat WHERE service = $1',
    [SERVICE],
  );
  return rows.length ? Number(rows[0].max_gap_seconds) || 0 : null;
}

/**
 * Whether the keep-warm job is doing its job.
 *
 * Two independent questions, because they fail differently:
 *
 *   - is it arriving now? (ageSeconds) - catches a job that just stopped
 *   - did it ever stop? (maxGapSeconds) - catches a lapse that has since been
 *     papered over, which is the one that would otherwise go unnoticed
 *
 * @returns {Promise<{ok: boolean, ageSeconds: number|null,
 *   maxGapSeconds: number|null, toleranceSeconds: number, verdict: string}>}
 */
async function check(toleranceSeconds = TOLERANCE_SECONDS) {
  const age = await ageSeconds();
  const worst = await worstGapSeconds();

  let verdict;
  if (age === null) {
    verdict = 'no ping has ever been recorded';
  } else if (age > toleranceSeconds) {
    verdict = `last ping was ${age}s ago, past the ${toleranceSeconds}s tolerance - the job may have stopped`;
  } else if (worst !== null && worst > toleranceSeconds) {
    verdict = `pings are arriving (last ${age}s ago), but a gap of ${worst}s was seen earlier - the job has lapsed at least once`;
  } else {
    verdict = 'ok';
  }

  return {
    ok: age !== null && age <= toleranceSeconds && !(worst !== null && worst > toleranceSeconds),
    ageSeconds: age,
    maxGapSeconds: worst,
    toleranceSeconds,
    verdict,
  };
}

module.exports = { record, ageSeconds, worstGapSeconds, check, SERVICE, TOLERANCE_SECONDS };