const { body } = require('express-validator');
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const throwIfInvalid = require('../utils/validate');
const Comment = require('../models/Comment');
const Series = require('../models/Series');
const Notification = require('../models/Notification');

async function recomputeRating(seriesId) {
  const stats = await Comment.aggregate([
    { $match: { series: seriesId, isRemoved: false } },
    { $group: { _id: '$series', avg: { $avg: '$rating' }, count: { $sum: 1 } } },
  ]);
  const { avg = 0, count = 0 } = stats[0] || {};
  await Series.findByIdAndUpdate(seriesId, {
    ratingAvg: Math.round(avg * 10) / 10,
    ratingCount: count,
  });
}

// GET /api/series/:seriesId/comments
const list = asyncHandler(async (req, res) => {
  const series = await Series.findById(req.params.seriesId).select('isRemoved');
  if (!series || series.isRemoved) throw ApiError.notFound('Series not found.');
  const comments = await Comment.find({ series: req.params.seriesId, isRemoved: false })
    .sort({ createdAt: -1 })
    .populate('user', 'username displayName');
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
        _id: parent,
        series: series._id,
        isRemoved: false,
      }).select('user');
      if (!parentComment) throw ApiError.badRequest('The parent comment is not part of this series.');
    }
    const comment = await Comment.create({
      series: series._id,
      user: req.user.id,
      rating,
      text,
      parent: parent || null,
    });
    await comment.populate('user', 'username displayName');
    await recomputeRating(series._id);

    // Notify the series owner and, if this is a reply, the parent comment's author.
    const notifyTargets = new Set();
    if (series.owner.toString() !== req.user.id) notifyTargets.add(series.owner.toString());
    if (parent) {
      const parentComment = await Comment.findById(parent).select('user');
      if (parentComment && parentComment.user.toString() !== req.user.id) {
        notifyTargets.add(parentComment.user.toString());
      }
    }
    if (notifyTargets.size) {
      await Notification.insertMany(
        [...notifyTargets].map((userId) => ({
          user: userId,
          type: 'comment_reply',
          message: `${req.user.displayName} commented on ${series.title}.`,
          series: series._id,
        }))
      );
    }

    res.status(201).json({ success: true, comment });
  }),
];

// DELETE /api/comments/:id — comment author or admin.
const remove = asyncHandler(async (req, res) => {
  const comment = await Comment.findById(req.params.id);
  if (!comment || comment.isRemoved) throw ApiError.notFound('Comment not found.');

  const isAuthor = comment.user.toString() === req.user.id;
  const isAdmin = req.user.role === 'admin';
  if (!isAuthor && !isAdmin) throw ApiError.forbidden('You can only delete your own comments.');

  comment.isRemoved = true;
  await comment.save();
  await recomputeRating(comment.series);

  res.json({ success: true, message: 'Comment removed.' });
});

module.exports = { list, create, remove };
