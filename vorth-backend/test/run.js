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
 * Usage:
 *   node test/run.js                 # every *.test.js under test/
 *   node test/run.js --watch         # re-run on change
 *   node test/run.js test/http.test.js   # only the named files
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const TEST_ROOT = __dirname;

/** Directories that hold support code, never tests. */
const EXCLUDED_DIRS = new Set(['node_modules', 'helpers', 'fixtures', 'node_modules']);

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

const files = explicit.length ? explicit : collect(TEST_ROOT).sort();

// Stable, readable order on every platform.
const display = files.map((f) => path.relative(process.cwd(), f));
console.log(`Running ${files.length} test file(s):`);
display.forEach((f) => console.log(`  ${f}`));
console.log('');

if (!files.length) {
  console.error('No test files matched. This is a bug in test/run.js, not a passing suite.');
  process.exit(1);
}

const nodeMajor = Number(process.versions.node.split('.')[0]);
const args = ['--test'];

// --test-reporter landed in Node 18.15/19.2. Fall back to the built-in TAP
// output rather than crashing on an unsupported flag.
if (nodeMajor >= 19) {
  if (!passthrough.includes('--test-reporter')) args.push('--test-reporter=spec');
  args.push(...passthrough);
}

if (watch) args.push('--watch');
args.push(...files);

const result = spawnSync(process.execPath, args, { stdio: 'inherit' });

if (result.error) {
  console.error(`Could not start the test runner: ${result.error.message}`);
  process.exit(1);
}
if (result.signal) {
  console.error(`Test runner terminated by ${result.signal}`);
  process.exit(1);
}
process.exit(result.status === null ? 1 : result.status);