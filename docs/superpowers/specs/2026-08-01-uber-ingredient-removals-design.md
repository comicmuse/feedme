# Uber ingredient removals → the target's "Remove" group (issue #33)

**Status:** design approved 2026-08-01
**Issue:** [#33](https://github.com/comicmuse/feedme/issues/33)
**Follows:** #29 part 1, shipped in PR #32 (composition rows dropped from capture).

## Problem

Uber's cart renders an item's ingredient composition as the group
`X Comes With:` followed by a comma-joined list of the **kept** defaults:

```
"Big Mac® Comes With:"  "Sauce, Pickles, Lettuce, Onions, Cheese, 2 Beef Patty, Bun"
```

Since PR #32 the capture drops these rows. That is correct when the user kept
every default — the row is informational, £0, and no target platform models it —
but it loses information when the user **removed** an ingredient on Uber: the
omission from the list is the only signal, and the target models removals as
explicit options (Just Eat: a "Remove" group holding `No Pickles`, `No Onions`, …,
observed live on McDonald's Bow, 2026-07-11).

## What the live probe changed (2026-08-01, McDonald's Bethnal Green Road)

Issue #33 proposed indexing composition options from the store-page catalog blob
alongside `uberCatalogIdByName`. **That is not possible.** The blob the store page
embeds (`catalogSectionsMap`, ~840 KB, the one `uberCatalogIdByName` already
walks) carries no customisation data at all — no group titles, no options, no
`defaultQuantity`.

The defaults live behind a per-item API instead:

```
POST /_p/api/getMenuItemV1?localeCode=gb
{ "itemRequestType": "ITEM", "storeUuid": …, "sectionUuid": …,
  "subsectionUuid": …, "menuItemUuid": …, "isEditFlow": false,
  "cbType": "EATER_ENDORSED", "includeCheaperAlternatives": false }
```

It responds (anonymously — no login needed) with `data.customizationsList`, a tree
whose branches hang off `option.childCustomizationList`. Walking it for the Big
Mac yields:

```
Select Option > Big Mac® > Big Mac® Comes With   (min 0, max 12)
  Sauce       def=1  min=0 max=2  £0
  Pickles     def=1  min=0 max=2  £0
  Lettuce     def=1  min=0 max=2  £0
  Onions      def=1  min=0 max=2  £0
  Cheese      def=1  min=0 max=1  £0
  Beef Patty  def=2  min=0 max=2  £0
  Bun         def=1  min=0 max=1  £0
```

This reproduces the cart string above exactly, `2 Beef Patty` included, so
`defaultQuantity` is the deterministic baseline the kept list is diffed against —
no heuristics, per the project's "deterministic over heuristic" rule.

The checkout side has the ids that call needs. Each draft-order cart item carries
`uuid`, `storeUuid`, `sectionUuid`, `subsectionUuid`, `quantity` and `title` —
precisely the `getMenuItemV1` request shape.

## Design

### 1. Pure logic — new `src/shared/uber-composition.js`

Plain CommonJS, like the rest of `src/shared/`, so Jest and Node scripts run it
directly. Two functions, no I/O:

**`uberCompositionDefaults(itemDetail)` → `Map<groupTitle, Map<optionTitle, qty>>`**

Walks `customizationsList` recursively through each option's
`childCustomizationList`, keeps groups whose title ends in `Comes With`, and
records options with `defaultQuantity >= 1`.

`"Big Mac® Comes With"` occurs three times in one response — under the plain item,
the Medium meal and the Large meal — with identical options each time, so entries
**merge by title**. A title seen with genuinely conflicting defaults is **dropped**
rather than resolved by guessing, mirroring how `uberCatalogIdByName` handles a
name that appears with two different uuids.

**`uberRemovals(compositionRows, defaults)` → `Array<{group, name, price}>`**

`compositionRows` are the captured `{ group, name }` pairs whose group ends in
`Comes With` — `name` being the comma-joined kept list. For each row: split on
commas, strip an optional leading integer (`2 Beef Patty` → `Beef Patty`, qty 2),
look the group up in `defaults`, and emit one entry per default **absent** from
the kept list:

```js
{ group: 'Remove', name: 'No Pickles', price: 0 }
```

A row whose group is not in `defaults` yields `[]`.

The synthetic group `'Remove'` is what makes this need no matcher change:
`priceOptions`' `isDecline` already matches `/^(no|none|without)\b/`, so
`No Pickles` resolves **only** to a decline inside the target's own Remove-style
group, and when the target has no such group the existing decline-by-omission path
clean-skips it. `'Remove'` is also the string that fuzzy-matches Just Eat's group
name; carrying the source group (`Big Mac® Comes With`) instead would match
nothing on any target.

**Deliberately out of scope:** a quantity *reduced* but not to zero (Beef Patty
2 → 1) emits nothing. No target platform models a partial reduction, so there is
no honest option to emit; it is ignored exactly as it is today.

### 2. Fetch — `src/content/checkout-reader.js`

`extractUberEats` gains a bounded, fail-soft enrichment step for the lines that
have a composition row (usually one or two per order):

1. Resolve each composition-bearing line's ids. **Check first** whether the
   existing `data-testid="cart-item-…"` suffix already carries the item uuid — if
   it does, it replaces step 2's index outright. Otherwise call
   `getDraftOrdersByEaterUuidV1` once for the whole cart and index
   `{storeUuid, sectionUuid, subsectionUuid, itemUuid}` **by item title**.
   Defaults are a property of the item, not of the line, so two differently
   customised Big Mac lines share one lookup; a title seen with two different id
   sets is dropped, as above.
2. Call `getMenuItemV1` once per **distinct** composition-bearing item.
3. Feed the response to `uberCompositionDefaults`, diff with `uberRemovals`, and
   append the results to that line's `options`.

The existing filter that keeps composition rows out of `options` stays exactly as
it is; removals are appended alongside the real selections.

**Failure is silent and total.** Missing ids, a non-200, a timeout, or a drifted
shape all yield no removals — which is precisely PR #32's current behaviour, so a
line with untouched defaults is unaffected and stays `prefillable: true`. The
capture must never throw (AGENTS.md), so every call is wrapped and abort-bounded.

### 3. Builder

Nothing new. A resolved `No Pickles` is an ordinary plan entry.

## Testing

TDD throughout — failing test first, watched fail.

- **Fixture:** the live `getMenuItemV1` Big Mac response, trimmed to the
  customisation tree, pinned as `tests/fixtures/ubereats-item-bigmac.json`.
- **`uberCompositionDefaults`:** finds groups nested under
  `childCustomizationList`; keeps only `defaultQuantity >= 1`; merges the three
  identical `Big Mac® Comes With` occurrences; drops a title whose defaults
  genuinely conflict.
- **`uberRemovals`:** pickles removed → `[{group:'Remove', name:'No Pickles',
  price:0}]`; every default kept → `[]`; the `2 Beef Patty` quantity prefix parses;
  a reduction to a non-zero quantity emits nothing; an unknown group → `[]`.
- **`checkout-reader`:** the real McDonald's cart DOM with a stubbed fetch yields
  the removal in `options` while the composition row itself stays excluded; and a
  **failing** fetch reproduces today's output unchanged.
- **`matcher`:** `No Pickles` resolves to Just Eat's Remove-group `No Pickles`, and
  clean-skips (no `unresolved`, no review flag) when the target has no Remove
  group.

## Acceptance

- Removing pickles from a Big Mac meal on Uber produces a Just Eat fill with
  "No Pickles" selected — verified live, per `.claude/skills/verify/SKILL.md`, with
  `npm run package` run immediately beforehand.
- A meal with untouched defaults produces no Remove selections and stays
  `prefillable: true` (PR #32 behaviour preserved).
