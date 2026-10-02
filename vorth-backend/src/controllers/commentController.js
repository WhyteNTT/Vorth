const { body } = require('express-validator');
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const throwIfInvalid = require('../utils/validate');
const Comment = require('../models/Comment');
const Series = require('../models/Series');
const Notification = require('../models/Notification');

/**
 * Recomputes a series' cached rating from its live comments in a single
 * statement, so the read and the write can never disagree.
 */
async function recomputeRating(seriesId) {
  const db = require('../config/db');
  await db.pool.query(
    `UPDATE "series" AS s
        SET "rating_avg"   = COALESCE(r.avg, 0),
            "rating_count" = COALESCE(r.count, 0),
            "updated_at"   = now()
       FROM (
         SELECT ROUND(AVG("rating")::numeric, 1)::float8 AS avg,
                COUNT(*)::int AS count
           FROM "comments"
          WHERE "series" = $1 AND "is_removed" = false
       ) AS r
      WHERE s."id" = $1`,
    [seriesId]
  );
}

// GET /api/series/:seriesId/comments
const list = asyncHandler(async (req, res) => {
  const series = await Series.findById(req.params.seriesId).select('isRemoved');
  if (!series || series.isRemoved) throw ApiError.notFound('Series not found.');

  // Filter on the route param rather than series._id: the projection above
  // only needs isRemoved, and relying on a populated id here is how this
  // endpoint silently returned an empty list before.
  const comments = await Comment.find({ series: req.params.seriesId, isRemoved: false })
    .sort({ createdAt: -1 })
    .populate('user', 'username displayName')
    .exec();
  res.json({ success: true, comments });
});

// POST /api/series/:seriesId/comments — auth required.
const createValidators = [
  body('rating').isInt({ min: 1, max: 5 }).withMessage('Rating must be 1-5'),
  body('text').trim().notEmpty().withMessage('Review text is required').isLength({ max: 1000 }),
  body('parent').optional({ nullable: true }).isUUID(),
];

const create = [
  ...createValidators,
  asyncHandler(async (req, res) => {
    throwIfInvalid(req);
    const series = await Series.findById(req.params.seriesId);
    if (!series || series.isRemoved) throw ApiError.notFound('Series not found.');

    const { rating, text, parent } = req.body;
    if (parent) {
      const parentComment = await Comment.findOne({
        id: parent,
        series: series._id,
        isRemoved: false,
      }).select('user').exec();
      if (!parentComment) throw ApiError.badRequest('The parent comment is not part of this series.');
    }

    const comment = await Comment.create({
      series: series._id,
      user: req.user.id,
      rating,
      text,
      parent: parent || null,
    });

    // Refresh the cached rating in the same transaction as nothing else
    // depends on it, but keep the comment visible even if this fails.
    try { await recomputeRating(series._id); } catch (err) {
      console.error('[comments] rating recompute failed:', err.message);
    }

    await comment.populate('user', 'username displayName');

    // Notify the series owner and, if this is a reply, the parent comment's author.
    const notifyTargets = new Set();
    if (String(series.owner) !== String(req.user.id)) notifyTargets.add(String(series.owner));
    if (parent) {
      const parentComment = await Comment.findById(parent).select('user').exec();
      if (parentComment && String(parentComment.user) !== String(req.user.id)) {
        notifyTargets.add(String(parentComment.user));
      }
    }
    if (notifyTargets.size) {
      await Notification.insertMany([...notifyTargets].map((userId) => ({
        user: userId,
        type: 'comment_reply',
        message: `${req.user.displayName} commented on ${series.title}.`,
        series: series._id,
      })));
    }

    res.status(201).json({ success: true, comment });
  }),
];

// DELETE /api/comments/:id — comment author or admin.
const remove = asyncHandler(async (req, res) => {
  const comment = await Comment.findById(req.params.id);
  if (!comment || comment.isRemoved) throw ApiError.notFound('Comment not found.');

  const isAuthor = String(comment.user) === String(req.user.id);
  const isAdmin = req.user.role === 'admin';
  if (!isAuthor && !isAdmin) throw ApiError.forbidden('You can only delete your own comments.');

  comment.isRemoved = true;
  await comment.save();
  try { await recomputeRating(comment.series); } catch (err) {
    console.error('[comments] rating recompute failed:', err.message);
  }

  res.json({ success: true, message: 'Comment removed.' });
});

module.exports = { list, create, remove };