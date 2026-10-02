const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const storage = require('../services/storage');

/**
 * POST /api/uploads/cover — single image field "cover"
 *
 * The stored value is an object key. `path` remains the public URL so existing
 * clients keep working; `key` is what the client should persist.
 */
const uploadCover = asyncHandler(async (req, res) => {
  if (!req.file) throw ApiError.badRequest('No cover image was uploaded.');
  const { key, url } = await storage.driver().save(req.file.buffer, req.file.mimetype);
  res.status(201).json({ success: true, path: url, key, storage: storage.driver().name });
});

/**
 * POST /api/uploads/pages — multiple images, field "pages" (comic chapter pages)
 */
const uploadPages = asyncHandler(async (req, res) => {
  if (!req.files || !req.files.length) throw ApiError.badRequest('No page images were uploaded.');

  const saved = [];
  for (const file of req.files) {
    // Sequential on purpose: a comic chapter is uploaded in page order and the
    // order must be preserved in the response.
     
    saved.push(await storage.driver().save(file.buffer, file.mimetype));
  }

  res.status(201).json({
    success: true,
    paths: saved.map((s) => s.url),
    keys: saved.map((s) => s.key),
    storage: storage.driver().name,
  });
});

/**
 * GET /api/uploads/:key — serves an object through the API.
 * Only meaningful for the local driver; with object storage the browser
 * fetches straight from the bucket via a presigned URL.
 */
const serveObject = asyncHandler(async (req, res) => {
  const driver = storage.driver();
  const bytes = await driver.read(req.params.key);
  if (!bytes) throw ApiError.notFound('Upload not found.');
  res.type(req.params.key.endsWith('.png') ? 'image/png' : 'image/jpeg')
    .set('Cache-Control', 'public, max-age=31536000, immutable')
    .send(bytes);
});

module.exports = { uploadCover, uploadPages, serveObject };