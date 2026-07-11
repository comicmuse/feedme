# Clear Basket Before Fill & Switch (#24) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The basket builder empties the target platform's pre-existing basket before scripting the plan in, so the filled basket matches the sidebar comparison.

**Architecture:** A new `clearBasket(doc, platform, wait)` in `src/content/basket-builder.js` drives each platform's own basket UI (remove/decrease buttons) with the builder's existing settle-wait discipline; `buildBasket` runs it once before the plan loop and reports the outcome in the overlay. A defensive handler accepts cross-restaurant "new basket/order?" confirm prompts during adds. Never throws; on failure the fill proceeds with an amber warning (user-confirmed behaviour).

**Tech Stack:** Plain CommonJS content script (esbuild-bundled), Jest + jsdom tests, Playwright MCP for live verification.

**Spec:** `docs/superpowers/specs/2026-07-11-clear-basket-before-fill-design.md`

## Global Constraints

- The builder NEVER throws; every failure degrades to a logged, reported skip (AGENTS.md).
- Every decision logs via `dlog(...)` (`[FeedMe builder]` console trail) — keep it.
- Overlay copy (exact, from spec): success line `Removed N item(s) already in the basket`; failure line `Couldn't clear pre-existing items — check your basket.`
- Platform DOM shapes must be re-probed live before trusting them (AGENTS.md); pin observed shapes in the jsdom tests.
- Work on branch `fix/24-clear-basket-before-fill` off current `main`.
- After any `src/` change, `npm run build` must pass before live verification (the manifest loads `dist/`).

---

### Task 1: `clearBasket` engine

**Files:**
- Modify: `src/content/basket-builder.js` (new section after `dismissDialog`, ~line 262)
- Test: `tests/basket-builder.test.js`

**Interfaces:**
- Consumes: existing helpers `dlog`, `describeEl`, `defaultWait`, `clickEl`, `accessibleName` (all module-local in the same file).
- Produces: `async function clearBasket(doc, platform, wait = defaultWait)` returning `{ hadItems: boolean, cleared: boolean, removed: number }`; `const CLEAR_HOOKS = { 'just-eat': …, 'deliveroo': …, 'uber-eats': … }` where each hook is `{ surface: ((doc) => Element|null) | null, removeButtons: (doc) => Element[] }`. `clearBasket` is added to `module.exports`. Task 2 calls `clearBasket`; Task 4 edits `CLEAR_HOOKS` entries.

- [ ] **Step 1: Create the branch**

```bash
cd /home/colm/git/feedme && git checkout -b fix/24-clear-basket-before-fill
```

- [ ] **Step 2: Write the failing tests**

Append to `tests/basket-builder.test.js` (top of file already requires the module; extend the require):

```js
const { buildBasket, findItemCard, selectModifier, findAddButton, clearBasket } = require('../src/content/basket-builder');
```

(replacing the existing require line), then add at the bottom:

