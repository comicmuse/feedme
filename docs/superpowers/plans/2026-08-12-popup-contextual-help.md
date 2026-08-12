# Context-Aware Popup Help Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the misleading idle popup (which lists Deliveroo/Just Eat as start points they cannot be in v1) with context-aware help: full instructions off-platform, a tailored message on-platform, and a clear "start from Uber Eats".

**Architecture:** A pure function `idleStateFor(url)` maps the active tab's URL to one of four state keys using existing `platformFromUrl` + `CHECKOUT_PATTERNS` exports. `popup.js`'s no-order branch queries the active tab, calls it, and unhides the matching static `<div>` in `popup.html`. Only the idle branch changes; `#state-ready` and `#state-blocked` are untouched.

**Tech Stack:** Plain CommonJS module (`src/`), esbuild bundle, Jest (jsdom), webextension-polyfill (shimmed to `null` in Jest via `src/shared/constants.js`).

## Global Constraints

- **Deterministic over heuristic:** state selection is exact URL matching over already-pinned patterns — no fuzzy guesses.
- **Copy must match reality:** v1 captures orders only from Uber Eats; the popup must never present Deliveroo/Just Eat as start points.
- **Bundle discipline:** the popup bundle stays lean — do not pull `sidebar-view.js` in for two label strings; keep a local label map.
- **Build workflow:** `npm run build` refreshes `dist/`; **`npm run package`** must be run right before any live verification, or the loaded extension is stale.
- **Test env:** Jest `testEnvironment` is `jsdom`; requiring `src/shared/constants.js` in a test is safe (`browser` shims to `null`). Do NOT import `src/popup.js` in a test — it self-runs `init()` which touches `browser`.

---

### Task 1: Pure `idleStateFor(url)` module

**Files:**
- Create: `src/popup-help.js`
- Test: `tests/popup-help.test.js`

**Interfaces:**
- Consumes (from `src/shared/constants.js`): `PLATFORM` (`{ UBER_EATS, DELIVEROO, JUST_EAT }`), `CHECKOUT_PATTERNS` (object keyed by platform → RegExp; `CHECKOUT_PATTERNS[PLATFORM.UBER_EATS]` is `/ubereats\.com\/gb\/checkout/`), `platformFromUrl(url)` → `PLATFORM.*` value or `null` (guards URL parsing internally, returns `null` on bad input).
- Produces: `idleStateFor(url)` → `{ key, platform }` where `key` is one of `'elsewhere' | 'uber-other' | 'uber-checkout' | 'destination'` and `platform` is a `PLATFORM.*` value or `null`. `platform` is non-null only for `uber-other`, `uber-checkout`, and `destination`; it is used by the caller solely to label the `destination` message.

- [ ] **Step 1: Write the failing test**

Create `tests/popup-help.test.js`:

```js
const { idleStateFor } = require('../src/popup-help');
const { PLATFORM } = require('../src/shared/constants');

describe('idleStateFor', () => {
  test('Uber Eats checkout URL → uber-checkout', () => {
    expect(idleStateFor('https://www.ubereats.com/gb/checkout?foo=1'))
      .toEqual({ key: 'uber-checkout', platform: PLATFORM.UBER_EATS });
  });

  test('Uber Eats store page → uber-other', () => {
    expect(idleStateFor('https://www.ubereats.com/gb/store/some-place/abc123'))
      .toEqual({ key: 'uber-other', platform: PLATFORM.UBER_EATS });
  });

  test('Uber Eats home → uber-other', () => {
    expect(idleStateFor('https://www.ubereats.com/gb/'))
      .toEqual({ key: 'uber-other', platform: PLATFORM.UBER_EATS });
  });

  test('Deliveroo menu → destination with Deliveroo platform', () => {
    expect(idleStateFor('https://deliveroo.co.uk/menu/london/place'))
      .toEqual({ key: 'destination', platform: PLATFORM.DELIVEROO });
  });

  test('Just Eat menu → destination with Just Eat platform', () => {
    expect(idleStateFor('https://www.just-eat.co.uk/restaurants-x/menu'))
      .toEqual({ key: 'destination', platform: PLATFORM.JUST_EAT });
  });

  test('unrelated site → elsewhere', () => {
    expect(idleStateFor('https://www.google.com/'))
      .toEqual({ key: 'elsewhere', platform: null });
  });

  test('undefined url → elsewhere', () => {
    expect(idleStateFor(undefined)).toEqual({ key: 'elsewhere', platform: null });
  });

  test('empty string url → elsewhere', () => {
    expect(idleStateFor('')).toEqual({ key: 'elsewhere', platform: null });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/popup-help.test.js`
Expected: FAIL — `Cannot find module '../src/popup-help'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/popup-help.js`:

