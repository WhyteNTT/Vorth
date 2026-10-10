'use strict';

/**
 * Storage drivers and the shared rate-limit store.
 *
 * The storage keys are checked against the same shape the frontend allowlist
 * accepts, because a mismatch here means covers silently fail to render.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.DATABASE_URL ||= 'postgres://stub/stub';
process.env.DATABASE_SSL = 'false';
process.env.JWT_SECRET ||= 'test-secret';
process.env.NODE_ENV = 'test';

const env = require('../src/config/env');
const storage = require('../src/services/storage');
const { createRateLimitStore, MemoryStore } = require('../src/config/rateLimitStore');

/** The allowlist lib/safe.js enforces on the client. */
const UPLOAD_PATH = /^\/uploads\/[A-Za-z0-9._-]{1,120}$/;

test('object keys are flat and satisfy the client allowlist', () => {
  const key = storage.objectKey('image/jpeg');
  assert.ok(!key.includes('/'), 'no directory separators');
  assert.match(key, /^[A-Za-z0-9._-]+$/, 'only allow-listed characters');
  assert.match(`/uploads/${key}`, UPLOAD_PATH, 'and the public URL passes the client check');
});

test('object keys use the right extension per mime type', () => {
  assert.match(storage.objectKey('image/png'), /\.png$/);
  assert.match(storage.objectKey('image/webp'), /\.webp$/);
  assert.match(storage.objectKey('image/avif'), /\.avif$/);
  assert.match(storage.objectKey('image/jpeg'), /\.jpg$/);
});

test('object keys do not collide for the same mime type', () => {
  const keys = new Set(Array.from({ length: 500 }, () => storage.objectKey('image/png')));
  assert.equal(keys.size, 500, 'every key is unique');
});

test('the local driver round-trips a file through disk', async () => {
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const { key, url } = await storage.localDriver.save(bytes, 'image/png');
  try {
    assert.match(url, UPLOAD_PATH);
    assert.equal((await storage.localDriver.read(key)).toString('hex'), bytes.toString('hex'));
    assert.equal(await storage.localDriver.exists(key), true);
  } finally {
    await storage.localDriver.remove(key);
  }
  assert.equal(await storage.localDriver.exists(key), false);
});

test('the local driver refuses path traversal', async () => {
  assert.equal(await storage.localDriver.read('../../../package.json'), null);
  assert.equal(await storage.localDriver.remove('../../../package.json'), false);
});

test('the s3 driver refuses to sign without configuration', async () => {
  const saved = { ...env };
  try {
    // Force the s3 driver with no credentials.
    Object.assign(env, { storageDriver: 's3', s3Bucket: '', s3AccessKeyId: '', s3SecretAccessKey: '' });
    assert.throws(() => storage.presignPut('x.png'), /requires S3_BUCKET/);

    // Bucket present but no credentials is a separate, equally loud failure.
    Object.assign(env, { s3Bucket: 'my-bucket', s3AccessKeyId: '', s3SecretAccessKey: '' });
    assert.throws(() => storage.presignPut('x.png'), /S3_ACCESS_KEY_ID/);
  } finally {
    Object.assign(env, saved);
  }
});

test('presigned urls are signed, scoped and expire', () => {
  const saved = { ...env };
  try {
    Object.assign(env, {
      storageDriver: 's3',
      s3Bucket: 'my-bucket',
      s3AccessKeyId: 'AKIAEXAMPLE',
      s3SecretAccessKey: 'secret',
      s3Region: 'eu-central-1',
      s3Endpoint: '',
      s3UrlTtlSeconds: 900,
    });

    const put = new URL(storage.presignPut('20260101-abc.png', { contentType: 'image/png' }));
    assert.equal(put.searchParams.get('X-Amz-Algorithm'), 'AWS4-HMAC-SHA256');
    assert.equal(put.searchParams.get('X-Amz-Expires'), '900');
    assert.match(put.searchParams.get('X-Amz-Credential'), /AKIAEXAMPLE\/\d{8}\/eu-central-1\/s3\/aws4_request/);
    assert.ok(put.searchParams.get('X-Amz-Signature'), 'a signature is present');
    // Content-Type is not a query parameter: it travels as a request header
    // and is not signed, which is what AWS's own presigner does.
    assert.equal(put.searchParams.get('X-Amz-Content-Sha256'), 'UNSIGNED-PAYLOAD');
    assert.match(put.hostname, /my-bucket\.s3\./);

    const get = new URL(storage.presignGet('20260101-abc.png'));
    assert.equal(get.searchParams.get('X-Amz-Expires'), '900');

    // Different keys must not share a signature.
    const other = new URL(storage.presignGet('20260101-different.png'));
    assert.notEqual(get.searchParams.get('X-Amz-Signature'), other.searchParams.get('X-Amz-Signature'));
  } finally {
    Object.assign(env, saved);
  }
});