```js
// ── clearBasket ──────────────────────────────────────────────────────────────
// A synthetic Just Eat basket pane: one decrease button per item row, labelled
// "Decrease quantity of X from N to M" (live shape, 2026-07-11). Clicking
// decrements the quantity; at zero the row (and its button) disappears.
function mountBasketPane(rows) {
  const pane = document.createElement('aside');
  pane.id = 'pane';
  document.body.appendChild(pane);
  rows.forEach(({ name, qty }) => {
    const btn = document.createElement('button');
    let n = qty;
    const label = () => `Decrease quantity of ${name} from ${n} to ${n - 1}`;
    btn.setAttribute('aria-label', label());
    btn.addEventListener('click', () => {
      n -= 1;
      if (n <= 0) btn.remove(); else btn.setAttribute('aria-label', label());
    });
    pane.appendChild(btn);
  });
  return pane;
}

describe('clearBasket', () => {
  beforeEach(() => { document.body.innerHTML = ''; });
  const fastWait = (fn) => Promise.resolve(fn());

  test('removes every unit and reports the count (Just Eat shape)', async () => {
    mountBasketPane([{ name: 'Spicy Mayo Dip', qty: 2 }, { name: 'Big Mac Sauce', qty: 1 }]);
    const r = await clearBasket(document, 'just-eat', fastWait);
    expect(r).toEqual({ hadItems: true, cleared: true, removed: 3 });
    expect(document.querySelectorAll('#pane button')).toHaveLength(0);
  });

  test('is a no-op on an empty basket', async () => {
    const r = await clearBasket(document, 'just-eat', fastWait);
    expect(r).toEqual({ hadItems: false, cleared: true, removed: 0 });
  });

  test('is a no-op for an unknown platform', async () => {
    mountBasketPane([{ name: 'Stray', qty: 1 }]);
    const r = await clearBasket(document, 'unknown-platform', fastWait);
    expect(r).toEqual({ hadItems: false, cleared: true, removed: 0 });
    expect(document.querySelectorAll('#pane button')).toHaveLength(1);
  });

  test('stops and reports cleared:false when a removal does not register', async () => {
    // A button whose click changes nothing (platform swallowed it).
    const pane = document.createElement('aside');
    const btn = document.createElement('button');
    btn.setAttribute('aria-label', 'Decrease quantity of Stuck Item from 1 to 0');
    pane.appendChild(btn);
    document.body.appendChild(pane);
    const r = await clearBasket(document, 'just-eat', fastWait);
    expect(r).toEqual({ hadItems: true, cleared: false, removed: 0 });
  });

  test('surfaces a hidden basket view before clearing (Just Eat "View basket")', async () => {
    const view = document.createElement('button');
    view.textContent = 'View basket';
    view.addEventListener('click', () => mountBasketPane([{ name: 'Old Fries', qty: 1 }]));
    document.body.appendChild(view);
    const r = await clearBasket(document, 'just-eat', fastWait);
    expect(r).toEqual({ hadItems: true, cleared: true, removed: 1 });
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

```bash
npx jest tests/basket-builder.test.js -t "clearBasket" 2>&1 | tail -15
```

Expected: FAIL — `clearBasket is not a function` (it isn't exported yet).

- [ ] **Step 4: Implement `clearBasket`**

In `src/content/basket-builder.js`, insert after `dismissDialog` (before `setNativeValue`):

```js
// ── Basket clearing (issue #24) ──────────────────────────────────────────────
// Pre-existing basket items make the filled basket diverge from the sidebar's
// comparison, so the plan starts by emptying the basket via the platform's own
// remove/decrease controls. Per-platform hooks: `surface` (optional) returns a
// control that reveals the basket view when it isn't rendered; `removeButtons`
// returns the current remove/decrease controls. Deliveroo and Uber selectors
// are candidates until the live-verification pass pins them.
const CLEAR_HOOKS = {
  'just-eat': {
    surface: (doc) => [...doc.querySelectorAll('button, [role="button"]')]
      .find((b) => /view basket/i.test(accessibleName(b, doc))) || null,
    removeButtons: (doc) => [...doc.querySelectorAll(
      'button[aria-label^="Decrease quantity"], pie-icon-button[aria-label^="Decrease quantity"]')],
  },
  deliveroo: {
    surface: null,
    removeButtons: (doc) => [...doc.querySelectorAll(
      'button[aria-label^="Remove"], button[aria-label*="decrease" i]')],
  },
  'uber-eats': {
    surface: (doc) => doc.querySelector('[data-testid="view-carts-badge"]'),
    removeButtons: (doc) => [...doc.querySelectorAll(
      '[data-testid*="remove" i], button[aria-label^="Remove" i]')],
  },
};

// Each click removes one UNIT (a decrease at quantity 1 removes the row), so the
// bound is on clicks, not rows. Big enough for any real basket, small enough to
// end a stuck loop quickly.
const MAX_CLEAR_CLICKS = 60;

