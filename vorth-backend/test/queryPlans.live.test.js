'use strict';

/**
 * Query plans for the hot paths, checked against a real PostgreSQL.
 *
 * Phase 5 of this work promised EXPLAIN (ANALYZE, BUFFERS) on the hot paths and
 * never ran it. That is the check review cannot do: an index that is never used
 * looks identical to one that is, and a query that scans sequentially still
 * returns correct answers while getting slower as the catalogue grows.
 *
 * The whole file is built around one honest difficulty. At a few hundred rows
 * PostgreSQL is *right* to choose a sequential scan - it genuinely is cheaper -
 * so asserting "no sequential scan" at that size would be asserting that the
 * planner is stupid. So the table is seeded well past the point where the
 * planner has a real reason to prefer an index, and the assertions are about
 * whether an index *can* serve the query at catalogue scale.
 *
 * Where that is what is being checked, `enable_seqscan = off` is set for the
 * duration of the statement. That does not prove the planner would choose the
 * index; it proves the index can answer the query at all. An index that cannot
 * serve a lookup answers with a sequential scan anyway even with the escape
 * hatch open, which is exactly the failure this catches. Cost-based preference
 * is a separate claim and is asserted separately, by comparing plans.
 *
 * Plans are asserted structurally - node types, index names, actual row counts -
 * rather than against captured plan text, which changes between PostgreSQL
 * versions and would turn this into a brittle fixture. ANALYZE is run after
 * seeding, so every plan here is one the planner produced against real
 * statistics rather than against an empty table.
 *
 * Needs a real database with the real schema, so it lives with the live suites.
 */

process.env.DATABASE_URL ||= 'postgres://stub/stub';
process.env.DATABASE_SSL = 'false';
process.env.JWT_SECRET ||= 'test-secret';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const liveGuard = require('./helpers/liveGuard');

/*
 * Large enough that the planner treats the indexes as worth using. Four hundred
 * rows is comfortably inside the range where a sequential scan is the correct
 * choice, and asserting against it would prove nothing.
 */
const SEED_ROWS = 4000;

