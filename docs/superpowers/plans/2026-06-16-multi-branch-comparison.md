# Multi-branch Comparison Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace single-branch fuzzy matching with: for every platform, find the nearest N branches of the chain, price the user's order at each, and stack them per platform with the cheapest highlighted.

**Architecture:** A per-platform *enumerator* pass extracts the nearest-N branch menu URLs; the service worker fans those out to *menu* scrapes through a bounded-concurrency pool, correlating background tabs to branches by tab id. Pure, independently-tested modules hold the logic that can run without a browser — branch selection, the pool scheduler, and the render snapshot — while the scrapers, service worker, and sidebar wire them to the page and are verified live.

**Tech Stack:** Vanilla JS (CommonJS source bundled by esbuild to IIFE in `dist/`), `fuse.js` for fuzzy matching, `webextension-polyfill`, Jest + jsdom for tests, Manifest V3 extension (Chrome/Firefox).

## Global Constraints

- Source files are CommonJS (`require`/`module.exports`); they are bundled by `esbuild.config.mjs` into `dist/` and also `require()`d directly by Jest. Never add ESM `import`/`export` to `src/`.
- Every new bundled entry point (a file injected as `dist/<name>.js`) MUST be added to `entryPoints` in `esbuild.config.mjs`.
- Tests live in `tests/**/*.test.js`, run with `npm test` (jsdom env). Fixtures live in `tests/fixtures/*.json`.
- Default branch count is **3**; default pool concurrency is **4**. Both read from `storage.local` with those defaults; no popup UI for them in this build.
- "Cheapest" (per column or global) only ever considers a branch whose match is **complete** — `total.matchedCount === total.totalCount`.
- Money is handled in pounds (numbers); platform raw data is in pence and divided by 100 at parse time (already done by existing parsers — do not double-divide).
- Do not modify `parseUberEats` / `parseDeliveroo` / `parseJustEat` menu-field parsing.
- Commit after every task. Branch is `fix/comparison-scrapers-and-options` (already checked out); do not switch to `main`.

---

## File Structure

**New files:**
- `src/shared/branches.js` — pure branch selection + Just Eat candidate extraction + shared `findByKey`.
- `src/shared/pool.js` — pure bounded-concurrency scheduler.
- `src/shared/snapshot.js` — pure render-snapshot builder (per-column cheapest + footer).
- `src/content/uber-scraper.js` — new Uber enumerator (feed → store URLs).
- `tests/branches.test.js`, `tests/pool.test.js`, `tests/snapshot.test.js` — unit tests.
- `tests/fixtures/just-eat-listing.json` — synthetic `__NEXT_DATA__`-shaped listing fixture.

**Modified files:**
- `src/shared/constants.js` — new MSG types, config defaults + `getConfig`.
- `src/content/just-eat-scraper.js` — split into enumerate / menu modes; use shared `findByKey` + `justEatCandidates`.
- `src/content/deliveroo-scraper.js` — split into enumerate / menu modes.
- `src/background/service-worker.js` — orchestration rewrite (enumerate → pool → progressive snapshots).
- `src/content/sidebar.js` — Layout A progressive rendering from snapshots.
- `esbuild.config.mjs` — add `uber-scraper` entry point.
- `manifest.json` — no new content_scripts; confirm host permissions cover Uber feed/store (already `*://www.ubereats.com/*`).

---

## Task 1: Message types and config

**Files:**
- Modify: `src/shared/constants.js`
- Test: `tests/constants.test.js` (create)

**Interfaces:**
- Produces: `MSG.BRANCHES_FOUND`, `MSG.COMPARISON_UPDATE`; `DEFAULT_BRANCH_COUNT = 3`, `DEFAULT_MAX_CONCURRENT = 4`; `async getConfig()` → `{ branchCount: number, maxConcurrent: number }`.

- [ ] **Step 1: Write the failing test**

```js
// tests/constants.test.js
const { MSG, DEFAULT_BRANCH_COUNT, DEFAULT_MAX_CONCURRENT, getConfig } = require('../src/shared/constants');

describe('constants', () => {
  test('exposes new message types', () => {
    expect(MSG.BRANCHES_FOUND).toBe('BRANCHES_FOUND');
    expect(MSG.COMPARISON_UPDATE).toBe('COMPARISON_UPDATE');
  });
  test('exposes config defaults', () => {
    expect(DEFAULT_BRANCH_COUNT).toBe(3);
    expect(DEFAULT_MAX_CONCURRENT).toBe(4);
  });
  test('getConfig falls back to defaults when storage is unavailable', async () => {
    const cfg = await getConfig();
    expect(cfg).toEqual({ branchCount: 3, maxConcurrent: 4 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- constants`
Expected: FAIL (`MSG.BRANCHES_FOUND` undefined / `getConfig` is not a function).

- [ ] **Step 3: Implement**

In `src/shared/constants.js`, add to the `MSG` object:

```js
  BRANCHES_FOUND: 'BRANCHES_FOUND',       // enumerator -> service-worker
  COMPARISON_UPDATE: 'COMPARISON_UPDATE', // service-worker -> sidebar (progressive)
```

After `const FUSE_THRESHOLD = 0.4;` add:

```js
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
```

