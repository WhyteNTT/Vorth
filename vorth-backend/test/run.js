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
 *   - runs `*.serial.test.js` files in a second pass, alone, because they alter
 *     the database the others are using.
 *
 * Usage:
 *   node test/run.js                 # every *.test.js under test/
 *   node test/run.js --watch         # re-run on change
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
const explicit = [];

for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i];
  if (arg === '--watch' || arg === '-w') {
    watch = true;
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
  console.log(`  (the last ${serial.length} run alone, in a second pass)`);
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

// --test-reporter landed in Node 18.15/19.2. Fall back to the built-in TAP
// output rather than crashing on an unsupported flag.
if (nodeMajor >= 19) {
  if (!passthrough.includes('--test-reporter')) baseArgs.push('--test-reporter=spec');
  baseArgs.push(...passthrough);
}
if (watch) baseArgs.push('--watch');

/** Runs one pass of files, returning the exit status. */
function runPass(passFiles) {
  const result = spawnSync(
    process.execPath,
    [...baseArgs, ...passFiles],
    { stdio: 'inherit', cwd: process.cwd() }
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

if (serial.length && !watch) {
  console.log(`\n--- serial pass: ${serial.length} file(s), run alone ---`);
  const serialStatus = runPass(serial);
  status = status || serialStatus;
} else if (serial.length) {
  console.log('\n--watch: serial files are not separated, so destructive tests may overlap.');
}

process.exit(status);
