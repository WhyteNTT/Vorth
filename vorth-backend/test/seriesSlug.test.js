'use strict';

/**
 * Slug generation and the collision retry, in `Series.create`.
 *
 * The uncovered branches were all in the slug path, and they are the ones that only
 * matter when something goes wrong — which is exactly why they had nothing checking
 * them.
 *
 * Two behaviours are load-bearing:
 *
 *   - A slug collision is retried with a random suffix, up to a limit. Slugs are
 *     derived from titles, so two authors publishing "Untitled" collide on the first
 *     attempt every time. Without the retry, the second one gets a 500 for no
 *     reason the API explains.
 *   - After the limit, the error is rethrown rather than swallowed. Retrying
 *     forever against a constraint that will not clear is a hang, not a retry.
 *
 * The retry also has to distinguish a *slug* collision from any other unique
 * violation. Treating every 23505 as a slug conflict means a collision on some other
 * column gets retried five times and then reported as if it were the slug's fault.
 */

process.env.DATABASE_URL ||= 'postgres://stub/stub';
process.env.DATABASE_SSL = 'false';
process.env.JWT_SECRET ||= 'test-secret';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');

/** A 23505 the way PostgreSQL reports a duplicate key. */
function uniqueViolation(detail) {
  const err = new Error('duplicate key value violates unique constraint');
  err.code = '23505';
  err.detail = detail;
  return err;
}

const SLUG_DETAIL = 'Key (slug)=(a-novel) already exists.';
const OTHER_DETAIL = 'Key (owner, title)=(someone, A Novel) already exists.';

/**
 * Runs Series.create against a pool that fails its first `n` inserts.
 *
 * Uses the real model, so `slugify`, the retry loop and the attempt counter are the
 * shipping ones. Only the database is a double, and the double is told exactly what
 * to throw.
 */