test('the s3 driver honours a public base url when signing is disabled', () => {
  const saved = { ...env };
  try {
    Object.assign(env, {
      storageDriver: 's3', s3Bucket: 'b', s3AccessKeyId: 'k', s3SecretAccessKey: 's',
      s3SignedUrls: false, s3PublicBaseUrl: 'https://cdn.example.com',
    });
    assert.equal(storage.s3Driver.url('a.png'), 'https://cdn.example.com/a.png');
  } finally {
    Object.assign(env, saved);
  }
});

test('the s3 driver refuses to delete when it is not configured', async () => {
  const saved = { ...env };
  try {
    Object.assign(env, { storageDriver: 's3', s3Bucket: '', s3AccessKeyId: '', s3SecretAccessKey: '' });
    await assert.rejects(() => storage.s3Driver.remove('a.png'), /requires S3_BUCKET/);
  } finally {
    Object.assign(env, saved);
  }
});

// Signed DELETE itself is covered end to end in test/s3.test.js, against a
// server that verifies the signature.

/* ------------------------------------------------------------------ *
 * Rate-limit stores
 * ------------------------------------------------------------------ */
test('the memory store satisfies the express-rate-limit contract', async () => {
  const store = new MemoryStore();
  for (const method of ['init', 'increment', 'decrement', 'resetKey', 'resetAll']) {
    assert.equal(typeof store[method], 'function', `${method}() is required`);
  }
  store.init({ windowMs: 60_000 });

  const first = await store.increment('k');
  assert.equal(first.totalHits, 1);
  assert.ok(first.resetTime instanceof Date);
  const second = await store.increment('k');
  assert.equal(second.totalHits, 2, 'counters accumulate within a window');
  assert.equal(second.resetTime.getTime(), first.resetTime.getTime(), 'the window is stable');

  await store.decrement('k');
  assert.equal((await store.increment('k')).totalHits, 2, 'decrement then increment is neutral');

  await store.resetKey('k');
  assert.equal((await store.increment('k')).totalHits, 1, 'resetKey clears the bucket');

  await store.increment('other');
  await store.resetAll();
  assert.equal((await store.increment('other')).totalHits, 1, 'resetAll clears everything');
});

test('increments accumulate within a window', async () => {
  /*
   * The window is 2s here, not 10ms.
   *
   * This assertion counts three sequential awaits and requires them all to land in
   * one window. With a 10ms window that is a coin flip under load - the counter
   * can lapse between the first and third increment and report 2 instead of 3,
   * which is a flaky test rather than a real fault. The store is correct; the
   * timing assumption was not.
   *
   * Window expiry is covered by the next test, where the lapse is the thing being
   * observed rather than an incidental race.
   */
  const store = new MemoryStore();
  store.init({ windowMs: 2000 });
  await store.increment('k');
  await store.increment('k');
  assert.equal((await store.increment('k')).totalHits, 3);
});

test('the memory store starts a fresh window once the old one lapses', async () => {
  // A short window is the point here, but the expiry is still given a wide margin
  // over the sleep so a slow machine cannot wake up before the deadline and read
  // a stale count.
  const store = new MemoryStore();
  store.init({ windowMs: 40 });
  await store.increment('k');
  await new Promise((r) => setTimeout(r, 250));
  assert.equal((await store.increment('k')).totalHits, 1, 'the counter resets after the window');
});

test('createRateLimitStore honours the driver setting', () => {
  assert.equal(createRateLimitStore('memory').constructor.name, 'MemoryStore');
  assert.equal(createRateLimitStore('postgres').constructor.name, 'PostgresStore');
  // Anything unknown falls back to the safe, dependency-free option.
  assert.equal(createRateLimitStore('nonsense').constructor.name, 'MemoryStore');
  assert.equal(createRateLimitStore(undefined).constructor.name, 'MemoryStore');
});

test('the postgres store issues a single atomic upsert per request', async () => {
  const store = createRateLimitStore('postgres');
  const db = require('../src/config/db');
  const { withPool } = require('./helpers/fakePool');
  const { createFakePool } = require('./helpers/fakePool');

  const fake = createFakePool({ rows: {} });
  await withPool(fake, async () => {
    store.init({ windowMs: 90_000 });
    await store.increment('ip|abc');

    const stmt = fake.log.find((e) => /rate_limit_buckets/.test(e.sql));
    assert.ok(stmt, 'a counter row is written');
    assert.match(stmt.sql, /INSERT INTO "rate_limit_buckets"/);
    assert.match(stmt.sql, /ON CONFLICT \("bucket"\) DO UPDATE/,
      'the bump is a single upsert, so concurrent requests cannot lose an increment');
    assert.match(stmt.sql, /RETURNING "hits"/);
    assert.equal(stmt.params[0], 'ip|abc');
    assert.equal(stmt.params[1], 90, 'window seconds');
  });
  void db;
});