# Item-level deal model & application engine (#7)

**Status:** approved design — foundation for epic #3 (model sibling-branch deals).
**Blocks:** #8 (Uber), #9 (Just Eat), #10 (Deliveroo) extraction.

## Problem

`applyOffers`/`computeTotal` in `src/shared/matcher.js` apply only **order-level**
offers: `free-delivery`, capped `percent` (whole subtotal), spend-threshold, and a
legacy fixed `amount`. Branch promotions like **Buy-1-get-1-free** are **item-level
and quantity-dependent**: the discount depends on which items are in the cart and how
many. They can't be expressed in the current model, so sibling branches running such
deals are priced at full price (the originally reported Uber 2-for-1 bug).

This story adds the model + application engine as pure, fixture-tested logic. It does
no scraping; the per-platform extractors (#8/#9/#10) produce this shape.

## Data shape

A new offer kind, alongside the existing order-level ones:

```js
{
  type: 'item-deal',
  rule: 'cheapest-free' | 'percent-off-items' | 'free-item',
  eligibleItems: ['Footlong Sub', ...], // branch item names the deal applies to
  quantity: 2,        // cheapest-free: per group of N qualifying units, 1 is free
  percent: 0.31,      // percent-off-items: fraction off eligible matched lines
  cap: Infinity,      // optional ceiling on the discount
  minSpend: 0,        // optional order-subtotal threshold (existing semantics)
  description: 'Buy one get one free',
}
```

Notes:
- `eligibleItems` holds the **branch's own** item names (the extractor reads them from
  that branch's catalogue/offer payload). Empty `eligibleItems` ⇒ the deal can't be
  located against the cart ⇒ display-only (no discount).
- `free-item` names the item that becomes free in `eligibleItems` (and may carry the
  qualifying item too if the platform distinguishes; v1 treats presence of any
  eligible matched line as the trigger and frees the named item once).

## Application

Extends `applyOffers`, which already receives the order subtotal and delivery fee. It
now also needs the **matched lines** to locate eligible items, so its signature gains
the matched lines (or `computeTotal` passes them through). It operates **only on
matched lines** (`m.matched`), never the raw branch catalogue.

Identifying eligible matched lines reuses the existing Fuse name-matching so platform
wording differences ("Footlong" vs "Footlong Sub") don't break equality: build a Fuse
index over `eligibleItems` and test each matched line's `platformItem.name` against it
(threshold consistent with `matchItems`). A matched line qualifies if it hits.

Per rule, against the qualifying lines (each expanded into `referenceItem.quantity`
unit prices at `platformItem.unitPrice`):

- **cheapest-free** — pool all qualifying units, sort ascending, free the cheapest
  `floor(totalQualifyingUnits / quantity)` units. Discount = sum of freed unit prices.
  (2-for-1 ⇒ quantity 2; 3-for-2 ⇒ quantity 3 frees 1 per 3.)
- **percent-off-items** — discount = `min(percent × subtotal(qualifying units), cap)`.
- **free-item** — if ≥1 qualifying line is matched, discount = the named item's unit
  price, once.

Determinism (honours the deterministic-signal preference): a deal contributes a
discount **only** when its eligible items are actually in the matched cart and any
`minSpend`/`quantity` threshold is met. Otherwise it stays display-only — never assume
the cart's deal "propagates" to a branch that doesn't carry it.

Composition: item-deal discounts add to the existing order-level discount handling.
Multiple item-deals each compute independently and sum (v1 — no cross-deal exclusivity
modelling; revisit if a real payload shows mutually-exclusive deals).

## Output

`computeTotal` folds item-deal discounts into `discountTotal` (so `total` already nets
them). It additionally returns an explainable per-deal breakdown, e.g.
`appliedDeals: [{ description, discount }]`, so the sidebar can show *why* a branch is
cheaper. Order-level offer behaviour and existing output fields are unchanged.

## Boundaries

- Pure functions in `src/shared/matcher.js` (or a small `deals.js` it delegates to if
  `matcher.js` grows unwieldy). No platform specifics, no scraping, no I/O.
- Inputs: matched lines + an `offers` array that may now contain `item-deal` entries.
- Reuses the existing Fuse-based normalization rather than introducing a second
  matching scheme.

## Testing (TDD)

Unit tests in `tests/matcher.test.js` (or `tests/deals.test.js`):

1. cheapest-free, 2-for-1, two qualifying units → cheaper one free.
2. cheapest-free with an odd count (3 units, quantity 2) → one free, not two.
3. cheapest-free, only 1 of 2 eligible items in cart → no discount.
4. 3-for-2 (quantity 3, 3 units) → cheapest one free.
5. percent-off-items applies only to eligible lines, respects `cap`.
6. free-item: qualifying line present → named item free once; absent → no discount.
7. eligibleItems empty → display-only, total unchanged.
8. composition: an item-deal + an order-level percent offer both apply correctly.
9. fuzzy eligibility: "Footlong" in `eligibleItems` matches branch line "Footlong Sub".
10. `computeTotal.appliedDeals` lists the applied deal with its discount.

No live data needed for #7; extractors validate against captured fixtures in their own
stories.
