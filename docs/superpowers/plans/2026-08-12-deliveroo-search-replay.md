# Deliveroo Search-Replay Enumeration Fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Deliveroo enumeration find independent / non-curated chains (e.g. Tayyabs) by replaying Deliveroo's own `text_search` GraphQL query from the content script and parsing the JSON, instead of scraping search results rendered in a throttled background tab (#131).

**Architecture:** Rewrite only phase 2 of `deliveroo-scraper.js`. It `fetch`es Deliveroo's search GraphQL endpoint (a cross-origin, PerimeterX-guarded host reached with a CORS bypass via a new `host_permissions` entry — the same pattern Just Eat already uses for `uk.api.just-eat.io`) and passes the response to a new pure parser `parseDeliverooSearch` in `src/shared/parsers.js`; the existing `selectNearestBranches` + `BRANCHES_FOUND` path is unchanged. Phase 1 and phase 3 are untouched.

**Tech Stack:** CommonJS (`src/shared`, `src/content`), esbuild bundle, Jest (jsdom) with `require('./fixtures/*.json')` fixtures, content-script `fetch`/`crypto.randomUUID`.

## Global Constraints

- **Deterministic over heuristic:** branches come from the platform's own search JSON; distance is read from the response, `null` when absent.
- **Verify live (the risk gate):** validated against the real Deliveroo site — Tayyab Sheesh Kebab @ E14 7LG. Reported browser: **Firefox** (`build/firefox/`); also check `build/chrome/`. Two live unknowns are settled here: PerimeterX accepting the content-script fetch, and the minimal query being accepted.
- **Pin live shapes as fixtures:** the captured real (verbatim) response becomes `tests/fixtures/deliveroo-search.json`, committed as-is. The parser is shape-tolerant, so it validates against real data even though production sends the minimal query.
- **Package before live verification:** `npm run package` right before loading the extension.
- **Do not change** `selectNearestBranches`, `sameBrand`, phase 1, phase 3, or the `BRANCHES_FOUND` branch shape `{ id, label, distance, menuUrl }`.
- **Host-permission coupling:** `tests/manifest.test.js` asserts `manifest.base.json` `host_permissions` == union of `PLATFORM_ORIGINS` (in `permissions.js`). Any host added to one MUST be added to the other, or that test fails.
- **Preserved capture** (full response body) is at:
  `/tmp/claude-1000/-home-colm-git-feedme/284b6334-db48-46c5-8de8-cdb1e8b9f72c/scratchpad/deliveroo-search-tayyab-e147lg.json`
  and `.playwright-mcp/deliveroo-search-181.json` (identical).

---

### Task 1: Declare the Deliveroo API host permission

**Files:**
- Modify: `manifest.base.json` (`host_permissions`)
- Modify: `src/shared/permissions.js` (`PLATFORM_ORIGINS[DELIVEROO]`)

**Interfaces:**
- Produces: `*://api.uk.deliveroo.com/*` granted to the Deliveroo content script, so its fetch to that host is a CORS-bypassed extension request and is covered by the Firefox grant / pre-flight checks.

- [ ] **Step 1: Add the host to the manifest base**

In `manifest.base.json`, add to `host_permissions` (after the two deliveroo.co.uk entries):

```json
    "*://api.uk.deliveroo.com/*",
```

- [ ] **Step 2: Attribute it to the Deliveroo platform**

In `src/shared/permissions.js`, extend `PLATFORM_ORIGINS[DELIVEROO]`:

```js
  [PLATFORM.DELIVEROO]: [
    '*://www.deliveroo.co.uk/*',
    '*://deliveroo.co.uk/*',
    '*://api.uk.deliveroo.com/*',
  ],
```

- [ ] **Step 3: Verify the manifest coupling test passes**

Run: `npx jest tests/manifest.test.js`
Expected: PASS — including "every declared host permission belongs to exactly one platform" (the base host set now equals the `PLATFORM_ORIGINS` union again). If it fails with a set mismatch, Step 1 and Step 2 disagree — reconcile.

- [ ] **Step 4: Lint the Firefox manifest (AMO parity)**

Run: `npm run package && npx web-ext lint --source-dir build/firefox`
Expected: zero warnings (the guidance in AGENTS.md). A new host permission is a normal declaration; confirm it introduces no lint warning.

- [ ] **Step 5: Commit**

```bash
git add manifest.base.json src/shared/permissions.js
git commit -m "feat: declare api.uk.deliveroo.com host permission for search replay (#131)"
```

---

### Task 2: `parseDeliverooSearch` parser + fixture + unit tests

**Files:**
- Modify: `src/shared/parsers.js` (add function + export)
- Create: `tests/fixtures/deliveroo-search.json` (copied from the preserved capture)
- Modify: `tests/parsers.test.js` (add a describe block)

