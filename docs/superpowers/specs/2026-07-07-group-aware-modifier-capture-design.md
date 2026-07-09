# Group-aware modifier capture & fill (issue #21)

**Status:** design approved 2026-07-07
**Issue:** [#21](https://github.com/comicmuse/feedme/issues/21)
**Depends on / blocks:** part of issue #2 (clickable switch + basket fill); a meaningful merge of PR #20 depends on this.

## Problem

When switching a basket to another platform, an item whose **required** modifier
groups were satisfied by **free (£0) selections** on the source platform fails to
auto-fill on the target: the target's Add button never enables and the line falls
back to "add manually".

Reproduced live 2026-07-07: an Uber Eats *Spicy Chicken Sandwich Box Meal* with
five selections — Spicy Chicken Sandwich, 3 Hot Wings, Regular Fries,
"Add a Side? → No Thanks", "Add a Shake? → No Thanks" — all £0 inclusions. On Just
Eat the same item exposes **all five groups as "1 required"** (including the two
"No Thanks" declines). The fill plan carries `modifiers: []`, so no required group
is satisfied.

## Root cause

`src/content/checkout-reader.js` (Uber cart reader) captures only **paid** options:
it matches option spans against `/{name} (£{price})/` and filters to `price > 0`.
Free selections and "No Thanks" declines are dropped. This was intentional for
**price comparison** (only paid add-ons change totals) but is insufficient for
basket **filling**, which needs every selection regardless of price.

Confirmed cart DOM shape (real output, Uber `[data-testid^="cart-item-"]` spans):

```
Spicy Chicken Sandwich Box Meal:
  "Spicy Chicken Sandwich:"  "Spicy Chicken Sandwich"
  "Choose Your Chicken:"     "3 Hot Wings"
  "Choose Your Fries:"       "Regular Fries"
  "Add a Side?:"             "No Thanks"
  "Add a Shake?:"            "No Thanks"
  "£13.29"                   (line total)
```

Selections render as **[group label ending in `:`] followed by [option value]**
pairs; paid values carry `(£price)`, free values do not; a bare-price span is the
line total. The group label — previously discarded — is what disambiguates the two
identically-named "No Thanks" options.

## Scope

- **Source platform: Uber only** for the capture change (the tested path). The
  matcher and builder changes are written generically. Deliveroo / Just-Eat as a
  source are a fast follow-up once the shape is proven.
- Both halves are in scope: **capture** (extractor + matcher) and **placement**
  (builder selects each option into the correct required group).

## Design

### 1. Extractor — `src/content/checkout-reader.js`

Replace the paid-only option parse with a group-aware walk of each cart-item's
spans:

- Skip bare-price spans (`/^£\d+(\.\d+)?$/`) — these are line totals.
- A span whose trimmed text ends with `:` sets `currentGroup` (strip the `:`).
- Any other span is an option value in `currentGroup`: parse `name` and an optional
  trailing `(£price)`; `price` defaults to `0`.
- Emit `options: [{ group, name, price }]`. `optionsTotal` is the sum of prices
  (unchanged; free options add 0).

Notes:
- Options that appear before any group label get `group: ''`.
- Multiple values under one label (multi-select groups) are consumed until the next
  label — handled naturally by the walk.
- The item name comes from `img alt`, not a span, so it is never mistaken for an
  option.

New option shape: `{ name, price, group }` (was `{ name, price }`).

### 2. Matcher — `src/shared/matcher.js`

Make option matching group-aware:

- Group the target item's modifiers by group name into
  `{ groupName, options: [{ id, groupId, name, price }] }`.
- For each source selection `{ group, name, price }`:
  1. fuzzy-match source `group` → target group name;
  2. within that group, fuzzy-match the option `name`;
  3. resolved → take the target option's `{ id, groupId, name, price }`
     (price for totals; id/groupId for the builder);
  4. group-or-option not found → **unresolved** (counts against prefillable).
- Fallback: a source option with `group === ''` matches option name globally, as
  today.
- `prefillable = item.id != null && unresolved === 0`, unchanged, now evaluated over
  the full (paid + free) option set: a box meal auto-fills only when *every* required
  selection resolves.

`buildBasketLine` carries each resolved modifier's target `groupId` (and `id`, `name`)
so the builder can scope placement.

**Dependency to verify in implementation:** the target modifier data must expose
group **names** (not just ids). Confirm in `justEatItemModifiers`; add group-name
extraction if absent.

### 3. Builder — `src/content/basket-builder.js`

`findModifierTarget` keeps deterministic id-first matching. Its **name fallback is
scoped to the modifier's group container** (located via the plan modifier's
`groupId` / the group heading) rather than searching the whole dialog — so a global
"No Thanks" cannot select the wrong group. Each plan modifier already carries the
correct target `groupId` from the group-aware matcher.

**Dependency to verify in implementation:** the group container is locatable from
`groupId`/heading on the live Just Eat dialog DOM.

### 4. Pricing invariant

Free options contribute £0, so comparison totals are unchanged for baskets that
previously carried only paid options. Refine the `estimated` flag so an unresolved
£0 option does not spuriously flag the whole total as estimated (only a non-zero
fallback price sets `estimated`).

## Testing

- **Extractor (jsdom):** the three real cart shapes (Hot Honey / 6 Boneless & a dip /
  Spicy Chicken Box Meal) → correct `{ group, name, price }` options, including both
  "No Thanks" and the paid "The Big Ranch (£1.00)".
- **Matcher:** duplicate option names across groups resolve to *distinct* target ids;
  totals unchanged vs. today for paid-only baskets; prefillable semantics
  (all-resolve → prefillable, any-unresolved → not).
- **Builder:** group-scoped selection picks the right element when two same-named
  options exist in different groups.
- **Live E2E:** switch the real Uber box-meal order to Just Eat → all five required
  groups fill and Add enables (the acceptance criterion in #21).

## Acceptance criteria

- Switching an Uber box-meal order to Just Eat fills all required groups and enables
  Add (verified live).
- Price-comparison totals are unchanged (free options contribute £0).
- Both "No Thanks" declines land in their correct respective groups.

## Out of scope (follow-ups)

- Deliveroo / Just-Eat as *source* platforms (their cart readers get the same
  capture change later).
- Any change to the required-group fill strategy when the plan genuinely can't cover
  a target group (that remains "add manually").
