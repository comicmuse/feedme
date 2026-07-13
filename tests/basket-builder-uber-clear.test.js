/**
 * @jest-environment jsdom
 * @jest-environment-options {"url": "https://www.ubereats.com/gb/store/kfc-london-mile-end-road/g_s9XoGVSkmubs6Lk1hziA?diningMode=DELIVERY"}
 *
 * Uber Eats basket clearing (issue #24). Own file because the store-scoping
 * logic reads document.location's /store/ path, which the main test file's
 * default jsdom URL doesn't carry.
 */
const { clearBasket } = require('../src/content/basket-builder');

const STORE_PATH = '/gb/store/kfc-london-mile-end-road/g_s9XoGVSkmubs6Lk1hziA';
const OTHER_PATH = '/gb/store/popeyes-london-city/aBcD';

// The LIVE Uber cart drawer shape (2026-07-11, KFC Mile End): a "BasketN"
// badge button opens a drawer with a Close button and one <li> per cart row —
// an editItem link whose href carries the store path, a qty label, and
// Decrement/Increment steppers. Decrement decrements; at quantity 1 it removes
// the row. Rows of ANOTHER store's cart look the same but link elsewhere.
// Per-row observability that survives the drawer being dismissed.
let clicksByName = {};
let removedByName = {};

function mountUberDrawer(rows) {
  const drawer = document.createElement('div');
  drawer.id = 'drawer';
  const close = document.createElement('button');
  close.setAttribute('aria-label', 'Close');
  close.addEventListener('click', () => drawer.remove());
  drawer.appendChild(close);
  const list = document.createElement('ul');
  rows.forEach(({ name, qty, path }) => {
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.setAttribute('href', `${path}?diningMode=DELIVERY&mod=editItem&modctx=x`);
    a.textContent = name;
    const qtyEl = document.createElement('span');
    let n = qty;
    qtyEl.textContent = String(n);
    const dec = document.createElement('button');
    dec.setAttribute('aria-label', 'Decrement');
    clicksByName[name] = 0;
    dec.addEventListener('click', () => {
      clicksByName[name] += 1;
      n -= 1;
      if (n <= 0) { removedByName[name] = true; li.remove(); } else qtyEl.textContent = String(n);
    });
    li.appendChild(a); li.appendChild(qtyEl); li.appendChild(dec);
    list.appendChild(li);
  });
  drawer.appendChild(list);
  document.body.appendChild(drawer);
  return drawer;
}

function mountBadge(rows) {
  const badge = document.createElement('button');
  badge.textContent = `Basket${rows.length}`;
  badge.addEventListener('click', () => mountUberDrawer(rows));
  document.body.appendChild(badge);
  return badge;
}

// A logged-in account with carts at OTHER restaurants but none at this store
// (issue #43, live-pinned 2026-07-13): the badge reads "BasketsN" and opens a
// cart SWITCHER — one li[role=menuitem] tile per restaurant ("<Name>Subtotal:
// £…"), far-address carts grouped under a "You seem far away from the shop"
// heading nested inside the first such tile. No editItem rows, no Close
// button; clicking the badge again toggles the switcher shut. (When this
// store HAS a cart the drawer above opens directly — the switcher never
// carries this store's rows.)
function mountSwitcherBadge(entries) {
  const badge = document.createElement('button');
  badge.setAttribute('data-test-id', 'view-carts-btn');
  badge.textContent = `Baskets${entries.length}`;
  badge.addEventListener('click', () => {
    const open = document.getElementById('switcher');
    if (open) open.remove(); else mountSwitcher(entries);
  });
  document.body.appendChild(badge);
  return badge;
}

function mountSwitcher(entries) {
  const panel = document.createElement('ul');
  panel.id = 'switcher';
  let farAwayShown = false;
  entries.forEach((entry) => {
    const tile = document.createElement('li');
    tile.setAttribute('role', 'menuitem');
    tile.setAttribute('data-testid', `menu-item-${entry.name}`);
    if (entry.farAway && !farAwayShown) {
      const heading = document.createElement('div');
      heading.textContent = 'You seem far away from the shop';
      tile.appendChild(heading);
      farAwayShown = true;
    }
    const label = document.createElement('div');
    label.textContent = `${entry.name}Subtotal: £${entry.subtotal}Deliver to ${entry.address}`;
    tile.appendChild(label);
    clicksByName[entry.name] = 0;
    tile.addEventListener('click', () => { clicksByName[entry.name] += 1; });
    panel.appendChild(tile);
  });
  document.body.appendChild(panel);
  return panel;
}

describe('clearBasket — Uber Eats cart drawer', () => {
  beforeEach(() => { document.body.innerHTML = ''; clicksByName = {}; removedByName = {}; });
  const fastWait = (fn) => Promise.resolve(fn());

  test('surfaces the drawer via the Basket badge, clears every unit, and closes it', async () => {
    mountBadge([
      { name: 'Original Sauce', qty: 2, path: STORE_PATH },
      { name: 'Tender', qty: 1, path: STORE_PATH },
    ]);
    const r = await clearBasket(document, 'uber-eats', fastWait);
    expect(r).toEqual({ hadItems: true, cleared: true, removed: 3 });
    expect(document.getElementById('drawer')).toBeNull(); // dismissed after clearing
  });

  test("never touches another store's cart rows", async () => {
    mountBadge([
      { name: 'Original Sauce', qty: 1, path: STORE_PATH },
      { name: 'Foreign Wrap', qty: 1, path: OTHER_PATH },
    ]);
    const r = await clearBasket(document, 'uber-eats', fastWait);
    expect(r).toEqual({ hadItems: true, cleared: true, removed: 1 });
    // The drawer is dismissed afterwards, so observe the foreign row's fate via
    // its recorded clicks: never clicked, never removed (li intact when closed).
    expect(clicksByName['Foreign Wrap']).toBe(0);
    expect(removedByName['Foreign Wrap']).toBeUndefined();
    expect(removedByName['Original Sauce']).toBe(true);
  });

  test('is a no-op when the badge shows an empty basket', async () => {
    mountBadge([]);
    const r = await clearBasket(document, 'uber-eats', fastWait);
    expect(r).toEqual({ hadItems: false, cleared: true, removed: 0 });
  });

  test('treats the multi-restaurant cart switcher as empty, clicks no tile, and toggles it shut (#43)', async () => {
    mountSwitcherBadge([
      { name: "Domino's Pizza", subtotal: '46.38', farAway: true, address: 'E14 7LG' },
      { name: "McDonald's", subtotal: '18.57', farAway: true, address: 'E14 7LG' },
      { name: 'Subway', subtotal: '28.30', farAway: true, address: 'E14 7LG' },
    ]);
    const r = await clearBasket(document, 'uber-eats', fastWait);
    expect(r).toEqual({ hadItems: false, cleared: true, removed: 0 });
    expect(clicksByName["Domino's Pizza"]).toBe(0);
    expect(clicksByName["McDonald's"]).toBe(0);
    expect(clicksByName.Subway).toBe(0);
    // dismissed via the badge toggle — a lingering switcher would sit over the
    // menu for the whole fill
    expect(document.getElementById('switcher')).toBeNull();
  });
});
