# Multi-branch comparison — design

**Status:** approved (brainstorm), pending implementation plan
**Date:** 2026-06-16

## Problem

Today each comparison platform scraper fuzzy-matches a **single** branch of the
chain (`fuse.search(...)[0]`) and prices the user's order there. Branches of the
same chain price differently (real example: Burger King "Bacon Double Cheese XL
Meal" was £11.79 at Whitechapel vs £12.59 at Canary Wharf), so the one branch we
happen to pick is often not the branch the user is looking at — the shown price
is arbitrary.

## Goal

For **every** platform, find the nearest *N* branches of the chain, price the
user's order at each, and stack them per platform (cheapest branch highlighted).
The source platform (whatever the user is checking out on) also gets its other
nearby branches scraped, with its live cart branch pinned as "YOUR CART".

Default **N = 3**, configurable. Bounded-concurrency scraping. Progressive
rendering as branches arrive.

## Decisions (from brainstorming)

- **Branch selection:** nearest N by distance, configurable (default 3).
- **Source platform:** also multi-branch. All three platforms get branch
  enumeration + per-branch menu scraping; the source additionally pins the live
  cart branch.
- **Layout:** Option A — cheapest *complete* branch expanded per column, other
  branches collapsed to one-line rows that expand on click.
- **Loading:** progressive — render each platform column as its branches arrive,
  with per-column spinners; cheapest/footer recompute live.
- **Orchestration:** Approach 3 — per-platform enumeration pass extracts the N
  branch menu URLs, then a bounded pool (default 4 concurrent) fans out the menu
  scrapes.

## Architecture

### 1. Branch enumeration (deterministic, per platform)

A new **enumerator** pass per platform produces `{ id, label, distance, menuUrl }`
for each candidate branch, sorted by distance, truncated to nearest N.

- **Just Eat** — `restaurantData` in `__NEXT_DATA__` lists every branch with
  `uniqueName` + distance; `menuUrl = /restaurants-{uniqueName}/menu` (directly
  navigable).
- **Deliveroo** — listing `a[href*="/menu/"]` links *are* the branch menu URLs;
  the aria-label carries name + distance.
- **Uber** — feed (`/gb/feed?q={name}&pl={postcode}`) → store cards give title +
  distance + store URL.

The existing Fuse fuzzy match still identifies *which* listings are the chain,
but instead of `best[0]` we keep all above-threshold matches and sort by
distance. Branch **label** is derived from an explicit field (locality/area), not
a heuristic — the exact field per platform is confirmed against live data before
relying on it (per the deterministic-signals preference).

**Independent (single-branch) restaurants** are the natural degenerate case: the
enumerator returns a single above-threshold match, so the platform column shows
one branch and behaves exactly as the comparison does today. No chain membership
is assumed — "nearest N" simply yields fewer than N (often 1) branches when that
is all the listing offers. A label may be unavailable for a lone branch; the card
falls back to the restaurant name with no area suffix.

### 2. Orchestration (service worker)

State becomes branch-keyed:

```
comparison = {
  sourceTabId, order,
  branches: {
    [platform|id]: { platform, label, distance, menuUrl, isCurrent, status, result }
  },
  pool: { activeTabs: Set, queue: [branchKey], maxConcurrent: 4 },
  enumTabs, timeouts,
}
```

Flow:

1. Inject sidebar (loading state).
2. Open one **enumeration tab per platform**.
3. Each enumerator reports its nearest-N branches.
4. Service worker enqueues those branch menu scrapes.
5. A **pool** opens menu tabs up to `maxConcurrent`, recycling a tab as each
   finishes.
6. Each finished branch is matched + totalled (reusing `matchItems` /
   `computeTotal`) and pushed to the sidebar immediately.
7. When all branches are done (or timed out), a final snapshot marks completion.

Background tabs are tagged `{ kind: 'enum' | 'menu', platform, branchKey }` so
`findTabOwner` routes both enumeration and menu tabs.

### 3. Scrapers (mostly refactor, one new enumerator)

The enumerate/menu split reuses existing parse logic:

- **Deliveroo / Just Eat** scrapers split into a **branch enumerator** (listing
  only) and a **menu scraper** (the existing menu-phase logic, now driven by a
  direct branch URL).
- **Uber menu** already works via the passive `platform-scraper.js` interceptor
  on a store page, so Uber needs only a new **enumerator** (feed → store URLs);
  the menu scrape reuses the interceptor and the existing `parseUberEats`.

**Risk — Uber validation:** there is no Uber login in the Playwright MCP
environment, so Uber enumeration can only be validated in the user's own Chrome.
We rely on `parseUberEats` already being tested; the user confirms the Uber flow
in real Chrome.

### 4. Matching & totals

Unchanged per branch — each branch's parsed menu runs through the existing
matcher / total / offer logic. "Cheapest" within a column requires a *complete*
match (every order item priced), the same guard used today.

### 5. UI (Layout A, progressive)

- Three platform columns; within each, the cheapest *complete* branch is
  expanded (items + fees); other branches collapse to one-line
  `area · distance · £total ▾` rows that expand on click.
- **Progressive:** the service worker sends a `COMPARISON_UPDATE` snapshot on
  every branch arrival; the sidebar re-renders columns and shows a per-column
  spinner until that platform's branches are in.
- The sidebar tracks expanded branch keys in a Set so re-renders preserve what
  the user has opened.
- **Current branch** is pinned in the source column as "YOUR CART" (from live
  checkout), de-duped against the scraped set by store id / URL.
- **Footer** compares the overall-cheapest complete branch across all platforms
  vs the user's current branch: e.g. "Switch to Deliveroo (Whitechapel) to save
  £0.39", or "You're already on the cheapest branch."

### 6. Error handling

- Enumerator finds no chain match → that column shows "not found" (as today).
- A branch menu scrape times out / fails → that branch is dropped; if a platform
  ends with zero branches, its column shows an error. Per-branch timeout plus a
  global backstop timeout.

### 7. Configuration

Stored in `storage.local` with defaults `{ branchCount: 3, maxConcurrent: 4 }`,
read at comparison start. Surfacing these in the popup / options UI is **out of
scope** for this build.

## Testing (TDD)

New pure, independently testable units:

- Per-platform **branch extractor** — fixtures of listing/feed data → nearest-N
  `{ id, label, distance, menuUrl }`, including the single-match (independent
  restaurant) case yielding exactly one branch.
- **Pool scheduler** — enqueue / concurrency cap / tab recycling.
- **Snapshot builder** — branches → per-column cheapest + global footer
  comparison.

Existing parser / matcher tests stay; add branch-list fixtures. Manual
verification: Deliveroo / Just Eat live via Playwright MCP; Uber in the user's
real Chrome.

## Out of scope

- Popup / options UI for `branchCount` and `maxConcurrent` (config is read from
  storage with defaults only).
- Changes to `parseUberEats` / `parseDeliveroo` / `parseJustEat` menu parsing.
