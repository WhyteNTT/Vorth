const mongoose = require('mongoose');

const chapterSchema = new mongoose.Schema(
  {
    series: { type: mongoose.Schema.Types.ObjectId, ref: 'Series', required: true, index: true },
    num: { type: Number, required: true, min: 1 },
    title: { type: String, required: true, trim: true, maxlength: 150 },

    // Novel chapters: array of paragraph strings.
    paragraphs: {
      type: [String],
      default: undefined,
      validate: (v) => !v || v.length <= 500,
    },
    // Comic chapters: array of page image paths (set via the upload endpoint).
    pages: {
      type: [String],
      default: undefined,
      validate: (v) => !v || v.length <= 80,
    },

    views: { type: Number, default: 0 },
    isRemoved: { type: Boolean, default: false }, // soft delete for takedowns
  },
  { timestamps: true }
);

chapterSchema.index({ series: 1, num: 1 }, { unique: true });

module.exports = mongoose.model('Chapter', chapterSchema);
