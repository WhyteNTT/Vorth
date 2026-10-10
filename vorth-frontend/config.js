/*
 * Deployment configuration for the frontend, loaded before script.js.
 *
 * WHY THIS FILE EXISTS
 *
 * The app was built for one origin: Express serves these files and answers /api
 * itself, so script.js defaults to same-origin and nothing has to be configured.
 *
 * Serving the frontend from Vercel while the API runs on Render breaks that
 * assumption. The page would then look for https://<vercel-host>/api, where
 * nothing is listening, and every request would fail - which is exactly what the
 * current vorth.vercel.app deployment does. `apiBase` below is the one value that
 * fixes it.
 *
 * WHY IT IS NOT IN SCRIPT.JS
 *
 * script.js is shared by three deployments that need three different answers:
 * local development, Render serving both halves, and Vercel serving only the
 * frontend. Putting the backend URL in the source would mean editing source
 * between environments, and the wrong value would be a silent failure in
 * whichever environment it was wrong for. A separate file is one value to set,
 * and it is set by whoever deploys rather than by whoever writes code.
 *
 * WHAT IT WILL NOT DO
 *
 * It deliberately stays inert in the two cases where same-origin is correct:
 *
 *   - Local development (localhost / 127.0.0.1). Left to itself here it would
 *     send the developer's own testing to production, which is the opposite of
 *     what anyone wants.
 *   - When the page is being served BY the backend already, i.e. the Render
 *     deployment that serves both halves. Pointing the page at an absolute URL
 *     there would be harmless but pointless, and would turn same-origin requests
 *     into cross-origin ones that need CORS and a cross-site cookie for no gain.
 *
 * That restraint is the point. If apiBase is wrong for the environment it
 * somehow reaches, this file does nothing rather than sending traffic somewhere
 * unexpected.
 */
(function () {
  /*
   * The API base URL, including the trailing /api.
   *
   * Leave the placeholder below unchanged until the Render service exists -
   * this file does nothing while it is set. Replace it with the real URL, e.g.
   *   https://vorth-api.onrender.com/api
   */
  var apiBase = 'https://REPLACE-WITH-YOUR-API-HOST/api';

  // Not configured yet. Stay on same-origin, which is the historical behaviour.
  if (!apiBase || apiBase.indexOf('REPLACE-WITH-YOUR-API-HOST') !== -1) return;

  // Trailing slashes removed here rather than left to each consumer. script.js
  // strips one for its own use, but this value is also read directly to build
  // media URLs, and a doubled slash would reach the network as //api.
  apiBase = apiBase.replace(/\/+$/, '');

  // Read defensively: this file runs before anything else, so a throw here is a
  // blank page with no error message to go on. Anything unexpected means "do not
  // redirect", which leaves the page same-origin.
  var loc = window.location;
  var host = loc && loc.hostname;

  // Local development keeps talking to the local backend. The suffix check is
  // there because *.localhost resolves to the loopback interface by
  // specification - a developer using app.localhost must not be redirected to
  // the deployed backend by missing an exact-match list.
  var isLocal = !host || host === 'localhost' || host === '127.0.0.1' || host === '::1'
    || host.endsWith('.localhost') || host.startsWith('127.');

  // Local development keeps talking to the local backend, and so does anything
  // whose location we could not read.
  if (isLocal) return;

  // Already being served by the backend. Same-origin is correct and needs nothing.
  var backendOrigin = apiBase.replace(/\/api\/?$/, '');
  if (loc.origin === backendOrigin) return;

  window.VORTH_API_BASE = apiBase;
})();