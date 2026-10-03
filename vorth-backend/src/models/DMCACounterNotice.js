const Base = require('./_base');

/**
 * A DMCA counter-notice under 17 U.S.C. 512(g).
 *
 * Distinct from DMCAReport: that is the complainant's original notice, this is
 * the alleged infringer's reply. The two have opposite evidentiary weight and
 * different required statements, so they are separate tables rather than a
 * status on the original.
 */
class DMCACounterNotice extends Base {
  static table = 'dmca_counter_notices';
}

module.exports = DMCACounterNotice;