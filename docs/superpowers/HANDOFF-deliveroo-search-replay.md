# Handoff — Deliveroo search-replay fix (#131)

> **RESOLVED 2026-08-15.** Live-verified end-to-end in Firefox (Tayyabs + Popeyes).
> The re-verification surfaced two further live-only requirements beyond this note —
> the `x-roo-sticky-guid` header and a `query=<brand>` param in the request `url`
> variable — both now fixed and covered by `tests/deliveroo-search-request.test.js`.
> See the "Final request shape" section of the design spec. This doc is kept as a
> record of the parked state; the notes below predate those two fixes.

**Branch:** `feat/deliveroo-search-replay` (off `main`)
**Date parked:** 2026-08-12, end of day
**Spec:** `docs/superpowers/specs/2026-08-12-deliveroo-search-replay-design.md`
**Plan:** `docs/superpowers/plans/2026-08-12-deliveroo-search-replay.md`
**Issue:** #131

## Where we are (one line)

Everything is implemented and unit-tested (598 green); the **only** remaining
step is one live re-verification in Firefox with a real Tayyabs basket. The two
hard risks are already retired live: the service-worker fetch returns **HTTP 200**
(CORS bypassed, **PerimeterX satisfied**), and the reply now reaches the scraper.

## What was proven live tonight

1. A content-script POST to `api.uk.deliveroo.com` fails (`NetworkError`) — Firefox
   MV3 content scripts don't get a CORS-preflight bypass. → moved the fetch to the
   **service worker** (host_permissions exempts it). **HTTP 200 confirmed.**
2. The SW's `onMessage` return-value reply raced the SW's other async listeners
   (one resolved `undefined` before the fetch finished). → the SW now **pushes** the
   result to the enum tab as a `DELIVEROO_SEARCH_RESULT` message. **Reply confirmed
   delivered** (`brand: "Tayyab"`, no more `null`).
3. The **minimal** GraphQL query returned HTTP 200 but **0 cards**: it dropped the
   `capabilities` vars (`ui_layouts:[LIST]`, `ui_targets:[RESTAURANT]`, …). → switched
   to Deliveroo's **verbatim** `getTextSearchResults` query + capability vars,
   auto-extracted into `src/background/deliveroo-search-query.js`. Not yet
   re-verified live (this is tomorrow's step).

## TODO tomorrow (should be quick)

1. `npm run package` (already done tonight, but re-run if you touch anything).
2. Firefox `about:debugging` → **Reload** FeedMe. Ensure `api.uk.deliveroo.com`
   host access is granted (it was).
3. Real **Tayyab Sheesh Kebab** basket → Uber Eats **checkout** at **E14 7LG**.
   Confirm the captured restaurant name is non-empty (last failing run had an empty
   brand and all three platforms returned 0 — that was a capture issue, not this fix).
4. Run compare. Open the **service-worker console** (about:debugging → FeedMe →
   Inspect) and the page Browser Console (filter `[FeedMe`).

**Expected:**
- SW console: `[FeedMe deliveroo-search] HTTP 200 — layoutGroups: <N>0 gqlErrors: 0`
- Page console: `[FeedMe enum] deliveroo — phase 2: reporting N branch(es) from M search result(s)`, N ≥ 1
- Sidebar shows **Tayyabs** with a price.

**If still 0 (`layoutGroups: 0`)** → the SW request differs from the page's in some
field the server needs. Diff the SW request against the captured page request at
`.playwright-mcp/deliveroo-search-request-181.json` (query is identical now; check
`variables` — likely `location`/`url`). The parser is not the suspect: it passes
against the real response fixture in `tests/parsers.test.js`.

**If `gqlErrors > 0`** → the SW console logs the count; add `json.errors` to the log
to read the message (likely a variable-type mismatch).

## Cleanup before merge (after live-verify passes)

- Remove/keep the bring-up diagnostic in `fetchDeliverooSearch` (the `[FeedMe
  deliveroo-search] HTTP … layoutGroups …` line). Keeping a concise one is fine per
  the "[FeedMe …] logging is deliberate" rule; trim if noisy.
- Consider slimming the 18 KB verbatim query later (own issue) — it works and
  matches the fixture, so not urgent. If slimmed, it MUST keep the `capabilities`
  args or the API returns 0 cards.
- Update the spec/plan "Query" sections: the final design is **SW-side fetch +
  push-reply + verbatim query** (the docs still describe the earlier
  content-script + minimal-query iteration in places).
- Then: `superpowers:finishing-a-development-branch` → PR to `main`, reference #131.

## Key files touched

- `manifest.base.json`, `src/shared/permissions.js` — `api.uk.deliveroo.com` host.
- `src/shared/parsers.js` (+ `tests/parsers.test.js`, `tests/fixtures/deliveroo-search.json`) — `parseDeliverooSearch`.
- `src/shared/constants.js` — `DELIVEROO_SEARCH` / `DELIVEROO_SEARCH_RESULT` MSG types.
- `src/background/service-worker.js` — SW fetch + push-reply + diagnostic.
- `src/background/deliveroo-search-query.js` — verbatim query + capability vars (auto-extracted).
- `src/content/deliveroo-scraper.js` — phase 2 asks the SW and awaits the pushed result.

## Reference captures (gitignored, in `.playwright-mcp/` and scratchpad)

- `deliveroo-search-181.json` / `deliveroo-search-tayyab-e147lg.json` — full response (the parser fixture source).
- `deliveroo-search-request-181.json` — the request (query + variables) the verbatim module was extracted from.
