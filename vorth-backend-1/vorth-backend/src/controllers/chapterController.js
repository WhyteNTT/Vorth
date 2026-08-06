const { body } = require('express-validator');
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const throwIfInvalid = require('../utils/validate');
const Chapter = require('../models/Chapter');
const Series = require('../models/Series');
const Notification = require('../models/Notification');
const User = require('../models/User');

// POST /api/series/:seriesId/chapters — owner only (enforced by
// requireSeriesOwner middleware, which sets req.series). This is the
// enforcement point requested: only the creator who published a series
// can add chapters to it.
const createValidators = [
  body('title').trim().notEmpty().withMessage('Chapter title is required').isLength({ max: 150 }),
  body('paragraphs').optional().isArray({ max: 500 }),
  body('pages').optional().isArray({ max: 80 }),
];

const create = [
  ...createValidators,
  asyncHandler(async (req, res) => {
    throwIfInvalid(req);
    const { title, paragraphs, pages } = req.body;
    const series = req.series;

    if (series.type === 'novel' && (!paragraphs || !paragraphs.length)) {
      throw ApiError.badRequest('Novel chapters need at least one paragraph of content.');
    }
    if (series.type === 'comic' && (!pages || !pages.length)) {
      throw ApiError.badRequest('Comic chapters need at least one page image. Upload pages first via /api/uploads/pages.');
    }

    const nextNum = series.chapterCount + 1;
    const chapter = await Chapter.create({
      series: series._id,
      num: nextNum,
      title,
      paragraphs: series.type === 'novel' ? paragraphs : undefined,
      pages: series.type === 'comic' ? pages : undefined,
    });

    series.chapterCount = nextNum;
    await series.save();

    // Notify everyone who has this series in their library.
    const followers = await User.find({ library: series._id }).select('_id');
    if (followers.length) {
      await Notification.insertMany(
        followers.map((f) => ({
          user: f._id,
          type: 'new_chapter',
          message: `${series.title} just released Chapter ${nextNum}: ${title}`,
          series: series._id,
        }))
      );
    }

    res.status(201).json({ success: true, chapter });
  }),
];

// GET /api/chapters/:id — public read. Increments the chapter and
// series view counters, which is what powers the rankings.
const getOne = asyncHandler(async (req, res) => {
  const chapter = await Chapter.findById(req.params.id);
  if (!chapter || chapter.isRemoved) throw ApiError.notFound('Chapter not found.');

  const series = await Series.findById(chapter.series);
  if (!series || series.isRemoved) throw ApiError.notFound('Series not found.');

  chapter.views += 1;
  series.views.daily += 1;
  series.views.weekly += 1;
  series.views.alltime += 1;
  await Promise.all([chapter.save(), series.save()]);

  res.json({ success: true, chapter, series: { id: series._id, title: series.title, type: series.type } });
});

// PATCH /api/chapters/:id — owner only (requireChapterOwner sets req.chapter).
const updateValidators = [
  body('title').optional().trim().isLength({ min: 1, max: 150 }),
  body('paragraphs').optional().isArray({ max: 500 }),
  body('pages').optional().isArray({ max: 80 }),
];

const update = [
  ...updateValidators,
  asyncHandler(async (req, res) => {
    throwIfInvalid(req);
    const { title, paragraphs, pages } = req.body;
    if (title !== undefined) req.chapter.title = title;
    if (paragraphs !== undefined) req.chapter.paragraphs = paragraphs;
    if (pages !== undefined) req.chapter.pages = pages;
    await req.chapter.save();
    res.json({ success: true, chapter: req.chapter });
  }),
];

// DELETE /api/chapters/:id — owner only. Soft delete.
const remove = asyncHandler(async (req, res) => {
  req.chapter.isRemoved = true;
  await req.chapter.save();
  res.json({ success: true, message: 'Chapter removed.' });
});

module.exports = { create, getOne, update, remove };
