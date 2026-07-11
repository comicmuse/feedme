const Fuse = require('fuse.js');

const FUSE_THRESHOLD = 0.4;

// Case/whitespace-insensitive name comparison, shared by exact-name checks.
const normalize = (s) => String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();

// Size adjectives whose swap distinguishes variants of one product ("… Medium
// Meal" vs "… Large Meal"). Names equal after stripping these are the same
// product in different sizes.
const SIZE_WORDS_RE = /\b(small|medium|large|regular|extra large|xl)\b/gi;
const sizeAgnostic = (s) => normalize(String(s ?? '').replace(SIZE_WORDS_RE, ' '));

// Combos, meals, bundles and multipacks fuzzy-match the same words as a single
// item but cost far more, so they're de-prioritised unless the reference item is
// itself one of these.
const COMBO_RE = /\b(meals?|bundle|combo|deal|sharing|share|feast|family|banquet|platter|box|pack|for \d|\d+\s*(?:x|pax|people|persons?))\b/i;
const COMBO_PENALTY = 0.3;

/**
 * Among a platform's fuzzy matches, pick the best one that has a usable price,
 * adding a penalty to combo/meal/multipack names so the plain à-la-carte item
 * wins when it exists. Returns the chosen platform item, or undefined.
 */
function pickBestPricedMatch(results, referenceName) {
  const refIsCombo = COMBO_RE.test(referenceName);
  let best;
  let bestScore = Infinity;
  for (const r of results) {
    if (!(r.item.unitPrice > 0)) continue;
    let score = r.score ?? 0;
    if (!refIsCombo && COMBO_RE.test(r.item.name)) score += COMBO_PENALTY;
    if (score < bestScore) {
      bestScore = score;
      best = r.item;
    }
  }
  return best;
}

/**
 * Cost of the reference item's selected options on a platform. Each option is
 * fuzzy-matched against that platform's own modifiers and priced at its rate:
 * within its own group first, when both sides carry a group name, to disambiguate
 * names repeated across groups (e.g. "No Thanks" in both "Add a Side?" and "Add a
 * Shake?"), retrying the whole pool on an in-group miss since platforms group the
 * same option differently. Hits prefer the option's price band (paid↔paid,
 * free↔free) so a paid selection isn't priced by a free negation, and each
 * platform modifier resolves at most one selection. An option the platform
 * doesn't list falls back to the source price and is flagged (unless the fallback
 * price is £0, since a free-option miss shouldn't make the total look estimated).
 * @param {{options?: Array<{group?: string, name: string, price: number}>, optionsTotal?: number}} ref
 * @param {Array<{name: string, price: number, id?: string, groupId?: string, group?: string}>} [platformModifiers]
 * @returns {{cost: number, estimated: boolean, matched: Array, unresolved: number}}
 *   `matched` holds the platform modifier objects (with ids) for the selected options
 *   that resolved; `unresolved` counts selected options with no platform modifier.
 */