```js
const { PLATFORM, CHECKOUT_PATTERNS, platformFromUrl } = require('./shared/constants');

// Maps the active tab's URL to the idle-popup help state. Pure and deterministic:
// exact host + checkout-pattern matching, no heuristics. A falsy or unrecognised
// URL yields 'elsewhere' (full "start on Uber Eats" instructions), which is the
// safe default — never a blank popup.
function idleStateFor(url) {
  const platform = url ? platformFromUrl(url) : null;
  if (!platform) return { key: 'elsewhere', platform: null };
  if (platform === PLATFORM.UBER_EATS) {
    const key = CHECKOUT_PATTERNS[PLATFORM.UBER_EATS].test(url) ? 'uber-checkout' : 'uber-other';
    return { key, platform };
  }
  // Deliveroo / Just Eat: valid comparison destinations, never v1 sources.
  return { key: 'destination', platform };
}

module.exports = { idleStateFor };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest tests/popup-help.test.js`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add src/popup-help.js tests/popup-help.test.js
git commit -m "feat: idleStateFor maps tab URL to popup help state"
```

---

### Task 2: Four help messages in `popup.html`

**Files:**
- Modify: `popup/popup.html` (the `#state-idle` block, lines 18-25)

**Interfaces:**
- Produces (DOM contract consumed by Task 3): a `#state-idle` container holding four children with ids `#help-elsewhere`, `#help-uber-other`, `#help-uber-checkout`, `#help-destination`, each carrying class `help`. `#help-elsewhere` is visible by default (no `hidden` class); the other three start with `hidden`. `#help-destination` contains a `<span class="platform-name">` placeholder for the platform label.

- [ ] **Step 1: Replace the `#state-idle` block**

In `popup/popup.html`, replace the current block:

```html
  <div id="state-idle">
    <p>Go to the checkout page on a supported platform, then click here to compare prices.</p>
    <ul>
      <li>Uber Eats checkout</li>
      <li>Deliveroo checkout</li>
      <li>Just Eat order page</li>
    </ul>
  </div>
```

with:

```html
  <div id="state-idle">
    <div id="help-elsewhere" class="help">
      <p class="help-title">How to compare prices</p>
      <ol>
        <li>Open your basket on Uber Eats</li>
        <li>Go to the Uber Eats checkout</li>
        <li>Click FeedMe here</li>
      </ol>
      <p class="help-note">Deliveroo &amp; Just Eat are compared automatically — you don't start there.</p>
    </div>
    <div id="help-uber-other" class="help hidden">
      <p>You're on Uber Eats. Open your basket and go to the checkout, then click FeedMe here.</p>
    </div>
    <div id="help-uber-checkout" class="help hidden">
      <p>You're on the Uber Eats checkout — if nothing shows here, add items to your basket, then reopen FeedMe.</p>
    </div>
    <div id="help-destination" class="help hidden">
      <p>You're on <span class="platform-name"></span>. FeedMe compares these for you automatically — but you start from an Uber Eats basket.</p>
    </div>
  </div>
```

- [ ] **Step 2: Verify markup loads without error**

Run: `npx jest tests/manifest.test.js tests/theme.test.js`
Expected: PASS — these do not read popup markup, so they must stay green (sanity that nothing unrelated broke).

- [ ] **Step 3: Commit**

```bash
git add popup/popup.html
git commit -m "feat: four context-aware help messages in idle popup"
```

---

### Task 3: Wire tab context into `popup.js`

**Files:**
- Modify: `src/popup.js` (the `init()` function, lines 27-48)

**Interfaces:**
- Consumes: `idleStateFor(url)` from `src/popup-help.js` (Task 1); the `#help-*` divs and `.platform-name` span from `popup.html` (Task 2); existing `browser.tabs.query` and `browser.storage.session` from the polyfill.
- Produces: no exports (browser entry module).

- [ ] **Step 1: Add the require and a local label map**

At the top of `src/popup.js`, alongside the existing requires, add:

```js
const { idleStateFor } = require('./popup-help');
```

And below the requires, a minimal label map (only Deliveroo/Just Eat ever reach the `destination` state; kept local to avoid pulling `sidebar-view.js` into the popup bundle):

```js
// Only Deliveroo / Just Eat reach the 'destination' state; a two-entry local map
// keeps the popup bundle from depending on the sidebar module for label strings.
const DESTINATION_LABEL = {
  [PLATFORM.DELIVEROO]: 'Deliveroo',
  [PLATFORM.JUST_EAT]: 'Just Eat',
};
```

Add `PLATFORM` to the existing `require('./shared/constants')` destructure at the top of the file (it currently imports `{ MSG, browser }`):

```js
const { MSG, browser, PLATFORM } = require('./shared/constants');
```

- [ ] **Step 2: Add the idle-context branch to `init()`**

In `init()`, the current structure captures an order into `#state-ready` and otherwise leaves `#state-idle` showing static text. Add an `else` branch that selects the help message. Replace the `if (order && order.items.length > 0) { ... }` block's closing so it reads:

