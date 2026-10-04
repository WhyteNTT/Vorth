const { body } = require('express-validator');
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const throwIfInvalid = require('../utils/validate');
const { withTransaction } = require('../config/db');
const ContentReport = require('../models/ContentReport');
const Series = require('../models/Series');
const Chapter = require('../models/Chapter');
const Comment = require('../models/Comment');
const { pageSize } = require('../utils/pagination');

/**
 * POST /api/reports — public, no auth required.
 *
 * The documented route for the Content Policy. Deliberately lighter than the
 * DMCA intake: no sworn statements and no signature, because those are
 * statutory formalities for a copyright notice and asking for them here would
 * discourage exactly the reports the policy exists to receive.
 *
 * The category is a closed list rather than free text so it can be counted and
 * triaged. It mirrors the headings in legal/CONTENT_POLICY.md; adding one there
 * means adding one here.
 */
const CATEGORIES = [
  'sexual_minors',
  'child_safety',
  'non_consensual_intimate',
  'violent_extremism',
  'hate_harassment',
  'malware_phishing',
  'copyright_or_trademark',
  'other',
];

const submitValidators = [
  body('category').trim().notEmpty().isIn(CATEGORIES)
    .withMessage(`Category must be one of: ${CATEGORIES.join(', ')}`),
  body('description').trim().notEmpty()
    .withMessage('Please describe the problem').isLength({ max: 200 }),
  body('details').optional({ nullable: true }).trim().isLength({ max: 4000 }),
  // At least one thing must be identified, or the report is unactionable.
  body().custom((value) => {
    const v = value || {};
    if (v.reportedSeries || v.reportedChapter || v.reportedComment) return true;
    throw new Error('Identify the series, chapter or comment you are reporting');
  }),
  body('reportedSeries').optional({ nullable: true }).isUUID(),
  body('reportedChapter').optional({ nullable: true }).isUUID(),
  body('reportedComment').optional({ nullable: true }).isUUID(),
  // Optional: an anonymous report is still read, but a signed-in reporter gets
  // told the outcome.
  body('reporterEmail').optional({ nullable: true, checkFalsy: true }).trim()
    .isEmail().withMessage('A valid email is required if you supply one').normalizeEmail(),
];

const submit = [
  ...submitValidators,
  asyncHandler(async (req, res) => {
    throwIfInvalid(req);

    // Confirm the target exists, and that a chapter really belongs to the
    // series it was reported under. Otherwise a report can name a series that
    // has nothing to do with the chapter, and moderation acts on the wrong row.
    if (req.body.reportedChapter) {
      const chapter = await Chapter.findById(req.body.reportedChapter)
        .select('series isRemoved').exec();
      if (!chapter || chapter.isRemoved) throw ApiError.notFound('Reported chapter not found.');
      if (req.body.reportedSeries && String(chapter.series) !== req.body.reportedSeries) {
        throw ApiError.badRequest('The reported chapter does not belong to the reported series.');
      }
    }
    if (req.body.reportedSeries) {
      const series = await Series.findById(req.body.reportedSeries).select('isRemoved').exec();
      if (!series || series.isRemoved) throw ApiError.notFound('Reported series not found.');
    }
    if (req.body.reportedComment) {
      const comment = await Comment.findById(req.body.reportedComment)
        .select('series isRemoved').exec();
      if (!comment || comment.isRemoved) throw ApiError.notFound('Reported comment not found.');
    }

    // Whitelist the columns. Passing req.body through would let a client supply
    // status, resolved_by or anything else the schema does not expect.
    const { category, description, details, reportedSeries, reportedChapter, reportedComment, reporterEmail } = req.body;

    const report = await ContentReport.create({
      category,
      description,
      details: details ?? null,
      reportedSeries: reportedSeries ?? null,
      reportedChapter: reportedChapter ?? null,
      reportedComment: reportedComment ?? null,
      reporterEmail: reporterEmail ?? null,
      // A signed-in reporter is recorded for correlation. An anonymous report
      // is still accepted and still read.
      reporterAccount: req.user ? req.user.id : null,
    });

    res.status(201).json({
      success: true,
      message: 'Thank you. Your report has been received and will be reviewed.',
      reportId: report._id,
    });
  }),
];

// GET /api/reports — admin only.
const list = asyncHandler(async (req, res) => {
  const filter = {};
  if (req.query.status) filter.status = req.query.status;
  if (req.query.category) filter.category = req.query.category;
  // Bounded for the same reason as the DMCA queue: it only grows.
    const reports = await ContentReport.find(filter)
      .sort({ createdAt: -1 })
      .limit(pageSize(req)).exec();
  res.json({ success: true, reports });
});

// GET /api/reports/:id — admin only.
const getOne = asyncHandler(async (req, res) => {
  const report = await ContentReport.findById(req.params.id)
    .populate('reportedSeries', 'title owner')
    .populate('reportedChapter', 'title series')
    .populate('reportedComment', 'series user');
  if (!report) throw ApiError.notFound('Report not found.');
  res.json({ success: true, report });
});

const resolveValidators = [
  body('status').isIn(['under_review', 'actioned', 'dismissed'])
    .withMessage('Invalid status'),
  body('adminNotes').optional({ nullable: true }).trim().isLength({ max: 1000 }),
  // Which of the reported things to act on. Defaults to everything reported.
  body('target').optional({ nullable: true })
    .isIn(['chapter', 'series', 'comment', 'none'])
    .withMessage('target must be chapter, series, comment or none'),
];

// PATCH /api/reports/:id — admin only.
const resolve = [
  ...resolveValidators,
  asyncHandler(async (req, res) => {
    throwIfInvalid(req);
    const report = await ContentReport.findById(req.params.id);
    if (!report) throw ApiError.notFound('Report not found.');

    const { status, adminNotes, target } = req.body;
    const actsOn = target || 'all';

    // Moderation outcome and the report state must land together: content
    // removed against a report that still reads "pending" is invisible to an
    // auditor.
    const updated = await withTransaction(async (client) => {
      report.status = status;
      if (adminNotes !== undefined) report.adminNotes = adminNotes;
      if (status === 'actioned' || status === 'dismissed') {
        report.resolvedAt = new Date();
        report.resolvedBy = req.user.id;
      }
      await report.save({ client });

      if (status === 'actioned') {
        if (actsOn !== 'none' && actsOn !== 'series' && report.reportedChapter) {
          await Chapter.findByIdAndUpdate(report.reportedChapter, {
            isRemoved: true,
            // A reason, so a DMCA counter-notice restoring a *different*
            // removal cannot un-hide a Content Policy removal by accident.
            takedownReason: `Content Policy report upheld (report ${report._id})`,
          }, { client });
        }
        if (actsOn !== 'none' && actsOn !== 'chapter' && report.reportedSeries) {
          await Series.findByIdAndUpdate(report.reportedSeries, {
            isRemoved: true,
            takedownReason: `Content Policy report upheld (report ${report._id})`,
          }, { client });
        }
        if (actsOn === 'comment' && report.reportedComment) {
          await Comment.findByIdAndUpdate(report.reportedComment, { isRemoved: true }, { client });
        }
      }
      return report;
    });

    res.json({ success: true, report: updated });
  }),
];

module.exports = { submit, list, getOne, resolve, CATEGORIES };