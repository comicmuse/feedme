# Gated-page Detection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the basket builder tell a page gated behind a blocking modal (Just Eat's unresolved-address dialog) apart from a genuinely-missing item, and report the gate once per run naming the action the user must take.

**Architecture:** A pure `detectPageGate(doc, platform)` composes small deterministic per-signal predicates and returns a gate descriptor `{ reason, action }` or `null`. `buildBasket` probes once up front; when gated it skips clearing and adding entirely, attaches the descriptor to the returned array as `results.gate`, and renders it in the progress overlay via a new `setGate` method. A live cookie-banner audit across all three platforms adds detectors only for banners that actually gate.

**Tech Stack:** Vanilla JS content script (`src/content/basket-builder.js`), Jest + jsdom tests, `verify` skill / Playwright-chromium for the live audit.

## Global Constraints

- The builder acts on the user's REAL basket and MUST NEVER throw — every step is null-safe; a gated run reports and returns, it does not error. (`basket-builder.js:6-8`)
- The builder acts only on explicit user intent (spec #24): when gated it does NOT dismiss the modal or enter an address.
- Matching is by visible name text, deterministic signals over heuristics (user preference; verify on live data).
- `buildBasket`'s return is read as an **array** by ~30 existing test call sites (`.find`, `[0].ok`, `toEqual([...])`). That contract must not change; the gate rides as a property on the array.
- Gate `reason` id: `je-address`. Gate `action` copy (verbatim): `Just Eat needs a delivery address before items can be added — set it, then switch again.`
- Existing helpers available in the module: `DIALOG_SELECTOR` (`:17`), `norm` (`:62`), `dlog` (`:25`), `safeQuery` (`:1079`). Reuse them; do not re-declare.

---

### Task 1: `jeLocationPanel` + `jeUnresolvedFees` predicates

The two deterministic Just Eat signals, as standalone testable predicates. Folded into one task because they are the two halves of the same "JE deliverability unresolved" signal and share a test fixture.

**Files:**
- Modify: `src/content/basket-builder.js` (add predicates near `findOpenDialog`, ~`:884`)
- Test: `tests/basket-builder-gate.test.js` (new)

**Interfaces:**
- Consumes: `DIALOG_SELECTOR`, `norm` from the module.
- Produces:
  - `jeLocationPanel(doc) → boolean` — true when the Just Eat address/location dialog is open.
  - `jeUnresolvedFees(doc) → boolean` — true when the basket panel shows a fee **range** (unresolved address) rather than a single value.
  - Both exported from the module for unit testing.

- [ ] **Step 1: Write the failing test**

Create `tests/basket-builder-gate.test.js`:

```js
/**
 * @jest-environment jsdom
 */
const {
  jeLocationPanel, jeUnresolvedFees,
} = require('../src/content/basket-builder');

// Just Eat's address dialog when no delivery address is resolved (live 2026-08-09,
// Popeyes Whitechapel): a role=dialog asking for the street / "Finding your location".
function mountJeLocationGate() {
  document.body.innerHTML = `
    <main>
      <div class="menu"><button class="item" data-item-id="x">Chicken Sandwich Box Meal</button></div>
      <div role="dialog" aria-modal="true">
        <h2>Where should we deliver?</h2>
        <p>Please enter your street and house number</p>
        <p>Finding your location…</p>
      </div>
    </main>`;
}

// Address dismissed but never set: the basket panel still shows fee RANGES.
function mountJeFeeRangeGate() {
  document.body.innerHTML = `
    <main>
      <div class="menu"><button class="item" data-item-id="x">Chicken Sandwich Box Meal</button></div>
      <aside class="basket">
        <div class="fee-row"><span>Service</span><span>£0.99 - £2.99</span></div>
        <div class="fee-row"><span>Small order</span><span>£0.00 - £2.00</span></div>
      </aside>
    </main>`;
}

// A resolved, usable Just Eat menu: single fee values, no location dialog.
function mountJeResolved() {
  document.body.innerHTML = `
    <main>
      <div class="menu"><button class="item" data-item-id="x">Chicken Sandwich Box Meal</button></div>
      <aside class="basket">
        <div class="fee-row"><span>Service</span><span>£1.49</span></div>
        <div class="fee-row"><span>Delivery</span><span>£2.49</span></div>
      </aside>
    </main>`;
}

describe('Just Eat gate predicates (#110)', () => {
  test('jeLocationPanel: true on the open address dialog', () => {
    mountJeLocationGate();
    expect(jeLocationPanel(document)).toBe(true);
  });

  test('jeLocationPanel: false on a resolved menu', () => {
    mountJeResolved();
    expect(jeLocationPanel(document)).toBe(false);
  });

  test('jeUnresolvedFees: true when fee ranges are shown', () => {
    mountJeFeeRangeGate();
    expect(jeUnresolvedFees(document)).toBe(true);
  });

  test('jeUnresolvedFees: false when fees are single values', () => {
    mountJeResolved();
    expect(jeUnresolvedFees(document)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/basket-builder-gate.test.js`
Expected: FAIL — `jeLocationPanel is not a function` (not yet exported).

- [ ] **Step 3: Write minimal implementation**

In `src/content/basket-builder.js`, just above `findOpenDialog` (~`:884`), add:

```js
// ── Page gates ───────────────────────────────────────────────────────────────
// A "gate" is a blocking page state that stops EVERY line from being added, as
// opposed to a single item being absent. Just Eat will not open a customise
// dialog until it can resolve deliverability, so an unresolved address gates the
// whole run (#110). These signals are deterministic, not heuristic.

// The Just Eat address/location dialog, shown when no delivery address is set.
const JE_LOCATION_RE = /finding your location|enter your (street|address|postcode)|street and house number|where should we deliver/i;
function jeLocationPanel(doc) {
  return [...doc.querySelectorAll(DIALOG_SELECTOR)]
    .some((d) => JE_LOCATION_RE.test(norm(d.textContent)));
}

// Just Eat renders fee RANGES ("£0.99 - £2.99") in the basket panel until an
// address is resolved, and single values once one is. A fee-labelled row that
// still shows a range means deliverability is unresolved. Scoped to a leaf-ish
// row (label and range within one small element) so a menu price range elsewhere
// on the page never trips it.
const FEE_ROW_RE = /\b(service|small order|delivery)\b.*£\s*\d+(?:\.\d{2})?\s*[-–—]\s*£?\s*\d+/i;
function jeUnresolvedFees(doc) {
  return [...doc.querySelectorAll('div,span,li,p,dd,dt,td')]
    .some((el) => el.children.length <= 3 && FEE_ROW_RE.test(norm(el.textContent)));
}
```

Then extend the module exports (`:1161`) to add `jeLocationPanel, jeUnresolvedFees`:

```js
module.exports = { buildBasket, findItemCard, selectModifier, findAddButton, clearBasket, jeLocationPanel, jeUnresolvedFees };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest tests/basket-builder-gate.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/content/basket-builder.js tests/basket-builder-gate.test.js
git commit -m "feat: deterministic Just Eat gate predicates (#110)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: `detectPageGate` compositor

Compose the predicates into one entry point returning a gate descriptor or null. Platform-scoped so non–Just-Eat runs (and the existing platform-less tests) never trip.

**Files:**
- Modify: `src/content/basket-builder.js` (after the predicates from Task 1)
- Test: `tests/basket-builder-gate.test.js` (extend)

**Interfaces:**
- Consumes: `jeLocationPanel`, `jeUnresolvedFees` (Task 1).
- Produces: `detectPageGate(doc, platform) → { reason: 'je-address', action: string } | null`. Exported.

- [ ] **Step 1: Write the failing test**

Append to `tests/basket-builder-gate.test.js` (add `detectPageGate` to the require at the top):

```js
describe('detectPageGate (#110)', () => {
  test('just-eat + location dialog → je-address gate', () => {
    mountJeLocationGate();
    expect(detectPageGate(document, 'just-eat')).toEqual({
      reason: 'je-address',
      action: 'Just Eat needs a delivery address before items can be added — set it, then switch again.',
    });
  });

  test('just-eat + fee ranges → je-address gate', () => {
    mountJeFeeRangeGate();
    expect(detectPageGate(document, 'just-eat')).toMatchObject({ reason: 'je-address' });
  });

  test('just-eat + resolved menu → null', () => {
    mountJeResolved();
    expect(detectPageGate(document, 'just-eat')).toBeNull();
  });

  test('the same gated DOM on another platform → null (JE-only for now)', () => {
    mountJeLocationGate();
    expect(detectPageGate(document, 'uber-eats')).toBeNull();
    expect(detectPageGate(document, 'deliveroo')).toBeNull();
  });

  test('null doc → null', () => {
    expect(detectPageGate(null, 'just-eat')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/basket-builder-gate.test.js -t detectPageGate`
Expected: FAIL — `detectPageGate is not a function`.

- [ ] **Step 3: Write minimal implementation**

Add below the predicates in `src/content/basket-builder.js`:

```js
const JE_ADDRESS_GATE = {
  reason: 'je-address',
  action: 'Just Eat needs a delivery address before items can be added — set it, then switch again.',
};

// Returns a gate descriptor { reason, action } when the page is in a blocking
// state that would fail every line identically, or null when the page is usable.
// Platform-scoped: only Just Eat has a known gate today (cookie-banner detectors
// are added in Task 6 for any platform whose banner actually gates).
function detectPageGate(doc, platform) {
  if (!doc) return null;
  if (platform === 'just-eat' && (jeLocationPanel(doc) || jeUnresolvedFees(doc))) {
    return { ...JE_ADDRESS_GATE };
  }
  return null;
}
```

Add `detectPageGate` to `module.exports`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest tests/basket-builder-gate.test.js`
Expected: PASS (all Task 1 + Task 2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/content/basket-builder.js tests/basket-builder-gate.test.js
git commit -m "feat: detectPageGate composes JE gate signals (#110)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Up-front probe in `buildBasket`

Probe once before clearing/adding. When gated: skip everything, attach `results.gate`, return. When not gated: unchanged behaviour, so "item not found" still reports per line.

**Files:**
- Modify: `src/content/basket-builder.js:1037-1075` (`buildBasket`)
- Test: `tests/basket-builder-gate.test.js` (extend)

**Interfaces:**
- Consumes: `detectPageGate` (Task 2), existing `clearBasket`, `createOverlay`.
- Produces: `buildBasket` still returns the `results` array; when gated the array is empty and carries `results.gate === { reason, action }`, with no clear and no adds performed.

- [ ] **Step 1: Write the failing test**

Append to `tests/basket-builder-gate.test.js` (add `buildBasket` to the require). Reuse a menu with a clickable item so we can prove no add happens:

```js
const fastWait = (fn) => Promise.resolve(fn());

describe('buildBasket gate path (#110)', () => {
  test('gated Just Eat: returns empty results with a gate, adds nothing', async () => {
    mountJeLocationGate();
    let clicked = false;
    document.querySelector('[data-item-id="x"]').addEventListener('click', () => { clicked = true; });
    const plan = [{ id: 'x', name: 'Chicken Sandwich Box Meal', quantity: 1, modifiers: [] }];
    const results = await buildBasket(
      { platform: 'just-eat', basketPlan: plan }, { wait: fastWait, headless: true });
    expect(results).toHaveLength(0);
    expect(results.gate).toMatchObject({ reason: 'je-address' });
    expect(clicked).toBe(false); // never attempted a click on a gated page
  });

  test('usable Just Eat with a genuinely-absent item: still reports it failed, no gate', async () => {
    mountJeResolved(); // no location dialog, single fee values → not gated
    const plan = [{ id: 'nope', name: 'Item Not On This Menu', quantity: 1, modifiers: [] }];
    const results = await buildBasket(
      { platform: 'just-eat', basketPlan: plan }, { wait: fastWait, headless: true });
    expect(results.gate).toBeUndefined();
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ name: 'Item Not On This Menu', added: 0, ok: false });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/basket-builder-gate.test.js -t "gate path"`
Expected: FAIL — the gated test gets a non-empty/attempted result (no probe yet), `results.gate` is undefined.

- [ ] **Step 3: Write minimal implementation**

In `buildBasket`, immediately after the `overlay` is created (`:1044`) and BEFORE the `clearBasket` block (`:1049`), insert:

```js
  // A blocking page state (e.g. Just Eat's unresolved-address dialog) fails every
  // line identically — detect it once, report it, and touch nothing. Acting would
  // mean clicking into a page that refuses adds; leaving the basket untouched is
  // correct when we cannot act (spec #24, #110).
  const gate = detectPageGate(doc, platform);
  if (gate) {
    dlog('page is gated:', gate.reason, '—', gate.action);
    if (overlay) overlay.setGate(gate);
    const gated = [];
    gated.gate = gate;
    return gated;
  }
```

(The `overlay.setGate` method is added in Task 4; under `headless: true` — used by these tests — `overlay` is `null`, so this task's tests pass without it. Do not reorder Tasks 3 and 4 relative to each other beyond this.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest tests/basket-builder-gate.test.js`
Expected: PASS. Then run the whole suite to confirm the probe didn't disturb existing runs (platform-less and JE-variation tests are not gated):

Run: `npx jest tests/basket-builder.test.js tests/basket-builder-just-eat-variation.test.js`
Expected: PASS (unchanged counts).

- [ ] **Step 5: Commit**

```bash
git add src/content/basket-builder.js tests/basket-builder-gate.test.js
git commit -m "feat: buildBasket skips a gated run and reports the gate (#110)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Overlay `setGate` rendering

Render the gate as one prominent blocking notice in the progress overlay — the only surface the user actually sees on a real page — distinct from the per-item "Add these manually" list.

**Files:**
- Modify: `src/content/basket-builder.js:1120-1158` (the `createOverlay` return object)
- Test: `tests/basket-builder-gate.test.js` (extend)

**Interfaces:**
- Consumes: the overlay's existing `box`/`status` shadow-DOM nodes.
- Produces: `overlay.setGate(gate)` — renders `gate.action` in warn colour. Exercised end-to-end through `buildBasket` with `headless: false`.

- [ ] **Step 1: Write the failing test**

Append to `tests/basket-builder-gate.test.js`:

```js
describe('overlay reports the gate (#110)', () => {
  test('setGate renders the action text in the overlay', async () => {
    mountJeLocationGate();
    const plan = [{ id: 'x', name: 'Chicken Sandwich Box Meal', quantity: 1, modifiers: [] }];
    await buildBasket(
      { platform: 'just-eat', basketPlan: plan }, { wait: fastWait }); // headless:false → overlay renders
    const host = document.getElementById('feedme-builder');
    expect(host).not.toBeNull();
    expect(host.shadowRoot.textContent).toContain('needs a delivery address');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/basket-builder-gate.test.js -t "reports the gate"`
Expected: FAIL — `overlay.setGate is not a function` (thrown inside buildBasket's gate branch when `overlay` is non-null).

- [ ] **Step 3: Write minimal implementation**

In the object returned by `createOverlay` (alongside `setClear`, `update`, `finish` — `:1120`), add a `setGate` method. Place it right after `setClear`:

```js
    setGate(gate) {
      title.textContent = 'FeedMe — can’t fill yet';
      status.textContent = '';
      const notice = doc.createElement('div');
      notice.style.cssText = 'margin-top:4px;font-size:12px;font-weight:700;color:var(--fm-warn);';
      notice.textContent = gate.action;
      box.appendChild(notice);
    },
```

(`title`, `status`, `box`, `doc` are all in scope in `createOverlay`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest tests/basket-builder-gate.test.js`
Expected: PASS (all gate tests).

- [ ] **Step 5: Commit**

```bash
git add src/content/basket-builder.js tests/basket-builder-gate.test.js
git commit -m "feat: overlay surfaces the page gate once per run (#110)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Full suite + build + regression check

Confirm nothing regressed and the bundled artifact is rebuilt (the extension loads `dist/basket-builder.js`, and live verification loads `build/`).

**Files:** none (verification only).

- [ ] **Step 1: Run the whole Jest suite**

Run: `npm test`
Expected: PASS, green. Note the total count (memory: worktrees can double counts — check `git worktree list` first if the number looks off).

- [ ] **Step 2: Rebuild the bundle**

Run: `npm run build`
Expected: `dist/basket-builder.js` rebuilt with the new code.

- [ ] **Step 3: Repackage for live verification**

Run: `npm run package`
Expected: `build/` refreshed (per AGENTS.md / memory: always repackage before asking for live verification).

- [ ] **Step 4: Commit any build artifacts if the repo tracks them**

```bash
git add -A && git status
# commit only if dist/ or build/ are tracked and changed:
git commit -m "chore: rebuild bundle for gated-page detection (#110)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>" || echo "nothing to commit"
```

---

### Task 6: Live cookie-banner audit + conditional detectors

Empirical: determine whether an undismissed cookie banner gates item-adding on Uber Eats, Just Eat, or Deliveroo, and add a detector only for those that genuinely gate. Findings are recorded either way.

**Files:**
- Modify (findings): `docs/superpowers/specs/2026-08-11-gated-page-detection-design.md` (add a "Cookie audit results" section)
- Modify (only if a banner gates): `src/content/basket-builder.js`, `tests/basket-builder-gate.test.js`

**Interfaces:**
- Consumes: `detectPageGate` (Task 2). If a gating banner is found, add a `cookieBanner(doc) → boolean` predicate and OR it into `detectPageGate` for the affected platform(s).

- [ ] **Step 1: Audit each platform live**

Using the `verify` skill / Playwright-chromium (memory: user-scoped chromium MCP server), for each of Uber Eats, Just Eat, Deliveroo:
1. Open a restaurant menu page in a context where the cookie banner is present and **undismissed**.
2. Attempt to open an item's customise dialog (click an item card).
3. Record: did the dialog open (banner is cosmetic) or not (banner gates)? Capture the banner's DOM (a stable `data-*`/`id`/role marker + heading text) for any that gate.

- [ ] **Step 2: Record findings**

Add a "Cookie audit results" section to the design doc: per platform, `gates: yes/no`, the DOM marker if yes, date and restaurant used. Commit:

```bash
git add docs/superpowers/specs/2026-08-11-gated-page-detection-design.md
git commit -m "docs: cookie-banner audit findings (#110)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

- [ ] **Step 3 (only if any banner gates): write the failing test**

For each gating platform, pin the captured banner DOM as a fixture in `tests/basket-builder-gate.test.js` and assert `detectPageGate(document, '<platform>')` returns a `cookie-consent` gate. Template:

```js
test('<platform> + undismissed gating cookie banner → cookie-consent gate', () => {
  document.body.innerHTML = `<!-- pinned live banner DOM with its stable marker -->`;
  expect(detectPageGate(document, '<platform>')).toMatchObject({ reason: 'cookie-consent' });
});
```

- [ ] **Step 4 (only if any banner gates): implement the predicate**

```js
// A consent banner that BLOCKS adds (found gating in the Task 6 audit — see the
// design doc's Cookie audit results). Matched by <stable marker from the audit>.
function cookieBanner(doc) {
  return !!safeQuery(doc, '<selector from the audit>');
}
```

Wire into `detectPageGate` for the affected platform(s), returning
`{ reason: 'cookie-consent', action: 'Accept or dismiss the cookie banner to continue.' }`.

- [ ] **Step 5: Run tests + commit**

Run: `npx jest tests/basket-builder-gate.test.js`
Expected: PASS. Then:

```bash
git add src/content/basket-builder.js tests/basket-builder-gate.test.js
git commit -m "feat: detect gating cookie banner(s) (#110)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

(If the audit finds all three banners cosmetic, Steps 3–5 are skipped — the recorded findings in Step 2 satisfy the acceptance criterion that the banners were checked.)

---

## Self-Review

**Spec coverage:**
- Gate detection (deterministic predicates + `detectPageGate`) → Tasks 1–2. ✓
- Up-front probe, skip run, surface once, no clear/adds → Task 3. ✓
- Overlay reporting naming the action → Task 4. ✓
- "Item not found" still distinct on a usable page → Task 3, second test. ✓
- Unit coverage over both paths with gated JE DOM pinned as fixture → Tasks 1–3 fixtures. ✓
- Cookie-banner audit across all three platforms + detectors for gating ones → Task 6. ✓
- No new sidebar channel; overlay is the surface → Task 4. ✓
- Rebuild/repackage before live verification → Task 5. ✓

**Placeholder scan:** No TBD/TODO. Task 6 carries live-derived values (selectors, banner DOM) by necessity — it is an audit whose inputs are the live pages; the procedure, gate shape, action copy, and test/impl templates are all concrete.

**Type consistency:** `jeLocationPanel`/`jeUnresolvedFees` (Task 1) → consumed by `detectPageGate` (Task 2) → consumed by `buildBasket` (Task 3). Gate descriptor `{ reason, action }` identical across Tasks 2–4. `overlay.setGate(gate)` defined in Task 4, called in Task 3's inserted branch. `results.gate` property used consistently in Task 3. Names match throughout.
