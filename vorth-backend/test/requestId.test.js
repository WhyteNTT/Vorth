'use strict';

/**
 * Request correlation: every response carries an id, and every error log names it.
 *
 * The gap this closes: `errorHandler` logged `[error] <err>` with nothing
 * identifying the request, and morgan's `combined` format has no id. With concurrent
 * requests an operator had a stack trace and no way to find the request that produced
 * it.
 *
 * The tests are about the properties that make it usable rather than the mechanism:
 * the id reaches the client, it survives being supplied by a proxy, and it cannot be
 * used to forge a log line. That last one is the security property and it is the
 * reason the inbound value is validated rather than trusted.
 */

process.env.DATABASE_URL ||= 'postgres://stub/stub';
process.env.DATABASE_SSL = 'false';
process.env.JWT_SECRET ||= 'test-secret';
process.env.NODE_ENV = 'test';
process.env.RATE_LIMIT_MAX_REQUESTS = '100000';
process.env.AUTH_RATE_LIMIT_MAX_REQUESTS = '100000';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createFakePool } = require('./helpers/fakePool');

const { sanitizeInbound, MAX_LENGTH } = require('../src/middleware/requestId');

async function withServer(fn) {
  const fake = createFakePool({ rows: {} });
  const db = require('../src/config/db');
  const Base = require('../src/models/_base');
  Base._clearColumnCache();
  db.setPool(fake);

  const app = require('../src/app');
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const { port } = server.address();

  const call = async (path, headers = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { headers });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (_) { /* not JSON */ }
    return { status: res.status, body: json, text, id: res.headers.get('x-request-id') };
  };

  try {
    // port is passed through for the raw-socket case, which cannot go through fetch.
    return await fn({ call, port });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    db.setPool(null);
    Base._clearColumnCache();
  }
}

/* ================================================================== *
 * The id reaches the client
 * ================================================================== */

test('every response carries a request id', async () => {
  await withServer(async ({ call }) => {
    // Several routes, because the id has to be on all of them - not just the ones
    // that succeed, and not just the ones that log.
    for (const path of ['/api', '/api/health', '/api/series?limit=1', '/api/definitely/not/a/route']) {
      const res = await call(path);
      assert.ok(res.id, `no request id on ${path}`);
      assert.match(res.id, /^[0-9a-f-]{36}$/, `${path} returned the id ${JSON.stringify(res.id)}`);
    }
  });
});

test('ids are unique per request', async () => {
  await withServer(async ({ call }) => {
    const seen = new Set();
    for (let i = 0; i < 5; i += 1) {
      const { id } = await call('/api');
      assert.ok(!seen.has(id), 'the same id was issued twice');
      seen.add(id);
    }
  });
});

test('the id is on a 500 as well as on a 200', async () => {
  /*
   * The case that matters. A client hitting a bug needs to be able to quote the id,
   * and a 500 is exactly when someone reports a bug.
   *
   * The health endpoint answers 503 when the database is unreachable, which is the
   * cheapest genuine server-side failure available here.
   */
  await withServer(async ({ call }) => {
    const db = require('../src/config/db');
    db.setPool({ query: async () => { throw new Error('down'); } });
    const res = await call('/api/health');
    db.setPool(createFakePool({ rows: {} }));

    assert.ok(res.id, 'a failing response carried no request id');
    assert.equal(res.status, 503);
  });
});

/* ================================================================== *
 * A proxy or an upstream service supplies one
 * ================================================================== */

test('an inbound id is honoured, so a request keeps its identity', async () => {
  /*
   * Load balancers and API gateways set this. If we generated a fresh id instead, a
   * request crossing two services would have two ids and no way to join their logs.
   */
  await withServer(async ({ call }) => {
    const res = await call('/api', { 'X-Request-Id': 'edge-abc-123' });
    assert.equal(res.id, 'edge-abc-123');
  });
});

