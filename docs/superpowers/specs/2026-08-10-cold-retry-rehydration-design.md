# Cold-retry rehydration: a post-idle Retry re-drives the comparison

**Issue:** #122 (remainder of #106). **Date:** 2026-08-10.

## Problem

FeedMe's comparison state lives in an in-memory `Map` in the MV3 service
worker (`service-worker.js:10`), keyed by the source tab id. Chrome terminates
the worker after ~30s idle, so the `Map` vanishes while the sidebar — which
lives in the page — survives with its buttons still clickable.

The interim slice (#106 / PR #121) made a cold `Retry ↻` *explain itself*: both
retry handlers reply `{ ok: false, reason: 'expired' }` when there is no
comparison for the tab, and the sidebar shows "This comparison has expired —
reload the page to compare again."

This issue makes a cold Retry actually **re-drive scraping** instead of only
explaining the expiry.

## Key constraint that shapes the design

Two things survive worker death in `storage.session` (which persists across
worker restarts and is cleared on browser close):

- `currentOrder` — the detected order. A single key, **not** keyed by tab.
- the per-tab **switch mirror** (`switch|<tabId>`), a deliberately minimal
  projection: `platform`, `label`, `switchUrl`, `isCurrent`, `basketPlan`.

The switch mirror carries **nothing to render a comparison card with** — no
totals, no per-item pricing, no deal breakdown. So resolved branches **cannot be
rehydrated for display** from anything persisted. A surgical "restore the
succeeded platforms, re-drive only the failed one" approach would leave every
other platform showing as an empty or degraded row — worse than the current
behaviour.

The live machinery that a warm retry uses — `enumTabs`, `menuTabs`,
`scheduler`, `queued`, `timeouts`, `injectedUrls` — holds tab ids and timer
handles that are meaningless after a worker restart. They are re-*creatable*
from the order, not restorable.

## Decision

**A cold retry is treated as a fresh comparison for that tab.** Rebuild the
comparison from `currentOrder` and re-drive the full scrape across all
platforms, exactly as `START_COMPARISON` does. Tab ids and timers regenerate
naturally; every platform refills with full data; the sidebar is correct rather
than half-restored.

Chosen over surgical rehydration because the persisted mirror cannot re-render
succeeded platforms, so surgical restore is both more complex *and* produces a
worse sidebar.

## What changes

### 1. Factor out `beginComparison(tabId, order)` — service-worker.js

Extract the body of the `START_COMPARISON` handler — everything from building
the `comparison` object (`service-worker.js:156`) through the enumeration loop
(`:197-200`) — into a reusable async function `beginComparison(tabId, order)`.

`beginComparison` does **not** inject the sidebar. `START_COMPARISON` keeps its
own `executeScript(['dist/sidebar.js'])` before calling it (a fresh page load
has no sidebar yet); a cold retry does **not** re-inject, because the surviving
sidebar is the very reason the retry button was clickable. This sidesteps any
sidebar double-injection question entirely.

Result:
- `START_COMPARISON`: read `currentOrder`, inject sidebar, `await beginComparison(tabId, order)`.
- No behavioural change to the initial comparison — same object, same drive.

### 2. Cold-path helper `restartOrExpire(tabId)` — service-worker.js

Both retry handlers share the cold branch. Factor:

```
async function restartOrExpire(tabId) {
  const { currentOrder } = await browser.storage.session.get('currentOrder').catch(() => ({}));
  if (!currentOrder || currentOrder.items.length === 0) {
    return { ok: false, reason: 'expired' };   // unchanged fallback
  }
  await beginComparison(tabId, currentOrder);
  return { ok: true, reason: 'restarted' };
}
```

In `RETRY_PLATFORM` (`:308`) and `RETRY_BRANCH` (`:349`), replace the current
`if (!comparison) { …; return { ok: false, reason: 'expired' }; }` with
`if (!comparison) return restartOrExpire(sender.tab?.id);`. The warm paths
(comparison present) are untouched.

The reply is awaited after the rebuild kicks off enumeration, matching how
`START_COMPARISON` awaits its drive. The distinct `reason: 'restarted'` lets the
sidebar acknowledge before the loading snapshot lands.

### 3. Sidebar: acknowledge `restarted` — sidebar.js + sidebar-view.js

`retry()` (`sidebar.js:239`) currently only handles `res.ok === false`. Add a
positive branch: on `res.reason === 'restarted'`, show an informational (not
error) footer line, e.g. "↻ Session resumed — refreshing comparison…".

Following the #107 seam, the *wording* lives in `sidebar-view.js` as a small
pure function (`resumeNoticeText()`); `sidebar.js` only assembles the element
(a `.ft` line without the `.err` class).

This notice is a **transient acknowledgement**. The authoritative "refreshing"
signal is the fresh comparison's first `COMPARISON_UPDATE`, which resets the
cards to loading spinners via the normal `render()` path — that is what the user
watches refill. The notice may briefly precede or sit above the reset; both are
acceptable and self-consistent.

## Testing

Extend `tests/retry-expired.test.js` (its `browser` stub already covers
`runtime.onMessage`, `storage.session`, `tabs`):

- **Cold `RETRY_PLATFORM` with `currentOrder` present** → replies
  `{ ok: true, reason: 'restarted' }` **and** drives a rebuild (a fresh
  comparison exists / enumeration tabs are opened — assert `tabs.create` was
  called, or that a subsequent warm retry now finds a comparison).
- **Cold `RETRY_BRANCH` with `currentOrder` present** → same.
- **Cold retry with no `currentOrder`** (empty stub) → still replies
  `{ ok: false, reason: 'expired' }` — the fallback is preserved.
- The existing warm-retry `{ ok: true }` and expired tests continue to pass.

`sidebar-view` test: `resumeNoticeText()` returns the expected wording.

Full suite must stay green (the `START_COMPARISON` refactor is covered by
existing tests plus the new cold-retry drive assertions).

## Out of scope / noted limitations

- **`currentOrder` is a single, un-keyed `storage.session` value.** If another
  tab detects a different order after this comparison starts, a cold retry
  rebuilds from that newer order. This is a **pre-existing** limitation of
  `START_COMPARISON`, inherited here deliberately. Keying the order per tab is a
  possible follow-up, out of scope for this issue.
