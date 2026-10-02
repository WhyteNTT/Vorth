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
 * runtime SDK dependency. Bytes are uploaded by the API and served either from
 * a public base URL or through short-lived presigned GETs for a private bucket.
 *
 * The signature is verified two ways in the test suite: against AWS's own
 * documented example, and by diffing the output of @aws-sdk/s3-request-presigner
 * for the same inputs. See test/s3.test.js.
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
 * SigV4 (no runtime SDK)
 * ------------------------------------------------------------------ */

const sha256Hex = (data) => crypto.createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();

function amzDate(now) {
  const iso = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  return { amz: iso, dateStamp: iso.slice(0, 8) };
}

/**
 * S3 is not a path-style service by default, but every self-hosted
 * S3-compatible server (MinIO, Ceph, most on-prem gateways) needs it, and so
 * does any custom endpoint. Getting this wrong means the bucket never appears
 * in the URL at all, so the object lands under a bucket named after the key.
 */
function addressing() {
  if (env.s3Endpoint) {
    const url = new URL(env.s3Endpoint);
    // An endpoint may carry its own path prefix (http://host/minio), and the
    // bucket always follows it.
    const prefix = `${url.pathname.replace(/\/+$/, '')}/${env.s3Bucket}`;
    return {
      host: url.host,
      origin: url.origin,
      // The bucket belongs in the path exactly once.
      canonicalUri: (key) => `${prefix}/${encodeKey(key)}`,
    };
  }
  const host = `${env.s3Bucket}.s3.${env.s3Region}.amazonaws.com`;
  return {
    host,
    origin: `https://${host}`,
    canonicalUri: (key) => `/${encodeKey(key)}`,
  };
}

/** URI-encodes each path segment exactly once, which is what S3 expects. */
function encodeKey(key) {
  return String(key)
    .split('/')
    .map((segment) => encodeURIComponent(segment).replace(/[!'()*]/g, (c) =>
      `%${c.charCodeAt(0).toString(16).toUpperCase()}`))
    .join('/');
}

/**
 * Builds a SigV4 presigned URL.
 *
 * Only `host` is signed, which is what AWS's own presigner does by default.
 * Any extra headers passed here are folded into the canonical request, and the
 * caller must then send exactly those values or the signature will not match.
 */
function presign(method, key, {
  expiresIn = env.s3UrlTtlSeconds,
  extraHeaders = {},
  now = new Date(),
} = {}) {
  assertConfigured();
  const { amz, dateStamp } = amzDate(now);
  const credentialScope = `${dateStamp}/${env.s3Region}/s3/aws4_request`;
  const { host, origin, canonicalUri } = addressing();

  const headers = { host, ...extraHeaders };
  const headerNames = Object.keys(headers).sort();
  const canonicalHeaders = headerNames.map((h) => `${h}:${String(headers[h]).trim()}\n`).join('');
  const signedHeaders = headerNames.join(';');

  const query = new URLSearchParams({
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    // AWS includes this in presigned S3 URLs. It is part of the canonical
    // request, so omitting it is legal but produces a signature that differs
    // from every official client - which made it impossible to prove this
    // implementation correct by diffing against @aws-sdk/s3-request-presigner.
    'X-Amz-Content-Sha256': 'UNSIGNED-PAYLOAD',
    'X-Amz-Credential': `${env.s3AccessKeyId}/${credentialScope}`,
    'X-Amz-Date': amz,
    'X-Amz-Expires': String(expiresIn),
    'X-Amz-SignedHeaders': signedHeaders,
  });
  const canonicalQuery = query.toString();

  const canonicalRequest = [
    method, canonicalUri(key), canonicalQuery, canonicalHeaders, signedHeaders,
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

  // Use the encoded path here too, so the URL that is handed out and the
  // path that was signed are the same string.
  return `${origin}${canonicalUri(key)}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

function presignPut(key, options = {}) {
  return presign('PUT', key, options);
}

function presignGet(key, options = {}) {
  return presign('GET', key, options);
}

function presignDelete(key, options = {}) {
  return presign('DELETE', key, options);
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
    const file = resolveLocal(key);
    if (!file) return null;
    try { return await fs.promises.readFile(file); } catch (_) { return null; }
  },

  async remove(key) {
    const file = resolveLocal(key);
    if (!file) return false;
    try { await fs.promises.unlink(file); return true; } catch (_) { return false; }
  },

  async exists(key) {
    const file = resolveLocal(key);
    if (!file) return false;
    try { await fs.promises.access(file); return true; } catch (_) { return false; }
  },

  /** Where the browser should fetch the asset from. */
  url(key) { return `/uploads/${key}`; },
};

/**
 * Resolves a key inside the upload directory, or null if it escapes.
 *
 * The comparison includes the separator, so `/uploads-evil/x` cannot pass a
 * plain prefix check on `/uploads`.
 */
function resolveLocal(key) {
  const root = path.resolve(UPLOAD_DIR);
  const file = path.resolve(root, key);
  if (file !== root && !file.startsWith(root + path.sep)) return null;
  return file;
}

const s3Driver = {
  name: 's3',

  async save(buffer, mimetype) {
    assertConfigured();
    const key = objectKey(mimetype);
    const putUrl = presignPut(key);
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

  /**
   * Signed DELETE.
   *
   * S3 answers 204 for a key that does not exist, so a delete is idempotent
   * here too, matching the local driver. A pre-existing bucket lifecycle rule
   * is still the better long-term answer for abandoned objects; this is for
   * removing a specific object the moment it is orphaned.
   */
  async remove(key) {
    assertConfigured();
    const response = await fetch(presignDelete(key), { method: 'DELETE' });
    if (!response.ok && response.status !== 404) {
      throw new Error(`Object storage rejected the delete (${response.status})`);
    }
    return true;
  },

  /** A real check: a HEAD against the bucket, signed like any other request. */
  async exists(key) {
    assertConfigured();
    const url = presign('HEAD', key);
    const response = await fetch(url, { method: 'HEAD' });
    return response.ok;
  },

  url(key) {
    // A public base URL means the bucket (or a CDN in front of it) is
    // world-readable; otherwise hand out a short-lived presigned GET.
    if (env.s3PublicBaseUrl && !env.s3SignedUrls) return `${env.s3PublicBaseUrl}/${key}`;
    return presignGet(key);
  },
};

function driver() {
  return env.storageDriver === 's3' ? s3Driver : localDriver;
}

module.exports = {
  driver, localDriver, s3Driver,
  ALLOWED_MIME, EXT_BY_MIME, objectKey,
  presign, presignPut, presignGet, presignDelete,
  addressing, encodeKey, resolveLocal,
  UPLOAD_DIR,
};