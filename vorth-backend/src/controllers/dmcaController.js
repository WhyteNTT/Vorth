const { body } = require('express-validator');
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const throwIfInvalid = require('../utils/validate');
const { withTransaction } = require('../config/db');
const DMCAReport = require('../models/DMCAReport');
const Series = require('../models/Series');
const Chapter = require('../models/Chapter');

// POST /api/dmca — public endpoint, no auth required (a rights holder may
// not have a Vorth account). Captures the statutory elements of a notice.
// IMPORTANT: this is intake plumbing, not legal advice. Have counsel
// review your actual DMCA process, designated-agent registration, and
// the language shown to reporters before relying on this in production.
const submitValidators = [
  body('reporterName').trim().notEmpty().withMessage('Your name is required').isLength({ max: 120 }),
  body('reporterEmail').trim().isEmail().withMessage('A valid email is required').normalizeEmail(),
  body('reporterOrganization').optional({ nullable: true }).trim().isLength({ max: 120 }),
  body('reporterAddress').optional({ nullable: true }).trim().isLength({ max: 300 }),
  body('copyrightedWorkDescription')
    .trim().notEmpty().withMessage('Please describe the copyrighted work').isLength({ max: 2000 }),
  body('originalWorkUrl').optional({ nullable: true, checkFalsy: true }).trim()
    .isURL({ protocols: ['http', 'https'], require_protocol: true }).isLength({ max: 500 }),
  body('infringingSeries').optional({ nullable: true }).isUUID(),
  body('infringingChapter').optional({ nullable: true }).isUUID(),
  body('infringingUrlDescription').optional({ nullable: true }).trim().isLength({ max: 500 }),
  body('goodFaithStatement').custom((value) => value === true || value === 'true')
    .withMessage('The good-faith statement must be affirmed'),
  body('accuracyStatement').custom((value) => value === true || value === 'true')
    .withMessage('The accuracy/perjury statement must be affirmed'),
  body('signature').trim().notEmpty().withMessage('A typed signature is required').isLength({ max: 120 }),
];

const submit = [
  ...submitValidators,
  asyncHandler(async (req, res) => {
    throwIfInvalid(req);
    if (req.body.infringingChapter) {
      const chapter = await Chapter.findById(req.body.infringingChapter).select('series isRemoved').exec();
      if (!chapter || chapter.isRemoved) throw ApiError.notFound('Infringing chapter not found.');
      if (req.body.infringingSeries && String(chapter.series) !== req.body.infringingSeries) {
        throw ApiError.badRequest('The infringing chapter does not belong to the selected series.');
      }
    }
    if (req.body.infringingSeries) {
      const series = await Series.findById(req.body.infringingSeries).select('isRemoved').exec();
      if (!series || series.isRemoved) throw ApiError.notFound('Infringing series not found.');
    }

    // Whitelist the columns explicitly. Passing req.body straight through
    // would let a client supply fields the schema does not expect, which
    // surfaces as a 500 rather than a clean validation error.
    const {
      reporterName, reporterEmail, reporterOrganization, reporterAddress,
      copyrightedWorkDescription, originalWorkUrl,
      infringingSeries, infringingChapter, infringingUrlDescription,
      signature,
    } = req.body;

    const report = await DMCAReport.create({
      reporterName, reporterEmail,
      reporterOrganization: reporterOrganization ?? null,
      reporterAddress: reporterAddress ?? null,
      copyrightedWorkDescription, originalWorkUrl: originalWorkUrl ?? null,
      infringingSeries: infringingSeries ?? null,
      infringingChapter: infringingChapter ?? null,
      infringingUrlDescription: infringingUrlDescription ?? null,
      // The two statutory statements are validated as required above, so the
      // stored value is always the affirmation itself.
      goodFaithStatement: true,
      accuracyStatement: true,
      signature,
    });

    res.status(201).json({
      success: true,
      message: 'Your takedown notice has been received and will be reviewed.',
      reportId: report._id,
    });
  }),
];

// GET /api/dmca — admin only, list reports (optionally filtered by status).
const list = asyncHandler(async (req, res) => {
  const filter = {};
  if (req.query.status) filter.status = req.query.status;
  const reports = await DMCAReport.find(filter).sort({ createdAt: -1 });
  res.json({ success: true, reports });
});

// GET /api/dmca/:id — admin only.
const getOne = asyncHandler(async (req, res) => {
  const report = await DMCAReport.findById(req.params.id)
    .populate('infringingSeries', 'title owner')
    .populate('infringingChapter', 'title series');
  if (!report) throw ApiError.notFound('Report not found.');
  res.json({ success: true, report });
});

// PATCH /api/dmca/:id — admin only. Resolving as "accepted" soft-removes
// the targeted series/chapter, mirroring a real takedown action.
const resolveValidators = [
  body('status').isIn(['under_review', 'accepted', 'rejected']).withMessage('Invalid status'),
  body('adminNotes').optional({ nullable: true }).trim().isLength({ max: 1000 }),
];

const resolve = [
  ...resolveValidators,
  asyncHandler(async (req, res) => {
    throwIfInvalid(req);
    const report = await DMCAReport.findById(req.params.id);
    if (!report) throw ApiError.notFound('Report not found.');

    const { status, adminNotes } = req.body;

    // Takedown, report state and resolution metadata must all land or none
    // of them: a series removed against a report that still says "pending"
    // would be invisible to an auditor.
    const updated = await withTransaction(async (client) => {
      report.status = status;
      if (adminNotes !== undefined) report.adminNotes = adminNotes;
      if (status === 'accepted' || status === 'rejected') {
        report.resolvedAt = new Date();
        report.resolvedBy = req.user.id;
      }
      await report.save({ client });

      if (status === 'accepted') {
        if (report.infringingChapter) {
          await Chapter.findByIdAndUpdate(report.infringingChapter, { isRemoved: true }, { client });
        }
        if (report.infringingSeries) {
          await Series.findByIdAndUpdate(report.infringingSeries, {
            isRemoved: true,
            takedownReason: `DMCA takedown accepted (report ${report._id})`,
          }, { client });
        }
      }
      return report;
    });

    res.json({ success: true, report: updated });
  }),
];

module.exports = { submit, list, getOne, resolve };