Add `DEFAULT_BRANCH_COUNT`, `DEFAULT_MAX_CONCURRENT`, `getConfig` to `module.exports`. (Note: in Jest `browser` is `null`, so `browser.storage` throws and the `catch` returns defaults — this is what the third test exercises.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- constants`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/shared/constants.js tests/constants.test.js
git commit -m "feat: branch message types and config defaults"
```

---

## Task 2: Pure branch selection

**Files:**
- Create: `src/shared/branches.js`
- Test: `tests/branches.test.js` (create)

**Interfaces:**
- Produces:
  - `findByKey(obj, key, depth?)` → first nested object value under `key`, or `null`.
  - `selectNearestBranches(candidates, targetName, n)` where `candidates: Array<{id, name, label, distance, menuUrl}>` → up to `n` candidates that fuzzy-match `targetName`, de-duped by `id`, sorted by ascending `distance` (null/undefined distance sorts last).

- [ ] **Step 1: Write the failing test**

```js
// tests/branches.test.js
const { findByKey, selectNearestBranches } = require('../src/shared/branches');

const candidates = [
  { id: 'bk-cw',  name: 'Burger King', label: 'Canary Wharf', distance: 1.8, menuUrl: '/restaurants-bk-cw/menu' },
  { id: 'bk-wc',  name: 'Burger King', label: 'Whitechapel',  distance: 0.4, menuUrl: '/restaurants-bk-wc/menu' },
  { id: 'bk-al',  name: 'Burger King', label: 'Aldgate',      distance: 0.9, menuUrl: '/restaurants-bk-al/menu' },
  { id: 'kfc-al', name: 'KFC',          label: 'Aldgate',      distance: 0.3, menuUrl: '/restaurants-kfc-al/menu' },
];

describe('findByKey', () => {
  test('finds a nested object by key', () => {
    expect(findByKey({ a: { b: { restaurantData: { x: 1 } } } }, 'restaurantData')).toEqual({ x: 1 });
  });
  test('returns null when absent', () => {
    expect(findByKey({ a: 1 }, 'missing')).toBeNull();
  });
});

describe('selectNearestBranches', () => {
  test('returns the nearest N of the matching chain, sorted by distance', () => {
    const out = selectNearestBranches(candidates, 'Burger King', 2);
    expect(out.map((b) => b.id)).toEqual(['bk-wc', 'bk-al']);
  });
  test('excludes other chains', () => {
    const out = selectNearestBranches(candidates, 'Burger King', 5);
    expect(out.every((b) => b.name === 'Burger King')).toBe(true);
  });
  test('independent restaurant: a single match yields exactly one branch', () => {
    const solo = [{ id: 'pizza-1', name: 'Tony\'s Pizza', label: '', distance: 0.5, menuUrl: '/r/menu' }];
    const out = selectNearestBranches(solo, 'Tonys Pizza', 3);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('pizza-1');
  });
  test('empty target name yields no branches', () => {
    expect(selectNearestBranches(candidates, '', 3)).toEqual([]);
  });
  test('de-dupes by id', () => {
    const dup = [...candidates, { ...candidates[1] }];
    const out = selectNearestBranches(dup, 'Burger King', 5);
    expect(out.filter((b) => b.id === 'bk-wc')).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- branches`
Expected: FAIL (`Cannot find module '../src/shared/branches'`).

- [ ] **Step 3: Implement**

```js
// src/shared/branches.js
const Fuse = require('fuse.js');

const FUSE_THRESHOLD = 0.4;

// Recursively locate a named property (some platform blobs nest the data at a
// deep, version-dependent path). Shared by the Just Eat scraper and candidate
// extraction.
function findByKey(obj, key, depth = 0) {
  if (depth > 12 || !obj || typeof obj !== 'object') return null;
  if (obj[key] && typeof obj[key] === 'object') return obj[key];
  for (const k of Object.keys(obj)) {
    const found = findByKey(obj[k], key, depth + 1);
    if (found) return found;
  }
  return null;
}

/**
 * From a platform's branch candidates, keep those that fuzzy-match the chain
 * name, de-dupe by id, sort by ascending distance, and take the nearest n.
 * A single independent restaurant is the degenerate case: one match in, one out.
 * @param {Array<{id:string,name:string,label:string,distance:?number,menuUrl:string}>} candidates
 * @param {string} targetName
 * @param {number} n
 */
function selectNearestBranches(candidates, targetName, n) {
  if (!targetName) return [];
  const fuse = new Fuse(candidates, { keys: ['name'], threshold: FUSE_THRESHOLD });
  const matched = fuse.search(targetName).map((r) => r.item);
  const seen = new Set();
  const unique = [];
  for (const c of matched) {
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    unique.push(c);
  }
  unique.sort((a, b) => (a.distance ?? Infinity) - (b.distance ?? Infinity));
  return unique.slice(0, n);
}

module.exports = { findByKey, selectNearestBranches };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- branches`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/shared/branches.js tests/branches.test.js
git commit -m "feat: pure nearest-N branch selection"
```

---

## Task 3: Just Eat candidate extraction

**Files:**
- Modify: `src/shared/branches.js`
- Create: `tests/fixtures/just-eat-listing.json`
- Test: `tests/branches.test.js` (extend)

**Interfaces:**
- Produces: `justEatCandidates(nextData)` → `Array<{id, name, label, distance, menuUrl}>` built from `restaurantData` in a Just Eat area-listing `__NEXT_DATA__` object.

> **Live-data note:** the field names below (`distanceInMiles`, `cuisineArea`) are the documented best guess. Task 11 confirms them against live `restaurantData`; if they differ, update both `justEatCandidates` and this fixture together so the test still pins real behaviour.

- [ ] **Step 1: Create the fixture**

```json
// tests/fixtures/just-eat-listing.json
{
  "props": {
    "initialState": {
      "restaurantData": {
        "bk-wc": { "uniqueName": "burger-king-whitechapel", "name": "Burger King - Whitechapel", "brandName": "Burger King", "distanceInMiles": 0.4, "cuisineArea": "Whitechapel" },
        "bk-al": { "uniqueName": "burger-king-aldgate", "name": "Burger King - Aldgate", "brandName": "Burger King", "distanceInMiles": 0.9, "cuisineArea": "Aldgate" },
        "kfc-al": { "uniqueName": "kfc-aldgate", "name": "KFC - Aldgate", "brandName": "KFC", "distanceInMiles": 0.3, "cuisineArea": "Aldgate" }
      }
    }
  }
}
```

- [ ] **Step 2: Write the failing test (append to tests/branches.test.js)**

```js
const { justEatCandidates } = require('../src/shared/branches');
const jeListing = require('./fixtures/just-eat-listing.json');

describe('justEatCandidates', () => {
  test('builds candidates from restaurantData', () => {
    const cands = justEatCandidates(jeListing);
    expect(cands).toHaveLength(3);
    const wc = cands.find((c) => c.id === 'burger-king-whitechapel');
    expect(wc.name).toBe('Burger King');
    expect(wc.label).toBe('Whitechapel');
    expect(wc.distance).toBeCloseTo(0.4);
    expect(wc.menuUrl).toBe('/restaurants-burger-king-whitechapel/menu');
  });
  test('matches end-to-end through selectNearestBranches', () => {
    const out = selectNearestBranches(justEatCandidates(jeListing), 'Burger King', 3);
    expect(out.map((b) => b.id)).toEqual(['burger-king-whitechapel', 'burger-king-aldgate']);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test -- branches`
Expected: FAIL (`justEatCandidates is not a function`).

- [ ] **Step 4: Implement (add to src/shared/branches.js, export it)**

```js
// Build branch candidates from a Just Eat area-listing __NEXT_DATA__ object.
// brandName is the chain ("Burger King"); name may carry the locality. The
// label prefers an explicit area field, falling back to the suffix of name.
function justEatCandidates(nextData) {
  const map = findByKey(nextData, 'restaurantData') || {};
  return Object.values(map)
    .filter((r) => r && r.uniqueName && r.name)
    .map((r) => ({
      id: r.uniqueName,
      name: r.brandName || r.name,
      label: r.cuisineArea || (r.name.includes(' - ') ? r.name.split(' - ').pop().trim() : ''),
      distance: typeof r.distanceInMiles === 'number' ? r.distanceInMiles : null,
      menuUrl: `/restaurants-${r.uniqueName}/menu`,
    }));
}
```

Add `justEatCandidates` to `module.exports`.

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- branches`
Expected: PASS (9 tests total).

- [ ] **Step 6: Commit**

```bash
git add src/shared/branches.js tests/branches.test.js tests/fixtures/just-eat-listing.json
git commit -m "feat: Just Eat branch candidate extraction"
```

---

## Task 4: Pure pool scheduler

**Files:**
- Create: `src/shared/pool.js`
- Test: `tests/pool.test.js` (create)

**Interfaces:**
- Produces: `createScheduler(maxConcurrent)` → `{ add(keys), take(), release(), pending }`.
  - `add(keys: string[])` appends keys to the queue.
  - `take()` returns the keys that may start now (up to remaining capacity), marking them active.
  - `release()` frees one active slot.
  - `pending` (getter) → number still queued or active.

- [ ] **Step 1: Write the failing test**

```js
// tests/pool.test.js
const { createScheduler } = require('../src/shared/pool');

describe('createScheduler', () => {
  test('take() respects the concurrency cap', () => {
    const s = createScheduler(2);
    s.add(['a', 'b', 'c', 'd']);
    expect(s.take()).toEqual(['a', 'b']);
    expect(s.take()).toEqual([]); // at capacity
  });
  test('release() frees a slot for the next key', () => {
    const s = createScheduler(2);
    s.add(['a', 'b', 'c']);
    s.take();          // a, b active
    s.release();       // a done
    expect(s.take()).toEqual(['c']);
  });
  test('pending counts queued + active until drained', () => {
    const s = createScheduler(1);
    s.add(['a', 'b']);
    expect(s.pending).toBe(2);
    s.take();             // a active, b queued
    expect(s.pending).toBe(2);
    s.release();          // a done -> 1 queued
    expect(s.pending).toBe(1);
    s.take(); s.release();
    expect(s.pending).toBe(0);
  });
  test('keys added after take() are scheduled on later takes', () => {
    const s = createScheduler(2);
    s.add(['a']);
    expect(s.take()).toEqual(['a']);
    s.add(['b', 'c']);
    expect(s.take()).toEqual(['b']); // one slot left (a still active)
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- pool`
Expected: FAIL (`Cannot find module '../src/shared/pool'`).

- [ ] **Step 3: Implement**

```js
// src/shared/pool.js
// A pure bounded-concurrency scheduler. The caller does the actual async work
// (opening tabs); this only tracks which keys may run now and how many are live.
function createScheduler(maxConcurrent) {
  const queue = [];
  let active = 0;
  return {
    add(keys) {
      for (const k of keys) queue.push(k);
    },
    take() {
      const out = [];
      while (active < maxConcurrent && queue.length) {
        out.push(queue.shift());
        active += 1;
      }
      return out;
    },
    release() {
      if (active > 0) active -= 1;
    },
    get pending() {
      return queue.length + active;
    },
  };
}

module.exports = { createScheduler };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- pool`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/shared/pool.js tests/pool.test.js
git commit -m "feat: pure bounded-concurrency scheduler"
```

---

## Task 5: Pure snapshot builder

**Files:**
- Create: `src/shared/snapshot.js`
- Test: `tests/snapshot.test.js` (create)

**Interfaces:**
- Consumes: branch records of shape
  `{ platform, key, label, distance, isCurrent, status: 'pending'|'done'|'error', result }`
  where a `done` result is `{ restaurantName, matches, total, offers }` (the shape `computeTotal` returns for `total`) and an `error` result is `{ error: string }`.
- Produces: `buildSnapshot(order, branches, loadingPlatforms)` →
  ```
  {
    platforms: [ { platform, spinner: boolean, cheapestKey: ?string,
                   branches: [ branchRecord... ] } ],
    footer: { kind: 'switch'|'best'|'unknown', platform?: string, label?: string, saving?: number },
    currentTotal: number,
  }
  ```
  - `loadingPlatforms: Set<string>` — platforms still enumerating/scraping; sets `spinner`.
  - Per platform, `cheapestKey` is the complete branch (`total.matchedCount === total.totalCount`) with the lowest `total.total`, or `null`.
  - `footer`: find the overall-cheapest complete branch across all platforms (including the current branch). If it is the current branch → `{ kind: 'best' }`. If cheaper than current → `{ kind: 'switch', platform, label, saving }`. If nothing complete yet → `{ kind: 'unknown' }`.

- [ ] **Step 1: Write the failing test**

```js
// tests/snapshot.test.js
const { buildSnapshot } = require('../src/shared/snapshot');
const { PLATFORM } = require('../src/shared/constants');

const order = { platform: PLATFORM.UBER_EATS, restaurantName: 'Burger King' };

const done = (total, matched = 3, count = 3) => ({
  status: 'done',
  result: { restaurantName: 'Burger King', matches: [], offers: [],
    total: { total, matchedCount: matched, totalCount: count } },
});

function branches() {
  return [
    { platform: PLATFORM.UBER_EATS, key: 'uber|cur', label: 'Whitechapel', distance: 0.4, isCurrent: true, ...done(11.79) },
    { platform: PLATFORM.DELIVEROO, key: 'del|wc', label: 'Whitechapel', distance: 0.4, isCurrent: false, ...done(11.40) },
    { platform: PLATFORM.DELIVEROO, key: 'del|al', label: 'Aldgate', distance: 0.9, isCurrent: false, ...done(12.30) },
    { platform: PLATFORM.JUST_EAT, key: 'je|al', label: 'Aldgate', distance: 0.9, isCurrent: false, ...done(12.05) },
  ];
}

describe('buildSnapshot', () => {
  test('picks the cheapest complete branch per platform', () => {
    const snap = buildSnapshot(order, branches(), new Set());
    const del = snap.platforms.find((p) => p.platform === PLATFORM.DELIVEROO);
    expect(del.cheapestKey).toBe('del|wc');
  });
  test('footer recommends switching to the overall cheapest with the saving', () => {
    const snap = buildSnapshot(order, branches(), new Set());
    expect(snap.footer.kind).toBe('switch');
    expect(snap.footer.platform).toBe(PLATFORM.DELIVEROO);
    expect(snap.footer.label).toBe('Whitechapel');
    expect(snap.footer.saving).toBeCloseTo(0.39);
    expect(snap.currentTotal).toBeCloseTo(11.79);
  });
  test('footer says best when the current branch is cheapest', () => {
    const only = [{ platform: PLATFORM.UBER_EATS, key: 'uber|cur', label: 'WC', distance: 0.4, isCurrent: true, ...done(9.99) }];
    expect(buildSnapshot(order, only, new Set()).footer.kind).toBe('best');
  });
  test('incomplete branches are never cheapest', () => {
    const b = [
      { platform: PLATFORM.UBER_EATS, key: 'uber|cur', label: 'WC', distance: 0.4, isCurrent: true, ...done(11.79) },
      { platform: PLATFORM.DELIVEROO, key: 'del|wc', label: 'WC', distance: 0.4, isCurrent: false, ...done(5.00, 2, 3) },
    ];
    const snap = buildSnapshot(order, b, new Set());
    expect(snap.platforms.find((p) => p.platform === PLATFORM.DELIVEROO).cheapestKey).toBeNull();
    expect(snap.footer.kind).toBe('best');
  });
  test('spinner set for platforms still loading; unknown footer with nothing complete', () => {
    const snap = buildSnapshot(order, [], new Set([PLATFORM.DELIVEROO]));
    const del = snap.platforms.find((p) => p.platform === PLATFORM.DELIVEROO);
    expect(del.spinner).toBe(true);
    expect(snap.footer.kind).toBe('unknown');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- snapshot`
Expected: FAIL (`Cannot find module '../src/shared/snapshot'`).

- [ ] **Step 3: Implement**

```js
// src/shared/snapshot.js
const { PLATFORM } = require('./constants');

const ORDER = [PLATFORM.UBER_EATS, PLATFORM.DELIVEROO, PLATFORM.JUST_EAT];

function isComplete(b) {
  return b.status === 'done' && b.result.total &&
    b.result.total.matchedCount === b.result.total.totalCount;
}

/**
 * Build the render snapshot the sidebar draws from.
 * @param {{platform:string}} order
 * @param {Array} branches  branch records (see Task 5 interface)
 * @param {Set<string>} loadingPlatforms
 */
function buildSnapshot(order, branches, loadingPlatforms) {
  const current = branches.find((b) => b.isCurrent);
  const currentTotal = current && current.status === 'done' ? current.result.total.total : Infinity;

  const platforms = ORDER.map((platform) => {
    const own = branches.filter((b) => b.platform === platform);
    let cheapestKey = null;
    let best = Infinity;
    for (const b of own) {
      if (!isComplete(b)) continue;
      if (b.result.total.total < best) {
        best = b.result.total.total;
        cheapestKey = b.key;
      }
    }
    return {
      platform,
      spinner: loadingPlatforms.has(platform),
      cheapestKey,
      branches: own,
    };
  });

  // Overall cheapest complete branch across everything, including the current one.
  let overall = null;
  for (const b of branches) {
    if (!isComplete(b)) continue;
    if (!overall || b.result.total.total < overall.result.total.total) overall = b;
  }

  let footer;
  if (!overall) {
    footer = { kind: 'unknown' };
  } else if (overall.isCurrent || overall.result.total.total >= currentTotal) {
    footer = { kind: 'best' };
  } else {
    footer = {
      kind: 'switch',
      platform: overall.platform,
      label: overall.label,
      saving: currentTotal - overall.result.total.total,
    };
  }

  return { platforms, footer, currentTotal: currentTotal === Infinity ? 0 : currentTotal };
}

module.exports = { buildSnapshot };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- snapshot`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/shared/snapshot.js tests/snapshot.test.js
git commit -m "feat: pure render-snapshot builder"
```

---

## Task 6: Just Eat scraper — enumerate / menu modes

**Files:**
- Modify: `src/content/just-eat-scraper.js`
- Verify: live (Task 11) — no Jest test (DOM/navigation driven).

**Interfaces:**
- Consumes: `window.__feedmeCompare = { mode: 'enumerate'|'menu', restaurantName, postcode, branchCount }`, `findByKey` + `justEatCandidates` + `selectNearestBranches` from `src/shared/branches.js`.
- Produces (messages to service worker):
  - enumerate mode: `{ type: MSG.BRANCHES_FOUND, platform: PLATFORM.JUST_EAT, branches: Array<{id,label,distance,menuUrl}> }` (or `{ ...BRANCHES_FOUND, branches: [] }` when no chain match).
  - menu mode: `{ type: MSG.PLATFORM_DATA, platform: PLATFORM.JUST_EAT, classification: 'menu', parsed, sourceUrl }`.

- [ ] **Step 1: Refactor to read mode and use shared helpers**

Replace the top of `src/content/just-eat-scraper.js` so it imports the shared helpers and removes the local `findByKey`:

```js
const { selectNearestBranches, justEatCandidates } = require('../shared/branches');
const { MSG, PLATFORM } = require('../shared/constants');
const { parseMenuResponse } = require('../shared/parsers');
```

Delete the local `findByKey` definition (now imported indirectly via `justEatCandidates`; the scraper no longer calls it directly).

- [ ] **Step 2: Rewrite PHASE 1 (listing) as enumerate mode**

Replace the `if (path.startsWith('/area/'))` block body with:

```js
  const ctx = window.__feedmeCompare ?? {};

  // ENUMERATE — area listing: report the nearest-N branches, do not navigate.
  if (path.startsWith('/area/')) {
    const blob = await waitFor(() => {
      const text = document.querySelector('#__NEXT_DATA__')?.textContent;
      return text && text.includes('restaurantData') ? text : null;
    });
    if (!blob) return;

    let branches = [];
    try {
      const data = JSON.parse(blob);
      branches = selectNearestBranches(justEatCandidates(data), ctx.restaurantName ?? '', ctx.branchCount ?? 3)
        .map(({ id, label, distance, menuUrl }) => ({ id, label, distance, menuUrl }));
    } catch (_) {}

    chrome.runtime.sendMessage({ type: MSG.BRANCHES_FOUND, platform: PLATFORM.JUST_EAT, branches });
    return;
  }
```

(The `reportNotFound` helper and the old Fuse import/usage are removed; an empty `branches` array is the "not found" signal the service worker handles.)

- [ ] **Step 3: Keep PHASE 2 (menu) as menu mode**

The existing `if (path.includes('/menu'))` block already fetches the dynamic/offers/CDN data, parses, and sends `MSG.PLATFORM_DATA`. Leave its body intact. It now runs because the service worker navigates a menu tab directly to the branch `menuUrl` and injects this script.

- [ ] **Step 4: Remove the now-unused `Fuse` and `reportNotFound`**

Delete `const Fuse = require('fuse.js');` and the `reportNotFound` function from this file. Confirm no other references remain:

Run: `grep -n "Fuse\|reportNotFound" src/content/just-eat-scraper.js`
Expected: no matches.

- [ ] **Step 5: Build to check it bundles**

Run: `npm run build`
Expected: esbuild completes with no errors; `dist/just-eat-scraper.js` updated.

- [ ] **Step 6: Commit**

```bash
git add src/content/just-eat-scraper.js
git commit -m "feat: Just Eat scraper enumerate/menu modes"
```

---

## Task 7: Deliveroo scraper — enumerate / menu modes

**Files:**
- Modify: `src/content/deliveroo-scraper.js`
- Verify: live (Task 11) — no Jest test.

**Interfaces:**
- Consumes: `window.__feedmeCompare = { mode, restaurantName, postcode, branchCount }`, `selectNearestBranches` from `src/shared/branches.js`.
- Produces:
  - enumerate: `{ type: MSG.BRANCHES_FOUND, platform: PLATFORM.DELIVEROO, branches: Array<{id,label,distance,menuUrl}> }`.
  - menu: `{ type: MSG.PLATFORM_DATA, platform: PLATFORM.DELIVEROO, classification: 'menu', parsed, sourceUrl }`.

- [ ] **Step 1: Swap the Fuse import for the shared selector**

At the top of `src/content/deliveroo-scraper.js` replace:

```js
const Fuse = require('fuse.js');
const { MSG, PLATFORM } = require('../shared/constants');
const { parseMenuResponse } = require('../shared/parsers');
```

with:

```js
const { selectNearestBranches } = require('../shared/branches');
const { MSG, PLATFORM } = require('../shared/constants');
const { parseMenuResponse } = require('../shared/parsers');
```

- [ ] **Step 2: Keep PHASE 1 (homepage postcode entry) unchanged**

The `if (path === '/' || path === '')` block (postcode entry → first suggestion → navigate to listing) is still needed for enumeration. Leave it intact.

- [ ] **Step 3: Rewrite PHASE 2 (listing) as enumerate mode**

Replace the body of `if (path.startsWith('/restaurants/'))` (after the existing scroll-to-load loop that populates `a[href*="/menu/"]`) so that instead of picking `best.el.click()` it builds candidates and reports them. Replace from the `const candidates = ...` line to the end of the block with:

```js
    const ctx = window.__feedmeCompare ?? {};
    const candidates = [...document.querySelectorAll('a[href*="/menu/"]')]
      .map((a) => {
        const label = a.getAttribute('aria-label') ?? a.textContent ?? '';
        // Labels read "Name. 0.3 mi. Delivers at 15. Rated 4.8..."
        const parts = label.split('. ');
        const name = parts[0].trim();
        const distMatch = label.match(/([\d.]+)\s*mi\b/i);
        const href = a.getAttribute('href') || '';
        return {
          id: href,                       // the menu path uniquely identifies a branch
          name,
          label: (parts[1] || '').trim(), // area / "0.3 mi" segment; refined in Task 11
          distance: distMatch ? parseFloat(distMatch[1]) : null,
          menuUrl: href,
        };
      })
      .filter((c) => c.name && c.menuUrl);

    const branches = selectNearestBranches(candidates, ctx.restaurantName ?? '', ctx.branchCount ?? 3)
      .map(({ id, label, distance, menuUrl }) => ({ id, label, distance, menuUrl }));

    chrome.runtime.sendMessage({ type: MSG.BRANCHES_FOUND, platform: PLATFORM.DELIVEROO, branches });
    return;
```

- [ ] **Step 4: Keep PHASE 3 (menu) as menu mode**

Leave the `if (path.startsWith('/menu/'))` block intact — it reads `__NEXT_DATA__`, parses, and sends `MSG.PLATFORM_DATA`. The service worker navigates a menu tab directly to a branch `menuUrl` (a `/menu/...` path) and injects this script, so this phase runs as-is.

- [ ] **Step 5: Build**

Run: `npm run build`
Expected: no errors; `dist/deliveroo-scraper.js` updated.

- [ ] **Step 6: Commit**

```bash
git add src/content/deliveroo-scraper.js
git commit -m "feat: Deliveroo scraper enumerate/menu modes"
```

---

## Task 8: Uber enumerator

**Files:**
- Create: `src/content/uber-scraper.js`
- Modify: `esbuild.config.mjs` (add entry point)
- Verify: live in real Chrome only (Task 11) — no Jest test.

**Interfaces:**
- Consumes: `window.__feedmeCompare = { mode: 'enumerate', restaurantName, postcode, branchCount }`, `selectNearestBranches` from `src/shared/branches.js`. Runs on the Uber feed page (`/gb/feed?q=...`).
- Produces: `{ type: MSG.BRANCHES_FOUND, platform: PLATFORM.UBER_EATS, branches: Array<{id,label,distance,menuUrl}> }`.
- Note: Uber **menu** scraping reuses the existing `dist/platform-scraper.js` interceptor (no new menu code). The service worker opens a store URL and injects `platform-scraper.js` in the MAIN world; the store page's own fetch returns `catalogSectionsMap`, which the interceptor parses into `MSG.PLATFORM_DATA`.

- [ ] **Step 1: Implement the enumerator**

```js
// src/content/uber-scraper.js
const { selectNearestBranches } = require('../shared/branches');
const { MSG, PLATFORM } = require('../shared/constants');

// Uber feed lists store cards as links to /gb/store/<slug>/<uuid>. This scraper
// runs only in "enumerate" mode: it reads the rendered feed, builds branch
// candidates, and reports the nearest N. Menu pricing reuses platform-scraper.js.
(async () => {
  if (window.__feedmeUberEnumerated) return;
  window.__feedmeUberEnumerated = true;

  const ctx = window.__feedmeCompare ?? {};

  function waitFor(fn, timeout = 8000, interval = 200) {
    return new Promise((resolve) => {
      const start = Date.now();
      const tick = () => {
        let v = null;
        try { v = fn(); } catch (_) {}
        if (v) return resolve(v);
        if (Date.now() - start > timeout) return resolve(null);
        setTimeout(tick, interval);
      };
      tick();
    });
  }

  const links = await waitFor(() => {
    const found = [...document.querySelectorAll('a[href*="/gb/store/"]')];
    return found.length ? found : null;
  });
  if (!links) {
    chrome.runtime.sendMessage({ type: MSG.BRANCHES_FOUND, platform: PLATFORM.UBER_EATS, branches: [] });
    return;
  }

  // De-dupe by store path; the card's aria-label / text carries the store name
  // and often an ETA/distance line.
  const byHref = new Map();
  for (const a of links) {
    const href = (a.getAttribute('href') || '').split('?')[0];
    if (!href || byHref.has(href)) continue;
    const text = a.getAttribute('aria-label') || a.textContent || '';
    const name = text.split('\n')[0].split('  ')[0].trim();
    const distMatch = text.match(/([\d.]+)\s*mi\b/i);
    byHref.set(href, {
      id: href,
      name,
      label: '',                       // refined against live data in Task 11
      distance: distMatch ? parseFloat(distMatch[1]) : null,
      menuUrl: href,
    });
  }

  const branches = selectNearestBranches([...byHref.values()], ctx.restaurantName ?? '', ctx.branchCount ?? 3)
    .map(({ id, label, distance, menuUrl }) => ({ id, label, distance, menuUrl }));

  chrome.runtime.sendMessage({ type: MSG.BRANCHES_FOUND, platform: PLATFORM.UBER_EATS, branches });
})();
```

- [ ] **Step 2: Add the entry point to esbuild**

In `esbuild.config.mjs`, add to `entryPoints`:

```js
    'uber-scraper': 'src/content/uber-scraper.js',
```

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: no errors; `dist/uber-scraper.js` created.

- [ ] **Step 4: Commit**

```bash
git add src/content/uber-scraper.js esbuild.config.mjs
git commit -m "feat: Uber branch enumerator"
```

---

## Task 9: Service worker orchestration

**Files:**
- Modify: `src/background/service-worker.js`
- Verify: live (Task 11) — no Jest test (browser APIs).

**Interfaces:**
- Consumes: `getConfig`, `MSG`, `PLATFORM`, `buildSearchUrl`, `platformFromUrl`, `browser` from constants; `matchItems`, `computeTotal` from matcher; `buildSnapshot` from snapshot; `createScheduler` from pool.
- Produces: progressive `{ type: MSG.COMPARISON_UPDATE, order, snapshot, done }` messages to the source tab.

This task replaces the per-platform single-tab model with: enumeration tab per platform → `BRANCHES_FOUND` → menu tabs via a shared scheduler → per-branch `PLATFORM_DATA` → snapshot recompute → `COMPARISON_UPDATE`.

- [ ] **Step 1: Replace the comparison state model and helpers**

Rewrite `src/background/service-worker.js`. Keep the existing `ORDER_DETECTED` listener (badge/storage) and the checkout-reader re-injection listener unchanged. Replace the comparison machinery with:

```js
const { PLATFORM, CHECKOUT_PATTERNS, MSG, SCRAPER_TIMEOUT_MS, buildSearchUrl, getConfig, browser } = require('../shared/constants');
const { matchItems, computeTotal } = require('../shared/matcher');
const { buildSnapshot } = require('../shared/snapshot');
const { createScheduler } = require('../shared/pool');

// Keyed by source tabId.
const comparisons = new Map();

const ALL_PLATFORMS = [PLATFORM.UBER_EATS, PLATFORM.DELIVEROO, PLATFORM.JUST_EAT];

// Which dist script enumerates each platform, and how to start enumeration.
const ENUMERATORS = {
  [PLATFORM.DELIVEROO]: 'dist/deliveroo-scraper.js',
  [PLATFORM.JUST_EAT]: 'dist/just-eat-scraper.js',
  [PLATFORM.UBER_EATS]: 'dist/uber-scraper.js',
};
// Menu scraping: Deliveroo/Just Eat use their own script in menu mode; Uber uses
// the generic MAIN-world interceptor.
const MENU_SCRAPERS = {
  [PLATFORM.DELIVEROO]: { file: 'dist/deliveroo-scraper.js', world: 'ISOLATED' },
  [PLATFORM.JUST_EAT]: { file: 'dist/just-eat-scraper.js', world: 'ISOLATED' },
  [PLATFORM.UBER_EATS]: { file: 'dist/platform-scraper.js', world: 'MAIN' },
};

const ENUM_TIMEOUT_MS = 30000;
const MENU_TIMEOUT_MS = 20000;

function findTab(tabId) {
  for (const comparison of comparisons.values()) {
    if (comparison.enumTabs.get(tabId)) {
      return { comparison, kind: 'enum', platform: comparison.enumTabs.get(tabId) };
    }
    const branchKey = comparison.menuTabs.get(tabId);
    if (branchKey) return { comparison, kind: 'menu', branchKey };
  }
  return null;
}
```

- [ ] **Step 2: Inject helper — set ctx, then inject script**

Add an injection helper that writes `window.__feedmeCompare` then injects the right file. Used for both enumeration and menu tabs:

```js
async function injectInto(tabId, file, world, ctx) {
  await browser.scripting.executeScript({
    target: { tabId },
    func: (c) => { window.__feedmeCompare = c; },
    args: [ctx],
  }).catch(() => {});
  await browser.scripting.executeScript({
    target: { tabId },
    files: [file],
    ...(world === 'MAIN' ? { world: 'MAIN' } : {}),
  }).catch(() => {});
}
```

- [ ] **Step 3: Rewrite START_COMPARISON to open enumeration tabs**

```js
browser.runtime.onMessage.addListener(async (msg) => {
  if (msg.type !== MSG.START_COMPARISON) return;

  const stored = await browser.storage.session.get('currentOrder');
  const order = stored.currentOrder;
  if (!order || order.items.length === 0) return;

  const tabId = msg.tabId;
  const { branchCount, maxConcurrent } = await getConfig();
  await browser.scripting.executeScript({ target: { tabId }, files: ['dist/sidebar.js'] });

  const comparison = {
    sourceTabId: tabId,
    order,
    branchCount,
    branches: new Map(),               // branchKey -> branch record
    enumTabs: new Map(),               // tabId -> platform
    menuTabs: new Map(),               // tabId -> branchKey
    scheduler: createScheduler(maxConcurrent),
    queued: new Map(),                 // branchKey -> { platform, label, distance, menuUrl }
    loading: new Set(ALL_PLATFORMS),
    injectedUrls: new Set(),
    timeouts: new Map(),
  };
  comparisons.set(tabId, comparison);

  // Seed the current branch from the live order (authoritative, not scraped).
  seedCurrentBranch(comparison);
  pushUpdate(comparison);

  for (const platform of ALL_PLATFORMS) {
    const url = buildSearchUrl(platform, order.restaurantName, order.postcode);
    if (!url) { onPlatformDone(comparison, platform); continue; }
    const bgTab = await browser.tabs.create({ url, active: false });
    comparison.enumTabs.set(bgTab.id, platform);
    comparison.timeouts.set(`enum|${platform}`, setTimeout(
      () => { onPlatformDone(comparison, platform); browser.tabs.remove(bgTab.id).catch(() => {}); },
      ENUM_TIMEOUT_MS
    ));
  }
});
```

- [ ] **Step 4: Seed current branch and snapshot push helpers**

```js
// Build the "YOUR CART" branch from the live checkout order.
function seedCurrentBranch(comparison) {
  const { order } = comparison;
  const discountTotal = order.discounts.reduce((s, d) => s + d.amount, 0);
  const itemsKnown = order.items.some((i) => i.unitPrice > 0);
  const computedItems = order.items.reduce((s, i) => s + i.unitPrice * i.quantity, 0);
  const currentTotal = order.checkoutTotal > 0
    ? order.checkoutTotal
    : computedItems + order.deliveryFee + order.serviceFee - discountTotal;
  const itemsTotal = itemsKnown ? computedItems
    : currentTotal - order.deliveryFee - order.serviceFee + discountTotal;

  comparison.branches.set('current', {
    platform: order.platform,
    key: 'current',
    label: 'Your cart',
    distance: null,
    isCurrent: true,
    status: 'done',
    result: {
      restaurantName: order.restaurantName,
      matches: order.items.map((i) => ({ referenceItem: i, platformItem: i, matched: true })),
      offers: order.discounts.map((d) => ({ description: d.label })),
      total: {
        itemsTotal, deliveryFee: order.deliveryFee, serviceFee: order.serviceFee,
        discountTotal, total: currentTotal,
        matchedCount: order.items.length, totalCount: order.items.length,
      },
    },
  });
}

function pushUpdate(comparison, done = false) {
  const snapshot = buildSnapshot(comparison.order, [...comparison.branches.values()], comparison.loading);
  browser.tabs.sendMessage(comparison.sourceTabId, {
    type: MSG.COMPARISON_UPDATE, order: comparison.order, snapshot, done,
  }).catch(() => {});
}
```

- [ ] **Step 5: Handle BRANCHES_FOUND → enqueue menu scrapes**

```js
browser.runtime.onMessage.addListener((msg, sender) => {
  if (msg.type !== MSG.BRANCHES_FOUND) return;
  const owner = findTab(sender.tab?.id);
  if (!owner || owner.kind !== 'enum') return;
  const { comparison, platform } = owner;

  clearTimeout(comparison.timeouts.get(`enum|${platform}`));
  browser.tabs.remove(sender.tab.id).catch(() => {});
  comparison.enumTabs.delete(sender.tab.id);

  // Drop the user's current branch from the source platform's scrape set so it
  // isn't shown twice (dedupe by normalised label against the live cart).
  const currentLabel = normaliseLabel(comparison.order.restaurantName);
  const found = (msg.branches || []).filter((b) =>
    !(platform === comparison.order.platform && normaliseLabel(b.label) && normaliseLabel(b.label) === currentLabel));

  if (!found.length) { onPlatformDone(comparison, platform); return; }

  const keys = [];
  for (const b of found) {
    const key = `${platform}|${b.id}`;
    comparison.branches.set(key, { platform, key, label: b.label, distance: b.distance, isCurrent: false, status: 'pending', result: null });
    comparison.queued.set(key, { platform, menuUrl: b.menuUrl });
    keys.push(key);
  }
  comparison.scheduler.add(keys);
  pushUpdate(comparison);
  pump(comparison);
});

function normaliseLabel(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}
```

- [ ] **Step 6: Pool pump — open menu tabs up to capacity**

```js
async function pump(comparison) {
  for (const key of comparison.scheduler.take()) {
    const { platform, menuUrl } = comparison.queued.get(key);
    comparison.queued.delete(key);
    const url = menuUrl.startsWith('http') ? menuUrl : originFor(platform) + menuUrl;
    const tab = await browser.tabs.create({ url, active: false }).catch(() => null);
    if (!tab) { failBranch(comparison, key, 'tab-failed'); continue; }
    comparison.menuTabs.set(tab.id, key);
    comparison.timeouts.set(key, setTimeout(() => failBranch(comparison, key, 'timeout'), MENU_TIMEOUT_MS));
  }
}

function originFor(platform) {
  if (platform === PLATFORM.JUST_EAT) return 'https://www.just-eat.co.uk';
  if (platform === PLATFORM.DELIVEROO) return 'https://deliveroo.co.uk';
  return 'https://www.ubereats.com';
}
```

The existing `onUpdated` / `onHistoryStateUpdated` injection listeners must inject the **menu** scraper for menu tabs. Update the shared injection listener:

```js
browser.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status !== 'complete') return;
  const owner = findTab(tabId);
  if (!owner) return;
  injectForTab(tabId, owner);
});
browser.webNavigation.onHistoryStateUpdated.addListener((details) => {
  const owner = findTab(details.tabId);
  if (owner) injectForTab(details.tabId, owner);
});

async function injectForTab(tabId, owner) {
  const { comparison } = owner;
  let url = '';
  try { url = (await browser.tabs.get(tabId)).url ?? ''; } catch (_) { return; }
  const dedupeKey = `${tabId}|${url}`;
  if (comparison.injectedUrls.has(dedupeKey)) return;
  comparison.injectedUrls.add(dedupeKey);

  if (owner.kind === 'enum') {
    await injectInto(tabId, ENUMERATORS[owner.platform], 'ISOLATED',
      { mode: 'enumerate', restaurantName: comparison.order.restaurantName, postcode: comparison.order.postcode, branchCount: comparison.branchCount });
  } else {
    const branch = comparison.branches.get(owner.branchKey);
    const spec = MENU_SCRAPERS[branch.platform];
    await injectInto(tabId, spec.file, spec.world,
      { mode: 'menu', restaurantName: comparison.order.restaurantName, postcode: comparison.order.postcode });
  }
}
```

- [ ] **Step 7: Handle PLATFORM_DATA per branch → match, total, snapshot**

```js
browser.runtime.onMessage.addListener((msg, sender) => {
  if (msg.type !== MSG.PLATFORM_DATA) return;
  const owner = findTab(sender.tab?.id);
  if (!owner || owner.kind !== 'menu') return;
  const { comparison, branchKey } = owner;
  const branch = comparison.branches.get(branchKey);
  if (!branch || branch.status !== 'pending') return;

  clearTimeout(comparison.timeouts.get(branchKey));
  browser.tabs.remove(sender.tab.id).catch(() => {});
  comparison.menuTabs.delete(sender.tab.id);

  if (msg.error || !msg.parsed) {
    branch.status = 'error';
    branch.result = { error: msg.error || 'parse-failed' };
  } else {
    const matches = matchItems(comparison.order.items, msg.parsed.items);
    const total = computeTotal(matches, msg.parsed.deliveryFee, msg.parsed.serviceFee, msg.parsed.offers ?? [], {
      serviceFeePct: msg.parsed.serviceFeePct, serviceFeeMin: msg.parsed.serviceFeeMin,
      serviceFeeMax: msg.parsed.serviceFeeMax, serviceFeeEstimated: msg.parsed.serviceFeeEstimated,
    });
    branch.status = 'done';
    branch.result = { restaurantName: msg.parsed.restaurantName, matches, total, offers: msg.parsed.offers ?? [] };
    if (!branch.label && msg.parsed.restaurantName) branch.label = msg.parsed.restaurantName;
  }

  comparison.scheduler.release();
  afterBranchSettled(comparison);
});

function failBranch(comparison, key, error) {
  const branch = comparison.branches.get(key);
  if (!branch || branch.status !== 'pending') return;
  branch.status = 'error';
  branch.result = { error };
  comparison.scheduler.release();
  afterBranchSettled(comparison);
}

function afterBranchSettled(comparison) {
  // A platform is no longer loading once it has enumerated and none of its
  // branches are still pending.
  for (const platform of ALL_PLATFORMS) maybeClearLoading(comparison, platform);
  pump(comparison);
  const allSettled = [...comparison.branches.values()].every((b) => b.status !== 'pending');
  const drained = comparison.scheduler.pending === 0 && comparison.queued.size === 0;
  pushUpdate(comparison, allSettled && drained && comparison.loading.size === 0);
}

function onPlatformDone(comparison, platform) {
  // Enumeration produced nothing schedulable for this platform.
  comparison.loading.delete(platform);
  afterBranchSettled(comparison);
}

function maybeClearLoading(comparison, platform) {
  if (!comparison.loading.has(platform)) return;
  const stillEnumerating = [...comparison.enumTabs.values()].includes(platform);
  const pendingBranches = [...comparison.branches.values()]
    .some((b) => b.platform === platform && b.status === 'pending');
  const queuedBranches = [...comparison.queued.keys()].some((k) => k.startsWith(`${platform}|`));
  if (!stillEnumerating && !pendingBranches && !queuedBranches) comparison.loading.delete(platform);
}
```

- [ ] **Step 8: Build and lint-by-eye**

Run: `npm run build`
Expected: esbuild completes; `dist/service-worker.js` updated. Re-read the file once to confirm no dangling references to the removed `finalisePlatform` / `comparison.tabs` / `comparison.results`.

Run: `grep -n "finalisePlatform\|comparison.tabs\|comparison.results\|COMPARISON_RESULT" src/background/service-worker.js`
Expected: no matches.

- [ ] **Step 9: Commit**

```bash
git add src/background/service-worker.js
git commit -m "feat: multi-branch orchestration with enumeration + bounded pool"
```

---

## Task 10: Sidebar — Layout A progressive rendering

**Files:**
- Modify: `src/content/sidebar.js`
- Verify: live (Task 11) — no Jest test (Shadow DOM rendering).

**Interfaces:**
- Consumes: `{ type: MSG.COMPARISON_UPDATE, order, snapshot, done }` where `snapshot` is the Task 5 shape.
- Behaviour: render three platform columns; within each, render the cheapest complete branch expanded and the rest as collapsed clickable rows; preserve which branches the user expanded across re-renders; render the footer from `snapshot.footer`.

- [ ] **Step 1a: Extend the stylesheet**

Append these rules to `styleEl.textContent` (the existing `.bd`, `.loading`, `.spin`, `.ft`, `.errc` rules stay). These implement the approved Layout A:

```css
.cols { display:flex; flex-direction:row; gap:10px; padding:12px; align-items:flex-start; width:100%; }
.col { flex:1 1 0; min-width:0; }
.colhd { font-size:12px; font-weight:700; color:#374151; padding:0 2px 6px; display:flex; align-items:center; gap:5px; }
.bc { border:1px solid #e5e7eb; border-radius:8px; margin-bottom:7px; overflow:hidden; background:#fff; }
.bc.win { border:2px solid #22c55e; }
.bc.cur { background:#fafafa; }
.bch { padding:7px 9px; display:flex; align-items:center; justify-content:space-between; gap:6px; }
.bc.win .bch { background:#f0fdf4; }
.bn { font-size:11px; font-weight:600; color:#374151; display:flex; flex-direction:column; gap:1px; }
.bn .sub { font-size:9px; color:#9ca3af; font-weight:500; }
.bt { font-size:15px; font-weight:800; color:#111; white-space:nowrap; }
.bc.win .bt { color:#16a34a; }
.tag { font-size:8px; font-weight:800; padding:1px 5px; border-radius:6px; margin-left:4px; align-self:flex-start; }
.tag.ch { background:#22c55e; color:#fff; }
.tag.cu { background:#eef2ff; color:#4f46e5; }
.det { border-top:1px dashed #e5e7eb; padding:6px 9px; font-size:10px; color:#6b7280; display:flex; flex-direction:column; gap:2px; }
.det .r { display:flex; justify-content:space-between; }
.collrow { padding:6px 9px; display:flex; align-items:center; justify-content:space-between; font-size:10px; color:#6b7280; cursor:pointer; }
.collrow:hover { background:#fafafa; }
```

- [ ] **Step 1b: Replace the message handler and card builders**

Replace the existing `browser.runtime.onMessage.addListener` block (the `COMPARISON_RESULT` handler) and the `buildCard` function. Keep the host/shadow/style setup at the top. Add a module-level `const expanded = new Set();` to remember opened branch keys.

```js
const expanded = new Set();
const fmt = (n) => `£${(+n || 0).toFixed(2)}`;

const PLATFORM_LABEL = {
  [PLATFORM.UBER_EATS]: { emoji: '🟠', name: 'Uber Eats' },
  [PLATFORM.DELIVEROO]: { emoji: '🔵', name: 'Deliveroo' },
  [PLATFORM.JUST_EAT]: { emoji: '🟣', name: 'Just Eat' },
};

function branchTotal(branch) {
  return branch.status === 'done' ? branch.result.total.total : null;
}

// Full (expanded) branch card: header + item rows + fee breakdown + offers.
function buildBranchCard(branch, isCheapest) {
  const card = document.createElement('div');
  card.className = `bc${isCheapest ? ' win' : ''}${branch.isCurrent ? ' cur' : ''}`;

  const head = document.createElement('div');
  head.className = 'bch';
  const nameWrap = document.createElement('span');
  nameWrap.className = 'bn';
  const labelLine = document.createElement('span');
  labelLine.textContent = branch.label || branch.result?.restaurantName || '';
  nameWrap.appendChild(labelLine);
  if (branch.isCurrent) appendTag(nameWrap, 'YOUR CART', 'cu');
  if (isCheapest) appendTag(nameWrap, 'CHEAPEST', 'ch');
  if (branch.distance != null) {
    const sub = document.createElement('span');
    sub.className = 'sub';
    sub.textContent = `${branch.distance} mi`;
    nameWrap.appendChild(sub);
  }
  const totalEl = document.createElement('span');
  totalEl.className = 'bt';
  totalEl.textContent = branch.status === 'error' ? '—' : fmt(branchTotal(branch));
  head.appendChild(nameWrap);
  head.appendChild(totalEl);
  card.appendChild(head);

  if (branch.status === 'error') {
    const err = document.createElement('div');
    err.className = 'det';
    err.textContent = `Could not load (${branch.result.error})`;
    card.appendChild(err);
    return card;
  }
  const det = document.createElement('div');
  det.className = 'det';
  const t = branch.result.total;
  appendDetRow(det, 'Subtotal', fmt(t.itemsTotal));
  appendDetRow(det, 'Delivery', fmt(t.deliveryFee));
  appendDetRow(det, `Service${t.serviceFeeEstimated ? ' (est.)' : ''}`, fmt(t.serviceFee));
  if (t.discountTotal > 0) appendDetRow(det, 'Discounts', `-${fmt(t.discountTotal)}`);
  card.appendChild(det);
  return card;
}

// Collapsed one-line row; clicking it expands that branch on the next render.
function buildCollapsedRow(branch) {
  const wrap = document.createElement('div');
  wrap.className = 'bc';
  const row = document.createElement('div');
  row.className = 'collrow';
  const left = document.createElement('span');
  left.textContent = branch.distance != null
    ? `${branch.label || 'Branch'} · ${branch.distance} mi`
    : (branch.label || 'Branch');
  const right = document.createElement('span');
  right.textContent = branch.status === 'error' ? 'error ▾'
    : branch.status === 'pending' ? '… ▾' : `${fmt(branchTotal(branch))} ▾`;
  row.appendChild(left);
  row.appendChild(right);
  row.addEventListener('click', () => { expanded.add(branch.key); render(lastSnapshot, lastOrder); });
  wrap.appendChild(row);
  return wrap;
}

function appendTag(parent, text, cls) {
  const t = document.createElement('span');
  t.className = `tag ${cls}`;
  t.textContent = text;
  parent.appendChild(t);
}
function appendDetRow(parent, label, value) {
  const r = document.createElement('div');
  r.className = 'r';
  const l = document.createElement('span'); l.textContent = label;
  const v = document.createElement('span'); v.textContent = value;
  r.appendChild(l); r.appendChild(v); parent.appendChild(r);
}
```

- [ ] **Step 2: Column + footer render**

```js
let lastSnapshot = null;
let lastOrder = null;

function render(snapshot, order) {
  lastSnapshot = snapshot;
  lastOrder = order;
  if (!snapshot) return;

  mname.textContent = order.restaurantName;
  while (metaEl.childNodes.length > 1) metaEl.removeChild(metaEl.lastChild);
  const subtext = document.createElement('span');
  subtext.textContent = `${order.items.length} item${order.items.length !== 1 ? 's' : ''} · ${order.postcode}`;
  metaEl.appendChild(subtext);

  bd.textContent = '';
  const cols = document.createElement('div');
  cols.className = 'cols';

  snapshot.platforms.forEach((col) => {
    const colEl = document.createElement('div');
    colEl.className = 'col';
    const hd = document.createElement('div');
    hd.className = 'colhd';
    const { emoji, name } = PLATFORM_LABEL[col.platform];
    hd.textContent = `${emoji} ${name}`;
    colEl.appendChild(hd);

    // Order branches: cheapest first (expanded), current pinned, then by distance.
    const ordered = [...col.branches].sort((a, b) => {
      if (a.key === col.cheapestKey) return -1;
      if (b.key === col.cheapestKey) return 1;
      if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
      return (a.distance ?? Infinity) - (b.distance ?? Infinity);
    });

    ordered.forEach((branch) => {
      const showFull = branch.key === col.cheapestKey || branch.isCurrent || expanded.has(branch.key);
      colEl.appendChild(showFull
        ? buildBranchCard(branch, branch.key === col.cheapestKey)
        : buildCollapsedRow(branch));
    });

    if (col.spinner) {
      const sp = document.createElement('div');
      sp.className = 'loading';
      const s = document.createElement('div'); s.className = 'spin';
      sp.appendChild(s); sp.appendChild(document.createTextNode('Finding branches…'));
      colEl.appendChild(sp);
    } else if (!col.branches.length) {
      const none = document.createElement('div');
      none.className = 'errc';
      none.textContent = 'No branches found';
      colEl.appendChild(none);
    }
    cols.appendChild(colEl);
  });
  bd.appendChild(cols);

  renderFooter(snapshot);
}

function renderFooter(snapshot) {
  const existing = bar.querySelector('.ft');
  if (existing) existing.remove();
  const ft = document.createElement('div');
  const f = snapshot.footer;
  if (f.kind === 'switch') {
    ft.className = 'ft sw';
    ft.textContent = 'Switch to ';
    const who = document.createElement('span'); who.className = 'save';
    who.textContent = `${PLATFORM_LABEL[f.platform].name}${f.label ? ` (${f.label})` : ''}`;
    ft.appendChild(who);
    ft.appendChild(document.createTextNode(' to save '));
    const amt = document.createElement('span'); amt.className = 'save';
    amt.textContent = fmt(f.saving);
    ft.appendChild(amt);
  } else if (f.kind === 'best') {
    ft.className = 'ft';
    ft.textContent = "✅ You're already on the cheapest branch";
  } else {
    ft.className = 'ft';
    ft.textContent = 'Comparing branches…';
  }
  bar.appendChild(ft);
}

browser.runtime.onMessage.addListener((msg) => {
  if (msg.type !== MSG.COMPARISON_UPDATE) return;
  render(msg.snapshot, msg.order);
});
```

- [ ] **Step 3: Remove dead code**

Delete the old `LABEL`, `buildCard`, and the previous `COMPARISON_RESULT` handler. Confirm:

Run: `grep -n "COMPARISON_RESULT\|buildCard\b" src/content/sidebar.js`
Expected: no matches.

- [ ] **Step 4: Build**

Run: `npm run build`
Expected: no errors; `dist/sidebar.js` updated.

- [ ] **Step 5: Commit**

```bash
git add src/content/sidebar.js
git commit -m "feat: Layout A progressive multi-branch sidebar"
```

---

## Task 11: Full build, live verification, field reconciliation

**Files:**
- Possibly modify: `src/shared/branches.js` (Just Eat fields), `src/content/deliveroo-scraper.js` / `src/content/uber-scraper.js` (label fields) if live data differs from the documented guesses.

- [ ] **Step 1: Full build + unit suite**

Run: `npm run build && npm test`
Expected: build succeeds; all unit suites pass (constants, branches, pool, snapshot, plus pre-existing parsers/matcher/checkout-reader).

- [ ] **Step 2: Reconcile Just Eat listing fields (Playwright MCP)**

Using the Playwright MCP (see the `feedme-live-investigation` memory), open a Just Eat area listing for a known chain + postcode, read `__NEXT_DATA__`, and locate `restaurantData`. Confirm the per-branch field used for distance and a locality/area label. If they differ from `distanceInMiles` / `cuisineArea`, update `justEatCandidates` in `src/shared/branches.js` **and** `tests/fixtures/just-eat-listing.json` together, then re-run `npm test -- branches` (expected PASS).

- [ ] **Step 3: Live Deliveroo + Just Eat enumeration sanity (Playwright MCP)**

For each: confirm the enumerator finds multiple branches of a multi-branch chain (e.g. a city-centre Burger King) and that each branch's `menuUrl` loads a real menu page. Validate parsing by running `src/shared/parsers.js` over the captured menu blob (the parsers are plain CommonJS, runnable in node).

- [ ] **Step 4: Uber verification (user's real Chrome)**

This step is done by the user (no Uber login in the MCP environment). Load the unpacked extension, start an Uber Eats checkout for a multi-branch chain, open the popup, trigger comparison, and confirm: the Uber column shows the "YOUR CART" branch plus nearby Uber branches, Deliveroo/Just Eat columns populate progressively, the cheapest branch per column is highlighted, collapsed rows expand on click, and the footer reports the correct switch-and-save (or "already cheapest"). Capture a screenshot.

- [ ] **Step 5: Final commit**

```bash
git add -A
git commit -m "chore: reconcile live branch fields and verify multi-branch end-to-end"
```

---

## Self-Review Notes

- **Spec coverage:** §2 enumeration → Tasks 2,3,6,7,8; §3 orchestration/pool → Tasks 4,9; §4 scrapers reuse → Tasks 6,7,8; §5 matching → Task 9 (reuses `matchItems`/`computeTotal`); §6 Layout A + progressive + current branch + footer → Tasks 5,9,10; §6 single-branch/independent case → Task 2 test; §7 errors → Task 9 (`failBranch`, empty-`branches`), §7 config → Task 1; testing → Tasks 2,4,5 (pure) + Task 11 (live). Uber risk → Task 11 Step 4.
- **Out of scope honoured:** no popup config UI; no changes to `parse*` menu-field logic.