test('an inbound id with surrounding whitespace is trimmed, not rejected', async () => {
  // Proxies append and pad. Rejecting would lose the identity for a cosmetic reason.
  await withServer(async ({ call }) => {
    const res = await call('/api', { 'X-Request-Id': '  edge-abc-123  ' });
    assert.equal(res.id, 'edge-abc-123');
  });
});

/* ================================================================== *
 * The security property
 * ================================================================== */

test('an inbound id cannot forge a log line', async () => {
  /*
   * The reason the inbound value is validated at all.
   *
   * This value is written into log output verbatim. A caller who can put a newline in
   * it can make the log contain a line that looks like a real one - and a log you
   * cannot trust is worse than no log, because it is trusted anyway.
   *
   * Assessed on the sanitiser directly, because whether a newline survives into a log
   * depends on how the log is written, and the sanitiser is the boundary that
   * guarantees it does not matter.
   */
  for (const hostile of [
    'abc\r\n[error] req=spoofed GET /api/secret',
    'abc\ndef',
    'abc\rdef',
    'abc\x00def',
    'abc\x1b[31mred',
    'tab\there',
    'a b c',
  ]) {
    assert.equal(sanitizeInbound(hostile), null,
      `a hostile request id was accepted: ${JSON.stringify(hostile)}`);
  }
});

test('an over-long inbound id is discarded rather than truncated', async () => {
  /*
   * Truncating a forged id leaves a valid-looking prefix, so the log would show an id
   * that never matched any request. Replacing it entirely keeps the log and the
   * response consistent with each other.
   */
  const long = 'a'.repeat(MAX_LENGTH + 1);
  assert.equal(sanitizeInbound(long), null, 'an over-long id was accepted');

  const atLimit = 'a'.repeat(MAX_LENGTH);
  assert.equal(sanitizeInbound(atLimit), atLimit, 'an id at the limit was rejected');
});

test('a raw socket cannot inject a header line either', async () => {
  /*
   * The end-to-end version, with the request bytes written by hand.
   *
   * Two layers are involved and both were measured rather than assumed:
   *
   *   - Node's HTTP *client* refuses to send a header containing CRLF, so both
   *     `fetch` and `http.request` throw before the request leaves. That is why the
   *     first version of this test failed with "Headers.append: ... is an invalid
   *     header value" - the protection was the test harness, not the server.
   *   - Node's HTTP *server* rejects such a request with 400 before any middleware
   *     runs. Verified by writing the request text directly over a socket.
   *
   * So the sanitiser is defence in depth, not the only line. This asserts the outer
   * layer is there so nobody drops the inner one on the reasoning that the outer one
   * suffices.
   */
  const net = require('node:net');
  await withServer(async ({ port }) => {
    const response = await new Promise((resolve) => {
      const sock = net.connect(port, '127.0.0.1', () => {
        sock.write(
          'GET /api HTTP/1.1\r\n'
          + 'Host: 127.0.0.1\r\n'
          + 'X-Request-Id: abc\r\nspoofed\r\n'
          + 'Connection: close\r\n\r\n',
        );
      });
      let buf = '';
      sock.on('data', (c) => { buf += c.toString('latin1'); });
      sock.on('close', () => resolve(buf));
      sock.on('error', () => resolve(buf));
    });

    const status = Number((response.match(/^HTTP\/1\.\d (\d+)/) || [])[1]);
    assert.equal(status, 400,
      `the server accepted an injected header line: ${response.slice(0, 200)}`);
    assert.doesNotMatch(response, /spoofed/, 'the injected value appeared in the response');
  });
});

test('a non-string inbound id is rejected', async () => {
  // Node gives an array when the header appears more than once.
  assert.equal(sanitizeInbound(['a', 'b']), null);
  assert.equal(sanitizeInbound(undefined), null);
  assert.equal(sanitizeInbound(null), null);
  assert.equal(sanitizeInbound(42), null);
});

test('an empty or whitespace-only inbound id is replaced', async () => {
  assert.equal(sanitizeInbound(''), null);
  assert.equal(sanitizeInbound('   '), null);
});

