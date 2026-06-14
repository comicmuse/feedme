# FeedMe Browser Extension — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Chrome + Firefox MV3 browser extension that injects a price comparison sidebar on delivery platform checkout pages, comparing the current order across Uber Eats, Deliveroo, and Just Eat.

**Architecture:** A content script (`checkout-reader.js`) reads the checkout page DOM to extract the current order and stores it in session storage. The extension popup detects whether an order is ready and shows either a "Compare prices" button or a help message. On compare, the background service worker injects the sidebar, opens two background tabs for the comparison platforms, injects a fetch/XHR interceptor (`platform-scraper.js`, MAIN world) into each, collects and classifies API responses, runs fuzzy item matching, computes totals, and sends results to the sidebar.

**Tech Stack:** Vanilla JS (CommonJS), esbuild (bundler), fuse.js (fuzzy matching), webextension-polyfill (Firefox/Chrome normalisation), Jest + jsdom (unit tests), Manifest V3 (Chrome 109+ / Firefox 109+).

---

## File Map

```
feedme/
├── manifest.json
├── package.json
├── esbuild.config.mjs
├── .gitignore
├── icons/
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
├── popup/
│   ├── popup.html
│   └── popup.css
├── src/
│   ├── shared/
│   │   ├── constants.js       # MSG types, PLATFORM ids, URL templates, config
│   │   ├── matcher.js         # matchItems() + computeTotal() — pure, no browser APIs
│   │   └── parsers.js         # per-platform JSON to normalised PlatformMenu — pure
│   ├── content/
│   │   ├── checkout-reader.js # reads order from checkout DOM; sets badge
│   │   ├── platform-scraper.js# injected MAIN world into bg tabs; intercepts fetch/XHR
│   │   └── sidebar.js         # injects Shadow DOM sidebar into checkout page
│   └── background/
│       └── service-worker.js  # tab orchestration, message routing, badge management
└── tests/
    ├── matcher.test.js
    ├── parsers.test.js
    ├── checkout-reader.test.js
    └── fixtures/
        ├── ubereats-checkout.html
        ├── deliveroo-checkout.html
        ├── just-eat-checkout.html
        ├── ubereats-menu.json
        ├── deliveroo-menu.json
        └── just-eat-menu.json
```

---

### Task 1: Scaffold project

**Files:**
- Create: `package.json`
- Create: `esbuild.config.mjs`
- Create: `manifest.json`
- Create: `.gitignore`
- Create: `popup/popup.html`
- Create: `popup/popup.css`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "feedme",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "build": "node esbuild.config.mjs",
    "watch": "node esbuild.config.mjs --watch",
    "test": "jest"
  },
  "dependencies": {
    "fuse.js": "^7.0.0",
    "webextension-polyfill": "^0.10.0"
  },
  "devDependencies": {
    "esbuild": "^0.21.0",
    "jest": "^29.0.0",
    "jest-environment-jsdom": "^29.0.0"
  },
  "jest": {
    "testEnvironment": "jsdom",
    "testMatch": ["**/tests/**/*.test.js"]
  }
}
```

- [ ] **Step 2: Install dependencies**

```bash
npm install
```

Expected: `node_modules/` created, no errors.

- [ ] **Step 3: Create `esbuild.config.mjs`**

```js
import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');

const ctx = await esbuild.context({
  entryPoints: {
    'service-worker': 'src/background/service-worker.js',
    'checkout-reader': 'src/content/checkout-reader.js',
    'platform-scraper': 'src/content/platform-scraper.js',
    'sidebar': 'src/content/sidebar.js',
    'popup': 'src/popup.js',
  },
  bundle: true,
  outdir: 'dist',
  format: 'iife',
  target: ['chrome109', 'firefox109'],
  logLevel: 'info',
});

if (watch) {
  await ctx.watch();
  console.log('Watching for changes...');
} else {
  await ctx.rebuild();
  await ctx.dispose();
}
```

- [ ] **Step 4: Create `manifest.json`**

```json
{
  "manifest_version": 3,
  "name": "FeedMe",
  "version": "0.1.0",
  "description": "Compare delivery prices across Uber Eats, Deliveroo, and Just Eat",
  "permissions": [
    "tabs",
    "scripting",
    "storage",
    "activeTab"
  ],
  "host_permissions": [
    "*://www.ubereats.com/*",
    "*://www.deliveroo.co.uk/*",
    "*://www.just-eat.co.uk/*"
  ],
  "background": {
    "service_worker": "dist/service-worker.js"
  },
  "content_scripts": [
    {
      "matches": [
        "*://www.ubereats.com/gb/store/*/checkout*",
        "*://www.deliveroo.co.uk/*/checkout*",
        "*://www.just-eat.co.uk/*/order*"
      ],
      "js": ["dist/checkout-reader.js"],
      "run_at": "document_idle"
    }
  ],
  "action": {
    "default_popup": "popup/popup.html",
    "default_icon": {
      "16": "icons/icon16.png",
      "48": "icons/icon48.png",
      "128": "icons/icon128.png"
    }
  },
  "browser_specific_settings": {
    "gecko": {
      "id": "feedme@feedme.dev",
      "strict_min_version": "109.0"
    }
  }
}
```

- [ ] **Step 5: Create `.gitignore`**

```
node_modules/
dist/
.superpowers/
```

- [ ] **Step 6: Create `popup/popup.html`**

```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <link rel="stylesheet" href="popup.css">
</head>
<body>
  <div class="logo">feed<span>me</span></div>
  <div id="state-ready" class="hidden">
    <p class="restaurant" id="restaurant-name"></p>
    <p class="sub" id="item-count"></p>
    <button id="compare-btn">Compare prices</button>
  </div>
  <div id="state-idle">
    <p>Go to the checkout page on a supported platform, then click here to compare prices.</p>
    <ul>
      <li>Uber Eats checkout</li>
      <li>Deliveroo checkout</li>
      <li>Just Eat order page</li>
    </ul>
  </div>
  <script src="../dist/popup.js"></script>
