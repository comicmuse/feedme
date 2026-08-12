const { PLATFORM, CHECKOUT_PATTERNS, platformFromUrl } = require('./shared/constants');

// Maps the active tab's URL to the idle-popup help state. Pure and deterministic:
// exact host + checkout-pattern matching, no heuristics. A falsy or unrecognised
// URL yields 'elsewhere' (full "start on Uber Eats" instructions), which is the
// safe default — never a blank popup.
function idleStateFor(url) {
  const platform = url ? platformFromUrl(url) : null;
  if (!platform) return { key: 'elsewhere', platform: null };
  if (platform === PLATFORM.UBER_EATS) {
    const key = CHECKOUT_PATTERNS[PLATFORM.UBER_EATS].test(url) ? 'uber-checkout' : 'uber-other';
    return { key, platform };
  }
  // Deliveroo / Just Eat: valid comparison destinations, never v1 sources.
  return { key: 'destination', platform };
}

module.exports = { idleStateFor };
