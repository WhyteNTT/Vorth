const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const Notification = require('../models/Notification');

// GET /api/notifications
const list = asyncHandler(async (req, res) => {
  const notifications = await Notification.find({ user: req.user.id })
    .sort({ createdAt: -1 })
    .limit(50)
    .populate('series', 'title slug');
  const unreadCount = await Notification.countDocuments({ user: req.user.id, isRead: false });
  res.json({ success: true, notifications, unreadCount });
});

// PATCH /api/notifications/:id/read
const markRead = asyncHandler(async (req, res) => {
  const notification = await Notification.findOne({ _id: req.params.id, user: req.user.id });
  if (!notification) throw ApiError.notFound('Notification not found.');
  notification.isRead = true;
  await notification.save();
  res.json({ success: true, notification });
});

// PATCH /api/notifications/read-all
const markAllRead = asyncHandler(async (req, res) => {
  await Notification.updateMany({ user: req.user.id, isRead: false }, { $set: { isRead: true } });
  res.json({ success: true, message: 'All notifications marked as read.' });
});

module.exports = { list, markRead, markAllRead };