// Empty the platform basket. Never throws. `cleared: false` means items may
// remain (the caller warns and proceeds — user-confirmed behaviour).
async function clearBasket(doc, platform, wait = defaultWait) {
  const hooks = CLEAR_HOOKS[platform];
  const result = { hadItems: false, cleared: true, removed: 0 };
  if (!hooks || !doc) return result;
  try {
    // A removal is confirmed by the control set changing (a button vanishing or
    // its "from N to M" label decrementing) — the platform's own signal.
    const state = () => hooks.removeButtons(doc).map((b) => accessibleName(b, doc)).join('|');
    if (!hooks.removeButtons(doc).length && hooks.surface) {
      const s = hooks.surface(doc);
      if (s) {
        dlog('clear: surfacing basket view via', describeEl(s, doc));
        clickEl(s);
        await wait(() => hooks.removeButtons(doc).length, { timeout: 3000 });
      }
    }
    for (let i = 0; i < MAX_CLEAR_CLICKS; i++) {
      const buttons = hooks.removeButtons(doc);
      if (!buttons.length) {
        if (result.removed) dlog(`clear: basket empty after ${result.removed} removal(s)`);
        return result;
      }
      result.hadItems = true;
      const before = state();
      dlog('clear: removing via', describeEl(buttons[0], doc));
      clickEl(buttons[0]);
      const settled = await wait(() => state() !== before, { timeout: 4000 });
      if (!settled) {
        dlog('clear: removal did not register — stopping with items left');
        result.cleared = false;
        return result;
      }
      result.removed += 1;
    }
    dlog('clear: hit the click bound with items remaining');
    result.cleared = false;
  } catch (e) {
    dlog('clear: failed —', e && e.message);
    result.cleared = false;
  }
  return result;
}
```

And extend the exports line:

```js
module.exports = { buildBasket, findItemCard, selectModifier, findAddButton, clearBasket };
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
npx jest tests/basket-builder.test.js 2>&1 | tail -5
```

Expected: all pass (existing suite + 5 new).

- [ ] **Step 6: Commit**

```bash
git add src/content/basket-builder.js tests/basket-builder.test.js
git commit -m "feat: clearBasket engine — empty the platform basket via its own UI (#24)"
```

---

### Task 2: Run the clear before the plan; report it in the overlay

**Files:**
- Modify: `src/content/basket-builder.js` (`buildBasket` ~line 368, `createOverlay` ~line 412)
- Test: `tests/basket-builder.test.js`

**Interfaces:**
- Consumes: `clearBasket(doc, platform, wait)` from Task 1.
- Produces: `createOverlay(...)` gains `setClear(clear)`; `buildBasket`'s return value (array of line results) is unchanged.

- [ ] **Step 1: Write the failing tests**

NOTE: the integration tests use `platform: 'deliveroo'` because `findItemCard`
with `platform: 'just-eat'` clicks ONLY `[data-qa="item"]` overlays
(`basket-builder.js:143`), which the synthetic `mountMenu` DOM doesn't render —
the fill half of the test would fail for the wrong reason. Just Eat clear
semantics (unit-by-unit decrease) are covered by Task 1's tests.

Append to `tests/basket-builder.test.js`:

```js
// A synthetic Deliveroo basket sidebar: one "Remove X" button per row, removed
// on click (one-shot rows, unlike Just Eat's per-unit decrease).
function mountRooPane(names) {
  const pane = document.createElement('aside');
  pane.id = 'roo-pane';
  document.body.appendChild(pane);
  names.forEach((name) => {
    const btn = document.createElement('button');
    btn.setAttribute('aria-label', `Remove ${name}`);
    btn.addEventListener('click', () => btn.remove());
    pane.appendChild(btn);
  });
  return pane;
}

