'use strict';

/**
 * The orphan-upload sweep, which is what actually bounds the upload directory.
 *
 * This is the other half of the upload rate limit. The limiter caps how fast a
 * client can write; the sweep is what removes what was written and never attached
 * to anything. With STORAGE_DRIVER=local and no disk ceiling anywhere in the
 * codebase, the sweep is the only thing standing between a burst of uploads and a
 * full disk.
 *
 * It sat at 79% statements and 29% branch, with the interesting paths untested:
 * the non-local early return, the missing-directory return, a referenced file, a
 * file young enough to keep, a removal that fails, and dryRun.
 *
 * The failure modes that matter are all about deleting the wrong thing, so the
 * assertions below are about which files survive - not about the return value. A
 * sweep that reported a plausible count while removing a referenced cover would
 * pass a test that only checked the number.
 */

process.env.DATABASE_URL ||= 'postgres://stub/stub';
process.env.DATABASE_SSL = 'false';
process.env.JWT_SECRET ||= 'test-secret';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const env = require('../src/config/env');
const storage = require('../src/services/storage');
const { ORPHAN_MIN_AGE_MS } = require('../src/services/uploads');

/**
 * Runs the sweep over a scratch directory with a scripted set of files.
 *
 * `store` is the fingerprint the storage layer returns for a removal, so a driver
 * that fails can be simulated. The real filesystem is used rather than a fake,
 * because the thing under test reads directory entries and stats them.
 */
