// Host-permission checks, for Firefox.
//
// Chrome grants declared host permissions at install and keeps them until the
// extension is removed. Firefox lets the user revoke any of them at any time,
// from the extensions button, in one click. Nothing here is Firefox-gated: on
// Chrome permissions.contains() simply answers true for everything we declare,
// so every check below is a no-op there.
//
// Without this, a revocation is silent in the worst way — the content script
// never injects, executeScript fails, the Just Eat API fetches fail, and none of
// it is distinguishable from "this restaurant has no siblings nearby".

// The origins a comparison needs, taken from the manifest itself so this can
// never drift from what we actually declare.
function requiredOrigins(browser) {
  try {
    return browser.runtime.getManifest().host_permissions || [];
  } catch (_) {
    return [];
  }
}

/**
 * Which of the required origins are not currently granted.
 *
 * Checked one at a time, not as a single batch, because Firefox can revoke the
 * API origins independently of the site they serve — `uk.api.just-eat.io` going
 * away while `just-eat.co.uk` stays is a different failure with a different fix,
 * and the user needs to be told which.
 *
 * Never throws, and errs toward "granted": a fault in this check must not be
 * what stops a comparison. If we are wrong, the real request fails with its own
 * error, which is more informative than a permissions message we invented.
 */
async function missingOrigins(browser) {
  if (!browser || !browser.permissions || typeof browser.permissions.contains !== 'function') return [];
  const missing = [];
  for (const origin of requiredOrigins(browser)) {
    try {
      if (!(await browser.permissions.contains({ origins: [origin] }))) missing.push(origin);
    } catch (_) {
      // Treat an unanswerable check as granted — see above.
    }
  }
  return missing;
}

// '*://uk.api.just-eat.io/*' -> 'uk.api.just-eat.io'. Match patterns are not
// something to show a user. Anything that isn't a recognisable pattern (e.g.
// '<all_urls>') is passed through rather than mangled.
function originLabel(pattern) {
  const m = /^[a-z*]+:\/\/([^/]+)\/?/.exec(String(pattern));
  return m ? m[1] : String(pattern);
}

module.exports = { requiredOrigins, missingOrigins, originLabel };
