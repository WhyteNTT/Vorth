const mongoose = require('mongoose');

const commentSchema = new mongoose.Schema(
  {
    series: { type: mongoose.Schema.Types.ObjectId, ref: 'Series', required: true, index: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    rating: { type: Number, required: true, min: 1, max: 5 },
    text: { type: String, required: true, trim: true, maxlength: 1000 },
    // Threaded replies (e.g. a creator replying to a reader comment) reference a parent comment.
    parent: { type: mongoose.Schema.Types.ObjectId, ref: 'Comment', default: null },
    isRemoved: { type: Boolean, default: false },
  },
  { timestamps: true }
);

commentSchema.index({ series: 1, createdAt: -1 });

module.exports = mongoose.model('Comment', commentSchema);
