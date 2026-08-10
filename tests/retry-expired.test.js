// After the MV3 worker idles out its in-memory `comparisons` Map is gone, so a
// Retry ↻ click lands on a handler with no comparison for the tab. Before #106
// both retry handlers returned nothing — the button did nothing and the only
// trace was a line in the worker's own console. These tests pin the interim
// contract that mirrors the switch path (#104): a dead retry replies
// {ok:false, reason:'expired'} so the sidebar can explain itself, while a retry
// that can still be serviced replies {ok:true}.

jest.mock('webextension-polyfill', () => {
  const listeners = [];
  return {
    __listeners: listeners,
    runtime: { onMessage: { addListener: (fn) => listeners.push(fn) } },
    tabs: {
      create: jest.fn(async () => ({ id: Math.floor(Math.random() * 1e6) })),
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
const { MSG, PLATFORM } = require('../src/shared/constants');
require('../src/background/service-worker');

// The worker registers one onMessage listener per message type; each returns
// undefined for a type it does not handle. Fan a message out to all of them and
// return the single meaningful reply. This calls the listeners directly, so it
// asserts their return VALUE — for that value to actually reach the sidebar over
// the polyfill's channel the listener must be async (return a Promise); a sync
// listener returning a plain object sends no response. Both retry listeners, like
// SWITCH_TO_BRANCH, are async for exactly that reason.
async function dispatch(msg, sender) {
  const results = await Promise.all(browser.__listeners.map((fn) => fn(msg, sender)));
  return results.find((r) => r !== undefined);
}

beforeEach(() => {
  jest.useFakeTimers();
  browser.storage.session.get.mockResolvedValue({});
});

afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
});

describe('retry after the worker has idled out (cold comparisons Map)', () => {
  test('a platform retry with no comparison for the tab replies expired', async () => {
    const reply = await dispatch(
      { type: MSG.RETRY_PLATFORM, platform: PLATFORM.DELIVEROO },
      { tab: { id: 4242 } },
    );
    expect(reply).toEqual({ ok: false, reason: 'expired' });
  });

  test('a branch retry with no comparison for the tab replies expired', async () => {
    const reply = await dispatch(
      { type: MSG.RETRY_BRANCH, branchKey: 'del|wc' },
      { tab: { id: 4242 } },
    );
    expect(reply).toEqual({ ok: false, reason: 'expired' });
  });
});

describe('retry that can still be serviced', () => {
  test('a platform retry with a live comparison replies ok', async () => {
    const tabId = 77;
    // Seed a real comparison through START_COMPARISON. No postcode means Just Eat
    // builds no search URL, so it settles out of `loading` immediately — leaving a
    // platform that a retry can service without waiting on a background tab.
    const order = {
      platform: PLATFORM.UBER_EATS,
      restaurantName: 'Tayyabs',
      postcode: null,
      items: [{ name: 'Seekh Kebab', unitPrice: 500, quantity: 1 }],
      discounts: [],
      checkoutTotal: 500,
      deliveryFee: 0,
      serviceFee: 0,
    };
    browser.storage.session.get.mockImplementation(async (key) =>
      key === 'currentOrder' ? { currentOrder: order } : {});

    await dispatch({ type: MSG.START_COMPARISON, tabId }, { tab: { id: tabId } });

    const reply = await dispatch(
      { type: MSG.RETRY_PLATFORM, platform: PLATFORM.JUST_EAT },
      { tab: { id: tabId } },
    );
    expect(reply).toEqual({ ok: true });
  });
});

describe('cold retry rebuilds a fresh comparison (#122)', () => {
  // A postcode is required or buildSearchUrl yields no URL and nothing opens a
  // tab; with one, every platform enumerates, so a rebuild is observable as a
  // tabs.create call.
  const order = {
    platform: PLATFORM.UBER_EATS,
    restaurantName: 'Tayyabs',
    postcode: 'E1 1EW',
    items: [{ name: 'Seekh Kebab', unitPrice: 500, quantity: 1 }],
    discounts: [],
    checkoutTotal: 500,
    deliveryFee: 0,
    serviceFee: 0,
  };

  test('a cold platform retry with an order in session storage rebuilds and replies restarted', async () => {
    browser.storage.session.get.mockImplementation(async (key) =>
      key === 'currentOrder' ? { currentOrder: order } : {});
    browser.tabs.create.mockClear();

    const reply = await dispatch(
      { type: MSG.RETRY_PLATFORM, platform: PLATFORM.DELIVEROO },
      { tab: { id: 9001 } },
    );

    expect(reply).toEqual({ ok: true, reason: 'restarted' });
    expect(browser.tabs.create).toHaveBeenCalled();  // enumeration was driven
  });

  test('a cold branch retry with an order in session storage rebuilds and replies restarted', async () => {
    browser.storage.session.get.mockImplementation(async (key) =>
      key === 'currentOrder' ? { currentOrder: order } : {});

    const reply = await dispatch(
      { type: MSG.RETRY_BRANCH, branchKey: 'del|wc' },
      { tab: { id: 9002 } },
    );

    expect(reply).toEqual({ ok: true, reason: 'restarted' });
  });

  test('a cold retry with no order in session storage still replies expired', async () => {
    browser.storage.session.get.mockResolvedValue({});  // nothing stored

    const reply = await dispatch(
      { type: MSG.RETRY_PLATFORM, platform: PLATFORM.DELIVEROO },
      { tab: { id: 9003 } },
    );

    expect(reply).toEqual({ ok: false, reason: 'expired' });
  });
});
