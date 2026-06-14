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

// {name} and {postcode} are replaced at runtime
const SEARCH_URL_TEMPLATES = {
  [PLATFORM.DELIVEROO]: 'https://www.deliveroo.co.uk/restaurants/{postcode}?searchTerm={name}',
  [PLATFORM.JUST_EAT]: 'https://www.just-eat.co.uk/area/{postcode}/restaurants?q={name}',
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
    .replace('{postcode}', encodeURIComponent(postcode.replace(/\s+/g, '')));
}

module.exports = {
  PLATFORM,
  CHECKOUT_PATTERNS,
  MSG,
  SCRAPER_TIMEOUT_MS,
  FUSE_THRESHOLD,
  platformFromUrl,
  buildSearchUrl,
  browser,
};