```js
  if (order && order.items.length > 0) {
    document.getElementById('state-idle').classList.add('hidden');
    document.getElementById('state-ready').classList.remove('hidden');

    // Use textContent to safely insert restaurant name from external data
    document.getElementById('restaurant-name').textContent = order.restaurantName;
    document.getElementById('item-count').textContent =
      `${order.items.length} item${order.items.length !== 1 ? 's' : ''} · ${order.postcode}`;

    document.getElementById('compare-btn').addEventListener('click', async () => {
      const tabs = await browser.tabs.query({ active: true, currentWindow: true });
      if (!tabs || tabs.length === 0) return;
      await browser.runtime.sendMessage({ type: MSG.START_COMPARISON, tabId: tabs[0].id });
      window.close();
    });
  } else {
    await showIdleHelp();
  }
```

- [ ] **Step 3: Implement `showIdleHelp()`**

Add this function above `init()`:

```js
// Picks the idle-popup help message from the active tab's URL. #help-elsewhere is
// visible by default so a slow/failed tabs.query still shows the full instructions;
// this only swaps to a more specific message when the tab warrants one.
async function showIdleHelp() {
  const tabs = await browser.tabs.query({ active: true, currentWindow: true }).catch(() => []);
  const url = tabs && tabs[0] && tabs[0].url;
  const { key, platform } = idleStateFor(url);
  if (key === 'elsewhere') return; // default div already visible

  document.querySelectorAll('#state-idle .help').forEach((el) => el.classList.add('hidden'));
  const help = document.getElementById(`help-${key}`);
  if (!help) return;
  if (key === 'destination') {
    help.querySelector('.platform-name').textContent = DESTINATION_LABEL[platform] ?? '';
  }
  help.classList.remove('hidden');
}
```

- [ ] **Step 4: Build and verify no syntax/bundle errors**

Run: `npm run build`
Expected: esbuild completes with no errors; `dist/popup.js` is regenerated.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS — all existing tests plus Task 1's 8 new tests green. (No test imports `popup.js`, so the browser entry never runs in Jest.)

- [ ] **Step 6: Commit**

```bash
git add src/popup.js
git commit -m "feat: show context-aware help in idle popup from active tab"
```

---

### Task 4: Package and live-verify the four states

**Files:** none (verification only).

- [ ] **Step 1: Package the loadable extension**

Run: `npm run package`
Expected: `build/chrome/` and `build/firefox/` regenerate with the new `dist/` and `popup/`.

- [ ] **Step 2: Load and check each state manually**

Load `build/chrome/` as the unpacked extension (`chrome://extensions` → Load unpacked → `build/chrome/`; never the repo root). With no order captured, open the popup on each of:

- a non-delivery site (e.g. `google.com`) → **full instructions** (`#help-elsewhere`), including the "Deliveroo & Just Eat are compared automatically" note.
- an Uber Eats non-checkout page (home or a store page) → **"go to your checkout"** (`#help-uber-other`).
- the Uber Eats checkout with an empty basket → **"add items to your basket"** (`#help-uber-checkout`). (With a filled basket, `#state-ready` shows instead — that is the existing captured-order path, unchanged.)
- a Deliveroo menu page and a Just Eat menu page → **"compared automatically… start from an Uber Eats basket"** (`#help-destination`) with the correct platform name in each.

Expected: exactly one help message per popup; the platform name in the destination case matches the site.

- [ ] **Step 3: Commit any copy/style fixes found during verification**

If verification surfaces a wording or layout tweak (e.g. `ol`/`.help-note` spacing), fix in `popup/popup.html` or `popup/popup.css`, re-run `npm run package`, re-check, then commit. Otherwise no commit.

---

## Self-Review

**Spec coverage:**
- Full instructions off-platform → `elsewhere` state, Task 1 test + Task 2 markup. ✓
- Contextual on-platform (Uber not-checkout, Uber checkout, destination) → Tasks 1–3. ✓
- "Start from Uber Eats" made explicit → `#help-elsewhere` steps + destination copy. ✓
- Deliveroo/Just Eat no longer presented as start points → old `<ul>` removed in Task 2. ✓
- Only the idle branch changes; `#state-ready`/`#state-blocked` untouched → Task 3 edits only the `else` branch and requires. ✓
- Deterministic URL logic, unit-tested; DOM wiring verified live → Tasks 1 and 4. ✓
- Plainer `uber-checkout` copy (per spec revision) → Task 2 markup matches. ✓
- Bundle stays lean (local label map, no sidebar-view import) → Task 3 Step 1. ✓

**Placeholder scan:** No TBD/TODO; every code step has literal code; test bodies are concrete. ✓

**Type consistency:** `idleStateFor` returns `{ key, platform }` in Task 1 and is consumed with that exact shape in Task 3. State keys (`elsewhere`/`uber-other`/`uber-checkout`/`destination`) match the `#help-<key>` ids in Task 2. `DESTINATION_LABEL` keyed by `PLATFORM.DELIVEROO`/`PLATFORM.JUST_EAT`, the only non-Uber platforms `idleStateFor` returns. ✓
