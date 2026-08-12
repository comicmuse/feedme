# Deliveroo Search-Replay Enumeration Fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Deliveroo enumeration find independent / non-curated chains (e.g. Tayyabs) by replaying Deliveroo's own `text_search` GraphQL query and parsing the JSON, instead of scraping search results rendered in a throttled background tab.

**Architecture:** Rewrite only phase 2 of `deliveroo-scraper.js`. It POSTs the search query to `api.uk.deliveroo.com/consumer/graphql/` (same-origin, cookies only — no auth token) and passes the response to a new pure parser `parseDeliverooSearch` in `src/shared/parsers.js`; the existing `selectNearestBranches` + `BRANCHES_FOUND` path is unchanged. Phase 1 (postcode→listing) and phase 3 (menu) are untouched.

**Tech Stack:** CommonJS (`src/shared`, `src/content`), esbuild bundle, Jest (jsdom) with `require('./fixtures/*.json')` fixtures, webextension content-script `fetch`/`crypto.randomUUID`.

## Global Constraints

- **Deterministic over heuristic:** branches come from the platform's own search JSON; nothing estimated. Distance is read from the response, `null` when absent.
- **Verify live:** the replay/response shape is validated against the real Deliveroo site before the fix is called done (Tayyab Sheesh Kebab @ E14 7LG). Browser reported by the user: **Firefox** (`build/firefox/`); also check `build/chrome/`.
- **Pin live shapes as fixtures:** the captured real response becomes `tests/fixtures/deliveroo-search.json`.
- **Package before live verification:** `npm run package` right before loading the extension, or stale code is tested.
- **Verbatim query first:** send Deliveroo's exact `getTextSearchResults` query + variable template (preserved capture) so the fixture equals live behaviour. Query-slimming is a follow-up, not this plan.
- **Do not change** `selectNearestBranches`, `sameBrand`, phase 1, phase 3, or the `BRANCHES_FOUND` branch shape `{ id, label, distance, menuUrl }`.
- **Preserved capture** (request query string + variables + full response) is at:
  `/tmp/claude-1000/-home-colm-git-feedme/284b6334-db48-46c5-8de8-cdb1e8b9f72c/scratchpad/deliveroo-search-tayyab-e147lg.json`
  and `.playwright-mcp/deliveroo-search-181.json` (identical). This file is the **response body**; the **query string + variables** come from the earlier request-body capture reproduced inline in Task 2.

---

### Task 1: `parseDeliverooSearch` parser + fixture + unit tests

**Files:**
- Modify: `src/shared/parsers.js` (add function + export)
- Create: `tests/fixtures/deliveroo-search.json` (copied from the preserved capture)
- Modify: `tests/parsers.test.js` (add a describe block)

**Interfaces:**
- Produces: `parseDeliverooSearch(json)` → `Array<{ id: string, name: string, distance: number|null, menuUrl: string }>`, one entry per distinct restaurant in a `text_search` response, de-duped by restaurant id. Consumed by Task 2.

- [ ] **Step 1: Copy the captured response into fixtures**

```bash
cp /tmp/claude-1000/-home-colm-git-feedme/284b6334-db48-46c5-8de8-cdb1e8b9f72c/scratchpad/deliveroo-search-tayyab-e147lg.json tests/fixtures/deliveroo-search.json
```

Sanity: `node -e "const d=require('./tests/fixtures/deliveroo-search.json'); console.log(!!d.results && !!d.results.layoutGroups)"` prints `true`.

- [ ] **Step 2: Write the failing test**

In `tests/parsers.test.js`, add near the other requires:

```js
const deliverooSearch = require('./fixtures/deliveroo-search.json');
```

and add `parseDeliverooSearch` to the destructured import from `../src/shared/parsers` on line 1. Then add:

```js
describe('parseDeliverooSearch', () => {
  const branches = require('../src/shared/parsers').parseDeliverooSearch(deliverooSearch);

  test('extracts Tayyabs with id, name, menu href and distance', () => {
    const tayyabs = branches.find((b) => b.name === 'Tayyabs');
    expect(tayyabs).toBeDefined();
    expect(tayyabs.id).toBe('28041');
    expect(tayyabs.menuUrl).toMatch(/^\/menu\/London\/whitechapel\/tayyabs/);
    expect(tayyabs.distance).toBeCloseTo(1.2, 5);
  });

  test('de-dupes the default/expanded card duplication by id', () => {
    const ids = branches.map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('returns multiple distinct restaurants', () => {
    expect(branches.length).toBeGreaterThan(1);
  });

  test('never throws on an empty / shapeless response', () => {
    const { parseDeliverooSearch } = require('../src/shared/parsers');
    expect(parseDeliverooSearch({})).toEqual([]);
    expect(parseDeliverooSearch({ results: { layoutGroups: [] } })).toEqual([]);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx jest tests/parsers.test.js -t parseDeliverooSearch`
