# Deliveroo Plus and Just Eat loyalty: live findings (#67)

Probed live on **2026-08-02** against deliveroo.co.uk and just-eat.co.uk,
delivery to E1, on the signed-in profile in the Playwright MCP chromium.

Issue #67 asks the four questions that made the Uber One picture tractable
(`2026-08-01-uber-one-account-deals-findings.md`). The short answer is that the
two platforms land on **opposite sides** of the deterministic/heuristic line:

- **Just Eat StampCards are fully modellable** — a dedicated endpoint publishes
  the scheme's economics as numbers, and eligibility as a date.
- **Deliveroo Plus is not** — membership status is typed, but every amount on
  the basket page is a display string inside a presentation tree.

## Account caveats — read before trusting the gaps

This profile is signed in to both platforms but holds **neither membership**:

| Signal | Value |
| --- | --- |
| Deliveroo `user.isSubscriber` | `false` (`isPlusEligible: true`, "Start your free trial now") |
| Just Eat `memberships` | `{"currency":"GBP","memberships":[]}` |
| Just Eat `memberships/current` | `404 NotFound` — "No memberships found" |
| Just Eat `loyalty-schemes` | `[]` |
| Just Eat `takeawaypay` | `{"takeawayPayLinked": false}` |
| StampCard progress | `inProgressStampCards: []`, `rewards: []` on every store probed |

So everything below describes the **non-member / no-progress** shape. Where a
field only populates for a member, that is called out rather than guessed.

## Just Eat

### StampCard economics are typed and numeric

`GET https://uk.api.just-eat.io/consumers/uk/stampcards/status/{restaurantId}`
(bearer token from the `je-at` cookie; the site calls this on every menu page):

```json
{
  "restaurantInfo": { "id": "86623", "name": "Subway® Shoreditch", "seoName": "subway-shoreditchlondoncity" },
  "restaurantSubscriptionInfo": {
    "timeZone": "Europe/London",
    "optInDate": "2022-05-10T17:01:54Z",
    "optOutDate": null,
    "optOutConfirmationDate": null,
    "offerInformation": { "offerType": "default", "stampCardSize": 5, "discountPercentage": 10 }
  },
  "inProgressStampCards": [],
  "rewards": []
}
```

`stampCardSize` and `discountPercentage` are **integers, not prose** — the thing
Uber One's minimum basket never gave us. All 10 participating stores probed
returned the identical `default` / 5 / 10%, so the scheme looks nationally
uniform; `offerType: "default"` implies non-default variants exist, so read the
numbers rather than hardcoding 5 and 10.

### The `offerInformation` trap

`offerInformation` is returned **identically for restaurants that are not in the
scheme at all** — Pizza 2 Go (no StampCard) also reports `default` / 5 / 10%,
with `optInDate: null`. It is a scheme-wide default template, not per-store
configuration. Reading it alone would conclude that every restaurant on Just Eat
runs a stampcard.

The only per-store signal is:

```
optInDate != null && optOutDate == null
```

Non-participants return HTTP **200**, not 404 — so status code is not a signal
either.

### Two independent eligibility signals, and they agree

The area listing already carries a typed per-store enum, with no login needed:

```json
"deals": [{ "description": "", "offerType": "StampCard" }]
```

Across 1834 branches at this postcode: `StampCard` 824, `Percent` 566,
`ItemLevelDiscount` 180, `FreeItem` 136, `BogofMixMatch` 117, `Notification` 9.

Checked `deals[].offerType == "StampCard"` against `optInDate != null` over a
24-store sample (12 with, 12 without): **24/24 agreement, 0 disagreements**.
The cheap anonymous signal is therefore good enough to decide eligibility; the
authenticated endpoint is only needed for the numbers and the progress.

`consumeroffers/notifications` (also anonymous) carries the same fact a third
way, with a stable id:

```json
{ "offerId": "3fcfb8f5-7e9e-48fa-be4c-26d91537cdda", "restaurantId": "86623",
  "offerType": "StampCard", "campaignId": "stampCardLoyalty",
  "consumerSegment": "All", "offerMenuItems": [], "maximumRedemptions": 1 }
```

Note `offerMenuItems: []` and `description: ""` — unlike `ItemLevelDiscount`
(which carries `discountPercentage`, `discountedItemPrice` and per-item ids),
the StampCard entry names no items and no money.

### A StampCard is deferred value, not a discount on this order

The in-product explainer:

> each time you order we'll save up 10% of your order value towards a nice
> discount. When you've hit your 5th order, we'll release your total saved up
> discount in the form of a personal voucher. The voucher is valid for 3 months
> after the collection date and can only be redeemed at the specific restaurant
> you've ordered from.

**This is the most important line for pricing.** A StampCard never reduces the
price of the basket being compared — it accrues 10% toward a voucher that pays
out on a future order, at that branch only. Modelling it as money off the
current order would be simply wrong.

Consequences for ranking:

