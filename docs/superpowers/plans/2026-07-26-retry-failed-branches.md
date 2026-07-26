# Retry for Failed Branches and Platform Enumeration (#30) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Retry ↻" affordance to failed branch cards and to platform columns whose enumeration timed out, so a transient failure no longer requires closing and re-opening the whole sidebar.

**Architecture:** Two message types (`RETRY_BRANCH`, `RETRY_PLATFORM`) sent from `sidebar.js` to `service-worker.js`. Both retries reuse existing machinery — a branch retry re-enters the same pending→`pump()`→timeout cycle a fresh branch goes through; a platform retry re-enters the same enumeration bootstrap `START_COMPARISON` uses, extracted into a shared `startEnumeration()` helper. `buildSnapshot()` gains an `enumFailed` flag per platform so the sidebar can tell a genuine timeout apart from a legitimate "no siblings" result.

**Tech Stack:** Plain CommonJS modules (no bundler-specific syntax beyond what's already used), esbuild for bundling (`npm run build`), Jest + jsdom for unit tests (`npm test`). No new dependencies.

## Global Constraints

- No new dependencies — implement with what `package.json` already lists.
- Every rejected/ignored message must log a `console.info('[FeedMe retry] ...', reason)` line — this codebase's established convention (see `[FeedMe switch]` logs) for making a silent no-op diagnosable from a user's console.
- `bad-url` branch errors are permanent and must never show a retry button (confirmed design decision — no disabled-button variant either).
- `buildSnapshot`'s new parameter must be optional with a default, so every existing call site and test keeps working unchanged.
- Match existing code style exactly: comments explain *why*, not *what*; no defensive error handling for states that can't occur; small pure helper functions over inline duplication.

Design spec: `docs/superpowers/specs/2026-07-26-retry-failed-branches-design.md`

---

### Task 1: `RETRY_BRANCH` / `RETRY_PLATFORM` message constants

**Files:**
- Modify: `src/shared/constants.js:40-48`
- Test: `tests/constants.test.js:69-73`

**Interfaces:**
- Produces: `MSG.RETRY_BRANCH` (string `'RETRY_BRANCH'`), `MSG.RETRY_PLATFORM` (string `'RETRY_PLATFORM'`) — consumed by Tasks 3 and 4.

- [ ] **Step 1: Write the failing test**

Edit `tests/constants.test.js`, the existing `'exposes new message types'` test (lines 69-73), to also assert the two new constants:

```js
describe('constants', () => {
  test('exposes new message types', () => {
    expect(MSG.BRANCHES_FOUND).toBe('BRANCHES_FOUND');
    expect(MSG.COMPARISON_UPDATE).toBe('COMPARISON_UPDATE');
    expect(MSG.RETRY_BRANCH).toBe('RETRY_BRANCH');
    expect(MSG.RETRY_PLATFORM).toBe('RETRY_PLATFORM');
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/constants.test.js -t "exposes new message types"`
Expected: FAIL — `expect(received).toBe(expected)` with `received: undefined` for `MSG.RETRY_BRANCH`.

- [ ] **Step 3: Add the constants**

In `src/shared/constants.js`, the `MSG` object (lines 40-48) currently reads:

```js
const MSG = {
  ORDER_DETECTED: 'ORDER_DETECTED',       // checkout-reader -> service-worker
  START_COMPARISON: 'START_COMPARISON',   // popup -> service-worker
  PLATFORM_DATA: 'PLATFORM_DATA',         // platform-scraper -> service-worker
  COMPARISON_RESULT: 'COMPARISON_RESULT', // service-worker -> sidebar
  BRANCHES_FOUND: 'BRANCHES_FOUND',       // enumerator -> service-worker
  COMPARISON_UPDATE: 'COMPARISON_UPDATE', // service-worker -> sidebar (progressive)
  SWITCH_TO_BRANCH: 'SWITCH_TO_BRANCH',   // sidebar -> service-worker (open + build basket)
};
```

Add two entries:

```js
const MSG = {
  ORDER_DETECTED: 'ORDER_DETECTED',       // checkout-reader -> service-worker
  START_COMPARISON: 'START_COMPARISON',   // popup -> service-worker
  PLATFORM_DATA: 'PLATFORM_DATA',         // platform-scraper -> service-worker
  COMPARISON_RESULT: 'COMPARISON_RESULT', // service-worker -> sidebar
  BRANCHES_FOUND: 'BRANCHES_FOUND',       // enumerator -> service-worker
  COMPARISON_UPDATE: 'COMPARISON_UPDATE', // service-worker -> sidebar (progressive)
  SWITCH_TO_BRANCH: 'SWITCH_TO_BRANCH',   // sidebar -> service-worker (open + build basket)
  RETRY_BRANCH: 'RETRY_BRANCH',           // sidebar -> service-worker (retry a failed branch)
  RETRY_PLATFORM: 'RETRY_PLATFORM',       // sidebar -> service-worker (retry a timed-out enumeration)
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest tests/constants.test.js -t "exposes new message types"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/shared/constants.js tests/constants.test.js
git commit -m "feat: add RETRY_BRANCH/RETRY_PLATFORM message types (#30)"
```

---

### Task 2: `buildSnapshot` — `enumFailed` per platform

**Files:**
- Modify: `src/shared/snapshot.js`
- Test: `tests/snapshot.test.js`

**Interfaces:**
- Consumes: nothing new (pure function, same `PLATFORM` constants already imported).
- Produces: `buildSnapshot(order, branches, loadingPlatforms, enumErrors = new Set())` — 4th parameter is optional. Return value's `platforms[i]` objects gain a boolean `enumFailed` field. Consumed by Task 3 (`pushUpdate` passes `comparison.enumErrors`) and Task 4 (`sidebar.js` reads `col.enumFailed`).

- [ ] **Step 1: Write the failing tests**

Add to `tests/snapshot.test.js`, inside the `describe('buildSnapshot', ...)` block (after the existing `'spinner set for platforms still loading...'` test at line 61):

```js
  test('marks a platform enumFailed when enumErrors names it, independent of spinner/branches', () => {
    const snap = buildSnapshot(order, [], new Set(), new Set([PLATFORM.JUST_EAT]));
    const je = snap.platforms.find((p) => p.platform === PLATFORM.JUST_EAT);
    expect(je.enumFailed).toBe(true);
    expect(je.spinner).toBe(false);
    const uber = snap.platforms.find((p) => p.platform === PLATFORM.UBER_EATS);
    expect(uber.enumFailed).toBe(false);
  });
  test('enumFailed defaults to false when the 4th argument is omitted (backward compatible)', () => {
    const snap = buildSnapshot(order, branches(), new Set());
    expect(snap.platforms.every((p) => p.enumFailed === false)).toBe(true);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest tests/snapshot.test.js`
Expected: FAIL on both new tests — `je.enumFailed` is `undefined`, not `true`/`false`.

- [ ] **Step 3: Implement**

In `src/shared/snapshot.js`, change the function signature and the `platforms` map (currently lines 16-24):

```js
function buildSnapshot(order, branches, loadingPlatforms, enumErrors = new Set()) {
  const current = branches.find((b) => b.isCurrent);
  const currentTotal = current && current.status === 'done' ? current.result.total.total : Infinity;

  const platforms = ORDER.map((platform) => ({
    platform,
    spinner: loadingPlatforms.has(platform),
    enumFailed: enumErrors.has(platform),
    branches: branches.filter((b) => b.platform === platform),
  }));
```

(Only the function signature line and the new `enumFailed:` line inside the `ORDER.map` are new; everything else in the file is unchanged.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest tests/snapshot.test.js`
Expected: PASS — all tests in the file, including the two new ones and every pre-existing one (they call `buildSnapshot` with only 3 arguments, exercising the new default).

- [ ] **Step 5: Commit**

```bash
git add src/shared/snapshot.js tests/snapshot.test.js
git commit -m "feat: add enumFailed flag to buildSnapshot (#30)"
```

---

### Task 3: Service-worker — platform enumeration retry

**Files:**
- Modify: `src/background/service-worker.js`

**Interfaces:**
- Consumes: `MSG.RETRY_PLATFORM` (Task 1), `buildSnapshot`'s 4th parameter (Task 2).
- Produces: `comparison.enumErrors: Set<platform>` (read by Task 4's manual verification, and internally by `pushUpdate`); `startEnumeration(comparison, platform): Promise<void>` — reused by `START_COMPARISON`'s bootstrap loop and the new `RETRY_PLATFORM` handler. No test file — this module has no unit-test harness (listeners wire up at import time); verified by `npm run build` here and live in Task 6.

- [ ] **Step 1: Add `enumErrors` to the comparison record**

In the `START_COMPARISON` handler, the comparison object literal (lines 153-165) currently reads:

```js
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
```

Add one field:

```js
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
    enumErrors: new Set(),             // platforms whose enumeration timed out (retryable)
  };
```

- [ ] **Step 2: Extract `startEnumeration` and use it from the bootstrap loop**

Immediately below the `START_COMPARISON` listener (after its closing `});` — currently line 182 — add the new helper:

```js
// ── Enumeration bootstrap — used at initial START_COMPARISON and on retry ───

