# Retry for failed branches and platform enumeration (#30)

## Problem

When a branch's menu scrape fails (`sidebar.js` shows `Could not load (timeout)`) or a
platform's enumeration times out (column shows "No branches found"), there is currently
no recovery short of closing the sidebar and re-triggering the whole comparison from the
checkout page. Timeouts (`MENU_TIMEOUT_MS` = 20s per branch, `ENUM_TIMEOUT_MS` = 30s per
platform, in `service-worker.js`) are the common failure and are often transient — slow
SSR, a consent interstitial, a platform having a moment.

## Goal

Add a "Retry ↻" affordance at two levels:
1. A failed branch card — retry just that branch's menu scrape.
2. A platform column whose enumeration timed out — retry that platform's enumeration.

Both reuse existing scheduling/tab-open machinery rather than introducing new state
machines.

## New messages

`src/shared/constants.js` `MSG` gains, sidebar → service-worker:
- `RETRY_BRANCH` — `{ branchKey }`
- `RETRY_PLATFORM` — `{ platform }`

Both follow the existing `SWITCH_TO_BRANCH` pattern: resolve the comparison via
`comparisons.get(sender.tab?.id)`, log and ignore on any invalid state (unknown
comparison, unknown branch/platform, wrong status) — a click that silently does nothing
must be diagnosable from a console log, per existing convention (see `[FeedMe switch]`
logging).

## Branch retry

**Guard (service-worker.js):** the branch must exist, have `status === 'error'`, and
`result.error !== 'bad-url'`. `bad-url` means the scraped link failed origin validation
— permanent, not retryable. No retry button is shown for it at all (confirmed via user
decision — no disabled-button-with-reason variant).

**Reset:** on a valid retry request:
```
branch.status = 'pending';
branch.result = null;
comparison.queued.set(key, { platform: branch.platform });
comparison.scheduler.add([key]);
pushUpdate(comparison);   // flip the UI to pending BEFORE any tab work
pump(comparison);         // opens the tab, arms a fresh MENU_TIMEOUT_MS timeout
```
`pushUpdate` before `pump` is the double-click guard: the retry button disappears (card
renders as pending) as soon as the message is handled, with no separate debounce
needed. `pump()` already contains all the tab-open + timeout-arm logic a fresh branch
goes through — no new logic needed there.

## Platform (enumeration) retry

Only offered when enumeration genuinely **timed out** — not when it legitimately found
zero real siblings (`BRANCHES_FOUND` with an empty list, or the existing "No other
branches found" case where Uber's brand search returns only the source store). These
are correct, permanent answers, not failures.

**Tracking:** `comparison.enumErrors: Set<platform>`. Added only inside the enumeration
timeout callback (currently anonymous, in the `START_COMPARISON` handler's per-platform
loop). Cleared whenever that platform later succeeds via `BRANCHES_FOUND` — covers the
rare race where a stale timeout fires just before a genuine late result arrives.

**Refactor:** extract the per-platform bootstrap (build search URL, open background
tab, register `enumTabs`, arm the `enum|{platform}` timeout) out of `START_COMPARISON`'s
loop body into `startEnumeration(comparison, platform)`. Used both at initial bootstrap
and on retry, so the two paths can't drift.

**Guard:** ignore `RETRY_PLATFORM` if `comparison.loading.has(platform)` already
(enumeration in progress) — same double-click-guard shape as branch retry.

**Reset:** on a valid retry request:
```
comparison.enumErrors.delete(platform);
comparison.loading.add(platform);   // brings back the "Finding branches…" spinner,
                                     // which replaces the retry button in the next render
pushUpdate(comparison);
startEnumeration(comparison, platform);
```

## Snapshot

`src/shared/snapshot.js`: `buildSnapshot(order, branches, loadingPlatforms, enumErrors =
new Set())` — new 4th parameter, optional and backward compatible with existing callers/
tests. Each platform column in the output gains `enumFailed: enumErrors.has(platform)`.

## Sidebar

`src/content/sidebar.js`:
- In `buildBranchCard`'s existing `status === 'error'` block: append a "Retry ↻" button
  (sends `RETRY_BRANCH` with the branch key) unless `branch.result.error === 'bad-url'`.
- In the column empty-state logic (currently: spinner → "No branches found" → "No other
  branches found"): check `col.enumFailed` first and render "Could not load branches
  (timeout)" plus a "Retry ↻" button (sends `RETRY_PLATFORM`) ahead of the existing
  "No branches found" text.

### Bug fix: pending-status crash in `buildBranchCard`

Found while reading the render path. `buildBranchCard` only special-cases
`status === 'error'`; every other status falls through to `const t = branch.result.total`,
which throws when `result` is `null` (the `pending` shape). Today this path is
unreachable — a `pending` branch can only render via `buildBranchCard` if it's the
overall cheapest or the current branch, both of which are always `done`. Retry makes it
reachable: a branch a user expanded while it was `error` (adding its key to the
`expanded` Set) stays expanded after a retry flips it back to `pending`, so the very next
render calls `buildBranchCard` on a pending branch. Fix: add an explicit `pending` case
(e.g. a "Retrying…" state in place of the total/detail rows) so this can't crash.

## Testing

- `tests/snapshot.test.js`: new cases for `enumFailed` per platform, including the
  default-Set backward-compatibility case.
- `service-worker.js` has no existing unit-test harness (listeners wire up at module
  load); branch/platform retry message handling will be verified live via the `verify`
  skill's pipeline, matching how `SWITCH_TO_BRANCH` was verified.
- `sidebar.js` has no existing unit tests (DOM/shadow-root building); left to live
  verification, consistent with current coverage.

## Out of scope

- Disabled-retry-with-reason for `bad-url` (user chose "no button at all").
- Retry back-off / rate-limiting (not requested; timeouts are already 20-30s).
- Any change to the `expanded` Set's lifecycle beyond the crash fix above.
