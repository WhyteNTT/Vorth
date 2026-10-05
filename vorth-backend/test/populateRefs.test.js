'use strict';

/**
 * Every populate path the controllers use resolves to a real model.
 *
 * `refFor` keeps a hand-written map from a field name to the model it points at,
 * and anything missing from it throws at request time - not at boot, not at
 * import. So a typo or an unregistered alias is a 500 on one endpoint, in
 * production, found by a user.
 *
 * That is exactly what happened to `GET /api/reports/:id`. The Content Policy
 * report names its targets `reportedSeries`, `reportedChapter` and
 * `reportedComment`; the map knew `series`, `chapter`, `comment` and the DMCA
 * controller's `infringingSeries`/`infringingChapter`, but not those three. So
 * populating threw and the endpoint answered 500. It has never worked, and the
 * route had no test - it was one of the uncovered lines when this check was
 * written.
 *
 * Checking the map against the actual populate calls in the source means the next
 * unregistered alias fails the build instead of a user request. Mutating the map
 * to drop an entry fails this, so it is not passing vacuously.
 */

process.env.DATABASE_URL ||= 'postgres://stub/stub';
process.env.DATABASE_SSL = 'false';
process.env.JWT_SECRET ||= 'test-secret';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '..', 'src');
const CONTROLLERS = path.join(SRC, 'controllers');

/** Every `.populate('path')` literal in the controllers. */
function populatePaths() {
  const found = new Map();
  for (const file of fs.readdirSync(CONTROLLERS)) {
    if (!file.endsWith('.js')) continue;
    const src = fs.readFileSync(path.join(CONTROLLERS, file), 'utf8');
    for (const m of src.matchAll(/\.populate\(\s*'([^']+)'/g)) {
      if (!found.has(m[1])) found.set(m[1], []);
      found.get(m[1]).push(file);
    }
  }
  return found;
}

test('every populate path the controllers use resolves to a model', () => {
  // A representative model: refFor is static and its map is the same for all of
  // them, so resolving through one covers the whole map.
  const Base = require('../src/models/_base');

  const unresolved = [];
  for (const [pathExpr, files] of populatePaths()) {
    assert.doesNotThrow(() => Base.refFor(pathExpr),
      `.populate('${pathExpr}') in ${[...new Set(files)].join(', ')} has no model `
      + 'registered, so that request would throw and answer 500');
    try {
      Base.refFor(pathExpr);
    } catch (_) {
      unresolved.push(pathExpr);
    }
  }

  assert.deepEqual(unresolved, [], unresolved.join('\n  '));
});

test('the populate guard would catch a missing registration', () => {
  /*
   * The guard above resolves through the real map, so it cannot fail unless the
   * map is wrong. Asserting that here is the difference between a check and a
   * tautology: if refFor started returning a model for everything, the guard
   * would pass while proving nothing.
   */
  const Base = require('../src/models/_base');

  assert.throws(() => Base.refFor('definitelyNotAField'),
    /No populate target registered/,
    'refFor now accepts anything, so the guard above would pass vacuously');
});

test('the Content Policy report targets are registered', () => {
  /*
   * Named separately because this is the one that was broken, and because the
   * fix is three entries in a map that someone will one day tidy up without
   * knowing what they are for.
   */
  const Base = require('../src/models/_base');
  const expected = {
    reportedSeries: require('../src/models/Series'),
    reportedChapter: require('../src/models/Chapter'),
    reportedComment: require('../src/models/Comment'),
  };

  for (const [field, Model] of Object.entries(expected)) {
    assert.equal(Base.refFor(field), Model,
      `${field} resolves to ${Base.refFor(field)?.name || 'nothing'}, not ${Model.name}`);
  }
});

test('no controller populates a path built from a variable', () => {
  // A computed path cannot be checked statically, so it cannot be checked at all.
  // If one is needed, it has to be registered for every value it can take, and
  // the guard above only sees literals.
  const dynamic = [];
  for (const file of fs.readdirSync(CONTROLLERS)) {
    if (!file.endsWith('.js')) continue;
    const src = fs.readFileSync(path.join(CONTROLLERS, file), 'utf8');
    for (const m of src.matchAll(/\.populate\(\s*(?!'|`|")([^)]*)/g)) {
      dynamic.push(`${file}: .populate(${m[1].trim().slice(0, 60)})`);
    }
  }
  assert.deepEqual(dynamic, [],
    'these populate paths are not literals, so nothing verifies they resolve:\n  '
    + dynamic.join('\n  '));
});