Expected: FAIL — `parseDeliverooSearch is not a function`.

- [ ] **Step 4: Implement the parser**

In `src/shared/parsers.js`, add:

```js
// A Deliveroo text_search response is a nested UI-block layout. Each result card
// carries a UITargetRestaurant (restaurant id/name and the menu href) and a
// distance text span ("1.2 mi"); the default+expanded card variants duplicate a
// restaurant, so de-dupe by id. Defensive throughout — an unknown or renamed
// shape yields fewer candidates, never a throw (mirrors the other parsers here).
function deliverooSearchBlocks(json) {
  const blocks = [];
  for (const g of (json?.results?.layoutGroups ?? [])) {
    for (const layout of (g?.data ?? [])) {
      for (const b of (layout?.blocks ?? [])) blocks.push(b);
    }
  }
  return blocks;
}

function deliverooRestaurantTarget(node) {
  if (!node || typeof node !== 'object') return null;
  if (node.typeName === 'UITargetRestaurant' && node.restaurant) {
    const r = node.restaurant;
    const href = r.links?.self?.href;
    if (r.name && href) return { id: String(r.id ?? href), name: r.name, href };
  }
  for (const v of Object.values(node)) {
    const found = deliverooRestaurantTarget(v);
    if (found) return found;
  }
  return null;
}

function deliverooFirstMiles(node) {
  let miles = null;
  (function walk(o) {
    if (miles !== null || !o || typeof o !== 'object') return;
    if (typeof o.text === 'string') {
      const m = o.text.match(/([\d.]+)\s*mi\b/i);
      if (m) { miles = parseFloat(m[1]); return; }
    }
    for (const v of Object.values(o)) walk(v);
  })(node);
  return miles;
}

function parseDeliverooSearch(json) {
  const out = [];
  const seen = new Set();
  for (const block of deliverooSearchBlocks(json)) {
    const r = deliverooRestaurantTarget(block);
    if (!r || seen.has(r.id)) continue;
    seen.add(r.id);
    out.push({ id: r.id, name: r.name, distance: deliverooFirstMiles(block), menuUrl: r.href });
  }
  return out;
}
```

Add `parseDeliverooSearch` to `module.exports` in `src/shared/parsers.js`:

```js
module.exports = { classifyResponse, parseMenuResponse, parseUberStore, justEatItemModifiers, parseDeliverooSearch };
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx jest tests/parsers.test.js -t parseDeliverooSearch`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add src/shared/parsers.js tests/parsers.test.js tests/fixtures/deliveroo-search.json
git commit -m "feat: parseDeliverooSearch extracts branches from text_search JSON"
```

---

### Task 2: Rewrite `deliveroo-scraper.js` phase 2 to replay the search query

**Files:**
- Modify: `src/content/deliveroo-scraper.js` (phase-2 block only; requires + phase-2 body)

**Interfaces:**
- Consumes: `parseDeliverooSearch` (Task 1); existing `selectNearestBranches`, `sameBrand` (`src/shared/branches`), `enumLog`, `MSG`, `PLATFORM`.
- Produces: unchanged `BRANCHES_FOUND` message with `branches: [{ id, label, distance, menuUrl }]`.

- [ ] **Step 1: Add the parser import**

At the top of `src/content/deliveroo-scraper.js`, extend the parsers require (it currently imports `parseMenuResponse`):

```js
const { parseMenuResponse, parseDeliverooSearch } = require('../shared/parsers');
```

- [ ] **Step 2: Add the search endpoint, query, and request builder**

Above the phase-2 block (after the helper functions, before `if (path.startsWith('/restaurants/'))`), add:

```js
const DELIVEROO_SEARCH_ENDPOINT = 'https://api.uk.deliveroo.com/consumer/graphql/';

// Deliveroo's verbatim getTextSearchResults query, copied exactly from the live
// request (preserved capture). Verbatim so the response aliases match the pinned
// parser fixture; slimming it is a tracked follow-up, not done here.
const DELIVEROO_SEARCH_QUERY = `<<< PASTE the "query" string verbatim from the captured request body >>>`;

