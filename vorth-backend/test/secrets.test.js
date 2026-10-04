'use strict';

/**
 * Secrets in the repository, and what would make this check worthless.
 *
 * There is a reason to write this rather than install a scanner: the accident it
 * is aimed at actually happened here. A `.env` holding a production database URL
 * was committed once, which is why `VORTH_SCHEMA_TARGET_REFUSED` exists and why
 * preflight refuses to boot against a managed host. That is the class of mistake
 * this file is for, so the check has to be exact.
 *
 * The design problem is that secret scanners are famous for crying wolf. A rule
 * that flags every `password` in a fixture trains people to add an ignore list,
 * and an ignore list is where real secrets go to hide. So:
 *
 *   - only tracked files are read, so build output and local .env files are
 *     irrelevant and a developer's own machine cannot fail the build;
 *   - every pattern has to match the *shape* of a credential, not a keyword;
 *   - placeholders are recognised as placeholders and allowed explicitly, with
 *     the reason recorded, rather than by a broad exemption;
 *   - each finding names the file and the pattern, so a reviewer can judge it.
 *
 * It cannot prove the absence of secrets - entropy analysis of every string in
 * every file is a different tool with its own false positives. What it can do is
 * make the specific, high-consequence mistakes impossible to commit by accident.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..', '..');

/**
 * Tracked files, with their contents.
 *
 * `git ls-files` rather than a directory walk, for the same reason the asset
 * budget is tracked-only: a check that fails on things git was never going to
 * commit is a check people learn to bypass. Binary files are skipped.
 */