function priceOptions(ref, platformModifiers) {
  const options = ref.options ?? [];
  // No per-option names captured (e.g. a non-Uber source) — fall back to the sum.
  // Such options can't be targeted for pre-fill, so count them as unresolved.
  if (!options.length) {
    const total = ref.optionsTotal || 0;
    return { cost: total, estimated: total > 0, matched: [], unresolved: total > 0 ? 1 : 0 };
  }
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
    ? new Fuse(groupNames.map((name) => ({ name })), { keys: ['name'], threshold: FUSE_THRESHOLD })
    : null;
  const fuseByPool = new Map(); // candidate pool -> Fuse index, reused across options

  let cost = 0;
  let estimated = false;
  let unresolved = 0;
  const matched = [];
  // Each platform modifier resolves at most one selection: the builder can only
  // tick it once, so letting duplicates share a hit would double-count its price
  // while the basket silently ends up with a single selection.
  const used = new Set();
  // A decline ("No Thanks", "No Dressing", "None") means "select nothing" in its
  // group. It may only resolve to another decline — never a positive option (live:
  // "No Dressing" fuzzy-matched the group's only option "Balsamic Dressing" and
  // the builder added a dressing the user refused) — and never outside its group
  // (a decline is meaningless elsewhere). When the target group has no decline
  // option, the group is decline-by-omission: skipping is exactly the selection.
  const isDecline = (name) => /^(no|none|without)\b/i.test(String(name ?? '').trim());
  for (const opt of options) {
    const declined = isDecline(opt.name);
    // Candidate pool: the option's own group when we can match it, else all mods.
    let pool = mods;
    if (opt.group && groupFuse) {
      const gName = groupFuse.search(opt.group)[0]?.item.name;
      if (gName != null) pool = byGroup.get(gName);
    }
    // Prefer a hit in the option's own price band (paid↔paid, free↔free): fuzzy
    // scores rank a free negation ("No Cheese") above the paid variant ("Extra
    // Cheese") for a query like "Cheese", which would price a paid selection at £0
    // and put the negation's id in the basket plan.
    const bestHit = (candidates) => {
      if (!candidates.length) return null;
      let fuse = fuseByPool.get(candidates);
      if (!fuse) {
        fuse = new Fuse(candidates, { keys: ['name'], threshold: FUSE_THRESHOLD });
        fuseByPool.set(candidates, fuse);
      }
      const results = fuse.search(opt.name)
        .filter((r) => !used.has(r.item))
        // decline-ness must agree in both directions.
        .filter((r) => isDecline(r.item.name) === declined);
      const wantPaid = opt.price > 0;
      return (results.find((r) => (r.item.price > 0) === wantPaid) ?? results[0])?.item ?? null;
    };
    let hit = bestHit(pool);
    // Platforms group the same option differently, so an in-group miss retries the
    // whole pool before the option is declared unresolved — except declines, which
    // only make sense within their own group.
    if (!hit && pool !== mods && !declined) hit = bestHit(mods);
    if (hit) {
      used.add(hit);
      cost += hit.price;
      matched.push(hit);
    } else if (declined) {
      // No decline option on the target: selecting nothing IS the decline.
    } else {
      cost += opt.price;
      if (opt.price > 0) estimated = true; // a £0 miss doesn't flag the total as estimated
      unresolved += 1;
    }
  }
  return { cost, estimated, matched, unresolved };
}

// Instructions a basket-builder needs to add one matched line on the target
// platform: the item id, the quantity ordered, and the resolved modifier options
// (with their ids). `prefillable` is false when the item has no id, or any selected
// option couldn't be resolved to a platform modifier — those lines fall back to
// being added manually by the user.
function buildBasketLine(ref, item, matchedModifiers, unresolved) {
  const modifiers = matchedModifiers.map((m) => ({ id: m.id, groupId: m.groupId, group: m.group ?? '', name: m.name }));
  return {
    id: item.id,
    variationId: item.variationId,
    name: item.name,
    quantity: ref.quantity ?? 1,
    modifiers,
    prefillable: item.id != null && unresolved === 0,
  };
}

/**
 * @param {Array<{name: string, quantity: number, unitPrice: number}>} referenceItems
 * @param {Array<{name: string, description?: string, unitPrice: number}>} platformItems
 * @returns {Array<{referenceItem, platformItem, matched: boolean, basketLine}>}
 */
function matchItems(referenceItems, platformItems) {
  const fuse = new Fuse(platformItems, {
    keys: [
      { name: 'name', weight: 0.8 },
      { name: 'description', weight: 0.2 },
    ],
    threshold: FUSE_THRESHOLD,
    includeScore: true,
  });

  return referenceItems.map((ref) => {
    // Size-upgrade retargeting (issue #28): Uber sells sizes as a modifier on the
    // base item ("Select Option: … Large Meal (£1.10)"), other platforms as
    // separate items. An option whose name equals the reference's name up to size
    // words is the same product in another size — when THIS platform lists that
    // size as its own item (exact normalized name), the line retargets to it and
    // the upgrade option is consumed. Otherwise everything falls through to the
    // base-item path (the upgrade stays an option: resolved as a modifier on
    // platforms that also sell sizes as modifiers, or honestly unresolved).
    let effectiveRef = ref;
    const upgrade = (ref.options ?? []).find((o) =>
      o.name
      && normalize(o.name) !== normalize(ref.name)
      && sizeAgnostic(o.name) === sizeAgnostic(ref.name));
    if (upgrade) {
      const sized = platformItems.find((i) => i.unitPrice > 0 && normalize(i.name) === normalize(upgrade.name));
      if (sized) {
        effectiveRef = { ...ref, name: sized.name, options: ref.options.filter((o) => o !== upgrade) };
      }
    }

    const results = fuse.search(effectiveRef.name);
    // Menus often have several entries matching the same words — a £0 combo-builder
    // placeholder, the real à-la-carte item, and bundles/meals that cost far more.
    // Pick the best-scoring priced match, de-prioritising combos; if none qualify
    // it's unmatched, which counts against completeness rather than silently
    // lowering the total with a £0 (or wildly inflating it with a meal deal).
    const item = pickBestPricedMatch(results, effectiveRef.name);
    if (!item) {
      return { referenceItem: ref, platformItem: null, matched: false, basketLine: null };
    }
    // Price the user's selected options using THIS platform's own modifier prices
    // where it lists them (exact); fall back to the source price and flag as an
    // estimate only for options this platform doesn't have.
    const { cost, estimated, matched, unresolved } = priceOptions(effectiveRef, item.modifiers);
    const platformItem = cost
      ? { ...item, unitPrice: item.unitPrice + cost, optionsEstimated: estimated }
      : item;
    return { referenceItem: ref, platformItem, matched: true, basketLine: buildBasketLine(ref, item, matched, unresolved) };
  });
}

