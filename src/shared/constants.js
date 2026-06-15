let browser;
try {
  browser = require('webextension-polyfill');
} catch (_) {
  // webextension-polyfill only available in browser context
  browser = null;
}

const PLATFORM = {
  UBER_EATS: 'uber-eats',
  DELIVEROO: 'deliveroo',
  JUST_EAT: 'just-eat',
};

const CHECKOUT_PATTERNS = {
  [PLATFORM.UBER_EATS]: /ubereats\.com\/gb\/checkout/,
  [PLATFORM.DELIVEROO]: /deliveroo\.co\.uk\/[^/]+\/checkout/,
  [PLATFORM.JUST_EAT]: /just-eat\.co\.uk\/[^/]+\/order/,
};

// {name} and {postcode} are replaced at runtime.
// Deliveroo has no postcode/name-addressable search URL — its listings are
// geohash-based behind a Google Places lookup — so the entry point is the
// homepage; deliveroo-scraper drives the postcode → listing → menu flow from there.
const SEARCH_URL_TEMPLATES = {
  [PLATFORM.DELIVEROO]: 'https://deliveroo.co.uk/',
  // The /area/{postcode} listing works directly (no geocode step); just-eat-scraper
  // matches the restaurant there and opens its menu.
  [PLATFORM.JUST_EAT]: 'https://www.just-eat.co.uk/area/{postcode}/restaurants',
  [PLATFORM.UBER_EATS]: 'https://www.ubereats.com/gb/feed?q={name}&pl={postcode}',
};

const MSG = {
  ORDER_DETECTED: 'ORDER_DETECTED',       // checkout-reader -> service-worker
  START_COMPARISON: 'START_COMPARISON',   // popup -> service-worker
  PLATFORM_DATA: 'PLATFORM_DATA',         // platform-scraper -> service-worker
  COMPARISON_RESULT: 'COMPARISON_RESULT', // service-worker -> sidebar
};

const SCRAPER_TIMEOUT_MS = 15000;
const FUSE_THRESHOLD = 0.4;

// Deliveroo's service fee is a basket-dependent percentage we can't read from the
// menu page, so we estimate it: a share of the matched subtotal, capped. The rate
// approximates Deliveroo UK's published fee; totals using it are labelled "est.".
const DELIVEROO_SERVICE_FEE_PCT = 0.11;
const DELIVEROO_SERVICE_FEE_CAP = 3.49;

function platformFromUrl(url) {
  try {
    const hostname = new URL(url).hostname;
    if (hostname === 'www.ubereats.com' || hostname.endsWith('.ubereats.com')) return PLATFORM.UBER_EATS;
    if (hostname === 'www.deliveroo.co.uk' || hostname.endsWith('.deliveroo.co.uk')) return PLATFORM.DELIVEROO;
    if (hostname === 'www.just-eat.co.uk' || hostname.endsWith('.just-eat.co.uk')) return PLATFORM.JUST_EAT;
  } catch (_) {}
  return null;
}

function buildSearchUrl(platform, restaurantName, postcode) {
  const template = SEARCH_URL_TEMPLATES[platform];
  if (!template) return null;
  return template
    .replace('{name}', encodeURIComponent(restaurantName))
    // Postcodes are case-insensitive in these URLs; lowercase matches the form the
    // sites use in their own paths (e.g. /area/sw1e5je).
    .replace('{postcode}', encodeURIComponent(postcode.replace(/\s+/g, '').toLowerCase()));
}

module.exports = {
  PLATFORM,
  CHECKOUT_PATTERNS,
  MSG,
  SCRAPER_TIMEOUT_MS,
  FUSE_THRESHOLD,
  DELIVEROO_SERVICE_FEE_PCT,
  DELIVEROO_SERVICE_FEE_CAP,
  platformFromUrl,
  buildSearchUrl,
  browser,
};
