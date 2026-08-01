# Uber sibling delivery fees + the Uber One £0 waiver (#63, #64)

Design for shipping #63 and #64 together. They must ship together: see
"Why coupled" below. Live evidence for every signal used here is in
`2026-08-01-uber-one-account-deals-findings.md` and
`2026-08-01-uber-order-level-offers-findings.md`.

## Problem

Uber sibling branches are priced with `estimateUberFees`, which copies the
**source cart's** delivery fee onto every sibling. Two things are wrong with
that:

1. The real fee is per-branch and the spread is large — £5.29 (Burger King
   Canary Wharf) vs £0.29 (Pizza Hut Bethnal Green) vs £0.79 (Subway Stepney
   Green) vs £2.79 (McDonald's Bethnal Green), all to the same address (#63).
2. For an Uber One member the copied fee is £0.00 *because it was waived on the
   source cart* — `parsePrice` takes the last number of the row `"£1.79 £0.00"`
   (`checkout-reader.js:117`), so the waived value is what gets copied (#64).

### Why coupled

Fixing #63 alone replaces a waived £0.00 with each branch's real fee, newly
overcharging every Uber branch for a member — worse than today's accidental
behaviour. Fixing #64 alone leaves the fee it waives a copied guess. Together
they give each branch its real fee and then waive it when the member's own
entitlement provably applies.

## Signals

All of these come from data the extension already has. No new network calls.

### Store page — `parseUberStore(ld, catalog)`

`catalog` is `queries[0].state.data`, which already carries both fields.

| Output | Source | Rule |
| --- | --- | --- |
| `deliveryFee` | `fareInfo.serviceFee` | Number, in pounds. |
| `deliveryFeeKnown` | `fareInfo.serviceFee` + `fareBadge.text` | `true` only when both are present and agree to the penny. |
| `uberOneFreeDelivery` | `eatsPassExclusionBadge.badgeDataWithFallback.membership` | `true` only when `brandingType === 'UBER_ONE'` **and** `badgeTextType === 'STANDARD_ZERO_DELIVERY_FEE'`. |

Notes:

- Despite its name, `fareInfo.serviceFee` is the **delivery** fee;
  `fareBadge.text` ("£5.29 Delivery Fee") is the cross-check that proves it.
- `serviceFeeCents` is ignored — it came back as `28.999999999999996` for a
  £0.29 fee.
- Any unrecognised, differing or absent badge means **not eligible**. All 14
  stores probed returned the identical badge, so no excluded store was seen;
  the enum must not be assumed constant.
- When `deliveryFeeKnown` is false the existing estimate path is used unchanged.

### Checkout — `extractUberEats(doc)`

| Output | Rule |
| --- | --- |
| `uberOneDeliveryWaived` | The `fare-breakdown-charge-badge-delivery-fee` row contains **two or more prices with the last equal to 0** *and* an `img` whose `src` matches `uber_one`. |

The image check is what discriminates an Uber One waiver from an ordinary store
free-delivery promotion, which would otherwise look identical. Live row:

```html
<div data-testid="fare-breakdown-charge-badge-delivery-fee">
  <span><span>£1.79</span>&nbsp;
  <span><img src="…/uber_one.png" width="14" height="14"><span> £0.00</span></span></span>
</div>
```

## Applying the waiver: an offer, not a new code path

The minimum basket Uber One requires is **not published** (prose only:
"orders that meet the minimum basket size displayed on the merchant's
shopfront"). Rather than invent a constant, derive a bound from what the
captured cart proves: the source cart was waived at subtotal `S`, so any
sibling whose matched subtotal is `>= S` is also above the threshold.

That bound is expressible as an offer the engine already understands. When the
source cart was waived and the branch is eligible, the service worker appends:

```js
{ type: 'free-delivery', minSpend: sourceSubtotal, description: '£0 Delivery Fee with Uber One' }
```

`applyOffers` already skips offers whose `minSpend` isn't met and zeroes the fee
for `free-delivery` (`matcher.js:275-277`), so:

- no new branching in `computeTotal`;
- branches below the bound keep their real fee — conservative, never claiming a
  saving that isn't proven;
- the £0 is *explained* in the sidebar's offer list rather than appearing
  unaccountably.

`sourceSubtotal` is the source order's subtotal, computed the way
`estimateUberFees` already computes it.

## Sibling pricing, after

For a non-current Uber branch:

1. `serviceFee` stays estimated from the cart's rate (`estimateUberFees`),
   flagged `serviceFeeEstimated` — unchanged.
2. `deliveryFee` is the branch's own `fareInfo` fee when `deliveryFeeKnown`,
   otherwise the copied estimate as today.
3. The Uber One offer is appended when `order.uberOneDeliveryWaived &&
   parsed.uberOneFreeDelivery`; `applyOffers` decides whether it fires.

## Display

Delivery carries an "approx." marker only when the fee is still the copied
estimate (`deliveryFeeKnown` false). A fee read from `fareInfo` is exact and
gets no marker — the exact case stops being labelled like a guess, and the
guess stops passing as exact. The sidebar's existing marker mechanism
(`sidebar.js:329-337`) is reused.

## Testing

TDD, failing test first, per unit:

- **Parser**: fee agrees / disagrees / `fareBadge` absent / `fareInfo` absent;
  badge eligible / wrong `badgeTextType` / wrong `brandingType` / absent.
- **Checkout reader**: waived row / plain `£0.00` with no Uber One image (must
  be false) / ordinary non-zero fee / single-price row.
- **Service worker**: bound met → fee zeroed; bound not met → real fee kept;
  branch ineligible → no offer; non-member → no offer, real fee.
- **End-to-end**: parse → match → `computeTotal` with a real captured blob,
  asserting the waiver fires above the bound and not below.

Fixtures are pinned from the live captures cited above.

## Out of scope

- The Uber One monthly benefit and credits (#65).
- Testid drift: the live checkout now exposes
  `fare-breakdown-charge-badge-uber-one-monthly-benefit-label` and
  `…-uber-one-credits`, while `checkout-reader.js:329` still reads
  `fare-breakdown-charge-badge-membership-benefit`, which is **absent from the
  live page** — today's membership-discount capture passes only against its own
  fixture. Recorded here; belongs to #65.
- Claimable promo offers (#66), Deliveroo/Just Eat entitlements (#67).
