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
const { spawnSync } = require('node:child_process');

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
  // service_heartbeat likewise: one row, two columns, no document to hydrate and
  // nothing in the app reads it - a model would be all ceremony.
  // Named explicitly so a genuinely orphaned table is a failure rather than a
  // judgement call at review time.
  const RAW_ONLY = new Set(['view_events', 'rate_limit_buckets', 'service_heartbeat']);
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
 * Documentation drift.
 * ------------------------------------------------------------------ */

test('every npm script is documented in the README', () => {
  /*
   * Seven were undocumented, including `test:e2e` - the one command somebody
   * verifying this work would reach for first. A script nobody can find is a
   * script nobody runs, and the suite it guards is the suite that finds bugs.
   */
  const scripts = Object.keys(JSON.parse(read(BACKEND, 'package.json')).scripts);
  const readme = read(BACKEND, 'README.md');
  const missing = scripts.filter((s) => !readme.includes(s)).sort();
  assert.deepEqual(missing, [],
    `these npm scripts are not mentioned in README.md:\n  ${missing.join('\n  ')}`);
});

test('every test file is reachable from some script', () => {
  /*
   * `test/run.js` with no arguments runs everything, so a file nothing names is
   * still executed - but only by `npm test`. If a suite needs a database or a
   * browser it has to be named in test:live or test:e2e, or it will sit skipped
   * in the default run and nobody will notice it is not really running.
   */
  const scripts = JSON.parse(read(BACKEND, 'package.json')).scripts;
  /*
   * Every script's text, not a list of script names.
   *
   * This check used to name the scripts it looked at: test, test:unit, test:http,
   * test:live, test:browser, test:e2e. That is a list that has to be updated by
   * hand every time a suite is added, and forgetting is silent - the new suite
   * exists, `npm test` runs it, and this reports it as unreachable instead of
   * noticing that nothing else does. It did exactly that to test:shutdown.
   *
   * Scanning the values means a new script is covered the moment it is written.
   */
  const named = Object.values(scripts).join(' ');

  const files = fs.readdirSync(path.join(BACKEND, 'test'))
    .filter((f) => /\.test\.(c|m)?js$/.test(f));
  const unreachable = files.filter((f) => !named.includes(f)).sort();

  assert.deepEqual(unreachable, [],
    'these test files are not named in any npm script, so nothing but the bare `npm test` '
    + 'ever runs them - and if they need a database or browser they will sit skipped:\n  '
    + unreachable.join('\n  '));
});

