const { body } = require('express-validator');
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const throwIfInvalid = require('../utils/validate');
const { withTransaction } = require('../config/db');
const Chapter = require('../models/Chapter');
const Series = require('../models/Series');
const Notification = require('../models/Notification');
const User = require('../models/User');
const { recordView, viewerKey } = require('../services/views');

/** Comic pages must reference uploads or https URLs, never free text. */
const pageArray = body('pages').optional({ nullable: true })
  .isArray({ max: 80 })
  .bail()
  .custom((value) => value.every((v) => typeof v === 'string'
    && (/^\/uploads\/[A-Za-z0-9._-]{1,120}$/.test(v) || /^https:\/\/[^\s"']{1,500}$/i.test(v))))
  .withMessage('Each page must be an /uploads/ path or an https:// URL.');

// POST /api/series/:seriesId/chapters — owner only (enforced by
// requireSeriesOwner middleware, which sets req.series). This is
// the enforcement point requested: only the creator who published a series
// can add chapters to it.
const createValidators = [
  body('title').trim().notEmpty().withMessage('Chapter title is required').isLength({ max: 150 }),
  body('paragraphs').optional({ nullable: true })
    .isArray({ max: 500 })
    .bail()
    .custom((value) => value.every((v) => typeof v === 'string' && v.length <= 20000))
    .withMessage('Paragraphs must be strings of at most 20000 characters.'),
  pageArray,
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

    // Reserve the chapter number and insert the chapter atomically. The
    // previous read-modify-write (`series.chapterCount + 1`) let two
    // concurrent creators pick the same number and one lost to the
    // UNIQUE(series, num) constraint.
    const chapter = await withTransaction(async (client) => {
      const num = await Series.nextChapterNumber(series._id, client);
      return Chapter.create({
        series: series._id,
        num,
        title,
        paragraphs: series.type === 'novel' ? paragraphs : undefined,
        pages: series.type === 'comic' ? pages : undefined,
      }, { client });
    });

    // Notify everyone who has this series in their library.
    const followers = await User.find({ library: series._id }).select('id').exec();
    if (followers.length) {
      await Notification.insertMany(followers.map((f) => ({
        user: f.id,
        type: 'new_chapter',
        message: `${series.title} just released Chapter ${chapter.num}: ${title}`,
        series: series._id,
      })));
    }

    res.status(201).json({ success: true, chapter });
  }),
];

// GET /api/chapters/:id — public read. Records a view (at most once per
// reader per day) which is what powers the rankings.
const getOne = asyncHandler(async (req, res) => {
  const chapter = await Chapter.findById(req.params.id);
  if (!chapter || chapter.isRemoved) throw ApiError.notFound('Chapter not found.');

  const series = await Series.findById(chapter.series);
  if (!series || series.isRemoved) throw ApiError.notFound('Series not found.');

  // Counting is idempotent, so a repeat read inside the same window is a
  // no-op rather than an unbounded write.
  await recordView({
    seriesId: series._id,
    chapterId: chapter._id,
    viewer: viewerKey(req),
  });

  res.json({
    success: true,
    chapter,
    series: { id: series._id, title: series.title, type: series.type },
  });
});

// PATCH /api/chapters/:id — owner only (requireChapterOwner sets req.chapter).
const updateValidators = [
  body('title').optional().trim().isLength({ min: 1, max: 150 }),
  body('paragraphs').optional({ nullable: true })
    .isArray({ max: 500 })
    .bail()
    .custom((value) => value.every((v) => typeof v === 'string' && v.length <= 20000))
    .withMessage('Paragraphs must be strings of at most 20000 characters.'),
  pageArray,
];

const update = [
  ...updateValidators,
  asyncHandler(async (req, res) => {
    throwIfInvalid(req);
    const { title, paragraphs, pages } = req.body;
    const nextParagraphs = paragraphs !== undefined ? paragraphs : req.chapter.paragraphs;
    const nextPages = pages !== undefined ? pages : req.chapter.pages;
    if (req.series.type === 'novel' && (pages !== undefined || !nextParagraphs || !nextParagraphs.length)) {
      throw ApiError.badRequest('Novel chapters need at least one paragraph and cannot contain comic pages.');
    }
    if (req.series.type === 'comic' && (paragraphs !== undefined || !nextPages || !nextPages.length)) {
      throw ApiError.badRequest('Comic chapters need at least one page and cannot contain novel paragraphs.');
    }
    if (title !== undefined) req.chapter.title = title;
    if (req.series.type === 'novel' && paragraphs !== undefined) req.chapter.paragraphs = paragraphs;
    if (req.series.type === 'comic' && pages !== undefined) req.chapter.pages = pages;
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