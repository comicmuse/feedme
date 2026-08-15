// Host access, checked rather than assumed.
//
// Chrome grants host_permissions at install and keeps them until uninstall.
// Firefox MV3 treats every one of them as revocable at any time, from the
// extensions button, in one click (#77). Mozilla's guidance is to check before
// relying on them.
//
// Nothing here is a security boundary — the browser already enforces that. This
// exists so a revocation reads as "you revoked access to X" instead of the
// silence it produces today, where every injection is a swallowed .catch() and
// nothing distinguishes it from a restaurant with no siblings nearby.
const { PLATFORM, browser } = require('./constants');

// Which origins each platform's comparison actually needs. Together these are
// exactly manifest.base.json's host_permissions, partitioned by who needs them —
// tests/manifest.test.js asserts they stay that way, so an origin added to the
// manifest cannot quietly go unchecked here.
const PLATFORM_ORIGINS = {
  [PLATFORM.UBER_EATS]: ['*://www.ubereats.com/*'],
  [PLATFORM.DELIVEROO]: [
    '*://www.deliveroo.co.uk/*',
    '*://deliveroo.co.uk/*',
    // Search enumeration replays Deliveroo's own text_search GraphQL from the
    // content script; the API host is a separate, separately-revocable origin
    // (as with Just Eat below).
    '*://api.uk.deliveroo.com/*',
  ],
  // The two API hosts are separate origins from the site and are revocable on
  // their own, so Just Eat can be half-granted: the menu page loads and the
  // fee/offer fetches in just-eat-scraper.js fail.
  [PLATFORM.JUST_EAT]: [
    '*://www.just-eat.co.uk/*',
    '*://uk.api.just-eat.io/*',
    '*://menu-globalmenucdn.je-apis.com/*',
  ],
};

/**
 * The origins a platform's comparison needs. Unknown platforms need nothing.
 * @param {string} platform
 * @returns {string[]}
 */
function originsFor(platform) {
  return PLATFORM_ORIGINS[platform] ?? [];
}

/**
 * Which of a platform's origins are NOT currently granted.
 *
 * Fails open in every uncertain case — no API, or a call that throws — because
 * a false "access revoked" over a working extension is a worse failure than the
 * one this replaces. Only a definite `false` from the browser counts.
 *
 * @param {string} platform
 * @param {?{contains: Function}} [api] permissions API; defaults to the real one
 * @returns {Promise<string[]>} missing origins, in declaration order
 */
async function missingOrigins(platform, api = browser && browser.permissions) {
  if (!api || typeof api.contains !== 'function') return [];
  // One origin per call. contains() answers with a single boolean for the whole
  // set, so a batched call could only report THAT something is missing, never
  // which — and naming the origin is the entire point, given the Just Eat API
  // hosts can be revoked independently of the site.
  const results = await Promise.all(originsFor(platform).map(async (origin) => {
    try {
      return (await api.contains({ origins: [origin] })) ? null : origin;
    } catch (_) {
      return null;
    }
  }));
  return results.filter(Boolean);
}

/**
 * The host inside a match pattern, for showing to a user. "*://uk.api.just-eat.io/*"
 * is precise and unreadable; the user's own browser calls it "uk.api.just-eat.io"
 * in the very UI they have to go and click, so match that wording.
 * @param {string} origin
 * @returns {string}
 */
function originLabel(origin) {
  return String(origin).replace(/^\*:\/\//, '').replace(/^[a-z]+:\/\//i, '').replace(/\/\*?$/, '');
}

module.exports = { PLATFORM_ORIGINS, originsFor, missingOrigins, originLabel };