async function startEnumeration(comparison, platform) {
  const url = buildSearchUrl(platform, comparison.order.restaurantName, comparison.order.postcode);
  if (!url) { onPlatformDone(comparison, platform); return; }
  const bgTab = await browser.tabs.create({ url, active: false });
  comparison.enumTabs.set(bgTab.id, platform);
  comparison.timeouts.set(`enum|${platform}`, setTimeout(
    () => {
      comparison.enumErrors.add(platform);
      onPlatformDone(comparison, platform);
      browser.tabs.remove(bgTab.id).catch(() => {});
    },
    ENUM_TIMEOUT_MS
  ));
}
```

Then replace the `START_COMPARISON` handler's per-platform loop (currently):

```js
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
```

with:

```js
  for (const platform of ALL_PLATFORMS) {
    await startEnumeration(comparison, platform);
  }
```

- [ ] **Step 3: Clear a stale `enumErrors` flag on a late success**

In the `BRANCHES_FOUND` handler, right after the existing `clearTimeout(comparison.timeouts.get(\`enum|${platform}\`));` line, add:

```js
  clearTimeout(comparison.timeouts.get(`enum|${platform}`));
  comparison.enumErrors.delete(platform);
  browser.tabs.remove(sender.tab.id).catch(() => {});
```

(This covers the rare race where the enumeration timeout fired a moment before a genuine late `BRANCHES_FOUND` arrived — the real result should win, not a stale "timed out" flag.)

- [ ] **Step 4: Thread `enumErrors` through `pushUpdate`**

`pushUpdate` currently reads:

```js
function pushUpdate(comparison, done = false) {
  const snapshot = buildSnapshot(comparison.order, [...comparison.branches.values()], comparison.loading);
  browser.tabs.sendMessage(comparison.sourceTabId, {
    type: MSG.COMPARISON_UPDATE, order: comparison.order, snapshot, done,
  }).catch(() => {});
}
```

Change the `buildSnapshot` call to pass the new set:

```js
function pushUpdate(comparison, done = false) {
  const snapshot = buildSnapshot(comparison.order, [...comparison.branches.values()], comparison.loading, comparison.enumErrors);
  browser.tabs.sendMessage(comparison.sourceTabId, {
    type: MSG.COMPARISON_UPDATE, order: comparison.order, snapshot, done,
  }).catch(() => {});
}
```

- [ ] **Step 5: Add the `RETRY_PLATFORM` handler**

Add this new listener right after the `SWITCH_TO_BRANCH` handler's closing `});` (after the line `if (basketPlan.length) pendingBuilds.set(tab.id, { platform: branch.platform, basketPlan });` and its closing `});`):

```js
// ── RETRY_PLATFORM: re-run enumeration for a platform whose scan timed out ──

browser.runtime.onMessage.addListener(async (msg, sender) => {
  if (msg.type !== MSG.RETRY_PLATFORM) return;
  const comparison = comparisons.get(sender.tab?.id);
  if (!comparison) {
    console.info('[FeedMe retry] platform retry ignored — no comparison for tab', sender.tab?.id);
    return;
  }
  if (comparison.loading.has(msg.platform)) {
    console.info('[FeedMe retry] platform retry ignored — already enumerating', msg.platform);
    return;
  }
  comparison.enumErrors.delete(msg.platform);
  comparison.loading.add(msg.platform);
  pushUpdate(comparison);
  await startEnumeration(comparison, msg.platform);
});
```

- [ ] **Step 6: Build to check for syntax errors**

Run: `npm run build`
Expected: exits 0, `dist/service-worker.js` rewritten with no esbuild errors.

- [ ] **Step 7: Run the full test suite (regression check)**

Run: `npx jest`
Expected: PASS — all existing suites still green (this task touches no tested module directly, but a syntax slip would break every suite that requires `constants.js` transitively).

- [ ] **Step 8: Commit**

```bash
git add src/background/service-worker.js
git commit -m "feat: retry a platform's enumeration after a timeout (#30)"
```

---

### Task 4: Service-worker — branch retry

**Files:**
- Modify: `src/background/service-worker.js`

**Interfaces:**
- Consumes: `MSG.RETRY_BRANCH` (Task 1), existing `pump(comparison)` (unchanged — already arms a fresh `MENU_TIMEOUT_MS` timeout when it opens a tab, see `service-worker.js:319-331`).
- Produces: nothing new consumed elsewhere — this is a leaf message handler.

- [ ] **Step 1: Add the `RETRY_BRANCH` handler**

Add this new listener directly after the `RETRY_PLATFORM` handler added in Task 3:

```js
// ── RETRY_BRANCH: re-run a single branch's menu scrape after a failure ──────

browser.runtime.onMessage.addListener((msg, sender) => {
  if (msg.type !== MSG.RETRY_BRANCH) return;
  const comparison = comparisons.get(sender.tab?.id);
  if (!comparison) {
    console.info('[FeedMe retry] branch retry ignored — no comparison for tab', sender.tab?.id);
    return;
  }
  const branch = comparison.branches.get(msg.branchKey);
  if (!branch || branch.status !== 'error' || branch.result?.error === 'bad-url') {
    console.info('[FeedMe retry] branch retry ignored —',
      !branch ? 'unknown branch key' : branch.status !== 'error' ? 'branch is not in an error state' : 'bad-url is permanent, not retryable',
      msg.branchKey);
    return;
  }
  branch.status = 'pending';
  branch.result = null;
  comparison.queued.set(msg.branchKey, { platform: branch.platform });
  comparison.scheduler.add([msg.branchKey]);
  pushUpdate(comparison);
  pump(comparison);
});
```

This mirrors exactly how `BRANCHES_FOUND` (lines 291-310) enqueues a fresh branch: `queued.set` + `scheduler.add` + `pump()`. `pump()` already contains the `switchUrl` null-check (`bad-url` path, already excluded above), tab-open, and `MENU_TIMEOUT_MS` timeout arming — no changes needed there. `pushUpdate` runs before `pump` so the branch already reads as `pending` in the sidebar by the time a second click could land, which is the double-click guard.

- [ ] **Step 2: Build to check for syntax errors**

Run: `npm run build`
Expected: exits 0.

- [ ] **Step 3: Run the full test suite (regression check)**

Run: `npx jest`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/background/service-worker.js
git commit -m "feat: retry a single failed branch's menu scrape (#30)"
```

---

### Task 5: Sidebar — retry buttons and the pending-status crash fix

**Files:**
- Modify: `src/content/sidebar.js`

**Interfaces:**
- Consumes: `MSG.RETRY_BRANCH`, `MSG.RETRY_PLATFORM` (Task 1); `col.enumFailed` from the snapshot (Task 2/3).
- Produces: nothing consumed elsewhere — this is the UI leaf. No test file — `sidebar.js` has no existing unit-test harness (it builds a shadow-DOM UI at script-injection time); verified by `npm run build` here and live in Task 6.

- [ ] **Step 1: Add retry CSS**

In the `<style>` block, the `.errc` rule (line 66) currently reads:

```css
.errc { border:1px solid #fecaca; border-radius:10px; padding:12px; font-size:12px; color:#ef4444; }
```

Change it to a column layout (so a message plus a button stack cleanly) and add a `.retrybtn` rule right after it:

```css
.errc { border:1px solid #fecaca; border-radius:10px; padding:12px; font-size:12px; color:#ef4444;
  display:flex; flex-direction:column; gap:6px; align-items:flex-start; }
.retrybtn { background:#f3f4f6; color:#374151; border:none; border-radius:6px;
  padding:6px 10px; font-size:10px; font-weight:700; cursor:pointer; }
.retrybtn:hover { background:#e5e7eb; }
```

- [ ] **Step 2: Add `retryBranch` and `retryPlatform` senders**

Directly after the existing `switchToBranch` function (lines 149-152):

```js
// Ask the worker to open this branch in a foreground tab and build its basket.
function switchToBranch(branchKey) {
  browser.runtime.sendMessage({ type: MSG.SWITCH_TO_BRANCH, branchKey });
}
```

add:

```js
// Ask the worker to retry a single branch's menu scrape after a failure.
function retryBranch(branchKey) {
  browser.runtime.sendMessage({ type: MSG.RETRY_BRANCH, branchKey });
}

// Ask the worker to retry a platform's enumeration after a timeout.
function retryPlatform(platform) {
  browser.runtime.sendMessage({ type: MSG.RETRY_PLATFORM, platform });
}
```

- [ ] **Step 3: Retry button on a failed branch card, and fix the pending-status crash**

In `buildBranchCard`, the status handling currently reads:

```js
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
```

Replace it with:

```js
  const totalEl = document.createElement('span');
  totalEl.className = 'bt';
  totalEl.textContent = (branch.status === 'error' || branch.status === 'pending') ? '—' : fmt(branchTotal(branch));
  head.appendChild(nameWrap);
  head.appendChild(totalEl);
  card.appendChild(head);

  if (branch.status === 'error') {
    const err = document.createElement('div');
    err.className = 'det';
    err.textContent = `Could not load (${branch.result.error})`;
    card.appendChild(err);
    // 'bad-url' is a permanent origin-validation failure — retrying it fails the
    // same way every time, so no button for it.
    if (branch.result.error !== 'bad-url') {
      const retry = document.createElement('button');
      retry.className = 'retrybtn';
      retry.textContent = 'Retry ↻';
      retry.addEventListener('click', (e) => { e.stopPropagation(); retryBranch(branch.key); });
      card.appendChild(retry);
    }
    return card;
  }
  // A branch a user expanded while it was 'error' stays in the `expanded` Set;
  // a retry flips it back to 'pending', so this card renders again before the
  // scrape resolves. branch.result is null in this state.
  if (branch.status === 'pending') {
    const pending = document.createElement('div');
    pending.className = 'det';
    pending.textContent = 'Retrying…';
    card.appendChild(pending);
    return card;
  }
  const det = document.createElement('div');
```

(Everything from `const det = document.createElement('div');` onward is unchanged.)

- [ ] **Step 4: Retry button on a platform column that timed out**

In `render`, the column empty-state block currently reads:

```js
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
    } else if (col.branches.every((b) => b.isCurrent)) {
```

Add an `enumFailed` branch ahead of the plain "no branches" case:

```js
    if (col.spinner) {
      const sp = document.createElement('div');
      sp.className = 'loading';
      const s = document.createElement('div'); s.className = 'spin';
      sp.appendChild(s); sp.appendChild(document.createTextNode('Finding branches…'));
      colEl.appendChild(sp);
    } else if (col.enumFailed) {
      const none = document.createElement('div');
      none.className = 'errc';
      none.textContent = 'Could not load branches (timeout)';
      const retry = document.createElement('button');
      retry.className = 'retrybtn';
      retry.textContent = 'Retry ↻';
      retry.addEventListener('click', () => retryPlatform(col.platform));
      none.appendChild(retry);
      colEl.appendChild(none);
    } else if (!col.branches.length) {
      const none = document.createElement('div');
      none.className = 'errc';
      none.textContent = 'No branches found';
      colEl.appendChild(none);
    } else if (col.branches.every((b) => b.isCurrent)) {
```

(The rest of the block — the `'No other branches found'` case — is unchanged.)

- [ ] **Step 5: Build to check for syntax errors**

Run: `npm run build`
Expected: exits 0, `dist/sidebar.js` rewritten with no esbuild errors.

- [ ] **Step 6: Run the full test suite (regression check)**

Run: `npx jest`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/content/sidebar.js
git commit -m "feat: retry buttons for failed branches and timed-out platforms (#30)"
```

---

### Task 6: Live verification and issue close-out

**Files:** none (verification only).

This feature's failure paths are 20-30 second real-world timeouts and shadow-DOM UI — outside what the Playwright MCP chromium session can drive (it cannot load the unpacked extension; see `.claude/skills/verify/SKILL.md`). Verification here is a manual real-Chrome pass, matching how every other sidebar-facing change in this project has been checked.

- [ ] **Step 1: Build the unpacked extension**

```bash
npm run package
```

Load `build/` as an unpacked extension in `chrome://extensions` (or reload it if already loaded — remember reloading the extension does NOT re-inject content scripts into already-open tabs; hard-reload the checkout page afterward).

- [ ] **Step 2: Force a branch-level timeout and verify recovery**

Start a comparison on a live checkout page. While a branch's menu tab is loading (visible as a background tab), open DevTools on that tab and set the Network tab to "Offline", or use "Block request URL" on the platform's domain, for at least 20 seconds (`MENU_TIMEOUT_MS`). Confirm:
- The branch's card shows `Could not load (timeout)` with a "Retry ↻" button.
- Re-enable the network, click Retry — the card flips to a "Retrying…" state, then resolves to a normal priced card once the scrape completes.
- Clicking Retry a second time while still pending does nothing (no duplicate tab opens — check `chrome://extensions` background page console for `[FeedMe retry]` logs, or just watch that only one new background tab opens per click).

- [ ] **Step 3: Force a platform-level enumeration timeout and verify recovery**

Before starting a comparison, block the relevant platform's search-URL host in DevTools for at least 30 seconds (`ENUM_TIMEOUT_MS`), then start the comparison. Confirm:
- That platform's column shows "Could not load branches (timeout)" with a "Retry ↻" button (not the plain "No branches found" text).
- Re-enable the network, click Retry — the column shows "Finding branches…" again, then resolves to real branch cards.

- [ ] **Step 4: Confirm the pending-status crash fix**

During Step 2, while the retried branch is in its "Retrying…" state, confirm there are no JavaScript errors in the sidebar's console (open DevTools on the checkout tab, check the Console — the shadow-root `#feedme-root` UI should render "Retrying…" without throwing).

- [ ] **Step 5: Close out the issue**

Once all of the above pass, comment on and close GitHub issue #30 (use `mcp__plugin_github_github__issue_write` or ask the user to click close, per this project's convention of leaving destructive/finalizing GitHub actions to explicit confirmation).
