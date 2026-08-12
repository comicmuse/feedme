# Deliveroo enumeration: search via GraphQL replay (#131)

## Problem

Deliveroo enumeration reports "No branches found" for any chain **not present in
Deliveroo's ~18 curated listing-landing cards** — i.e. independents and smaller
chains (e.g. Tayyabs). Confirmed root cause (see #131):

- `deliveroo-scraper.js` phase 2 types the brand into the listing search box and
  `waitFor`s a rendered `/menu/` link whose aria-label `sameBrand`-matches.
- Big chains (KFC, McDonald's, Nando's…) are already in the landing cards, so the
  match returns instantly — the search results are never needed. Prior
  verification used such chains, masking the gap.
- Independents only appear once the **search** returns results, and in the real
  enumeration tab those results never reach the scraper: the tab is a background
  (`active:false`) tab with throttled rendering, and the search is obstructed by
  interstitials the scraper never dismisses (a first-order "£0 delivery" promo
  modal, a location prompt). The scraper has no modal/consent/location handling.

Verified live (2026-08-12, Playwright, foreground): Tayyabs *is* available at E14
7LG and renders in ~1.5 s in a foreground tab — so it is neither an availability
nor a matcher problem. It is purely that the background tab never surfaces the
search results to the scraper.

## Approach

Rewrite **only phase 2** of `deliveroo-scraper.js`: instead of typing into the
search box and scraping the rendered DOM, **replay Deliveroo's own search query**
and parse the JSON response. A network request is immune to both the promo modal
and background-tab render throttling.

Phases 1 (homepage → postcode → listing) and 3 (menu `__NEXT_DATA__`) are
unchanged. Phase 1 already succeeds — it produced the geohash-bearing listing URL
— so location is established before phase 2 runs.

### How the replay reaches a PerimeterX-guarded, cross-origin endpoint

The search fires `POST https://api.uk.deliveroo.com/consumer/graphql/`, operation
`getTextSearchResults` → `results.text_search`. Two obstacles, live-confirmed
2026-08-12:

- **Cross-origin.** The API host (`api.uk.deliveroo.com`) is a different origin
  from the page (`deliveroo.co.uk`). A page-context / iframe `fetch` fails CORS
  (`Failed to fetch`).
- **PerimeterX.** The endpoint is guarded by PerimeterX (`px-cloud.net`), which
  monkeypatches the page's `window.fetch`.

The in-repo precedent that clears both: **Just Eat already fetches its own
cross-origin API host (`uk.api.just-eat.io`) directly from its content script**
(`just-eat-scraper.js`), with that host declared in `host_permissions`. A content
script's `fetch` to a host in `host_permissions` gets a **CORS bypass**, and runs
in the ISOLATED world so it is not the page's PX-patched `fetch`. It carries the
`api.uk.deliveroo.com` cookies (incl. any `_px*`) via `credentials:'include'`.

So the fix **adds `*://api.uk.deliveroo.com/*` to `host_permissions`** (mirroring
Just Eat) and issues the search from the Deliveroo content script.

**Residual risk — PerimeterX server-side enforcement.** Just Eat's API is not
PX-guarded; Deliveroo's is. Whether a content-script fetch carrying the `_px*`
cookies satisfies PX (cookie-based) or is rejected (needs a per-request signed
header the PX JS computes) can only be settled by building and running the
extension. This is the live-verification gate. **Fallback if PX rejects the
replay:** a MAIN-world interceptor that captures the page's *own* (PX-signed)
`text_search` response and relays it to the ISOLATED scraper. Do not build the
fallback pre-emptively.

Request variables of interest:

- `options.query` — the search term (the brand, e.g. `"Tayyab"`).
- `location` — `{ geohash, city_uname, neighborhood_uname, postcode:"" }`, all
  derivable from the listing URL the scraper is already on
  (`/restaurants/london/limehouse?...&geohash=gcpvp1tvkpfy`).
- `uuid` — a per-request UUID (freshly generated is accepted).

Request headers to set: `content-type: application/json`, `accept:
application/json`, `x-roo-country: uk`, `x-roo-platform: web`, `x-roo-client:
consumer-web-app`, and `x-roo-guid` / `x-roo-session-guid` (freshly generated
UUIDs). `credentials: 'include'`.

### Response shape (from the captured fixture)

`results.text_search.ui_layout_groups[].ui_layouts[]` are `UILayoutList`s whose
`ui_blocks[]` are cards. A restaurant card's `target` is a `UITargetRestaurant`:

```
target.restaurant = { id, name, links: { self: { href } } }
```

and the card's distance is a text span elsewhere in the same block
(`"1.2 mi"`; delivery time `"25 min"` and fee text also present). Each restaurant
appears twice (default + expanded card content) and must be de-duped by `id`.

Confirmed in the fixture: Tayyabs → `{ id: "28041", name: "Tayyabs", href:
"/menu/London/whitechapel/tayyabs?day=today&geohash=...&time=ASAP" }`, distance
`1.2 mi`, among 30+ results.

### Query: minimal, with a shape-tolerant parser

Deliveroo's real `getTextSearchResults` query is a ~10 KB blob of UI fragments.
Ship a **minimal query (~577 bytes, measured live)** selecting only what we parse:
`text_search` → `ui_layout_groups` → `ui_layouts (UILayoutList)` → `ui_blocks
(UICard)` → the restaurant `target` (`__typename` aliased `typeName`; `restaurant
{ id name links { self { href } } }`) plus the card's `ui_lines` text spans (for
distance). Aliases in the minimal query are chosen to match the field names
`parseDeliverooSearch` keys on (`typeName`, `restaurant`, `links`, `self`, `href`,
`name`, `id`, `text`).

