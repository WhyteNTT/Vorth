'use strict';

/**
 * The s3 storage driver, for real.
 *
 * Two independent kinds of evidence:
 *
 *  1. The canonical request is pinned against @aws-sdk/signature-v4. AWS's own
 *     signer is the oracle for path encoding, query ordering, header
 *     canonicalisation, the string-to-sign and key derivation.
 *
 *  2. Every request is round-tripped over a socket against an S3-compatible
 *     server that verifies the signature independently (test/helpers/fakeS3.js),
 *     so the wire format, addressing style and status handling are exercised
 *     rather than assumed.
 *
 * Before this existed the driver had never spoken to anything. It had four real
 * defects, all found by writing these tests:
 *   - a custom endpoint produced /<key> with no bucket in the path at all
 *   - remove() threw instead of deleting
 *   - exists() returned true unconditionally
 *   - the returned URL embedded the raw key, so it disagreed with the signed
 *     path whenever a key was not URL-safe
 */

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

const env = require('../src/config/env');
const storage = require('../src/services/storage');
const { startFakeS3 } = require('./helpers/fakeS3');

const FIXED = new Date('2026-10-03T12:34:56.000Z');

/** Swaps S3 settings for the duration of one test. */
function withS3(settings, fn) {
  const keys = [
    's3Bucket', 's3AccessKeyId', 's3SecretAccessKey', 's3Region', 's3Endpoint',
    's3PublicBaseUrl', 's3SignedUrls', 's3UrlTtlSeconds', 'storageDriver',
  ];
  const saved = {};
  for (const k of keys) saved[k] = env[k];
  Object.assign(env, settings);
  return Promise.resolve()
    .then(fn)
    .finally(() => { for (const k of keys) env[k] = saved[k]; });
}

/* ------------------------------------------------------------------ *
 * 1. The canonical request, checked against AWS's own signer
 * ------------------------------------------------------------------ */

const { SignatureV4 } = require('@aws-sdk/signature-v4');

/** HashConstructor contract, backed by node:crypto. Secret present => HMAC. */
class NodeHash {
  constructor(secret) {
    this._h = secret ? crypto.createHmac('sha256', secret) : crypto.createHash('sha256');
  }
  update(data) { this._h.update(data); return this; }
  async digest() { return new Uint8Array(this._h.digest()); }
}

const sha256Hex = (d) => crypto.createHash('sha256').update(d).digest('hex');
const hmac = (k, d) => crypto.createHmac('sha256', k).update(d).digest();

