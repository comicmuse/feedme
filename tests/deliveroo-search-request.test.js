// Deliveroo's search resolver (text_search) soft-blocks any request that lacks
// the `x-roo-sticky-guid` header, replying HTTP 200 with a single GraphQL error
// "Try again in a moment" and `data.results: null` — no restaurant cards. The
// real web app always sends `x-roo-sticky-guid` (equal to its `x-roo-guid`), so
// the service worker's replayed search must too, or every live enumeration comes
// back empty (#131). Verified live: a request WITHOUT the header errors; adding
// it (any value) returns the full card layout.
// jsdom's crypto lacks randomUUID, which the SW uses for request guids; the real
// extension service worker has it. Polyfill from Node before the SW module loads.
const nodeCrypto = require('crypto');
if (typeof global.crypto?.randomUUID !== 'function') {
  Object.defineProperty(global, 'crypto', { value: nodeCrypto.webcrypto, configurable: true });
}

jest.mock('webextension-polyfill', () => {
  const listeners = [];
  return {
    __listeners: listeners,
    runtime: { onMessage: { addListener: (fn) => listeners.push(fn) } },
    tabs: {
      create: jest.fn(async () => ({ id: 1 })),
      sendMessage: jest.fn(async () => {}),
      get: jest.fn(async () => ({})),
      remove: jest.fn(async () => {}),
      onUpdated: { addListener: () => {} },
      onRemoved: { addListener: () => {} },
    },
    webNavigation: { onHistoryStateUpdated: { addListener: () => {} } },
    storage: {
      session: { get: jest.fn(async () => ({})), set: jest.fn(async () => {}) },
      local: { get: jest.fn(async () => ({})) },
    },
    scripting: { executeScript: jest.fn(async () => {}) },
    action: { setBadgeText: jest.fn(), setBadgeBackgroundColor: jest.fn() },
  };
});

const browser = require('webextension-polyfill');
const { MSG } = require('../src/shared/constants');
require('../src/background/service-worker');

// Flush the microtask queue so the fire-and-forget fetch chain settles.
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

async function dispatchSearch() {
  let fetchInit;
  global.fetch = jest.fn(async (_url, init) => {
    fetchInit = init;
    return { ok: true, status: 200, json: async () => ({ data: { results: { layoutGroups: [] } } }) };
  });
  const msg = {
    type: MSG.DELIVEROO_SEARCH,
    brand: 'Tayyab',
    location: { geohash: 'gcpvp1tvkpfy', city_uname: 'london', neighborhood_uname: 'limehouse' },
    // The scraper passes window.location.href — the bare listing page, which has
    // NO query param (fulfillment_method + geohash only). The SW must add query=brand.
    url: 'https://deliveroo.co.uk/restaurants/london/limehouse?fulfillment_method=DELIVERY&geohash=gcpvp1tvkpfy',
  };
  for (const fn of browser.__listeners) fn(msg, { tab: { id: 1 } });
  await flush();
  return fetchInit;
}

test('the search request carries x-roo-sticky-guid (Deliveroo soft-blocks requests without it)', async () => {
  const init = await dispatchSearch();
  expect(global.fetch).toHaveBeenCalled();
  expect(init.headers['x-roo-sticky-guid']).toBeTruthy();
});

test('x-roo-sticky-guid matches x-roo-guid, as the real web app sends it', async () => {
  const init = await dispatchSearch();
  expect(init.headers['x-roo-sticky-guid']).toBe(init.headers['x-roo-guid']);
});

// text_search reads the search term from the request `url`'s query param, not
// only from options.query — a url without `query=<brand>` returns a generic,
// restaurant-less layout even with options.query set (verified live: bare listing
// url → 0 cards; same request with ?query=Popeyes → 22 cards). #131.
test('the request url carries the brand as its query param', async () => {
  const init = await dispatchSearch();
  const sent = JSON.parse(init.body);
  const u = new URL(sent.variables.url);
  expect(u.searchParams.get('query')).toBe('Tayyab');
});
