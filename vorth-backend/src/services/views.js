const { withTransaction } = require('../config/db');

const DAILY_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * A stable, non-reversible identifier for an anonymous reader.
 * Signed-in readers use their account id so a view follows the reader
 * across devices rather than counting once per IP.
 */
function viewerKey(req) {
  if (req.user && req.user.id) return `u:${req.user.id}`;
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || 'unknown';
  const agent = req.headers['user-agent'] || '';
  return `a:${ip}|${agent}`;
}

/**
 * Records one view, at most once per viewer per chapter per day.
 *
 * Previously every GET incremented unconditionally, which meant rankings
 * were inflated by a single client looping the endpoint. The UNIQUE
 * constraint on view_events makes the counter idempotent, so the insert is
 * the gate: if it conflicts, nothing is counted.
 */
async function recordView({ seriesId, chapterId, viewer }) {
  const windowStart = new Date(Math.floor(Date.now() / DAILY_WINDOW_MS) * DAILY_WINDOW_MS);

  return withTransaction(async (client) => {
    const inserted = await client.query(
      `INSERT INTO "view_events" ("series", "chapter", "viewer", "window_start")
       VALUES ($1, $2, $3, $4)
       ON CONFLICT ("chapter", "viewer", "window_start") DO NOTHING
       RETURNING "id"`,
      [seriesId, chapterId, viewer, windowStart]
    );

    if (!inserted.rows.length) return { counted: false };

    await client.query(
      `UPDATE "chapters" SET "views" = "views" + 1, "updated_at" = now() WHERE "id" = $1`,
      [chapterId]
    );

    await client.query(
      `UPDATE "series"
          SET "views" = jsonb_set(
                jsonb_set(
                  jsonb_set(COALESCE("views", '{}'::jsonb), '{daily}',
                    to_jsonb(COALESCE(("views"->>'daily')::bigint, 0) + 1), true),
                  '{weekly}',
                    to_jsonb(COALESCE(("views"->>'weekly')::bigint, 0) + 1), true),
                '{alltime}',
                  to_jsonb(COALESCE(("views"->>'alltime')::bigint, 0) + 1), true),
              "updated_at" = now()
        WHERE "id" = $1`,
      [seriesId]
    );

    return { counted: true };
  });
}

/** Drops view_events rows older than the retention window. */
async function pruneViewEvents(client, days = 3) {
  const { rowCount } = await client.query(
    `DELETE FROM "view_events" WHERE "window_start" < now() - ($1 || ' days')::interval`,
    [String(days)]
  );
  return rowCount;
}

module.exports = { recordView, viewerKey, pruneViewEvents, DAILY_WINDOW_MS };