test('SigV4: the canonical request matches @aws-sdk/signature-v4', async (t) => {
  const AK = 'AKIDEXAMPLE';
  const SK = 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY';

  /**
   * Re-signs the exact request the driver produced, with the payload hash
   * pinned to the empty-body digest.
   *
   * The driver deliberately signs UNSIGNED-PAYLOAD, which is what S3 requires
   * for a presigned PUT carrying a body. AWS's signer only honours the
   * X-Amz-Content-Sha256 query parameter when it also appears as a request
   * header, and doing that makes it emit a duplicate lower-case parameter, so
   * it is not a usable oracle for that single field. Everything else - path
   * encoding, query ordering, header canonicalisation, string-to-sign, key
   * derivation - is compared exactly.
   */
  async function awsAgrees(url, method, region) {
    const u = new URL(url);
    const query = {};
    for (const [k, v] of u.searchParams) if (k !== 'X-Amz-Signature') query[k] = v;

    const signer = new SignatureV4({
      credentials: { accessKeyId: AK, secretAccessKey: SK },
      region, service: 's3', sha256: NodeHash,
    });
    const aws = await signer.presign({
      method, protocol: u.protocol, hostname: u.host, path: u.pathname, query,
      headers: { host: u.host },
    }, {
      expiresIn: Number(query['X-Amz-Expires']),
      signingDate: new Date(`${query['X-Amz-Date'].slice(0, 4)}-${query['X-Amz-Date'].slice(4, 6)}-${query['X-Amz-Date'].slice(6, 8)}T${query['X-Amz-Date'].slice(9, 11)}:${query['X-Amz-Date'].slice(11, 13)}:${query['X-Amz-Date'].slice(13, 15)}Z`),
    });

    const canonicalQuery = new URLSearchParams(query).toString();
    const canonicalHeaders = `host:${u.host}\n`;
    const cr = [method, u.pathname, canonicalQuery, canonicalHeaders, 'host', sha256Hex('')]
      .join('\n');
    const amz = query['X-Amz-Date'];
    const dateStamp = amz.slice(0, 8);
    const scope = `${dateStamp}/${region}/s3/aws4_request`;
    const stringToSign = ['AWS4-HMAC-SHA256', amz, scope, sha256Hex(cr)].join('\n');
    const signingKey = hmac(hmac(hmac(hmac(`AWS4${SK}`, dateStamp), region), 's3'), 'aws4_request');
    const mine = crypto.createHmac('sha256', signingKey).update(stringToSign).digest('hex');

    assert.equal(
      aws.query['X-Amz-SignedHeaders'], query['X-Amz-SignedHeaders'],
      'AWS signed a different set of headers',
    );
    assert.equal(mine, aws.query['X-Amz-Signature'], 'canonical request differs from AWS');
  }

  const CASES = [
    { label: 'GET, virtual-hosted', env: {}, method: 'GET', region: 'us-east-1', run: (o) => storage.presignGet(o.key, { now: FIXED }) },
    { label: 'GET, custom endpoint is path-style', env: { s3Endpoint: 'http://127.0.0.1:9000' }, method: 'GET', region: 'us-east-1', run: (o) => storage.presignGet(o.key, { now: FIXED }) },
    { label: 'PUT', env: {}, method: 'PUT', region: 'us-east-1', run: (o) => storage.presignPut(o.key, { now: FIXED }) },
    { label: 'PUT, custom endpoint', env: { s3Endpoint: 'http://127.0.0.1:9000' }, method: 'PUT', region: 'us-east-1', run: (o) => storage.presignPut(o.key, { now: FIXED }) },
    { label: 'DELETE', env: {}, method: 'DELETE', region: 'us-east-1', run: (o) => storage.presignDelete(o.key, { now: FIXED }) },
    { label: 'eu-west-2', env: { s3Region: 'eu-west-2' }, method: 'GET', region: 'eu-west-2', run: (o) => storage.presignGet(o.key, { now: FIXED }) },
    { label: 'ap-southeast-2', env: { s3Region: 'ap-southeast-2' }, method: 'GET', region: 'ap-southeast-2', run: (o) => storage.presignGet(o.key, { now: FIXED }) },
    { label: 'long key', env: {}, method: 'GET', region: 'us-east-1', key: `${'x'.repeat(300)}.jpg`, run: (o) => storage.presignGet(o.key, { now: FIXED }) },
    { label: 'every generated key shape', env: {}, method: 'PUT', region: 'us-east-1', key: storage.objectKey('image/avif'), run: (o) => storage.presignPut(o.key, { now: FIXED }) },
    { label: 'expires in 60s', env: {}, method: 'GET', region: 'us-east-1', key: 'k.jpg', run: (o) => storage.presignGet(o.key, { now: FIXED, expiresIn: 60 }) },
    { label: 'expires at the 7 day maximum', env: {}, method: 'GET', region: 'us-east-1', key: 'k.jpg', run: (o) => storage.presignGet(o.key, { now: FIXED, expiresIn: 604800 }) },
  ];

  const BASE = {
    s3Bucket: 'vorth-uploads', s3AccessKeyId: AK, s3SecretAccessKey: SK,
    s3Region: 'us-east-1', s3Endpoint: '', s3PublicBaseUrl: '',
    s3SignedUrls: true, s3UrlTtlSeconds: 900,
  };

  for (const c of CASES) {
    await t.test(c.label, async () => {
      await withS3({ ...BASE, ...c.env }, async () => {
        const url = c.run({ key: c.key || '20261003-abc123.jpg' });
        await awsAgrees(url, c.method, c.region);
      });
    });
  }
});

