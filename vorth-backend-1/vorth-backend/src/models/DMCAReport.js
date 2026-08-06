const mongoose = require('mongoose');

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Captures the elements a DMCA takedown notice needs to be actionable:
// identification of the copyrighted work, identification of the
// infringing material, contact info, and the two required statements
// (good-faith belief + accuracy/perjury, "under penalty of perjury").
// This is a general-purpose intake model, not a substitute for legal
// review of your actual takedown process — see legal/DMCA_POLICY.md.
const dmcaReportSchema = new mongoose.Schema(
  {
    reporterName: { type: String, required: true, trim: true, maxlength: 120 },
    reporterEmail: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      match: [EMAIL_REGEX, 'Please provide a valid email address'],
    },
    reporterOrganization: { type: String, trim: true, maxlength: 120, default: null },
    reporterAddress: { type: String, trim: true, maxlength: 300, default: null },

    copyrightedWorkDescription: { type: String, required: true, maxlength: 2000 },
    originalWorkUrl: { type: String, trim: true, maxlength: 500, default: null },

    infringingSeries: { type: mongoose.Schema.Types.ObjectId, ref: 'Series', default: null },
    infringingChapter: { type: mongoose.Schema.Types.ObjectId, ref: 'Chapter', default: null },
    infringingUrlDescription: { type: String, maxlength: 500, default: null },

    // Required statutory statements — both must be explicitly affirmed true.
    goodFaithStatement: {
      type: Boolean,
      required: true,
      validate: { validator: (v) => v === true, message: 'Good faith statement must be affirmed.' },
    },
    accuracyStatement: {
      type: Boolean,
      required: true,
      validate: { validator: (v) => v === true, message: 'Accuracy/perjury statement must be affirmed.' },
    },
    signature: { type: String, required: true, trim: true, maxlength: 120 }, // typed full legal name

    status: {
      type: String,
      enum: ['pending', 'under_review', 'accepted', 'rejected'],
      default: 'pending',
    },
    adminNotes: { type: String, maxlength: 1000, default: null },
    resolvedAt: { type: Date, default: null },
    resolvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

dmcaReportSchema.index({ status: 1, createdAt: -1 });

module.exports = mongoose.model('DMCAReport', dmcaReportSchema);
