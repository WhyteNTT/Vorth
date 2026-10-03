'use strict';

/**
 * Business-day arithmetic for the DMCA counter-notice window.
 *
 * 17 U.S.C. 512(g)(2)(C) gives the original complainant 10 to 14 *business
 * days* from the day the counter-notice is forwarded to notify the service
 * provider that it has filed a court action. If it does not, the provider may
 * restore the removed material.
 *
 * Two things worth being explicit about:
 *
 *   - "business days" excludes weekends. Public holidays are NOT excluded.
 *     Counting them properly needs an authoritative holiday calendar per
 *     jurisdiction, and a wrong one silently shifts a statutory deadline in the
 *     direction that is worse for the complainant. Weekends only is the
 *     conservative choice: the deadline lands later rather than earlier. A
 *     deployment that needs holidays should pass them in.
 *   - the count starts the day AFTER the forwarded date. Day zero is not a day
 *     the complainant gets to act on.
 */

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Midnight UTC on the given day, so counting is not at the mercy of a TZ. */
function startOfDay(date) {
  const d = new Date(date);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function isWeekend(date) {
  const day = new Date(date).getUTCDay();
  return day === 0 || day === 6;
}

/** YYYY-MM-DD in UTC, for a stable, timezone-free key. */
function isoDay(date) {
  return new Date(date).toISOString().slice(0, 10);
}

/**
 * Adds `count` business days to `from`.
 *
 * @param {Date|string} from     the starting day (day zero)
 * @param {number} count         business days to add
 * @param {string[]} [holidays]  ISO YYYY-MM-DD dates not to count
 * @returns {Date} midnight UTC on the resulting day
 */
function addBusinessDays(from, count, holidays = []) {
  const skip = new Set(holidays);
  if (!Number.isInteger(count) || count < 0) {
    throw new RangeError(`addBusinessDays: count must be a non-negative integer, got ${count}`);
  }
  if (count === 0) return new Date(startOfDay(from));

  let cursor = startOfDay(from).getTime();
  let remaining = count;
  // Bounded so a pathological holiday list cannot spin forever.
  let guard = 0;
  const limit = count * 4 + 400;

  while (remaining > 0) {
    guard += 1;
    if (guard > limit) {
      throw new Error(`addBusinessDays: gave up after ${limit} days; check the holiday list`);
    }
    cursor += MS_PER_DAY;
    const d = new Date(cursor);
    if (isWeekend(d)) continue;
    if (skip.has(isoDay(d))) continue;
    remaining -= 1;
  }
  return new Date(cursor);
}

/**
 * Whole business days between two instants, never negative.
 *
 * Used to answer "is the window still open?", so a clock skew or a late job
 * cannot produce a negative age and read as "long expired".
 */
function businessDaysBetween(from, to) {
  let cursor = startOfDay(from).getTime();
  const end = startOfDay(to).getTime();
  if (end <= cursor) return 0;
  let days = 0;
  let guard = 0;
  while (cursor < end) {
    guard += 1;
    if (guard > 100000) throw new Error('businessDaysBetween: range too large');
    cursor += MS_PER_DAY;
    if (!isWeekend(new Date(cursor))) days += 1;
  }
  return days;
}

/**
 * The statutory window: forward date plus 10 business days, the earliest
 * point at which restoration may be permitted.
 */
function counterNoticeDeadline(forwardedAt, { businessDays = 10, holidays } = {}) {
  return addBusinessDays(forwardedAt, businessDays, holidays);
}

module.exports = {
  addBusinessDays,
  businessDaysBetween,
  counterNoticeDeadline,
  isWeekend,
  startOfDay,
  isoDay,
  MS_PER_DAY,
};