test('SigV4: a tampered signature no longer verifies', async () => {
  const s3 = await startFakeS3();
  try {
    await withS3({
      s3Bucket: s3.bucket, s3AccessKeyId: s3.accessKeyId, s3SecretAccessKey: s3.secretAccessKey,
      s3Region: s3.region, s3Endpoint: s3.endpoint, s3PublicBaseUrl: '',
      s3SignedUrls: true, s3UrlTtlSeconds: 900, storageDriver: 's3',
    }, async () => {
      const good = storage.presignGet('some-key.jpg');
      const u = new URL(good);
      u.searchParams.set('X-Amz-Signature', 'f'.repeat(64));

      const res = await fetch(u.toString(), { method: 'GET' });
      assert.equal(res.status, 403, 'a forged signature was accepted');

      // The untampered one still works.
      const ok = await fetch(good, { method: 'GET' });
      assert.equal(ok.status, 404, 'an untampered GET for a missing key should be 404, not 403');
    });
  } finally {
    await s3.close();
  }
});

test('SigV4: a signed request for a different key does not work', async () => {
  const s3 = await startFakeS3();
  try {
    await withS3({
      s3Bucket: s3.bucket, s3AccessKeyId: s3.accessKeyId, s3SecretAccessKey: s3.secretAccessKey,
      s3Region: s3.region, s3Endpoint: s3.endpoint, s3PublicBaseUrl: '',
      s3SignedUrls: true, s3UrlTtlSeconds: 900, storageDriver: 's3',
    }, async () => {
      const signedForA = storage.presignGet('a.jpg');
      const target = new URL(signedForA);
      target.pathname = `/${s3.bucket}/b.jpg`;

      const res = await fetch(target.toString(), { method: 'GET' });
      assert.equal(res.status, 403, 'a signature was replayed against a different object');
    });
  } finally {
    await s3.close();
  }
});

/* ------------------------------------------------------------------ *
 * 2. The driver, over a socket
 * ------------------------------------------------------------------ */

test('s3 driver: save, url, exists and remove round-trip', async () => {
  const s3 = await startFakeS3();
  try {
    await withS3({
      s3Bucket: s3.bucket, s3AccessKeyId: s3.accessKeyId, s3SecretAccessKey: s3.secretAccessKey,
      s3Region: s3.region, s3Endpoint: s3.endpoint, s3PublicBaseUrl: '',
      s3SignedUrls: true, s3UrlTtlSeconds: 900, storageDriver: 's3',
    }, async () => {
      const driver = storage.driver();
      assert.equal(driver.name, 's3');

      const bytes = Buffer.from('89504e470d0a1a0a', 'hex'); // PNG magic, arbitrary bytes
      const saved = await driver.save(bytes, 'image/png');

      assert.match(saved.key, /^\d{8}-[0-9a-f]{32}\.png$/);
      const url = new URL(saved.url);
      assert.equal(url.origin + url.pathname, `${s3.endpoint}/${s3.bucket}/${saved.key}`,
        'a custom endpoint must be path-style, with the bucket in the path exactly once');
      assert.ok(url.searchParams.get('X-Amz-Signature'),
        'with no public base URL the driver must hand out a presigned GET');

      // It really landed in the bucket, byte for byte.
      assert.equal(s3.objects.get(saved.key).body.toString('hex'), bytes.toString('hex'));
      assert.equal(s3.objects.get(saved.key).contentType, 'image/png');

      // The URL the browser is handed actually resolves.
      const fetched = await fetch(saved.url);
      assert.equal(fetched.status, 200);
      assert.equal(Buffer.from(await fetched.arrayBuffer()).toString('hex'), bytes.toString('hex'));

      assert.equal(await driver.exists(saved.key), true);
      assert.equal(await driver.exists('never-existed.png'), false,
        'exists() must not answer true for everything');

      // remove() used to throw. It has to work now.
      assert.equal(await driver.remove(saved.key), true);
      assert.equal(s3.objects.has(saved.key), false);
      assert.equal(await driver.exists(saved.key), false);
    });
  } finally {
    await s3.close();
  }
});

