# Uber ingredient removals → target "Remove" group — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a user removes an ingredient on Uber (e.g. pickles from a Big Mac), the captured order carries a decline option so the target platform's fill selects "No Pickles".

**Architecture:** Uber's cart shows only the *kept* defaults of a composition group (`Big Mac® Comes With: Sauce, Pickles, …`). The full defaults come from Uber's per-item API `getMenuItemV1`, where each option carries a `defaultQuantity`. Pure diffing logic lives in a new `src/shared/uber-composition.js`; `src/content/checkout-reader.js` does the two bounded, fail-soft fetches and appends the resulting `{ group: 'Remove', name: 'No X', price: 0 }` options. The matcher and basket builder are unchanged — `priceOptions`' existing `isDecline` rules already handle a `No X` option correctly.

**Tech Stack:** Plain CommonJS (`src/shared/` runs in Jest, Node scripts and the esbuild bundles alike), Jest + JSDOM, esbuild.

**Spec:** `docs/superpowers/specs/2026-08-01-uber-ingredient-removals-design.md`

## Global Constraints

- **TDD, always.** Write the failing test, run it, watch it fail, then implement. No exceptions.
- **Deterministic over heuristic.** Removals derive from `defaultQuantity` in platform data, never from guessing. When the data isn't there, emit nothing.
- **The capture must never throw.** Every network call is wrapped; any failure yields no removals, which is exactly the current (PR #32) behaviour.
- **Never widen `options` with composition rows.** The `X Comes With` rows themselves stay excluded from `options`, as PR #32 made them. Only the derived `No X` removals are appended.
- `src/shared/` is plain CommonJS — `require`/`module.exports`, no ESM syntax.
- Keep the `[FeedMe …]` console logging convention; the builder acts on real baskets with no other visibility.
- Run `npm test` before every commit. Run `npm run package` (not just `npm run build`) immediately before any live verification.
- Branch is `feat/33-uber-ingredient-removals`, already created off `main`. Do not commit to `main`.

---

### Task 1: Composition defaults from a `getMenuItemV1` response

**Files:**
- Create: `src/shared/uber-composition.js`
- Create: `tests/uber-composition.test.js`
- Create: `tests/fixtures/ubereats-item-bigmac.json`

**Interfaces:**
- Consumes: nothing.
- Produces: `uberCompositionDefaults(itemDetail) -> Map<string, Map<string, number>>` — outer key is the group title (e.g. `"Big Mac® Comes With"`), inner map is option title → `defaultQuantity`, containing only options with `defaultQuantity >= 1`. Accepts either the raw API envelope (`{ data: { customizationsList } }`) or the inner `data` object.

- [ ] **Step 1: Create the fixture**

This is the live `getMenuItemV1` response for the Big Mac at McDonald's Bethnal Green Road, captured 2026-08-01 and trimmed to the customisation tree plus the identifying fields. Titles, `defaultQuantity`, `minPermitted`, `maxPermitted` and `price` (in pence) are the values observed live. The Medium-meal branch is dropped from the fixture — the Large-meal branch already exercises the nesting and the duplicate group title.

Create `tests/fixtures/ubereats-item-bigmac.json`:

```json
{
  "status": "success",
  "data": {
    "title": "Big Mac®",
    "uuid": "436063f7-19ba-5d0f-ba15-137deab02561",
    "sectionUuid": "82a88175-4085-50b2-9ac1-9cfda241af83",
    "subsectionUuid": "6af6e4d6-c531-53d8-bb5f-82109718d392",
    "price": 589,
    "hasCustomizations": true,
    "customizationsList": [
      {
        "uuid": "b2529750-eb20-55d6-b2d0-2e84ad3f603d",
        "title": "Select Option",
        "minPermitted": 1,
        "maxPermitted": 1,
        "options": [
          {
            "uuid": "4818291b-0d5b-5343-9f53-fa5737df088f",
            "title": "Large Big Mac® Meal",
            "defaultQuantity": 0,
            "price": 280,
            "childCustomizationList": [
              {
                "uuid": "6d1b2c40-0000-0000-0000-00000000000a",
                "title": "Meal Add On",
                "minPermitted": 1,
                "maxPermitted": 1,
                "options": [
                  { "uuid": "a1", "title": "4 Chicken McNuggets®", "defaultQuantity": 0, "price": 259 },
                  { "uuid": "a2", "title": "No Thanks", "defaultQuantity": 0, "price": 0 }
                ]
              },
              {
                "uuid": "0edc9a22-ab2f-529d-89d7-8facb1643db2",
                "title": "Big Mac® Comes With",
                "minPermitted": 0,
                "maxPermitted": 12,
                "options": [
                  { "uuid": "c1", "title": "Sauce", "defaultQuantity": 1, "minPermitted": 0, "maxPermitted": 2, "price": 0 },
                  { "uuid": "c2", "title": "Pickles", "defaultQuantity": 1, "minPermitted": 0, "maxPermitted": 2, "price": 0 },
                  { "uuid": "c3", "title": "Lettuce", "defaultQuantity": 1, "minPermitted": 0, "maxPermitted": 2, "price": 0 },
                  { "uuid": "c4", "title": "Onions", "defaultQuantity": 1, "minPermitted": 0, "maxPermitted": 2, "price": 0 },
                  { "uuid": "c5", "title": "Cheese", "defaultQuantity": 1, "minPermitted": 0, "maxPermitted": 1, "price": 0 },
                  { "uuid": "c6", "title": "Beef Patty", "defaultQuantity": 2, "minPermitted": 0, "maxPermitted": 2, "price": 0 },
                  { "uuid": "c7", "title": "Bun", "defaultQuantity": 1, "minPermitted": 0, "maxPermitted": 1, "price": 0 }
                ]
              },
              {
                "uuid": "452cb4b6-415a-52e1-8b0d-40ec7eec1425",
                "title": "Big Mac® Additions",
                "minPermitted": 0,
                "maxPermitted": 3,
                "options": [
                  { "uuid": "d1", "title": "2x Bacon", "defaultQuantity": 0, "minPermitted": 0, "maxPermitted": 1, "price": 100 },
                  { "uuid": "d2", "title": "Ketchup", "defaultQuantity": 0, "minPermitted": 0, "maxPermitted": 1, "price": 0 },
                  { "uuid": "d3", "title": "Cheese Slice", "defaultQuantity": 0, "minPermitted": 0, "maxPermitted": 1, "price": 60 }
                ]
              }
            ]
          },
          {
            "uuid": "3833a77f-0675-50b1-8e0d-55950dc0970c",
            "title": "Big Mac®",
            "defaultQuantity": 0,
            "price": 0,
            "childCustomizationList": [
              {
                "uuid": "0edc9a22-ab2f-529d-89d7-8facb1643db2",
                "title": "Big Mac® Comes With",
                "minPermitted": 0,
                "maxPermitted": 12,
                "options": [
                  { "uuid": "c1", "title": "Sauce", "defaultQuantity": 1, "minPermitted": 0, "maxPermitted": 2, "price": 0 },
                  { "uuid": "c2", "title": "Pickles", "defaultQuantity": 1, "minPermitted": 0, "maxPermitted": 2, "price": 0 },
                  { "uuid": "c3", "title": "Lettuce", "defaultQuantity": 1, "minPermitted": 0, "maxPermitted": 2, "price": 0 },
                  { "uuid": "c4", "title": "Onions", "defaultQuantity": 1, "minPermitted": 0, "maxPermitted": 2, "price": 0 },
                  { "uuid": "c5", "title": "Cheese", "defaultQuantity": 1, "minPermitted": 0, "maxPermitted": 1, "price": 0 },
                  { "uuid": "c6", "title": "Beef Patty", "defaultQuantity": 2, "minPermitted": 0, "maxPermitted": 2, "price": 0 },
                  { "uuid": "c7", "title": "Bun", "defaultQuantity": 1, "minPermitted": 0, "maxPermitted": 1, "price": 0 }
                ]
              }
            ]
          }
        ]
      }
    ]
  }
}
```

- [ ] **Step 2: Write the failing tests**

Create `tests/uber-composition.test.js`:

```js
const { uberCompositionDefaults } = require('../src/shared/uber-composition');
const bigMac = require('./fixtures/ubereats-item-bigmac.json');

describe('uberCompositionDefaults', () => {
  test('finds a "Comes With" group nested under childCustomizationList', () => {
    const defaults = uberCompositionDefaults(bigMac);
    expect([...defaults.keys()]).toEqual(['Big Mac® Comes With']);
  });

  test('records each default option with its defaultQuantity', () => {
    const group = uberCompositionDefaults(bigMac).get('Big Mac® Comes With');
    expect([...group.entries()]).toEqual([
      ['Sauce', 1], ['Pickles', 1], ['Lettuce', 1], ['Onions', 1],
      ['Cheese', 1], ['Beef Patty', 2], ['Bun', 1],
    ]);
  });

  test('ignores non-composition groups (Additions, Select Option, Meal Add On)', () => {
    const defaults = uberCompositionDefaults(bigMac);
    expect(defaults.has('Big Mac® Additions')).toBe(false);
    expect(defaults.has('Select Option')).toBe(false);
    expect(defaults.has('Meal Add On')).toBe(false);
  });

  test('keeps only options that are actually defaults (defaultQuantity >= 1)', () => {
    const detail = { data: { customizationsList: [{
      title: 'Wrap Comes With', options: [
        { title: 'Lettuce', defaultQuantity: 1 },
        { title: 'Jalapenos', defaultQuantity: 0 },
      ],
    }] } };
    expect([...uberCompositionDefaults(detail).get('Wrap Comes With').keys()]).toEqual(['Lettuce']);
  });

  test('merges the same group title repeated across meal branches', () => {
    // The fixture carries "Big Mac® Comes With" twice (Large meal + plain item)
    // with identical options; one merged entry is the right answer.
    expect(uberCompositionDefaults(bigMac).get('Big Mac® Comes With').size).toBe(7);
  });

  test('drops a group title whose defaults genuinely conflict rather than guessing', () => {
    const detail = { data: { customizationsList: [
      { title: 'Burger Comes With', options: [{ title: 'Cheese', defaultQuantity: 1 }] },
      { title: 'Burger Comes With', options: [{ title: 'Cheese', defaultQuantity: 2 }] },
    ] } };
    expect(uberCompositionDefaults(detail).has('Burger Comes With')).toBe(false);
  });

  test('accepts the inner data object as well as the response envelope', () => {
    expect(uberCompositionDefaults(bigMac.data).get('Big Mac® Comes With').size).toBe(7);
  });

  test('returns an empty map for junk input', () => {
    expect(uberCompositionDefaults(null).size).toBe(0);
    expect(uberCompositionDefaults({}).size).toBe(0);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx jest tests/uber-composition.test.js`
Expected: FAIL — `Cannot find module '../src/shared/uber-composition'`.

- [ ] **Step 4: Write the implementation**

Create `src/shared/uber-composition.js`:

```js
// Uber renders an item's ingredient composition in the cart as one comma-joined
// row of the *kept* defaults ("Big Mac® Comes With: Sauce, Pickles, …"), so an
// ingredient the user removed shows up only as an absence. The full defaults are
// not on the store page — the store catalog blob carries no customisation data at
// all (probed live 2026-08-01) — they come from the per-item getMenuItemV1 API,
// where every option carries its defaultQuantity. Diffing the two yields the
// removals, which the target platform models as explicit "No X" options (#33).

// Composition groups are titled "<Item> Comes With"; every other group
// (additions, size pickers, add-ons) is a real selection group.
const COMES_WITH_RE = /\bcomes with$/i;

const sameDefaults = (a, b) =>
  a.size === b.size && [...a].every(([name, qty]) => b.get(name) === qty);

/**
 * Index an item's default composition from a getMenuItemV1 response.
 *
 * Customisation groups nest: each option may carry its own
 * `childCustomizationList`, so a meal's composition hangs several levels below
 * the top-level "Select Option" group. One item response repeats the same
 * composition group under every size branch (plain / Medium meal / Large meal)
 * with identical options, so entries merge by title. A title seen with genuinely
 * different defaults is dropped rather than resolved by guessing — same rule as
 * `uberCatalogIdByName` applies to a name with two uuids.
 *
 * @param {object} itemDetail the API response, or its inner `data` object
 * @returns {Map<string, Map<string, number>>} group title -> (option title -> defaultQuantity)
 */
function uberCompositionDefaults(itemDetail) {
  const byGroup = new Map();
  const conflicting = new Set();
  const walkGroup = (group) => {
    const title = String(group?.title ?? '').trim();
    const options = Array.isArray(group?.options) ? group.options : [];
    if (COMES_WITH_RE.test(title) && !conflicting.has(title)) {
      const defaults = new Map();
      for (const opt of options) {
        const name = String(opt?.title ?? '').trim();
        const qty = opt?.defaultQuantity ?? 0;
        if (name && qty >= 1) defaults.set(name, qty);
      }
      const existing = byGroup.get(title);
      if (existing == null) {
        byGroup.set(title, defaults);
      } else if (!sameDefaults(existing, defaults)) {
        byGroup.delete(title);
        conflicting.add(title);
      }
    }
    for (const opt of options) {
      for (const child of opt?.childCustomizationList ?? []) walkGroup(child);
    }
  };
  const root = itemDetail?.data ?? itemDetail;
  for (const group of root?.customizationsList ?? []) walkGroup(group);
  return byGroup;
}

module.exports = { uberCompositionDefaults };
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx jest tests/uber-composition.test.js`
Expected: PASS, 8 tests.

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: all green (existing count + 8).

- [ ] **Step 7: Commit**

```bash
git add src/shared/uber-composition.js tests/uber-composition.test.js tests/fixtures/ubereats-item-bigmac.json
git commit -m "feat: index Uber item composition defaults from getMenuItemV1 (#33)"
```

---

### Task 2: Diff kept list against defaults to produce removals

**Files:**
- Modify: `src/shared/uber-composition.js`
- Modify: `tests/uber-composition.test.js`

**Interfaces:**
- Consumes: `uberCompositionDefaults` from Task 1.
- Produces: `uberRemovals(compositionRows, defaults) -> Array<{group: string, name: string, price: number}>`. `compositionRows` is an array of `{ group, name }` where `group` is the cart's group label (`"Big Mac® Comes With"`) and `name` is the comma-joined kept list. Returns one `{ group: 'Remove', name: 'No <option>', price: 0 }` per default absent from the kept list.

- [ ] **Step 1: Write the failing tests**

Append to `tests/uber-composition.test.js`:

```js
const { uberRemovals } = require('../src/shared/uber-composition');

describe('uberRemovals', () => {
  const defaults = () => uberCompositionDefaults(bigMac);
  const row = (name) => [{ group: 'Big Mac® Comes With', name }];

  test('a removed ingredient becomes a decline option in a "Remove" group', () => {
    const kept = 'Sauce, Lettuce, Onions, Cheese, 2 Beef Patty, Bun';
    expect(uberRemovals(row(kept), defaults())).toEqual([
      { group: 'Remove', name: 'No Pickles', price: 0 },
    ]);
  });

  test('every default kept yields no removals', () => {
    const kept = 'Sauce, Pickles, Lettuce, Onions, Cheese, 2 Beef Patty, Bun';
    expect(uberRemovals(row(kept), defaults())).toEqual([]);
  });

  test('several removals come back in the group\'s own order', () => {
    const kept = 'Sauce, Lettuce, Cheese, 2 Beef Patty, Bun';
    expect(uberRemovals(row(kept), defaults())).toEqual([
      { group: 'Remove', name: 'No Pickles', price: 0 },
      { group: 'Remove', name: 'No Onions', price: 0 },
    ]);
  });

  test('a quantity prefix is stripped when matching ("2 Beef Patty")', () => {
    // Without stripping, "2 Beef Patty" wouldn't match the default named
    // "Beef Patty" and every Big Mac would claim the patties were removed.
    const kept = 'Sauce, Pickles, Lettuce, Onions, Cheese, 2 Beef Patty, Bun';
    expect(uberRemovals(row(kept), defaults())).toEqual([]);
  });

  test('a quantity reduced but not to zero emits nothing (no target models it)', () => {
    // Beef Patty default 2, kept 1: still present, so not a removal.
    const kept = 'Sauce, Pickles, Lettuce, Onions, Cheese, Beef Patty, Bun';
    expect(uberRemovals(row(kept), defaults())).toEqual([]);
  });

  test('an unknown group yields nothing rather than declining every default', () => {
    const rows = [{ group: 'Side Salad Comes With', name: 'Cucumber, Tomato' }];
    expect(uberRemovals(rows, defaults())).toEqual([]);
  });

  test('handles empty and junk input without throwing', () => {
    expect(uberRemovals([], defaults())).toEqual([]);
    expect(uberRemovals(null, defaults())).toEqual([]);
    expect(uberRemovals(row('Sauce'), new Map())).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest tests/uber-composition.test.js -t uberRemovals`
Expected: FAIL — `uberRemovals is not a function`.

- [ ] **Step 3: Write the implementation**

Add to `src/shared/uber-composition.js`, above `module.exports`:

```js
// The cart packs the kept defaults into one comma-joined value, each entry
// optionally prefixed with its quantity ("2 Beef Patty"). Strip the prefix so
// the name matches the catalogue option it came from.
function keptNames(value) {
  const kept = new Set();
  for (const part of String(value ?? '').split(',')) {
    const name = part.trim().replace(/^\d+\s+/, '');
    if (name) kept.add(name);
  }
  return kept;
}

/**
 * Diff the cart's kept composition against the item's defaults.
 *
 * A default missing from the kept list is an ingredient the user removed on
 * Uber. It's emitted as a decline in a synthetic "Remove" group: `priceOptions`
 * already treats a name matching /^(no|none|without)\b/ as a decline, so it can
 * only resolve to another decline inside the target's own Remove-style group,
 * and clean-skips when the target has no such group. Carrying the source group
 * name instead would fuzzy-match nothing on any target.
 *
 * A quantity that was reduced but not to zero (2 patties -> 1) emits nothing:
 * no target platform models a partial reduction, so there is nothing honest to
 * put in the plan.
 *
 * @param {Array<{group: string, name: string}>} compositionRows cart "Comes With" rows
 * @param {Map<string, Map<string, number>>} defaults from uberCompositionDefaults
 * @returns {Array<{group: string, name: string, price: number}>}
 */
function uberRemovals(compositionRows, defaults) {
  const removals = [];
  for (const row of compositionRows ?? []) {
    const groupDefaults = defaults?.get(String(row?.group ?? '').trim());
    if (!groupDefaults) continue;
    const kept = keptNames(row?.name);
    for (const name of groupDefaults.keys()) {
      if (!kept.has(name)) removals.push({ group: 'Remove', name: `No ${name}`, price: 0 });
    }
  }
  return removals;
}
```

Update the export line:

```js
module.exports = { uberCompositionDefaults, uberRemovals };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx jest tests/uber-composition.test.js`
Expected: PASS, 15 tests.

- [ ] **Step 5: Run the full suite and commit**

```bash
npm test
git add src/shared/uber-composition.js tests/uber-composition.test.js
git commit -m "feat: derive Uber ingredient removals by diffing kept list against defaults (#33)"
```

---

### Task 3: Index cart-line item ids from the draft-order response

**Files:**
- Modify: `src/shared/uber-composition.js`
- Modify: `tests/uber-composition.test.js`
- Create: `tests/fixtures/ubereats-draft-orders.json`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `uberCartItemIds(draftOrders) -> Map<string, {storeUuid, sectionUuid, subsectionUuid, itemUuid}>` keyed by **normalised** item title (lowercased, whitespace-collapsed), and `normalizeTitle(s) -> string` used for both indexing and lookup.

**Why title, not line:** `getMenuItemV1` returns the defaults for an *item*, not for a cart line's particular customisations. Two Big Mac lines with different removals need the same lookup, so a title index is sufficient — and it sidesteps having to pair DOM rows with draft-order entries.

**Note for later:** the checkout DOM's `data-testid="cart-item-…"` suffix may already carry the item uuid. If a live check shows it does, this index can be replaced by reading the testid — a strictly simpler equivalent, worth filing as a follow-up rather than blocking this change.

- [ ] **Step 1: Create the fixture**

The key names below are the ones observed live on `getDraftOrdersByEaterUuidV1` (2026-08-01); the values are synthetic, and the store/section/item uuids match `ubereats-item-bigmac.json` so the two fixtures compose.

Create `tests/fixtures/ubereats-draft-orders.json`:

```json
{
  "status": "success",
  "data": {
    "draftOrders": [
      {
        "uuid": "draft-mcdonalds",
        "storeUuid": "7c0b936e-53cc-4f7b-9558-b41691071f19",
        "shoppingCart": {
          "items": [
            {
              "shoppingCartItemUuid": "line-1",
              "uuid": "436063f7-19ba-5d0f-ba15-137deab02561",
              "storeUuid": "7c0b936e-53cc-4f7b-9558-b41691071f19",
              "sectionUuid": "82a88175-4085-50b2-9ac1-9cfda241af83",
              "subsectionUuid": "6af6e4d6-c531-53d8-bb5f-82109718d392",
              "quantity": 1,
              "title": "Big Mac®",
              "price": 589,
              "customizations": []
            },
            {
              "shoppingCartItemUuid": "line-2",
              "uuid": "0e7c3532-80b3-5277-a8d5-c5220363445b",
              "storeUuid": "7c0b936e-53cc-4f7b-9558-b41691071f19",
              "sectionUuid": "82a88175-4085-50b2-9ac1-9cfda241af83",
              "subsectionUuid": "6af6e4d6-c531-53d8-bb5f-82109718d392",
              "quantity": 1,
              "title": "Big Arch® with Bacon",
              "price": 1089,
              "customizations": []
            }
          ]
        }
      },
      {
        "uuid": "draft-other-store",
        "storeUuid": "8e519a15-5e64-549e-a463-1a0840e33ca7",
        "shoppingCart": {
          "items": [
            {
              "shoppingCartItemUuid": "line-3",
              "uuid": "aaaaaaaa-0000-0000-0000-000000000001",
              "storeUuid": "8e519a15-5e64-549e-a463-1a0840e33ca7",
              "sectionUuid": "bbbbbbbb-0000-0000-0000-000000000001",
              "subsectionUuid": "cccccccc-0000-0000-0000-000000000001",
              "quantity": 2,
              "title": "Whopper",
              "price": 799,
              "customizations": []
            }
          ]
        }
      }
    ]
  }
}
```

- [ ] **Step 2: Write the failing tests**

Append to `tests/uber-composition.test.js`:

```js
const { uberCartItemIds, normalizeTitle } = require('../src/shared/uber-composition');
const drafts = require('./fixtures/ubereats-draft-orders.json');

describe('uberCartItemIds', () => {
  test('indexes every cart line across every draft order by normalised title', () => {
    const ids = uberCartItemIds(drafts.data.draftOrders);
    expect([...ids.keys()].sort()).toEqual(['big arch® with bacon', 'big mac®', 'whopper']);
  });

  test('carries the four ids getMenuItemV1 needs', () => {
    expect(uberCartItemIds(drafts.data.draftOrders).get('big mac®')).toEqual({
      storeUuid: '7c0b936e-53cc-4f7b-9558-b41691071f19',
      sectionUuid: '82a88175-4085-50b2-9ac1-9cfda241af83',
      subsectionUuid: '6af6e4d6-c531-53d8-bb5f-82109718d392',
      itemUuid: '436063f7-19ba-5d0f-ba15-137deab02561',
    });
  });

  test('the same title in two lines is one entry, not an ambiguity', () => {
    // Two Big Mac lines with different removals share one item, so the second
    // occurrence must not knock the entry out.
    const twice = [{ shoppingCart: { items: [
      ...drafts.data.draftOrders[0].shoppingCart.items,
      { ...drafts.data.draftOrders[0].shoppingCart.items[0], shoppingCartItemUuid: 'line-1b' },
    ] } }];
    expect(uberCartItemIds(twice).has('big mac®')).toBe(true);
  });

  test('a title genuinely pointing at two different items is dropped', () => {
    const conflicting = [{ shoppingCart: { items: [
      drafts.data.draftOrders[0].shoppingCart.items[0],
      { ...drafts.data.draftOrders[0].shoppingCart.items[0], uuid: 'different-item-uuid' },
    ] } }];
    expect(uberCartItemIds(conflicting).has('big mac®')).toBe(false);
  });

  test('a line missing any id is skipped rather than half-indexed', () => {
    const partial = [{ shoppingCart: { items: [
      { uuid: 'x', storeUuid: 'y', title: 'Half Item' },
    ] } }];
    expect(uberCartItemIds(partial).size).toBe(0);
  });

  test('handles junk input without throwing', () => {
    expect(uberCartItemIds(null).size).toBe(0);
    expect(uberCartItemIds([{}]).size).toBe(0);
  });
});

describe('normalizeTitle', () => {
  test('lowercases and collapses whitespace so img alt text matches cart titles', () => {
    expect(normalizeTitle('  Big   Mac®  ')).toBe('big mac®');
    expect(normalizeTitle(null)).toBe('');
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx jest tests/uber-composition.test.js -t uberCartItemIds`
Expected: FAIL — `uberCartItemIds is not a function`.

- [ ] **Step 4: Write the implementation**

Add to `src/shared/uber-composition.js`, above `module.exports`:

```js
// The cart line's name comes from the row's <img alt>, the draft order's from
// its `title` field. Normalise both sides so incidental case/spacing drift
// between the two doesn't lose the lookup.
const normalizeTitle = (s) => String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();

const sameIds = (a, b) =>
  a.storeUuid === b.storeUuid && a.sectionUuid === b.sectionUuid
  && a.subsectionUuid === b.subsectionUuid && a.itemUuid === b.itemUuid;

/**
 * Index the ids getMenuItemV1 needs, per cart item, from a
 * getDraftOrdersByEaterUuidV1 response's `draftOrders` array.
 *
 * Keyed by title because composition defaults belong to the *item*, not to the
 * line's own customisations: two differently-customised Big Mac lines resolve
 * through one entry. A title that genuinely points at two different items is
 * dropped rather than tagged with whichever line came first.
 *
 * @param {Array<object>} draftOrders
 * @returns {Map<string, {storeUuid: string, sectionUuid: string, subsectionUuid: string, itemUuid: string}>}
 */
function uberCartItemIds(draftOrders) {
  const byTitle = new Map();
  const ambiguous = new Set();
  for (const draft of draftOrders ?? []) {
    for (const item of draft?.shoppingCart?.items ?? []) {
      const key = normalizeTitle(item?.title);
      if (!key || ambiguous.has(key)) continue;
      const ids = {
        storeUuid: item.storeUuid,
        sectionUuid: item.sectionUuid,
        subsectionUuid: item.subsectionUuid,
        itemUuid: item.uuid,
      };
      if (Object.values(ids).some((v) => !v)) continue;
      const existing = byTitle.get(key);
      if (existing == null) {
        byTitle.set(key, ids);
      } else if (!sameIds(existing, ids)) {
        byTitle.delete(key);
        ambiguous.add(key);
      }
    }
  }
  return byTitle;
}
```

Update the export line:

```js
module.exports = { uberCompositionDefaults, uberRemovals, uberCartItemIds, normalizeTitle };
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx jest tests/uber-composition.test.js`
Expected: PASS, 23 tests.

- [ ] **Step 6: Run the full suite and commit**

```bash
npm test
git add src/shared/uber-composition.js tests/uber-composition.test.js tests/fixtures/ubereats-draft-orders.json
git commit -m "feat: index Uber cart-line item ids from the draft-order response (#33)"
```

---

### Task 4: Wire the enrichment into the Uber capture

**Files:**
- Modify: `src/content/checkout-reader.js` (the `extractUberEats` item map, ~lines 105–185, plus new helpers above it)
- Modify: `tests/checkout-reader.test.js`

**Interfaces:**
- Consumes: `uberCompositionDefaults`, `uberRemovals`, `uberCartItemIds`, `normalizeTitle` from Tasks 1–3.
- Produces: no new exports. `extractOrder(PLATFORM.UBER_EATS, doc)` now appends `{ group: 'Remove', name: 'No X', price: 0 }` entries to an item's `options` when the page's own `fetch` reveals a removal.

**Key constraint:** the enrichment must use `doc.defaultView.fetch` and nothing else. JSDOM windows have no `fetch`, so every existing test stays network-free and unchanged by construction; a test opts in by assigning a stub to `dom.window.fetch`. Never fall back to Node's global `fetch` — that would fire real requests during `npm test`.

- [ ] **Step 1: Write the failing tests**

Append to the `describe('extractOrder - Uber Eats', …)` block in `tests/checkout-reader.test.js`:

```js
  // Issue #33: an ingredient the user removed on Uber shows only as an absence
  // from the "Comes With" list. The defaults come from the per-item API, so the
  // capture fetches them and emits the difference as a decline the target's
  // Remove group can satisfy.
  const bigMacDetail = require('./fixtures/ubereats-item-bigmac.json');
  const draftOrders = require('./fixtures/ubereats-draft-orders.json');

  const compositionDom = (keptList) => new JSDOM(`<!DOCTYPE html><html><body>
      <div data-testid="cart-summary-panel"></div>
      <div data-testid="fare-breakdown-charge-badge-total">£5.89</div>
      <div data-testid="cart-items-list">
        <li><div data-testid="cart-item-1">
          <img alt="Big Mac®" />
          <span data-testid="rich-text">Big Mac® Comes With:</span><span data-testid="rich-text">${keptList}</span>
          <span>£5.89</span>
        </div></li>
      </div></body></html>`);

  const okJson = (payload) => Promise.resolve({ ok: true, json: () => Promise.resolve(payload) });

  const stubUberApis = (dom) => {
    const calls = [];
    dom.window.fetch = (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) });
      if (url.includes('getDraftOrdersByEaterUuidV1')) return okJson(draftOrders);
      if (url.includes('getMenuItemV1')) return okJson(bigMacDetail);
      return Promise.reject(new Error(`unexpected ${url}`));
    };
    return calls;
  };

  test('a removed ingredient becomes a "No X" decline option', async () => {
    const dom = compositionDom('Sauce, Lettuce, Onions, Cheese, 2 Beef Patty, Bun');
    stubUberApis(dom);
    const order = await extractOrder(PLATFORM.UBER_EATS, dom.window.document);
    expect(order.items[0].options).toEqual([
      { group: 'Remove', name: 'No Pickles', price: 0 },
    ]);
  });

  test('the composition row itself is still excluded from options', async () => {
    const dom = compositionDom('Sauce, Lettuce, Onions, Cheese, 2 Beef Patty, Bun');
    stubUberApis(dom);
    const order = await extractOrder(PLATFORM.UBER_EATS, dom.window.document);
    expect(order.items[0].options.some((o) => /Comes With/i.test(o.group))).toBe(false);
  });

  test('untouched defaults produce no Remove selections', async () => {
    const dom = compositionDom('Sauce, Pickles, Lettuce, Onions, Cheese, 2 Beef Patty, Bun');
    stubUberApis(dom);
    const order = await extractOrder(PLATFORM.UBER_EATS, dom.window.document);
    expect(order.items[0].options).toEqual([]);
  });

  test('the item detail is requested with the ids from the draft order', async () => {
    const dom = compositionDom('Sauce, Lettuce, Onions, Cheese, 2 Beef Patty, Bun');
    const calls = stubUberApis(dom);
    await extractOrder(PLATFORM.UBER_EATS, dom.window.document);
    const itemCall = calls.find((c) => c.url.includes('getMenuItemV1'));
    expect(itemCall.body).toMatchObject({
      itemRequestType: 'ITEM',
      storeUuid: '7c0b936e-53cc-4f7b-9558-b41691071f19',
      sectionUuid: '82a88175-4085-50b2-9ac1-9cfda241af83',
      subsectionUuid: '6af6e4d6-c531-53d8-bb5f-82109718d392',
      menuItemUuid: '436063f7-19ba-5d0f-ba15-137deab02561',
    });
  });

  test('a failing fetch leaves the capture exactly as it was (no removals, no throw)', async () => {
    const dom = compositionDom('Sauce, Lettuce, Onions, Cheese, 2 Beef Patty, Bun');
    dom.window.fetch = () => Promise.reject(new Error('offline'));
    const order = await extractOrder(PLATFORM.UBER_EATS, dom.window.document);
    expect(order.items[0].options).toEqual([]);
    expect(order.items[0].name).toBe('Big Mac®');
  });

  test('a non-200 response yields no removals', async () => {
    const dom = compositionDom('Sauce, Lettuce, Onions, Cheese, 2 Beef Patty, Bun');
    dom.window.fetch = () => Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
    const order = await extractOrder(PLATFORM.UBER_EATS, dom.window.document);
    expect(order.items[0].options).toEqual([]);
  });

  test('no composition row means no network call at all', async () => {
    const dom = new JSDOM(`<!DOCTYPE html><html><body>
      <div data-testid="cart-summary-panel"></div>
      <div data-testid="fare-breakdown-charge-badge-total">£9.99</div>
      <div data-testid="cart-items-list">
        <li><div data-testid="cart-item-1">
          <img alt="Whopper" />
          <span data-testid="rich-text">Choose Drink:</span><span data-testid="rich-text">Coke</span>
          <span>£9.99</span>
        </div></li>
      </div></body></html>`);
    let called = false;
    dom.window.fetch = () => { called = true; return Promise.reject(new Error('should not fetch')); };
    const order = await extractOrder(PLATFORM.UBER_EATS, dom.window.document);
    expect(called).toBe(false);
    expect(order.items[0].options).toEqual([{ group: 'Choose Drink', name: 'Coke', price: 0 }]);
  });

  test('internal composition rows never leak onto the returned item', async () => {
    const dom = compositionDom('Sauce, Lettuce, Onions, Cheese, 2 Beef Patty, Bun');
    stubUberApis(dom);
    const order = await extractOrder(PLATFORM.UBER_EATS, dom.window.document);
    expect(Object.keys(order.items[0]).sort()).toEqual(
      ['name', 'options', 'optionsTotal', 'quantity', 'unitPrice'].sort()
    );
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest tests/checkout-reader.test.js`
Expected: FAIL — the removal tests report `options` as `[]` (the composition row is dropped and nothing replaces it).

- [ ] **Step 3: Add the fetch helpers**

In `src/content/checkout-reader.js`, extend the top-of-file require and add the helpers below it:

```js
const { PLATFORM, MSG, platformFromUrl } = require('../shared/constants');
const {
  uberCompositionDefaults,
  uberRemovals,
  uberCartItemIds,
  normalizeTitle,
} = require('../shared/uber-composition');

const UBER_DRAFTS_API = '/_p/api/getDraftOrdersByEaterUuidV1?localeCode=gb';
const UBER_ITEM_API = '/_p/api/getMenuItemV1?localeCode=gb';
// The capture blocks the sidebar's first render, so a hung request must not
// hold it open — a timed-out call is treated exactly like a failed one.
const UBER_API_TIMEOUT = 4000;

// Same-origin POST to one of Uber's own web APIs. Resolves the parsed body, or
// null on any failure (non-200, network error, timeout, unparseable). Never
// rejects: the capture must not throw, and no removals is a correct answer.
function uberPost(fetchFn, url, body) {
  const request = fetchFn(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-csrf-token': 'x' },
    body: JSON.stringify(body),
  })
    .then((r) => (r && r.ok ? r.json() : null))
    .catch(() => null);
  const timeout = new Promise((resolve) => setTimeout(() => resolve(null), UBER_API_TIMEOUT));
  return Promise.race([request, timeout]).catch(() => null);
}

// Uber's cart lists only the KEPT defaults of a composition group, so an
// ingredient the user removed is visible only as an absence. Fetch the item's
// full defaults and append the difference as decline options the target's
// "Remove" group can satisfy (#33). Bounded: one draft-order call for the whole
// cart, then one item call per distinct composition-bearing item. Any failure
// leaves the items untouched, which is the pre-#33 behaviour.
async function addUberRemovals(doc, items) {
  const needing = items.filter((i) => i._compositionRows.length);
  // Only the page's own window can reach these same-origin APIs; there is
  // deliberately no global-fetch fallback (it would fire real requests in tests).
  const fetchFn = doc.defaultView?.fetch;
  if (!needing.length || typeof fetchFn !== 'function') return;
  const drafts = await uberPost(fetchFn, UBER_DRAFTS_API, {});
  const idsByTitle = uberCartItemIds(drafts?.data?.draftOrders);
  const detailByItem = new Map();
  for (const item of needing) {
    const ids = idsByTitle.get(normalizeTitle(item.name));
    if (!ids) continue;
    if (!detailByItem.has(ids.itemUuid)) {
      detailByItem.set(
        ids.itemUuid,
        await uberPost(fetchFn, UBER_ITEM_API, {
          itemRequestType: 'ITEM',
          storeUuid: ids.storeUuid,
          sectionUuid: ids.sectionUuid,
          subsectionUuid: ids.subsectionUuid,
          menuItemUuid: ids.itemUuid,
          isEditFlow: false,
          cbType: 'EATER_ENDORSED',
          includeCheaperAlternatives: false,
        })
      );
    }
    const detail = detailByItem.get(ids.itemUuid);
    if (!detail) continue;
    const removals = uberRemovals(item._compositionRows, uberCompositionDefaults(detail));
    if (removals.length) {
      console.info('[FeedMe checkout] removals on', JSON.stringify(item.name), '—',
        removals.map((r) => r.name).join(', '));
      item.options.push(...removals);
    }
  }
}
```

- [ ] **Step 4: Carry the composition rows out of the item map**

In `extractUberEats`, the filter that builds `options` currently discards the composition rows outright. Keep the filter as it is and capture those rows alongside it. Replace:

```js
          const options = allOptions.filter((o) =>
            !/comes with$/i.test(o.group)
            && !(o.price === 0 && o.name !== o.group && groupLabels.has(o.name)));
          const optionsTotal = options.reduce((sum, o) => sum + o.price, 0);
          return {
            name,
            quantity,
            unitPrice: quantity > 0 ? lineTotal / quantity : lineTotal,
            options,
            optionsTotal,
          };
```

with:

```js
          const options = allOptions.filter((o) =>
            !/comes with$/i.test(o.group)
            && !(o.price === 0 && o.name !== o.group && groupLabels.has(o.name)));
          const optionsTotal = options.reduce((sum, o) => sum + o.price, 0);
          return {
            name,
            quantity,
            unitPrice: quantity > 0 ? lineTotal / quantity : lineTotal,
            options,
            optionsTotal,
            // The dropped composition rows, kept only long enough for
            // addUberRemovals to diff them; stripped before the order is sent.
            _compositionRows: allOptions.filter((o) => /comes with$/i.test(o.group)),
          };
```

- [ ] **Step 5: Call the enrichment and strip the scratch field**

In `extractUberEats`, immediately after the `const items = itemsList ? … : [];` assignment, add:

```js
  await addUberRemovals(doc, items);
  for (const item of items) delete item._compositionRows;
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx jest tests/checkout-reader.test.js`
Expected: PASS — the 8 new tests plus every pre-existing Uber test (the PR #32 drop tests must still pass untouched; they have no `window.fetch`, so no enrichment runs).

- [ ] **Step 7: Run the full suite and build**

```bash
npm test
npm run build
```
Expected: all green; esbuild clean.

- [ ] **Step 8: Commit**

```bash
git add src/content/checkout-reader.js tests/checkout-reader.test.js
git commit -m "feat: capture Uber ingredient removals as Remove-group declines (#33)"
```

---

### Task 5: Prove the matcher needs no change

**Files:**
- Modify: `tests/matcher.test.js`

**Interfaces:**
- Consumes: the `{ group: 'Remove', name: 'No X', price: 0 }` shape from Task 2.
- Produces: nothing — this task adds tests only.

The design rests on `priceOptions` already handling the emitted shape: `isDecline` matches `/^(no|none|without)\b/`, so `No Pickles` resolves only to a decline inside the target's Remove-style group, and clean-skips when there is none. **If these tests fail, stop and report** — the design assumption is wrong and needs revisiting, not patching around.

- [ ] **Step 1: Write the tests**

`priceOptions` is internal — `matcher.js` exports only `matchItems`, `computeTotal` and `estimateUberFees` — so drive these through `matchItems`, exactly as the existing decline tests in this file do.

Append to `tests/matcher.test.js`:

```js
describe('Uber ingredient removals (#33)', () => {
  // The capture emits a removed ingredient as a decline in a synthetic "Remove"
  // group. Nothing in matcher.js knows about #33: these tests pin that the
  // existing decline rules already do the right thing with that shape.
  const refWithRemoval = [{
    name: 'Big Mac®', quantity: 1, unitPrice: 5.89, optionsTotal: 0,
    options: [{ group: 'Remove', name: 'No Pickles', price: 0 }],
  }];

  test('resolves to the target\'s own Remove-group decline', () => {
    const platform = [{
      id: 'je-1', name: 'Big Mac®', description: '', unitPrice: 5.89,
      modifiers: [
        { name: 'No Pickles', price: 0, id: 'je-no-pickles', groupId: 'gr', group: 'Remove' },
        { name: 'No Onions', price: 0, id: 'je-no-onions', groupId: 'gr', group: 'Remove' },
        { name: 'Extra Pickles', price: 0.5, id: 'je-extra-pickles', groupId: 'ga', group: 'Additions' },
      ],
    }];
    const [result] = matchItems(refWithRemoval, platform);
    expect(result.basketLine.modifiers).toEqual([
      { id: 'je-no-pickles', groupId: 'gr', group: 'Remove', name: 'No Pickles' },
    ]);
    expect(result.basketLine.prefillable).toBe(true);
  });

  test('never resolves to a positive option of the same ingredient', () => {
    const platform = [{
      id: 'je-2', name: 'Big Mac®', description: '', unitPrice: 5.89,
      modifiers: [
        { name: 'Extra Pickles', price: 0.5, id: 'je-extra-pickles', groupId: 'ga', group: 'Additions' },
      ],
    }];
    const [result] = matchItems(refWithRemoval, platform);
    expect(result.basketLine.modifiers).toEqual([]);
    expect(result.platformItem.unitPrice).toBeCloseTo(5.89); // no £0.50 add-on priced in
  });

  test('clean-skips when the target models no removals at all', () => {
    const platform = [{
      id: 'je-3', name: 'Big Mac®', description: '', unitPrice: 5.89,
      modifiers: [{ name: 'Regular Fries', price: 0, id: 'je-fries', groupId: 'gs', group: 'Side' }],
    }];
    const [result] = matchItems(refWithRemoval, platform);
    expect(result.basketLine.modifiers).toEqual([]);
    expect(result.basketLine.prefillable).toBe(true); // skipping IS the removal
  });
});
```

- [ ] **Step 2: Run them**

Run: `npx jest tests/matcher.test.js -t "#33"`
Expected: PASS with no production change. If any fail, stop and report the failure rather than editing `matcher.js`.

- [ ] **Step 3: Run the full suite and commit**

```bash
npm test
git add tests/matcher.test.js
git commit -m "test: pin decline handling for Uber ingredient removals (#33)"
```

---

### Task 6: Live verification and PR

**Files:**
- Modify: `docs/superpowers/plans/2026-08-01-uber-ingredient-removals.md` (tick boxes as you go)

**Interfaces:**
- Consumes: everything above.
- Produces: a merged PR closing #33.

- [ ] **Step 1: Package before touching a live page**

```bash
npm run package
```

`npm test` and `npm run build` only refresh `dist/`; `build/` is a manual snapshot, and skipping this means verifying stale code with nothing to reveal it.

- [ ] **Step 2: Build the source basket on Uber**

Follow `.claude/skills/verify/SKILL.md`. On a McDonald's Uber store page, open the Big Mac item, choose the plain **Big Mac®** option under "Select Option", decrement **Pickles** to 0 in the "Big Mac® Comes With" group, and add it to the basket.

Known snags from the 2026-08-01 probe: the composition options render as quantity steppers (`[data-testid="quantity-decrement-selection-button"]`), not checkboxes; a modal overlay intercepts Playwright clicks, so click through `page.evaluate` instead; and the quick-view's confirm button can read "Save" rather than "Add N to order" and silently no-op — confirm the basket count actually increased before moving on.

- [ ] **Step 3: Capture and confirm the removal survives**

On `/gb/checkout`, inject the built `checkout-reader` bundle and run `extractOrder('uber-eats', document)`. Expected: the Big Mac line's `options` contains `{ group: 'Remove', name: 'No Pickles', price: 0 }` and no `Comes With` group.

- [ ] **Step 4: Match and fill on Just Eat**

Dump the JE menu's `__NEXT_DATA__`, run `parseMenuResponse` + `matchItems` in Node to get the `basketPlan`, then drive `dist/basket-builder.js` on the JE menu page. Open the JE basket and confirm the line shows **No Pickles**. Screenshot it.

- [ ] **Step 5: Confirm the no-removal case still passes**

Repeat with a Big Mac whose defaults are untouched: no Remove selections, `prefillable: true`, no amber review flag. This is PR #32's behaviour and must be unchanged.

- [ ] **Step 6: Open the PR**

```bash
git push -u origin feat/33-uber-ingredient-removals
gh pr create --title "feat: map Uber ingredient removals onto the target's Remove group (#33)" --body "..."
```

The body must state the live acceptance result (both cases from Steps 4 and 5) and note that the store-catalog approach in #33's own text was ruled out by the 2026-08-01 probe, with `getMenuItemV1` used instead. Update issue #33's body to match, so the issue and the shipped design don't disagree.

---

## Follow-ups to file, not to build here

- **`cart-item-…` testid may carry the item uuid.** If a live check shows the checkout DOM's `data-testid="cart-item-<uuid>"` suffix is the item uuid, the whole `getDraftOrdersByEaterUuidV1` call and `uberCartItemIds` index collapse into reading an attribute. Worth an issue.
- **Removals from non-Uber sources.** Deliveroo and Just Eat as *source* platforms (#22, #23) don't capture options at all yet; removals there are out of scope until they do.
