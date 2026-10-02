'use strict';

/**
 * A minimal S3-compatible server for the test suite.
 *
 * Purpose: exercise the s3 driver's real HTTP behaviour - presigned PUT, GET,
 * HEAD, DELETE - over a socket, including status codes and idempotency. The
 * local disk driver never touches the network, so without this, the s3 driver's
 * request shape, addressing style and error handling are entirely untested.
 *
 * Signature checking is done by a second, independent implementation of the
 * SigV4 canonical request (server-side verify vs client-side sign). That cannot
 * catch a shared misreading of the specification, so test/s3.test.js *also*
 * pins the canonical request against @aws-sdk/signature-v4. Between the two,
 * a wrong query order, wrong percent-encoding, a missing parameter or a wrong
 * host all fail.
 *
 * Path-style addressing only, which is what every self-hosted S3-compatible
 * service requires.
 */

const http = require('http');
const crypto = require('crypto');

const sha256Hex = (d) => crypto.createHash('sha256').update(d).digest('hex');
const hmac = (k, d) => crypto.createHmac('sha256', k).update(d).digest();

/** Verifies the SigV4 signature on a presigned request. */
function verifySignature({ method, pathname, search, headers, accessKeyId, secretAccessKey, region }) {
  const params = new URLSearchParams(search);
  const signature = params.get('X-Amz-Signature');
  if (!signature) return { ok: false, reason: 'no X-Amz-Signature' };

  const algorithm = params.get('X-Amz-Algorithm');
  if (algorithm !== 'AWS4-HMAC-SHA256') return { ok: false, reason: `bad algorithm ${algorithm}` };

  const amzDate = params.get('X-Amz-Date');
  const credential = params.get('X-Amz-Credential') || '';
  const signedHeaders = params.get('X-Amz-SignedHeaders') || 'host';
  const expires = Number(params.get('X-Amz-Expires'));
  const contentSha = params.get('X-Amz-Content-Sha256') || 'UNSIGNED-PAYLOAD';

  const [credKey, credDate, credRegion, credService, credTerm] = credential.split('/');
  if (credKey !== accessKeyId) return { ok: false, reason: `unknown access key ${credKey}` };
  if (credService !== 's3' || credTerm !== 'aws4_request') {
    return { ok: false, reason: `bad credential scope ${credential}` };
  }
  if (credRegion !== region) return { ok: false, reason: `bad region ${credRegion}` };

  // Expiry.
  const signedAt = Date.parse(
    `${amzDate.slice(0, 4)}-${amzDate.slice(4, 6)}-${amzDate.slice(6, 8)}`
    + `T${amzDate.slice(9, 11)}:${amzDate.slice(11, 13)}:${amzDate.slice(13, 15)}Z`
  );
  if (Number.isNaN(signedAt)) return { ok: false, reason: `unparseable X-Amz-Date ${amzDate}` };
  if (expires > 604800) return { ok: false, reason: `X-Amz-Expires ${expires} exceeds the 7 day maximum` };
  if (Date.now() > signedAt + expires * 1000) return { ok: false, reason: 'signature has expired' };

  // Canonical query: every param except the signature, sorted by encoded name.
  const canonicalParams = [...params.entries()]
    .filter(([k]) => k !== 'X-Amz-Signature')
    .map(([k, v]) => [encodeRfc3986(k), encodeRfc3986(v)])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');

  // Canonical headers, from what actually arrived on the wire.
  const canonicalHeaderLines = signedHeaders.split(';').map((name) => {
    const value = name === 'host' ? headers.host : (headers[name] || '');
    return `${name}:${String(value).trim()}\n`;
  }).join('');

  const canonicalRequest = [
    method, pathname, canonicalParams, canonicalHeaderLines, signedHeaders, contentSha,
  ].join('\n');

  const scope = `${credDate}/${credRegion}/${credService}/${credTerm}`;
  const stringToSign = [
    'AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest),
  ].join('\n');

  const signingKey = hmac(
    hmac(hmac(hmac(`AWS4${secretAccessKey}`, credDate), credRegion), credService), credTerm
  );
  const expected = crypto.createHmac('sha256', signingKey).update(stringToSign).digest('hex');

  if (expected !== signature) {
    return {
      ok: false,
      reason: 'signature mismatch',
      canonicalRequest,
      expected,
      provided: signature,
    };
  }
  return { ok: true, canonicalRequest };
}

/** RFC 3986 encoding: AWS encodes space as %20, never as '+'. */
function encodeRfc3986(str) {
  return encodeURIComponent(str)
    .replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * Starts the server.
 *
 * `objects` is a Map that survives for the lifetime of the server so a test can
 * inspect what was actually stored.
 */
function startFakeS3({
  accessKeyId = 'AKIDEXAMPLE',
  secretAccessKey = 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
  region = 'us-east-1',
  bucket = 'vorth-uploads',
} = {}) {
  const objects = new Map();
  const seen = [];
  let failNext = null;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const method = req.method.toUpperCase();
    const body = await readBody(req);
    seen.push({ method, pathname: url.pathname, search: url.search, headers: { ...req.headers } });

    if (failNext) {
      const f = failNext;
      failNext = null;
      res.writeHead(f.status, { 'Content-Type': 'text/plain' });
      return res.end(f.body || 'injected failure');
    }

    // /<bucket>/<key...>
    const prefix = `/${bucket}/`;
    if (!url.pathname.startsWith(prefix)) {
      res.writeHead(404);
      return res.end('no such bucket');
    }
    const key = decodeURIComponent(url.pathname.slice(prefix.length));

    const verdict = verifySignature({
      method, pathname: url.pathname, search: url.search,
      headers: req.headers, accessKeyId, secretAccessKey, region,
    });
    if (!verdict.ok) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      return res.end(`SignatureDoesNotMatch: ${verdict.reason}`);
    }

    if (method === 'PUT') {
      objects.set(key, { body, contentType: req.headers['content-type'] });
      res.writeHead(200, { ETag: `"${crypto.createHash('md5').update(body).digest('hex')}"` });
      return res.end();
    }
    if (method === 'GET' || method === 'HEAD') {
      const found = objects.get(key);
      if (!found) { res.writeHead(404); return res.end(); }
      res.writeHead(200, {
        'Content-Type': found.contentType || 'application/octet-stream',
        'Content-Length': String(found.body.length),
      });
      return res.end(method === 'HEAD' ? undefined : found.body);
    }
    if (method === 'DELETE') {
      // S3 answers 204 whether or not the key existed.
      objects.delete(key);
      res.writeHead(204);
      return res.end();
    }
    res.writeHead(405);
    return res.end();
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        server,
        objects,
        seen,
        port,
        endpoint: `http://127.0.0.1:${port}`,
        bucket,
        accessKeyId,
        secretAccessKey,
        region,
        /** Make the next request fail, to exercise the driver's error paths. */
        failOnce(status, body) { failNext = { status, body }; },
        close() { return new Promise((r) => server.close(r)); },
      });
    });
  });
}

module.exports = { startFakeS3, verifySignature, encodeRfc3986 };