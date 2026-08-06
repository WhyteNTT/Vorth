const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');

// POST /api/uploads/cover — single image field "cover"
const uploadCover = asyncHandler(async (req, res) => {
  if (!req.file) throw ApiError.badRequest('No cover image was uploaded.');
  res.status(201).json({ success: true, path: `/uploads/${req.file.filename}` });
});

// POST /api/uploads/pages — multiple images field "pages" (comic chapter pages)
const uploadPages = asyncHandler(async (req, res) => {
  if (!req.files || !req.files.length) throw ApiError.badRequest('No page images were uploaded.');
  const paths = req.files.map((f) => `/uploads/${f.filename}`);
  res.status(201).json({ success: true, paths });
});

module.exports = { uploadCover, uploadPages };
