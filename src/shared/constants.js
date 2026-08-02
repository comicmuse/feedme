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
  // Brand search: /gb/search with searchType=GLOBAL_SEARCH USED to return the
  // focused "N locations" view listing every nearby branch of the chain. Live
  // 2026-07-12 (#38) it returns a generic feed with a SINGLE brand store (the
  // nearest) — confirmed for KFC/McDonald's/Subway, in the getSearchFeedV1 API
  // payload as well as the DOM — so Uber sibling enumeration currently yields at
  // most one branch. No pl=: a shorthand postcode is rejected and Uber resolves the session
  // location via a 307 redirect, so we let the logged-in session supply it.
  [PLATFORM.UBER_EATS]: 'https://www.ubereats.com/gb/search?q={name}&vertical=ALL&searchType=GLOBAL_SEARCH&sc=SEARCH_BAR',
};

const MSG = {
  ORDER_DETECTED: 'ORDER_DETECTED',       // checkout-reader -> service-worker
  START_COMPARISON: 'START_COMPARISON',   // popup -> service-worker
  PLATFORM_DATA: 'PLATFORM_DATA',         // platform-scraper -> service-worker
  COMPARISON_RESULT: 'COMPARISON_RESULT', // service-worker -> sidebar
  BRANCHES_FOUND: 'BRANCHES_FOUND',       // enumerator -> service-worker
  COMPARISON_UPDATE: 'COMPARISON_UPDATE', // service-worker -> sidebar (progressive)
  SWITCH_TO_BRANCH: 'SWITCH_TO_BRANCH',   // sidebar -> service-worker (open + build basket)
  RETRY_BRANCH: 'RETRY_BRANCH',           // sidebar -> service-worker (retry a failed branch)
  RETRY_PLATFORM: 'RETRY_PLATFORM',       // sidebar -> service-worker (retry a timed-out enumeration)
};

const SCRAPER_TIMEOUT_MS = 15000;
const FUSE_THRESHOLD = 0.4;

const DEFAULT_BRANCH_COUNT = 3;
const DEFAULT_MAX_CONCURRENT = 4;

// Read tunables from storage.local, falling back to defaults outside the browser
// or when unset. Never throws.
async function getConfig() {
  try {
    const stored = await browser.storage.local.get(['branchCount', 'maxConcurrent']);
    return {
      branchCount: Number.isInteger(stored.branchCount) ? stored.branchCount : DEFAULT_BRANCH_COUNT,
      maxConcurrent: Number.isInteger(stored.maxConcurrent) ? stored.maxConcurrent : DEFAULT_MAX_CONCURRENT,
    };
  } catch (_) {
    return { branchCount: DEFAULT_BRANCH_COUNT, maxConcurrent: DEFAULT_MAX_CONCURRENT };
  }
}

// Deliveroo's service fee is a basket-dependent percentage we can't read from the
// menu page, so we estimate it: a share of the matched subtotal, capped. The rate
// approximates Deliveroo UK's published fee; totals using it are labelled "est.".
const DELIVEROO_SERVICE_FEE_PCT = 0.11;
const DELIVEROO_SERVICE_FEE_CAP = 3.49;

// Just Eat charges its small-order fee (SmallOrderFee.MaxAmount, flat) when the
// basket subtotal is at or below a threshold the platform never publishes — it
// only exists server-side, in basket responses. Live captures (2026-07-11) put it
// at £10.00 inclusive for JET-delivered branches and £7.00 for a marketplace
// branch; we model the common £10 and label the row approximate in the sidebar.
const JUST_EAT_SMALL_ORDER_THRESHOLD = 10;

// Just Eat's StampCard scheme: each order at a participating branch accrues this
// share of its value, and the 5th order releases the accrued total as a voucher
// (3 months, that branch only). The authenticated stampcards/status endpoint does
// publish these as integers, but returns the identical scheme-wide default for
// every branch — participating or not — so an extra per-branch request buys us
// nothing over modelling them here. Live 2026-08-02: all 10 participating
// branches probed returned offerType "default", size 5, 10%.
// These describe a FUTURE order's voucher; they never reduce the current total.
const JUST_EAT_STAMP_CARD_PERCENT = 10;
const JUST_EAT_STAMP_CARD_SIZE = 5;