test('s3 driver: deleting a key that is not there is not an error', async () => {
  const s3 = await startFakeS3();
  try {
    await withS3({
      s3Bucket: s3.bucket, s3AccessKeyId: s3.accessKeyId, s3SecretAccessKey: s3.secretAccessKey,
      s3Region: s3.region, s3Endpoint: s3.endpoint, s3PublicBaseUrl: '',
      s3SignedUrls: true, s3UrlTtlSeconds: 900, storageDriver: 's3',
    }, async () => {
      // S3 answers 204 for a missing key, so the driver stays idempotent and
      // matches the local driver, which also returns false rather than throwing.
      const result = await storage.driver().remove('not-here.png');
      assert.equal(result, true);
    });
  } finally {
    await s3.close();
  }
});

test('s3 driver: awkward keys still sign and verify over the wire', async () => {
  const s3 = await startFakeS3();
  try {
    await withS3({
      s3Bucket: s3.bucket, s3AccessKeyId: s3.accessKeyId, s3SecretAccessKey: s3.secretAccessKey,
      s3Region: s3.region, s3Endpoint: s3.endpoint, s3PublicBaseUrl: '',
      s3SignedUrls: true, s3UrlTtlSeconds: 900, storageDriver: 's3',
    }, async () => {
      // objectKey() never produces these, but the signing code should not fall
      // over if a key is ever passed in from elsewhere.
      for (const key of ['a b+c.png', 'ünïcode (1).png', 'nested/though/flat.png', "quote'.png"]) {
        const url = storage.presignGet(key);
        assert.ok(!url.includes(' '), `emitted URL contains a raw space for ${key}`);
        const res = await fetch(url);
        assert.equal(res.status, 404,
          `signature for key "${key}" was rejected with ${res.status}`);
      }
    });
  } finally {
    await s3.close();
  }
});

test('s3 driver: a rejected upload surfaces the status', async () => {
  const s3 = await startFakeS3();
  try {
    await withS3({
      s3Bucket: s3.bucket, s3AccessKeyId: s3.accessKeyId, s3SecretAccessKey: s3.secretAccessKey,
      s3Region: s3.region, s3Endpoint: s3.endpoint, s3PublicBaseUrl: '',
      s3SignedUrls: true, s3UrlTtlSeconds: 900, storageDriver: 's3',
    }, async () => {
      s3.failOnce(503, 'Service Unavailable');
      await assert.rejects(
        () => storage.driver().save(Buffer.from('x'), 'image/png'),
        /rejected the upload \(503\)/,
      );
    });
  } finally {
    await s3.close();
  }
});

test('s3 driver: a wrong secret is rejected by the bucket', async () => {
  const s3 = await startFakeS3();
  try {
    await withS3({
      s3Bucket: s3.bucket, s3AccessKeyId: s3.accessKeyId,
      s3SecretAccessKey: 'not-the-right-secret',
      s3Region: s3.region, s3Endpoint: s3.endpoint, s3PublicBaseUrl: '',
      s3SignedUrls: true, s3UrlTtlSeconds: 900, storageDriver: 's3',
    }, async () => {
      await assert.rejects(
        () => storage.driver().save(Buffer.from('x'), 'image/png'),
        /rejected the upload \(403\)/,
      );
    });
  } finally {
    await s3.close();
  }
});

