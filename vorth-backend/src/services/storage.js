const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const env = require('../config/env');

/**
 * Upload storage.
 *
 * `local` (default) writes to uploads/ — fine for one server, but files are
 * lost on redeploy and invisible to other instances.
 *
 * `s3` targets any S3-compatible service (AWS S3, Cloudflare R2, MinIO,
 * Backblaze B2) using SigV4 signed requests implemented here, so there is no
 * SDK dependency. Bytes are uploaded by the API and served either from a
 * public base URL or through short-lived presigned GETs for a private bucket.
 */

const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/avif']);
const EXT_BY_MIME = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/avif': '.avif',
};

const UPLOAD_DIR = path.join(__dirname, '..', '..', 'uploads');

function assertConfigured() {
  if (!env.s3Bucket) throw new Error('STORAGE_DRIVER=s3 requires S3_BUCKET');
  if (!env.s3AccessKeyId || !env.s3SecretAccessKey) {
    throw new Error('STORAGE_DRIVER=s3 requires S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY');
  }
}

/**
 * Builds a collision-resistant, non-guessable object key.
 *
 * Deliberately flat (no directory separator) so the public URL shape stays
 * `/uploads/<name>`, which is what the frontend's allowlist validates and
 * what express.static serves.
 */
function objectKey(mimetype) {
  const ext = EXT_BY_MIME[mimetype] || '';
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  return `${stamp}-${crypto.randomBytes(16).toString('hex')}${ext}`;
}

/* ------------------------------------------------------------------ *
 * SigV4 (no SDK)
 * ------------------------------------------------------------------ */

const sha256Hex = (data) => crypto.createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();

function amzDate(now = new Date()) {
  const iso = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  return { amz: iso, dateStamp: iso.slice(0, 8) };
}

/**
 * Produces a presigned PUT so a client can upload straight to the bucket
 * without the bytes traversing the API.
 */
