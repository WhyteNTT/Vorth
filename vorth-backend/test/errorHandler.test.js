'use strict';

/**
 * What the API says when something goes wrong.
 *
 * This is the last thing standing between an internal failure and a reader, and
 * it is the one file where being wrong is invisible: nothing breaks, the pages
 * still load, and the only symptom is a leaked schema name in a JSON body that
 * no one reads by hand. The frontend already rewrites 5xx bodies before showing
 * them - frontendErrors.test.js proves that - which is exactly why the wire
 * format needs its own tests. Anything a browser hides, curl does not.
 */

process.env.DATABASE_URL ||= 'postgres://stub/stub';
process.env.DATABASE_SSL = 'false';
process.env.JWT_SECRET ||= 'test-secret';
process.env.NODE_ENV = 'test';
process.env.RATE_LIMIT_MAX_REQUESTS = '100000';
process.env.AUTH_RATE_LIMIT_MAX_REQUESTS = '100000';

const test = require('node:test');
const assert = require('node:assert/strict');
const { notFound, errorHandler } = require('../src/middleware/errorHandler');
const ApiError = require('../src/utils/ApiError');

/** Drives the middleware the way Express does, and captures what it sends. */
function invoke(err, { method = 'GET', url = '/api/x' } = {}) {
  const req = { method, originalUrl: url, headers: {} };
  const out = { statusCode: null, body: null, type: null };
  const res = {
    status(code) { out.statusCode = code; return this; },
    json(payload) { out.body = payload; return this; },
    type(t) { out.type = t; return this; },
    set() { return this; },
    send(payload) { out.body = payload; return this; },
  };
  errorHandler(err, req, res, () => {});
  return out;
}

/** Silence the deliberate console.error for the 5xx cases. */
function quiet(fn) {
  const real = console.error;
  console.error = () => {};
  try { return fn(); } finally { console.error = real; }
}

/* ------------------------------------------------------------------ *
 * What must not reach the client
 * ------------------------------------------------------------------ */

test('a 500 does not carry an internal message over the wire', () => {
  /*
   * The frontend rewrites these before display, so the leak is invisible in the
   * browser and stays invisible until someone curls the API. A non-browser
   * client has no such filter, and neither will the next client this ships.
   */
  const leaks = [
    'relation "series" does not exist',
    'column "email_verified_at" does not exist',
    'ECONNREFUSED 127.0.0.1:5432',
    'duplicate key value violates unique constraint "users_email_key"',
    'EACCES: permission denied, open \'/app/uploads/cover.png\'',
    'password authentication failed for user "vorth"',
  ];

  for (const message of leaks) {
    const { statusCode, body } = quiet(() => invoke(new Error(message)));
    assert.equal(statusCode, 500);
    assert.ok(
      !JSON.stringify(body).includes(message),
      `a 500 body carried the internal message: ${JSON.stringify(body)}`
    );
    assert.ok(!/"relation"|"email_verified_at"|users_email_key/.test(JSON.stringify(body)),
      `a 500 body carried an internal identifier: ${JSON.stringify(body)}`);
  }
});

test('a stack is sent only when NODE_ENV is development, and not when it is unset', () => {
  /*
   * env.nodeEnv defaults to 'development', so a host that forgets NODE_ENV reads
   * as development and every 5xx ships a stack with full source paths. Render sets
   * it and .env.example documents it, but a fail-open default here is the wrong
   * direction: the cost of the mistake is a disclosure, and the cost of the fix is
   * one less debugging convenience on a machine nobody set up.
   *
   * The gate is asserted from both sides - set to development and a stack does
   * appear, so this is not "the stack was never sent" passing for the right reason.
   */
  const env = require('../src/config/env');
  const err = new Error('boom');
  err.stack = 'Error: boom\n    at /app/src/controllers/secret.js:12:9';

  for (const value of ['production', 'test', 'staging', undefined]) {
    env.nodeEnv = value;
    const out = quiet(() => invoke(err));
    assert.ok(!('stack' in out.body),
      `a stack was sent with NODE_ENV=${String(value)} (resolved ${env.nodeEnv})`);
    assert.ok(!JSON.stringify(out.body).includes('secret.js'),
      `a source path was sent with NODE_ENV=${String(value)}`);
  }

  env.nodeEnv = 'development';
  const dev = quiet(() => invoke(err));
  assert.ok('stack' in dev.body, 'a stack is not sent in development, so it is dead code');
  assert.match(dev.body.stack, /secret\.js/);

  // Restore whatever the process was configured with.
  env.nodeEnv = process.env.NODE_ENV || 'development';
});

test('a 500 that we wrote on purpose keeps its wording', () => {
  // ApiError.internal is a message a person chose for a reader. The filter above
  // keys on isOperational so it survives - otherwise the fix would throw away
  // information we decided to give.
  const out = quiet(() => invoke(ApiError.internal('The library is being rebuilt.')));
  assert.equal(out.statusCode, 500);
  assert.equal(out.body.message, 'The library is being rebuilt.');
});

