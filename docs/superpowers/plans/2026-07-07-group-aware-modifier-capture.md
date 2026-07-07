# Group-aware Modifier Capture & Fill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture every source-cart selection (including free/£0 options and "No Thanks" declines) with its group, and fill them into the correct required groups on the target platform, so items like a box meal auto-fill on a switch.

**Architecture:** Four layers change. (1) The Uber cart reader captures all option spans with their group. (2) The Just Eat item parser exposes free modifiers and their group name. (3) The matcher resolves each source option group→group then name→name, disambiguating repeated option names. (4) The basket builder scopes its name-fallback selection to the option's group container.

**Tech Stack:** Node, Jest (jsdom), esbuild, fuse.js. No new dependencies.

## Global Constraints

- Source-platform capture is **Uber only** this pass (`extractUberEats`). Deliveroo/Just-Eat cart readers unchanged.
- Comparison totals must be **unchanged** for baskets that previously carried only paid options — free options contribute **£0**.
- Prefillable rule is unchanged: `prefillable = item.id != null && unresolved === 0`, now evaluated over the full (paid + free) option set.
- Fuzzy matching uses **fuse.js with threshold 0.4** (matches existing `FUSE_THRESHOLD` / `priceOptions`).
- The full suite (currently **191 tests**) must stay green after every task; `npm run build` must stay clean.
- Work on branch `feat/2-switch-build-basket`.

---

### Task 1: Capture all cart selections with their group (Uber reader)

**Files:**
- Modify: `src/content/checkout-reader.js` (the option-parse block inside `extractUberEats`, currently ~lines 78-83)
- Test: `tests/checkout-reader.test.js`

**Interfaces:**
- Produces: each `order.items[i]` gains `options: Array<{ group: string, name: string, price: number }>` (was `{ name, price }`, paid-only). `optionsTotal` unchanged (sum of `price`).

- [ ] **Step 1: Write the failing test**

Add to `tests/checkout-reader.test.js` (uses the existing JSDOM setup at the top of the file):

```js
describe('extractOrder - Uber Eats free & grouped options', () => {
  function boxMealDoc() {
    const html = `<!DOCTYPE html><html><body>
      <div data-testid="fare-breakdown-charge-badge-total">£13.29</div>
      <div data-testid="cart-items-list">
        <li><div data-testid="cart-item-1">
          <img alt="Spicy Chicken Sandwich Box Meal" />
          <span>Spicy Chicken Sandwich:</span><span>Spicy Chicken Sandwich</span>
          <span>Choose Your Chicken:</span><span>3 Hot Wings</span>
          <span>Choose Your Fries:</span><span>Regular Fries</span>
          <span>Add a Side?:</span><span>No Thanks</span>
          <span>Add a Shake?:</span><span>No Thanks</span>
          <span>£13.29</span>
        </div></li>
      </div></body></html>`;
    return new JSDOM(html).window.document;
  }

  test('captures free options with their group, keeps optionsTotal at 0', async () => {
    const order = await extractOrder(PLATFORM.UBER_EATS, boxMealDoc());
    expect(order.items[0].optionsTotal).toBe(0);
    expect(order.items[0].options).toEqual([
      { group: 'Spicy Chicken Sandwich', name: 'Spicy Chicken Sandwich', price: 0 },
      { group: 'Choose Your Chicken', name: '3 Hot Wings', price: 0 },
      { group: 'Choose Your Fries', name: 'Regular Fries', price: 0 },
      { group: 'Add a Side?', name: 'No Thanks', price: 0 },
      { group: 'Add a Shake?', name: 'No Thanks', price: 0 },
    ]);
  });

  test('still captures a paid option with its price and group', async () => {
    const html = `<!DOCTYPE html><html><body>
      <div data-testid="fare-breakdown-charge-badge-total">£8.49</div>
      <div data-testid="cart-items-list">
        <li><div data-testid="cart-item-1">
          <img alt="6 Boneless & a dip" />
          <span>6 Boneless:</span><span>6 Boneless</span>
          <span>Choose Dips:</span><span>The Big Ranch (£1.00)</span>
          <span>£8.49</span>
        </div></li>
      </div></body></html>`;
    const order = await extractOrder(PLATFORM.UBER_EATS, new JSDOM(html).window.document);
    expect(order.items[0].optionsTotal).toBeCloseTo(1.0);
    expect(order.items[0].options).toEqual([
      { group: '6 Boneless', name: '6 Boneless', price: 0 },
      { group: 'Choose Dips', name: 'The Big Ranch', price: 1.0 },
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/checkout-reader.test.js -t "free & grouped" -v`
Expected: FAIL — current parser drops free options and emits no `group`.