- It cannot change which branch wins on price today.
- Its honest representation is an annotation ("earns a stamp — 10% toward a
  voucher on your 5th order"), not a line in the total.
- The one case where it *is* real money is redemption of an already-earned
  voucher, which lives in `rewards[]` — **shape unobserved**, because this
  account has no completed card.

No minimum basket for stampcards was found anywhere, typed or prose. The
`menu/dynamic` endpoint carries no stampcard or loyalty fields at all (its
`DeliveryFees.MinimumOrderValue` / `Bands[].MinimumAmount` are the existing
delivery-band model, unrelated).

## Deliveroo

### Membership status is typed

`__NEXT_DATA__.props.initialState.user`, on every page:

```json
{ "isLoggedIn": true, "isSubscriber": false, "isPlusEligible": true,
  "subscriptionTier": null, "subscriptionDrnId": null,
  "subscriptionOfferUname": null, "showRewards": false, "challenges": null,
  "subscriptionLinking": { "partner_uname": "amazon_prime",
                           "title": "Get Plus Silver with Amazon Prime" } }
```

`isSubscriber` is the flag to read — a boolean, not prose, present without any
extra navigation. Tiers are typed too: `plus_tier` target params carry `GOLD`
(menu banner) and `gold` (basket banner) — **note the inconsistent casing** —
and Amazon Prime links to a Silver tier.

### The tier and the branding are typed; the money is not

The basket footer banner ("Only ~~£33.30~~ £30.65 with Plus Gold") arrives from
`consumer/basket/graphql` as a **presentation tree**:

```json
{ "typeName": "UIBanner",
  "bannerContent": {
    "contentStart": [{ "spans": [{ "typeName": "UISpanIcon",
                                   "icon": { "name": "DELIVEROO_PLUS_TAG" } }] }],
    "contentMain": [{ "spans": [
      { "typeName": "UISpanText", "text": "Only " },
      { "typeName": "UISpanText", "text": "£33.30", "isStrikethrough": true },
      { "typeName": "UISpanText", "text": "£30.65", "isBold": true },
      { "typeName": "UISpanText", "text": " with Plus Gold" } ] }],
    "target": { "action": "OPEN_PLUS_SHORT_SIGN_UP",
                "params": [{ "id": "plus_tier", "value": ["gold"] }] } } }
```

Deterministic: the icon name `DELIVEROO_PLUS_TAG`, the action
`OPEN_PLUS_SHORT_SIGN_UP`, the `plus_tier` param. Not deterministic: **both
prices**. To get £30.65 you must regex a `£` out of a `UISpanText` and rely on
`isStrikethrough` to tell you which of two adjacent strings is the "after"
price. That is exactly the fuzzy-guess shape AGENTS.md rules out for money.

### There is no typed money for fees anywhere on the basket page

Walking the entire `get_basket_page` payload for a Deliveroo `Currency`-shaped
node (`code` + `fractional`) returns **zero matches**. What typed money exists
is confined to `meta.basket`, and covers items and subtotal only:

```json
"subtotalBeforeDiscounts": { "fractional": 3000, "currency": "GBP",
                             "currencySymbol": "£", "fractionalConversion": 2,
                             "formatted": "£30.00" }
```

There is no delivery fee, no service fee, and no total in typed form. The
order total exists only as the string `"£33.30 incl. fees"` inside
`meta.menuBasketButton.cost[].spans[].text`. Contrast Uber, where every fare row
carries a `fareInfoID` and an exact `amountE5`.

The GraphQL schema does define a `UISpanPlusLogo` span type, so a member's cards
and rows are presumably marked with it — **unverified**, no Plus account.

### The listing's "£0 delivery fee" is a promo, not Plus

Every card at this postcode renders a struck-through fee and "£0 delivery fee"
(`data-testid="partner-delivery-fee"`, with the original in
`data-testid="discounted-price"`) — on an account with **no Plus**. The
`delivery-fee-prefix-icon` is a percent-in-starburst discount badge, not the
Plus logo. Reading "£0 delivery fee" as evidence of membership would be wrong.

### Menu-level free-delivery offers

`menuPage.menu.metas.root.offer` is typed and does carry numbers —
`minimumOrderValue: { fractional, formatted }` and a `progressBar` with
`displayThreshold` — but on the stores probed the offer was a
`BuyOneGetOneFreeOffer` with `minimumOrderValue: £0.00`. A `FreeDeliveryOffer`
with a non-zero threshold was not encountered this session.

## What this means for #22 / #23

The issue proposed doing this probe *as part of* Deliveroo/Just Eat source
support. That still holds, with one correction: the two platforms need
different amounts of work, and neither needs to block on the other.

- **Just Eat StampCards can be built whenever.** Eligibility comes from the
  listing FeedMe already parses; the numbers come from one authenticated GET.
  The honest output is an annotation, not a price adjustment — so it does not
  touch the pricing path at all, which makes it cheap and low-risk.
- **Deliveroo Plus should not be modelled from the basket page as it stands.**
  Pulling a member's price out of `UISpanText` + `isStrikethrough` would be the
  first place in this codebase where money came from a display string. If Plus
  pricing is wanted, the honest interim is to read `isSubscriber` and mark
  Deliveroo totals approximate for members, the way
  `JUST_EAT_SMALL_ORDER_THRESHOLD` is marked today.

## Not probed

- **Any member-side behaviour on either platform.** No Plus subscription, no
  Just Eat membership, no completed stampcard. Specifically unknown: what
  `subscriptionTier` contains when set, whether `UISpanPlusLogo` appears on a
  member's rows, whether a member's basket gains typed fee rows, and the shape
  of `rewards[]` and `inProgressStampCards[]` when non-empty.
- **Deliveroo checkout.** Only the basket page was read; the fee breakdown may
  be typed one step later. Reaching it needs a saved delivery address on the
  account, which this session did not create.
- **A `FreeDeliveryOffer` with a real threshold**, and any non-`default`
  StampCard `offerType`.