if (process.env.VORTH_LIVE_DB !== '1') {
  test('query plans against a real PostgreSQL', { skip: 'live database tests disabled' }, () => {});
} else {
  liveGuard.assertSafeTarget(process.env.DATABASE_URL, 'test/queryPlans.live.test.js');

  const db = require('../src/config/db');

  let owner = null;
  let seeded = [];

  /*
   * Runs EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) and returns the root plan node.
   *
   * `opts.client` pins the statement to an existing transaction, which is how the
   * counter-reset test gets its count and its rewrite onto one snapshot. Without
   * it both go to the pool and can land on different connections, and a
   * transaction on the caller's connection would not see them at all.
   */
  async function plan(sql, params = [], opts = {}) {
    const client = opts.client || db.pool;
    const settings = opts.settings || {};
    const apply = Object.keys(settings).map((k) => `SET ${k} = ${settings[k]}`).join('; ');
    if (apply) await client.query(apply);
    try {
      const { rows } = await client.query(
        `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`, params,
      );
      // FORMAT JSON parses server-side, so this is already an array of
      // `{ Plan, Planning Time, Execution Time }` and the root node is under
      // `Plan`. Reaching for the array directly returns the envelope and every
      // lookup below reads undefined.
      return rows[0]['QUERY PLAN'][0].Plan;
    } finally {
      if (apply) {
        await client.query(Object.keys(settings).map((k) => `RESET ${k}`).join('; '));
      }
    }
  }

  /** Every node in the plan, flattened. */
  function nodes(root, out = []) {
    out.push(root);
    for (const child of root.Plans || []) nodes(child, out);
    return out;
  }

  const nodeTypes = (root) => nodes(root).map((n) => n['Node Type']);
  const indexesUsed = (root) => nodes(root).flatMap((n) => (n['Index Name'] ? [n['Index Name']] : []));
  const totalCost = (root) => Number(root['Total Cost']);
  const rowsActually = (root) => Number(root['Actual Rows']);

  /**
   * Rows a write actually visited.
   *
   * For an UPDATE the root node is `ModifyTable`, and its Actual Rows is 0 no
   * matter how many rows it changed - verified, not assumed:
   *
   *   non_zero rows: 1
   *   ModifyTable  -> Actual Rows: 0
   *   Seq Scan     -> Actual Rows: 1
   *
   * So reading the root would have made the counter test below assert that the
   * reset visits no rows, which is what a missing WHERE clause would also report.
   * The number that matters is the scan's output: rows matched and therefore
   * rewritten.
   */
  function rowsVisited(root) {
    const scans = nodes(root).filter((n) => /Scan$/.test(n['Node Type'] || ''));
    assert.ok(scans.length > 0,
      `no scan node in the plan, so there is nothing to count: ${nodeTypes(root).join(' > ')}`);
    return scans.reduce((total, n) => total + Number(n['Actual Rows']) * Number(n['Actual Loops']), 0);
  }

  test.before(async () => {
    const { rows: u } = await db.pool.query(
      `INSERT INTO users (display_name, username, email, password, agreed_to_terms_at)
       VALUES ('Plan Probe', $1, $2, 'hash', now()) RETURNING id`,
      [`plan_probe_${process.pid}`,
        `plan_probe_${process.pid}@example.com`],
    );
    owner = u[0].id;

    /*
     * Inserted in one statement so this does not take a minute.
     *
     * search_vector is deliberately absent: it is a GENERATED column derived from
     * the title and synopsis, so PostgreSQL computes it per row and rejects any
     * attempt to supply one ("cannot insert a non-DEFAULT value into column
     * search_vector"). That is better anyway - the index test below then runs
     * against a vector the database actually built, not one assembled here.
     *
     * The view counters are seeded at zero, and that is load-bearing rather than
     * incidental. resetCounter issues one UPDATE over the whole series table, and
     * jobs.live.test.js asserts that the number of rows it touches equals the
     * number that were non-zero. Seeding `daily: g` put 4000 non-zero rows in the
     * table, so that test saw 4002 and failed - intermittently, because node --test
     * runs the live files concurrently and it only loses the race when both files
     * are mid-flight.
     *
     * So probe rows must not perturb a measurement another file is taking. They
     * start at zero, which is also the state the counter test below wants anyway.
     */
    await db.pool.query(
      `INSERT INTO series (title, slug, type, owner, author, synopsis, views, rights_attested_at)
       SELECT
         'Plan Probe ' || g,
         'plan-probe-' || g || '-' || $1,
         'novel', $2::uuid, 'Probe', 'synopsis text here',
         jsonb_build_object('daily', 0, 'weekly', 0, 'alltime', 0),
         now()
       FROM generate_series(1, $3) g`,
      [`${process.pid.toString(36)}x${Date.now().toString(36)}`, owner, SEED_ROWS],
    );

    const { rows } = await db.pool.query(
      'SELECT id FROM series WHERE owner = $1', [owner],
    );
    seeded = rows.map((r) => r.id);

    // The planner's choices depend on statistics; without this it is guessing
    // from defaults and every assertion below would be about its guessing.
    await db.pool.query('ANALYZE series');
    await db.pool.query('ANALYZE users');
  });

  test.after(async () => {
    if (seeded.length) {
      await db.pool.query('DELETE FROM series WHERE id = ANY($1::uuid[])', [seeded]);
    }
    if (owner) await db.pool.query('DELETE FROM users WHERE id = $1', [owner]);
  });

  test('the seed is large enough for its plan assertions to mean anything', () => {
    /*
     * A guard on the other guards. If the seed silently stopped inserting - a
     * renamed column, a constraint - every assertion below would still pass,
     * because a sequential scan over ten rows is exactly what these tests say is
     * not happening. This is the check that they are still measuring something.
     */
    assert.equal(seeded.length, SEED_ROWS,
      `seeded ${seeded.length} rows, expected ${SEED_ROWS}; the plan assertions below `
      + 'would pass vacuously against a table too small to tempt a sequential scan');
  });

  test('looking a series up by id is an index scan', async () => {
    const p = await plan('SELECT * FROM series WHERE id = $1', [seeded[0]]);
    const types = nodeTypes(p);

    assert.ok(!types.includes('Seq Scan'),
      `a lookup by primary key used a sequential scan over ${SEED_ROWS} rows: ${types.join(' > ')}`);
    assert.ok(types.some((t) => /Index/.test(t)),
      `a lookup by primary key used no index: ${types.join(' > ')}`);
    assert.equal(rowsActually(p), 1, `a primary key lookup touched ${rowsActually(p)} rows`);
  });

  test('the public catalogue listing is served by the listing index', async () => {
    // The hot path for every reader: the catalogue, newest first, excluding
    // removed work. The index is (is_removed, created_at DESC), which matches the
    // query exactly - that is what it is for.
    const p = await plan('SELECT * FROM series WHERE is_removed = $1 ORDER BY created_at DESC LIMIT 50', [false]);
    const types = nodeTypes(p);

    assert.ok(indexesUsed(p).includes('idx_series_listing'),
      `the catalogue listing did not use idx_series_listing (used: `
      + `${indexesUsed(p).join(', ') || 'none'}); plan was ${types.join(' > ')}`);
    assert.ok(!types.includes('Seq Scan'),
      `the catalogue listing scanned ${SEED_ROWS} rows: ${types.join(' > ')}`);
  });

  test('a listing reads the rows it needs and not the whole table', async () => {
    /*
     * The cost comparison rather than a fixed number, because a fixed number is
     * version- and hardware-dependent and would rot. A limit-50 listing must
     * cost materially less than the same query without the limit; if the limit
     * were not reaching the planner, the two would be equal.
     */
    const [bounded, unbounded] = await Promise.all([
      plan('SELECT * FROM series ORDER BY created_at DESC LIMIT 50'),
      plan('SELECT * FROM series ORDER BY created_at DESC'),
    ]);

    assert.ok(totalCost(bounded) < totalCost(unbounded),
      `a limit-50 listing costs ${totalCost(bounded)} against ${totalCost(unbounded)} `
      + 'unbounded - the limit is not reaching the planner');
    assert.ok(rowsActually(bounded) <= 50,
      `a limit-50 listing read ${rowsActually(bounded)} rows`);
  });

  test('search can be served by the search index', async () => {
    /*
     * Every seeded row contains "plan", so a match on it is not selective and the
     * planner would be right to scan. What is being checked is that the GIN index
     * over search_vector is *capable* of answering the query at all, so this runs
     * with sequential scans disallowed: an index that cannot serve the lookup
     * still returns a sequential scan with the escape hatch open, which is the
     * failure this catches.
     */
    const p = await plan(
      `SELECT id, title FROM series
        WHERE search_vector @@ plainto_tsquery('english', $1) LIMIT 50`,
      ['plan'],
      { settings: { enable_seqscan: 'off' } },
    );
    const types = nodeTypes(p);

    assert.ok(indexesUsed(p).some((i) => /search/i.test(i)),
      `the search path used no search index (used: ${indexesUsed(p).join(', ') || 'none'}); `
      + `with sequential scans disabled the plan was ${types.join(' > ')}`);
  });

  test('the counter reset skips rows that are already zero', async () => {
    /*
     * The statement's entire value is its WHERE clause: a quiet day should do no
     * work. What is asserted is the executed plan's actual row count against the
     * number of rows that genuinely needed rewriting.
     *
     * Both numbers have to describe the same data. Counting in one statement and
     * explaining in another is not safe here, because node --test runs the live
     * files concurrently against one database and another file's rows can change
     * in between - so the count and the rewrite would be answering different
     * questions. REPEATABLE READ pins both to one snapshot, and ROLLBACK undoes
     * the rewrite.
     */
    await db.pool.query(
      `UPDATE series SET views = '{"daily":0,"weekly":0,"alltime":0}'::jsonb
        WHERE id = ANY($1::uuid[])`, [seeded],
    );

    /*
     * Exactly one probe row is left non-zero, and the whole measurement is scoped
     * to this file's own rows.
     *
     * Two earlier versions of this were wrong in ways that only showed up under
     * load:
     *
     * Counting every non-zero row in the table, then explaining, in one
     * REPEATABLE READ snapshot, to stop another file's rows moving in between. That
     * fails outright when a concurrent test deletes a row the snapshot needs:
     * "could not serialize access due to concurrent delete". Coverage runs 50
     * processes against one database, so that was not an edge case - it failed on
     * the first full coverage run.
     *
     * Scoping both halves to `id = ANY(seeded)` removes the dependency on global
     * state entirely: no other file's rows are counted, so none can change the
     * answer, and no transaction is needed to hold a snapshot still.
     *
     * One row, not zero, is deliberate. With every row already zero there is
     * nothing to reset, a working clause and a missing one both rewrite zero rows,
     * and the test cannot tell them apart - which is exactly the state it was in
     * before, where it passed while proving nothing about the skip-if-zero clause.
     */
    await db.pool.query(
      `UPDATE series SET views = jsonb_set(COALESCE(views, '{}'::jsonb), '{daily}', '7'::jsonb, true)
        WHERE id = $1`, [seeded[0]],
    );
    await db.pool.query('ANALYZE series');

    const SCOPE = 'id = ANY($1::uuid[]) AND views ->> \'daily\' IS DISTINCT FROM \'0\'';
    const counted = await db.pool.query(
      `SELECT count(*)::int AS n FROM series WHERE ${SCOPE}`, [seeded],
    );
    const nonZero = Number(counted.rows[0].n);

    const p = await plan(
      `UPDATE series
          SET views = jsonb_set(COALESCE(views, '{}'::jsonb), '{daily}', '0'::jsonb, true),
              last_daily_reset = now()
        WHERE ${SCOPE}`,
      [seeded],
    );

    // The guard on the guard: if every row were non-zero, a working clause and a
    // missing one would rewrite the same number of rows and this could not tell
    // them apart.
    assert.ok(nonZero >= 1,
      'nothing in the table was non-zero, so there was nothing for the clause to skip '
      + 'and a missing clause would look identical');
    assert.ok(nonZero < SEED_ROWS,
      `${nonZero} of ${SEED_ROWS} probe rows are non-zero; if every row needed rewriting `
      + 'then a working clause and a missing one would produce the same count');
    assert.equal(rowsVisited(p), nonZero,
      `the reset visited ${rowsVisited(p)} rows but ${nonZero} were non-zero, so the `
      + 'skip-if-zero clause is not doing its job');
  });

  test('the statement proven here is the statement the job actually runs', () => {
    /*
     * The honest limitation of this file, pinned rather than left implicit.
     *
     * The counter test above explains a copy of the UPDATE written out here, not
     * the one in resetViews.js - a function cannot be EXPLAINed. So on its own it
     * proves the plan shape of a statement nobody ships. Verified by mutating
     * resetViews.js to drop its WHERE clause: jobs.live.test.js failed (it calls
     * the function) and this file passed (it explains its own copy). Exactly the
     * gap this assertion closes.
     *
     * It reads the source rather than importing it, so what is checked is the text
     * that is actually deployed, not a re-render of it. If resetCounter ever moves
     * its SQL into a builder or a service, this fails and says so rather than
     * quietly testing a copy of something that no longer exists.
     */
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'jobs', 'resetViews.js'), 'utf8');
    const statement = src.match(/UPDATE "series"[\s\S]*?`/);

    assert.ok(statement, 'could not find the series UPDATE in resetViews.js');

    for (const fragment of [
      /SET "views" = jsonb_set\(COALESCE\("views", '\{\}'::jsonb\)/,
      /WHERE "views" ->> '\$\{key\}' IS DISTINCT FROM '0'/,
    ]) {
      assert.match(statement[0], fragment,
        `the UPDATE that ships no longer matches what this file explains: missing ${fragment}`);
    }
  });

  test('every index on series is valid and ready', async () => {
    /*
     * An index that is invalid or not ready is invisible to the planner, so it is
     * pure write cost. This does not prove each index is *used* - that needs
     * production traffic and real query shapes - but it does prove each one is
     * capable of being chosen.
     */
    const { rows } = await db.pool.query(
      `SELECT indexname FROM pg_indexes
        WHERE schemaname = current_schema() AND tablename = 'series'
        ORDER BY indexname`,
    );

    assert.ok(rows.length >= 8,
      `expected the series indexes to be present, found ${rows.length}: ${rows.map((r) => r.indexname).join(', ')}`);

    const { rows: bad } = await db.pool.query(
      `SELECT c.relname AS indexname
         FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid
         JOIN pg_class t ON t.oid = i.indrelid
        WHERE t.relname = 'series' AND (NOT i.indisvalid OR NOT i.indisready)`,
    );

    assert.deepEqual(bad.map((b) => b.indexname), [],
      'these indexes are not valid and ready, so the planner cannot use them at all:\n  '
      + bad.map((b) => b.indexname).join('\n  '));
  });

  test('the probe rows are removable, so this file cleans up after itself', async () => {
    /*
     * The first version of this counted every row in the table and asserted the
     * difference. That is wrong here and it failed: node --test runs test files
     * concurrently against one database, so another live file inserting or
     * deleting series between the two counts changes the answer. It reported 9
     * deleted when 10 were.
     *
     * Counting only this file's own rows, by the owner it created, removes the
     * race. The point stands either way - if the probe rows could not be removed,
     * the after() hook would not be able to remove them either and this file would
     * leave four thousand rows behind for the next run to trip over.
     */
    const probeCount = async () => Number((await db.pool.query(
      'SELECT count(*)::int AS n FROM series WHERE owner = $1', [owner],
    )).rows[0].n);

    const before = await probeCount();
    assert.equal(before, SEED_ROWS, `expected ${SEED_ROWS} probe rows, found ${before}`);

    const victim = seeded.slice(0, 10);
    const gone = await db.pool.query('DELETE FROM series WHERE id = ANY($1::uuid[]) RETURNING id', [victim]);
    assert.equal(gone.rows.length, 10,
      `asked to remove 10 probe rows, ${gone.rows.length} were removed`);

    assert.equal(await probeCount(), SEED_ROWS - 10, 'the probe rows did not clean up');
  });
}