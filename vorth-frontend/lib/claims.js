/* =========================================================
   VORTH copyright-claim rendering

   Loaded in the browser via <script> and in Node via require() so the
   markup can be tested against a real HTML parser
   (test/browser/xss.dom.test.js).

   Why this is a separate file and not a template string inside script.js:

   the text rendered here was typed by an anonymous complainant and is shown
   to a *different* user - the publisher whose content was removed. It is
   third-party text on a signed-in page, which is the worst place for a stored
   XSS to land and the easiest place for one to be missed, because every other
   escaped string on the page came from the person looking at it.

   Factoring it out means the browser test exercises the code that actually
   ships, rather than a copy of it kept in step by hand.

   Rules enforced here:
   - every interpolated value goes through VorthSafe.escapeHtml();
   - nothing user-supplied is interpolated into an attribute unescaped;
   - no inline event handlers, so there is no handler for a payload to supply.
   ========================================================= */
(function (root, factory) {
  const escapeHtml = (typeof module === 'object' && module.exports)
    ? require('./safe.js').escapeHtml
    : root.VorthSafe.escapeHtml;
  const api = factory(escapeHtml);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.VorthClaims = api;
}(typeof self !== 'undefined' ? self : this, function (escapeHtml) {
  'use strict';

  /** A date, or an em dash when there is none. Unparseable input is not a crash. */
  function claimDate(value) {
    if (!value) return '—';
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString();
  }

  /**
   * One claim, as a list item.
   *
   * `canCounterNotice` false means a counter-notice already exists, so the
   * button is replaced by the status and the deadline. The deadline is the
   * subscriber's own: it is how long their material may stay down, so hiding it
   * would leave them guessing.
   */
  function claimItem(row) {
    const r = row || {};
    const notice = r.counterNotice || null;

    const status = notice
      ? '<span class="claim-status">Counter-notice sent</span>'
      : '';
    const deadline = notice && notice.responseDeadline
      ? '<span class="claim-meta">The copyright holder has until '
        + escapeHtml(claimDate(notice.responseDeadline))
        + ' to say they have filed a court action.</span>'
      : '';
    const action = notice
      ? ''
      : '<button type="button" class="btn btn-ghost sm" data-counter-notice="'
        + escapeHtml(String(r.id || '')) + '">File a counter-notice</button>';

    return '<div class="claim-item">'
      + '<div class="claim-head">'
      + '<span class="claim-when">Removed ' + escapeHtml(claimDate(r.removedAt)) + '</span>'
      + status
      + '</div>'
      + '<p class="claim-work">' + escapeHtml(String(r.copyrightedWorkDescription || '')) + '</p>'
      + '<p class="claim-meta">Reference ' + escapeHtml(String(r.id || '')) + '</p>'
      + deadline
      + action
      + '</div>';
  }

  /** The whole list, or the empty state. */
  function claimList(rows) {
    const list = Array.isArray(rows) ? rows : [];
    if (!list.length) {
      return '<p class="empty-hint">No copyright claims against your content.</p>';
    }
    return list.map(claimItem).join('');
  }

  return { claimItem, claimList, claimDate };
}));
