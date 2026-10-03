const { body, param } = require('express-validator');
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const throwIfInvalid = require('../utils/validate');
const { withTransaction } = require('../config/db');
const env = require('../config/env');
const mailer = require('../services/mailer');
const { counterNoticeDeadline } = require('../services/businessDays');
const DMCAReport = require('../models/DMCAReport');
const DMCACounterNotice = require('../models/DMCACounterNotice');
const Series = require('../models/Series');
const Chapter = require('../models/Chapter');

// A DMCA counter-notice under 17 U.S.C. 512(g): the alleged infringer's reply
// to an accepted takedown.
//
// IMPORTANT: this is process plumbing, not legal advice. The deadlines, the
// statements and the forwarding obligation are implemented because the statute
// is explicit about them, but a deployment still needs counsel to review its
// actual process, and needs a registered DMCA designated agent. Do not rely on
// this in production without doing both.

/**
 * Affirmation check.
 *
 * These are statements made under penalty of perjury, so accepting anything
 * other than an explicit yes would undermine them. The value is normalised to
 * `true` on write, so a stored record always means the affirmation was made.
 */
function mustAffirm(label) {
  return body(label)
    .custom((value) => value === true || value === 'true')
    .withMessage(`The ${label} must be affirmed`);
}

// POST /api/dmca/:id/counter-notice — public, no auth. The subscriber may have
// no Vorth account, exactly like the complainant filing the original notice.
const submitValidators = [
  param('id').isUUID().withMessage('Invalid report id'),
  body('subscriberName').trim().notEmpty().withMessage('Your name is required').isLength({ max: 120 }),
  body('subscriberEmail').trim().isEmail().withMessage('A valid email is required').normalizeEmail(),
  // 512(g)(3)(D) makes acceptance of process a condition of the notice, so the
  // jurisdiction statement is required, not optional.
  body('subscriberAddress').trim().notEmpty()
    .withMessage('Your address is required so we can serve you with process')
    .isLength({ max: 300 }),
  // 512(g)(3)(B): what was removed, and where it used to be.
  body('identifiedMaterial').trim().notEmpty()
    .withMessage('Describe the material that was removed').isLength({ max: 2000 }),
  body('materialLocation').trim().notEmpty()
    .withMessage('Tell us where the material was previously available').isLength({ max: 1000 }),
  mustAffirm('goodFaithStatement'),
  mustAffirm('perjuryStatement'),
  mustAffirm('jurisdictionStatement'),
  body('signature').trim().notEmpty().withMessage('A typed signature is required').isLength({ max: 120 }),
];

/** PostgreSQL unique-violation, so a second filing is a 409 and not a 500. */
function isUniqueViolation(err) {
  return err && (err.code === '23505' || /duplicate key/i.test(err.message || ''));
}

/**
 * The text forwarded to the complainant.
 *
 * 512(g)(2)(A) requires the counter-notice itself to be provided, so this
 * carries the subscriber's statements verbatim rather than a summary of them.
 */
function forwardBody(report, notice) {
  return [
    `A DMCA counter-notice has been filed in response to your takedown notice ${report._id}.`,
    '',
    `Material you complained of: ${report.copyrightedWorkDescription}`,
    '',
    'The subscriber making this counter-notice states, under penalty of perjury:',
    '',
    `1. Name:    ${notice.subscriberName}`,
    `   Email:   ${notice.subscriberEmail}`,
    `   Address: ${notice.subscriberAddress}`,
    '',
    `2. Material removed and disabled: ${notice.identifiedMaterial}`,
    `   Where it appeared:             ${notice.materialLocation}`,
    '',
    '3. The subscriber has a good faith belief that the material was removed or',
    '   disabled as a result of mistake or misidentification.',
    '',
    '4. The subscriber consents to the jurisdiction of the Federal District Court',
    '   for the judicial district in which the subscriber resides, or in which',
    '   the alleged infringing activity was located, and will accept service of',
    '   process from you.',
    '',
    `   Signature: ${notice.signature}`,
    '',
    'IF YOU HAVE FILED A COURT ACTION seeking to restrain the activity, you must',
    'notify us by the date below. If you do not, the material may be restored.',
    '',
    `Response deadline: ${notice.responseDeadline}`,
    '',
    // Quoted rather than the counter-notice id: the forward is sent before the
    // record is inserted, so there is no id to quote yet.
    `Please quote your original notice ${report._id} in any reply.`,
    env.publicUrl ? `Our DMCA policy: ${env.publicUrl}/dmca-policy` : '',
  ].join('\n');
}

