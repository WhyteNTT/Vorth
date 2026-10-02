const { body, param } = require('express-validator');
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const throwIfInvalid = require('../utils/validate');
const Series = require('../models/Series');
const Chapter = require('../models/Chapter');
const User = require('../models/User');

/** Shape of a jsonb library entry: an array of series ids. */
const libraryIds = (user) => (Array.isArray(user.library) ? user.library : []);

/**
 * GET /api/library — the signed-in user's saved series.
 *
 * Returns fully populated series documents rather than bare ids. The previous
 * version relied on a `populate({ path: 'library' })` call that silently did
 * nothing, so the client received an array of UUID strings and had to guess
 * how to render them.
 */
const getSaved = asyncHandler(async (req, res) => {
  const user = await User.findById(req.user.id);
  const ids = libraryIds(user);
  if (!ids.length) return res.json({ success: true, series: [], library: ids });

  const series = await Series.find({ id: { $in: ids }, isRemoved: false })
    .populate('owner', 'username displayName')
    .exec();

  // Preserve the order the user saved them in.
  const byId = new Map(series.map((s) => [String(s.id), s]));
  const ordered = ids.map((id) => byId.get(String(id))).filter(Boolean);
  res.json({ success: true, series: ordered });
});

// POST /api/library/:seriesId — save a series to the library.
const seriesParamValidators = [
  param('seriesId').isUUID().withMessage('A valid seriesId is required'),
];

const save = [
  ...seriesParamValidators,
  asyncHandler(async (req, res) => {
    throwIfInvalid(req);
    const series = await Series.findById(req.params.seriesId);
    if (!series || series.isRemoved) throw ApiError.notFound('Series not found.');

    if (!libraryIds(req.user).some((id) => String(id) === String(series._id))) {
      req.user.library = [...libraryIds(req.user), series._id];
      await req.user.save();
    }
    res.json({ success: true, library: req.user.library });
  }),
];

// DELETE /api/library/:seriesId — remove a series from the library.
const unsave = [
  ...seriesParamValidators,
  asyncHandler(async (req, res) => {
    throwIfInvalid(req);
    req.user.library = libraryIds(req.user).filter((id) => String(id) !== req.params.seriesId);
    await req.user.save();
    res.json({ success: true, library: req.user.library });
  }),
];

/**
 * GET /api/library/downloads — chapters marked for offline reading.
 *
 * Both the series and the chapter are resolved to real documents; the
 * frontend needs `chapter.id` to match a download back to the reader.
 */
const getDownloads = asyncHandler(async (req, res) => {
  const entries = Array.isArray(req.user.downloads) ? req.user.downloads : [];
  if (!entries.length) return res.json({ success: true, downloads: [] });

  const seriesIds = entries.map((d) => d.series).filter(Boolean);
  const chapterIds = entries.map((d) => d.chapter).filter(Boolean);

  const [series, chapters] = await Promise.all([
    Series.find({ id: { $in: seriesIds }, isRemoved: false }).exec(),
    Chapter.find({ id: { $in: chapterIds }, isRemoved: false }).exec(),
  ]);

  const seriesById = new Map(series.map((s) => [String(s.id), s]));
  const chapterById = new Map(chapters.map((c) => [String(c.id), c]));

  const downloads = entries
    .filter((d) => seriesById.get(String(d.series)) && chapterById.get(String(d.chapter)))
    .map((d) => ({
      series: seriesById.get(String(d.series)),
      chapter: chapterById.get(String(d.chapter)),
    }));

  res.json({ success: true, downloads });
});

// POST /api/library/downloads — mark a chapter for offline reading.
// Note: this records intent/metadata only. Actual offline asset caching
// (service worker, IndexedDB, etc.) is a frontend concern.
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
    if (!chapter || chapter.isRemoved || String(chapter.series) !== String(seriesId)) {
      throw ApiError.notFound('Chapter not found.');
    }

    const entries = Array.isArray(req.user.downloads) ? req.user.downloads : [];
    if (!entries.some((d) => String(d.chapter) === String(chapterId))) {
      req.user.downloads = [...entries, { series: seriesId, chapter: chapterId }];
      await req.user.save();
    }
    res.status(201).json({ success: true, downloads: req.user.downloads });
  }),
];

// DELETE /api/library/downloads/:chapterId
const removeDownload = [
  param('chapterId').isUUID().withMessage('A valid chapterId is required'),
  asyncHandler(async (req, res) => {
    throwIfInvalid(req);
    const entries = Array.isArray(req.user.downloads) ? req.user.downloads : [];
    req.user.downloads = entries.filter((d) => String(d.chapter) !== req.params.chapterId);
    await req.user.save();
    res.json({ success: true, downloads: req.user.downloads });
  }),
];

module.exports = { getSaved, save, unsave, getDownloads, addDownload, removeDownload };