**Interfaces:**
- Produces: `parseDeliverooSearch(json)` → `Array<{ id: string, name: string, distance: number|null, menuUrl: string }>`, de-duped by restaurant id. Consumed by Task 3.

- [ ] **Step 1: Copy the captured response into fixtures**

```bash
cp /tmp/claude-1000/-home-colm-git-feedme/284b6334-db48-46c5-8de8-cdb1e8b9f72c/scratchpad/deliveroo-search-tayyab-e147lg.json tests/fixtures/deliveroo-search.json
```

Sanity: `node -e "const d=require('./tests/fixtures/deliveroo-search.json'); console.log(!!(d.results&&d.results.layoutGroups))"` prints `true`.

- [ ] **Step 2: Write the failing test**

In `tests/parsers.test.js`, add `parseDeliverooSearch` to the destructured import from `../src/shared/parsers` on line 1, add `const deliverooSearch = require('./fixtures/deliveroo-search.json');` near the other fixture requires, and add:

```js
describe('parseDeliverooSearch', () => {
  const { parseDeliverooSearch } = require('../src/shared/parsers');
  const branches = parseDeliverooSearch(deliverooSearch);

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
// restaurant, so de-dupe by id. The block collection uses the response's aliased
// path (layoutGroups/data/blocks — emitted by both Deliveroo's verbatim query and
// our minimal one); restaurant + distance are found generically within a block so
// minor structural drift degrades to fewer candidates, never a throw.
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

Add `parseDeliverooSearch` to `module.exports`:

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

### Task 3: Rewrite `deliveroo-scraper.js` phase 2 to replay the search query

**Files:**
- Modify: `src/content/deliveroo-scraper.js` (requires + phase-2 block only)

**Interfaces:**
- Consumes: `parseDeliverooSearch` (Task 2); the API host permission (Task 1); existing `selectNearestBranches`, `sameBrand`, `enumLog`, `MSG`, `PLATFORM`.
- Produces: unchanged `BRANCHES_FOUND` message with `branches: [{ id, label, distance, menuUrl }]`.

- [ ] **Step 1: Add the parser import**

Extend the parsers require at the top of `src/content/deliveroo-scraper.js`:

```js
const { parseMenuResponse, parseDeliverooSearch } = require('../shared/parsers');
```

- [ ] **Step 2: Add the endpoint, minimal query, and request helper**

Above the phase-2 block, add (the minimal query aliases `layoutGroups/data/blocks`
and `typeName` so its response matches what `parseDeliverooSearch` walks):

```js
const DELIVEROO_SEARCH_ENDPOINT = 'https://api.uk.deliveroo.com/consumer/graphql/';

// Minimal getTextSearchResults selection — only the fields parseDeliverooSearch
// reads. Aliased to the same names Deliveroo's own query emits so one parser (and
// one fixture) covers both. 577 bytes vs Deliveroo's ~10 KB verbatim query.
const DELIVEROO_SEARCH_QUERY = `query getTextSearchResults($location: LocationInput!, $options: SearchOptionsInput, $uuid: String!) {
  results: text_search(location: $location, options: $options, uuid: $uuid) {
    layoutGroups: ui_layout_groups { data: ui_layouts { ... on UILayoutList { blocks: ui_blocks { ... on UICard {
      target { typeName: __typename ... on UITargetRestaurant { restaurant { id name links { self { href } } } } }
      uiContent: properties { default { uiLines: ui_lines { ... on UITextLine { spans: ui_spans { ... on UISpanText { text } } } } } }
    } } } } }
  }
}`;

// Location comes from the listing URL phase 1 navigated to
// (/restaurants/{city}/{neighborhood}?...&geohash=...).
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
  if (!location.geohash) return { json: null, error: 'no geohash on listing URL' };
  const variables = {
    location,
    options: { query: brand, recent_searches: [], web_column_count: 1 },
    uuid: crypto.randomUUID(),
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
    if (!res.ok) return { json: null, error: `search HTTP ${res.status}` };
    return { json: await res.json(), error: null };
  } catch (err) {
    return { json: null, error: String(err && err.message || err) };
  }
}
```

- [ ] **Step 3: Replace the phase-2 body**

Replace the entire `if (path.startsWith('/restaurants/')) { … }` block with:

```js
  // PHASE 2 — listing: replay Deliveroo's own text_search query and parse the
  // JSON. A cross-origin fetch to the API host (granted in host_permissions),
  // immune to the promo modal and background-tab render throttling that hid
  // search results from the old DOM-scrape path (#131). selectNearestBranches
  // still filters to the target brand exactly as before.
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