// Location comes from the listing URL the scraper is already on
// (/restaurants/{city}/{neighborhood}?...&geohash=...). Phase 1 established it.
function deliverooSearchLocation() {
  const u = new URL(window.location.href);
  const seg = u.pathname.split('/'); // ['', 'restaurants', city, neighborhood]
  return {
    geohash: u.searchParams.get('geohash') || '',
    city_uname: seg[2] || '',
    neighborhood_uname: seg[3] || '',
    postcode: '',
  };
}

async function deliverooSearch(brand) {
  const location = deliverooSearchLocation();
  if (!location.geohash) return { location, json: null, error: 'no geohash on listing URL' };
  const variables = {
    ui_blocks: ['BANNER'],
    ui_layouts: ['LIST'],
    ui_targets: ['PARAMS', 'RESTAURANT', 'MENU_ITEM'],
    ui_themes: ['BANNER_CARD', 'BANNER_EMPTY', 'BANNER_MARKETING_A', 'BANNER_MARKETING_B', 'BANNER_MARKETING_C', 'BANNER_PICKUP_SHOWCASE', 'BANNER_SERVICE_ADVISORY'],
    ui_features: ['UNAVAILABLE_RESTAURANTS', 'LIMIT_QUERY_RESULTS', 'UI_CARD_BORDER', 'UI_CAROUSEL_COLOR', 'UI_PROMOTION_TAG', 'UI_BACKGROUND', 'ILLUSTRATION_BADGES', 'SCHEDULED_RANGES', 'UI_SPAN_TAGS', 'UI_SPAN_COUNTDOWN', 'UI_CARD_BADGES', 'TEXT_SEARCH_COMBINED_VIEW', 'UI_CAROUSEL_BACKGROUND_IMAGE', 'CARD_ILLUSTRATION_BADGE', 'HOME_MAP_VIEW'],
    location,
    options: { query: brand, recent_searches: [], web_column_count: 1 },
    url: window.location.href,
    uuid: crypto.randomUUID(),
    include_token: false,
  };
  try {
    const res = await fetch(DELIVEROO_SEARCH_ENDPOINT, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'x-roo-country': 'uk',
        'x-roo-platform': 'web',
        'x-roo-client': 'consumer-web-app',
        'x-roo-guid': crypto.randomUUID(),
        'x-roo-session-guid': crypto.randomUUID(),
      },
      body: JSON.stringify({ query: DELIVEROO_SEARCH_QUERY, variables }),
    });
    if (!res.ok) return { location, json: null, error: `search HTTP ${res.status}` };
    return { location, json: await res.json(), error: null };
  } catch (err) {
    return { location, json: null, error: String(err && err.message || err) };
  }
}
```

**Note for the implementer:** replace the `<<< PASTE … >>>` placeholder with the exact `query` string from the captured request body (in the preserved capture / earlier recon). Keep it as a single template literal; do not edit its contents.

- [ ] **Step 3: Replace the phase-2 body**

Replace the entire `if (path.startsWith('/restaurants/')) { … }` block with:

```js
  // PHASE 2 — listing: replay Deliveroo's own text_search query and parse the
  // JSON. A network call, so it is immune to the promo modal and to background-
  // tab render throttling that hid search results from the old DOM-scrape path
  // (#131). The result carries every nearby restaurant; selectNearestBranches
  // filters to the target brand exactly as before.
  if (path.startsWith('/restaurants/')) {
    const ctx = window.__feedmeCompare ?? {};
    const brand = (ctx.restaurantName ?? '').trim().split(/\s+/)[0] || '';

    const { json, error } = await deliverooSearch(brand);
    if (!json) {
      enumLog(PLATFORM.DELIVEROO, `phase 2: search request did not return data (${error})`, { brand });
      chrome.runtime.sendMessage({ type: MSG.BRANCHES_FOUND, platform: PLATFORM.DELIVEROO, branches: [] });
      return;
    }

    const candidates = parseDeliverooSearch(json).map((r) => {
      const href = r.menuUrl;
      const areaSeg = href.split('?')[0].split('/')[3] || '';
      const label = areaSeg.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
      return { id: href.split('?')[0], name: r.name, label, distance: r.distance, menuUrl: href };
    }).filter((c) => c.name && c.menuUrl);

    const branches = selectNearestBranches(candidates, ctx.restaurantName ?? '', ctx.branchCount ?? 3)
      .map(({ id, label, distance, menuUrl }) => ({ id, label, distance, menuUrl }));

    enumLog(PLATFORM.DELIVEROO, `phase 2: reporting ${branches.length} branch(es) from ${candidates.length} search result(s)`, { brand, branchCount: branches.length, candidateCount: candidates.length });
    chrome.runtime.sendMessage({ type: MSG.BRANCHES_FOUND, platform: PLATFORM.DELIVEROO, branches });
    return;
  }
