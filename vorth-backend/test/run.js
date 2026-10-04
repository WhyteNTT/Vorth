'use strict';

/**
 * Portable entry point for the test suite.
 *
 * `node --test "test/*.test.js"` only works on Node 21+, which expands the glob
 * itself. On Node 20 and earlier the quoted pattern is treated as a literal
 * filename and the run dies with:
 *
 *     Could not find '.../test/*.test.js'
 *
 * Un-quoting it does not help either: npm runs scripts through cmd.exe on
 * Windows and sh on Linux, so only one of the two expands the glob. CI runs
 * Node 20, which is where this bites.
 *
 * So the file list is resolved here, in Node, and passed as explicit paths.
 * That behaves identically on every platform and every supported Node version.
 *
 * It also does two things `node --test` cannot:
 *
 *   - applies the database schema once, instead of letting every live file
 *     bootstrap it concurrently and deadlock;
 *   - runs `*.serial.test.js` files in a second pass, one at a time, because they
 *     alter the database the others are using;
 *   - merges the coverage every child process collected (`--coverage`).
 *
 * Usage:
 *   node test/run.js                 # every *.test.js under test/
 *   node test/run.js --watch         # re-run on change
 *   node test/run.js --coverage      # ...and report line/branch/function coverage
 *   node test/run.js test/http.test.js   # only the named files
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const TEST_ROOT = __dirname;
const PROJECT_ROOT = path.join(__dirname, '..');

/** Directories that hold support code, never tests. */
const EXCLUDED_DIRS = new Set(['node_modules', 'helpers', 'fixtures']);

function collect(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!EXCLUDED_DIRS.has(entry.name)) collect(full, out);
    } else if (/\.test\.(c|m)?js$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

const argv = process.argv.slice(2);
const passthrough = [];
let watch = false;
let coverage = false;
const explicit = [];

for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i];
  if (arg === '--watch' || arg === '-w') {
    watch = true;
  } else if (arg === '--coverage') {
    /*
     * Collects V8 coverage from every spawned pass and merges it with c8 once at
     * the end. Not a pass-through to the child: see reportCoverage() below for why
     * node's own --experimental-test-coverage cannot answer the question here.
     */
    coverage = true;
  } else if (arg.startsWith('-')) {
    // Let node --test handle its own flags; we only pick up the reporter.
    passthrough.push(arg);
  } else {
    explicit.push(path.resolve(arg));
  }
}

const all = explicit.length ? explicit : collect(TEST_ROOT).sort();

/*
 * `*.serial.test.js` files run in a second pass, after every parallel file has
 * finished.
 *
 * node --test runs test files concurrently, which is right for speed and wrong
 * for any test that alters the database the others are using. The column-upgrade
 * test has to drop a column to prove boot puts it back, and while it is dropped
 * every other file's INSERT fails with "relation has no column" - a cascade of
 * failures that look like product bugs and are not one. Those tests were written
 * to be destructive because there is no other way to test the thing, so the
 * scheduling gives way instead.
 */
const isSerial = (f) => /\.serial\.test\.(c|m)?js$/.test(f);
const files = all.filter((f) => !isSerial(f));
const serial = all.filter(isSerial);

// Stable, readable order on every platform.
const display = all.map((f) => path.relative(process.cwd(), f));
console.log(`Running ${all.length} test file(s):`);
display.forEach((f) => console.log(`  ${f}`));
if (serial.length && !explicit.length) {
  console.log(`  (the last ${serial.length} run one at a time, in a second pass)`);
}
console.log('');

if (!all.length) {
  console.error('No test files matched. This is a bug in test/run.js, not a passing suite.');
  process.exit(1);
}

/**
 * Apply the schema once, before the test files fan out.
 *
 * `node --test` runs test *files* in parallel, and each live file calls
 * connectDB(), which runs the full DDL. Every CREATE INDEX takes a ShareLock on
 * its table even when it creates nothing, and that conflicts with the
 * RowExclusiveLock any writer holds - so N files bootstrapping the same database
 * deadlock against each other. That is not hypothetical: the live suite died with
 * "Process 412 waits for RowShareLock ... blocked by process 411", 411 waiting on
 * ShareLock.
 *
 * The deadlock is a property of bootstrapping the schema concurrently, not of any
 * one statement, so the fix is to stop doing it concurrently: prepare the schema
 * once here, then tell the children not to touch it. They still get a real pool
 * and real SQL, which is the point of the live suite.
 *
 * Only done when the schema is actually going to be needed - a live database, and
 * at least one live file in the list - so the default `npm test` stays a pure
 * no-database run.
 */
