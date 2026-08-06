const mongoose = require('mongoose');
const slugify = require('slugify');

const viewCounterSchema = new mongoose.Schema(
  {
    daily: { type: Number, default: 0 },
    weekly: { type: Number, default: 0 },
    alltime: { type: Number, default: 0 },
  },
  { _id: false }
);

const seriesSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true, maxlength: 150 },
    slug: { type: String, required: true, unique: true, index: true },
    type: { type: String, enum: ['novel', 'comic'], required: true },

    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    author: { type: String, required: true, trim: true, maxlength: 80 },
    artist: { type: String, trim: true, maxlength: 80, default: null },

    genres: { type: [String], default: [], validate: (v) => v.length <= 6 },
    tags: { type: [String], default: [], validate: (v) => v.length <= 12 },
    status: { type: String, enum: ['Ongoing', 'Completed', 'Hiatus'], default: 'Ongoing' },

    synopsis: { type: String, required: true, maxlength: 2000 },
    coverImage: { type: String, default: null }, // path under /uploads, set via the upload endpoint

    views: { type: viewCounterSchema, default: () => ({}) },
    lastDailyReset: { type: Date, default: Date.now },
    lastWeeklyReset: { type: Date, default: Date.now },

    ratingAvg: { type: Number, default: 0, min: 0, max: 5 },
    ratingCount: { type: Number, default: 0 },
    chapterCount: { type: Number, default: 0 },

    // --- content moderation / legal ---
    // A creator must attest they own the rights (or have permission to
    // publish) the work at creation time — see seriesController.create.
    rightsAttestedAt: { type: Date, required: true },
    isRemoved: { type: Boolean, default: false }, // soft delete for DMCA takedowns
    takedownReason: { type: String, default: null },
  },
  { timestamps: true }
);

seriesSchema.index({ title: 'text', author: 'text', artist: 'text', tags: 'text', synopsis: 'text' });
seriesSchema.index({ genres: 1 });
seriesSchema.index({ 'views.daily': -1 });
seriesSchema.index({ 'views.weekly': -1 });
seriesSchema.index({ 'views.alltime': -1 });

seriesSchema.pre('validate', async function generateSlug(next) {
  if (!this.isModified('title') && this.slug) return next();
  const base = slugify(this.title, { lower: true, strict: true });
  let candidate = base;
  let suffix = 1;
  const SeriesModel = this.constructor;
  // Ensure uniqueness without relying on a race-prone "check then save".
  while (await SeriesModel.exists({ slug: candidate, _id: { $ne: this._id } })) {
    suffix += 1;
    candidate = `${base}-${suffix}`;
  }
  this.slug = candidate;
  next();
});

module.exports = mongoose.model('Series', seriesSchema);