/**
 * Apply offers against the matched cart. Order-level offers act on the subtotal:
 * free-delivery offers zero the delivery fee; the single best-value percentage
 * offer (capped) becomes a discount; legacy offers carrying a fixed `amount` are
 * summed. `item-deal` offers are item-level and quantity-dependent, applied against
 * the eligible matched lines (see itemDealDiscount) and reported in appliedDeals.
 * Offers whose minimum spend isn't met, or whose eligible items aren't in the cart,
 * are left for display only.
 * @param {Array<{referenceItem, platformItem, matched: boolean}>} matches - matched
 *   cart lines; item-deals locate their eligible items here (never the raw menu).
 * @returns {{deliveryFee: number, discountTotal: number, appliedDeals: Array<{description: string, discount: number}>}}
 */
function applyOffers(offers, itemsTotal, deliveryFee, matches = []) {
  let effectiveDelivery = deliveryFee;
  let discountTotal = 0;
  let bestPercentDiscount = 0;
  const appliedDeals = [];
  for (const o of offers) {
    if (o.minSpend && itemsTotal < o.minSpend) continue;
    if (o.type === 'free-delivery') {
      effectiveDelivery = 0;
    } else if (o.type === 'percent' && o.percent > 0) {
      const d = Math.min(itemsTotal * o.percent, o.cap ?? Infinity);
      bestPercentDiscount = Math.max(bestPercentDiscount, d);
    } else if (o.type === 'item-deal') {
      const d = itemDealDiscount(o, matches);
      if (d > 0) {
        discountTotal += d;
        appliedDeals.push({ description: o.description ?? '', discount: d });
      }
    } else if (o.amount > 0) {
      discountTotal += o.amount;
    }
  }
  return { deliveryFee: effectiveDelivery, discountTotal: discountTotal + bestPercentDiscount, appliedDeals };
}

// Unit prices of the matched lines whose branch item is eligible for a deal,
// each expanded by the line's ordered quantity. Eligible names come from the SAME
// platform's catalogue as the matched item names (offer item ids resolved to
// names), so eligibility is exact equality (case/whitespace-insensitive) — fuzzy
// matching here invented discounts for similar-but-different products
// ("6 Boneless & a dip" qualifying for a deal on "6 boneless saucin' wings").
function eligibleUnitPrices(offer, matches) {
  const eligible = new Set((offer.eligibleItems ?? []).map(normalize));
  if (!eligible.size) return [];
  const units = [];
  for (const m of matches) {
    if (!m.matched || !eligible.has(normalize(m.platformItem.name))) continue;
    for (let q = 0; q < m.referenceItem.quantity; q++) units.push(m.platformItem.unitPrice);
  }
  return units;
}

// Discount contributed by a single item-level deal, applied against the matched
// cart only. Returns 0 when the deal's eligible items aren't present.
function itemDealDiscount(offer, matches) {
  const units = eligibleUnitPrices(offer, matches);
  if (offer.rule === 'cheapest-free') {
    const freeCount = Math.floor(units.length / (offer.quantity || 2));
    if (freeCount <= 0) return 0;
    return units
      .slice()
      .sort((a, b) => a - b)
      .slice(0, freeCount)
      .reduce((s, p) => s + p, 0);
  }
  if (offer.rule === 'percent-off-items') {
    const eligibleSubtotal = units.reduce((s, p) => s + p, 0);
    return Math.min(eligibleSubtotal * (offer.percent ?? 0), offer.cap ?? Infinity);
  }
  if (offer.rule === 'free-item') {
    // The named item becomes free once; if several are in the cart, free the
    // cheapest unit (conservative, deterministic).
    return units.length ? Math.min(...units) : 0;
  }
  return 0;
}