async function sweep(files, {
  driver = 'local',
  removeOk = true,
  dryRun = false,
  runs = 1,
} = {}) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'vorth-prune-'));
  const now = Date.now();

  for (const f of files) {
    const full = path.join(scratch, f.name);
    fs.writeFileSync(full, f.body || 'x');
    if (f.ageMs !== undefined) {
      const when = new Date(now - f.ageMs);
      fs.utimesSync(full, when, when);
    }
  }

  /*
   * What has to be redirected, and why each one is awkward.
   *
   * uploads.js captures `UPLOAD_DIR` into a module-level const at require time
   * (line 6), so reassigning `storage.UPLOAD_DIR` afterwards does nothing to it.
   * The exported binding is what the test replaces instead.
   *
   * db exports `pool` as a getter over an internal variable, and `uploads.js`
   * reads it through the documented `setPool` seam - so the pool is redirected
   * with setPool rather than by poking at properties. Reaching into db's
   * internals with defineProperty was tried first and is wrong twice over: it
   * bypasses the seam the rest of the suite uses, and it fights the getter.
   *
   * `localDriver` is a plain export, so it is replaced directly.
   */
  const uploads = require('../src/services/uploads');
  const db = require('../src/config/db');

  const realDir = storage.UPLOAD_DIR;
  const realDriver = storage.localDriver;
  const realDriverEnv = env.storageDriver;
  const hadPool = Boolean(db.pool);

  Object.defineProperty(storage, 'UPLOAD_DIR', { value: scratch, configurable: true });
  Object.defineProperty(storage, 'localDriver', {
    value: {
      /*
       * Deletes, then reports success. Returning true without unlinking was the
       * first version, and it produced a test that reported "removed 1" with the
       * file still on disk - the assertions are about survivors precisely so that
       * a count alone cannot pass.
       */
      remove: async (name) => {
        if (!removeOk) return false;
        const full = path.join(scratch, name);
        if (!fs.existsSync(full)) return false;
        fs.unlinkSync(full);
        return true;
      },
    },
    configurable: true,
  });
  db.setPool({
    query: async () => ({
      rows: [{ path: 'referenced.jpg' }, { path: 'chapter/page.png' }],
    }),
  });
  env.storageDriver = driver;

  try {
    const counts = [];
    for (let i = 0; i < runs; i += 1) {
      counts.push(await uploads.pruneOrphanUploads(null, { dryRun }));
    }
    const survivors = fs.existsSync(scratch) ? fs.readdirSync(scratch).sort() : [];
    return { removed: counts[0], counts, survivors };
  } finally {
    Object.defineProperty(storage, 'UPLOAD_DIR', { value: realDir, configurable: true });
    Object.defineProperty(storage, 'localDriver', { value: realDriver, configurable: true });
    env.storageDriver = realDriverEnv;
    db.setPool(hadPool ? db.pool : null);
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

/** Old enough to be swept. Comfortably past the default grace period. */
const ANCIENT = ORPHAN_MIN_AGE_MS + 60_000;

test('an unreferenced old file is removed', async () => {
  const { removed, survivors } = await sweep([
    { name: 'orphan.jpg', ageMs: ANCIENT },
  ]);
  assert.equal(removed, 1);
  assert.deepEqual(survivors, [], 'the orphan survived the sweep');
});

test('a file that is still referenced is kept, however old', async () => {
  /*
   * The destructive failure. A referenced cover is the difference between a
   * working site and a site with broken images, and the age check runs before the
   * reference check would matter to a reader - so this is the assertion that says
   * the reference check comes first.
   */
  const { removed, survivors } = await sweep([
    { name: 'referenced.jpg', ageMs: ANCIENT },
  ]);
  assert.equal(removed, 0, 'a referenced file was swept');
  assert.deepEqual(survivors, ['referenced.jpg']);
});

test('a referenced chapter page is kept, and the reference is matched on basename', async () => {
  // The query returns `chapter/page.png` while the directory holds `page.png`, so
  // matching on the full path would delete every page image on the site.
  const { removed, survivors } = await sweep([
    { name: 'page.png', ageMs: ANCIENT },
  ]);
  assert.equal(removed, 0, 'a referenced chapter page was swept');
  assert.deepEqual(survivors, ['page.png']);
});

test('a fresh unreferenced file is kept, because the grace period has not passed', async () => {
  /*
   * A user uploads pages and then attaches them. The sweep must not race that, so
   * anything inside the grace period is left alone.
   */
  const { removed, survivors } = await sweep([
    { name: 'just-uploaded.jpg', ageMs: 1000 },
  ]);
  assert.equal(removed, 0);
  assert.deepEqual(survivors, ['just-uploaded.jpg']);
});

test('the grace period boundary is respected from both sides', async () => {
  // Precisely inside and precisely outside, rather than one comfortably each way.
  const { survivors } = await sweep([
    { name: 'inside.jpg', ageMs: ORPHAN_MIN_AGE_MS - 60_000 },
    { name: 'outside.jpg', ageMs: ORPHAN_MIN_AGE_MS + 60_000 },
  ]);
  assert.ok(survivors.includes('inside.jpg'), 'a file inside the grace period was swept');
  assert.ok(!survivors.includes('outside.jpg'), 'a file past the grace period was kept');
});

test('.gitkeep is never removed', async () => {
  const { removed, survivors } = await sweep([
    { name: '.gitkeep', ageMs: ANCIENT },
  ]);
  assert.equal(removed, 0);
  assert.deepEqual(survivors, ['.gitkeep']);
});

test('a removal the storage driver refuses leaves the file in place and uncounted', async () => {
  /*
   * The failure branch. `removed` is incremented after the driver says yes, so a
   * refused removal is not counted - and the file survives. Counting it anyway
   * would make the sweep's log claim work it did not do, which is how a disk fills
   * up while the logs look healthy.
   */
  const { removed, survivors } = await sweep(
    [{ name: 'stuck.jpg', ageMs: ANCIENT }],
    { removeOk: false },
  );
  assert.equal(removed, 0, 'a refused removal was counted as a success');
  assert.deepEqual(survivors, ['stuck.jpg'], 'the file was reported gone but is still there');
});

test('dryRun reports what it would remove and removes nothing', async () => {
  /*
   * The mode an operator uses to find out what is safe to delete. If it deleted
   * anything, the inspection itself would be destructive.
   */
  const { removed, survivors } = await sweep([
    { name: 'orphan-a.jpg', ageMs: ANCIENT },
    { name: 'orphan-b.jpg', ageMs: ANCIENT },
    { name: 'referenced.jpg', ageMs: ANCIENT },
  ], { dryRun: true });

  assert.equal(removed, 2, 'dryRun did not report the two orphans');
  assert.deepEqual(survivors, ['orphan-a.jpg', 'orphan-b.jpg', 'referenced.jpg'],
    'dryRun deleted files');
});

test('a non-local storage driver is not swept at all', async () => {
  /*
   * With object storage the files are not on this disk, and the lifecycle rules
   * there handle removal. Running the sweep anyway would delete local files that
   * are irrelevant to the bucket, or worse, report a count that means nothing.
   */
  const { removed, survivors } = await sweep([
    { name: 'orphan.jpg', ageMs: ANCIENT },
  ], { driver: 's3' });

  assert.equal(removed, 0, 'a non-local driver was swept');
  assert.deepEqual(survivors, ['orphan.jpg']);
});

test('a directory containing only referenced and fresh files reports zero', async () => {
  // The quiet-day case, which is what the cron job normally sees. Worth pinning
  // because a sweep that reported work when there was none would page someone.
  const { removed, survivors } = await sweep([
    { name: 'referenced.jpg', ageMs: ANCIENT },
    { name: 'fresh.jpg', ageMs: 1000 },
    { name: '.gitkeep', ageMs: ANCIENT },
  ]);
  assert.equal(removed, 0);
  assert.equal(survivors.length, 3);
});

test('the sweep is safe to run twice in a row', async () => {
  // Idempotence: the second pass has nothing left to do, and must not error or
  // count the same file twice.
  const { counts, survivors } = await sweep(
    [{ name: 'orphan.jpg', ageMs: ANCIENT }],
    { runs: 3 },
  );

  assert.deepEqual(counts, [1, 0, 0],
    'a second or third sweep over the same directory should find nothing left to do');
  assert.deepEqual(survivors, [], 'the orphan is still on disk');
});