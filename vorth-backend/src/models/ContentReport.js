const Base = require('./_base');

/**
 * A Content Policy report: a house-rule violation, carrying a category
 * rather than statutory statements and a signature.
 */
class ContentReport extends Base {
  static table = 'content_reports';
}

module.exports = ContentReport;