function presignPut(key, { expiresIn = env.s3UrlTtlSeconds, contentType } = {}) {
  assertConfigured();
  const { amz, dateStamp } = amzDate();
  const credentialScope = `${dateStamp}/${env.s3Region}/s3/aws4_request`;
  const host = env.s3Endpoint
    ? new URL(env.s3Endpoint).host
    : `${env.s3Bucket}.s3.${env.s3Region}.amazonaws.com`;

  const canonicalHeaders = `host:${host}\n`;
  const signedHeaders = 'host';
  const query = new URLSearchParams({
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${env.s3AccessKeyId}/${credentialScope}`,
    'X-Amz-Date': amz,
    'X-Amz-Expires': String(expiresIn),
    'X-Amz-SignedHeaders': signedHeaders,
  });
  if (contentType) query.set('Content-Type', contentType);

  const canonicalRequest = [
    'PUT', `/${key}`, query.toString(), canonicalHeaders, signedHeaders,
    'UNSIGNED-PAYLOAD',
  ].join('\n');

  const stringToSign = [
    'AWS4-HMAC-SHA256', amz, credentialScope, sha256Hex(canonicalRequest),
  ].join('\n');

  const signingKey = hmac(
    hmac(hmac(hmac(`AWS4${env.s3SecretAccessKey}`, dateStamp), env.s3Region), 's3'),
    'aws4_request'
  );
  const signature = crypto.createHmac('sha256', signingKey).update(stringToSign).digest('hex');

  const base = env.s3Endpoint || `https://${host}`;
  return `${base}/${key}?${query.toString()}&X-Amz-Signature=${signature}`;
}

function presignGet(key, { expiresIn = env.s3UrlTtlSeconds } = {}) {
  assertConfigured();
  const { amz, dateStamp } = amzDate();
  const credentialScope = `${dateStamp}/${env.s3Region}/s3/aws4_request`;
  const host = env.s3Endpoint
    ? new URL(env.s3Endpoint).host
    : `${env.s3Bucket}.s3.${env.s3Region}.amazonaws.com`;

  const query = new URLSearchParams({
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${env.s3AccessKeyId}/${credentialScope}`,
    'X-Amz-Date': amz,
    'X-Amz-Expires': String(expiresIn),
    'X-Amz-SignedHeaders': 'host',
  });

  const canonicalRequest = ['GET', `/${key}`, query.toString(), `host:${host}\n`, 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  const stringToSign = ['AWS4-HMAC-SHA256', amz, credentialScope, sha256Hex(canonicalRequest)].join('\n');
  const signingKey = hmac(
    hmac(hmac(hmac(`AWS4${env.s3SecretAccessKey}`, dateStamp), env.s3Region), 's3'),
    'aws4_request'
  );
  const signature = crypto.createHmac('sha256', signingKey).update(stringToSign).digest('hex');

  const base = env.s3Endpoint || `https://${host}`;
  return `${base}/${key}?${query.toString()}&X-Amz-Signature=${signature}`;
}

/* ------------------------------------------------------------------ *
 * Drivers
 * ------------------------------------------------------------------ */

const localDriver = {
  name: 'local',

  async save(buffer, mimetype) {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    const key = objectKey(mimetype);
    fs.writeFileSync(path.join(UPLOAD_DIR, key), buffer);
    return { key, url: `/uploads/${key}` };
  },

  /** Serves the bytes back through the API. */
  async read(key) {
    const file = path.join(UPLOAD_DIR, key);
    // Defend against traversal even though keys are generated.
    if (!path.resolve(file).startsWith(path.resolve(UPLOAD_DIR))) return null;
    return fs.promises.readFile(file);
  },

  async remove(key) {
    const file = path.join(UPLOAD_DIR, key);
    if (!path.resolve(file).startsWith(path.resolve(UPLOAD_DIR))) return false;
    try { await fs.promises.unlink(file); return true; } catch (_) { return false; }
  },

  async exists(key) {
    try { await fs.promises.access(path.join(UPLOAD_DIR, key)); return true; } catch (_) { return false; }
  },

  /** Where the browser should fetch the asset from. */
  url(key) { return `/uploads/${key}`; },
};

const s3Driver = {
  name: 's3',

  async save(buffer, mimetype) {
    assertConfigured();
    const key = objectKey(mimetype);
    const putUrl = presignPut(key, { contentType: mimetype });
    const response = await fetch(putUrl, {
      method: 'PUT',
      headers: { 'Content-Type': mimetype },
      body: buffer,
    });
    if (!response.ok) {
      throw new Error(`Object storage rejected the upload (${response.status})`);
    }
    return { key, url: s3Driver.url(key) };
  },

  async read() {
    // Bytes are fetched by the browser through a presigned URL, so the API
    // never proxies them. Returning null makes the /uploads route 404 rather
    // than silently pulling the whole object through the process.
    return null;
  },

  async remove(_key) {
    assertConfigured();
    // A signed DELETE request is not implemented. Failing loudly is better than
    // shipping a delete that silently does nothing; rely on bucket lifecycle
    // rules or `forceDelete` to remove objects.
    throw new Error(
      'Deleting from object storage is not implemented. Configure a bucket lifecycle '
      + 'rule, or switch STORAGE_DRIVER=local to use in-process pruning.'
    );
  },

  async exists() { return true; },

  url(key) {
    // A public base URL means the bucket (or CDN) is world-readable; otherwise
    // hand out a short-lived presigned GET.
    if (!env.s3SignedUrls && env.s3PublicBaseUrl) return `${env.s3PublicBaseUrl}/${key}`;
    if (env.s3PublicBaseUrl && !env.s3SignedUrls) return `${env.s3PublicBaseUrl}/${key}`;
    return presignGet(key);
  },
};

function driver() {
  return env.storageDriver === 's3' ? s3Driver : localDriver;
}

module.exports = {
  driver, localDriver, s3Driver,
  ALLOWED_MIME, EXT_BY_MIME, objectKey, presignPut, presignGet, UPLOAD_DIR,
};