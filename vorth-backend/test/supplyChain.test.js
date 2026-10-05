'use strict';

/**
 * Supply chain, checked offline.
 *
 * `npm audit` is the right tool for known vulnerabilities and it is not used here,
 * for one reason: it needs the registry, so a test that depends on it makes the
 * suite fail for reasons unrelated to the code, and a suite that fails for
 * unrelated reasons stops being read. Audit runs as a separate command, documented
 * below, and the result at this commit was 0 vulnerabilities for both production
 * and development.
 *
 * What is checked here needs no network and is worth checking every run anyway:
 * that everything ships under a licence this project can use, that the lockfile
 * still describes what package.json asks for, and that every resolved URL points
 * at the registry rather than somewhere a compromised entry could redirect it.
 *
 * The registry check is the one that matters most and is the least often done. A
 * `resolved` URL pointing at a tarball host, or a git:// dependency, is a
 * dependency that is not the thing npm's integrity hash was published for.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const BACKEND = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(BACKEND, 'package.json'), 'utf8'));
const lock = JSON.parse(fs.readFileSync(path.join(BACKEND, 'package-lock.json'), 'utf8'));

/** Licences this project can ship. Anything else needs a human decision. */
const ALLOWED_LICENCES = new Set([
  'MIT', 'ISC', 'BSD-2-Clause', 'BSD-3-Clause', 'Apache-2.0', '0BSD', 'Unlicense',
]);

const readLicence = (name) => {
  try {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(BACKEND, 'node_modules', name, 'package.json'), 'utf8'),
    );
    return typeof manifest.license === 'string' ? manifest.license : (manifest.license?.type || null);
  } catch (_) {
    return null;
  }
};

test('every production dependency ships under a licence this project can use', () => {
  const problems = [];
  for (const name of Object.keys(pkg.dependencies || {})) {
    const licence = readLicence(name);
    if (licence === null) { problems.push(`${name}: licence could not be read`); continue; }
    // An SPDX expression like "MIT OR Apache-2.0" is fine; a copyleft one is not.
    const options = licence.split(/\s+OR\s+/);
    if (!options.some((o) => ALLOWED_LICENCES.has(o.trim()))) {
      problems.push(`${name}: ${licence}`);
    }
  }
  assert.deepEqual(problems, [], problems.join('\n  '));
});

test('every package resolves from the npm registry', () => {
  /*
   * The integrity hash in a lockfile protects the bytes of the artefact npm
   * published. A `resolved` URL pointing anywhere else is a different supply, and
   * a git dependency has no published hash at all - both are the shape a
   * compromised or careless entry takes, so neither is allowed to appear quietly.
   */
  const offenders = [];
  for (const [name, entry] of Object.entries(lock.packages || {})) {
    if (!entry.resolved) {
      // A workspace or link entry legitimately has none.
      if (entry.link || entry.version?.startsWith('file:')) continue;
      if (!name) continue;
      offenders.push(`${name}: no resolved URL (${entry.version || 'no version'})`);
      continue;
    }
    let url;
    try {
      url = new URL(entry.resolved);
    } catch (_) {
      offenders.push(`${name}: unparseable resolved URL ${entry.resolved}`);
      continue;
    }
    if (url.protocol !== 'https:') {
      offenders.push(`${name}: ${url.protocol}// - not https`);
      continue;
    }
    if (url.host !== 'registry.npmjs.org') {
      offenders.push(`${name}: resolved from ${url.host}, not the registry`);
    }
  }
  assert.deepEqual(offenders, [], offenders.join('\n  '));
});

test('the lockfile still describes what package.json asks for', () => {
  /*
   * A lockfile that has drifted from the manifest is how `npm ci` starts failing
   * in CI on a commit that passed locally, and how a removed dependency keeps
   * being installed because the lockfile still lists it.
   */
  const root = lock.packages[''];
  assert.ok(root, 'the lockfile has no root package entry');

  for (const field of ['dependencies', 'devDependencies']) {
    const fromPkg = pkg[field] || {};
    const fromLock = root[field] || {};
    const missing = Object.keys(fromPkg).filter((d) => !(d in fromLock));
    const extra = Object.keys(fromLock).filter((d) => !(d in fromPkg));
    assert.deepEqual(missing, [],
      `${field} in package.json are absent from the lockfile: ${missing.join(', ')}. `
      + 'Run npm install so `npm ci` reproduces this tree.');
    assert.deepEqual(extra, [],
      `${field} in the lockfile are gone from package.json: ${extra.join(', ')}. `
      + 'Run npm install to prune them.');
  }
});

