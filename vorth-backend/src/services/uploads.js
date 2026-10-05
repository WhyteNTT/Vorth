const fs = require('fs');
const path = require('path');
const storage = require('./storage');
const env = require('../config/env');

/*
 * Read through the storage module at call time, not captured here at require time.
 *
 * `const UPLOAD_DIR = storage.UPLOAD_DIR` froze the value when this module was
 * first loaded, which made the sweep untestable: a test could point storage's
 * export at a scratch directory and uploads.js would keep reading the real one.
 * The first attempt at these tests did exactly that, ran against the real uploads/
 * directory, and passed or failed according to whatever happened to be in there -
 * which is why they were removed and rewritten rather than trusted.
 *
 * The behaviour is identical in production; only the indirection changes.
 */
const ORPHAN_MIN_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Deletes uploaded files that were never referenced by a series or chapter.
 *
 * Uploads return a path but write no row of their own, so an abandoned upload
 * used to sit on disk forever. Anything not referenced by a series cover or a
 * comic page, and older than the grace period, is removed.
 *
 * Only the local driver is pruned: object storage lifecycle rules should
 * handle it, and this job issues a DELETE per orphan otherwise.
 */
async function pruneOrphanUploads(_client, { minAgeMs = ORPHAN_MIN_AGE_MS, dryRun = false } = {}) {
  if (env.storageDriver !== 'local') return 0;

  const { pool } = require('../config/db');
  const { rows } = await pool.query(
    `SELECT cover_image AS path FROM "series" WHERE cover_image IS NOT NULL
     UNION
     SELECT page AS path FROM "chapters", jsonb_array_elements_text(pages) AS page
      WHERE pages IS NOT NULL`
  );

  const referenced = new Set(rows.map((r) => path.basename(String(r.path))));
  let removed = 0;

  let entries;
  try {
    entries = fs.readdirSync(storage.UPLOAD_DIR);
  } catch (_) {
    return 0; // uploads directory not created yet
  }

  const cutoff = Date.now() - minAgeMs;
  for (const name of entries) {
    if (name === '.gitkeep' || referenced.has(name)) continue;
    const full = path.join(storage.UPLOAD_DIR, name);
    let stat;
    try { stat = fs.statSync(full); } catch (_) { continue; }
    if (!stat.isFile() || stat.mtimeMs > cutoff) continue;
    if (!dryRun) {
       
      const ok = await storage.localDriver.remove(name);
      if (!ok) continue;
    }
    removed += 1;
  }
  return removed;
}

module.exports = {
  pruneOrphanUploads,
  // A getter, for the same reason the sweep reads it lazily: a captured value
  // cannot be redirected, which is what made this untestable.
  get UPLOAD_DIR() { return storage.UPLOAD_DIR; },
  ORPHAN_MIN_AGE_MS,
};