const needsDatabase = Boolean(process.env.VORTH_LIVE_DB)
  && all.some((f) => /\.(live|postgres|serial)\.test\.js$/.test(path.basename(f)));

if (needsDatabase) {
  const prepare = spawnSync(
    process.execPath,
    ['-e', [
      "require('./src/config/db').connectDB()",
      '.then(() => process.exit(0), (e) => { console.error(e.message); process.exit(1); })',
    ].join('')],
    { stdio: 'inherit', cwd: PROJECT_ROOT }
  );
  if (prepare.status !== 0) {
    console.error('Could not prepare the schema. Fix that before reading test results.');
    process.exit(1);
  }
  // Children connect without DDL. Without this they race, and the run deadlocks.
  process.env.VORTH_SKIP_SCHEMA = '1';
  console.log('schema prepared once; test files connect without re-running DDL\n');
}

const nodeMajor = Number(process.versions.node.split('.')[0]);
const baseArgs = ['--test'];

/*
 * One reporter, chosen once.
 *
 * Passing two is a hard error in Node 24 ("must match the number of specified
 * --test-reporter-destination"), so the coverage default and the usual default
 * have to be reconciled here rather than both being appended.
 *
 * dot is used under coverage because the spec reporter interleaves the coverage
 * table with per-file output from a parallel run, which makes it unreadable.
 */
const userChoseReporter = passthrough.some((a) => a.startsWith('--test-reporter'));
const otherFlags = passthrough.filter((a) => !a.startsWith('--test-reporter'));
const wantReporter = userChoseReporter ? null : (coverage ? 'dot' : 'spec');

// --test-reporter landed in Node 18.15/19.2. Fall back to the built-in TAP
// output rather than crashing on an unsupported flag.
if (nodeMajor >= 19) {
  if (wantReporter) baseArgs.push(`--test-reporter=${wantReporter}`);
  baseArgs.push(...otherFlags);
} else {
  baseArgs.push(...passthrough);
}
if (watch) baseArgs.push('--watch');

/*
 * Coverage is collected across every spawned pass, then merged by c8.
 *
 * Two things make `--experimental-test-coverage` unusable here:
 *
 *   - the `dot` reporter prints no coverage table at all while `spec` does, so
 *     "coverage is broken" and "coverage was never switched on" are
 *     indistinguishable from the outside;
 *   - every test file already runs in its own process, so each child would print
 *     a table covering only what that process happened to load. Thirty files means
 *     thirty partial, non-additive reports, and the "all files" line of any one
 *     of them is not this project's coverage.
 *
 * NODE_V8_COVERAGE makes each child write raw V8 coverage to a directory instead,
 * and c8 merges them. That is the only way to get a real whole-project number out
 * of a runner that already forks per file.
 */
const CHILD_ENV = {};
if (coverage) {
  CHILD_ENV.NODE_V8_COVERAGE = path.join(PROJECT_ROOT, '.coverage-tmp');
}

function runPass(passFiles) {
  const result = spawnSync(
    process.execPath,
    // baseArgs already begins with --test.
    [...baseArgs, ...passFiles],
    { stdio: 'inherit', cwd: process.cwd(), env: { ...process.env, ...CHILD_ENV } }
  );
  if (result.error) {
    console.error(`Could not start the test runner: ${result.error.message}`);
    return 1;
  }
  if (result.signal) {
    console.error(`Test runner terminated by ${result.signal}`);
    return 1;
  }
  return result.status === null ? 1 : result.status;
}

// A separate invocation, not extra arguments to the same one: node --test runs
// every file it is given concurrently, so appending the serial files to the first
// pass would change nothing at all.
let status = runPass(files);

