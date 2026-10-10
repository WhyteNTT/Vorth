/**
 * Whether the refresh cookie has to be SameSite=None, and whether that decision
 * can be trusted.
 *
 * The refresh token lives in an httpOnly cookie. For years this app was served by
 * Express from the same origin as the API, so `SameSite=Lax` was both sufficient
 * and the safer choice: a cross-site subrequest could not ride on the cookie, so
 * CSRF could not borrow a session.
 *
 * Serving the frontend from Vercel and the API from Render makes those two origins
 * *different sites*. `SameSite=Lax` cookies are not attached to cross-site
 * subrequests at all - fetch and XHR included - so refresh silently stops working.
 * The failure is late and quiet: signup, login, browsing, commenting and reading all
 * succeed, because those use the in-memory access token. Only when that token
 * expires does the app appear to log the reader out for no reason. `SameSite=None`
 * is the fix, and it is what this module decides.
 *
 * The cost is real and stated here rather than glossed: `None` re-admits the cookie
 * to cross-site requests, which is the CSRF surface `Lax` was holding shut. What
 * still holds the line is that every state-changing auth endpoint takes a JSON body,
 * and a cross-site request cannot send `application/json` without a CORS preflight
 * that the server refuses. `Lax` remains the default for every same-origin
 * deployment, including local development, so this weakening applies only to a
 * deployment that has explicitly configured a foreign frontend origin.
 */

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/**
 * The host of an origin or URL, lowercased, or null if it cannot be read.
 *
 * Null rather than a throw: these values come from the environment, and a malformed
 * entry should degrade to "cannot tell" rather than take the process down at import.
 */
function hostOf(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    return new URL(value.trim()).hostname.toLowerCase();
  } catch (_) {
    return null;
  }
}

function isLoopback(host) {
  return LOOPBACK_HOSTS.has(host) || host.endsWith('.localhost');
}

/**
 * True when a configured client origin is a genuinely foreign site.
 *
 * Two deliberate restraints, both about not weakening security on a guess:
 *
 *   - Without PUBLIC_URL there is no way to know which origins are foreign, so this
 *     returns false and the cookie stays Lax. An unconfigured PUBLIC_URL therefore
 *     produces the old, stricter behaviour instead of an insecure one.
 *   - If either side is a loopback host this returns false. Local development with
 *     `?api=http://localhost:5000` is not cross-site in the sense that matters, and
 *     SameSite=None is rejected outright by browsers over plain http, so enabling it
 *     there would break development rather than protect anyone.
 *
 * Hosts are compared exactly rather than by registrable domain. Doing this properly
 * needs the public suffix list, which is a dependency, and the exact comparison only
 * over-triggers in one direction: it treats `example.com` and `www.example.com` as
 * foreign when a browser would not. `www.` is stripped from our own host to avoid the
 * commonest version of that. The cost of over-triggering is a slightly weaker cookie
 * on a same-site deployment; the cost of a suffix-list bug is a broken session, which
 * is worse and much harder to diagnose.
 */
function needsCrossSiteCookie(clientOrigins, publicUrl) {
  const own = hostOf(publicUrl);
  if (!own) return false;
  const ownHost = own.replace(/^www\./, '');
  if (isLoopback(ownHost)) return false;

  return (Array.isArray(clientOrigins) ? clientOrigins : []).some((origin) => {
    const host = hostOf(origin);
    if (!host || isLoopback(host)) return false;
    // Stripped on both sides: a browser does not treat example.com and
    // www.example.com as different sites, so neither should we.
    return host.replace(/^www\./, '') !== ownHost;
  });
}

/**
 * The sameSite value for the refresh cookie, given the environment.
 */
function refreshSameSite(env) {
  return needsCrossSiteCookie(env.clientOrigins, env.publicUrl) ? 'none' : 'lax';
}

/**
 * Whether the refresh cookie must carry the Secure attribute.
 *
 * Forced on whenever SameSite=None. A browser rejects a SameSite=None cookie that is
 * not Secure, so honouring `SECURE_COOKIES=false` here would not loosen anything - it
 * would silently stop refresh working on exactly the deployments that need it.
 */
function refreshSecure(env) {
  return refreshSameSite(env) === 'none' ? true : env.secureCookies;
}

module.exports = {
  needsCrossSiteCookie,
  refreshSameSite,
  refreshSecure,
  hostOf,
  isLoopback,
};