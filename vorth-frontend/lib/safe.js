/* =========================================================
   VORTH — safe rendering helpers

   Loaded in the browser via <script> and in Node via require()
   so the escaping rules can be unit tested (test/xss.test.js).

   Rules enforced here:
   - Text interpolated into innerHTML must go through escapeHtml().
   - User-supplied image references are validated against an allowlist
     and are NEVER interpolated into an HTML attribute. They are applied
     through the CSSOM (element.style.backgroundImage) instead, so there
     is no HTML parser involved and no way to break out of an attribute.
   ========================================================= */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.VorthSafe = api;
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

  /** Escapes text for interpolation into HTML content or a quoted attribute. */
  function escapeHtml(value) {
    if (value === null || value === undefined) return '';
    return String(value).replace(/[&<>"']/g, (c) => ESCAPES[c]);
  }

  /** Escapes a value for use inside a CSS url("...") token. */
  function escapeCssUrl(value) {
    return String(value).replace(/["'\\()\s]/g, '');
  }

  const UPLOAD_PATH = /^\/uploads\/[A-Za-z0-9._-]{1,120}$/;
  const HTTPS_URL = /^https:\/\/[A-Za-z0-9.-]+(?::\d+)?(?:\/[A-Za-z0-9._~%-]*)*$/;

  /**
   * Validates an image reference coming from user content.
   * Returns the value unchanged, or null if it is not something we are
   * willing to load. Anything with a quote, a space, a backslash or a
   * non-https scheme is rejected outright.
   */
  function safeImageUrl(value, origin) {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (UPLOAD_PATH.test(trimmed)) return trimmed;
    if (HTTPS_URL.test(trimmed)) return trimmed;
    return null;
  }

  /** Resolves a stored image reference to an absolute URL, or ''. */
  function resolveMediaUrl(value, origin) {
    const safe = safeImageUrl(value, origin);
    if (!safe) return '';
    if (safe.startsWith('/')) return `${origin || ''}${safe}`;
    return safe;
  }

  /**
   * Applies a background image to an element through the CSSOM.
   * This is the only supported way to render user-supplied artwork: the
   * browser never re-parses the value as HTML or as an attribute boundary.
   */
  function applyBackgroundImage(element, value, origin) {
    if (!element) return false;
    const url = resolveMediaUrl(value, origin);
    if (!url) {
      element.removeAttribute('data-cover');
      return false;
    }
    element.style.backgroundImage = `linear-gradient(180deg, rgba(7,3,18,.18), rgba(7,3,18,.52)), url("${escapeCssUrl(url)}")`;
    element.style.backgroundSize = 'cover';
    element.style.backgroundPosition = 'center';
    return true;
  }

  /**
   * Re-derives artwork for every [data-cover] element inside root.
   * Elements whose reference is not allowlisted keep their gradient.
   */
  function applyCovers(root, origin) {
    const scope = root || document;
    const nodes = scope.querySelectorAll('[data-cover]');
    nodes.forEach((el) => applyBackgroundImage(el, el.getAttribute('data-cover'), origin));
    return nodes.length;
  }

  /** Renders a list of chips, escaping each label. */
  function chipList(items, { prefix = '', className = 'chip' } = {}) {
    return (Array.isArray(items) ? items : [])
      .filter((t) => typeof t === 'string' && t.length)
      .map((t) => `<span class="${escapeHtml(className)}">${escapeHtml(prefix)}${escapeHtml(t)}</span>`)
      .join('');
  }

  return {
    escapeHtml,
    escapeCssUrl,
    safeImageUrl,
    resolveMediaUrl,
    applyBackgroundImage,
    applyCovers,
    chipList,
  };
}));