</body>
</html>
```

- [ ] **Step 7: Create `popup/popup.css`**

```css
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; width: 260px; padding: 16px; }
.logo { font-size: 18px; font-weight: 800; margin-bottom: 12px; }
.logo span { color: #f97316; }
.hidden { display: none; }
p { font-size: 13px; color: #6b7280; line-height: 1.5; }
ul { font-size: 12px; color: #374151; padding-left: 16px; margin-top: 8px; line-height: 1.8; }
.restaurant { font-size: 13px; font-weight: 600; color: #111; margin-bottom: 2px; }
.sub { font-size: 11px; color: #9ca3af; margin-bottom: 12px; }
#compare-btn {
  width: 100%; background: #f97316; color: #fff; border: none;
  border-radius: 8px; padding: 10px; font-size: 13px; font-weight: 700; cursor: pointer;
}
#compare-btn:hover { background: #ea6c10; }
```

- [ ] **Step 8: Create stub source files**

```bash
mkdir -p src/shared src/content src/background tests/fixtures
touch src/shared/constants.js src/shared/matcher.js src/shared/parsers.js
touch src/content/checkout-reader.js src/content/platform-scraper.js src/content/sidebar.js
touch src/background/service-worker.js src/popup.js
```

- [ ] **Step 9: Add placeholder icons**

```bash
mkdir -p icons
```

Add any three PNG files as `icons/icon16.png` (16x16), `icons/icon48.png` (48x48), `icons/icon128.png` (128x128). A plain coloured square is fine for development — the extension will not load without them.

- [ ] **Step 10: Verify build works with empty stubs**

```bash
npm run build
```

Expected: `dist/` contains `service-worker.js`, `checkout-reader.js`, `platform-scraper.js`, `sidebar.js`, `popup.js`.

- [ ] **Step 11: Commit**

```bash
git init
git add .
git commit -m "chore: scaffold FeedMe extension project"
```

---

### Task 2: Shared constants

**Files:**
- Modify: `src/shared/constants.js`

- [ ] **Step 1: Write `src/shared/constants.js`**

```js
const browser = require('webextension-polyfill');

const PLATFORM = {
  UBER_EATS: 'uber-eats',
  DELIVEROO: 'deliveroo',
  JUST_EAT: 'just-eat',
};

const CHECKOUT_PATTERNS = {
  [PLATFORM.UBER_EATS]: /ubereats\.com\/gb\/store\/[^/]+\/checkout/,
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
    if (hostname.includes('ubereats')) return PLATFORM.UBER_EATS;
    if (hostname.includes('deliveroo')) return PLATFORM.DELIVEROO;
    if (hostname.includes('just-eat')) return PLATFORM.JUST_EAT;
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
```

- [ ] **Step 2: Build and verify**

```bash
npm run build
```

Expected: clean build.

- [ ] **Step 3: Commit**

```bash
git add src/shared/constants.js
git commit -m "feat: shared constants, platform helpers, webextension-polyfill"
```

---

### Task 3: Item matching and total computation (TDD)

**Files:**
- Modify: `src/shared/matcher.js`
- Create: `tests/matcher.test.js`

Pure functions — no browser APIs. Test first.

- [ ] **Step 1: Write failing tests in `tests/matcher.test.js`**

```js
const { matchItems, computeTotal } = require('../src/shared/matcher');

const PLATFORM_ITEMS = [
  { name: 'Whopper', description: 'Flame-grilled beef burger', unitPrice: 5.89 },
  { name: 'Double Whopper', description: 'Two flame-grilled patties', unitPrice: 7.89 },
  { name: 'Large Fries', description: 'Seasoned shoestring fries', unitPrice: 3.19 },
  { name: 'Coca-Cola Large', description: '330ml drink', unitPrice: 2.49 },
];

describe('matchItems', () => {
  test('matches exact name', () => {
    const ref = [{ name: 'Whopper', quantity: 1, unitPrice: 5.49 }];
    const [result] = matchItems(ref, PLATFORM_ITEMS);
    expect(result.matched).toBe(true);
    expect(result.platformItem.name).toBe('Whopper');
  });

  test('matches near-identical name (case difference)', () => {
    const ref = [{ name: 'large fries', quantity: 1, unitPrice: 2.99 }];
    const [result] = matchItems(ref, PLATFORM_ITEMS);
    expect(result.matched).toBe(true);
    expect(result.platformItem.name).toBe('Large Fries');
  });

  test('returns unmatched for item well outside threshold', () => {
    const ref = [{ name: 'Vegan Artisan Flatbread', quantity: 1, unitPrice: 9.00 }];
    const [result] = matchItems(ref, PLATFORM_ITEMS);
    expect(result.matched).toBe(false);
    expect(result.platformItem).toBeNull();
  });

  test('returns one result per reference item', () => {
    const ref = [
      { name: 'Whopper', quantity: 1, unitPrice: 5.49 },
      { name: 'Large Fries', quantity: 2, unitPrice: 2.99 },
    ];
    expect(matchItems(ref, PLATFORM_ITEMS)).toHaveLength(2);
  });

  test('preserves reference item in result', () => {
    const ref = [{ name: 'Whopper', quantity: 3, unitPrice: 5.49 }];
    const [result] = matchItems(ref, PLATFORM_ITEMS);
    expect(result.referenceItem.quantity).toBe(3);
  });
});

describe('computeTotal', () => {
  test('sums matched items times quantity, adds fees, subtracts discounts', () => {
    const matches = [
      { referenceItem: { quantity: 1 }, platformItem: { unitPrice: 5.89 }, matched: true },
      { referenceItem: { quantity: 2 }, platformItem: { unitPrice: 3.19 }, matched: true },
    ];
    // items: 5.89 + 6.38 = 12.27; + 1.99 delivery + 1.50 service - 2.00 discount = 13.76
    const result = computeTotal(matches, 1.99, 1.50, [{ amount: 2.00, label: '20% off' }]);
    expect(result.itemsTotal).toBeCloseTo(12.27);
    expect(result.total).toBeCloseTo(13.76);
    expect(result.discountTotal).toBeCloseTo(2.00);
    expect(result.matchedCount).toBe(2);
    expect(result.totalCount).toBe(2);
  });

  test('excludes unmatched items from total', () => {
    const matches = [
      { referenceItem: { quantity: 1 }, platformItem: { unitPrice: 5.89 }, matched: true },
      { referenceItem: { quantity: 1 }, platformItem: null, matched: false },
    ];
    const result = computeTotal(matches, 0, 0, []);
    expect(result.itemsTotal).toBeCloseTo(5.89);
    expect(result.matchedCount).toBe(1);
    expect(result.totalCount).toBe(2);
  });

  test('handles zero fees and empty discounts', () => {
    const matches = [
      { referenceItem: { quantity: 1 }, platformItem: { unitPrice: 10.00 }, matched: true },
    ];
    const result = computeTotal(matches, 0, 0, []);
    expect(result.total).toBeCloseTo(10.00);
    expect(result.discountTotal).toBe(0);
  });
});
```

- [ ] **Step 2: Run — expect failure**

```bash
npm test -- tests/matcher.test.js
```

Expected: `Cannot find module '../src/shared/matcher'`.

- [ ] **Step 3: Implement `src/shared/matcher.js`**

```js
const Fuse = require('fuse.js');
const { FUSE_THRESHOLD } = require('./constants');

/**
 * @param {Array<{name: string, quantity: number, unitPrice: number}>} referenceItems
 * @param {Array<{name: string, description?: string, unitPrice: number}>} platformItems
 * @returns {Array<{referenceItem, platformItem, matched: boolean}>}
 */
function matchItems(referenceItems, platformItems) {
  const fuse = new Fuse(platformItems, {
    keys: [
      { name: 'name', weight: 0.8 },
      { name: 'description', weight: 0.2 },
    ],
    threshold: FUSE_THRESHOLD,
    includeScore: true,
  });

  return referenceItems.map((ref) => {
    const results = fuse.search(ref.name);
    if (results.length === 0 || (results[0].score ?? 1) > FUSE_THRESHOLD) {
      return { referenceItem: ref, platformItem: null, matched: false };
    }
    return { referenceItem: ref, platformItem: results[0].item, matched: true };
  });
}

/**
 * @param {Array<{referenceItem, platformItem, matched: boolean}>} matches
 * @param {number} deliveryFee
 * @param {number} serviceFee
 * @param {Array<{amount: number, label: string}>} discounts
 */
function computeTotal(matches, deliveryFee, serviceFee, discounts) {
  const itemsTotal = matches
    .filter((m) => m.matched)
    .reduce((sum, m) => sum + m.platformItem.unitPrice * m.referenceItem.quantity, 0);
  const discountTotal = discounts.reduce((sum, d) => sum + d.amount, 0);
  return {
    itemsTotal,
    deliveryFee,
    serviceFee,
    discountTotal,
    total: itemsTotal + deliveryFee + serviceFee - discountTotal,
    matchedCount: matches.filter((m) => m.matched).length,
    totalCount: matches.length,
  };
}

module.exports = { matchItems, computeTotal };
```

- [ ] **Step 4: Run — expect all pass**

```bash
npm test -- tests/matcher.test.js
```

Expected: 8 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/shared/matcher.js tests/matcher.test.js
git commit -m "feat: item matching and total computation (TDD)"
```

---

### Task 4: Platform response parsers (TDD)

**Files:**
- Modify: `src/shared/parsers.js`
- Create: `tests/parsers.test.js`
- Create: `tests/fixtures/ubereats-menu.json`
- Create: `tests/fixtures/deliveroo-menu.json`
- Create: `tests/fixtures/just-eat-menu.json`

`parsers.js` converts raw API JSON into the normalised shape `matcher.js` expects. Pure functions.

> **Implementer note:** The fixture JSON below represents plausible response shapes. Before writing the final parsers, open each platform in Chrome DevTools (Network tab, filter XHR/Fetch), navigate to a restaurant menu page, and capture the actual responses. Update the fixtures to match real responses, then adjust the parsers accordingly.

- [ ] **Step 1: Create `tests/fixtures/ubereats-menu.json`**

```json
{
  "data": {
    "catalogSectionsMap": {
      "items": [
        {
          "uuid": "ue-1",
          "title": "Whopper",
          "itemDescription": "Flame-grilled beef burger with lettuce and tomato",
          "price": 549
        },
        {
          "uuid": "ue-2",
          "title": "Double Whopper",
          "itemDescription": "Two flame-grilled patties",
          "price": 729
        },
        {
          "uuid": "ue-3",
          "title": "Large Fries",
          "itemDescription": "Seasoned shoestring fries",
          "price": 299
        }
      ]
    },
    "storeInfo": {
      "title": "Burger King - Victoria",
      "location": { "address": { "postalCode": "SW1E 5JE" } },
      "deliveryFee": { "price": 0 },
      "serviceFeePct": 10
    }
  }
}
```

- [ ] **Step 2: Create `tests/fixtures/deliveroo-menu.json`**

```json
{
  "restaurant": {
    "id": "dr-12345",
    "name": "Burger King - Victoria",
    "postcode": "SW1E 5JE",
    "menu": {
      "categories": [
        {
          "name": "Burgers",
          "items": [
            { "id": "dr-1", "name": "Whopper", "description": "Flame-grilled beef burger", "price": 589 },
            { "id": "dr-2", "name": "Double Whopper", "description": "Two flame-grilled patties", "price": 789 },
            { "id": "dr-3", "name": "Large Fries", "description": "Seasoned shoestring fries", "price": 319 }
          ]
        }
      ]
    },
    "deliveryFee": 299,
    "serviceFee": 172,
    "offers": [
      { "description": "Free delivery on orders over £20" }
    ]
  }
}
```

- [ ] **Step 3: Create `tests/fixtures/just-eat-menu.json`**

```json
{
  "restaurantId": "je-99999",
  "name": "Burger King - Victoria",
  "address": { "postCode": "SW1E 5JE" },
  "menuItems": [
    { "id": "je-1", "name": "Whopper", "description": "Flame-grilled beef burger", "price": 569 },
    { "id": "je-2", "name": "Double Whopper", "description": "Two flame-grilled patties", "price": 759 },
    { "id": "je-3", "name": "Large Fries", "description": "Seasoned shoestring fries", "price": 309 }
  ],
  "deliveryFee": 299,
  "serviceFeePercent": 9,
  "promotions": []
}
```

- [ ] **Step 4: Write failing tests in `tests/parsers.test.js`**

```js
const { classifyResponse, parseMenuResponse } = require('../src/shared/parsers');
const { PLATFORM } = require('../src/shared/constants');

const ubereats = require('./fixtures/ubereats-menu.json');
const deliveroo = require('./fixtures/deliveroo-menu.json');
const justeat = require('./fixtures/just-eat-menu.json');

describe('classifyResponse', () => {
  test('identifies Uber Eats menu response', () => {
    expect(classifyResponse(PLATFORM.UBER_EATS, ubereats)).toBe('menu');
  });
  test('identifies Deliveroo menu response', () => {
    expect(classifyResponse(PLATFORM.DELIVEROO, deliveroo)).toBe('menu');
  });
  test('identifies Just Eat menu response', () => {
    expect(classifyResponse(PLATFORM.JUST_EAT, justeat)).toBe('menu');
  });
  test('returns null for unrecognised response', () => {
    expect(classifyResponse(PLATFORM.UBER_EATS, { random: true })).toBeNull();
  });
  test('returns null for null input', () => {
    expect(classifyResponse(PLATFORM.DELIVEROO, null)).toBeNull();
  });
});

describe('parseMenuResponse - Uber Eats', () => {
  let result;
  beforeAll(() => { result = parseMenuResponse(PLATFORM.UBER_EATS, ubereats); });

  test('extracts restaurant name', () => { expect(result.restaurantName).toBe('Burger King - Victoria'); });
  test('extracts postcode', () => { expect(result.postcode).toBe('SW1E 5JE'); });
  test('extracts 3 items', () => { expect(result.items).toHaveLength(3); });
  test('first item has correct name and unitPrice in pounds', () => {
    expect(result.items[0].name).toBe('Whopper');
    expect(result.items[0].unitPrice).toBeCloseTo(5.49);
  });
  test('extracts delivery fee in pounds', () => { expect(result.deliveryFee).toBe(0); });
});

describe('parseMenuResponse - Deliveroo', () => {
  let result;
  beforeAll(() => { result = parseMenuResponse(PLATFORM.DELIVEROO, deliveroo); });

  test('flattens items from categories', () => { expect(result.items).toHaveLength(3); });
  test('first item unitPrice in pounds', () => { expect(result.items[0].unitPrice).toBeCloseTo(5.89); });
  test('extracts delivery fee', () => { expect(result.deliveryFee).toBeCloseTo(2.99); });
  test('extracts service fee', () => { expect(result.serviceFee).toBeCloseTo(1.72); });
  test('extracts offers', () => {
    expect(result.offers).toHaveLength(1);
    expect(result.offers[0].description).toContain('Free delivery');
  });
});

describe('parseMenuResponse - Just Eat', () => {
  let result;
  beforeAll(() => { result = parseMenuResponse(PLATFORM.JUST_EAT, justeat); });

  test('extracts items', () => { expect(result.items).toHaveLength(3); });
  test('first item unitPrice in pounds', () => { expect(result.items[0].unitPrice).toBeCloseTo(5.69); });
  test('extracts delivery fee', () => { expect(result.deliveryFee).toBeCloseTo(2.99); });
});
```

- [ ] **Step 5: Run — expect failure**

```bash
npm test -- tests/parsers.test.js
```

Expected: `Cannot find module '../src/shared/parsers'`.

- [ ] **Step 6: Implement `src/shared/parsers.js`**

```js
const { PLATFORM } = require('./constants');

function classifyResponse(platform, data) {
  if (!data || typeof data !== 'object') return null;
  try {
    if (platform === PLATFORM.UBER_EATS && data?.data?.catalogSectionsMap?.items?.length > 0) return 'menu';
    if (platform === PLATFORM.DELIVEROO && data?.restaurant?.menu?.categories?.length > 0) return 'menu';
    if (platform === PLATFORM.JUST_EAT && Array.isArray(data?.menuItems) && data.menuItems.length > 0) return 'menu';
  } catch (_) {}
  return null;
}

function parseMenuResponse(platform, data) {
  if (platform === PLATFORM.UBER_EATS) return parseUberEats(data);
  if (platform === PLATFORM.DELIVEROO) return parseDeliveroo(data);
  if (platform === PLATFORM.JUST_EAT) return parseJustEat(data);
  throw new Error(`Unknown platform: ${platform}`);
}

function parseUberEats(data) {
  const store = data.data.storeInfo;
  return {
    restaurantName: store.title,
    postcode: store.location?.address?.postalCode ?? '',
    items: data.data.catalogSectionsMap.items.map((i) => ({
      name: i.title,
      description: i.itemDescription ?? '',
      unitPrice: i.price / 100,
    })),
    deliveryFee: (store.deliveryFee?.price ?? 0) / 100,
    serviceFee: 0,
    serviceFeePct: store.serviceFeePct ?? 0,
    offers: [],
  };
}

function parseDeliveroo(data) {
  const r = data.restaurant;
  const items = r.menu.categories.flatMap((cat) =>
    cat.items.map((i) => ({ name: i.name, description: i.description ?? '', unitPrice: i.price / 100 }))
  );
  return {
    restaurantName: r.name,
    postcode: r.postcode ?? '',
    items,
    deliveryFee: (r.deliveryFee ?? 0) / 100,
    serviceFee: (r.serviceFee ?? 0) / 100,
    serviceFeePct: 0,
    offers: (r.offers ?? []).map((o) => ({ description: o.description, amount: 0 })),
  };
}

function parseJustEat(data) {
  return {
    restaurantName: data.name,
    postcode: data.address?.postCode ?? '',
    items: data.menuItems.map((i) => ({ name: i.name, description: i.description ?? '', unitPrice: i.price / 100 })),
    deliveryFee: (data.deliveryFee ?? 0) / 100,
    serviceFee: 0,
    serviceFeePct: data.serviceFeePercent ?? 0,
    offers: (data.promotions ?? []).map((p) => ({ description: p.description ?? '', amount: 0 })),
  };
}

module.exports = { classifyResponse, parseMenuResponse };
```

- [ ] **Step 7: Run — expect all pass**

```bash
npm test -- tests/parsers.test.js
```

Expected: 18 tests pass.

- [ ] **Step 8: Commit**

```bash
git add src/shared/parsers.js tests/parsers.test.js tests/fixtures/
git commit -m "feat: platform response parsers with representative fixtures (TDD)"
```

---

### Task 5: Checkout reader (TDD)

**Files:**
- Create: `tests/fixtures/ubereats-checkout.html`
- Create: `tests/fixtures/deliveroo-checkout.html`
- Create: `tests/fixtures/just-eat-checkout.html`
- Create: `tests/checkout-reader.test.js`
- Modify: `src/content/checkout-reader.js`

Reads the current order from the checkout page DOM. Runs in ISOLATED world — no fetch interception needed.

> **Implementer note:** These fixtures are minimal representations. Open each platform's checkout page in DevTools, inspect the order summary area, find the actual CSS selectors, and update the fixtures to match. Then update the selectors in `checkout-reader.js`. Tests are the source of truth — update fixtures first.

- [ ] **Step 1: Create `tests/fixtures/ubereats-checkout.html`**

```html
<div data-testid="checkout-cart">
  <div data-testid="restaurant-name">Burger King - Victoria</div>
  <div data-testid="delivery-postcode">SW1E 5JE</div>
  <ul data-testid="cart-item-list">
    <li data-testid="cart-item">
      <span data-testid="item-quantity">1</span>
      <span data-testid="item-name">Whopper</span>
      <span data-testid="item-price">5.49</span>
    </li>
    <li data-testid="cart-item">
      <span data-testid="item-quantity">2</span>
      <span data-testid="item-name">Large Fries</span>
      <span data-testid="item-price">2.99</span>
    </li>
  </ul>
  <div data-testid="delivery-fee">0.00</div>
  <div data-testid="service-fee">1.50</div>
  <div data-testid="promo-discount" data-amount="1.80">20% off saving 1.80</div>
</div>
```

- [ ] **Step 2: Create `tests/fixtures/deliveroo-checkout.html`**

```html
<div class="checkout-summary">
  <h1 class="restaurant-title">Burger King - Victoria</h1>
  <span class="delivery-postcode">SW1E 5JE</span>
  <ul class="basket-items">
    <li class="basket-item">
      <span class="item-count">1</span>
      <span class="item-name">Whopper</span>
      <span class="item-price">5.89</span>
    </li>
    <li class="basket-item">
      <span class="item-count">2</span>
      <span class="item-name">Large Fries</span>
      <span class="item-price">3.19</span>
    </li>
  </ul>
  <div class="fee-delivery">2.99</div>
  <div class="fee-service">1.72</div>
</div>
```

- [ ] **Step 3: Create `tests/fixtures/just-eat-checkout.html`**

```html
<div class="order-summary">
  <h2 class="restaurant-name">Burger King - Victoria</h2>
  <span class="postcode">SW1E 5JE</span>
  <div class="order-items">
    <div class="order-item">
      <span class="quantity">1</span>
      <span class="name">Whopper</span>
      <span class="price">5.69</span>
    </div>
    <div class="order-item">
      <span class="quantity">2</span>
      <span class="name">Large Fries</span>
      <span class="price">3.09</span>
    </div>
  </div>
  <span class="delivery-fee">2.99</span>
  <span class="service-fee">1.69</span>
</div>
```

- [ ] **Step 4: Write failing tests in `tests/checkout-reader.test.js`**

```js
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { extractOrder } = require('../src/content/checkout-reader');
const { PLATFORM } = require('../src/shared/constants');

function docFromFixture(name) {
  const html = fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
  return new JSDOM(html).window.document;
}

describe('extractOrder - Uber Eats', () => {
  let order;
  beforeAll(() => { order = extractOrder(PLATFORM.UBER_EATS, docFromFixture('ubereats-checkout.html')); });

  test('extracts restaurant name', () => { expect(order.restaurantName).toBe('Burger King - Victoria'); });
  test('extracts postcode', () => { expect(order.postcode).toBe('SW1E 5JE'); });
  test('extracts two items', () => { expect(order.items).toHaveLength(2); });
  test('first item name, quantity, and unitPrice', () => {
    expect(order.items[0]).toEqual({ name: 'Whopper', quantity: 1, unitPrice: 5.49 });
  });
  test('second item quantity is 2', () => { expect(order.items[1].quantity).toBe(2); });
  test('extracts delivery fee as 0', () => { expect(order.deliveryFee).toBe(0); });
  test('extracts service fee', () => { expect(order.serviceFee).toBeCloseTo(1.50); });
  test('extracts one discount', () => {
    expect(order.discounts).toHaveLength(1);
    expect(order.discounts[0].amount).toBeCloseTo(1.80);
  });
});

describe('extractOrder - Deliveroo', () => {
  let order;
  beforeAll(() => { order = extractOrder(PLATFORM.DELIVEROO, docFromFixture('deliveroo-checkout.html')); });

  test('extracts restaurant name', () => { expect(order.restaurantName).toBe('Burger King - Victoria'); });
  test('extracts two items', () => { expect(order.items).toHaveLength(2); });
  test('first item unitPrice in pounds', () => { expect(order.items[0].unitPrice).toBeCloseTo(5.89); });
  test('extracts delivery fee', () => { expect(order.deliveryFee).toBeCloseTo(2.99); });
  test('has empty discounts array', () => { expect(order.discounts).toEqual([]); });
});

describe('extractOrder - Just Eat', () => {
  let order;
  beforeAll(() => { order = extractOrder(PLATFORM.JUST_EAT, docFromFixture('just-eat-checkout.html')); });

  test('extracts restaurant name', () => { expect(order.restaurantName).toBe('Burger King - Victoria'); });
  test('extracts two items', () => { expect(order.items).toHaveLength(2); });
  test('first item unitPrice in pounds', () => { expect(order.items[0].unitPrice).toBeCloseTo(5.69); });
});
```

- [ ] **Step 5: Run — expect failure**

```bash
npm test -- tests/checkout-reader.test.js
```

Expected: `Cannot find module '../src/content/checkout-reader'`.

- [ ] **Step 6: Implement `src/content/checkout-reader.js`**

```js
const { PLATFORM, MSG, platformFromUrl } = require('../shared/constants');

function parsePrice(text) {
  return parseFloat((text ?? '').replace(/[^0-9.]/g, '')) || 0;
}

function extractUberEats(doc) {
  const items = [...doc.querySelectorAll('[data-testid="cart-item"]')].map((el) => ({
    name: el.querySelector('[data-testid="item-name"]')?.textContent?.trim() ?? '',
    quantity: parseInt(el.querySelector('[data-testid="item-quantity"]')?.textContent ?? '1', 10),
    unitPrice: parsePrice(el.querySelector('[data-testid="item-price"]')?.textContent),
  }));
  const promoEl = doc.querySelector('[data-testid="promo-discount"]');
  return {
    platform: PLATFORM.UBER_EATS,
    restaurantName: doc.querySelector('[data-testid="restaurant-name"]')?.textContent?.trim() ?? '',
    postcode: doc.querySelector('[data-testid="delivery-postcode"]')?.textContent?.trim() ?? '',
    items,
    deliveryFee: parsePrice(doc.querySelector('[data-testid="delivery-fee"]')?.textContent),
    serviceFee: parsePrice(doc.querySelector('[data-testid="service-fee"]')?.textContent),
    discounts: promoEl
      ? [{ amount: parseFloat(promoEl.dataset.amount ?? '0'), label: promoEl.textContent?.trim() ?? '' }]
      : [],
  };
}

function extractDeliveroo(doc) {
  const items = [...doc.querySelectorAll('.basket-item')].map((el) => ({
    name: el.querySelector('.item-name')?.textContent?.trim() ?? '',
    quantity: parseInt(el.querySelector('.item-count')?.textContent ?? '1', 10),
    unitPrice: parsePrice(el.querySelector('.item-price')?.textContent),
  }));
  return {
    platform: PLATFORM.DELIVEROO,
    restaurantName: doc.querySelector('.restaurant-title')?.textContent?.trim() ?? '',
    postcode: doc.querySelector('.delivery-postcode')?.textContent?.trim() ?? '',
    items,
    deliveryFee: parsePrice(doc.querySelector('.fee-delivery')?.textContent),
    serviceFee: parsePrice(doc.querySelector('.fee-service')?.textContent),
    discounts: [],
  };
}

function extractJustEat(doc) {
  const items = [...doc.querySelectorAll('.order-item')].map((el) => ({
    name: el.querySelector('.name')?.textContent?.trim() ?? '',
    quantity: parseInt(el.querySelector('.quantity')?.textContent ?? '1', 10),
    unitPrice: parsePrice(el.querySelector('.price')?.textContent),
  }));
  return {
    platform: PLATFORM.JUST_EAT,
    restaurantName: doc.querySelector('.restaurant-name')?.textContent?.trim() ?? '',
    postcode: doc.querySelector('.postcode')?.textContent?.trim() ?? '',
    items,
    deliveryFee: parsePrice(doc.querySelector('.delivery-fee')?.textContent),
    serviceFee: parsePrice(doc.querySelector('.service-fee')?.textContent),
    discounts: [],
  };
}

function extractOrder(platform, doc) {
  if (platform === PLATFORM.UBER_EATS) return extractUberEats(doc);
  if (platform === PLATFORM.DELIVEROO) return extractDeliveroo(doc);
  if (platform === PLATFORM.JUST_EAT) return extractJustEat(doc);
  throw new Error(`Unsupported platform: ${platform}`);
}

// Browser entry point — not reached during Jest tests
if (typeof window !== 'undefined' && typeof chrome !== 'undefined') {
  const { browser } = require('../shared/constants');
  const platform = platformFromUrl(window.location.href);
  if (platform) {
    const order = extractOrder(platform, document);
    if (order.items.length > 0) {
      browser.storage.session.set({ currentOrder: order });
      browser.runtime.sendMessage({ type: MSG.ORDER_DETECTED, order });
      browser.action.setBadgeText({ text: '✓' });
      browser.action.setBadgeBackgroundColor({ color: '#22c55e' });
    }
  }
}

module.exports = { extractOrder };
```

- [ ] **Step 7: Run — expect all pass**

```bash
npm test -- tests/checkout-reader.test.js
```

Expected: 16 tests pass.

- [ ] **Step 8: Commit**

```bash
git add src/content/checkout-reader.js tests/checkout-reader.test.js tests/fixtures/
git commit -m "feat: checkout DOM reader for Uber Eats, Deliveroo, Just Eat (TDD)"
```

---

### Task 6: Platform scraper

**Files:**
- Modify: `src/content/platform-scraper.js`

Injected into background tabs with `world: 'MAIN'`, giving access to `window.fetch` and `XMLHttpRequest`. Patches both to capture JSON responses, classifies them, and posts structured data to the service worker.

Correctness is verified during end-to-end testing in Task 10 — real API shapes will differ from fixtures.

- [ ] **Step 1: Implement `src/content/platform-scraper.js`**

```js
const { PLATFORM, MSG, platformFromUrl } = require('../shared/constants');
const { classifyResponse, parseMenuResponse } = require('../shared/parsers');

const platform = platformFromUrl(window.location.href);
if (!platform) throw new Error('FeedMe: scraper loaded on unsupported URL');

function handleJson(url, data) {
  if (!data || typeof data !== 'object') return;
  const classification = classifyResponse(platform, data);
  if (!classification) return;
  let parsed;
  try {
    parsed = parseMenuResponse(platform, data);
  } catch (_) {
    return;
  }
  chrome.runtime.sendMessage({ type: MSG.PLATFORM_DATA, platform, classification, parsed, sourceUrl: url });
}

// Patch fetch
const _fetch = window.fetch.bind(window);
window.fetch = async function (...args) {
  const response = await _fetch(...args);
  const url = typeof args[0] === 'string' ? args[0] : (args[0]?.url ?? '');
  response.clone().json().then((data) => handleJson(url, data)).catch(() => {});
  return response;
};

// Patch XHR
const _xhrOpen = XMLHttpRequest.prototype.open;
const _xhrSend = XMLHttpRequest.prototype.send;
XMLHttpRequest.prototype.open = function (method, url) {
  this._feedmeUrl = url;
  return _xhrOpen.apply(this, arguments);
};
XMLHttpRequest.prototype.send = function () {
  this.addEventListener('load', () => {
    try { handleJson(this._feedmeUrl ?? '', JSON.parse(this.responseText)); } catch (_) {}
  });
  return _xhrSend.apply(this, arguments);
};
```

- [ ] **Step 2: Build to verify no syntax errors**

```bash
npm run build
```

Expected: clean build.

- [ ] **Step 3: Commit**

```bash
git add src/content/platform-scraper.js
git commit -m "feat: fetch/XHR interceptor for background comparison tabs"
```

---

### Task 7: Popup script

**Files:**
- Create: `src/popup.js`

Checks session storage for a stored order. Shows the restaurant name and "Compare prices" button if found, otherwise shows help text. Sends `START_COMPARISON` to the service worker when the button is clicked.

- [ ] **Step 1: Implement `src/popup.js`**

```js
const { MSG, browser } = require('./shared/constants');

async function init() {
  const stored = await browser.storage.session.get('currentOrder');
  const order = stored.currentOrder;

  if (order && order.items.length > 0) {
    document.getElementById('state-idle').classList.add('hidden');
    document.getElementById('state-ready').classList.remove('hidden');

    // Use textContent to safely insert restaurant name from external data
    document.getElementById('restaurant-name').textContent = order.restaurantName;
    document.getElementById('item-count').textContent =
      `${order.items.length} item${order.items.length !== 1 ? 's' : ''} · ${order.postcode}`;

    document.getElementById('compare-btn').addEventListener('click', async () => {
      const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
      await browser.runtime.sendMessage({ type: MSG.START_COMPARISON, tabId: tab.id });
      window.close();
    });
  }
}

init();
```

- [ ] **Step 2: Build and verify**

```bash
npm run build
```

Expected: `dist/popup.js` built, no errors.

- [ ] **Step 3: Commit**

```bash
git add src/popup.js
git commit -m "feat: popup script — shows order summary or help, triggers comparison"
```

---

### Task 8: Background service worker

**Files:**
- Modify: `src/background/service-worker.js`

- [ ] **Step 1: Implement `src/background/service-worker.js`**

```js
const { PLATFORM, MSG, SCRAPER_TIMEOUT_MS, buildSearchUrl, browser } = require('../shared/constants');
const { matchItems, computeTotal } = require('../shared/matcher');

// Keyed by source tabId — tracks in-flight comparisons
const comparisons = new Map();

// Set badge when checkout-reader detects an order
browser.runtime.onMessage.addListener((msg, sender) => {
  if (msg.type !== MSG.ORDER_DETECTED) return;
  browser.action.setBadgeText({ text: '✓', tabId: sender.tab?.id });
  browser.action.setBadgeBackgroundColor({ color: '#22c55e', tabId: sender.tab?.id });
});

// Start comparison when popup sends START_COMPARISON
browser.runtime.onMessage.addListener(async (msg) => {
  if (msg.type !== MSG.START_COMPARISON) return;

  const stored = await browser.storage.session.get('currentOrder');
  const order = stored.currentOrder;
  if (!order || order.items.length === 0) return;

  const tabId = msg.tabId;

  await browser.scripting.executeScript({ target: { tabId }, files: ['dist/sidebar.js'] });

  const allPlatforms = [PLATFORM.UBER_EATS, PLATFORM.DELIVEROO, PLATFORM.JUST_EAT];
  const comparisonPlatforms = allPlatforms.filter((p) => p !== order.platform);

  const comparison = { sourceTabId: tabId, order, results: {}, tabs: {}, timeouts: {} };
  comparisons.set(tabId, comparison);

  for (const platform of comparisonPlatforms) {
    const url = buildSearchUrl(platform, order.restaurantName, order.postcode);
    if (!url) {
      finalisePlatform(tabId, platform, { error: 'no-search-url' });
      continue;
    }

    const bgTab = await browser.tabs.create({ url, active: false });
    comparison.tabs[platform] = bgTab.id;

    comparison.timeouts[platform] = setTimeout(
      () => finalisePlatform(tabId, platform, { error: 'timeout' }),
      SCRAPER_TIMEOUT_MS
    );

    browser.tabs.onUpdated.addListener(async function listener(updatedTabId, info) {
      if (updatedTabId !== bgTab.id || info.status !== 'complete') return;
      browser.tabs.onUpdated.removeListener(listener);
      await browser.scripting.executeScript({
        target: { tabId: bgTab.id },
        files: ['dist/platform-scraper.js'],
        world: 'MAIN',
      });
    });
  }
});

// Receive data from platform-scraper in background tabs
browser.runtime.onMessage.addListener((msg, sender) => {
  if (msg.type !== MSG.PLATFORM_DATA) return;

  for (const [sourceTabId, comparison] of comparisons) {
    if (comparison.tabs[msg.platform] !== sender.tab?.id) continue;

    clearTimeout(comparison.timeouts[msg.platform]);
    browser.tabs.remove(sender.tab.id).catch(() => {});

    const matches = matchItems(comparison.order.items, msg.parsed.items);
    const total = computeTotal(
      matches,
      msg.parsed.deliveryFee,
      msg.parsed.serviceFee,
      msg.parsed.offers ?? []
    );

    finalisePlatform(sourceTabId, msg.platform, {
      restaurantName: msg.parsed.restaurantName,
      matches,
      total,
      offers: msg.parsed.offers ?? [],
    });
    break;
  }
});

function finalisePlatform(sourceTabId, platform, result) {
  const comparison = comparisons.get(sourceTabId);
  if (!comparison) return;

  comparison.results[platform] = result;

  const done = Object.keys(comparison.tabs).every((p) => comparison.results[p] !== undefined);
  if (!done) return;

  browser.tabs.sendMessage(sourceTabId, {
    type: MSG.COMPARISON_RESULT,
    order: comparison.order,
    results: comparison.results,
  });
  comparisons.delete(sourceTabId);
}
```

- [ ] **Step 2: Build to verify**

```bash
npm run build
```

Expected: clean build.

- [ ] **Step 3: Commit**

```bash
git add src/background/service-worker.js
git commit -m "feat: background service worker — tab lifecycle and message routing"
```

---

### Task 9: Sidebar UI

**Files:**
- Modify: `src/content/sidebar.js`

Injected into the checkout tab. Creates a Shadow DOM host, renders a loading state, and renders comparison results. All user-controlled strings (restaurant names, item names, offer text from platform APIs) are inserted via `textContent` or escaped before DOM insertion to prevent XSS.

- [ ] **Step 1: Implement `src/content/sidebar.js`**

```js
const { MSG, PLATFORM, buildSearchUrl, browser } = require('../shared/constants');

// Prevent double-injection on re-click
if (document.getElementById('feedme-root')) return;

const LABEL = {
  [PLATFORM.UBER_EATS]: { emoji: '🟠', name: 'Uber Eats' },
  [PLATFORM.DELIVEROO]: { emoji: '🔵', name: 'Deliveroo' },
  [PLATFORM.JUST_EAT]: { emoji: '🟣', name: 'Just Eat' },
};

// Escape user-controlled strings before inserting into innerHTML
function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const host = document.createElement('div');
host.id = 'feedme-root';
host.style.cssText = 'position:fixed;top:0;right:0;width:400px;height:100vh;z-index:2147483647;pointer-events:auto;';
document.body.appendChild(host);

const shadow = host.attachShadow({ mode: 'open' });

const styleEl = document.createElement('style');
styleEl.textContent = `
* { box-sizing: border-box; margin: 0; padding: 0; }
#bar { width:400px; height:100vh; background:#fff; border-left:1px solid #e5e7eb;
  display:flex; flex-direction:column;
  font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
  box-shadow:-4px 0 20px rgba(0,0,0,.08); }
.hd { padding:12px 14px; border-bottom:1px solid #e5e7eb; display:flex; align-items:center; gap:10px; }
.logo { font-size:15px; font-weight:800; color:#111; }
.logo .accent { color:#f97316; }
.meta { flex:1; font-size:11px; color:#6b7280; }
.meta .mname { display:block; font-size:12px; font-weight:600; color:#374151; }
.cls { color:#9ca3af; font-size:16px; cursor:pointer; background:none; border:none; padding:2px 6px; }
.bd { flex:1; overflow-y:auto; padding:10px 12px; display:flex; flex-direction:column; gap:10px; }
.loading { display:flex; align-items:center; justify-content:center; flex:1; gap:8px;
  color:#9ca3af; font-size:13px; flex-direction:column; }
.spin { width:24px; height:24px; border:2px solid #e5e7eb; border-top-color:#f97316;
  border-radius:50%; animation:sp .8s linear infinite; }
@keyframes sp { to { transform:rotate(360deg); } }
.card { border:1px solid #e5e7eb; border-radius:10px; overflow:hidden; }
.card.win { border:2px solid #22c55e; }
.card.cur { background:#fafafa; }
.ch { padding:10px 12px; display:flex; align-items:center; gap:8px; background:#fafafa;
  border-bottom:1px solid #e5e7eb; }
.card.win .ch { background:#f0fdf4; }
.pname { font-size:12px; font-weight:700; flex:1; display:flex; align-items:center; gap:6px; }
.wb { background:#22c55e; color:#fff; font-size:8px; font-weight:800; padding:2px 6px; border-radius:8px; }
.cb { background:#f3f4f6; color:#6b7280; font-size:8px; font-weight:700; padding:2px 6px; border-radius:8px; }
.ptotal { font-size:18px; font-weight:800; color:#111; }
.card.win .ptotal { color:#16a34a; }
.cbody { padding:8px 12px; display:flex; flex-direction:column; gap:3px; }
.row { display:flex; justify-content:space-between; font-size:11px; color:#6b7280; padding:2px 0; }
.row.b { color:#374151; font-weight:600; border-top:1px solid #e5e7eb; padding-top:4px; margin-top:2px; }
.row.g { color:#16a34a; }
.row.r { color:#ef4444; }
.off { margin:0 12px 10px; background:#f0fdf4; border:1px solid #bbf7d0;
  border-radius:6px; padding:5px 8px; font-size:10px; color:#15803d; }
.off.n { background:#fafafa; border-color:#e5e7eb; color:#9ca3af; }
.obtn { margin:0 12px 12px; background:#f3f4f6; color:#374151; border:none;
  border-radius:7px; padding:9px; font-size:11px; font-weight:700; cursor:pointer;
  width:calc(100% - 24px); }
.obtn:hover { background:#e5e7eb; }
.ft { border-top:2px solid #dcfce7; background:#f0fdf4; padding:10px 14px; font-size:12px; color:#15803d; }
.ft .save { font-weight:700; color:#166534; }
.ft.sw { background:#fff7ed; border-top-color:#fed7aa; color:#c2410c; }
.ft.sw .save { color:#7c2d12; }
.cv { font-size:10px; color:#6b7280; margin-top:3px; }
.errc { border:1px solid #fecaca; border-radius:10px; padding:12px; font-size:12px; color:#ef4444; }
`;

const bar = document.createElement('div');
bar.id = 'bar';

const hd = document.createElement('div');
hd.className = 'hd';

const logoEl = document.createElement('div');
logoEl.className = 'logo';
logoEl.textContent = 'feed';
const accentSpan = document.createElement('span');
accentSpan.className = 'accent';
accentSpan.textContent = 'me';
logoEl.appendChild(accentSpan);

const metaEl = document.createElement('div');
metaEl.className = 'meta';
const mname = document.createElement('span');
mname.className = 'mname';
mname.textContent = 'Finding prices...';
metaEl.appendChild(mname);

const clsBtn = document.createElement('button');
clsBtn.className = 'cls';
clsBtn.textContent = '✕';
clsBtn.addEventListener('click', () => host.remove());

hd.appendChild(logoEl);
hd.appendChild(metaEl);
hd.appendChild(clsBtn);

const bd = document.createElement('div');
bd.className = 'bd';
bd.id = 'bd';

const loadingDiv = document.createElement('div');
loadingDiv.className = 'loading';
const spinDiv = document.createElement('div');
spinDiv.className = 'spin';
const loadingText = document.createTextNode('Fetching prices from other platforms...');
loadingDiv.appendChild(spinDiv);
loadingDiv.appendChild(loadingText);
bd.appendChild(loadingDiv);

bar.appendChild(hd);
bar.appendChild(bd);
shadow.appendChild(styleEl);
shadow.appendChild(bar);

const fmt = (n) => `£${Number(n).toFixed(2)}`;

function buildCard(platform, result, order, isCurrent, isWinner) {
  const { emoji, name } = LABEL[platform];
  const card = document.createElement('div');
  card.className = `card${isWinner ? ' win' : ''}${isCurrent ? ' cur' : ''}`;

  if (result.error) {
    const ch = document.createElement('div');
    ch.className = 'ch';
    const pname = document.createElement('div');
    pname.className = 'pname';
    pname.textContent = `${emoji} ${name}`;
    ch.appendChild(pname);
    const errc = document.createElement('div');
    errc.className = 'errc';
    errc.textContent = `Could not load (${result.error})`;
    card.appendChild(ch);
    card.appendChild(errc);
    return card;
  }

  const { matches, total, offers } = result;
  const caveated = total.matchedCount < total.totalCount;

  // Card header
  const ch = document.createElement('div');
  ch.className = 'ch';
  const pname = document.createElement('div');
  pname.className = 'pname';
  pname.textContent = `${emoji} ${name} `;
  if (isWinner) {
    const wb = document.createElement('span');
    wb.className = 'wb';
    wb.textContent = 'CHEAPEST';
    pname.appendChild(wb);
  }
  if (isCurrent) {
    const cb = document.createElement('span');
    cb.className = 'cb';
    cb.textContent = 'current';
    pname.appendChild(cb);
  }
  const ptotal = document.createElement('span');
  ptotal.className = 'ptotal';
  ptotal.textContent = fmt(total.total);
  ch.appendChild(pname);
  ch.appendChild(ptotal);
  card.appendChild(ch);

  // Card body — item rows
  const cbody = document.createElement('div');
  cbody.className = 'cbody';

  matches.forEach((m) => {
    const row = document.createElement('div');
    row.className = `row${m.matched ? '' : ' r'}`;
    const nameSpan = document.createElement('span');
    const priceSpan = document.createElement('span');
    if (m.matched) {
      nameSpan.textContent = `${m.referenceItem.name} ×${m.referenceItem.quantity}`;
      priceSpan.textContent = fmt(m.platformItem.unitPrice * m.referenceItem.quantity);
    } else {
      nameSpan.textContent = `⚠ ${m.referenceItem.name} — not found`;
      priceSpan.textContent = '—';
    }
    row.appendChild(nameSpan);
    row.appendChild(priceSpan);
    cbody.appendChild(row);
  });

  const addRow = (label, value, cls = '') => {
    const row = document.createElement('div');
    row.className = `row b${cls ? ' ' + cls : ''}`;
    const l = document.createElement('span');
    l.textContent = label;
    const v = document.createElement('span');
    v.textContent = value;
    row.appendChild(l);
    row.appendChild(v);
    cbody.appendChild(row);
  };

  addRow('Subtotal', fmt(total.itemsTotal));
  addRow('Delivery', fmt(total.deliveryFee), '');
  addRow('Service fee', fmt(total.serviceFee), '');
  if (total.discountTotal > 0) {
    const drow = document.createElement('div');
    drow.className = 'row g';
    const dl = document.createElement('span');
    dl.textContent = 'Discounts';
    const dv = document.createElement('span');
    dv.textContent = `-${fmt(total.discountTotal)}`;
    drow.appendChild(dl);
    drow.appendChild(dv);
    cbody.appendChild(drow);
  }
  addRow(`Total${caveated ? ` (${total.matchedCount}/${total.totalCount})` : ''}`, fmt(total.total));
  card.appendChild(cbody);

  // Offer tags — text from platform API, use textContent
  if (offers.length > 0) {
    offers.forEach((o) => {
      const offEl = document.createElement('div');
      offEl.className = 'off';
      offEl.textContent = `🏷 ${o.description}`;
      card.appendChild(offEl);
    });
  } else {
    const noOff = document.createElement('div');
    noOff.className = 'off n';
    noOff.textContent = '— No current offers';
    card.appendChild(noOff);
  }

  // Open in X button
  if (!isCurrent) {
    const btn = document.createElement('button');
    btn.className = 'obtn';
    btn.textContent = `Open in ${name} →`;
    btn.addEventListener('click', () => {
      const url = buildSearchUrl(platform, order.restaurantName, order.postcode);
      if (url) window.open(url, '_blank');
    });
    card.appendChild(btn);
  }

  return card;
}

browser.runtime.onMessage.addListener((msg) => {
  if (msg.type !== MSG.COMPARISON_RESULT) return;
  const { order, results } = msg;

  // Update header — textContent for user-controlled data
  mname.textContent = order.restaurantName;
  metaEl.appendChild(document.createTextNode(`${order.items.length} items · ${order.postcode}`));

  const currentTotal =
    order.items.reduce((s, i) => s + i.unitPrice * i.quantity, 0) +
    order.deliveryFee +
    order.serviceFee -
    order.discounts.reduce((s, d) => s + d.amount, 0);

  const compPlatforms = Object.keys(results).filter((p) => p !== order.platform);
  compPlatforms.sort((a, b) => {
    if (results[a].error) return 1;
    if (results[b].error) return -1;
    return results[a].total.total - results[b].total.total;
  });

  const cheapest = compPlatforms.find((p) => !results[p].error);
  const winner = cheapest && results[cheapest].total.total < currentTotal ? cheapest : order.platform;

  bd.textContent = '';

  compPlatforms.forEach((p) => {
    bd.appendChild(buildCard(p, results[p], order, false, winner === p));
  });

  // Synthesise a card for the current platform
  const currentResult = {
    matches: order.items.map((i) => ({ referenceItem: i, platformItem: i, matched: true })),
    total: {
      itemsTotal: order.items.reduce((s, i) => s + i.unitPrice * i.quantity, 0),
      deliveryFee: order.deliveryFee,
      serviceFee: order.serviceFee,
      discountTotal: order.discounts.reduce((s, d) => s + d.amount, 0),
      total: currentTotal,
      matchedCount: order.items.length,
      totalCount: order.items.length,
    },
    offers: order.discounts.map((d) => ({ description: d.label })),
  };
  bd.appendChild(buildCard(order.platform, currentResult, order, true, winner === order.platform));

  // Footer
  const ft = document.createElement('div');
  const caveated = compPlatforms.some(
    (p) => !results[p].error && results[p].total.matchedCount < results[p].total.totalCount
  );

  if (winner !== order.platform && cheapest) {
    ft.className = 'ft sw';
    ft.textContent = 'Switch to ';
    const saveSpan = document.createElement('span');
    saveSpan.className = 'save';
    saveSpan.textContent = LABEL[cheapest].name;
    const saving = (currentTotal - results[cheapest].total.total).toFixed(2);
    ft.appendChild(saveSpan);
    ft.appendChild(document.createTextNode(` to save `));
    const saveAmt = document.createElement('span');
    saveAmt.className = 'save';
    saveAmt.textContent = `£${saving}`;
    ft.appendChild(saveAmt);
  } else {
    ft.className = 'ft';
    ft.textContent = '✅ You’re already on the cheapest platform';
  }

  if (caveated) {
    const cv = document.createElement('div');
    cv.className = 'cv';
    cv.textContent = '* Some items could not be matched — totals may be incomplete';
    ft.appendChild(cv);
  }

  bar.appendChild(ft);
});
```

- [ ] **Step 2: Build to verify**

```bash
npm run build
```

Expected: clean build.

- [ ] **Step 3: Run all tests**

```bash
npm test
```

Expected: all tests still pass.

- [ ] **Step 4: Commit**

```bash
git add src/content/sidebar.js
git commit -m "feat: sidebar Shadow DOM — loading state, comparison cards, footer"
```

---

### Task 10: End-to-end integration and smoke test

> **This is where real platform-specific tuning happens.** Fixtures and selectors will need updating to match real DOM/API shapes — budget time accordingly.

- [ ] **Step 1: Build the extension**

```bash
npm run build
```

- [ ] **Step 2: Load unpacked in Chrome**

1. Open `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked** and select the `feedme/` root directory
4. Confirm "FeedMe" appears with no error badge

- [ ] **Step 3: Load in Firefox**

```bash
npx web-ext run --source-dir . --target firefox-desktop
```

Or: `about:debugging` > This Firefox > Load Temporary Add-on > select `manifest.json`.

- [ ] **Step 4: Verify checkout reading — Uber Eats**

1. Navigate to `ubereats.com`, add 2-3 items, proceed to checkout
2. Click the FeedMe extension icon — it should show the restaurant name and item count
3. If it shows "Go to a checkout page..." instead:
   - Open DevTools on the checkout page and inspect the DOM
   - Find the actual selectors for restaurant name, item rows, quantity, price, fees
   - Update `tests/fixtures/ubereats-checkout.html` to match the real structure
   - Update `extractUberEats()` in `src/content/checkout-reader.js`
   - Run `npm test -- tests/checkout-reader.test.js` and confirm pass
   - Run `npm run build`, reload the extension, and retry

- [ ] **Step 5: Verify checkout reading — Deliveroo and Just Eat**

Repeat Step 4 for Deliveroo and Just Eat, updating `extractDeliveroo()` and `extractJustEat()` with real selectors. Run `npm test` after each fix.

- [ ] **Step 6: Verify platform scraper — capture real API shapes**

1. With an order detected on the Uber Eats checkout, click "Compare prices" in the popup
2. Open `chrome://extensions` > FeedMe > Service Worker > DevTools console
3. If a platform times out:
   - Open a new tab for that platform, navigate to a restaurant menu page
   - In DevTools Network > Fetch/XHR, find the response containing the menu item list
   - Copy the response body to `tests/fixtures/<platform>-menu.json`
   - Update `classifyResponse()` and the relevant `parse*()` function in `src/shared/parsers.js`
   - Run `npm test -- tests/parsers.test.js` and confirm pass
   - Rebuild and retry

- [ ] **Step 7: Full flow test — all three starting platforms**

For each starting platform (Uber Eats, Deliveroo, Just Eat):
1. Build an order and go to checkout
2. Click the FeedMe popup, then "Compare prices"
3. Confirm the sidebar appears in loading state within 1 second
4. Confirm all comparison cards populate within 15 seconds
5. Confirm the cheapest platform is highlighted with a green border and "CHEAPEST" badge
6. Confirm "Open in X" opens the correct platform in a new tab
7. Confirm unmatched items show a warning and the total is caveated

- [ ] **Step 8: Final commit**

```bash
npm test
npm run build
git add -A
git commit -m "chore: end-to-end verified, real platform fixtures and selectors updated"
```