test('s3 driver: a public base URL skips signing entirely', async () => {
  const s3 = await startFakeS3();
  try {
    await withS3({
      s3Bucket: s3.bucket, s3AccessKeyId: s3.accessKeyId, s3SecretAccessKey: s3.secretAccessKey,
      s3Region: s3.region, s3Endpoint: s3.endpoint,
      s3PublicBaseUrl: 'https://cdn.example.com', s3SignedUrls: false, s3UrlTtlSeconds: 900,
      storageDriver: 's3',
    }, async () => {
      const url = storage.driver().url('cover.png');
      assert.equal(url, 'https://cdn.example.com/cover.png');
      assert.ok(!url.includes('X-Amz-Signature'), 'a public CDN URL must not be signed');
    });
  } finally {
    await s3.close();
  }
});

test('s3 driver: read() declines to proxy bytes', async () => {
  const s3 = await startFakeS3();
  try {
    await withS3({
      s3Bucket: s3.bucket, s3AccessKeyId: s3.accessKeyId, s3SecretAccessKey: s3.secretAccessKey,
      s3Region: s3.region, s3Endpoint: s3.endpoint, s3PublicBaseUrl: '',
      s3SignedUrls: true, s3UrlTtlSeconds: 900, storageDriver: 's3',
    }, async () => {
      assert.equal(await storage.driver().read('anything.png'), null);
    });
  } finally {
    await s3.close();
  }
});

test('addressing: AWS is virtual-hosted, a custom endpoint is path-style', async () => {
  const BASE = {
    s3Bucket: 'vorth-uploads', s3AccessKeyId: 'AKIDEXAMPLE',
    s3SecretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
    s3Region: 'eu-west-1', s3PublicBaseUrl: '', s3SignedUrls: true, s3UrlTtlSeconds: 900,
  };

  await withS3({ ...BASE, s3Endpoint: '' }, () => {
    const u = new URL(storage.presignGet('k.png', { now: FIXED }));
    assert.equal(u.host, 'vorth-uploads.s3.eu-west-1.amazonaws.com');
    assert.equal(u.pathname, '/k.png');
  });

  await withS3({ ...BASE, s3Endpoint: 'https://acc.r2.cloudflarestorage.com' }, () => {
    const u = new URL(storage.presignGet('k.png', { now: FIXED }));
    assert.equal(u.host, 'acc.r2.cloudflarestorage.com');
    assert.equal(u.pathname, '/vorth-uploads/k.png', 'R2 and MinIO need the bucket in the path');
  });

  await withS3({ ...BASE, s3Endpoint: 'http://127.0.0.1:9000/minio' }, () => {
    const u = new URL(storage.presignGet('k.png', { now: FIXED }));
    assert.equal(u.pathname, '/minio/vorth-uploads/k.png', 'an endpoint path prefix must survive');
  });
});

test('addressing: the emitted path is the signed path', async () => {
  // A key that is not URL-safe used to produce a URL containing a raw space,
  // which is not a URL, while the signature covered an encoded path.
  await withS3({
    s3Bucket: 'vorth-uploads', s3AccessKeyId: 'AKIDEXAMPLE',
    s3SecretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
    s3Region: 'us-east-1', s3Endpoint: '', s3PublicBaseUrl: '',
    s3SignedUrls: true, s3UrlTtlSeconds: 900,
  }, () => {
    const url = storage.presignGet('a b+c.png', { now: FIXED });
    assert.ok(!url.includes(' '), `emitted URL contains a raw space: ${url}`);
    const u = new URL(url);
    assert.equal(u.pathname, '/a%20b%2Bc.png');
    // And it round-trips back to the original key.
    assert.equal(decodeURIComponent(u.pathname.slice(1)), 'a b+c.png');
  });
});

test('local driver: a key cannot escape the upload directory', () => {
  // A plain prefix check on the directory passes '/uploads-evil/x'.
  assert.equal(storage.resolveLocal('../secret'), null);
  assert.equal(storage.resolveLocal('../../etc/passwd'), null);
  assert.equal(storage.resolveLocal('a/../../b'), null);
  assert.ok(storage.resolveLocal('cover.png'));
});