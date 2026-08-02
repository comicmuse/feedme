/**
 * The popup decides which of three states to show, and the priority between
 * them is the whole point of #77: missing host access must win, because it is
 * the reason there is no order to offer.
 */
const fs = require('fs');
const path = require('path');

const HTML = fs.readFileSync(path.join(__dirname, '../popup/popup.html'), 'utf8');

let mockBrowser;

jest.mock('../src/shared/constants', () => ({
  MSG: { START_COMPARISON: 'START_COMPARISON' },
  get browser() { return mockBrowser; },
}));

function setup({ order = null, granted = true, requestResult = true } = {}) {
  document.body.innerHTML = HTML.replace(/[\s\S]*<body>/, '').replace(/<\/body>[\s\S]*/, '');
  const hostPermissions = ['*://www.just-eat.co.uk/*', '*://uk.api.just-eat.io/*'];
  mockBrowser = {
    runtime: {
      getManifest: () => ({ host_permissions: hostPermissions }),
      sendMessage: jest.fn().mockResolvedValue(undefined),
    },
    storage: { session: { get: jest.fn().mockResolvedValue(order ? { currentOrder: order } : {}) } },
    permissions: {
      contains: jest.fn().mockResolvedValue(granted),
      request: jest.fn().mockResolvedValue(requestResult),
    },
    tabs: {
      query: jest.fn().mockResolvedValue([{ id: 7 }]),
      reload: jest.fn().mockResolvedValue(undefined),
    },
  };
  jest.isolateModules(() => { require('../src/popup.js'); });
  // Let init()'s awaits settle.
  return new Promise((r) => setTimeout(r, 0));
}

const visible = (id) => !document.getElementById(id).classList.contains('hidden');

beforeEach(() => { window.close = jest.fn(); });

const ORDER = { restaurantName: 'KFC', items: [{}, {}], postcode: 'E1 4DH' };

test('offers a comparison when access is granted and an order was captured', async () => {
  await setup({ order: ORDER });
  expect(visible('state-ready')).toBe(true);
  expect(visible('state-permission')).toBe(false);
  expect(document.getElementById('item-count').textContent).toBe('2 items · E1 4DH');
});

test('shows the idle state when access is fine but nothing was captured', async () => {
  await setup({ order: null });
  expect(visible('state-idle')).toBe(true);
  expect(visible('state-permission')).toBe(false);
});

// The case that motivated #77: revoked access means the content script never
// ran, so there is no order — and the idle state's "go to a checkout page"
// would send the user round a loop that cannot succeed.
test('revoked access is shown instead of the idle state, naming each host', async () => {
  await setup({ order: null, granted: false });
  expect(visible('state-permission')).toBe(true);
  expect(visible('state-idle')).toBe(false);
  const shown = [...document.querySelectorAll('#missing-origins li')].map((li) => li.textContent);
  expect(shown).toEqual(['www.just-eat.co.uk', 'uk.api.just-eat.io']);
});

test('revoked access outranks an order captured before the revocation', async () => {
  await setup({ order: ORDER, granted: false });
  expect(visible('state-permission')).toBe(true);
  expect(visible('state-ready')).toBe(false);
});

test('granting reloads the tab, because content scripts do not inject retroactively', async () => {
  await setup({ order: null, granted: false, requestResult: true });
  document.getElementById('grant-btn').click();
  await new Promise((r) => setTimeout(r, 0));
  expect(mockBrowser.permissions.request).toHaveBeenCalledWith({
    origins: ['*://www.just-eat.co.uk/*', '*://uk.api.just-eat.io/*'],
  });
  expect(mockBrowser.tabs.reload).toHaveBeenCalledWith(7);
});

test('a declined grant says so and reloads nothing', async () => {
  await setup({ order: null, granted: false, requestResult: false });
  document.getElementById('grant-btn').click();
  await new Promise((r) => setTimeout(r, 0));
  expect(mockBrowser.tabs.reload).not.toHaveBeenCalled();
  expect(document.getElementById('grant-note').textContent).toMatch(/not granted/i);
});

test('comparing sends START_COMPARISON for the active tab', async () => {
  await setup({ order: ORDER });
  document.getElementById('compare-btn').click();
  await new Promise((r) => setTimeout(r, 0));
  expect(mockBrowser.runtime.sendMessage).toHaveBeenCalledWith({ type: 'START_COMPARISON', tabId: 7 });
});