This removes the old search-box lookup, `setInputValue`-into-search, and DOM `waitFor` for `/menu/` links. Phase 1 still uses `setInputValue`/`waitFor` for the postcode input — leave those helpers.

- [ ] **Step 4: Build**

Run: `npm run build`
Expected: esbuild completes; `dist/deliveroo-scraper.js` regenerated.

- [ ] **Step 5: Full suite**

Run: `git worktree list` (confirm single worktree), then `npm test`
Expected: PASS — existing tests + Task 2's parser tests. No test imports the scraper's browser entry, so `fetch`/`crypto` are not exercised in Jest.

- [ ] **Step 6: Commit**

```bash
git add src/content/deliveroo-scraper.js
git commit -m "feat: Deliveroo phase 2 replays text_search query instead of DOM scrape (#131)"
```

---

### Task 4: Package and live-verify against Tayyabs @ E14 7LG

**Files:** none (verification only). This task settles the two live risks; do not skip.

- [ ] **Step 1: Package**

Run: `npm run package`
Expected: `build/firefox/` and `build/chrome/` regenerate.

- [ ] **Step 2: Live-verify in Firefox**

Load `build/firefox/` (`about:debugging#/runtime/this-firefox` → Load Temporary Add-on → `build/firefox/manifest.json`). **Grant the Deliveroo site + API host access** from the extensions button (the new `api.uk.deliveroo.com` origin is optional in Firefox MV3). Build a **Tayyab Sheesh Kebab** basket, open the Uber Eats checkout at **E14 7LG**. Open the Multiprocess Browser Console (Ctrl+Shift+J, "Show Content Messages" on), filter `[FeedMe enum]`.

Expected: `[FeedMe enum] deliveroo — phase 2: reporting N branch(es) from M search result(s)`, N ≥ 1, and the sidebar shows a Deliveroo (Tayyabs) price, not "No branches found".

Risk outcomes:
- `search request did not return data (search HTTP 4xx/…)` or a CORS/`Failed to fetch` in the console → **PerimeterX rejected the replay.** Switch to the fallback: a MAIN-world interceptor (`world:'MAIN'`) that patches `fetch`/`XHR`, captures the page's own `text_search` response (triggered by typing the brand), and `postMessage`s it to the ISOLATED scraper, which then calls `parseDeliverooSearch`. Re-verify. Capture the failing response first; do not guess.
- Branches found but wrong/missing distance or brand → inspect `parseDeliverooSearch` against the live response; the minimal query may need a field (validate live, adjust the query, parser/fixture unchanged if the aliases hold).

- [ ] **Step 3: Regression check — a curated chain**

Repeat with a big chain already in the landing cards (e.g. **KFC**) at the same postcode. Expected: Deliveroo still returns branch(es) — confirms the rewrite didn't regress the previously-working path.

- [ ] **Step 4: Chrome smoke check**

Load `build/chrome/`, repeat the Tayyabs check. Expected: same result (Chrome MV3 grants declared host permissions without a prompt).

- [ ] **Step 5: Commit any fixes surfaced by verification**

If verification forced a change (header tweak, minimal→verbatim query, or the MAIN-world fallback), commit it with a message describing the live behaviour that forced it. Otherwise no commit.

---

## Self-Review

**Spec coverage:**
- New `api.uk.deliveroo.com` host permission, manifest + permissions together → Task 1. ✓
- Content-script replay with a minimal (577-byte) query, CORS-bypassed → Task 3. ✓
- Pure `parseDeliverooSearch`, fixture-pinned to the real verbatim response, shape-tolerant → Task 2. ✓
- Reuse `selectNearestBranches` + `BRANCHES_FOUND` unchanged → Task 3 Step 3. ✓
- Phase 1 / phase 3 untouched → only phase-2 block replaced. ✓
- Live gate settles PerimeterX + minimal-query risks, with documented fallbacks → Task 4. ✓
- enumLog diagnostics kept + request-outcome log added → Task 3 Step 3. ✓
- Curated-chain regression check → Task 4 Step 3. ✓

**Placeholder scan:** No TBD/TODO; the minimal query is written out in full; test bodies concrete. The MAIN-world fallback is described as a conditional live-outcome branch, not a placeholder in shipped code. ✓

**Type consistency:** `parseDeliverooSearch` returns `{ id, name, distance, menuUrl }` (Task 2), consumed with those fields in Task 3 and mapped to the `{ id, label, distance, menuUrl }` branch shape `selectNearestBranches` already emits. Parser de-dup key is restaurant `id` (string); the branch `id` remains the href path, preserving the downstream contract. `host_permissions` (Task 1) and `PLATFORM_ORIGINS` stay in sync, as `manifest.test.js` enforces. ✓
