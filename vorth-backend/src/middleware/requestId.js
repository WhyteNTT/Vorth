const crypto = require('crypto');

/**
 * A correlation id for every request, so a log line can be tied to one.
 *
 * This was on the list from the first pass and never done. The problem it solves is
 * narrow and real: `errorHandler` logs `[error] <err>` with no indication of which
 * request failed, and morgan's `combined` format carries no id either. With
 * concurrent requests, an operator reading a log has a stack trace and no way to
 * find the request that produced it - so the only options are to reproduce the
 * failure or to add logging at every call site, which is worse.
 *
 * Three properties, in order of importance:
 *
 *   - The id reaches the response, so a client reporting a bug can quote something
 *     that appears in the log. That is the whole point: it has to be visible to the
 *     person hitting the problem, not just to us.
 *   - An inbound `X-Request-Id` is honoured, so a request that crossed a proxy or
 *     arrived from another service keeps one identity end to end. It is sanitised
 *     first: an unvalidated header is attacker-controlled and ends up in the logs,
 *     so a caller could inject newlines and forge log entries.
 *   - Generated ids are random, not sequential. A counter would leak request volume
 *     to anyone who can read the response header, and would let one client infer
 *     another's id.
 *
 * The id is attached to `req` so every later middleware and every log can read it
 * without threading it through.
 */

/**
 * Header length and character set. Deliberately tight: this value is written into
 * logs, and a log line is only as trustworthy as the fields in it.
 */
const MAX_LENGTH = 64;
const SAFE = /^[A-Za-z0-9._-]+$/;

/**
 * A caller-supplied id, if it is safe to reuse.
 *
 * Anything with a newline, a space, a control character or more than 64 characters
 * is discarded rather than truncated. Truncating a forged id leaves a valid-looking
 * prefix, which is worse than replacing it: the log would show an id that never
 * matched the request.
 */
function sanitizeInbound(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_LENGTH || !SAFE.test(trimmed)) return null;
  return trimmed;
}

function requestId(req, res, next) {
  const inbound = sanitizeInbound(req.headers['x-request-id']);
  req.id = inbound || crypto.randomUUID();
  res.setHeader('X-Request-Id', req.id);
  next();
}

module.exports = { requestId, sanitizeInbound, MAX_LENGTH };