test('a deliberate 4xx keeps its message, because someone wrote it for a reader', () => {
  // The opposite rule to the 5xx case, and it has to be stated or the fix above
  // looks like it could swallow real errors.
  const cases = [
    [ApiError.notFound('Series not found.'), 404, /Series not found/],
    [ApiError.badRequest('Rating must be 1-5'), 400, /Rating must be 1-5/],
    [ApiError.unauthorized('You must be signed in to do this.'), 401, /signed in/],
    [ApiError.forbidden('You can only delete your own comments.'), 403, /your own/],
    [ApiError.conflict('That value is already in use.'), 409, /already in use/],
  ];

  for (const [err, status, pattern] of cases) {
    const out = invoke(err);
    assert.equal(out.statusCode, status);
    assert.equal(out.body.success, false);
    assert.match(out.body.message, pattern);
  }
});

/* ------------------------------------------------------------------ *
 * Mapping what the database and the upload layer throw
 * ------------------------------------------------------------------ */

test('a malformed UUID is the caller\'s problem, not a server error', () => {
  // 22P02 is raised by the driver on a bad :id. Reporting 500 would page
  // someone for a mistyped URL and hide a 400 from the caller.
  const out = quiet(() => invoke(Object.assign(new Error('invalid input syntax for uuid'), { code: '22P02' })));
  assert.equal(out.statusCode, 400);
  assert.match(out.body.message, /invalid identifier/i);
});

test('a unique violation is a 409 and does not echo the constraint name', () => {
  // The constraint name is the useful part for a developer and a map of the
  // schema for anyone probing, so the message is fixed and the detail is not.
  const out = invoke(Object.assign(
    new Error('duplicate key value violates unique constraint "users_email_key"'),
    { code: '23505' },
  ));
  assert.equal(out.statusCode, 409);
  assert.doesNotMatch(out.body.message, /users_email_key/);
});

test('a foreign key violation is a 409 rather than a 500', () => {
  // 23503. Reachable by posting a comment on a series deleted mid-request, and
  // by a client racing a delete. A 500 there is noise in the logs and a lie to
  // the caller, who did nothing wrong beyond arriving slightly late.
  const out = quiet(() => invoke(Object.assign(
    new Error('insert or update on table "comments" violates foreign key constraint'),
    { code: '23503' },
  )));
  assert.equal(out.statusCode, 409);
  assert.doesNotMatch(out.body.message, /foreign key/);
});

test('a check-constraint violation is a 400', () => {
  const out = invoke(Object.assign(new Error('new row violates check constraint'), { code: '23514' }));
  assert.equal(out.statusCode, 400);
});

test('a multer error keeps its own wording, which is written for a reader', () => {
  // Multer's messages name the limit and the field ("Field "cover" exceeds the
  // configured limit of 5MB"), which is more useful than anything generic. They
  // are 4xx, so they are not filtered.
  const out = invoke(Object.assign(
    new Error('Field "cover" exceeds the configured limit of 5242880 bytes'),
    { name: 'MulterError' },
  ));
  assert.equal(out.statusCode, 400);
  assert.match(out.body.message, /exceeds the configured limit/);
});

test('a validation error is reported per field', () => {
  const err = new Error('Validation failed');
  err.name = 'ValidationError';
  err.errors = {
    rating: { path: 'rating', message: 'Rating must be 1-5' },
    text: { path: 'text', message: 'Review text is required' },
  };
  const out = invoke(err);
  assert.equal(out.statusCode, 400);
  assert.equal(out.body.message, 'Validation failed');
  assert.deepEqual(out.body.details, [
    { field: 'rating', message: 'Rating must be 1-5' },
    { field: 'text', message: 'Review text is required' },
  ]);
});

test('a body with no message still says something', () => {
  const bare = { statusCode: null };
  const out = quiet(() => invoke(bare));
  assert.equal(out.statusCode, 500);
  assert.equal(typeof out.body.message, 'string');
  assert.ok(out.body.message.length > 0, 'a failure produced an empty message');
});

test('details are null rather than absent when there are none', () => {
  // The frontend reads body.details, so a missing key is a different shape than
  // the one it was written against.
  const out = quiet(() => invoke(new Error('boom')));
  assert.ok('details' in out.body, 'the details key was missing entirely');
  assert.equal(out.body.details, null);
});

/* ------------------------------------------------------------------ *
 * notFound
 * ------------------------------------------------------------------ */

test('an unmatched route is a 404 that names the method and path', () => {
  let captured = null;
  notFound(
    { method: 'PATCH', originalUrl: '/api/nope/here' },
    {},
    (err) => { captured = err; },
  );
  assert.ok(captured instanceof ApiError);
  assert.equal(captured.statusCode, 404);
  assert.match(captured.message, /PATCH \/api\/nope\/here/);
});

test('a 404 does not imply a server fault, so nothing is logged', () => {
  let logged = 0;
  const real = console.error;
  console.error = () => { logged += 1; };
  try {
    invoke(ApiError.notFound('Route not found: GET /api/typo'));
  } finally {
    console.error = real;
  }
  assert.equal(logged, 0, 'a 404 was logged as a server error');
});