test('the accepted character set is the documented one', () => {
  // Letters, digits, dot, underscore, dash. Enough for every real tracing header,
  // and nothing that needs quoting in a log format.
  assert.equal(sanitizeInbound('abc-123_XYZ.789'), 'abc-123_XYZ.789');
  for (const bad of ['abc/def', 'abc\\def', 'abc:def', 'abc(def)', 'abc"def', "abc'def", 'abc#def']) {
    assert.equal(sanitizeInbound(bad), null, `"${bad}" was accepted`);
  }
});

/* ================================================================== *
 * The error log
 * ================================================================== */

test('a 500 log line names the request', async () => {
  /*
   * The property the whole thing exists for. Intercepted rather than read from
   * stdout, because a test that depends on log ordering or on capturing the
   * process's output is a test that breaks when the logger is swapped.
   */
  await withServer(async ({ call }) => {
    const db = require('../src/config/db');
    const lines = [];
    const original = console.error;
    console.error = (...args) => lines.push(args.map(String).join(' '));

    db.setPool({ query: async () => { throw new Error('database is unreachable'); } });
    const res = await call('/api/series?limit=1');
    db.setPool(createFakePool({ rows: {} }));
    console.error = original;

    assert.equal(res.status, 500, 'the probe did not produce a 500');
    const line = lines.find((l) => l.startsWith('[error]'));
    assert.ok(line, `no error line was logged; got: ${JSON.stringify(lines)}`);

    assert.ok(line.includes(res.id), `the error line does not carry the response's id: ${line}`);
    assert.ok(line.includes('GET'), `the error line does not say what was requested: ${line}`);
    assert.ok(line.includes('/api/series'), `the error line does not say which path: ${line}`);
  });
});

test('a 4xx does not log a server error', async () => {
  // Noise is what makes people ignore a log. A 404 is the caller's mistake and
  // already recorded by the access log.
  await withServer(async ({ call }) => {
    const lines = [];
    const original = console.error;
    console.error = (...args) => lines.push(args.map(String).join(' '));

    await call('/api/definitely/not/a/route');
    console.error = original;

    assert.equal(lines.filter((l) => l.startsWith('[error]')).length, 0,
      `a client error was logged as a server error: ${JSON.stringify(lines)}`);
  });
});

test('a request rejected by the body parser still carries an id', async () => {
  /*
   * The ordering property, and the only thing that caught the `lateMount` mutant -
   * moving requestId below the body parsers. Everything else in this file passed
   * with it there, because a request that reaches a route is parsed fine and the id
   * is set either way.
   *
   * A malformed JSON body is rejected by `express.json()` itself and goes straight
   * to the error handler, skipping every route. If the id were assigned below the
   * parser there would be no `req.id`, so the error log line would read `req=-` and
   * the response would carry no id - and that is precisely the case an operator needs
   * to trace, because a client reporting "I got a 400 from your API" has nothing to
   * quote.
   */
  await withServer(async ({ port }) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/series`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"title": "unterminated',
    }).catch(() => null);

    // fetch may reject on some platforms for a body the server never parsed; the
    // assertion is on the response headers when there is one.
    if (res) {
      assert.ok(res.headers.get('x-request-id'),
        'a request the body parser rejected arrived with no id, so the id is assigned '
        + 'below the parser');
      const body = await res.text();
      assert.match(body, /success.*false/, `expected an error body: ${body.slice(0, 120)}`);
    }
  });
});

test('the id is on the response before the route runs, not added by the route', async () => {
  /*
   * If the id were set by a route handler it would be absent on 404s, on validation
   * failures, and on anything that throws before reaching a handler. Asserted on a
   * 404 because that path involves no route body at all.
   */
  await withServer(async ({ call }) => {
    const res = await call('/api/definitely/not/a/route');
    assert.equal(res.status, 404);
    assert.ok(res.id, 'a 404 arrived with no id, so the id is not set by middleware');
  });
});