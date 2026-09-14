const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const { body } = require('express-validator');
const throwIfInvalid = require('../utils/validate');
const Series = require('../models/Series');
const Chapter = require('../models/Chapter');
const User = require('../models/User');

// GET /api/library — the signed-in user's saved series.
const getSaved = asyncHandler(async (req, res) => {
  const user = await User.findById(req.user.id).populate({
    path: 'library',
    match: { isRemoved: false },
  });
  res.json({ success: true, series: user.library });
});

// POST /api/library/:seriesId — save a series to the library.
const save = asyncHandler(async (req, res) => {
  const series = await Series.findById(req.params.seriesId);
  if (!series || series.isRemoved) throw ApiError.notFound('Series not found.');

  if (!req.user.library.some((id) => id.toString() === series._id.toString())) {
    req.user.library.push(series._id);
    await req.user.save();
  }
  res.json({ success: true, library: req.user.library });
});

// DELETE /api/library/:seriesId — remove a series from the library.
const unsave = asyncHandler(async (req, res) => {
  req.user.library = req.user.library.filter((id) => id.toString() !== req.params.seriesId);
  await req.user.save();
  res.json({ success: true, library: req.user.library });
});

// GET /api/library/downloads — chapters marked for offline reading.
const getDownloads = asyncHandler(async (req, res) => {
  const user = await User.findById(req.user.id)
    .populate({ path: 'downloads.series', match: { isRemoved: false } })
    .populate({ path: 'downloads.chapter', match: { isRemoved: false } });
  const downloads = user.downloads.filter((d) => d.series && d.chapter);
  res.json({ success: true, downloads });
});

// POST /api/library/downloads — mark a chapter for offline reading.
// Note: this endpoint records intent/metadata only. Actual offline asset
// caching (service worker, IndexedDB, etc.) is a frontend concern.
const addDownload = [
  body('seriesId').isUUID().withMessage('A valid seriesId is required'),
  body('chapterId').isUUID().withMessage('A valid chapterId is required'),
  asyncHandler(async (req, res) => {
  throwIfInvalid(req);
  const { seriesId, chapterId } = req.body;
  const [series, chapter] = await Promise.all([
    Series.findById(seriesId),
    Chapter.findById(chapterId),
  ]);
  if (!series || series.isRemoved) throw ApiError.notFound('Series not found.');
  if (!chapter || chapter.isRemoved || chapter.series.toString() !== seriesId) {
    throw ApiError.notFound('Chapter not found.');
  }

  const already = req.user.downloads.some(
    (d) => d.chapter.toString() === chapterId
  );
  if (!already) {
    req.user.downloads.push({ series: seriesId, chapter: chapterId });
    await req.user.save();
  }
  res.status(201).json({ success: true, downloads: req.user.downloads });
  }),
];

// DELETE /api/library/downloads/:chapterId
const removeDownload = asyncHandler(async (req, res) => {
  req.user.downloads = req.user.downloads.filter(
    (d) => d.chapter.toString() !== req.params.chapterId
  );
  await req.user.save();
  res.json({ success: true, downloads: req.user.downloads });
});

module.exports = { getSaved, save, unsave, getDownloads, addDownload, removeDownload };