async function createWithFailures(failures, data) {
  const db = require('../src/config/db');
  const Base = require('../src/models/_base');
  Base._clearColumnCache();

  const attempts = [];

  const fake = {
    async query(sql, params = []) {
      if (/^INSERT INTO "series"/.test(sql)) {
        const slug = params.find((p) => typeof p === 'string' && /^[a-z0-9-]+$/.test(p));
        attempts.push({ sql, params, slug });

        if (failures.length) throw failures.shift();

        /*
         * RETURNING * with one row.
         *
         * Returning `{ rows: [] }` looks harmless and is not: the model hydrates
         * from the returned row, so an empty result throws "Cannot convert undefined
         * or null to object" - which the retry loop then reads as a non-unique error
         * and rethrows. The retry appeared not to work when the double, not the
         * code, was at fault; measured by printing the statements, which showed both
         * attempts going out with the right slugs.
         */
        const row = { id: '44444444-4444-4444-8444-444444444444', ...Object.fromEntries(params.map((v, i) => [
          ['title', 'slug', 'author', 'type', 'synopsis', 'cover_image'][i] || `c${i}`,
          v,
        ])) };
        return { rows: [row], rowCount: 1 };
      }
      // The column cache query the model issues before its first insert.
      if (/information_schema\.columns/.test(sql)) {
        return { rows: [
          { column_name: 'id' }, { column_name: 'title' }, { column_name: 'slug' },
          { column_name: 'author' }, { column_name: 'type' }, { column_name: 'synopsis' },
        ], rowCount: 6 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
  db.setPool(fake);

  const Series = require('../src/models/Series');
  try {
    const created = await Series.create(data);
    return { created, attempts, error: null };
  } catch (error) {
    return { created: null, attempts, error };
  } finally {
    db.setPool(null);
    Base._clearColumnCache();
  }
}

test('a slug is derived from the title when none is supplied', async () => {
  const { attempts } = await createWithFailures([], { title: 'A Novel' });
  assert.equal(attempts.length, 1, 'a plain create should not retry');
  assert.equal(attempts[0].slug, 'a-novel');
});

test('a supplied slug is used as given', async () => {
  // An author's own slug is a deliberate choice - it is in their share links - so it
  // must not be slugified out from under them.
  const { attempts } = await createWithFailures([], { title: 'A Novel', slug: 'my-chosen-slug' });
  assert.equal(attempts[0].slug, 'my-chosen-slug');
});

test('a title with no slugifiable characters still produces a slug', async () => {
  /*
   * `slugify('!!!')` is empty, so without the final fallback the INSERT would carry
   * an empty slug - which is unique only once, and then every such title collides
   * with the first. 'untitled' is a placeholder that at least makes the collision
   * visible as the retry it is.
   */
  const { attempts } = await createWithFailures([], { title: '!!! ???' });
  assert.ok(attempts[0].slug, 'the slug is empty');
  assert.equal(typeof attempts[0].slug, 'string');
});

test('a slug collision is retried with a different candidate', async () => {
  const { created, attempts } = await createWithFailures(
    [uniqueViolation(SLUG_DETAIL)],
    { title: 'A Novel' },
  );

  assert.equal(attempts.length, 2, `expected one retry, saw ${attempts.length} attempts`);
  assert.equal(attempts[0].slug, 'a-novel');
  assert.notEqual(attempts[1].slug, attempts[0].slug,
    'the retry reused the same slug, so it would collide again');
  assert.match(attempts[1].slug, /^a-novel-\d+-[0-9a-f]{6}$/,
    `the retry slug is not a distinguishable variant: ${attempts[1].slug}`);
  assert.ok(created, 'the retry did not produce a series');
});

test('several collisions in a row are all retried', async () => {
  const { attempts } = await createWithFailures(
    [uniqueViolation(SLUG_DETAIL), uniqueViolation(SLUG_DETAIL), uniqueViolation(SLUG_DETAIL)],
    { title: 'A Novel' },
  );
  assert.equal(attempts.length, 4, `expected four attempts, saw ${attempts.length}`);
  assert.equal(new Set(attempts.map((a) => a.slug)).size, 4,
    'a retry reused an earlier slug, so it would have collided again');
});

test('the retry gives up rather than looping forever', async () => {
  /*
   * The limit. Five attempts then rethrow. A retry loop with no ceiling is a hang
   * against a constraint that will not clear, and it holds the request open while it
   * does it.
   */
  const { attempts, error } = await createWithFailures(
    Array.from({ length: 20 }, () => uniqueViolation(SLUG_DETAIL)),
    { title: 'A Novel' },
  );

  assert.ok(error, 'an endless collision sequence returned success');
  assert.equal(error.code, '23505', 'the original error was not surfaced');
  assert.equal(attempts.length, 5, `expected the loop to stop at 5 attempts, made ${attempts.length}`);
});

test('a collision on another column is not retried as a slug conflict', async () => {
  /*
   * The distinction. The retry keys on `23505` *and* the word "slug" in the detail.
   * Without the second half, a duplicate on any other unique constraint is retried
   * five times and then reported as a slug problem, which sends whoever is debugging
   * to look at the wrong column.
   *
   * This one caught a mutant the others missed, and it is worth saying why: the
   * detail string is checked, but the first version of this case supplied a detail
   * containing the word "slug" nowhere while *also* relying on the code falling back
   * to `err.message`, which said "duplicate key value violates unique constraint" and
   * has no column name in it at all. Both paths therefore failed the test for the
   * wrong reason.
   *
   * Asserted on both spellings now - a detail naming the other column, and a driver
   * that reports only a generic message - because both are what real drivers do, and
   * a retry keyed on 23505 alone would spin five times on either.
   */
  for (const detail of [OTHER_DETAIL, undefined]) {
    const violation = detail
      ? uniqueViolation(detail)
      : Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' });

    const { attempts, error } = await createWithFailures([violation], { title: 'A Novel' });

    assert.equal(attempts.length, 1,
      `a non-slug collision${detail ? '' : ' with no detail'} was retried as a slug conflict`);
    assert.ok(error, 'a non-slug collision returned success');
    assert.equal(error.code, '23505');
  }
});

test('an error that is not a unique violation is not retried at all', async () => {
  const { attempts, error } = await createWithFailures(
    [Object.assign(new Error('connection terminated'), { code: '08006' })],
    { title: 'A Novel' },
  );
  assert.equal(attempts.length, 1, 'a connection error was retried');
  assert.equal(error.code, '08006', 'the original error was replaced');
});

test('a failure with no error code is not retried', async () => {
  // `err && err.code` guards against a rejection with a non-Error value, which is
  // what a promisified callback rejecting on a string produces.
  const { attempts, error } = await createWithFailures([{ notAnError: true }], { title: 'A Novel' });
  assert.equal(attempts.length, 1, 'a malformed rejection was retried');
  assert.ok(error, 'a malformed rejection returned success');
});

test('the retried insert carries the same payload, only the slug differs', async () => {
  // Otherwise a retry silently publishes the series with the fields the first
  // attempt had, which is not the same series.
  const { attempts } = await createWithFailures([uniqueViolation(SLUG_DETAIL)], {
    title: 'A Novel', author: 'Alice', type: 'novel', synopsis: 'Prose.',
  });

  /*
   * The slug is not params[0]. The model emits `INSERT INTO "series" ("title",
   * "slug", ...) VALUES ($1, $2, ...)` and puts its own slug in last position,
   * after the caller-supplied fields — so the two attempts differ in their *last*
   * parameter, and comparing everything else as one sorted blob mixed the old slug in
   * with the stable fields.
   */
  const [first, second] = attempts.map((a) => a.params);
  assert.equal(first[first.length - 1], 'a-novel', `the first attempt's slug was ${first.at(-1)}`);
  assert.ok(second.at(-1).startsWith('a-novel-'),
    `the retry's slug was ${second.at(-1)}`);
  assert.deepEqual(second.slice(0, -1), first.slice(0, -1),
    'the retry changed something other than the slug');
});

/* ================================================================== *
 * The chapter counter
 * ================================================================== */

test('nextChapterNumber throws when the series is not found', async () => {
  /*
   * `RETURNING` on an UPDATE that matched nothing yields no rows. Without this throw
   * the caller gets `undefined` as a chapter number, which becomes `num = undefined`
   * in an INSERT and fails with a confusing constraint error about a null.
   */
  const db = require('../src/config/db');
  const Series = require('../src/models/Series');
  db.setPool({ query: async () => ({ rows: [] }) });

  try {
    await assert.rejects(
      () => Series.nextChapterNumber('00000000-0000-0000-0000-000000000000'),
      /not found/,
      'a missing series returned a chapter number instead of failing',
    );
  } finally {
    db.setPool(null);
  }
});