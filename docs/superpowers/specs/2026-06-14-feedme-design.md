# FeedMe — Design Spec
_Date: 2026-06-14_

## Overview

A browser extension (Chrome + Firefox) that compares the price of your current order across Uber Eats, Deliveroo, and Just Eat. The user builds their order naturally on one platform, reaches the checkout page, clicks the extension, and sees a live price comparison sidebar — including account-specific discounts, credits, and promotions from each platform.

---

## Scope

**In scope (Phase 1):**
- Chrome and Firefox support via Manifest V3 + `webextension-polyfill`
- Detects supported checkout pages and activates the extension badge
- Reads current order from the checkout page (items, quantities, prices, delivery fee, applied offers)
- Finds the same restaurant on the other two platforms by name + location
- Matches order items on each platform using fuzzy string matching (`fuse.js`)
- Fetches pricing, delivery fees, service fees, and visible offers by intercepting each platform's internal API responses
- Displays results as an injected sidebar on the checkout page, sorted cheapest-first
- Shows per-platform breakdown: subtotal, delivery, service fee, discounts, total
- Flags unmatched items with a warning and caveats the total accordingly
- "Open in X →" button opens the equivalent restaurant page on the other platform in a new tab

**Out of scope (Phase 2):**
- Automatically building the cart on the other platform after "Open in X →" (requires programmatic add-to-cart flows per platform, complex and fragile)

---

## Target Platforms

| Platform   | UK domain              |
|------------|------------------------|
| Uber Eats  | ubereats.com           |
| Deliveroo  | deliveroo.co.uk        |
| Just Eat   | just-eat.co.uk         |

Checkout URL patterns (for content script activation):
- `*://www.ubereats.com/gb/store/*/checkout*`
- `*://www.deliveroo.co.uk/*/checkout*`
- `*://www.just-eat.co.uk/*/order*`

---

## Architecture

```
Browser Extension (MV3)
├── manifest.json
├── background/
│   └── service-worker.js     # Orchestrates comparison: opens tabs, collects results
├── content/
│   ├── checkout-reader.js    # Reads current order from the active checkout page
│   ├── platform-scraper.js   # Injected into background tabs; intercepts API responses
│   └── sidebar.js            # Injects and manages the FeedMe sidebar UI
├── sidebar/
│   ├── sidebar.html          # Sidebar markup (injected into checkout page)
│   └── sidebar.css           # Sidebar styles (light mode)
├── popup/
│   └── popup.html            # Extension popup (shown when not on a checkout page)
└── lib/
    └── fuse.js               # Fuzzy item matching
```

### Data flow

1. User reaches a supported checkout page → `checkout-reader.js` activates, reads order, stores it in extension local storage, sets badge to green (✓)
2. User clicks extension icon → browser fires `onAction` event to background service worker
3. Background worker injects `sidebar.js` into the active tab; sidebar renders in loading state
4. Background worker opens two background tabs (one per comparison platform) and navigates to each platform's restaurant search
5. `platform-scraper.js` is injected into each tab; intercepts `fetch`/`XHR` responses, captures restaurant search results and menu/pricing API responses, posts them back via `chrome.runtime.sendMessage`
6. Background worker collects both results, runs fuzzy item matching, computes totals
7. Results posted to `sidebar.js` → sidebar UI updates with final comparison

### Session / authentication

No credential handling. Each background tab opens under the user's existing browser session — they are already logged into each platform. Account-specific discounts, credits (e.g. Uber Cash), and loyalty offers are therefore naturally included in the API responses captured by the scraper.

---

## Key Components

### checkout-reader.js

Runs on supported checkout pages. Extracts:
- Restaurant name and location (postcode / coordinates)
- Array of `{ name, quantity, unitPrice }` for each line item
- Delivery fee, service fee, applied promo codes and their discount values
- Platform identifier (derived from hostname)

Sends extracted order to the background worker. Sets the extension badge to green (✓) to indicate the page is supported.

### platform-scraper.js

