# FeedMe

A browser extension that answers one question at takeaway checkout time: **would this exact order be cheaper from another branch, or on another platform?**

Open your basket on **Uber Eats**, **Deliveroo**, or **Just Eat** and FeedMe reads the order, finds the same restaurant chain's nearby branches on all three platforms, re-prices your items — modifiers, fees, and offers included — using each platform's own menu data, and shows a side-by-side comparison sidebar. One click on a winning branch opens its menu and a scripted basket builder refills your basket there, selections and all.

## How it works

1. **Capture** (`src/content/checkout-reader.js`) — reads the live checkout/cart DOM on the source platform: items, quantities, and every selected option with its group label (free choices and "No Thanks" declines included).
2. **Enumerate** (`src/content/*-scraper.js`, `src/shared/branches.js`) — background tabs open each platform's area listing for your postcode and collect the chain's nearest branches.
3. **Parse** (`src/shared/parsers.js`) — each branch's menu page is scraped from the platform's own embedded data (`__NEXT_DATA__`, JSON-LD + catalog blob, CDN catalogues), yielding items, modifier groups (including Just Eat "deal group" meals), fees, and offers.
4. **Match & price** (`src/shared/matcher.js`) — your items fuzzy-match each branch's menu; options resolve group-aware onto the target's own modifiers (size upgrades retarget to the sibling size item; declines only ever resolve to declines). Totals apply delivery/service fees and the offers the platform itself advertises — deal eligibility is exact catalogue-name equality, never fuzzy.
5. **Compare** (`src/content/sidebar.js`, `src/background/service-worker.js`) — the sidebar shows each branch's full total with a fee breakdown; estimates are labelled (e.g. "Delivery (approx.)").
6. **Switch & fill** (`src/content/basket-builder.js`) — clicking a branch opens its menu in a foreground tab and the builder scripts your matched items into the real basket: name-driven clicking with native ids as hints, per-selection settle waits, shadow-DOM/web-component handling, collapsed-option expansion. It never throws; anything it can't fill honestly reports "add manually", and lines filled from partially-resolved plans are flagged "check the options".

### Design principles

- **Deterministic over heuristic** — prices, fees, ids, and offer eligibility come from platform data, not guesses; anything estimated is labelled as such.
- **Honest failure** — the builder acts on your real, logged-in basket, so it only ever runs from an explicit click, counts nothing as added unless the platform's own dialog confirmed it, and over-reports rather than under-reports what needs checking.
- **Live-verified** — every scraper/builder behaviour is validated against the real sites (see `.claude/skills/verify/SKILL.md` for the drive-it-live recipe), with the live DOM shapes pinned in the Jest suite.

## Development

```sh
npm install
npm test          # Jest suite incl. live-shape fixtures for all three platforms
npm run build     # esbuild → dist/
```

Load it in Chrome: `chrome://extensions` → enable Developer mode → *Load unpacked* → select the repo root. Rebuild and hit the reload icon after changes (`node esbuild.config.mjs --watch` for auto-rebuild).

Then place items in a basket on any supported platform and open the checkout — the sidebar appears once the comparison completes. Diagnostics are logged as `[FeedMe …]` in the page and service-worker consoles.

## Repo layout

```
src/background/service-worker.js   orchestration: capture → enumerate → scrape → match → sidebar/switch
src/content/                       per-platform scrapers, checkout reader, sidebar UI, basket builder
src/shared/                        parsers, matcher/pricing engine, branch selection, constants
tests/                             Jest suite (live DOM/data shapes as fixtures)
dist/                              built bundles (esbuild; what the manifest loads)
```

Work is tracked in GitHub issues, one shippable unit per issue.