/**
 * Files the counter-notice and forwards it to the complainant.
 *
 * Order matters. The forward happens first and the record is written second,
 * because 512(g)(2)(A) requires the complainant to actually receive the
 * counter-notice and runs their clock from that day. Computing the deadline
 * before the send is therefore correct - it is measured from the moment we
 * dispatch, which is the earliest the clock could possibly start.
 *
 * A failed send persists nothing, so the subscriber gets a clean retry rather
 * than a half-filed record with no deadline. If the send succeeds but the insert
 * then fails, the duplicate that a retry creates is harmless: the complainant
 * has been told, and their window is running from the earlier date.
 *
 * @returns {Promise<object>} the persisted counter-notice
 */
async function fileAndForward(report, data) {
  const forwardedAt = new Date();
  const deadline = counterNoticeDeadline(forwardedAt, {
    businessDays: env.dmcaCounterNoticeDays,
    holidays: env.dmcaCounterNoticeHolidays,
  });

  const body = forwardBody(report, Object.assign({}, data, {
    responseDeadline: deadline.toISOString(),
  }));

  await mailer.send({
    to: report.reporterEmail,
    subject: `DMCA counter-notice received for your notice ${report._id}`,
    text: body,
  });

  try {
    return await DMCACounterNotice.create(Object.assign({
      dmcaReport: report._id,
      forwardedAt,
      responseDeadline: deadline,
      forwardedNote: `Forwarded to ${report.reporterEmail} on ${forwardedAt.toISOString()}`,
    }, data));
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw ApiError.conflict(
        'A counter-notice has already been filed for this takedown. '
        + 'If you need to correct it, contact us.'
      );
    }
    throw err;
  }
}

const submitCounterNotice = [
  ...submitValidators,
  asyncHandler(async (req, res) => {
    throwIfInvalid(req);

    const report = await DMCAReport.findById(req.params.id);
    if (!report) throw ApiError.notFound('Takedown notice not found.');

    // Only an accepted takedown can be counter-noticed. A pending or rejected
    // notice removed nothing, so there is nothing to contest.
    if (report.status !== 'accepted') {
      throw ApiError.badRequest(
        'This takedown notice has not resulted in a removal, so there is nothing to counter-notice.'
      );
    }
    // A takedown is only contestable if it actually removed something.
    if (!report.removalAt || (!report.removalSeries && !report.removalChapter)) {
      throw ApiError.badRequest(
        'This takedown did not record a removal, so there is nothing to counter-notice.'
      );
    }

    // Whitelist explicitly: passing req.body through would let a client set
    // status, forwardedAt or responseDeadline and forge an expired window.
    const {
      subscriberName, subscriberEmail, subscriberAddress,
      identifiedMaterial, materialLocation, signature,
    } = req.body;

    const notice = await fileAndForward(report, {
      subscriberName,
      subscriberEmail,
      subscriberAddress,
      identifiedMaterial,
      materialLocation,
      signature,
      goodFaithStatement: true,
      perjuryStatement: true,
      jurisdictionStatement: true,
    });

    res.status(201).json({
      success: true,
      message:
        'Your counter-notice has been received and forwarded to the copyright holder. '
        + 'If they do not notify us that they have filed a court action by the date '
        + 'below, the material may be restored.',
      counterNoticeId: notice._id,
      responseDeadline: notice.responseDeadline,
    });
  }),
];

/**
 * Whether a series is still down *because of this report*.
 *
 * The takedown reason carries the report id, which is what distinguishes
 * "removed by the takedown being contested" from "removed by something else
 * since". Without this a successful counter-notice would un-hide a series an
 * admin had taken down for a different reason, or one a court order covers.
 */
function ownedByThisReport(series, reason) {
  return Boolean(series && series.isRemoved && series.takedownReason === reason);
}

/**
 * Puts back what a specific takedown removed.
 *
 * Reports content it declined to restore rather than silently leaving it down,
 * so an operator can tell "nothing to do" from "refused on purpose".
 */