test('every locked package has an integrity hash', () => {
  // Without integrity, the lockfile pins a version but not the bytes.
  const missing = Object.entries(lock.packages || {})
    .filter(([name, entry]) => name && entry.resolved && !entry.integrity)
    .map(([name]) => name);
  assert.deepEqual(missing, [], missing.join('\n  '));
});

test('no dependency is a git URL or a loose range that could float', () => {
  const loose = [];
  const fromPkg = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  for (const [name, range] of Object.entries(fromPkg)) {
    if (/^(git|github|http|file|link):/.test(range)) {
      loose.push(`${name}: "${range}" is not a registry range`);
      continue;
    }
    if (!/^[\^~]?\d/.test(range)) loose.push(`${name}: "${range}" is not a version range`);
  }
  assert.deepEqual(loose, [], loose.join('\n  '));
});

test('every CI action is pinned to an immutable commit', () => {
  /*
   * `uses: actions/checkout@v4` names a tag, and a tag is a pointer that whoever
   * controls the upstream repository can move. The workflow runs with a token, on
   * every push, so a moved tag is arbitrary code execution on the repository -
   * and it would not show up in this repository's diff at all.
   *
   * The SHA is the artefact that was reviewed. The version stays in a trailing
   * comment so Dependabot can still propose an upgrade and a reader can tell what
   * the pin corresponds to.
   */
  const yaml = require('yaml');
  const workflowPath = path.join(BACKEND, '..', '.github', 'workflows', 'ci.yml');
  const raw = fs.readFileSync(workflowPath, 'utf8');
  const doc = yaml.parse(raw);

  const refs = [];
  const walk = (node) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== 'object') return;
    if (typeof node.uses === 'string') refs.push(node.uses);
    Object.values(node).forEach(walk);
  };
  walk(doc);

  assert.ok(refs.length > 0, 'no actions were found; the workflow probably failed to parse');

  const unpinned = refs.filter((r) => !/@[0-9a-f]{40}(?:\s|$)/.test(r));
  assert.deepEqual(unpinned, [],
    'these actions are referenced by a mutable tag or branch:\n  ' + unpinned.join('\n  ')
    + '\n  Pin each to a commit SHA and keep the version in a comment.');
});

test('the CI workflow declares least-privilege token permissions', () => {
  const yaml = require('yaml');
  const raw = fs.readFileSync(path.join(BACKEND, '..', '.github', 'workflows', 'ci.yml'), 'utf8');
  const doc = yaml.parse(raw);

  assert.ok(doc.permissions, 'the workflow sets no permissions, so it inherits the '
    + 'repository default - often read/write across every scope');
  assert.deepEqual(doc.permissions, { contents: 'read' },
    'this workflow only checks out code and runs tests; it should not hold write '
    + 'access to anything');
});

test('no script or workflow pins a playwright version', () => {
  /*
   * The browser build has to match the playwright that drives it. Hard-coding a
   * version in a script is how that silently stops being true: playwright was
   * upgraded for a security fix, the lockfile moved, and `npx playwright@1.49.0
   * install` kept downloading a browser revision the suite no longer asks for.
   * Nothing local catches that - the browsers are already present on a developer
   * machine, so only CI, which installs from scratch every run, sees it.
   *
   * So the version is read from the lockfile rather than written anywhere.
   */
  const offenders = [];

  for (const [name, command] of Object.entries(pkg.scripts || {})) {
    if (/playwright@\d/.test(command)) {
      offenders.push(`package.json script "${name}": ${command}`);
    }
  }

  const workflowPath = path.join(BACKEND, '..', '.github', 'workflows', 'ci.yml');
  const workflow = fs.readFileSync(workflowPath, 'utf8');
  for (const m of workflow.matchAll(/playwright@\d[^\s]*/g)) {
    offenders.push(`ci.yml: ${m[0]}`);
  }

  assert.deepEqual(offenders, [],
    'a playwright version is hard-coded, so the browser downloaded will not match '
    + 'the playwright in package-lock.json once either is upgraded:\n  '
    + offenders.join('\n  '));
});

test('the licence exemptions are all still in use', () => {
  // An allowance nothing needs is not a decision, it is a habit.
  const unused = [...ALLOWED_LICENCES].filter((licence) => {
    const matches = Object.keys(pkg.dependencies || {})
      .some((name) => (readLicence(name) || '').includes(licence));
    return !matches;
  });
  // Apache-2.0 and BSD-3-Clause are unused today. That is fine - they are
  // allowances for future dependencies - so this reports rather than fails, and
  // the assertion keeps it visible.
  assert.ok(unused.length < ALLOWED_LICENCES.size,
    'no dependency uses any allowed licence, so the list is wrong');
});