'use strict';

/**
 * Configuration and schema drift guards.
 *
 * Every check here exists because the thing it guards was got wrong by hand at
 * least once, and nothing noticed:
 *
 *   - `.env.example` was missing 28 of the 47 variables the code reads. It is the
 *     file a deployer copies, so an undocumented variable is a variable nobody
 *     sets - and half of them decide whether password reset works at all.
 *   - the GIN index over the search tsvector was never asserted by
 *     db:verify-schema. Dropping it costs a sequential scan on the one table
 *     people search, and search keeps returning correct answers, so nothing fails.
 *   - db:verify-schema's own list had drifted from the schema: a new table was
 *     added and had to be remembered. That was done by hand, once, and would
 *     have to be done by hand again.
 *   - a 2.1 MB scraped mp4 sat in the frontend, referenced by index.html. A
 *     budget is the only thing that stops the next one landing quietly.
 *
 * These are static checks over the repository, so they need no database and no
 * browser.
 */

process.env.DATABASE_URL ||= 'postgres://stub/stub';
process.env.DATABASE_SSL = 'false';
process.env.JWT_SECRET ||= 'test-secret';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const BACKEND = path.join(__dirname, '..');
const REPO = path.join(BACKEND, '..');
const FRONTEND = path.join(REPO, 'vorth-frontend');

const read = (...p) => fs.readFileSync(path.join(...p), 'utf8');
const walk = (dir, out = []) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
};

/* ------------------------------------------------------------------ *
 * .env.example completeness.
 * ------------------------------------------------------------------ */