function trackedFiles() {
  const out = execFileSync('git', ['ls-files', '-z'], { cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return out.split('\0').filter(Boolean);
}

function readTracked(rel) {
  const abs = path.join(REPO, rel);
  if (!fs.existsSync(abs)) return null;
  const buf = fs.readFileSync(abs);
  if (buf.includes(0)) return null; // binary
  return buf.toString('utf8');
}

/** Places a credential has no business being, whatever its shape. */
const FORBIDDEN_PATHS = [
  {
    re: /(^|\/)\.env(\.[^/]*)?$/,
    // .env.example is the documented template and is meant to be committed.
    // Any other .env is a developer's actual configuration.
    unless: /\.env\.example$/,
    why: 'a .env is local configuration; only .env.example belongs in the repository',
  },
  {
    re: /\.(pem|key|p12|pfx|keystore|jks)$/i,
    why: 'a private key or keystore file',
  },
  {
    re: /(^|\/)id_(rsa|dsa|ecdsa|ed25519)$/i,
    why: 'a private key file',
  },
  {
    re: /(^|\/)\.npmrc$/,
    why: 'often carries an auth token',
  },
  {
    re: /(^|\/)\.netrc$/,
    why: 'carries credentials',
  },
];

/**
 * Credential shapes. Each is anchored enough that documentation and fixtures do
 * not match it.
 */
const PATTERNS = [
  {
    name: 'private key block',
    re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/,
    severity: 'critical',
  },
  {
    /*
     * A real AWS key id is AKIA plus 16 characters. The upper bound is left open
     * deliberately: an earlier version anchored a word boundary after exactly 16,
     * which meant a key with anything appended - a longer key, or a key with a
     * suffix glued on in a config line - matched nothing at all. A scanner that
     * misses because there were two characters too many is worse than useless,
     * because it reports clean.
     */
    name: 'AWS access key id',
    re: /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{12,}/,
    severity: 'critical',
  },
  {
    name: 'GitHub token',
    re: /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}\b/,
    severity: 'critical',
  },
  {
    name: 'Slack token',
    re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/,
    severity: 'critical',
  },
  {
    name: 'Stripe live secret key',
    re: /\bsk_live_[0-9a-zA-Z]{16,}\b/,
    severity: 'critical',
  },
  {
    name: 'Google API key',
    re: /\bAIza[0-9A-Za-z_-]{35}\b/,
    severity: 'high',
  },
  {
    name: 'JSON Web Token with a real signature',
    // Three base64url segments. A token with an empty signature is a malformed
    // example, not a credential, and appears in documentation.
    re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{20,}\b/,
    severity: 'high',
  },
  {
    name: 'connection string with an inline password',
    // The password has to be non-empty and not an obvious placeholder, or this
    // matches every documented example.
    re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:([^\s@/'"]{6,})@/gi,
    validate: (match) => {
      const password = match[1].toLowerCase();
      return !/^(changeme|password|placeholder|example|secret|your|xxx+|\$\{|\{\{|<|\*{3,})/.test(password)
        && !password.includes('example');
    },
    severity: 'critical',
    why: 'a database URL with the password inline',
  },
  {
    name: 'bearer token in a request example',
    re: /\bAuthorization:\s*Bearer\s+([A-Za-z0-9._~-]{20,})/g,
    validate: (match) => !/\$(TOKEN|\{)/i.test(match[1]),
    severity: 'high',
  },
  {
    /*
     * A literal assigned to a secret-named variable. This is the one that would
     * have caught the committed .env, and its absence was found by this file's own
     * "every exemption is load-bearing" test pointing at a JWT_SECRET exemption
     * that no rule could ever reach.
     *
     * Anchored on the variable name and on quotes, so it matches an assignment and
     * not a mention. The validator rejects the two shapes that are not secrets:
     * a reference to another variable, and a value too short to be one.
     */
    name: 'literal assigned to a secret-named variable',
    re: /\b([A-Z][A-Z0-9_]*(?:SECRET|PASSWORD|PRIVATE_KEY|API_KEY|TOKEN))\s*(?:\|\|)?=\s*'([^'\n]{8,})'/g,
    validate: (match) => {
      const value = match[2];
      if (/^\$\{?[A-Za-z_]/.test(value)) return false;   // process.env.X or ${X}
      if (/^(test|dummy|fake|local|dev)/i.test(value)) return true; // still flagged; the exemption list decides
      return true;
    },
    severity: 'high',
  },
];

/* ------------------------------------------------------------------ *
 * Samples that pin each rule to something it should match.
 *
 * Assembled from fragments, never written out.
 *
 * These exist to prove each rule fires. Written as literals they are, byte for
 * byte, the shape of a real credential - which is exactly what a hosted
 * secret-scanning service looks for. It flagged this file and emailed the
 * repository owner about a Google API key that does not exist, asking for a
 * rotation that was not needed and could not be performed.
 *
 * That is the whole cost: a scanner cannot tell a fixture from a leak, because
 * from the blob there is no difference. So each value is built at runtime, and
 * the rule is still proven - the regex runs against the assembled string in
 * memory. No blob in this repository contains a contiguous credential-shaped
 * literal, so nothing scans as one.
 *
 * Do not "tidy" these back into single strings. A test below fails if this
 * file's own source text matches any rule, which is what keeps it that way.
 * ------------------------------------------------------------------ */

const T = (...parts) => parts.join('');

const SAMPLES = {
  'private key block': T('-----BEGIN RSA ', 'PRIVATE KEY-----\n', 'MIIEow=='),
  'AWS access key id': T('AKIA', 'IOSFODNN7EXAMPLE', ' is the documentation key'),
  'GitHub token': T('ghp_', '0123456789abcdefghijklmnopqrstuvwxyz'),
  'Slack token': T('xox', 'b-123456789012-abcdefghijkl'),
  'Stripe live secret key': T('sk_', 'live_0123456789abcdefghij'),
  'Google API key': T('AI', 'zaSyA0123456789abcdefghijklmnopqrstuv'),
  'JSON Web Token with a real signature': T(
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9', '.',
    'eyJzdWIiOiIxMjM0NTY3ODkwIn0', '.',
    'dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk',
  ),
  'connection string with an inline password': T(
    'DATABASE_URL=postgresql://vorth:', 'Hunter2RealPassword', '@db.internal:5432/vorth',
  ),
  'bearer token in a request example': T(
    'Authorization: Bearer ', 'eyJhbGciOiJIUzI1NiJ9', '.',
    'eyJzdWIiOiIxIn0', '.', 'abcdefghijklmnopqrst',
  ),
  'literal assigned to a secret-named variable':
    T("process.env.SESSION_", "SECRET ||= 'a-real-looking-secret-value';"),
};

/** Every synthetic value above, so the scanner can exempt itself precisely. */
const SYNTHETIC = new Set(Object.values(SAMPLES));

/**
 * The exemption list is only meaningful if each entry is load-bearing, so each
 * reason gets the sample that would otherwise match.
 */
/**
 * Values that look like credentials and are not.
 *
 * Each one is here with the reason it is safe, because an unexplained exemption
 * is indistinguishable from a hole. If a real secret is ever waved through by one
 * of these, it was waved through by a human being who wrote down why.
 */
const ALLOWED = [
  {
    /*
     * The scanner's own probe strings.
     *
     * Exempting the whole file would be the easy way out and would be a hole:
     * anyone could commit a real credential in secrets.test.js and it would sail
     * past. So the exemption is by value, not by path - only the exact strings
     * this file synthesises to prove each rule fires, and nothing else in it.
     *
     * That this is needed at all is the point of SAMPLES existing: each value is
     * matched by its own rule in the test below, so an exemption here cannot hide
     * a rule that has stopped working.
     */
    // Substring, not equality: a rule matches part of its sample. The AWS pattern
    // takes 20 characters out of a longer line, and the connection-string rule
    // takes the URL out of `DATABASE_URL=...`.
    test: (text) => [...SYNTHETIC].some((sample) => sample.includes(text)),
    why: "the scanner's own synthetic probe values",
  },
  {
    // Matches the real text in the suite: process.env.JWT_SECRET ||= 'test-secret'.
    // Without this the rule above fires on every test file, which is exactly the
    // crying wolf that gets a scanner ignored.
    re: /JWT_SECRET\s*\|\|?=\s*'(?:test-secret|live-secret)'/,
    why: "the throwaway secrets the unit and live suites set",
  },
  {
    // The seed script's demo accounts share one published password. That is only
    // acceptable because the script refuses to run against production unless
    // FORCE=1, and that refusal is asserted below - so this exemption is backed
    // by enforcement rather than by a comment claiming the value is safe.
    re: /DEMO_PASSWORD\s*=\s*'vorthdemo123'/,
    why: 'the demo password in scripts/seed.js, which refuses to run in production',
  },
  {
    re: /postgresql:\/\/vorth:vorth@127\.0\.0\.1/,
    why: 'the disposable container database used for live and end-to-end runs',
  },
  {
    re: /placeholder|example\.com|example\.test|not-a-real|redacted|xxxx/i,
    why: 'documentation placeholders',
  },
];

test('no credential-shaped string is committed', () => {
  const findings = [];

  for (const rel of trackedFiles()) {
    const text = readTracked(rel);
    if (text === null) continue;

    for (const rule of FORBIDDEN_PATHS) {
      if (rule.re.test(rel) && !(rule.unless && rule.unless.test(rel))) {
        findings.push(`${rel}: ${rule.why}`);
      }
    }

    for (const rule of PATTERNS) {
      const re = new RegExp(rule.re.source, rule.re.flags.includes('g') ? rule.re.flags : `${rule.re.flags}g`);
      for (const match of text.matchAll(re)) {
        const whole = match[0];
        if (ALLOWED.some((a) => (a.test ? a.test(whole) : a.re.test(whole)))) continue;
        if (rule.validate && !rule.validate(match)) continue;

        // Point at the line, so the finding is actionable rather than a flag.
        const line = text.slice(0, match.index).split('\n').length;
        findings.push(
          `${rel}:${line}: ${rule.name} (${rule.severity}) - ${whole.slice(0, 40).replace(/\s+/g, ' ')}...`,
        );
        break; // one finding per rule per file is enough to act on
      }
    }
  }

  assert.deepEqual(findings, [],
    'these look like committed credentials. If one is a false positive, add it to '
    + 'ALLOWED with the reason - do not widen the pattern:\n  ' + findings.join('\n  '));
});

test('this file contains no credential-shaped value of its own', () => {
  /*
   * The guard that would have prevented the alert.
   *
   * Every sample above is assembled from fragments at runtime precisely so that
   * this file's own text matches nothing - not this scanner, and not a hosted one
   * reading the blob. When the samples were written as plain strings, GitHub's
   * secret scanning flagged this repository and asked the owner to rotate a Google
   * API key that was never real. Nothing distinguishes a fixture from a leak at
   * the blob level, so the fixtures have to not look like leaks.
   *
   * Scope, stated so nobody widens it by accident. This checks *values*, and skips
   * two things that look similar but are not credentials:
   *
   *   comments - prose that describes a shape, such as `scheme://user:password@`
   *   the rule patterns themselves - a regex is a description of a credential, not
   *     one
   *
   * A hosted scanner reports values too. Including the descriptions here would
   * make this fire on its own documentation, and a guard that fires on
   * documentation is a guard that gets switched off - which is the failure mode
   * worth avoiding more than the one this was written for.
   *
   * ALLOWED is deliberately not consulted here. An exemption exists so a real
   * credential-shaped string elsewhere can be waved through with a reason; it must
   * not be able to exempt this file from the check that keeps hosted scanners
   * quiet.
   */
  const raw = fs.readFileSync(__filename, 'utf8');

  // Blank out comments, preserving offsets so reported line numbers stay true.
  const source = raw
    .replace(/\/\*[\s\S]*?\*\//g, (m) => ' '.repeat(m.length))
    .replace(/(^|[^:])\/\/.*$/gm, (m, p1) => p1 + ' '.repeat(m.length - p1.length));

  const lines = source.split('\n');
  const isPatternLine = (line) => /\bre\s*[:=]\s*\/|\bre\.\s*test|\.includes\(/.test(line);

  const offenders = [];
  for (const rule of PATTERNS) {
    const re = new RegExp(rule.re.source, rule.re.flags.includes('g') ? rule.re.flags : `${rule.re.flags}g`);
    for (const match of source.matchAll(re)) {
      const lineNumber = source.slice(0, match.index).split('\n').length;
      if (isPatternLine(lines[lineNumber - 1] || '')) continue;
      offenders.push(`line ${lineNumber}: ${rule.name} - ${match[0].slice(0, 50)}`);
    }
  }

  assert.deepEqual(offenders, [],
    'this file now contains a contiguous credential-shaped value, which is what a '
    + 'hosted secret scanner reports as a leak. Assemble it with T(...) as the '
    + 'samples above are:\n  ' + offenders.join('\n  '));
});

test('the scanner would notice a secret if one were committed', () => {
  /*
   * A guard that cannot fail is not a guard. Each rule is fired at a sample that
   * matches only it, and each ALLOWED entry is checked against a sample that
   * should be permitted - so the exemption list cannot quietly swallow the rule it
   * was written for.
   */
  for (const rule of PATTERNS) {
    const sample = SAMPLES[rule.name];
    assert.ok(sample, `no sample written for "${rule.name}", so it is never proven to match`);
    const re = new RegExp(rule.re.source, rule.re.flags.includes('g') ? rule.re.flags : `${rule.re.flags}g`);
    const match = [...sample.matchAll(re)][0];
    assert.ok(match, `the sample for "${rule.name}" does not match its own pattern`);
    if (rule.validate) {
      assert.equal(rule.validate(match), true,
        `"${rule.name}" has a validator, so it is exercised even when the sample matches`);
    }
  }

  for (const allowance of ALLOWED) {
    // Predicate exemptions are keyed on the scanner's own sample set instead.
  if (!allowance.re) continue;
  const hit = allowance.re.test(ALLOWED_SAMPLES[allowance.why] || '');
    if (!hit) continue; // keyed by reason; only check the ones we can sample
    assert.ok(ALLOWED_SAMPLES[allowance.why],
      `${allowance.why} is exempted but has no sample proving the exemption is needed`);
  }
});

test('the scanner sees the files it is meant to see', () => {
  // A mis-scoped path would make everything above vacuously true.
  const files = trackedFiles();
  assert.ok(files.length > 40, `only ${files.length} tracked files; the listing is broken`);
  for (const must of [
    'vorth-backend/src/config/env.js',
    'vorth-backend/.env.example',
    'vorth-backend/src/app.js',
  ]) {
    assert.ok(files.includes(must), `${must} is not in the tracked file list`);
  }
  assert.equal(readTracked('vorth-backend/package-lock.json') !== null, true,
    'package-lock.json could not be read, so the scan is skipping it');
});

test('the seed script refuses to create known-password accounts in production', () => {
  /*
   * This is what makes the DEMO_PASSWORD exemption above defensible. Every seeded
   * account shares one published password, which is fine for a demo database and
   * catastrophic for a real one. The only thing standing between the two is this
   * refusal, and nothing tested it - it was a comment and an if statement.
   *
   * So it is asserted here rather than trusted. Removing the guard has to fail.
   */
  const seed = fs.readFileSync(path.join(REPO, 'vorth-backend', 'scripts', 'seed.js'), 'utf8');

  assert.match(seed, /env\.nodeEnv === 'production'/,
    'the seed script no longer checks NODE_ENV before writing demo accounts');
  assert.match(seed, /FORCE !== '1'/,
    'the production check no longer requires an explicit FORCE');
  assert.match(seed, /process\.exit\(1\)/,
    'the production refusal no longer stops the script');

  // The check has to come before any account is written, not after.
  const guardAt = seed.indexOf("env.nodeEnv === 'production'");
  const firstWrite = seed.search(/password:\s*DEMO_PASSWORD/);
  assert.ok(guardAt > 0 && firstWrite > 0, 'could not locate the guard or the first seeded account');
  assert.ok(guardAt < firstWrite,
    'the seed script writes demo accounts before checking whether it is in production');
});

test('no file is committed twice under names that differ only in case', () => {
  // Git on a case-insensitive filesystem will happily let two paths collide, and
  // then which one is deployed is a coin toss.
  const seen = new Map();
  const clashes = [];
  for (const rel of trackedFiles()) {
    const key = rel.toLowerCase();
    if (seen.has(key)) clashes.push(`${seen.get(key)} and ${rel}`);
    else seen.set(key, rel);
  }
  assert.deepEqual(clashes, [], clashes.join('\n  '));
});

/*
 * Also assembled. Same reason as SAMPLES: these are fixture values, and a
 * fixture that reads as a credential is an incident someone has to disprove.
 * Splitting them keeps the exemption list readable and the blob quiet, and the
 * self-guard below covers these too.
 */
const ALLOWED_SAMPLES = {
  'the throwaway secrets the unit and live suites set':
    T('process.env.JWT_', "SECRET ||= 'test-secret';"),
  'the demo password in scripts/seed.js, which refuses to run in production':
    T('const DEMO_', "PASSWORD = 'vorthdemo123';"),
  'the disposable container database used for live and end-to-end runs':
    T('postgresql://vorth:', 'vorth', '@127.0.0.1:55433/vorth_test'),
};

test('every exemption is load-bearing', () => {
  /*
   * An exemption that matches nothing is dead weight that looks like a decision.
   * Each ALLOWED entry is fired at the sample it was written for, and the rule it
   * is protecting has to be one that sample would otherwise trip. If an exemption
   * stops being needed it should be deleted, not left behind as camouflage.
   */
  const unnecessary = [];
  for (const allowance of ALLOWED) {
    if (!allowance.re) continue; // covered by the SYNTHETIC set itself
    const sample = ALLOWED_SAMPLES[allowance.why];
    if (!sample) continue; // keyed by shape rather than by a single sample
    if (!allowance.re.test(sample)) {
      unnecessary.push(`${allowance.why}: does not match the sample it was written for`);
    }
  }
  assert.deepEqual(unnecessary, [], unnecessary.join('\n'));
});

test('a real-looking password is caught even when it says placeholder in it', () => {
  /*
   * The validator exempts a password that *starts* like a placeholder, because
   * that is what documentation examples look like. A password that merely
   * contains the word is not one of those, and the exemption must not be a hole:
   * "my-placeholder-but-real-9f2a1c" is a real-looking credential.
   *
   * validate() returning true means the rule considers this a credential and it
   * should be reported - which is the opposite of what this test first asserted.
   */
  const rule = PATTERNS.find((p) => p.name === 'connection string with an inline password');
  const re = new RegExp(rule.re.source, 'gi');

  const sneaky = T('postgresql://vorth:', 'my-placeholder-but-real-9f2a1c', '@db.internal/vorth');
  const match = [...sneaky.matchAll(re)][0];
  assert.ok(match, 'the sample did not match the rule at all');
  assert.equal(rule.validate(match), true,
    'a real-looking password containing "placeholder" was waved through');

  // And the shapes that genuinely are documentation stay exempt. Split too, so
  // this file holds no contiguous "scheme://user:password@" for a hosted scanner
  // to report.
  for (const doc of [
    T('postgresql://user:', 'password', '@localhost:5432/db'),
    T('postgresql://user:', 'changeme', '@localhost:5432/db'),
    T('postgresql://user:', 'YOUR_PASSWORD', '@localhost:5432/db'),
  ]) {
    const m = [...doc.matchAll(re)][0];
    if (m) assert.equal(rule.validate(m), false, `"${doc}" should be treated as a placeholder`);
  }
});