- [ ] **Step 3: Implement the group-aware span walk**

In `src/content/checkout-reader.js`, replace the current option block:

```js
          const options = [...el.querySelectorAll('span')]
            .map((s) => s.textContent.trim().match(/^(?:[^():]*:\s*)?(.+?)\s*\(£(\d+(?:\.\d+)?)\)$/))
            .filter(Boolean)
            .map((m) => ({ name: m[1].trim(), price: parseFloat(m[2]) }))
            .filter((o) => o.name && o.price > 0);
          const optionsTotal = options.reduce((sum, o) => sum + o.price, 0);
```

with:

```js
          // Selections render as [group label ending ":"] then [option value] span
          // pairs; paid values carry "(£price)", free ones don't; a bare-price span
          // is the line total. Capture every option (free included) with its group
          // so cross-platform fill can satisfy the target's required groups.
          const options = [];
          let currentGroup = '';
          for (const s of el.querySelectorAll('span')) {
            const text = s.textContent.trim();
            if (!text || /^£\d+(\.\d+)?$/.test(text)) continue; // skip blanks + line total
            if (text.endsWith(':')) { currentGroup = text.slice(0, -1).trim(); continue; }
            const priced = text.match(/^(.*)\(£(\d+(?:\.\d+)?)\)$/);
            const name = (priced ? priced[1] : text).trim();
            const price = priced ? parseFloat(priced[2]) : 0;
            if (name) options.push({ group: currentGroup, name, price });
          }
          const optionsTotal = options.reduce((sum, o) => sum + o.price, 0);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest tests/checkout-reader.test.js -v`
Expected: PASS (new tests pass; existing Uber-checkout fixture tests — `optionsTotal` etc. — still pass).

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: all pass. If a pre-existing test asserted an exact `options` array (paid-only), update it to include the now-captured free options + `group`.

- [ ] **Step 6: Commit**

```bash
git add src/content/checkout-reader.js tests/checkout-reader.test.js
git commit -m "feat: capture free/grouped cart selections from Uber (#21)"
```

---

### Task 2: Expose free modifiers and group name (Just Eat item parser)

**Files:**
- Modify: `src/shared/parsers.js` — `justEatItemModifiers` (~lines 332-341)
- Test: `tests/parsers.test.js`

