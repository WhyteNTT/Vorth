'use strict';

/**
 * The refresh cookie's SameSite policy, which is the whole reason this module
 * exists.
 *
 * A frontend on a different site than the API (Vercel in front of Render) needs
 * SameSite=None. A same-origin deployment must keep Lax, because Lax is what stops
 * a CSRF from borrowing the cookie. Getting this wrong in the permissive direction
 * weakens every deployment; getting it wrong in the strict direction silently
 * breaks refresh for the people who most need it to work.
 *
 * So these tests pin both directions, and specifically pin that the decision does
 * NOT fire in the cases where firing it would be harmful: no PUBLIC_URL, and
 * loopback on either side.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  needsCrossSiteCookie,
  refreshSameSite,
  refreshSecure,
  hostOf,
} = require('../src/utils/cookiePolicy');

/* ================================================================== *
 * The split deployment - the reason for the module
 * ================================================================== */

test('a foreign frontend origin requires SameSite=None', () => {
  assert.equal(
    needsCrossSiteCookie(['https://vorth.vercel.app'], 'https://vorth-api.onrender.com'),
    true,
  );
});

test('the split deployment cookie is None and necessarily Secure', () => {
  const env = {
    clientOrigins: ['https://vorth.vercel.app'],
    publicUrl: 'https://vorth-api.onrender.com',
    // Deliberately false. A browser rejects SameSite=None without Secure, so this
    // must be overridden - otherwise the fix breaks the deployments it was for.
    secureCookies: false,
  };
  assert.equal(refreshSameSite(env), 'none');
  assert.equal(refreshSecure(env), true);
});

/* ================================================================== *
 * The same-origin deployment keeps its CSRF protection
 * ================================================================== */

test('a same-origin deployment stays Lax', () => {
  assert.equal(
    needsCrossSiteCookie(['https://vorth-api.onrender.com'], 'https://vorth-api.onrender.com'),
    false,
  );
});

test('a www difference on our own host is not treated as foreign', () => {
  // A browser would not consider these cross-site, and Lax would work. Treating
  // them as foreign would needlessly weaken the cookie on a same-site deployment.
  assert.equal(
    needsCrossSiteCookie(['https://www.example.com'], 'https://example.com'),
    false,
  );
});

test('secure still follows the environment when the cookie is Lax', () => {
  // The opposite direction of the forced-Secure rule: Lax honours configuration.
  assert.equal(refreshSecure({
    clientOrigins: [], publicUrl: 'https://example.com', secureCookies: false,
  }), false);
});

/* ================================================================== *
 * Cases where it must NOT fire
 * ================================================================== */

test('no PUBLIC_URL means we cannot tell, so we keep the stricter default', () => {
  /*
   * This is the guard that matters most.
   *
   * Guessing "cross-site" when PUBLIC_URL is unset would weaken the cookie on
   * every deployment that has not set it - including production ones served from
   * a single host. Refusing to weaken on a guess is the whole point: a missing
   * config variable should cost the operator a warning, not silently downgrade
   * their CSRF posture.
   */
  assert.equal(needsCrossSiteCookie(['https://vorth.vercel.app'], ''), false);
  assert.equal(needsCrossSiteCookie(['https://vorth.vercel.app'], undefined), false);
  assert.equal(refreshSameSite({
    clientOrigins: ['https://vorth.vercel.app'], publicUrl: '',
  }), 'lax');
});

test('a malformed PUBLIC_URL is treated as unknown, not as foreign', () => {
  for (const bad of ['not a url', '://missing-scheme', 'http://', '   ']) {
    assert.equal(needsCrossSiteCookie(['https://vorth.vercel.app'], bad), false,
      `a malformed PUBLIC_URL (${JSON.stringify(bad)}) triggered the permissive branch`);
  }
});

test('loopback on either side is never cross-site', () => {
  /*
   * Local development runs the frontend on one port and the API on another, which
   * looks like a split but is not a site boundary. SameSite=None is additionally
   * rejected by browsers over plain http, so enabling it here would break
   * development rather than protect anything.
   */
  assert.equal(needsCrossSiteCookie(
    ['http://localhost:3000'], 'http://localhost:5000',
  ), false);
  assert.equal(needsCrossSiteCookie(
    ['http://127.0.0.1:8080'], 'https://vorth-api.onrender.com',
  ), false);
  assert.equal(needsCrossSiteCookie(
    ['https://vorth.vercel.app'], 'http://localhost:5000',
  ), false);
  assert.equal(needsCrossSiteCookie(
    ['http://app.localhost:3000'], 'http://localhost:5000',
  ), false);
});

test('no configured origins means no foreign site', () => {
  assert.equal(needsCrossSiteCookie([], 'https://vorth-api.onrender.com'), false);
});

/* ================================================================== *
 * Mixed and malformed input
 * ================================================================== */

test('one foreign origin among several is enough', () => {
  // Real deployments accumulate origins over time - a preview, a custom domain and
  // a forgotten dev host. The policy is permissive if ANY of them is foreign,
  // because the cookie has to work for all of them.
  assert.equal(needsCrossSiteCookie(
    ['https://vorth-api.onrender.com', 'https://vorth.vercel.app'],
    'https://vorth-api.onrender.com',
  ), true);
});

test('a malformed origin is ignored rather than crashing the boot', () => {
  // These come from the environment, which is attacker-adjacent: a typo should not
  // take the process down at require() time.
  const mixed = ['not a url', 'https://vorth.vercel.app', '', null];
  assert.equal(needsCrossSiteCookie(mixed, 'https://vorth-api.onrender.com'), true);
  // The malformed entries are skipped, so a list that is otherwise same-origin
  // stays same-origin rather than being dragged permissive by junk in it.
  assert.equal(needsCrossSiteCookie(
    ['not a url', 'https://vorth-api.onrender.com', ''], 'https://vorth-api.onrender.com',
  ), false);
});

test('a non-array CLIENT_ORIGINS does not throw', () => {
  // env.js always produces an array, but this is called at cookie-write time and a
  // TypeError here would surface as a 500 on login rather than a config error.
  assert.equal(needsCrossSiteCookie(undefined, 'https://example.com'), false);
  assert.equal(needsCrossSiteCookie(null, 'https://example.com'), false);
  assert.equal(needsCrossSiteCookie('https://a.example.com', 'https://example.com'), false);
});

test('hosts are compared case-insensitively', () => {
  // Browsers treat host case-insensitively, so a differently-cased origin must not
  // be mistaken for a foreign site and weaken the cookie.
  assert.equal(needsCrossSiteCookie(
    ['https://VORTH-API.onrender.com'], 'https://vorth-api.onrender.com',
  ), false);
});

test('hostOf reads a host from either a bare origin or a full URL', () => {
  assert.equal(hostOf('https://vorth.vercel.app'), 'vorth.vercel.app');
  assert.equal(hostOf('https://vorth.vercel.app/some/path?x=1'), 'vorth.vercel.app');
  assert.equal(hostOf('  https://vorth.vercel.app  '), 'vorth.vercel.app');
  for (const bad of ['', '   ', 'nonsense', null, undefined, 42, {}]) {
    assert.equal(hostOf(bad), null, `hostOf(${JSON.stringify(bad)}) should be null`);
  }
});