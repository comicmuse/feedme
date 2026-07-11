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
});