**Interfaces:**
- Produces: each target modifier in `item.modifiers` gains `group: string` (its group's display name) and free (£0) modifiers are no longer dropped. Shape: `{ name, price, id, setId, groupId, group }`.
- Consumes (Task 3): the matcher reads `item.modifiers[].group` and `.price` (0 for free).

- [ ] **Step 1: Write the failing test**

Add to `tests/parsers.test.js` (unit-test the helper directly). If `justEatItemModifiers` is not exported, export it from `parsers.js` (`module.exports = { ..., justEatItemModifiers }`) as part of this step.

```js
const { justEatItemModifiers } = require('../src/shared/parsers');

test('justEatItemModifiers includes free options and their group name', () => {
  const item = { variations: [{ modifierGroupsIds: ['g1'] }] };
  const groupsById = { g1: { id: 'g1', name: 'Add a Side?' } };
  const modifierBySetId = {
    s1: { id: 'm1', name: 'No Thanks', additionPrice: 0 },
    s2: { id: 'm2', name: 'Fries', additionPrice: 1.5 },
  };
  groupsById.g1.modifiers = ['s1', 's2'];
  const mods = justEatItemModifiers(item, groupsById, modifierBySetId);
  expect(mods).toEqual([
    { name: 'No Thanks', price: 0, id: 'm1', setId: 's1', groupId: 'g1', group: 'Add a Side?' },
    { name: 'Fries', price: 1.5, id: 'm2', setId: 's2', groupId: 'g1', group: 'Add a Side?' },
  ]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/parsers.test.js -t "includes free options" -v`
Expected: FAIL — current code drops the £0 modifier and emits no `group`.

- [ ] **Step 3: Implement — keep free modifiers, add group name**

In `justEatItemModifiers`, replace the final `.map(...).filter(...)`:

```js
    .map(({ m, setId, gid }) => ({ name: m.name, price: m.additionPrice ?? 0, id: m.id, setId, groupId: gid }))
    .filter((o) => o.name && o.price > 0);
```

with:

```js
    // Carry the group name (for group-aware matching) and keep FREE options too:
    // the target's required groups are often satisfied by £0 choices ("No Thanks").
    .map(({ m, setId, gid }) => ({
      name: m.name,
      price: m.additionPrice ?? 0,
      id: m.id,
      setId,
      groupId: gid,
      group: groupsById[gid]?.name ?? '',
    }))
    .filter((o) => o.name);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest tests/parsers.test.js -v`
Expected: PASS. If an existing parser test asserted an exact modifier list (paid-only, no `group`), update it to include free modifiers and the `group` field.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: all pass (fix any matcher/parser expectations that counted paid-only modifiers).

- [ ] **Step 6: Commit**

```bash
git add src/shared/parsers.js tests/parsers.test.js
git commit -m "feat: Just Eat parser exposes free modifiers + group name (#21)"
```

---

### Task 3: Group-aware option matching (matcher)

**Files:**
- Modify: `src/shared/matcher.js` — `priceOptions` (~lines 42-69) and `buildBasketLine` (~lines 76-86)
- Test: `tests/matcher.test.js`

**Interfaces:**
- Consumes: `ref.options[] = { group, name, price }` (Task 1); `platformModifiers[] = { name, price, id, groupId, group }` (Task 2).
- Produces: `priceOptions` returns `{ cost, estimated, matched, unresolved }` where `matched` are target modifier objects (carrying `id`, `groupId`, `group`, `name`). `buildBasketLine` emits `modifiers: Array<{ id, groupId, group, name }>`.

- [ ] **Step 1: Write the failing test**

Add to `tests/matcher.test.js`:

```js
test('resolves repeated option names to distinct groups (No Thanks x2)', () => {
  const reference = [{
    name: 'Box Meal', quantity: 1, unitPrice: 13.29, optionsTotal: 0,
    options: [
      { group: 'Add a Side?', name: 'No Thanks', price: 0 },
      { group: 'Add a Shake?', name: 'No Thanks', price: 0 },
    ],
  }];
  const platform = [{
    id: 'je-1', name: 'Box Meal', description: '', unitPrice: 13.29,
    modifiers: [
      { name: 'No Thanks', price: 0, id: 'side-no', groupId: 'gs', group: 'Add a Side?' },
      { name: 'Fries',     price: 0, id: 'side-fr', groupId: 'gs', group: 'Add a Side?' },
      { name: 'No Thanks', price: 0, id: 'shake-no', groupId: 'gk', group: 'Add a Shake?' },
      { name: 'Oreo Shake', price: 3, id: 'shake-or', groupId: 'gk', group: 'Add a Shake?' },
    ],
  }];
  const [result] = matchItems(reference, platform);
  expect(result.basketLine.prefillable).toBe(true);
  expect(result.basketLine.modifiers).toEqual([
    { id: 'side-no', groupId: 'gs', group: 'Add a Side?', name: 'No Thanks' },
    { id: 'shake-no', groupId: 'gk', group: 'Add a Shake?', name: 'No Thanks' },
  ]);
  // Free options add nothing to the priced total.
  expect(result.platformItem.unitPrice).toBeCloseTo(13.29);
});
```

Also update the existing test that asserts `basketLine.modifiers` equality (search for `groupId: 'mg-1', name: 'Regular Fries'`) to include the new `group` field, e.g. `group: ''` when the platform modifier in that test carries no `group`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/matcher.test.js -t "distinct groups" -v`
Expected: FAIL — global name matching resolves both "No Thanks" to the same modifier.

- [ ] **Step 3: Implement group-aware `priceOptions`**

Replace the body of `priceOptions` after the empty-options guard (keep the `if (!options.length)` block as-is):

```js
  const mods = platformModifiers ?? [];
  // Index target modifiers by group name so a source option is matched within its
  // own group first — this disambiguates option names repeated across groups.
  const byGroup = new Map();
  for (const m of mods) {
    const g = m.group ?? '';
    if (!byGroup.has(g)) byGroup.set(g, []);
    byGroup.get(g).push(m);
  }
  const groupNames = [...byGroup.keys()].filter((g) => g);
  const groupFuse = groupNames.length
    ? new Fuse(groupNames.map((name) => ({ name })), { keys: ['name'], threshold: 0.4 })
    : null;

  let cost = 0;
  let estimated = false;
  let unresolved = 0;
  const matched = [];
  for (const opt of options) {
    // Candidate pool: the option's own group when we can match it, else all mods.
    let pool = mods;
    if (opt.group && groupFuse) {
      const gName = groupFuse.search(opt.group)[0]?.item.name;
      if (gName != null) pool = byGroup.get(gName);
    }
    const optFuse = pool.length ? new Fuse(pool, { keys: ['name'], threshold: 0.4 }) : null;
    const hit = optFuse ? optFuse.search(opt.name)[0]?.item : null;
    if (hit) {
      cost += hit.price;
      matched.push(hit);
    } else {
      cost += opt.price;
      if (opt.price > 0) estimated = true; // a £0 miss doesn't flag the total as estimated
      unresolved += 1;
    }
  }
  return { cost, estimated, matched, unresolved };
```

- [ ] **Step 4: Carry the group through `buildBasketLine`**

In `buildBasketLine`, change the modifiers map:

```js
  const modifiers = matchedModifiers.map((m) => ({ id: m.id, groupId: m.groupId, name: m.name }));
```

to:

```js
  const modifiers = matchedModifiers.map((m) => ({ id: m.id, groupId: m.groupId, group: m.group ?? '', name: m.name }));
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx jest tests/matcher.test.js -v`
Expected: PASS (new test + updated equality test).

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add src/shared/matcher.js tests/matcher.test.js
git commit -m "feat: group-aware modifier matching (#21)"
```

---

### Task 4: Group-scoped selection in the builder

**Files:**
- Modify: `src/content/basket-builder.js` — `findModifierTarget` (~lines 162-174); add helper `findGroupContainer`
- Test: `tests/basket-builder.test.js`

**Interfaces:**
- Consumes: plan `modifiers[] = { id, groupId, group, name }` (Task 3).
- Produces: unchanged public API (`selectModifier` still the entry point); selection is now group-scoped when `mod.group` is set.

- [ ] **Step 1: Write the failing test**

Add to `tests/basket-builder.test.js` (uses the existing `pollWait` helper defined near the bottom of that file):

```js
describe('selectModifier group scoping', () => {
  test('selects the same-named option inside the requested group only', async () => {
    document.body.innerHTML = `
      <div role="dialog">
        <section><h3>Add a Side?</h3>
          <label><input type="checkbox" id="side-no"> No Thanks</label>
          <label><input type="checkbox" id="side-fr"> Fries</label>
        </section>
        <section><h3>Add a Shake?</h3>
          <label><input type="checkbox" id="shake-no"> No Thanks</label>
          <label><input type="checkbox" id="shake-or"> Oreo Shake</label>
        </section>
      </div>`;
    const dialog = document.querySelector('[role="dialog"]');
    const ok = await selectModifier(dialog, { name: 'No Thanks', group: 'Add a Shake?' }, pollWait);
    expect(ok).toBe(true);
    expect(document.getElementById('shake-no').checked).toBe(true);
    expect(document.getElementById('side-no').checked).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/basket-builder.test.js -t "group scoping" -v`
Expected: FAIL — the un-scoped search picks the first "No Thanks" (side), leaving the shake unchecked.

- [ ] **Step 3: Implement group scoping**

In `src/content/basket-builder.js`, add a helper above `findModifierTarget`:

```js
// Find the container of a modifier group by its heading text, so option matching
// can be scoped within it. Returns null when the group can't be located.
function findGroupContainer(dialog, group) {
  const g = norm(group);
  if (!g) return null;
  const heading = [...dialog.querySelectorAll('*')]
    .find((el) => el.children.length === 0 && norm(el.textContent) === g);
  let node = heading && heading.parentElement;
  for (let i = 0; i < 5 && node && node !== dialog; i++) {
    if (node.querySelector('label, li, button, [role="checkbox"], [role="radio"], pie-radio, pie-checkbox')) return node;
    node = node.parentElement;
  }
  return null;
}
```

Then in `findModifierTarget`, replace the name-fallback block:

```js
  const name = norm(mod.name);
  if (!name) return null;
  const candidates = [...dialog.querySelectorAll('label, li, button, [role="checkbox"], [role="radio"]')]
    .filter((el) => norm(el.textContent).includes(name));
  candidates.sort((a, b) => a.textContent.length - b.textContent.length);
  return candidates[0] || null;
```

with:

```js
  const name = norm(mod.name);
  if (!name) return null;
  // Scope to the option's group when known so a name repeated across groups
  // (e.g. "No Thanks") lands in the correct one.
  const scope = findGroupContainer(dialog, mod.group) || dialog;
  const candidates = [...scope.querySelectorAll('label, li, button, [role="checkbox"], [role="radio"]')]
    .filter((el) => norm(el.textContent).includes(name));
  candidates.sort((a, b) => a.textContent.length - b.textContent.length);
  return candidates[0] || null;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest tests/basket-builder.test.js -v`
Expected: PASS (new group-scoping test + all existing builder tests).

- [ ] **Step 5: Run the full suite + build**

Run: `npm test && npm run build`
Expected: all pass; build clean.

- [ ] **Step 6: Commit**

```bash
git add src/content/basket-builder.js tests/basket-builder.test.js
git commit -m "feat: scope modifier selection to its group in the builder (#21)"
```

---

### Task 5: Live end-to-end verification

**Files:** none (verification only).

- [ ] **Step 1: Rebuild** — `npm run build` (clean).
- [ ] **Step 2: Drive the real flow.** With the Uber box-meal order as the source cart, run the comparison, then switch to the Just Eat branch (Popeyes Whitechapel). Watch the target tab console for `[FeedMe builder]` lines.
- [ ] **Step 3: Confirm** the log shows all five modifiers `selected` (Spicy Chicken Sandwich, 3 Hot Wings, Regular Fries, No Thanks ×2 into their correct groups), the Add button enables, the dialog closes, and the item appears in the Just Eat basket with the right options. Overlay reports the line as added (not "add manually").
- [ ] **Step 4:** If a modifier reports `NOT selected`, capture the group/option and revisit Task 3 (matching) or Task 4 (scoping) with the live DOM.

---

## Self-Review

**Spec coverage:**
- Extractor capture of free/grouped options → Task 1. ✓
- Matcher group-aware resolution + prefillable + totals unchanged → Task 3 (+ Task 2 supplying target free modifiers & group names). ✓
- Builder group-scoped placement → Task 4. ✓
- Pricing invariant (free = £0; estimated flag refinement) → Task 3 Step 3. ✓
- Live acceptance (box meal fills, Add enables) → Task 5. ✓
- Dependency flagged in spec ("target exposes group names") turned out to also require **un-dropping free target modifiers** → Task 2 covers both. ✓

**Placeholder scan:** none — every code step shows full code and exact commands.

**Type consistency:** `options: {group,name,price}` (Task 1) → consumed by `priceOptions` (Task 3); target modifier `{...,groupId,group}` (Task 2) → `matched`/`buildBasketLine` emit `{id,groupId,group,name}` (Task 3) → consumed by `findModifierTarget` via `mod.group`/`mod.id` (Task 4). Consistent across tasks.
