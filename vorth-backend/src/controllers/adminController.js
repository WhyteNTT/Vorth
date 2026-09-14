const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const User = require('../models/User');
const Series = require('../models/Series');
const Comment = require('../models/Comment');

// GET /api/admin/users
const listUsers = asyncHandler(async (req, res) => {
  const users = await User.find().sort({ createdAt: -1 }).limit(200);
  res.json({ success: true, users });
});

// PATCH /api/admin/users/:id/ban
const banUser = asyncHandler(async (req, res) => {
  const user = await User.findById(req.params.id);
  if (!user) throw ApiError.notFound('User not found.');
  if (user.role === 'admin') throw ApiError.forbidden('Admins cannot be banned through this endpoint.');
  user.isBanned = true;
  user.banReason = req.body.reason || 'Violation of Vorth Terms of Service';
  await user.save();
  res.json({ success: true, message: `${user.username} has been suspended.` });
});

// PATCH /api/admin/users/:id/unban
const unbanUser = asyncHandler(async (req, res) => {
  const user = await User.findById(req.params.id);
  if (!user) throw ApiError.notFound('User not found.');
  user.isBanned = false;
  user.banReason = null;
  await user.save();
  res.json({ success: true, message: `${user.username} has been reinstated.` });
});

// DELETE /api/admin/series/:id — moderation removal outside the DMCA flow
// (e.g. ToS violations unrelated to copyright).
const removeSeries = asyncHandler(async (req, res) => {
  const series = await Series.findById(req.params.id);
  if (!series) throw ApiError.notFound('Series not found.');
  series.isRemoved = true;
  series.takedownReason = req.body.reason || 'Removed by moderator';
  await series.save();
  res.json({ success: true, message: 'Series removed.' });
});

// DELETE /api/admin/comments/:id
const removeComment = asyncHandler(async (req, res) => {
  const comment = await Comment.findById(req.params.id);
  if (!comment) throw ApiError.notFound('Comment not found.');
  comment.isRemoved = true;
  await comment.save();
  res.json({ success: true, message: 'Comment removed.' });
});

module.exports = { listUsers, banUser, unbanUser, removeSeries, removeComment };
