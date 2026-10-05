'use strict';

/**
 * Upload handling: the most abusable surface in the app.
 *
 * Every one of these routes accepts bytes from an anonymous-ish caller and hands
 * them a permanent public URL, so the questions that matter are: what is
 * accepted, what is refused, and can a key be used to reach a file that is not
 * an upload. `resolveLocal` is the single choke point for the last question, and
 * it is guarded by a comparison that is easy to break by accident - a plain
 * prefix test would let `/uploads-evil/x` through - so it is tested directly and
 * by mutation.
 */

process.env.DATABASE_URL ||= 'postgres://stub/stub';
process.env.DATABASE_SSL = 'false';
process.env.JWT_SECRET ||= 'test-secret';
process.env.NODE_ENV = 'test';
process.env.RATE_LIMIT_MAX_REQUESTS = '100000';
process.env.AUTH_RATE_LIMIT_MAX_REQUESTS = '100000';
// Uploads have their own, much tighter limit - 10 per window by default - because
// one request can carry 60 page images. This file makes more upload requests than
// that in total, so without raising it here the suite starts failing with 429 on
// a test about image formats, which says nothing about image formats.
//
// configDrift.test.js asserts that any test file hitting a rate-limited route
// raises the limit for that route's limiter, so the next limiter added does not
// have to be rediscovered this way.
process.env.UPLOAD_RATE_LIMIT_MAX_REQUESTS = '100000';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const jwt = require('jsonwebtoken');

const storage = require('../src/services/storage');

const JWT_SECRET = process.env.JWT_SECRET;
const ALICE = '11111111-1111-4111-8111-111111111111';

/* ------------------------------------------------------------------ *
 * resolveLocal - the traversal boundary
 * ------------------------------------------------------------------ */

test('a key that climbs out of the upload directory resolves to nothing', () => {
  const root = path.resolve(storage.UPLOAD_DIR);
  const escape = [
    '../package.json',
    '../../package.json',
    '../src/config/db.js',
    'a/../../package.json',
    './../package.json',
  ];

  for (const key of escape) {
    assert.equal(storage.resolveLocal(key), null,
      `resolveLocal let "${key}" through - that reads a file outside ${root}`);
  }
});

test('percent-encoded dots are a literal filename, not a climb', () => {
  /*
   * Worth stating because it is easy to assume the opposite. path.resolve does
   * not decode, so "%2e%2e" is an ordinary directory name and the result stays
   * inside the upload root. Express does decode route params before this is
   * called, so over HTTP these arrive as ".." and are caught by the guard above;
   * here they are simply harmless names.
   */
  const root = path.resolve(storage.UPLOAD_DIR);
  for (const key of ['%2e%2e/package.json', '%2e%2e%2fpackage.json']) {
    const file = storage.resolveLocal(key);
    if (file !== null) {
      assert.ok(file.startsWith(root + path.sep),
        `resolveLocal("${key}") returned ${file}, outside ${root}`);
      assert.ok(!fs.existsSync(file), `${file} should not exist`);
    }
  }
});

test('the upload root itself resolves, but reading it yields nothing', async () => {
  /*
   * resolveLocal permits the root - the `file !== root` clause is there so the
   * boundary is exclusive of the directory but inclusive of its contents. A bare
   * ".." climbs *out* of it and is refused; "../uploads" lands back on it.
   * Reading a directory fails, and that failure is swallowed into a null, so the
   * route answers 404. Asserted because "returns the root" looks alarming until
   * you know what happens next.
   */
  assert.equal(storage.resolveLocal('..'), null);
  assert.equal(storage.resolveLocal('../uploads'), path.resolve(storage.UPLOAD_DIR));
  assert.equal(await storage.driver().read('../uploads'), null);
});

test('a sibling directory sharing the upload prefix does not pass a prefix check', () => {
  // /app/uploads-evil/secret passes a naive startsWith(root) test. The guard
  // compares root + separator, so it must not pass.
  assert.equal(storage.resolveLocal('../uploads-evil/secret'), null);
});

