# Cold-retry rehydration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `Retry ↻` clicked after the MV3 worker has idled out rebuilds the comparison from the order in session storage and re-drives the full scrape, instead of only showing the expired message.

**Architecture:** Extract `START_COMPARISON`'s comparison-building body into a shared `beginComparison(tabId, order)`. Both retry handlers, when they find no live comparison, call a `restartOrExpire(tabId)` helper that rebuilds via `beginComparison` when `currentOrder` is still in session storage (reply `{ok:true, reason:'restarted'}`) or falls back to the existing `{ok:false, reason:'expired'}`. The sidebar acknowledges `restarted` with an informational line; the fresh loading snapshot is the real refresh signal.

**Tech Stack:** Vanilla JS (webextension-polyfill), CommonJS modules, Jest with a mocked `webextension-polyfill`.

## Global Constraints

- **Reply-bearing `onMessage` listeners MUST be async** (return a Promise) or webextension-polyfill drops the reply — this is why the retry handlers are already `async`. Keep them async.
- **`beginComparison` MUST NOT inject the sidebar.** `START_COMPARISON` injects it for a fresh page; a cold retry's sidebar already lives in the page.
- **Do not change the warm paths.** The cold branch triggers only when `comparisons.get(tabId)` is falsy.
- **Wording lives in `src/shared/sidebar-view.js`** (the #107 seam), not inline in `sidebar.js`.
- **Preserve the existing explanatory comments** when moving code into `beginComparison`.
- Resume notice copy, verbatim: `Session resumed — refreshing comparison…`

---

### Task 1: Extract `beginComparison(tabId, order)` (pure refactor)

Move the comparison-building body out of the `START_COMPARISON` handler into a reusable function. No behavioural change — existing tests are the safety net.

**Files:**
- Modify: `src/background/service-worker.js` (the `START_COMPARISON` listener, ~`:145-201`)
- Test: `tests/retry-expired.test.js` (existing warm-retry + expired tests must still pass)

**Interfaces:**
- Produces: `async function beginComparison(tabId, order)` — builds and registers the comparison for `tabId`, runs the permission pre-flight, seeds the current branch, pushes the first update, and drives enumeration for every non-blocked platform. Assumes the sidebar is already present in the tab. Returns a Promise that resolves once enumeration has been kicked off.

- [ ] **Step 1: Add `beginComparison` above the `START_COMPARISON` listener**

Insert this function immediately before the `START_COMPARISON` comment block (`// ── START_COMPARISON …`):

```js
// ── Comparison bootstrap — shared by START_COMPARISON and a cold retry (#122) ─
// Builds the in-memory comparison for a tab and drives the full scrape. Does NOT
// inject the sidebar: START_COMPARISON injects it for a fresh page load, and a
// cold retry's sidebar already lives in the page — that it survived is the very
// reason the retry button was clickable.
async function beginComparison(tabId, order) {
  const { branchCount, maxConcurrent } = await getConfig();

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
    blockedPlatforms: new Map(),       // platform -> revoked origins (#77)
  };
  comparisons.set(tabId, comparison);

  // Pre-flight the host access each platform needs. Firefox revokes these at
  // will, and without this every stage fails silently — the injections below are
  // all swallowed .catch()es, so a revoked platform is indistinguishable from
  // one with no nearby siblings. Blocked platforms are dropped from the run
  // rather than aborting it: the comparison across the platforms that DO have
  // access is still worth having, and is still honest as long as the missing one
  // says why it is missing.
  await Promise.all(ALL_PLATFORMS.map(async (platform) => {
    const missing = await missingOrigins(platform);
    if (missing.length) {
      console.info('[FeedMe permissions]', platform, 'blocked — host access revoked for', missing.join(', '));
      comparison.blockedPlatforms.set(platform, missing);
      comparison.loading.delete(platform);
    }
  }));

  // Seed the current branch from the live order (authoritative, not scraped).
  seedCurrentBranch(comparison);
  // Settle rather than merely push when something is blocked: a blocked platform
  // never enumerates, so nothing else would ever evaluate completion, and with
  // ALL of them blocked the sidebar would sit unfinished forever.
  if (comparison.blockedPlatforms.size) afterBranchSettled(comparison);
  else pushUpdate(comparison);

  for (const platform of ALL_PLATFORMS) {
    if (comparison.blockedPlatforms.has(platform)) continue;
    await startEnumeration(comparison, platform);
  }
}
```

- [ ] **Step 2: Slim the `START_COMPARISON` listener to call it**

Replace the listener body (from `const tabId = msg.tabId;` through the closing of the enumeration `for` loop) so the whole listener reads:

```js
browser.runtime.onMessage.addListener(async (msg) => {
  if (msg.type !== MSG.START_COMPARISON) return;

  const stored = await browser.storage.session.get('currentOrder');
  const order = stored.currentOrder;
  if (!order || order.items.length === 0) return;

  const tabId = msg.tabId;
  await browser.scripting.executeScript({ target: { tabId }, files: ['dist/sidebar.js'] });
  await beginComparison(tabId, order);
});
```

- [ ] **Step 3: Run the existing suite to confirm no behavioural change**

Run: `npx jest tests/retry-expired.test.js -v`
Expected: PASS — all existing tests (cold expired ×2, warm platform retry `{ok:true}`) still green. The warm test exercises `START_COMPARISON` → `beginComparison` end to end.

- [ ] **Step 4: Run the full suite**

Run: `npx jest`
Expected: PASS — the refactor touches only the internal factoring of an already-covered path.

- [ ] **Step 5: Commit**

```bash
git add src/background/service-worker.js
git commit -m "refactor: extract beginComparison from START_COMPARISON (#122)"
```

---

### Task 2: Cold retry rebuilds a fresh comparison

When a retry lands with no live comparison, rebuild from `currentOrder` and re-drive; keep the expired fallback when there is no order to rebuild from.

**Files:**
- Modify: `src/background/service-worker.js` (`RETRY_PLATFORM` `~:305-338`, `RETRY_BRANCH` `~:346-369`; add `restartOrExpire` helper)
- Test: `tests/retry-expired.test.js`

**Interfaces:**
- Consumes: `beginComparison(tabId, order)` from Task 1.
- Produces: `async function restartOrExpire(tabId)` → `{ok:true, reason:'restarted'}` after rebuilding, or `{ok:false, reason:'expired'}` when session storage holds no usable order.

- [ ] **Step 1: Write the failing tests**

Append to `tests/retry-expired.test.js` (inside the top-level `describe` file scope, after the existing describes):

```js
describe('cold retry rebuilds a fresh comparison (#122)', () => {
  // A postcode is required or buildSearchUrl yields no URL and nothing opens a
  // tab; with one, every platform enumerates, so a rebuild is observable as a
  // tabs.create call.
  const order = {
    platform: PLATFORM.UBER_EATS,
    restaurantName: 'Tayyabs',
    postcode: 'E1 1EW',
    items: [{ name: 'Seekh Kebab', unitPrice: 500, quantity: 1 }],
    discounts: [],
    checkoutTotal: 500,
    deliveryFee: 0,
    serviceFee: 0,
  };

  test('a cold platform retry with an order in session storage rebuilds and replies restarted', async () => {
    browser.storage.session.get.mockImplementation(async (key) =>
      key === 'currentOrder' ? { currentOrder: order } : {});
    browser.tabs.create.mockClear();

    const reply = await dispatch(
      { type: MSG.RETRY_PLATFORM, platform: PLATFORM.DELIVEROO },
      { tab: { id: 9001 } },
    );

    expect(reply).toEqual({ ok: true, reason: 'restarted' });
    expect(browser.tabs.create).toHaveBeenCalled();  // enumeration was driven
  });

  test('a cold branch retry with an order in session storage rebuilds and replies restarted', async () => {
    browser.storage.session.get.mockImplementation(async (key) =>
      key === 'currentOrder' ? { currentOrder: order } : {});

    const reply = await dispatch(
      { type: MSG.RETRY_BRANCH, branchKey: 'del|wc' },
      { tab: { id: 9002 } },
    );

    expect(reply).toEqual({ ok: true, reason: 'restarted' });
  });

  test('a cold retry with no order in session storage still replies expired', async () => {
    browser.storage.session.get.mockResolvedValue({});  // nothing stored

    const reply = await dispatch(
      { type: MSG.RETRY_PLATFORM, platform: PLATFORM.DELIVEROO },
      { tab: { id: 9003 } },
    );

    expect(reply).toEqual({ ok: false, reason: 'expired' });
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx jest tests/retry-expired.test.js -t "rebuilds a fresh comparison" -v`
Expected: FAIL — the first two get `{ok:false, reason:'expired'}` (current cold behaviour) instead of `restarted`. (The third already passes; it pins the preserved fallback.)

- [ ] **Step 3: Add the `restartOrExpire` helper**

Insert immediately after `beginComparison` (from Task 1):

```js
// A cold retry (worker idled out, comparison Map empty) rebuilds the comparison
// from the order still in session storage and re-drives the whole scrape — the
// persisted switch mirror carries nothing to re-render succeeded platforms, so a
// fresh full comparison is both simpler and correct (#122). The distinct reason
// lets the sidebar acknowledge the resume; with no order to rebuild from, the
// #106 expired fallback stands.
async function restartOrExpire(tabId) {
  const { currentOrder } = await browser.storage.session.get('currentOrder').catch(() => ({}));
  if (!currentOrder || currentOrder.items.length === 0) {
    console.info('[FeedMe retry] cold retry could not rebuild — no order in session storage for tab', tabId);
    return { ok: false, reason: 'expired' };
  }
  console.info('[FeedMe retry] cold retry — rebuilding a fresh comparison for tab', tabId);
  await beginComparison(tabId, currentOrder);
  return { ok: true, reason: 'restarted' };
}
```

- [ ] **Step 4: Route both cold branches through it**

In the `RETRY_PLATFORM` listener, replace:

```js
  if (!comparison) {
    console.info('[FeedMe retry] platform retry ignored — no comparison for tab', sender.tab?.id);
    return { ok: false, reason: 'expired' };
  }
```

with:

```js
  if (!comparison) return restartOrExpire(sender.tab?.id);
```

In the `RETRY_BRANCH` listener, replace:

```js
  if (!comparison) {
    console.info('[FeedMe retry] branch retry ignored — no comparison for tab', sender.tab?.id);
    return { ok: false, reason: 'expired' };
  }
```

with:

```js
  if (!comparison) return restartOrExpire(sender.tab?.id);
```

- [ ] **Step 5: Run the new tests**

Run: `npx jest tests/retry-expired.test.js -v`
Expected: PASS — all cold-rebuild, cold-expired, and warm tests green.

- [ ] **Step 6: Run the full suite**

Run: `npx jest`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/background/service-worker.js tests/retry-expired.test.js
git commit -m "feat: cold retry rebuilds a fresh comparison and re-drives scraping (#122)"
```

---

### Task 3: Sidebar acknowledges a resumed comparison

Give the `restarted` reply an informational sidebar line, with the wording in the tested view seam.

**Files:**
- Modify: `src/shared/sidebar-view.js` (add `resumeNoticeText`, export it)
- Modify: `src/content/sidebar.js` (import it, add `showResumeNotice`, branch in `retry`)
- Test: `tests/sidebar-view.test.js`

**Interfaces:**
- Produces: `resumeNoticeText()` → the resume copy string.
- Consumes: the `{ok:true, reason:'restarted'}` reply from Task 2.

- [ ] **Step 1: Write the failing wording test**

In `tests/sidebar-view.test.js`, add `resumeNoticeText` to the destructured import from `../src/shared/sidebar-view`, then add:

```js
describe('resumeNoticeText', () => {
  test('names the resumed refresh', () => {
    expect(resumeNoticeText()).toBe('Session resumed — refreshing comparison…');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest tests/sidebar-view.test.js -t resumeNoticeText -v`
Expected: FAIL — `resumeNoticeText is not a function`.

- [ ] **Step 3: Add `resumeNoticeText` in sidebar-view.js**

After the `clickFailureText` function (and its `CLICK_FAILURE_FALLBACK` const), add:

```js
// The positive counterpart to clickFailureText: a cold retry that rebuilt the
// comparison (#122). Shown as an informational line, then superseded by the
// fresh loading snapshot's spinners.
const RESUME_NOTICE_TEXT = 'Session resumed — refreshing comparison…';
function resumeNoticeText() {
  return RESUME_NOTICE_TEXT;
}
```

Add `resumeNoticeText,` to the `module.exports` object (next to `clickFailureText,`).

- [ ] **Step 4: Run the wording test**

Run: `npx jest tests/sidebar-view.test.js -v`
Expected: PASS.

- [ ] **Step 5: Wire it into sidebar.js**

Update the import (`src/content/sidebar.js:13`) to include `resumeNoticeText`:

```js
const {
  PLATFORM_LABEL, formatMoney, clickFailureText, resumeNoticeText, footerView, switchButtonLabel,
} = require('../shared/sidebar-view');
```

Add a `showResumeNotice` next to `showClickFailure`:

```js
// A cold retry rebuilt the comparison (#122): acknowledge it with a plain (not
// error) line. The fresh COMPARISON_UPDATE that follows re-renders the bar to
// loading spinners, which is what the user actually watches refill.
function showResumeNotice() {
  const existing = bar.querySelector('.ft');
  if (existing) existing.remove();
  const ft = document.createElement('div');
  ft.className = 'ft';
  ft.textContent = `↻ ${resumeNoticeText()}`;
  bar.appendChild(ft);
}
```

In `retry()`, replace the final line:

```js
  if (res && res.ok === false) showClickFailure(res.reason);
```

with:

```js
  if (res && res.ok === false) showClickFailure(res.reason);
  else if (res && res.reason === 'restarted') showResumeNotice();
```

- [ ] **Step 6: Run the full suite**

Run: `npx jest`
Expected: PASS.

- [ ] **Step 7: Lint the built extension**

Run: `npm run package && npx web-ext lint --source-dir build/firefox`
Expected: 0 errors / 0 warnings.

- [ ] **Step 8: Commit**

```bash
git add src/shared/sidebar-view.js src/content/sidebar.js tests/sidebar-view.test.js
git commit -m "feat: sidebar acknowledges a resumed comparison on cold retry (#122)"
```

---

## Self-Review

**Spec coverage:**
- Fresh-comparison rebuild → Task 1 (`beginComparison`) + Task 2 (`restartOrExpire`). ✓
- No sidebar re-injection on cold retry → Task 1 keeps injection in `START_COMPARISON` only; `beginComparison` never injects. ✓
- Distinct `restarted` reply + expired fallback preserved → Task 2. ✓
- Explicit resume notice, wording in the seam → Task 3. ✓
- Tests over SW handlers with a cold `comparisons` Map using the existing `browser` stub → Task 2. ✓
- Noted limitation (single un-keyed `currentOrder`) → out of scope by design; no task, correct.

**Placeholder scan:** none — every step carries real code and exact run commands.

**Type consistency:** `beginComparison(tabId, order)` and `restartOrExpire(tabId)` are named and used identically across Tasks 1–2; `resumeNoticeText()` matches between sidebar-view.js, its export, sidebar.js import, and the test; the reason string `'restarted'` matches between worker reply and sidebar branch.