async function restoreRemovedContent(report, client) {
  const restored = [];
  const keptDown = [];
  const reason = `DMCA takedown accepted (report ${report._id})`;

  if (report.removalChapter) {
    const chapter = await Chapter.findById(report.removalChapter)
      .select('isRemoved takedownReason series')
      .exec(client);
    if (ownedByThisReport(chapter, reason)) {
      await Chapter.findByIdAndUpdate(report.removalChapter, {
        isRemoved: false,
        takedownReason: null,
      }, { client });
      restored.push({ type: 'chapter', id: report.removalChapter });
    } else {
      keptDown.push({
        type: 'chapter',
        id: report.removalChapter,
        reason: chapter && chapter.isRemoved
          ? 'removed for another reason, not this report'
          : 'no longer removed',
      });
    }
  }

  if (report.removalSeries) {
    const series = await Series.findById(report.removalSeries)
      .select('isRemoved takedownReason')
      .exec(client);

    if (!ownedByThisReport(series, reason)) {
      keptDown.push({
        type: 'series',
        id: report.removalSeries,
        reason: series && series.isRemoved
          ? 'removed for another reason, not this report'
          : 'no longer removed',
      });
    } else {
      // A visible series with a removed chapter inside it leaks that chapter, so
      // the series stays down until its own chapter is back.
      const stillHidden = await Chapter.find({ series: report.removalSeries, isRemoved: true })
        .select('id')
        .limit(1)
        .exec(client);
      if (stillHidden.length) {
        keptDown.push({
          type: 'series',
          id: report.removalSeries,
          reason: 'a chapter is still removed',
        });
      } else {
        await Series.findByIdAndUpdate(report.removalSeries, {
          isRemoved: false,
          takedownReason: null,
        }, { client });
        restored.push({ type: 'series', id: report.removalSeries });
      }
    }
  }

  return { restored, keptDown, reason };
}

// PATCH /api/dmca/counter-notices/:id — admin only.
const resolveValidators = [
  param('id').isUUID().withMessage('Invalid counter-notice id'),
  body('outcome').isIn(['court_action', 'restore', 'withdrawn'])
    .withMessage('Outcome must be court_action, restore, or withdrawn'),
  body('adminNotes').optional({ nullable: true }).trim().isLength({ max: 1000 }),
];

const resolveCounterNotice = [
  ...resolveValidators,
  asyncHandler(async (req, res) => {
    throwIfInvalid(req);
    const notice = await DMCACounterNotice.findById(req.params.id);
    if (!notice) throw ApiError.notFound('Counter-notice not found.');
    if (notice.status !== 'pending') {
      throw ApiError.conflict(
        `This counter-notice has already been ${notice.status}.`
      );
    }
    if (!notice.forwardedAt) {
      throw ApiError.conflict(
        'This counter-notice has not been forwarded to the copyright holder yet, '
        + 'so no response window has started.'
      );
    }

    const { outcome, adminNotes } = req.body;
    const report = await DMCAReport.findById(notice.dmcaReport);

    const result = await withTransaction(async (client) => {
      const restored = outcome === 'restore' && report
        ? await restoreRemovedContent(report, client)
        : { restored: [], keptDown: [] };
      notice.status = outcome === 'court_action' ? 'contested'
        : outcome === 'restore' ? 'restored'
          : 'withdrawn';
      notice.resolvedAt = new Date();
      notice.resolvedBy = req.user.id;
      if (adminNotes !== undefined) notice.adminNotes = adminNotes;
      await notice.save({ client });
      return restored;
    });

    // Both halves: what went back, and what was deliberately left down. A caller
    // that only sees `restored: []` cannot tell a no-op from a refusal.
    res.json({
      success: true,
      counterNotice: notice,
      restored: result.restored,
      keptDown: result.keptDown,
    });
  }),
];

// GET /api/dmca/counter-notices — admin only.
const listCounterNotices = asyncHandler(async (req, res) => {
  const filter = {};
  if (req.query.status) filter.status = req.query.status;
  const notices = await DMCACounterNotice.find(filter).sort({ createdAt: -1 });
  res.json({ success: true, counterNotices: notices });
});

// GET /api/dmca/counter-notices/:id — admin only.
const getCounterNotice = asyncHandler(async (req, res) => {
  const notice = await DMCACounterNotice.findById(req.params.id);
  if (!notice) throw ApiError.notFound('Counter-notice not found.');
  const report = await DMCAReport.findById(notice.dmcaReport)
    .select('reporterEmail reporterName status removalSeries removalChapter removalAt')
    .exec();
  res.json({ success: true, counterNotice: notice, report });
});

/**
 * Restores counter-notices whose response window has lapsed.
 *
 * 512(g)(2)(C) makes restoration permissive ("may"), so this is something an
 * operator runs rather than something that happens by itself: a missed job
 * should not silently un-hide content that a court order might be keeping down.
 * `npm run dmca:sweep-lapsed -- --dry-run` is the safe first step.
 *
 * @param {object}  [options]
 * @param {Date}    [options.now]       injected clock, so the sweep is testable
 * @param {boolean} [options.dryRun]    report what would happen, change nothing
 * @param {string}  [options.dmcaReport] limit to one takedown, for re-running a
 *                                       single case after a partial failure
 */