/** Every process.env.NAME the runtime actually reads. */
function envVarsReadByCode() {
  const found = new Set();
  for (const file of walk(path.join(BACKEND, 'src'))) {
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(/process\.env\.([A-Z0-9_]+)/g)) found.add(m[1]);
    for (const m of src.matchAll(/process\.env\[['"]?([A-Z0-9_]+)/g)) found.add(m[1]);
  }
  return found;
}

/** Every variable named in .env.example, commented or not. */
function envVarsDocumented() {
  const src = read(BACKEND, '.env.example');
  const found = new Set();
  for (const m of src.matchAll(/^#?\s*([A-Z][A-Z0-9_]*)=/gm)) found.add(m[1]);
  return found;
}

test('every environment variable the code reads is in .env.example', () => {
  const read_ = envVarsReadByCode();
  const documented = envVarsDocumented();
  const missing = [...read_].filter((v) => !documented.has(v)).sort();

  assert.deepEqual(missing, [],
    `these are read in src/ but absent from .env.example, so nobody will set them:\n  `
    + missing.join('\n  '));
});

test('nothing in .env.example is dead', () => {
  // A documented variable nothing reads is a trap: it looks like a knob, and
  // setting it does nothing.
  const read_ = envVarsReadByCode();
  const dead = [...envVarsDocumented()].filter((v) => !read_.has(v)).sort();
  assert.deepEqual(dead, [],
    `these are in .env.example but nothing in src/ reads them:\n  ${dead.join('\n  ')}`);
});

test('.env.example states real defaults, not aspirational ones', () => {
  // Spot-checked against config/env.js. A wrong default in the example file is
  // how a deployment ends up quietly different from the one that was tested.
  const src = read(BACKEND, '.env.example');
  const env = read(BACKEND, 'src', 'config', 'env.js');
  const cases = [
    ['REFRESH_COOKIE_NAME', 'vorth_refresh'],
    ['REFRESH_TOKEN_DAYS', '30'],
    ['EMAIL_VERIFICATION_HOURS', '24'],
    ['PASSWORD_RESET_HOURS', '1'],
    ['SMTP_PORT', '587'],
    ['S3_URL_TTL_SECONDS', '3600'],
    ['RATE_LIMIT_STORE', 'memory'],
  ];
  for (const [name, defaultLiteral] of cases) {
    const documented = new RegExp(`^#?\\s*${name}=(.+)$`, 'm').exec(src);
    assert.ok(documented, `${name} is not in .env.example`);
    assert.equal(
      documented[1].trim(), defaultLiteral,
      `.env.example says ${name}=${documented[1]} but config/env.js defaults to ${defaultLiteral}`
    );
    /*
     * And that the default is really in env.js, so the two cannot drift apart in
     * the other direction either. config/env.js reads the variable as
     * process.env.NAME, so a rename there shows up as a missing literal here -
     * which is the point, because the first check would no longer catch it.
     */
    assert.ok(
      env.includes(`process.env.${name}`) || env.includes(`'${name}'`),
      `${name} is documented with a default but config/env.js does not read it, so the `
      + 'documented default means nothing'
    );
  }
});

/* ------------------------------------------------------------------ *
 * Schema, models and the verifier agreeing with each other.
 * ------------------------------------------------------------------ */

const SCHEMA = () => read(BACKEND, 'src', 'config', 'db.js');
const VERIFIER = () => read(BACKEND, 'scripts', 'verifySchema.js');

test('every table the schema creates is asserted by db:verify-schema', () => {
  const created = [...SCHEMA().matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map((m) => m[1]);
  const verifier = VERIFIER();
  const TABLES = /const TABLES = \[([\s\S]*?)\];/.exec(verifier);
  assert.ok(TABLES, 'could not find the TABLES list in verifySchema.js');
  const asserted = [...TABLES[1].matchAll(/'(\w+)'/g)].map((m) => m[1]);
  const missing = created.filter((t) => !asserted.includes(t)).sort();

  assert.deepEqual(missing, [],
    `these tables are created but db:verify-schema does not check them, so they can go `
    + `missing unnoticed:\n  ${missing.join('\n  ')}`);
});

test('every index the schema creates is asserted by db:verify-schema', () => {
  const created = [...SCHEMA().matchAll(/CREATE (?:UNIQUE )?INDEX IF NOT EXISTS (\w+)/g)]
    .map((m) => m[1]);
  const verifier = VERIFIER();

  /*
   * Both lists, not just REQUIRED_INDEXES. An index that backs a correctness
   * invariant is asserted in UNIQUE_CONSTRAINTS instead, and treating that as
   * "not asserted" would report a false gap on exactly the indexes that matter
   * most - and train the reader to ignore this check.
   */
  const REQUIRED = /const REQUIRED_INDEXES = \[([\s\S]*?)\];/.exec(verifier);
  const UNIQUE = /const UNIQUE_CONSTRAINTS = \[([\s\S]*?)\];/.exec(verifier);
  assert.ok(REQUIRED, 'could not find REQUIRED_INDEXES in verifySchema.js');
  assert.ok(UNIQUE, 'could not find UNIQUE_CONSTRAINTS in verifySchema.js');
  const asserted = new Set(
    [...`${REQUIRED[1]}${UNIQUE[1]}`.matchAll(/'(\w+)'/g)].map((m) => m[1])
  );

  const missing = [...new Set(created)].filter((i) => !asserted.has(i)).sort();
  assert.deepEqual(missing, [],
    `these indexes are created but db:verify-schema does not check them:\n  ${missing.join('\n  ')}`);
});

test('the search index is asserted, because losing it fails silently', () => {
  // A sequential scan over series returns the same answers. The only symptom is
  // that search got slow, which is not something a failing check would catch.
  assert.match(VERIFIER(), /'idx_series_search'/,
    'the GIN index over search_vector is not asserted by db:verify-schema');
  assert.match(SCHEMA(), /USING GIN \(search_vector\)/,
    'the schema no longer creates the GIN search index the verifier expects');
});

test('every model maps onto a table the schema creates', () => {
  const modelsDir = path.join(BACKEND, 'src', 'models');
  const created = new Set([...SCHEMA().matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map((m) => m[1]));

  const missing = [];
  for (const file of fs.readdirSync(modelsDir)) {
    if (!file.endsWith('.js') || file.startsWith('_')) continue;
    const src = fs.readFileSync(path.join(modelsDir, file), 'utf8');
    const table = /static table = '(\w+)'/.exec(src);
    if (!table) {
      missing.push(`${file}: no "static table"`);
    } else if (!created.has(table[1])) {
      missing.push(`${file}: table "${table[1]}" is not created by the schema`);
    }
  }
  assert.deepEqual(missing, [],
    `models that do not line up with the schema:\n  ${missing.join('\n  ')}`);
});

test('every table is either modelled or deliberately raw', () => {
  // view_events and rate_limit_buckets are written by services with raw SQL.
  // Named explicitly so a genuinely orphaned table is a failure rather than a
  // judgement call at review time.
  const RAW_ONLY = new Set(['view_events', 'rate_limit_buckets']);
  const created = [...SCHEMA().matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map((m) => m[1]);

  const modelsDir = path.join(BACKEND, 'src', 'models');
  const modelled = new Set();
  for (const file of fs.readdirSync(modelsDir)) {
    if (!file.endsWith('.js') || file.startsWith('_')) continue;
    const t = /static table = '(\w+)'/.exec(fs.readFileSync(path.join(modelsDir, file), 'utf8'));
    if (t) modelled.add(t[1]);
  }

  const orphans = created.filter((t) => !modelled.has(t) && !RAW_ONLY.has(t));
  assert.deepEqual(orphans, [],
    `tables with no model and not on the deliberate raw-only list:\n  ${orphans.join('\n  ')}`);
});

/* ------------------------------------------------------------------ *
 * Frontend assets.
 * ------------------------------------------------------------------ */

test('every asset index.html references exists', () => {
  const html = read(FRONTEND, 'index.html');
  const refs = new Set();
  for (const m of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
    const url = m[1];
    if (/^(https?:|data:|#|mailto:|\/api)/.test(url)) continue;
    refs.add(url.split('?')[0].split('#')[0]);
  }
  // styles.css referenced url() values too.
  for (const m of read(FRONTEND, 'styles.css').matchAll(/url\((['"]?)([^)'"]+)\1\)/g)) {
    if (/^(https?:|data:|#)/.test(m[2])) continue;
    refs.add(m[2].split('?')[0]);
  }

  const missing = [...refs].filter((r) => !fs.existsSync(path.join(FRONTEND, r))).sort();
  assert.deepEqual(missing, [],
    `referenced by the page but not present:\n  ${missing.join('\n  ')}`);
});

test('no tracked asset is large enough to be a problem', () => {
  /*
   * 2.1 MB of scraped mp4 was committed as a background video that turned out to
   * be invisible behind an opaque background and never played - so it cost every
   * visitor 2.1 MB and showed nothing. Review does not catch that, and
   * .gitignore cannot: the file was tracked.
   *
   * 256 KB is comfortably above the largest legitimate asset here (a 73 KB logo)
   * and far below anything a reader pays for on first load.
   */
  const BUDGET = 256 * 1024;
  const OVERRIDES = new Set(['package-lock.json']);

  const tooBig = [];
  const walkTracked = (dir, prefix = '') => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const full = path.join(dir, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) { walkTracked(full, rel); continue; }
      if (OVERRIDES.has(rel)) continue;
      const size = fs.statSync(full).size;
      if (size > BUDGET) tooBig.push(`${(size / 1024).toFixed(0)} KB  ${rel}`);
    }
  };
  walkTracked(REPO);

  assert.deepEqual(tooBig.sort(), [],
    `files over the ${BUDGET / 1024} KB budget. If one is deliberate, add it to the `
    + 'OVERRIDES list with a reason:\n  ' + tooBig.join('\n  '));
});

test('no third-party media is committed to the frontend', () => {
  // Narrower than the size budget, and aimed at the actual failure: content
  // lifted from another site, whose licence for redistribution was never
  // established. Replace it with something you own.
  const offenders = [];
  const walkFrontend = (dir, prefix = '') => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const rel = `${prefix}${entry.name}`;
      if (entry.isDirectory()) { walkFrontend(full, `${rel}/`); continue; }
      if (/\.(mp4|mp3|mov|avi|webm|wav)$/i.test(entry.name)) offenders.push(rel);
    }
  };
  walkFrontend(FRONTEND);
  assert.deepEqual(offenders, [],
    `media files committed to the frontend: ${offenders.join(', ')}`);
});