```

This removes the old search-box lookup, `setInputValue`-into-search, and DOM `waitFor` for `/menu/` links. (Phase 1 still uses `setInputValue` and `waitFor` for the postcode input — leave those helpers in place.)

- [ ] **Step 4: Build and verify no bundle errors**

Run: `npm run build`
Expected: esbuild completes; `dist/deliveroo-scraper.js` regenerated.

- [ ] **Step 5: Run the full suite**

Run: `git worktree list` (confirm single worktree so counts aren't doubled), then `npm test`
Expected: PASS — all existing tests plus Task 1's `parseDeliverooSearch` tests. No test imports the scraper's browser entry, so `fetch`/`crypto` are not exercised in Jest.

- [ ] **Step 6: Commit**

```bash
git add src/content/deliveroo-scraper.js
git commit -m "feat: Deliveroo phase 2 replays text_search query instead of DOM scrape (#131)"
```

---

### Task 3: Package and live-verify against Tayyabs @ E14 7LG

**Files:** none (verification only).

- [ ] **Step 1: Package**

Run: `npm run package`
Expected: `build/firefox/` and `build/chrome/` regenerate.

- [ ] **Step 2: Live-verify in Firefox (the reported browser)**

Load `build/firefox/` (`about:debugging#/runtime/this-firefox` → Load Temporary Add-on → `build/firefox/manifest.json`), grant Deliveroo site access, then build a **Tayyab Sheesh Kebab** basket and open the Uber Eats checkout at postcode **E14 7LG**. Open the Multiprocess Browser Console (Ctrl+Shift+J, Show Content Messages on), filter `[FeedMe enum]`.

Expected:
- `[FeedMe enum] deliveroo — phase 2: reporting N branch(es) from M search result(s)` with N ≥ 1.
- The sidebar shows a Deliveroo branch (Tayyabs) with a price, not "No branches found".

If instead you see `search request did not return data (search HTTP 4xx)`: the verbatim replay was rejected. Capture the response, and (fallback) switch the request to send the page's own search response via a MAIN-world interceptor — file/annotate before proceeding; do not guess.

- [ ] **Step 3: Sanity-check a curated chain still works**

Repeat with a big chain already in the landing cards (e.g. KFC) at the same postcode. Expected: Deliveroo still returns branch(es) — confirms the rewrite didn't regress the previously-working path.

- [ ] **Step 4: Commit any fixes surfaced by verification**

If live verification required a change (e.g. a header tweak, or the verbatim-query fallback), commit it with a message describing what live behaviour forced it. Otherwise no commit.

---

## Self-Review

**Spec coverage:**
- Replay text_search instead of DOM scrape → Task 2. ✓
- Pure `parseDeliverooSearch` in parsers.js, fixture-pinned → Task 1. ✓
- Location from listing URL; no auth token; `x-roo-*` headers + cookies → Task 2 Step 2. ✓
- Reuse `selectNearestBranches` + `BRANCHES_FOUND` unchanged → Task 2 Step 3. ✓
- Phase 1 / phase 3 untouched → only phase-2 block replaced. ✓
- Verbatim-query-first (fixture == live), slimming deferred → Global Constraints + Task 2 note. ✓
- Keep enumLog diagnostics + add request-outcome log → Task 2 Step 3. ✓
- Live verification incl. curated-chain regression check → Task 3. ✓

**Placeholder scan:** The only intentional placeholder is the verbatim query string in Task 2 Step 2, with an explicit instruction and source (the preserved capture) — the implementer pastes real content, not invents it. No TBD/TODO elsewhere; all test bodies concrete. ✓

**Type consistency:** `parseDeliverooSearch` returns `{ id, name, distance, menuUrl }` (Task 1), consumed with exactly those fields in Task 2 Step 3, then mapped to the `{ id, label, distance, menuUrl }` branch shape `selectNearestBranches` already emits. De-dup key is restaurant `id` (string) in the parser; the branch `id` remains the href path, preserving the existing downstream contract. ✓
