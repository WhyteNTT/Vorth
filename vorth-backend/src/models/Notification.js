const mongoose = require('mongoose');

const notificationSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    type: { type: String, enum: ['new_chapter', 'comment_reply', 'system'], required: true },
    message: { type: String, required: true, maxlength: 300 },
    series: { type: mongoose.Schema.Types.ObjectId, ref: 'Series', default: null },
    isRead: { type: Boolean, default: false },
  },
  { timestamps: true }
);

notificationSchema.index({ user: 1, createdAt: -1 });

module.exports = mongoose.model('Notification', notificationSchema);
