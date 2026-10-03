/* =========================================================
     VORTH — API error messages

     Loaded in the browser via <script> and in Node via require() so the
     wording a reader sees can be unit tested (test/frontendErrors.test.js).

     Why this exists: a failed request used to throw whatever the server
     happened to put in the body. With no API reachable at all, the page
     served by the front-end host answered for /api, and visitors were shown

       "The page could not be found NOT_FOUND cpt1:-lk52k-1791014199690-..."

     That is a hosting provider's error text with an internal request id,
     displayed to a reader. It explains nothing and leaks the deployment's
     internals.

     Two failures are distinguished:

       - the API is not there at all. One sentence, shown once, saying so.
       - the API answered and rejected the request. Its wording was written
         for this interface, so it is passed through unchanged.

     The tell is the response shape. This API always speaks JSON, so a 404
     carrying a hosting provider's marker, or a body that is not JSON at all,
     means nobody is serving the API here.
     ========================================================= */
  (function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.VorthApiError = factory();
  }(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    /** Markers that identify a hosting provider answering in the API's place. */
    const PROVIDER_MARKERS = /NOT_FOUND|DEPLOYMENT_NOT_FOUND|The page could not be found/i;

    /**
     * True when a response came from something that is not this API: a static
     * host, a CDN, or a proxy error page.
     */
    function looksLikeMissingApi(payload) {
      if (typeof payload === 'string') {
        const trimmed = payload.trim();
        if (trimmed && !trimmed.startsWith('{') && !trimmed.startsWith('[')) return true;
      }
      if (payload && typeof payload === 'object') {
        return PROVIDER_MARKERS.test(String(payload.message || payload.error || ''));
      }
      return false;
    }

    /**
     * Explains a failed request in terms the reader can act on.
     *
     * @param {number} status  HTTP status
     * @param {*} payload      the parsed body, or the raw text
     * @returns {string}
     */
    function apiErrorMessage(status, payload) {
      // The API's own 404s are JSON with a message written for this interface.
      if (looksLikeMissingApi(payload) && (status === 404 || status >= 500)) {
        return 'The Vorth server is not responding. Please try again shortly.';
      }

      /*
       * A 5xx is a fault on this side of the wire. Whatever the body carries may
       * be a raw driver error - a missing relation, a duplicate key constraint,
       * a host and port - and none of that belongs in front of a reader. Reader
       * facing wording is a 4xx concern; anything at 5xx gets one generic line.
       * Returning the body here is how `relation "series" does not exist`
       * reaches the page.
       */
      if (status >= 500) {
        return 'The Vorth server had a problem. Please try again shortly.';
      }

      if (typeof payload === 'string' && payload.trim()) return payload;
      const body = payload && (payload.message || payload.error);
      if (typeof body === 'string' && body.trim() && !looksLikeMissingApi({ message: body })) {
        return body;
      }
      return 'Request failed (' + status + ')';
    }

    return { looksLikeMissingApi, apiErrorMessage, PROVIDER_MARKERS };
  }));