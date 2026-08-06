const mongoose = require('mongoose');

const progressSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    series: { type: mongoose.Schema.Types.ObjectId, ref: 'Series', required: true },
    chapter: { type: mongoose.Schema.Types.ObjectId, ref: 'Chapter', required: true },
    type: { type: String, enum: ['novel', 'comic'], required: true },

    scrollPct: { type: Number, min: 0, max: 1, default: 0 }, // novel resume position
    page: { type: Number, min: 0, default: 0 }, // comic resume position

    bookmarked: { type: Boolean, default: false },
  },
  { timestamps: true }
);

progressSchema.index({ user: 1, series: 1 }, { unique: true });

module.exports = mongoose.model('ReadingProgress', progressSchema);
