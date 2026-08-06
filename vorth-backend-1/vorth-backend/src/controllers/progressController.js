const { body } = require('express-validator');
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const throwIfInvalid = require('../utils/validate');
const ReadingProgress = require('../models/ReadingProgress');
const Series = require('../models/Series');
const Chapter = require('../models/Chapter');

// GET /api/progress — full reading history for the signed-in user, most recent first.
const list = asyncHandler(async (req, res) => {
  const progress = await ReadingProgress.find({ user: req.user.id })
    .sort({ updatedAt: -1 })
    .populate('series', 'title type coverImage')
    .populate('chapter', 'title num');
  res.json({ success: true, progress });
});

// GET /api/progress/:seriesId — resume point for one series.
const getForSeries = asyncHandler(async (req, res) => {
  const progress = await ReadingProgress.findOne({ user: req.user.id, series: req.params.seriesId })
    .populate('chapter', 'title num');
  if (!progress) return res.json({ success: true, progress: null });
  res.json({ success: true, progress });
});

// PUT /api/progress/:seriesId — upsert resume position. Called on scroll
// (novel) or page turn (comic), and again when explicitly bookmarking.
const upsertValidators = [
  body('chapterId').isMongoId().withMessage('A valid chapterId is required'),
  body('scrollPct').optional().isFloat({ min: 0, max: 1 }),
  body('page').optional().isInt({ min: 0 }),
  body('bookmarked').optional().isBoolean(),
];

const upsert = [
  ...upsertValidators,
  asyncHandler(async (req, res) => {
    throwIfInvalid(req);
    const { seriesId } = req.params;
    const { chapterId, scrollPct, page, bookmarked } = req.body;

    const [series, chapter] = await Promise.all([
      Series.findById(seriesId),
      Chapter.findById(chapterId),
    ]);
    if (!series || series.isRemoved) throw ApiError.notFound('Series not found.');
    if (!chapter || chapter.isRemoved || chapter.series.toString() !== seriesId) {
      throw ApiError.notFound('Chapter not found for this series.');
    }

    const update = { chapter: chapterId, type: series.type };
    if (scrollPct !== undefined) update.scrollPct = scrollPct;
    if (page !== undefined) update.page = page;
    if (bookmarked !== undefined) update.bookmarked = bookmarked;

    const progress = await ReadingProgress.findOneAndUpdate(
      { user: req.user.id, series: seriesId },
      { $set: update },
      { new: true, upsert: true, runValidators: true }
    );

    res.json({ success: true, progress });
  }),
];

// DELETE /api/progress/:seriesId — clear resume position for a series.
const remove = asyncHandler(async (req, res) => {
  await ReadingProgress.findOneAndDelete({ user: req.user.id, series: req.params.seriesId });
  res.json({ success: true, message: 'Progress cleared.' });
});

module.exports = { list, getForSeries, upsert, remove };