describe('buildBasket clears the basket first', () => {
  const fastWait = (fn) => Promise.resolve(fn());
  beforeEach(() => { document.body.innerHTML = ''; });

  test('empties pre-existing items before adding the plan (order matters)', async () => {
    mountMenu();
    const events = [];
    const pane = mountRooPane(['Stale Hot Honey']);
    pane.querySelector('button').addEventListener('click', () => events.push('removed'));
    document.querySelector('[data-item-id="dr-1"]').addEventListener('click', () => events.push('add-clicked'));
    const plan = [{ id: 'dr-1', name: 'Whopper', quantity: 1, modifiers: [], prefillable: true }];
    const results = await buildBasket({ platform: 'deliveroo', basketPlan: plan }, { wait: fastWait, headless: true });
    expect(results[0]).toMatchObject({ ok: true });
    expect(events[0]).toBe('removed');
    expect(events).toContain('add-clicked');
    expect(document.querySelectorAll('#roo-pane button')).toHaveLength(0);
  });

  test('does not clear when the plan is empty', async () => {
    mountRooPane(['Keep Me']);
    await buildBasket({ platform: 'deliveroo', basketPlan: [] }, { wait: fastWait, headless: true });
    expect(document.querySelectorAll('#roo-pane button')).toHaveLength(1);
  });

  test('overlay reports how many pre-existing items were removed', async () => {
    mountMenu();
    mountRooPane(['Stale A', 'Stale B']);
    const plan = [{ id: 'dr-1', name: 'Whopper', quantity: 1, modifiers: [], prefillable: true }];
    await buildBasket({ platform: 'deliveroo', basketPlan: plan }, { wait: fastWait });
    const shadow = document.getElementById('feedme-builder').shadowRoot;
    expect(shadow.textContent).toContain('Removed 2 item(s) already in the basket');
  });

  test('overlay warns in amber when clearing fails, and the fill still runs', async () => {
    mountMenu();
    // Stuck removal: click changes nothing.
    const pane = document.createElement('aside');
    const btn = document.createElement('button');
    btn.setAttribute('aria-label', 'Remove Stuck Item');
    pane.appendChild(btn);
    document.body.appendChild(pane);
    const plan = [{ id: 'dr-1', name: 'Whopper', quantity: 1, modifiers: [], prefillable: true }];
    const results = await buildBasket({ platform: 'deliveroo', basketPlan: plan }, { wait: fastWait });
    expect(results[0]).toMatchObject({ ok: true });
    const shadow = document.getElementById('feedme-builder').shadowRoot;
    expect(shadow.textContent).toContain("Couldn't clear pre-existing items — check your basket.");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npx jest tests/basket-builder.test.js -t "clears the basket first" 2>&1 | tail -15
```

Expected: FAIL — pre-existing pane button still present / overlay text missing (`buildBasket` doesn't clear yet).

- [ ] **Step 3: Implement the integration and overlay line**

In `buildBasket`, after the `const overlay = …` line, insert:

```js
  // Pre-existing basket items would sit under the plan and skew the total away
  // from the sidebar's comparison — empty the basket first (issue #24). A failed
  // clear warns and proceeds: most of a fill is better than none (user-confirmed).
  if (plan.length) {
    const clear = await clearBasket(doc, platform, wait);
    if (overlay) overlay.setClear(clear);
  }
```

In `createOverlay`, add a `clearLine` element and `setClear` method, and let an
uncleared basket extend the overlay's lifetime. Replace the body-construction
lines:

```js
  const status = doc.createElement('div');
  const list = doc.createElement('div');
  list.style.cssText = 'margin-top:6px;color:#ef4444;font-size:11px;';
  box.appendChild(title); box.appendChild(status); box.appendChild(list);
```

with:

```js
  const status = doc.createElement('div');
  const clearLine = doc.createElement('div');
  clearLine.style.cssText = 'margin-top:4px;font-size:11px;color:#6b7280;display:none;';
  const list = doc.createElement('div');
  list.style.cssText = 'margin-top:6px;color:#ef4444;font-size:11px;';
  box.appendChild(title); box.appendChild(status); box.appendChild(clearLine); box.appendChild(list);
  let uncleared = false;
```

and add `setClear` to the returned object (before `update`):

```js
    setClear(clear) {
      if (!clear.hadItems) return;
      clearLine.style.display = 'block';
      if (clear.cleared) {
        clearLine.textContent = `Removed ${clear.removed} item(s) already in the basket`;
      } else {
        uncleared = true;
        clearLine.style.color = '#d97706';
        clearLine.textContent = "Couldn't clear pre-existing items — check your basket.";
      }
    },
```

and in `finish`, change the removal timeout line to keep a warned overlay up:

```js
      setTimeout(() => host.remove(), failed.length || review.length || uncleared ? 12000 : 4000);
```

- [ ] **Step 4: Run the full suite and build**

```bash
npx jest 2>&1 | tail -5 && npm run build 2>&1 | tail -3
```

Expected: all tests pass; build clean.

- [ ] **Step 5: Commit**

```bash
git add src/content/basket-builder.js tests/basket-builder.test.js
git commit -m "feat: buildBasket empties the basket before filling; overlay reports it (#24)"
```

---

### Task 3: Accept cross-restaurant "new basket/order?" confirm prompts

Deliveroo (and historically Just Eat) confirm before replacing another
restaurant's basket; the prompt appears mid-add and would otherwise fail the
line. (Live note 2026-07-11: current JE web silently keeps per-restaurant
baskets — no prompt — so this is defensive there; Deliveroo is the live case.)

**Files:**
- Modify: `src/content/basket-builder.js` (`openItemDialog` ~line 300, `addLine` ~line 322)
- Test: `tests/basket-builder.test.js`

**Interfaces:**
- Consumes: `DIALOG_SELECTOR`, `norm`, `dlog`, `clickEl` (module-local).
- Produces: `function acceptNewBasketPrompt(doc, line)` returning boolean (module-local, not exported); behavioural change only.

- [ ] **Step 1: Write the failing test**

Append to `tests/basket-builder.test.js`:

```js
describe('cross-restaurant new-basket prompt', () => {
  const fastWait = (fn) => Promise.resolve(fn());
  beforeEach(() => { document.body.innerHTML = ''; });

  test('accepts a "start new order?" confirm that blocks the add, then counts the line', async () => {
    mountMenu();
    // First add-click spawns a Deliveroo-style confirm instead of closing the
    // dialog; clicking "New order" removes the confirm AND completes the add.
    const root = document.getElementById('dialog-root');
    let intercepted = false;
    root.addEventListener('click', (e) => {
      if (!e.target.classList.contains('add') || intercepted) return;
      intercepted = true;
      e.stopPropagation();
      const confirm = document.createElement('div');
      confirm.setAttribute('role', 'dialog');
      confirm.id = 'confirm';
      const p = document.createElement('p');
      p.textContent = 'Starting a new order will clear your basket at Popeyes Whitechapel';
      const yes = document.createElement('button');
      yes.textContent = 'New order';
      yes.addEventListener('click', () => { confirm.remove(); root.innerHTML = ''; });
      confirm.appendChild(p); confirm.appendChild(yes);
      document.body.appendChild(confirm);
    }, true);
    const plan = [{ id: 'dr-1', name: 'Whopper', quantity: 1, modifiers: [], prefillable: true }];
    const results = await buildBasket({ platform: 'deliveroo', basketPlan: plan }, { wait: fastWait, headless: true });
    expect(results[0]).toMatchObject({ name: 'Whopper', added: 1, ok: true });
    expect(document.getElementById('confirm')).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx jest tests/basket-builder.test.js -t "new-basket prompt" 2>&1 | tail -12
```

Expected: FAIL — `added: 0, ok: false` (the un-closed dialog fails the line today).

- [ ] **Step 3: Implement the prompt handler**

In `src/content/basket-builder.js`, insert before `addLine`:

```js
// Cross-restaurant switch: adding while another restaurant's basket exists makes
// the platform confirm before replacing it ("Starting a new order will clear your
// basket at …"). Accepting IS the clear (spec #24), so find such a prompt and
// click its affirmative. Excludes the item's own customise dialog by name.
const NEW_BASKET_RE = /\b(new (basket|order)|start (a )?(new|fresh|again)|clear your basket)\b/i;
function acceptNewBasketPrompt(doc, line) {
  const prompt = [...doc.querySelectorAll(DIALOG_SELECTOR)]
    .find((d) => NEW_BASKET_RE.test(norm(d.textContent))
      && !norm(d.textContent).includes(norm(line.name)));
  if (!prompt) return false;
  const yes = [...prompt.querySelectorAll('button, [role="button"], pie-button')]
    .find((b) => NEW_BASKET_RE.test(norm(b.textContent))
      || /^(yes|ok|continue|confirm)$/.test(norm(b.textContent)));
  if (!yes) return false;
  dlog(`"${line.name}": accepting new-basket prompt via`, describeEl(yes, doc));
  clickEl(yes);
  return true;
}
```

In `addLine`, replace:

```js
    if (!closed) {
      dismissDialog(doc, dialog);
      break;
    }
```

with:

```js
    if (!closed) {
      // The add may be blocked by a cross-restaurant confirm — accept it (that
      // IS the basket clear) and re-await the close before failing the line.
      let closedAfterPrompt = false;
      if (acceptNewBasketPrompt(doc, line)) {
        closedAfterPrompt = await wait(() => !doc.contains(dialog), { timeout: 3000 });
        dlog(`"${line.name}": dialog ${closedAfterPrompt ? 'closed' : 'still open'} after accepting the prompt`);
      }
      if (!closedAfterPrompt) {
        dismissDialog(doc, dialog);
        break;
      }
    }
```

In `openItemDialog`, after `if (dialog) return dialog;` add (a prompt can also
block the customise dialog from opening at all):

```js
    if (acceptNewBasketPrompt(doc, line)) continue;
```

- [ ] **Step 4: Run the full suite**

```bash
npx jest 2>&1 | tail -5 && npm run build 2>&1 | tail -3
```

Expected: all pass; build clean.

- [ ] **Step 5: Commit**

```bash
git add src/content/basket-builder.js tests/basket-builder.test.js
git commit -m "feat: accept cross-restaurant new-basket confirm prompts during fill (#24)"
```

---

### Task 4: Live verification on all three platforms; pin real hooks

Follow `.claude/skills/verify/SKILL.md` (inject `dist/basket-builder.js` into the
live page via Playwright MCP `browser_run_code_unsafe`; never base64 the bundle).
The MCP profile already holds stale test baskets to clear. The Deliveroo and
Uber `CLEAR_HOOKS` selectors are candidates — this task replaces them with what
the live DOM actually exposes, then mirrors any change back into the jsdom
fixtures from Task 1.

- [ ] **Step 1: Build and prepare the injection snippet**

```bash
npm run build
```

Write `.playwright-mcp/clear-verify.js` (gitignored) that sets
`window.__feedmeBuild = { platform: '<platform>', basketPlan: [<one cheap real item>] }`
and evals the `dist/basket-builder.js` bundle source (read it into the snippet
with `JSON.stringify`), then polls
`document.getElementById('feedme-builder')?.shadowRoot?.textContent`.

- [ ] **Step 2: Just Eat live pass**

Navigate to `https://www.just-eat.co.uk/restaurants-fortune-cat-bow/menu` (its
basket holds stale kimchi from the #35 probes). Inject with a 1-item plan (e.g.
`{ name: 'Korean Spiced kimchi', quantity: 1, modifiers: [] }`). Expected:
`[FeedMe builder] clear: …` console lines; overlay shows
`Removed 3 item(s) already in the basket` (or the current stale count) and
`✅ … basket filled`; the platform basket then contains ONLY the plan item.
Confirm via the basket pane subtotal (1 × £2.49). If the decrease buttons differ
from `aria-label^="Decrease quantity"`, update `CLEAR_HOOKS['just-eat']` and the
Task 1 fixture to the observed shape.

- [ ] **Step 3: Deliveroo live pass**

Open a Deliveroo menu with items in its basket (add one manually first if the
profile has none: any cheap item on e.g. Popeyes Whitechapel). Dump the basket
sidebar DOM (`browser_evaluate`: serialize the aside/sidebar containing the
basket rows) and pin the real remove/decrease control (tag, aria-label,
data-testid) into `CLEAR_HOOKS.deliveroo` and a new jsdom fixture variant in the
Task 1 describe block (same test body, Deliveroo shape). Re-inject and confirm
the clear + fill as in Step 2. Also exercise Task 3 live if feasible: with a
basket at restaurant A, fill at restaurant B and confirm the "new order" prompt
is accepted and logged.

- [ ] **Step 4: Uber Eats live pass**

Open an Uber store page whose cart has items (add one manually if needed —
anonymous add works). Dump the cart panel DOM behind
`[data-testid="view-carts-badge"]`, pin the real remove control into
`CLEAR_HOOKS['uber-eats']` (scoped so only the CURRENT store's cart is touched —
verify a second store's cart survives) and a jsdom fixture variant. Re-inject
and confirm clear + fill.

- [ ] **Step 5: Re-run the suite and commit the pinned hooks**

```bash
npx jest 2>&1 | tail -5 && npm run build 2>&1 | tail -3
git add src/content/basket-builder.js tests/basket-builder.test.js
git commit -m "fix: pin live-verified basket-clear hooks for Deliveroo and Uber (#24)"
```

(Skip the commit if the candidates already matched the live DOM.)

---

### Task 5: PR

- [ ] **Step 1: Final checks**

```bash
npx jest 2>&1 | tail -5 && npm run build 2>&1 | tail -3 && git log --oneline main..HEAD
```

Expected: suite green, build clean, 3–4 commits.

- [ ] **Step 2: Push and open the PR**

```bash
git push -u origin fix/24-clear-basket-before-fill
gh pr create --title "Clear the basket before filling it in Fill & Switch (#24)" --body "<summary of: clearBasket engine + hooks, overlay reporting, new-basket prompt acceptance, live verification results per platform. Closes #24. Spec: docs/superpowers/specs/2026-07-11-clear-basket-before-fill-design.md>"
```

The PR body must include the live-verification evidence (per-platform: stale
items cleared, fill landed, overlay copy seen) and end with the standard
"🤖 Generated with [Claude Code](https://claude.com/claude-code)" footer.