/**
 * @param {Array<{referenceItem, platformItem, matched: boolean}>} matches
 * @param {number} deliveryFee
 * @param {number} serviceFee - flat fee; if 0 and serviceFeePct is given, the fee
 *   is estimated as a percentage of the matched subtotal (capped) and flagged.
 * @param {Array<{type?: string, minSpend?: number, percent?: number, cap?: number, amount?: number, description?: string, rule?: 'cheapest-free'|'percent-off-items'|'free-item', eligibleItems?: string[], quantity?: number}>} offers
 *   Order-level offers plus optional `item-deal`s (rule + eligibleItems, applied
 *   against the matched cart). Applied item-deals are listed in result.appliedDeals.
 * @param {{serviceFeePct?: number, serviceFeeMin?: number, serviceFeeMax?: number, serviceFeeEstimated?: boolean, deliveryFeeBands?: Array<{minSubtotal: number, fee: number}>}} [opts]
 *   deliveryFeeBands, when given, override the flat deliveryFee: the band with the
 *   highest minSubtotal at or below the matched subtotal is used.
 */
function computeTotal(matches, deliveryFee, serviceFee, offers, opts = {}) {
  const serviceFeePct = opts.serviceFeePct ?? 0;
  const serviceFeeMin = opts.serviceFeeMin ?? 0;
  const serviceFeeMax = opts.serviceFeeMax ?? Infinity;
  const itemsTotal = matches
    .filter((m) => m.matched)
    .reduce((sum, m) => sum + m.platformItem.unitPrice * m.referenceItem.quantity, 0);

  // Prefer a scraped flat fee; otherwise derive it from the matched subtotal,
  // clamped to the platform's min/max. Whether that derivation is exact (Just Eat
  // publishes the formula) or a guess (Deliveroo) is signalled by opts.
  let effectiveServiceFee = serviceFee;
  let serviceFeeEstimated = false;
  if (!effectiveServiceFee && serviceFeePct > 0) {
    effectiveServiceFee = Math.min(Math.max(itemsTotal * serviceFeePct, serviceFeeMin), serviceFeeMax);
    serviceFeeEstimated = opts.serviceFeeEstimated ?? false;
  }

  // Just Eat delivery fees are banded by basket subtotal (higher spend -> cheaper),
  // so select the band with the highest threshold the matched subtotal meets; the
  // flat deliveryFee is the fallback for platforms that publish no bands.
  let baseDelivery = deliveryFee;
  const bands = opts.deliveryFeeBands;
  if (Array.isArray(bands) && bands.length) {
    const applicable = bands
      .filter((b) => (b.minSubtotal ?? 0) <= itemsTotal)
      .sort((a, b) => (b.minSubtotal ?? 0) - (a.minSubtotal ?? 0))[0];
    if (applicable) baseDelivery = applicable.fee ?? 0;
  }

  const { deliveryFee: effectiveDelivery, discountTotal, appliedDeals } = applyOffers(
    offers,
    itemsTotal,
    baseDelivery,
    matches
  );

  return {
    itemsTotal,
    deliveryFee: effectiveDelivery,
    serviceFee: effectiveServiceFee,
    serviceFeeEstimated,
    discountTotal,
    appliedDeals,
    total: itemsTotal + effectiveDelivery + effectiveServiceFee - discountTotal,
    matchedCount: matches.filter((m) => m.matched).length,
    totalCount: matches.length,
  };
}

// Other Uber branches are scraped from their store page's JSON-LD, which carries
// item prices but no fees. Estimate their fees from the live cart (same platform,
// same delivery area): reuse its delivery fee and apply its service-fee rate
// (serviceFee / subtotal) to each branch's subtotal. Totals built this way are
// flagged estimated via computeTotal's serviceFeeEstimated.
function estimateUberFees(order) {
  const discountTotal = (order.discounts ?? []).reduce((s, d) => s + d.amount, 0);
  const itemsKnown = (order.items ?? []).some((i) => i.unitPrice > 0);
  const subtotal = itemsKnown
    ? order.items.reduce((s, i) => s + i.unitPrice * i.quantity, 0)
    : order.checkoutTotal - order.deliveryFee - order.serviceFee + discountTotal;
  return {
    deliveryFee: order.deliveryFee ?? 0,
    serviceFeePct: subtotal > 0 ? order.serviceFee / subtotal : 0,
  };
}

module.exports = { matchItems, computeTotal, estimateUberFees };