/*
 * One serial file per invocation, not all of them in one.
 *
 * `node --test` runs every file it is handed concurrently, which is right for
 * the parallel pass and defeats the entire point of the `.serial.` suffix here:
 * two files that alter the schema would be doing it to each other in one pass,
 * exactly the collision the suffix exists to prevent. There was only one serial
 * file until the schema-bootstrap tests moved out of the parallel live suite, so
 * this never showed up - handing the whole array to a single run looked correct
 * and was not.
 */
if (serial.length && !watch) {
  console.log(`\n--- serial pass: ${serial.length} file(s), one at a time ---`);
  for (const file of serial) {
    status = status || runPass([file]);
  }
} else if (serial.length) {
  console.log('\n--watch: serial files are not separated, so destructive tests may overlap.');
}

/**
 * Names the suites that sat this one out, so the number is not over-trusted.
 *
 * `npm run test:coverage` needs nothing, so with no VORTH_LIVE_DB and no
 * VORTH_E2E the live and end-to-end files skip themselves - quietly, and
 * correctly. The report then describes the unit suite only: 81% rather than 88%,
 * with the controllers looking like the biggest hole in the project when in fact
 * they are the part the skipped suites exist to exercise. A percentage with no
 * statement of what produced it is the thing to guard against.
 */
function reportSkippedSuites() {
  const skipped = [];
  if (!process.env.VORTH_LIVE_DB) {
    skipped.push('the live files (set VORTH_LIVE_DB=1 and point DATABASE_URL at a test database)');
  }
  if (!process.env.VORTH_E2E) skipped.push('the end-to-end file (set VORTH_E2E=1)');
  if (!skipped.length) return;

  console.log('\n[coverage] this number excludes ' + skipped.join(', and ') + '.');
  console.log('[coverage] It is the unit suite, not the project - read it as a floor.');
}

/**
 * Merges the raw V8 coverage the children wrote and prints a report.
 *
 * Printed whether the suite passed or failed: a green run is exactly when the
 * number is wanted, and a red run is when you want to know which file lost
 * coverage. Only a failure to merge is swallowed.
 */
function reportCoverage() {
  const tmp = path.join(PROJECT_ROOT, '.coverage-tmp');
  const files = fs.existsSync(tmp) ? fs.readdirSync(tmp).filter((f) => f.endsWith('.json')) : [];
  if (!files.length) {
    console.error('\n[coverage] no raw coverage was written; the number would be a lie. Skipping.');
    return;
  }

  console.log(`\n--- coverage (${files.length} process${files.length === 1 ? '' : 'es'} merged) ---`);
  reportSkippedSuites();
  /*
   * c8's JS entry, run through this node, not its .bin shim.
   *
   * On Windows the shim is a .cmd, which spawnSync will not execute without a
   * shell - so it failed with no output at all, which is indistinguishable from
   * c8 having found no data. Reading the bin path out of c8's own package.json
   * and running it with node avoids the shell entirely and works the same on
   * every platform.
   */
  const c8Bin = path.join(
    PROJECT_ROOT, 'node_modules', 'c8', require('c8/package.json').bin
  );
  if (!fs.existsSync(c8Bin)) {
    console.error('[coverage] c8 is not installed; run `npm ci` first.');
    return;
  }

  /*
   * The minimal argument set, verified working. An earlier version also passed
   * --exclude globs alongside --src, and c8 then failed with no usable message -
   * which reads as "coverage is broken" when the report itself was perfectly fine.
   */
  const result = spawnSync(process.execPath, [
    c8Bin, 'report',
    '--reporter=text',
    '--reporter=json-summary',
    '--temp-directory', tmp,
    '--reports-dir', path.join(PROJECT_ROOT, 'coverage'),
    '--src', path.join(PROJECT_ROOT, 'src'),
  ], { stdio: 'inherit', cwd: PROJECT_ROOT });

  if (result.error || result.status !== 0) {
    console.error(`[coverage] c8 could not merge the raw data (status ${result.status}).`);
  }
}

if (coverage) {
  reportCoverage();
  fs.rmSync(path.join(PROJECT_ROOT, '.coverage-tmp'), { recursive: true, force: true });
}

process.exit(status);