Injected into background tabs. Intercepts `fetch` and `XMLHttpRequest` calls made by the platform's own JS, filtering for:
- Restaurant search results (to find the matching restaurant)
- Menu / item listing responses (for item prices)
- Basket or delivery estimate responses (for delivery fee, service fee, promotions)

Posts captured JSON payloads to the background worker. Does not modify any requests or responses.

### Background service worker

Orchestrates the full comparison flow:
1. Receives the current order from `checkout-reader.js`
2. On user action, opens two background tabs with each platform's search URL (restaurant name + postcode)
3. Waits for `platform-scraper.js` to report back from each tab (timeout: 15s per platform)
4. Closes background tabs once data is collected
5. Runs `fuse.js` fuzzy match to pair each item in the reference order with the closest item on each comparison platform (match threshold: 0.6 score; below threshold → flagged as "not found")
6. Computes totals: `sum(matched item prices) + delivery fee + service fee − discounts`
7. Sends final `ComparisonResult` to `sidebar.js`

### sidebar.js + sidebar UI

Injected into the checkout page when the user clicks the extension. Renders:
- Header: FeedMe logo, restaurant name, item count, live/loading state, close button
- One card per comparison platform, sorted cheapest-first:
  - Platform name + emoji
  - Per-item price breakdown (unmatched items shown in red with ⚠)
  - Subtotal, delivery, service fee, discounts (savings in green)
  - **Total** (bold, green on winner)
  - Offer/promo tags
  - "Open in X →" button
- Current platform card (muted, shown last — user is already looking at it)
- Footer: summary sentence ("You're saving £X on Uber Eats" or "Switch to Deliveroo to save £X")
  - Caveat shown if any items are unmatched on a platform

---

## Item Matching

Uses `fuse.js` with the following field weights:
- `name` (weight: 0.8)
- `description` (weight: 0.2, if available)

Match threshold: fuse.js score ≤ 0.4 (lower = better match; 0 = exact) → matched. Above threshold → item flagged as "not found" on that platform, excluded from that platform's subtotal, and a ⚠ warning shown on the card with a caveated total ("3 of 4 items matched").

---

## UI Design

**Light mode only (Phase 1).** Sidebar width: 400px, fixed right edge, full viewport height, `z-index: 2147483647` to stay above the host page. Injected via a Shadow DOM root to avoid CSS conflicts with the host page.

Visual language: clean, minimal, white cards with subtle borders. Winner card has a 2px green border and `#f0fdf4` background. Savings amounts in green. Unmatched items in red. Offer tags in pale yellow/green chips.

---

## Error Handling

| Scenario | Behaviour |
|---|---|
| Platform times out (>15s) | Card shows "Could not load — try again" with a retry button |
| Restaurant not found on a platform | Card shows "Restaurant not available on [platform]" |
| Item not matched on a platform | Item shown as "⚠ not found", excluded from total, caveat in footer |
| Extension clicked off a supported page | Popup explains which pages are supported |
| Network error in background tab | Treated same as timeout |

---

## Browser Compatibility

Uses `webextension-polyfill` (Mozilla) to normalise `browser.*` vs `chrome.*` API differences. Targets:
- Chrome 109+ (MV3 stable)
- Firefox 109+ (MV3 support added)

Manifest declares both `chrome_style` and standard MV3 fields. Published to Chrome Web Store and Firefox Add-ons separately.

---

## Phase 2: Auto-build order on "Open in X →"

When the user clicks "Open in X →", open the restaurant on the target platform in a new tab and inject a content script that programmatically adds each matched item to the cart. Complexity: each platform has a different add-to-cart flow; customisation modals (e.g. burger options) require additional handling; bot detection may trigger on rapid sequential interactions. Deferred until Phase 1 is stable.

---

## Out of Scope

- Dark mode (Phase 1 is light mode only)
- Safari support (WebExtensions API coverage differs; can be revisited)
- Mobile browsers
- Non-UK markets
- Saving / history of past comparisons
- Price alerts