test('the test runner never invokes a pass with no files in it', () => {
  /*
   * Found by this, and it is the worst kind of bug: the runner ran a suite nobody
   * asked for and reported a failure from it.
   *
   * test/run.js partitions the files into a parallel pass, a serial pass, and - as
   * of the end-to-end scheduling fix - a browser pass. `node --test` with no file
   * arguments does not run nothing; it runs the entire suite. So whenever a script
   * names only files that fall outside the parallel pass, `runPass([])` executed
   * everything.
   *
   * `npm run test:e2e` names exactly one file, e2e.test.js, which goes to the
   * browser pass. The empty parallel pass then ran the whole suite against the same
   * database, and the command failed on "deadlock detected" from a live test it
   * should never have started.
   *
   * Checked by deriving the partition the same way run.js does and asserting every
   * script that names test files leaves a non-empty parallel pass. Derived rather
   * than restated, so it stays true when a script or a suffix changes.
   */
  const runner = read(BACKEND, 'test', 'run.js');
  assert.match(runner, /if \(files\.length\)\s*\{\s*status = runPass\(files\)/,
    'test/run.js calls runPass(files) unguarded; node --test with no file arguments '
    + 'runs the whole suite, so an empty parallel pass silently runs everything');

  /*
   * An empty parallel pass is legitimate when a script names only files that go to a
   * later pass, which test:e2e does. The guard is on the *invocation*, not on the
   * partition: run.js must not call runPass with nothing, because node --test reads
   * an empty file list as "run everything".
   */
const scripts = JSON.parse(read(BACKEND, 'package.json')).scripts;
  const isSerial = /\.serial\.test\.(c|m)?js$/;
  const isBrowserDriven = /(^|[\\/])e2e\.test\.(c|m)?js$/;

  const deferred = [];
  for (const [name, body] of Object.entries(scripts)) {
    if (!body.includes('test/run.js')) continue;

    const named = (body.match(/test\/[\w.]+\.test\.js/g) || [])
      .map((f) => f.replace(/^test\//, ''));
    if (!named.length) continue; // a bare `node test/run.js` means everything

    // A script whose entire selection is deferred is fine - run.js skips the
    // parallel pass. What it must not do is name a file no pass would run, which
    // would leave that test silently unexecuted.
    const runsSomewhere = named.some((f) => isSerial.test(f) || isBrowserDriven.test(f));
    const inParallel = named.filter((f) => !isSerial.test(f) && !isBrowserDriven.test(f));
    if (!inParallel.length && !runsSomewhere) {
      deferred.push(name);
    }
  }

  assert.deepEqual(deferred, [],
    'these scripts name test files that no pass runs, so those tests never execute:\n  '
    + deferred.join('\n  '));

  /*
   * The pair of facts that makes the guard above necessary, and which together
   * explain the bug it was written for.
   *
   *   1. A script naming only non-parallel files is legitimate - test:e2e does.
   *   2. So the empty-pass hazard is real and cannot be designed away by
   *      convention.
   *
   * Asserted separately because fixing the guard's assertion instead of the
   * runner would have produced a green suite that ran the entire database suite
   * whenever the e2e command was typed. The guard has to keep firing.
   */
  const e2eOnly = Object.entries(scripts)
    .filter(([, body]) => /test\/run\.js\s+test\/e2e\.test\.js\s*$/.test(body.trim()))
    .map(([name]) => name);

  assert.ok(e2eOnly.length >= 1,
    'the exact shape that broke - a script naming only the end-to-end file - is gone, so '
    + 'the empty-pass guard above is no longer being tested by anything real');
});

/* ------------------------------------------------------------------ *
 * Frontend assets.
 * ------------------------------------------------------------------ */

test('the signup form declares every constraint the API enforces', () => {
  /*
   * Added after a real report: a reader was told "Validation failed" with no
   * indication of which field, and the cause was a username containing a dot and
   * a password under 8 characters - both of which the form happily submitted,
   * because it only declared `required` and type=email.
   *
   * The rule here is that the browser must not be able to construct a payload the
   * server will reject. Asserted against the validators themselves rather than
   * against a copy of the numbers, so changing the API without changing the form
   * fails here.
   */
  const html = read(FRONTEND, 'index.html');
  const controller = read(BACKEND, 'src', 'controllers', 'authController.js');

  const attr = (id, name) => {
    const tag = html.match(new RegExp(`id="${id}"[^>]*`));
    assert.ok(tag, `index.html has no input with id="${id}"`);
    const m = tag[0].match(new RegExp(`${name}="([^"]*)"`));
    return m ? m[1] : null;
  };

  // The server: body('username').trim().toLowerCase().matches(/^[a-z0-9_]{3,24}$/)
  const usernameRule = controller.match(/body\('username'\)[\s\S]*?\.matches\((\/\^.*?\/)\)/);
  assert.ok(usernameRule, 'could not read the username validator out of the controller');
  const [, serverPattern] = usernameRule;
  // Checked as literal source text, not as a regex: serverPattern is the pattern
  // *as written in the controller*, so its braces are unescaped there.
  assert.ok(serverPattern.includes('a-z0-9_') && serverPattern.includes('{3,24}'),
    `username validator changed shape (${serverPattern}); update this test deliberately`);

  const formPattern = attr('signupUsername', 'pattern');
  assert.ok(formPattern, 'the username input declares no pattern, so anything can be submitted');
  // Must reject exactly what the server rejects. Both cases allowed, because the
  // server lowercases before matching.
  for (const bad of ['john.doe', 'john-doe', 'john doe', 'ab', 'a'.repeat(25), 'john@doe']) {
    assert.ok(!new RegExp(`^(?:${formPattern})$`).test(bad),
      `the form's pattern would still accept "${bad}", which the server rejects`);
  }
  for (const good of ['john', 'john_doe', 'a_b_9', 'A'.repeat(24)]) {
    assert.ok(new RegExp(`^(?:${formPattern})$`).test(good),
      `the form's pattern rejects "${good}", which the server accepts`);
  }

  // The server: body('password').isLength({ min: 8 })
  const passwordRule = controller.match(/body\('password'\)\.isLength\(\{\s*min:\s*(\d+)/);
  assert.ok(passwordRule, 'could not read the password length rule out of the controller');
  const minLength = Number(passwordRule[1]);
  for (const id of ['signupPassword', 'signupConfirmPassword']) {
    assert.equal(Number(attr(id, 'minlength')), minLength,
      `${id} must declare minlength="${minLength}" to match the API`);
  }

  // The server: body('displayName').isLength({ max: 60 })
  const nameRule = controller.match(/body\('displayName'\)[\s\S]*?isLength\(\{\s*max:\s*(\d+)/);
  assert.ok(nameRule, 'could not read the display-name length rule out of the controller');
  assert.equal(Number(attr('signupName', 'maxlength')), Number(nameRule[1]),
    'the display-name input must declare the same maximum the API enforces');
});

test('the form-error stylesheet class is the one the script actually sets', () => {
  /*
   * The script set `form-hint err` while the stylesheet defined `.form-hint.error`.
   * Nothing failed: the class applied, matched no rule, and every error message
   * rendered in the dim informational colour. Seven occurrences, none noticed.
   *
   * Reading the class out of the script and asserting the stylesheet knows it is
   * the only way that class drift becomes a failing test rather than a colour that
   * quietly does not apply.
   */
  const script = read(FRONTEND, 'script.js');
  const css = read(FRONTEND, 'styles.css');
  const used = new Set([...script.matchAll(/'(form-hint(?:\s+\S+)?)'/g)].map((m) => m[1]));

  assert.ok(used.size > 0, 'no form-hint classes found in script.js');
  for (const cls of used) {
    const [base, ...variants] = cls.split(/\s+/);
    for (const variant of variants) {
      /*
       * Matched as a complete selector, not with `includes`.
       *
       * The first version of this guard used `css.includes('.form-hint.err')`, and
       * mutation testing showed it passing for exactly the bug it exists to catch:
       * `.form-hint.error` *contains* the substring `.form-hint.err`, so a
       * substring check cannot tell "the rule exists" from "a longer rule with the
       * same prefix exists". The negative lookahead is what makes it exact.
       */
      const exact = new RegExp(`\\.${base}\\.${variant}(?![\\w-])`);
      assert.ok(exact.test(css),
        `script.js sets "${cls}" but styles.css defines no "${base}.${variant}" rule - the styling silently does nothing`);
    }
  }
});

test('validation details reach the reader rather than being discarded', () => {
  /*
   * The API returns `{ message, details: [{ field, message }] }`. Only `message`
   * used to be used, so "Validation failed" reached the screen with the reason
   * dropped. Asserted as a chain because any link can be the one that breaks:
   * the fetch must keep the details, and the form must render them.
   */
  const script = read(FRONTEND, 'script.js');
  assert.match(script, /err\.details\s*=/,
    'apiFetch does not carry payload.details onto the thrown error');

  /*
   * Asserted at the call sites, not by the identifier merely existing.
   *
   * Checking `/showFieldErrors/` is satisfied by the function's own definition, so
   * a mutation that removed the calls still passed. What matters is that the two
   * auth forms pass their own hint element, and that the renderer actually writes
   * into it.
   */
  for (const hint of ['#signupHint', '#loginHint']) {
    assert.ok(script.includes(`showFieldErrors('${hint}'`),
      `no form renders validation details into ${hint}`);
  }
  const render = script.slice(script.indexOf('function showFieldErrors'), script.indexOf('function showFieldErrors') + 2000);
  /*
   * One assertion, not two, and matched in sequence on purpose.
   *
   * showFieldErrors has two branches: the per-field details path, and a fallback
   * for failures that carry no details. Two separate checks - "some textContent
   * assignment exists" and "some className assignment exists" - were both satisfied
   * by the *fallback* branch alone, so mutation testing showed the guards stayed
   * green while the details branch was gutted: first its write removed, then its
   * error class removed. Requiring the write and the class together, with the
   * write anchored on `lines.join` so only the details branch can match, is what
   * makes the check bite.
   */
  assert.match(render,
    /el\.textContent\s*=\s*lines\.join\([^)]*\);\s*el\.className\s*=\s*'form-hint error'/,
    'the branch that reports per-field details does not write them into the hint element '
    + 'and mark it as an error');

  // And the forms must have somewhere to render them to.
  const html = read(FRONTEND, 'index.html');
  for (const id of ['signupHint', 'loginHint']) {
    assert.ok(html.includes(`id="${id}"`), `index.html has no #${id} to render errors into`);
  }
});

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

test('every live test sets its environment before requiring the database', () => {
  /*
   * config/db validates its environment at require time and *exits* when
   * DATABASE_URL or JWT_SECRET is missing. A live test that requires it before
   * setting its own stubs therefore dies at load, before its skip logic can run.
   *
   * This was missed in test/jobs.live.test.js and it is invisible on a developer
   * machine, because a local .env always supplies those variables. The CI job
   * that runs deliberately with no .env is the only environment that has neither,
   * so the failure appeared there and nowhere else.
   *
   * Asserted statically, because the alternative is "only CI catches this" -
   * which is how it stayed broken for two commits.
   */
  const live = fs.readdirSync(path.join(BACKEND, 'test'))
    .filter((f) => /\.live\.test\.(c|m)?js$/.test(f));

  assert.ok(live.length > 0, 'no live test files found; the glob probably broke');

  const offenders = [];
  for (const file of live) {
    const src = fs.readFileSync(path.join(BACKEND, 'test', file), 'utf8');
    const stubs = src.indexOf('process.env.DATABASE_URL');
    const requiresDb = src.search(/require\('\.\.\/src\/(config\/db|models\/)/);

    if (stubs === -1) {
      offenders.push(`${file}: never sets process.env.DATABASE_URL at all`);
      continue;
    }
    if (requiresDb !== -1 && stubs > requiresDb) {
      offenders.push(`${file}: requires src/ at line ${src.slice(0, requiresDb).split('\n').length} `
        + `but does not set its environment until line ${src.slice(0, stubs).split('\n').length}`);
    }
  }

  assert.deepEqual(offenders, [],
    'these files load src/config/db before their environment is set, so they die at '
    + 'require time in any environment without a .env - which is every CI run of the '
    + 'Test + lint job:\n  ' + offenders.join('\n  '));
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
   *
   * Tracked, and only tracked. This used to walk the working tree, which made it
   * fire on things git was never going to commit: `npm run test:coverage` leaves
   * raw V8 profiles in `.coverage-tmp/`, several of them over 400 KB, and a local
   * `uploads/` or `.env` counts too. A budget that fails on build output trains
   * people to add an OVERRIDE for build output, and then it guards nothing.
   */
  const BUDGET = 256 * 1024;
  // Keys are paths as `git ls-files` reports them, relative to the repository
  // root. They used to be bare filenames, which could never match, so the escape
  // hatch this failure message offers silently did nothing.
  const OVERRIDES = new Map([
    ['vorth-backend/package-lock.json', 'the resolved dependency tree; regenerating it is the fix, not an override'],
  ]);

  const listed = spawnSync('git', ['ls-files', '-z'], { cwd: REPO, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (listed.error || listed.status !== 0) {
    /*
     * Without git the question cannot be answered, so say so instead of quietly
     * walking the tree - which is the check this one used to do, and the reason
     * it failed on coverage output.
     */
    assert.fail(
      'could not list tracked files with `git ls-files`, so the asset budget '
      + `cannot be checked: ${listed.error ? listed.error.message : `exit ${listed.status}`}`
    );
  }

  const tooBig = [];
  for (const rel of listed.stdout.split('\0').filter(Boolean)) {
    if (OVERRIDES.has(rel)) continue;
    let size;
    try {
      size = fs.statSync(path.join(REPO, rel)).size;
    } catch (_) {
      continue; // Tracked but deleted from the working tree; nothing ships.
    }
    if (size > BUDGET) tooBig.push(`${(size / 1024).toFixed(0)} KB  ${rel}`);
  }

  assert.deepEqual(
    tooBig.sort(), [],
    `tracked files over the ${BUDGET / 1024} KB budget. If one is deliberate, add it to the `
    + 'OVERRIDES list with a reason (the path as `git ls-files` prints it, relative to '
    + `the repository root):\n  ${tooBig.join('\n  ')}`
  );
});

test('only serial test files may boot the schema against a live database', () => {
  /*
   * test/run.js prepares the schema once and sets VORTH_SKIP_SCHEMA so no parallel
   * test file issues DDL. A file that clears that flag and then connects for real
   * is putting CREATE INDEX into a pass where every other live file is inserting
   * rows - and a ShareLock does not wait politely for a RowExclusiveLock. That
   * deadlocked for real, mid-INSERT, in the live suite.
   *
   * hostGuard.test.js clears the flag too, against a stub pool that never reaches
   * a server, so it is allowed: it asserts what boot *would* issue, and setPool()
   * is how it proves it.
   */
  const clearsSkipFlag = (src) => /delete\s+process\.env\.VORTH_SKIP_SCHEMA/.test(src);
  const usesStubPool = (src) => /setPool\(/.test(src);

  const offenders = [];
  for (const file of fs.readdirSync(path.join(BACKEND, 'test'))) {
    if (!/\.test\.(c|m)?js$/.test(file)) continue;
    if (/\.serial\.test\.(c|m)?js$/.test(file)) continue;
    const src = fs.readFileSync(path.join(BACKEND, 'test', file), 'utf8');
    if (clearsSkipFlag(src) && !usesStubPool(src)) offenders.push(file);
  }

  assert.deepEqual(offenders.sort(), [],
    'these files clear VORTH_SKIP_SCHEMA and then connect for real, so they run DDL beside '
    + 'the other live files - which deadlocks. Rename them to *.serial.test.js so run.js '
    + `runs them alone, or inject a stub pool:\n  ${offenders.join('\n  ')}`);
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
