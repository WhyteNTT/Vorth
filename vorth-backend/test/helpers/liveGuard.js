'use strict';

/**
 * Guard for tests that touch a real database.
 *
 * `test/postgres.live.test.js` executes destructive statements (DELETE) against
 * whatever DATABASE_URL points at - including the value loaded from a
 * developer's local `.env`, which is very often a real, remote, production
 * database.
 *
 * The classification and the rules live in src/config/hostGuard.js, shared with
 * connectDB(), so the two cannot drift apart. This file is the test-facing
 * wrapper.
 *
 * Two independent conditions must hold:
 *   1. explicit opt-in via VORTH_LIVE_DB=1
 *   2. the connection string looks like a local or disposable test database
 *
 * Set VORTH_LIVE_DB_ALLOW_REMOTE=1 to override (2) when you really do mean to
 * run against a shared scratch database - never for a production one.
 */

const {
  assertSafeTarget,
  classify,
  parseDatabaseUrl,
  LOCAL_HOSTS,
  MANAGED_PRODUCTION_HOSTS,
  TEST_NAME_MARKERS,
} = require('../../src/config/hostGuard');

module.exports = {
  assertSafeTarget,
  parseDatabaseUrl,
  classify,
  LOCAL_HOSTS,
  MANAGED_PRODUCTION_HOSTS,
  TEST_NAME_MARKERS,
};