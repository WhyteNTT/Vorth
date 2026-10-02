const crypto = require('crypto');
const env = require('../config/env');
const ApiError = require('../utils/ApiError');
const storage = require('../services/storage');

/**
 * Multer configured to buffer in memory rather than write straight to disk.
 *
 * Buffering is what makes the storage driver swappable: the bytes reach the
 * storage layer, which decides between local disk and object storage. The
 * size cap keeps that safe in memory.
 */
const ALLOWED_MIME = storage.ALLOWED_MIME;

function fileFilter(req, file, cb) {
  if (!ALLOWED_MIME.has(file.mimetype)) {
    return cb(ApiError.badRequest('Only JPEG, PNG, WEBP, or AVIF images are allowed.'));
  }
  cb(null, true);
}

const upload = require('multer')({
  storage: require('multer').memoryStorage(),
  fileFilter,
  limits: {
    fileSize: env.maxUploadMb * 1024 * 1024,
    files: 60, // generous cap for a full comic chapter's pages in one request
  },
});

/** Hash of the bytes, so identical uploads can be detected and deduped. */
function fingerprint(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 32);
}

module.exports = upload;
module.exports.fingerprint = fingerprint;
module.exports.ALLOWED_MIME = ALLOWED_MIME;