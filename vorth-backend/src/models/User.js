const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const downloadSchema = new mongoose.Schema(
  {
    series: { type: mongoose.Schema.Types.ObjectId, ref: 'Series', required: true },
    chapter: { type: mongoose.Schema.Types.ObjectId, ref: 'Chapter', required: true },
    savedAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const userSchema = new mongoose.Schema(
  {
    displayName: { type: String, required: true, trim: true, maxlength: 60 },
    username: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true,
      minlength: 3,
      maxlength: 24,
      match: [/^[a-z0-9_]+$/, 'Username may only contain lowercase letters, numbers, and underscores'],
    },
    email: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true,
      match: [EMAIL_REGEX, 'Please provide a valid email address'],
    },
    password: { type: String, required: true, minlength: 8, select: false },
    role: { type: String, enum: ['user', 'admin'], default: 'user' },
    bio: { type: String, maxlength: 300, default: '' },

    library: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Series' }],
    downloads: [downloadSchema],

    // --- legal / compliance ---
    // Required at signup: platform Terms of Service and content/DMCA policy.
    agreedToTermsAt: { type: Date, required: true },
    ageConfirmed: {
      // User affirmatively confirmed they meet the minimum age requirement.
      // We deliberately do NOT store a raw birthdate — only the confirmation
      // flag and timestamp — to minimize retention of sensitive PII.
      type: Boolean,
      required: true,
      validate: {
        validator: (v) => v === true,
        message: 'You must confirm you meet the minimum age requirement to register.',
      },
    },

    isBanned: { type: Boolean, default: false },
    banReason: { type: String, default: null },

    lastLoginAt: { type: Date, default: null },
  },
  { timestamps: true }
);

userSchema.index({ createdAt: -1 });

userSchema.pre('save', async function hashPassword(next) {
  if (!this.isModified('password')) return next();
  const salt = await bcrypt.genSalt(12);
  this.password = await bcrypt.hash(this.password, salt);
  next();
});

userSchema.methods.comparePassword = function comparePassword(candidate) {
  return bcrypt.compare(candidate, this.password);
};

userSchema.methods.toSafeObject = function toSafeObject() {
  const obj = this.toObject();
  delete obj.password;
  delete obj.__v;
  return obj;
};

module.exports = mongoose.model('User', userSchema);
