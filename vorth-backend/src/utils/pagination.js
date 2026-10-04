'use strict';

/**
 * How many rows a list endpoint may return.
 *
 * Unbounded list reads are the quiet kind of problem: every one of them works
 * perfectly at the size the data happens to be today, and the response grows
 * until the page stops loading or the process runs out of memory. Three of the
 * queues this applies to only ever grow - one row per claim, per report, per
 * counter notice - so "today's size" is not a stable property of them.
 *
 * The ceiling is deliberately a ceiling and not a page size. These endpoints have
 * no pagination contract with the client and no total count, so returning a
 * partial list silently would be a lie. Instead the list is capped and says so:
 * `truncated` tells the caller the newest rows are here and there are more, which
 * is enough for a moderation queue to be usable and enough for a client to know
 * not to treat the result as complete.
 *
 * The default is generous on purpose. This is a bound against an accident, not a
 * pagination feature; an admin with 200 claims queued is a normal week, and an
 * admin with 20,000 is a problem this makes visible instead of silent.
 */

const DEFAULT_PAGE_SIZE = 200;
const MAX_PAGE_SIZE = 500;

/**
 * The page size for a request, from `?limit=`, clamped to [1, MAX].
 *
 * Clamped rather than trusted: `?limit=1000000` is the query equivalent of an
 * unbounded read, and a caller who can ask for a million rows can ask for a
 * million rows from an endpoint that had a ceiling for a reason.
 */
function pageSize(req) {
  const raw = Number.parseInt(req && req.query && req.query.limit, 10);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_PAGE_SIZE;
  return Math.min(raw, MAX_PAGE_SIZE);
}

module.exports = { pageSize, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE };