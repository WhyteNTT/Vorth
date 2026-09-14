const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const Series = require('../models/Series');
const Chapter = require('../models/Chapter');

// Loads the series from :seriesId (or :id, for series-scoped routes) and
// verifies req.user is either its owner or an admin. Attaches the loaded
// series to req.series so downstream handlers don't re-fetch it.
//
// This is the enforcement point for "only the publishing author/artist
// can add chapters to their own series — everyone else can only read."
const requireSeriesOwner = asyncHandler(async (req, res, next) => {
  const seriesId = req.params.seriesId || req.params.id;
  const series = await Series.findById(seriesId);
  if (!series || series.isRemoved) throw ApiError.notFound('Series not found.');

  const isOwner = series.owner.toString() === req.user.id;
  const isAdmin = req.user.role === 'admin';
  if (!isOwner && !isAdmin) {
    throw ApiError.forbidden('Only the creator who published this series can modify it.');
  }

  req.series = series;
  next();
});

// Same idea, scoped to an individual chapter — loads it via :chapterId
// or :id, then checks ownership on its parent series.
const requireChapterOwner = asyncHandler(async (req, res, next) => {
  const chapterId = req.params.chapterId || req.params.id;
  const chapter = await Chapter.findById(chapterId);
  if (!chapter || chapter.isRemoved) throw ApiError.notFound('Chapter not found.');

  const series = await Series.findById(chapter.series);
  if (!series || series.isRemoved) throw ApiError.notFound('Series not found.');

  const isOwner = series.owner.toString() === req.user.id;
  const isAdmin = req.user.role === 'admin';
  if (!isOwner && !isAdmin) {
    throw ApiError.forbidden('Only the creator who published this series can modify its chapters.');
  }

  req.chapter = chapter;
  req.series = series;
  next();
});

module.exports = { requireSeriesOwner, requireChapterOwner };