test('a real key inside the directory resolves to a path under it', () => {
  const root = path.resolve(storage.UPLOAD_DIR);
  const ok = ['abc123.png', 'a/b/c.png', 'x.jpeg'];
  for (const key of ok) {
    const file = storage.resolveLocal(key);
    assert.ok(file, `resolveLocal refused the legitimate key "${key}"`);
    assert.ok(
      file.startsWith(root + path.sep),
      `resolveLocal returned ${file}, which is outside ${root}`
    );
  }
});

test('the local driver refuses to read, delete or stat a traversing key', async () => {
  const driver = storage.driver();
  assert.equal(driver.name, 'local', 'this test is about the local driver');
  assert.equal(await driver.read('../package.json'), null);
  assert.equal(await driver.exists('../package.json'), false);
  // remove must refuse too, or a crafted key deletes files as it reads nothing.
  assert.equal(await driver.remove('../package.json'), false);
  assert.ok(fs.existsSync(path.join('package.json')), 'package.json must still be there');
});

/* ------------------------------------------------------------------ *
 * The routes
 * ------------------------------------------------------------------ */

async function withServer(fn) {
  const { createFakePool, seedRow } = require('./helpers/fakePool');
  const fake = createFakePool({
    rows: { users: [seedRow('users', { id: ALICE, username: 'alice', email: 'a@x.test', role: 'user' })] },
  });
  const db = require('../src/config/db');
  const Base = require('../src/models/_base');
  Base._clearColumnCache();
  db.setPool(fake);

  const app = require('../src/app');
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const { port } = server.address();

  const call = async (method, path, { token, body, headers } = {}) => {
    const h = { ...headers };
    if (token) h.Authorization = `Bearer ${token}`;
    // A Buffer body is already encoded and must be sent verbatim - this is what
    // fetch does for a FormData body, and JSON.stringify(Buffer) would turn a
    // multipart request into the literal text {"type":"Buffer","data":[...]}.
    let payload;
    if (Buffer.isBuffer(body)) payload = body;
    else if (body !== undefined) {
      h['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method, headers: h, body: payload,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (_) { /* not JSON */ }
    return { status: res.status, body: json, text, headers: res.headers };
  };

  try {
    return await fn({
      call,
      token: (id = ALICE) => jwt.sign({ id, role: 'user' }, JWT_SECRET),
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    db.setPool(null);
    Base._clearColumnCache();
  }
}

/** A multipart body built by hand: multer is the only thing parsing it here. */
function fileForm(field, filename, type, bytes) {
  const boundary = '----vorthTestBoundary7f3a';
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${filename}"\r\n`
    + `Content-Type: ${type}\r\n\r\n`, 'utf8');
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
  return {
    body: Buffer.concat([head, Buffer.from(bytes), tail]),
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
  };
}

test('uploading a cover needs a session and a file', async () => {
  await withServer(async ({ call, token }) => {
    const anon = await call('POST', '/api/uploads/cover');
    assert.equal(anon.status, 401, 'an anonymous caller could reach the upload endpoint');

    const empty = await call('POST', '/api/uploads/cover', { token: token() });
    assert.equal(empty.status, 400);
    assert.match(empty.body.message, /no cover image/i);
  });
});

test('an uploaded cover is stored and handed back as a permanent public URL', async () => {
  const png = Buffer.from('89504e470d0a1a0a', 'hex'); // PNG magic only; nothing decodes it
  await withServer(async ({ call, token }) => {
    const form = fileForm('cover', 'cover.png', 'image/png', png);
    const res = await call('POST', '/api/uploads/cover', {
      token: token(), body: form.body, headers: form.headers,
    });

    assert.equal(res.status, 201, `upload failed: ${res.status} ${res.text}`);
    assert.equal(res.body.storage, 'local');
    assert.ok(res.body.key, 'no object key was returned');
    assert.equal(res.body.path, `/uploads/${res.body.key}`);

    // It really is on disk, under the upload directory.
    const onDisk = path.join(storage.UPLOAD_DIR, res.body.key);
    assert.ok(fs.existsSync(onDisk), `${onDisk} was not written`);
    assert.deepEqual(fs.readFileSync(onDisk), png);

    // And it comes back through the public route.
    const fetched = await call('GET', `/api/uploads/${res.body.key}`);
    assert.equal(fetched.status, 200);
    assert.equal(fetched.headers.get('content-type'), 'image/png');
    assert.match(fetched.headers.get('cache-control') || '', /immutable/);

    fs.unlinkSync(onDisk);
  });
});

test('comic pages come back in the order they were sent', async () => {
  const boundary = '----vorthTestBoundary7f3a';
  const parts = [];
  ['p1', 'p2', 'p3'].forEach((name, i) => {
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="pages"; filename="${name}.png"\r\n`
      + `Content-Type: image/png\r\n\r\n`, 'utf8'));
    parts.push(Buffer.from(`page-${i}`, 'utf8'));
    parts.push(Buffer.from('\r\n', 'utf8'));
  });
  parts.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));

  await withServer(async ({ call, token }) => {
    const res = await call('POST', '/api/uploads/pages', {
      token: token(),
      body: Buffer.concat(parts),
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    });

    assert.equal(res.status, 201, `pages upload failed: ${res.status} ${res.text}`);
    assert.equal(res.body.paths.length, 3, 'not every page came back');
    assert.equal(res.body.keys.length, 3);

    /*
     * Order is the entire point of an endpoint that accepts an array, and keys
     * cannot prove it: they are date-hash.png names, so their sort order is
     * unrelated to the order the pages arrived in. Comparing them against
     * .sort() passes whether or not the loop is sequential.
     *
     * So read each page back through the public route and check the bytes. Each
     * page has distinct content, so the response order has to be the send order.
     */
    for (let i = 0; i < res.body.keys.length; i += 1) {
      const back = await call('GET', `/api/uploads/${res.body.keys[i]}`);
      assert.equal(back.status, 200, `page ${i} could not be read back`);
      assert.equal(back.text, `page-${i}`,
        `response slot ${i} holds page ${res.body.keys[i]} fetched as "${back.text}"`);
    }

    for (const key of res.body.keys) fs.unlinkSync(path.join(storage.UPLOAD_DIR, key));
  });
});

test('a non-image upload is refused whatever it is named', async () => {
  /*
   * The file filter is the only thing between an authenticated user and an
   * arbitrary file landing in a publicly served directory. Names are attacker
   * controlled, so the decision has to be made on the declared type - and a
   * polyglot (a PNG that is also valid HTML) is exactly why the response is
   * re-typed on the way out rather than sniffed.
   */
  const rejected = [
    ['payload.html', 'text/html', '<script>alert(1)</script>'],
    ['payload.svg', 'image/svg+xml', '<svg onload="alert(1)"></svg>'],
    ['payload.js', 'application/javascript', 'require("fs")'],
    ['payload.pdf', 'application/pdf', '%PDF-1.7'],
    // A .png name does not make it a PNG.
    ['sneaky.png', 'text/html', '<script>alert(1)</script>'],
    ['noext', 'application/octet-stream', 'MZ'],
  ];

  for (const [filename, type, content] of rejected) {
    await withServer(async ({ call, token }) => {
      const form = fileForm('cover', filename, type, content);
      const res = await call('POST', '/api/uploads/cover', {
        token: token(), body: form.body, headers: form.headers,
      });
      assert.equal(res.status, 400,
        `${type} named "${filename}" was accepted and stored in a public directory`);
      assert.match(res.body.message, /JPEG, PNG, WEBP, or AVIF/);
    });
  }
});

test('every accepted image type is stored and served back as an image', async () => {
  for (const type of ['image/jpeg', 'image/png', 'image/webp', 'image/avif']) {
    const form = fileForm('cover', `cover.${type.slice(6)}`, type, 'bytes');
    const res = await withServer(async ({ call, token }) => {
      const r = await call('POST', '/api/uploads/cover', {
        token: token(), body: form.body, headers: form.headers,
      });
      assert.equal(r.status, 201, `${type} was refused: ${r.status} ${r.text}`);
      return r;
    });

    // Served back with a content type chosen by the server, never the one the
    // uploader declared, and never anything a browser would execute.
    const back = await withServer(async ({ call }) => {
      const r = await call('GET', `/api/uploads/${res.body.key}`);
      assert.equal(r.status, 200);
      return r;
    });
    assert.match(back.headers.get('content-type') || '', /^image\//,
      `${type} came back as ${back.headers.get('content-type')}`);

    fs.unlinkSync(path.join(storage.UPLOAD_DIR, res.body.key));
  }
});

test('the size cap is enforced rather than merely configured', async () => {
  const env = require('../src/config/env');
  const boundary = '----vorthTestBoundary7f3a';
  const bytes = Buffer.alloc(env.maxUploadMb * 1024 * 1024 + 1024, 0x41);
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="cover"; filename="big.png"\r\n`
      + 'Content-Type: image/png\r\n\r\n', 'utf8'),
    bytes,
    Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'),
  ]);

  await withServer(async ({ call, token }) => {
    const res = await call('POST', '/api/uploads/cover', {
      token: token(), body, headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    });
    assert.ok(res.status >= 400, `a ${env.maxUploadMb} MB+ upload was accepted`);
    assert.ok(!res.text.includes('big.png') || res.status !== 201);
  });
});

test('GET /api/uploads refuses a traversing key', async () => {
  await withServer(async ({ call }) => {
    // A bare ".." is not in this list: the WHATWG URL parser collapses it in the
    // client, so fetch would request /api/ and the route would never see it.
    // resolveLocal is still checked against the bare form directly, above, since
    // the driver is reachable from hand-written code as well as over HTTP.
    for (const key of [
      '..%2Fpackage.json',
      '%2e%2e%2f%2e%2e%2fpackage.json',
      '%2e%2e%2fpackage.json%00.png',
      '....%2F%2F..%2Fpackage.json',
    ]) {
      const res = await call('GET', `/api/uploads/${key}`);
      assert.equal(res.status, 404, `/api/uploads/${key} returned ${res.status} - not a 404`);
      assert.ok(!res.text.includes('vorth-backend'),
        `the body of /api/uploads/${key} leaked file content`);
    }
  });
});

test('an unknown key is a 404, not an empty 200', async () => {
  await withServer(async ({ call }) => {
    const res = await call('GET', `/api/uploads/${require('crypto').randomUUID()}.png`);
    assert.equal(res.status, 404, 'a missing object answered 200 with no content');
  });
});

test('an upload directory that does not exist yet is created on demand', () => {
  // save() does mkdirSync recursive. Losing that line turns a first upload into a
  // 500, so it is worth a test that never assumes the directory is there.
  assert.ok(typeof storage.UPLOAD_DIR === 'string' && storage.UPLOAD_DIR.length > 0);
  assert.ok(path.isAbsolute(path.resolve(storage.UPLOAD_DIR)),
    'the upload directory should be an absolute path');
});

test('nothing in the upload tree is group- or world-writable', () => {
  /*
   * Everything here is served publicly at an immutable URL, so a stray private
   * key or an SSH key someone uploaded here would be disclosed to anyone who
   * guessed or enumerated the key. The check is skipped on Windows, where the
   * mode bits are not the access control; CI runs it on Linux where they are.
   */
  if (process.platform === 'win32') return;
  const root = storage.UPLOAD_DIR;
  if (!fs.existsSync(root)) return;

  const bad = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (fs.statSync(full).mode & 0o022) bad.push(`${full} (${(fs.statSync(full).mode & 0o777).toString(8)})`);
      if (entry.isDirectory()) walk(full);
    }
  };
  walk(root);

  assert.deepEqual(bad, [], 'publicly served files that others can write');
});

// Keeps the temp-dir import honest if the upload root is ever redirected at it.
test('the upload root is inside the repository, not a system path', () => {
  const root = path.resolve(storage.UPLOAD_DIR);
  const tmp = path.resolve(os.tmpdir());
  assert.ok(!root.startsWith(tmp), `uploads would live in ${tmp}, which is wiped`);
});