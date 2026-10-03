const Base = require('./_base');

/**
 * A Content Policy report. Distinct from DMCAReport: this is a house-rule
 * report, not a copyright claim, so it carries a category rather than the
 * statutory statements and a signature.
 */
class ContentReport extends Base {
  static table = 'content_reports';
}

module.exports = ContentReport;