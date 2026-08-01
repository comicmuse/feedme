# Uber order-level offers: live findings (#15)

Probed live on **2026-08-01** against ubereats.com/gb, delivery to E2, using the
Playwright MCP chromium and the same blob decoder as `extractUberStoreCatalog`.

Issue #15 assumed Uber publishes store-funded order-level offers (free delivery /
% off / spend threshold) that could be mapped to the structured offer model the
way Just Eat (#9) and Deliveroo (#10) offers are. **It does not.** The finding
below is why the mapping half of #15 was not built.

## What the storefront actually publishes

Stores probed (all drawn from Uber's own `/feeds/offershub`, so all are running
*some* promotion): Burger King Canary Wharf, Popeyes Whitechapel, Pizza Hut
Bethnal Green, Papa Johns Aldgate, KFC Mile End, Subway Stepney Green, Tortilla
Canary Wharf, Five Guys Liverpool St, McDonald's Bethnal Green.

In the server-rendered react-query blob, on **every** store:

| Key | Value |
| --- | --- |
| `promotion` | `null` |
| `suggestedPromotion` | `{"text":"","promotionUuid":""}` |
| `hasStorePromotion` | `true` |
| `storeBanners` | `null` |
| `nuggets` | `[]` |

`hasStorePromotion: true` is a flag with no payload behind it. The only
promotion data with substance in the blob is the per-item `itemPromotion`
(`buyXGetYItemPromotion`) already extracted by #8, plus section-level
`promoUUID` / `promoInfo.promotionUUID` references pointing at those same
item promotions.

## Where the "% off" offers on the page come from

They are not store data at all. They arrive in a client-side, authenticated
`POST /_p/api/getStoreV1` response, as promo cards under:

```
data.catalogSectionsMap.<uuid>.0.payload.eaterMessagingPayload
  .eaterMessage.payload.cardCarousel.carouselItems[].card
```

A card (Burger King, 2026-08-01):

```json
{
  "title": "15% off (up to £30) on breakfast",
  "subtitle": "Use between 05:00 and 11:00 before 3 Aug 2026, in the timezone of the restaurant",
  "cta": { "text": "Claim offer", "action": { "claimPromotion": { "promotionUUID": "701e9085-…" } } },
  "viewData": { "metadata": { "OFFER_TYPE": "PERCENT", "OFFER_UUID": "701e9085-…" } },
  "cardMetadata": { "promotionCardMetadata": { "promotionUuid": "701e9085-…", "isHappyHourOffer": false } }
}
```

Three properties make these unusable as branch offers:

1. **They are account-scoped, not store-scoped.** The *identical* four cards
   ("15% off (up to £30) on breakfast" / "on large orders" / "on scheduled
   orders" / "on a late night snack") appeared on all five chains probed. They
   belong to the signed-in eater, not the restaurant. The details prose says so:
   "This promotion may be personalised based on automated decision-making."
2. **They must be claimed and applied as a promo code** — `claimPromotion` CTA,
   "Must apply the promo code in the app before completing your order." An
   unclaimed offer discounts nothing, so folding one into a comparison total
   would misprice the branch for anyone who has not claimed it.
3. **The numbers exist only in marketing prose.** `OFFER_TYPE: "PERCENT"` is
   typed, but the percentage (15%), the cap (£30) and the minimum spend (£10)
   appear only inside `title` and a bottom-sheet `subtitle` bullet list
   ("• £10 minimum order (excluding promotions)\n• Up to £30"). Deriving them
   means regex-parsing localised English copy, which the deterministic-data rule
   in AGENTS.md rules out.

Point 1 puts these squarely under issue #5 (account-based deals in comparison
pricing), not #15.

## Consequence

- No `free-delivery` / `percent` / spend-threshold offer can be sourced for an
  Uber sibling branch from platform data today. The offer half of #15 is not
  implementable as specified, and should not be approximated.
- The `maxRedemptionCount` half of #15 *was* real and shipped on this branch.

## Unrelated finding worth an issue

The same blob carries a per-store delivery fee that `parseUberStore` currently
throws away — it hardcodes `deliveryFee: 0`:

```json
"fareBadge": { "text": "£5.29 Delivery Fee" },
"fareInfo":  { "serviceFee": 5.29, "serviceFeeCents": 529 }
```

Despite the key name, `fareInfo.serviceFee` is the **delivery** fee (the badge
text confirms it), and it varies per store (£5.29 BK, £0.29 Pizza Hut, £0.79
Subway, £2.79 McDonald's). Uber siblings currently compare with a £0 delivery
fee, which understates every Uber total. That is deterministic, typed data and a
much larger accuracy win than #15 would have been.