Because the parser walks the response generically for those keyed fields, it
handles **both** the minimal-query response and Deliveroo's full verbatim
response. That is what lets the pinned unit-test fixture be the real **verbatim**
response (134 KB, already captured) while production sends the 577-byte query:
same keyed fields, so one parser satisfies both. Live verification confirms the
minimal query is accepted; if the server ever rejects it, switch the request to
the verbatim query string with **no change to the parser or fixture**.

## Components

### `manifest.base.json` + `src/shared/permissions.js` + `tests/manifest.test.js` — new host

Add `*://api.uk.deliveroo.com/*` to `manifest.base.json` `host_permissions` **and**
to `PLATFORM_ORIGINS[DELIVEROO]` in `permissions.js`. `manifest.test.js` already
asserts the two sets are identical, so both must change together (mirrors Just
Eat's three-origin split, where the API host is separately revocable). This makes
the Deliveroo content script's fetch to the API host a CORS-bypassed extension
request, and folds the host into the existing Firefox grant/pre-flight checks.

### `src/shared/parsers.js` — new `parseDeliverooSearch(json)`

Pure function. Input: the parsed `text_search` GraphQL response. Output:
`Array<{ id, name, distance, menuUrl }>` — one entry per distinct restaurant.

- Collect card blocks via the response's aliased path
  `json.data.results.layoutGroups[].data[].blocks[]` (GraphQL's `data` envelope,
  then the aliases both Deliveroo's verbatim query and our minimal query emit).
- Per block: deep-find the `UITargetRestaurant` (`typeName` === `UITargetRestaurant`,
  `restaurant.id`, `restaurant.name`, `restaurant.links.self.href`) and the card's
  distance from any text span matching `/([\d.]+)\s*mi\b/i` → float; null if absent.
- De-dupe by restaurant `id` (keep first). Skip blocks with no restaurant target
  (banners, pills, ads).
- Defensive: never throw on missing/renamed fields — a block that doesn't match
  the expected shape is skipped, yielding fewer candidates rather than an error
  (mirrors the existing parser tolerance).

### `src/content/deliveroo-scraper.js` — phase 2 rewrite

Replace the "type into search box + `waitFor` rendered links" logic with:

1. Parse `geohash`, `city_uname`, `neighborhood_uname` from `window.location`.
   If geohash is absent (phase 1 did not resolve), `enumLog` the reason and report
   `branches: []` (unchanged failure semantics, now with a clear cause).
2. Build the request (minimal query + variables above) and `fetch` the API host
   from the content script — `credentials:'include'`, `content-type`/`accept`
   JSON, and the `x-roo-country/platform/client` + freshly-generated
   `x-roo-guid`/`x-roo-session-guid` headers. On network error or non-200,
   `enumLog` the outcome and report `branches: []`.
3. `const candidates = parseDeliverooSearch(await res.json())`.
4. Map candidates into the shape `selectNearestBranches` expects (it already takes
   `{ id, name, label, distance, menuUrl }`; derive `label` from the href area
   segment exactly as the current code does), filtering `sameBrand`.
5. `selectNearestBranches(candidates, ctx.restaurantName, ctx.branchCount)` →
   `BRANCHES_FOUND`. **This reporting path and `selectNearestBranches` are
   unchanged.**
6. Keep every `enumLog` diagnostic, and add one for the request outcome
   (candidate count) so a future silent failure is visible in the tab console.

The `menuUrl` returned by the API is a relative `/menu/...` href; the service
worker's existing `resolveMenuUrl` already absolutises + validates it against the
Deliveroo origin, so no change there.

## Testing

Per AGENTS.md ("Pin newly observed shapes as test fixtures", "Verify live").

- **Unit:** pin the captured real (verbatim) response as `tests/fixtures/
  deliveroo-search.json` as-is. `parseDeliverooSearch(fixture)` asserts: Tayyabs
  extracted with id `28041`, name, `/menu/London/whitechapel/tayyabs` href, and
  distance `1.2`; duplicates de-duped by id; an empty/shapeless response yields `[]`.
- **Live (the risk gate):** run the real extension against the Tayyab Sheesh Kebab
  order at E14 7LG (`npm run package`, grant the new Deliveroo API host, load
  `build/firefox/` — the reported browser — and `build/chrome/`), confirm Deliveroo
  returns Tayyabs end-to-end into the sidebar. This validates the two live
  unknowns: **(a) PerimeterX** accepts the content-script fetch (cookie-based) —
  if not, switch to the MAIN-world-interceptor fallback; **(b)** the minimal query
  is accepted — if not, switch to the verbatim query (parser/fixture unchanged).
  Also re-check a curated chain (e.g. KFC) to confirm no regression.

## Out of scope / non-goals

- No change to phase 1 (postcode entry) or phase 3 (menu parse).
- No change to `selectNearestBranches`, `sameBrand`, or the `BRANCHES_FOUND`
  contract.
- No modal/consent-dismissal DOM logic — replay makes it unnecessary for phase 2.
- The secondary diagnosability gap (`service-worker.js` `injectInto` swallowing
  `executeScript` failures) is noted in #131 but not fixed here; it did not cause
  this bug.

## Reference

- Captured request/response: operation `getTextSearchResults`, endpoint
  `api.uk.deliveroo.com/consumer/graphql/`. The full 134 KB response is preserved
  and committed as the fixture as-is (the parser is shape-tolerant, so no trimming
  is needed and none should be risked).
- Minimal query (577 bytes, live-measured) and the fallback plan (MAIN-world
  interceptor for PX; verbatim query if minimal is rejected) live in the plan.