function platformFromUrl(url) {
  try {
    const hostname = new URL(url).hostname;
    if (hostname === 'www.ubereats.com' || hostname.endsWith('.ubereats.com')) return PLATFORM.UBER_EATS;
    if (hostname === 'www.deliveroo.co.uk' || hostname.endsWith('.deliveroo.co.uk')) return PLATFORM.DELIVEROO;
    if (hostname === 'www.just-eat.co.uk' || hostname.endsWith('.just-eat.co.uk')) return PLATFORM.JUST_EAT;
  } catch (_) {}
  return null;
}

// Registrable hosts each platform's branch/menu URLs may resolve to (mirrors the
// manifest host_permissions). Branch menu URLs are scraped from page links, so a
// malicious page could surface an off-platform absolute href; validate before
// opening one in a tab. Matches the apex and any subdomain, but not look-alikes
// (e.g. ubereats.com.evil.com).
const MENU_URL_HOSTS = {
  [PLATFORM.UBER_EATS]: 'ubereats.com',
  [PLATFORM.DELIVEROO]: 'deliveroo.co.uk',
  [PLATFORM.JUST_EAT]: 'just-eat.co.uk',
};

function isAllowedMenuUrl(platform, url) {
  const suffix = MENU_URL_HOSTS[platform];
  if (!suffix) return false;
  let host;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch (_) {
    return false;
  }
  return host === suffix || host.endsWith('.' + suffix);
}

// Just Eat's own internal APIs — menu/dynamic (fees), consumer offers, and the CDN
// that serves large menus' catalogue — live on hosts distinct from just-eat.co.uk.
// just-eat-scraper.js builds these URLs from page-supplied data (__NEXT_DATA__), so
// validate them the same way as isAllowedMenuUrl before fetching: a compromised page
// shouldn't be able to redirect these requests off-platform.
const JE_API_HOSTS = ['uk.api.just-eat.io', 'menu-globalmenucdn.je-apis.com'];

function isJeApiUrl(url) {
  let host;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch (_) {
    return false;
  }
  return JE_API_HOSTS.some((h) => host === h || host.endsWith('.' + h));
}

// Path shape of each platform's restaurant menu page. Interstitials (consent,
// login, area listing) often live on the SAME host, so a host check alone can't
// tell "the menu finished loading" from "a redirect stopped short of it".
const MENU_URL_PATHS = {
  [PLATFORM.UBER_EATS]: /\/store\//,
  [PLATFORM.DELIVEROO]: /^\/menu\//,
  [PLATFORM.JUST_EAT]: /^\/restaurants-[^/]+\/menu/,
};

// True only when the URL is a restaurant menu page on the platform's own host —
// the signal that a switch tab is ready for the basket-builder.
function isMenuPageUrl(platform, url) {
  if (!isAllowedMenuUrl(platform, url)) return false;
  const re = MENU_URL_PATHS[platform];
  return re ? re.test(new URL(url).pathname) : false;
}

function buildSearchUrl(platform, restaurantName, postcode) {
  const template = SEARCH_URL_TEMPLATES[platform];
  if (!template) return null;
  // Search by the brand (first token) only: the verbose store name ("Subway Mile
  // End Halal") makes Uber return just that one store, hiding sibling branches.
  const brand = String(restaurantName || '').trim().split(/\s+/)[0] || '';
  return template
    .replace('{name}', encodeURIComponent(brand))
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
  DEFAULT_BRANCH_COUNT,
  DEFAULT_MAX_CONCURRENT,
  DELIVEROO_SERVICE_FEE_PCT,
  DELIVEROO_SERVICE_FEE_CAP,
  JUST_EAT_SMALL_ORDER_THRESHOLD,
  JUST_EAT_STAMP_CARD_PERCENT,
  JUST_EAT_STAMP_CARD_SIZE,
  platformFromUrl,
  buildSearchUrl,
  isAllowedMenuUrl,
  isJeApiUrl,
  isMenuPageUrl,
  getConfig,
  browser,
};
