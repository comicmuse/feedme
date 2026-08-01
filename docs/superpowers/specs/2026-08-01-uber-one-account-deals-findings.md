# Uber One account deals: live findings (#5)

Probed live on **2026-08-01** against ubereats.com/gb, delivery to E2, on the
signed-in profile in the Playwright MCP chromium (an Uber One member — see
`membershipStatus` below). 14 store pages plus the live checkout.

Issue #5 asks whether account-based entitlements can be read deterministically.
For Uber One the answer is **mostly yes** — the status and the money are typed;
only one threshold is not.

## Membership status is typed

At checkout, `getCheckoutPresentationV1` carries:

```
data.checkoutPayloads.promoAndMembershipSavingBannerPayload
  .analyticsMetadata.membershipPayload.membershipStatus = "MEMBER_ABOVE_THRESHOLD"
```

An enum, not prose. The name implies at least a `..._BELOW_THRESHOLD` and a
non-member variant; only `MEMBER_ABOVE_THRESHOLD` was observed on this account.
This sits on the **checkout page — exactly where FeedMe already captures the
source order**, so it is readable at capture time with no extra navigation.

## The benefit is three separate things, with typed amounts

Live fare breakdown (Subway cart, subtotal £16.91, total £15.39). Every row
carries a typed `fareInfoID` and an exact `amountE5`:

| Row | `fareInfoID` | Amount |
| --- | --- | --- |
| Uber One monthly benefit | `eats.mp.discounts.subscription_order_discount` | −£3.00 |
| Uber One credits | `eats.mp.discounts.membership.cash_benefit` | −£0.55 |
| Delivery fee | `eats.mp.charges.bundled_delivery_fee` | £0.00 |
| Fees | `eats.mp.charges.tax_and_fees_v2` | £2.03 |

The delivery-fee row expands to a structured sheet showing the waiver rather
than a genuinely free delivery:

```
Delivery fee                              £1.79
Delivery promotion / Saving with Uber One −£1.79
Total                                      £0.00
```

Banner: "Saving £5.34 with Uber One" — and 3.00 + 0.55 + 1.79 = 5.34, so the
three components account for the whole benefit exactly.

## Per-store eligibility is typed, and currently uniform

Every store carries `eatsPassExclusionBadge`:

```json
{
  "text": "£0 Delivery Fee",
  "badgeType": "MembershipBenefit",
  "badgeDataWithFallback": { "membership": {
    "brandingType": "UBER_ONE",
    "badgeTextType": "STANDARD_ZERO_DELIVERY_FEE"
  } }
}
```

`badgeTextType` is an enum — deterministic. **All 14 stores probed returned the
identical badge** (Burger King, KFC, Subway, Gansu, Red Dragon, Smokin Wok,
Golden Dragon, Mirchiwala, Loaded Wraps, Honest Burgers, Franco Manca, Co-op,
Iceland, McDonald's), so no excluded store was found to confirm what exclusion
looks like. The field name implies exclusions exist; treat a differing or absent
badge as "not eligible" rather than assuming the enum is a constant.

## The one thing that is *not* published: the minimum basket

The only statement of the threshold is prose, identical on every store:

> Uber One members enjoy £0 Delivery Fee on eligible orders that meet the
> **minimum basket size displayed on the merchant's shopfront**.

No numeric field for it was found in the store blob. `MEMBER_ABOVE_THRESHOLD`
tells us the API evaluated a threshold against the £16.91 basket, but not what
it was. There is precedent in this codebase for exactly this shape of gap:
`JUST_EAT_SMALL_ORDER_THRESHOLD` is our model's number, not a scraped one, and
the sidebar marks the row approximate.

## What this means for pricing

Ranking is what matters, so the three components are not equally important:

- **Delivery-fee waiver — ranking-relevant, and the prize.** It zeroes a fee that
  differs hugely per branch (£5.29 Burger King vs £0.29 Pizza Hut vs £0.79
  Subway vs £2.79 McDonald's, same address). Getting this wrong in either
  direction reorders the comparison.
- **Monthly benefit (−£3.00) and credits (−£0.55) — not ranking-relevant within
  Uber.** They are order-independent constants that shift every Uber branch
  equally. They *do* matter across platforms (Uber gets them, Just Eat and
  Deliveroo do not), so they belong in the total but cannot change which Uber
  branch wins.

## Interaction with #63 — important

`estimateUberFees` copies the **source cart's** delivery fee onto every Uber
sibling. On this member's cart that fee is £0.00 *because it was waived*, so
Uber siblings currently inherit £0 — accidentally close to right for a member
whose branches are all eligible, and wrong for everyone else.

That means #63 (use `fareInfo.serviceFee`, the branch's real fee) and the Uber
One waiver must land together or be sequenced deliberately: switching siblings
to the real per-store fee **without** modelling the waiver would newly overcharge
every Uber branch for a member — a regression from today's accidental behaviour.

## Not probed

- Deliveroo Plus and Just Eat loyalty/stampcards: no evidence gathered. Those
  platforms are not yet supported as sources (#22, #23) either.
- Non-member behaviour: this profile is a member, and logging out of the user's
  session to check was out of scope. Read `membershipStatus` rather than
  inferring membership from the badge's presence.
