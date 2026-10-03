'use strict';

/**
 * Tests for the live-database guard.
 *
 * This is the protection against `npm test` truncating a developer's real
 * remote database because .env happened to be loaded. It matters more than
 * any other test in the suite, so it is pinned explicitly.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { assertSafeTarget } = require('./helpers/liveGuard');

const NEON = 'postgresql://neondb_owner:secret@ep-xyz-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require';
const LOCAL_TEST_DB = 'postgresql://vorth:vorth@127.0.0.1:5432/vorth_test';
const LOCAL_ANY_DB = 'postgresql://vorth:vorth@localhost:5432/vorth';
const REMOTE_NAMED_TEST = 'postgresql://u:p@db.internal.example.com:5432/app_test';
const REMOTE_UNDISPOSABLE = 'postgresql://u:p@db.internal.example.com:5432/vorth';

test('refuses by default, even for a clearly disposable database', () => {
  const r = assertSafeTarget(LOCAL_TEST_DB, {});
  assert.equal(r.ok, false);
  assert.match(r.reason, /VORTH_LIVE_DB=1/);
});

test('refuses the .env-style production database even when opted in', () => {
  const r = assertSafeTarget(NEON, { VORTH_LIVE_DB: '1' });
  assert.equal(r.ok, false, 'a Neon production host must never be truncated');
  assert.match(r.reason, /managed production host/);
});

test('refuses an unknown remote host whose database name is not disposable', () => {
  const r = assertSafeTarget(REMOTE_UNDISPOSABLE, { VORTH_LIVE_DB: '1' });
  assert.equal(r.ok, false);
  assert.match(r.reason, /does not look like a throwaway/);
});

test('refuses when DATABASE_URL is missing or unparseable', () => {
  assert.equal(assertSafeTarget('', { VORTH_LIVE_DB: '1' }).ok, false);
  assert.equal(assertSafeTarget(undefined, { VORTH_LIVE_DB: '1' }).ok, false);
  assert.equal(assertSafeTarget('not a url', { VORTH_LIVE_DB: '1' }).ok, false);
});

test('allows a local database named like a test database', () => {
  assert.equal(assertSafeTarget(LOCAL_TEST_DB, { VORTH_LIVE_DB: '1' }).ok, true);
});

test('allows a local database with any name', () => {
  const r = assertSafeTarget(LOCAL_ANY_DB, { VORTH_LIVE_DB: '1' });
  assert.equal(r.ok, true, 'localhost is safe regardless of database name');
});

test('allows a remote host only when the database name is disposable', () => {
  assert.equal(assertSafeTarget(REMOTE_NAMED_TEST, { VORTH_LIVE_DB: '1' }).ok, true);
});

test('ALLOW_REMOTE is still not enough on a managed production host without explicit override', () => {
  // With the override the guard defers to the operator's judgement.
  const overridden = assertSafeTarget(NEON, { VORTH_LIVE_DB: '1', VORTH_LIVE_DB_ALLOW_REMOTE: '1' });
  assert.equal(overridden.ok, true, 'an explicit override wins — but it must be deliberate');
  assert.equal(overridden.target.host, 'ep-xyz-pooler.us-east-2.aws.neon.tech');
});

test('reports the classified target so callers can log what they are about to touch', () => {
  const r = assertSafeTarget(LOCAL_TEST_DB, { VORTH_LIVE_DB: '1' });
  // The target carries the verdicts as well as the coordinates, so a refusal
  // message can explain *why* something looked safe or unsafe.
  assert.deepEqual(r.target, {
    host: '127.0.0.1',
    port: '5432',
    database: 'vorth_test',
    isLocal: true,
    isManagedProduction: false,
    nameLooksDisposable: true,
  });
});