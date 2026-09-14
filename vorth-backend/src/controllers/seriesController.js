const { body, query } = require('express-validator');
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const throwIfInvalid = require('../utils/validate');
const Series = require('../models/Series');
const Chapter = require('../models/Chapter');
const Comment = require('../models/Comment');

const MAX_PAGE_SIZE = 48;

// GET /api/series — browse/search/filter/sort with pagination.
// No seed data is ever injected here: an empty catalog returns an empty array.
const listValidators = [
  query('page').optional().isInt({ min: 1 }).toInt(),
  query('limit').optional().isInt({ min: 1, max: MAX_PAGE_SIZE }).toInt(),
  query('type').optional().isIn(['novel', 'comic']),
  query('status').optional().isIn(['Ongoing', 'Completed', 'Hiatus']),
  query('sort').optional().isIn(['popular', 'rating', 'newest', 'az']),
];

const list = [
  ...listValidators,
  asyncHandler(async (req, res) => {
    throwIfInvalid(req);
    const {
      type, genre, status, tag, q,
      sort = 'popular',
      page = 1,
      limit = 24,
    } = req.query;

    const filter = { isRemoved: false };
    if (type && ['novel', 'comic'].includes(type)) filter.type = type;
    if (status && ['Ongoing', 'Completed', 'Hiatus'].includes(status)) filter.status = status;
    if (genre) filter.genres = genre;
    if (tag) filter.tags = tag;
    if (q) filter.$text = { $search: q };

    const sortMap = {
      popular: { 'views.alltime': -1 },
      rating: { ratingAvg: -1, ratingCount: -1 },
      newest: { createdAt: -1 },
      az: { title: 1 },
    };
    const sortSpec = sortMap[sort] || sortMap.popular;

    const skip = (page - 1) * limit;
    const [items, total] = await Promise.all([
      Series.find(filter).sort(sortSpec).skip(skip).limit(limit).populate('owner', 'username displayName'),
      Series.countDocuments(filter),
    ]);

    res.json({
      success: true,
      count: items.length,
      total,
      page,
      pages: Math.ceil(total / limit) || 1,
      series: items,
    });
  }),
];

// GET /api/series/rankings?range=daily|weekly|alltime
const rankings = asyncHandler(async (req, res) => {
  const range = ['daily', 'weekly', 'alltime'].includes(req.query.range) ? req.query.range : 'daily';
  const items = await Series.find({ isRemoved: false })
    .sort({ [`views.${range}`]: -1 })
    .limit(10)
    .select('title type author genres views ratingAvg coverImage slug');
  res.json({ success: true, range, series: items });
});

// GET /api/series/:id — full detail. Publicly readable by design; only
// writes (create/update chapters) are ownership-gated.
const getOne = asyncHandler(async (req, res) => {
  const series = await Series.findById(req.params.id).populate('owner', 'username displayName');
  if (!series || series.isRemoved) throw ApiError.notFound('Series not found.');

  const [chapters, commentCount] = await Promise.all([
    Chapter.find({ series: series._id, isRemoved: false }).sort({ num: 1 }).select('-paragraphs -pages'),
    Comment.countDocuments({ series: series._id, isRemoved: false }),
  ]);

  res.json({ success: true, series, chapters, commentCount });
});

// POST /api/series — creator publishes a new series. Requires sign-in and
// an explicit rights attestation (they must own or have permission to
// publish this content) — this is the legal hook for the content policy.
const createValidators = [
  body('title').trim().notEmpty().withMessage('Title is required').isLength({ max: 150 }),
  body('type').isIn(['novel', 'comic']).withMessage('Type must be novel or comic'),
  body('author').trim().notEmpty().withMessage('Author is required').isLength({ max: 80 }),
  body('artist').optional({ nullable: true }).trim().isLength({ max: 80 }),
  body('genres').optional().isArray({ max: 6 }),
  body('tags').optional().isArray({ max: 12 }),
  body('status').optional().isIn(['Ongoing', 'Completed', 'Hiatus']),
  body('synopsis').trim().notEmpty().withMessage('Synopsis is required').isLength({ max: 2000 }),
  body('coverImage').optional({ nullable: true }).isString(),
  body('rightsAttested').custom((value) => value === true || value === 'true').withMessage(
    'You must confirm you own the rights to this work, or have permission to publish it, before it can go live.'
  ),
];

const create = [
  ...createValidators,
  asyncHandler(async (req, res) => {
    throwIfInvalid(req);
    const { title, type, author, artist, genres, tags, status, synopsis, coverImage } = req.body;

    const series = await Series.create({
      title,
      type,
      author,
      artist: artist || null,
      genres: genres || [],
      tags: tags || [],
      status: status || 'Ongoing',
      synopsis,
      coverImage: coverImage || null,
      owner: req.user.id,
      rightsAttestedAt: new Date(),
    });

    res.status(201).json({ success: true, series });
  }),
];

// PATCH /api/series/:id — owner (or admin) only. req.series set by requireSeriesOwner.
const updateValidators = [
  body('title').optional().trim().isLength({ min: 1, max: 150 }),
  body('author').optional().trim().isLength({ min: 1, max: 80 }),
  body('artist').optional({ nullable: true }).trim().isLength({ max: 80 }),
  body('genres').optional().isArray({ max: 6 }),
  body('tags').optional().isArray({ max: 12 }),
  body('status').optional().isIn(['Ongoing', 'Completed', 'Hiatus']),
  body('synopsis').optional().trim().isLength({ min: 1, max: 2000 }),
  body('coverImage').optional({ nullable: true }).isString(),
];

const update = [
  ...updateValidators,
  asyncHandler(async (req, res) => {
    throwIfInvalid(req);
    const fields = ['title', 'author', 'artist', 'genres', 'tags', 'status', 'synopsis', 'coverImage'];
    fields.forEach((f) => {
      if (req.body[f] !== undefined) req.series[f] = req.body[f];
    });
    await req.series.save();
    res.json({ success: true, series: req.series });
  }),
];

// DELETE /api/series/:id — owner (or admin) only. Soft delete: preserves
// the record for moderation/legal history rather than hard-deleting it.
const remove = asyncHandler(async (req, res) => {
  req.series.isRemoved = true;
  await req.series.save();
  res.json({ success: true, message: 'Series removed.' });
});

module.exports = { list, rankings, getOne, create, update, remove };