async function restoreLapsed(options = {}) {
  const now = options.now || new Date();
  const filter = {
    status: 'pending',
    responseDeadline: { $lte: now, $ne: null },
  };
  if (options.dmcaReport) filter.dmcaReport = options.dmcaReport;

  const due = await DMCACounterNotice.find(filter);

  const outcomes = [];
  for (const notice of due) {
    const report = await DMCAReport.findById(notice.dmcaReport);
    if (!report) {
      outcomes.push({ id: notice._id, action: 'skipped', reason: 'report no longer exists' });
      continue;
    }
    if (options.dryRun) {
      outcomes.push({ id: notice._id, action: 'would-restore', report: report._id });
      continue;
    }
    // Sequential on purpose. Each restoration is its own transaction, and
    // running them concurrently on a shared pool would interleave the reads that
    // decide whether content is still owned by this report.
    const outcome = await withTransaction(async (client) => {
      const result = await restoreRemovedContent(report, client);
      notice.status = 'restored';
      notice.resolvedAt = new Date();
      notice.adminNotes = 'Response window lapsed with no court action; '
        + 'restored under 17 U.S.C. 512(g)(2)(C) by the scheduled sweep. '
        + (result.keptDown.length
          ? `Left down: ${result.keptDown.map((k) => `${k.type} (${k.reason})`).join('; ')}`
          : '');
      await notice.save({ client });
      return result;
    });
    outcomes.push({
      id: notice._id,
      action: 'restored',
      restored: outcome.restored,
      // Reported so a sweep that restored nothing is distinguishable from one
      // that had nothing to restore. Silently doing nothing reads as success.
      keptDown: outcome.keptDown,
    });
  }

  return { checked: due.length, outcomes };
}

// GET /api/dmca/mine — the takedowns against the caller's own content.
//
// This is what makes a counter-notice reachable. The endpoint is keyed on the
// takedown id, and nothing else in the product shows a publisher that id, so
// without this the whole flow exists but cannot be used.
//
// Only accepted takedowns appear. A claim still under review is not actionable
// and telling the publisher about it would disclose an unreviewed accusation
// against them, so the conservative reading wins.
//
// The complainant's identity is deliberately absent. §512(g)(3)(B) needs the
// subscriber to be able to identify the material they are contesting, so the
// work description is included; names, email addresses and postal addresses are
// not, because they are the complainant's personal data and the subscriber has
// no need for them.
const listMyTakedowns = asyncHandler(async (req, res) => {
  const mySeries = await Series.find({ owner: req.user.id }).select('id').exec();
  const seriesIds = mySeries.map((s) => s._id);

  const myChapters = seriesIds.length
    ? await Chapter.find({ series: { $in: seriesIds } })
      .select('id')
      .exec()
    : [];
  const chapterIds = myChapters.map((c) => c._id);

  const or = [];
  if (seriesIds.length) or.push({ removalSeries: { $in: seriesIds } });
  if (chapterIds.length) or.push({ removalChapter: { $in: chapterIds } });

  const reports = or.length
    ? await DMCAReport.find({ status: 'accepted', $or: or }).sort({ removalAt: -1 })
    : [];

  const reportIds = reports.map((r) => r._id);
  const notices = reportIds.length
    ? await DMCACounterNotice.find({ dmcaReport: { $in: reportIds } })
    : [];
  const byReport = new Map(notices.map((n) => [String(n.dmcaReport), n]));

  res.json({
    success: true,
    takedowns: reports.map((r) => {
      const notice = byReport.get(String(r._id));
      return {
        id: r._id,
        // What was claimed, so the subscriber can satisfy 512(g)(3)(B).
        copyrightedWorkDescription: r.copyrightedWorkDescription,
        originalWorkUrl: r.originalWorkUrl ?? null,
        infringingUrlDescription: r.infringingUrlDescription ?? null,
        removedSeries: r.removalSeries ?? null,
        removedChapter: r.removalChapter ?? null,
        removedAt: r.removalAt ?? null,
        canCounterNotice: !notice,
        counterNotice: notice
          ? {
            id: notice._id,
            status: notice.status,
            // Shown to the subscriber because it is their deadline: they should
            // know how long the material may stay down.
            responseDeadline: notice.responseDeadline ?? null,
          }
          : null,
      };
    }),
  });
});

module.exports = {
  submitCounterNotice,
  resolveCounterNotice,
  listCounterNotices,
  getCounterNotice,
  listMyTakedowns,
  restoreLapsed,
  // exported for tests
  _forwardBody: forwardBody,
  _restoreRemovedContent: restoreRemovedContent,
  _ownedByThisReport: ownedByThisReport,
};