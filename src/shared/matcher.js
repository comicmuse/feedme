const Fuse = require('fuse.js');

const FUSE_THRESHOLD = 0.4;

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
 * fuzzy-matched against that platform's own modifiers and priced at its rate; an
 * option the platform doesn't list falls back to the source price and is flagged.
 * @param {{options?: Array<{name: string, price: number}>, optionsTotal?: number}} ref
 * @param {Array<{name: string, price: number}>} [platformModifiers]
 * @returns {{cost: number, estimated: boolean}}
 */
function priceOptions(ref, platformModifiers) {
  const options = ref.options ?? [];
  // No per-option names captured (e.g. a non-Uber source) — fall back to the sum.
  if (!options.length) {
    return { cost: ref.optionsTotal || 0, estimated: (ref.optionsTotal || 0) > 0 };
  }
  const fuse = platformModifiers && platformModifiers.length
    ? new Fuse(platformModifiers, { keys: ['name'], threshold: 0.4 })
    : null;
  let cost = 0;
  let estimated = false;
  for (const opt of options) {
    const hit = fuse ? fuse.search(opt.name)[0]?.item : null;
    if (hit) {
      cost += hit.price;
    } else {
      cost += opt.price;
      estimated = true;
    }
  }
  return { cost, estimated };
}

/**
 * @param {Array<{name: string, quantity: number, unitPrice: number}>} referenceItems
 * @param {Array<{name: string, description?: string, unitPrice: number}>} platformItems
 * @returns {Array<{referenceItem, platformItem, matched: boolean}>}
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
    const results = fuse.search(ref.name);
    // Menus often have several entries matching the same words — a £0 combo-builder
    // placeholder, the real à-la-carte item, and bundles/meals that cost far more.
    // Pick the best-scoring priced match, de-prioritising combos; if none qualify
    // it's unmatched, which counts against completeness rather than silently
    // lowering the total with a £0 (or wildly inflating it with a meal deal).
    const item = pickBestPricedMatch(results, ref.name);
    if (!item) {
      return { referenceItem: ref, platformItem: null, matched: false };
    }
    // Price the user's selected options using THIS platform's own modifier prices
    // where it lists them (exact); fall back to the source price and flag as an
    // estimate only for options this platform doesn't have.
    const { cost, estimated } = priceOptions(ref, item.modifiers);
    const platformItem = cost
      ? { ...item, unitPrice: item.unitPrice + cost, optionsEstimated: estimated }
      : item;
    return { referenceItem: ref, platformItem, matched: true };
  });
}

/**
 * Apply spend-threshold offers against the matched subtotal. Free-delivery offers
 * zero the delivery fee; the single best-value percentage offer (capped) becomes a
 * discount. Legacy offers carrying a fixed `amount` are still summed. Offers whose
 * minimum spend isn't met, or that we can't apply, are left for display only.
 * @returns {{deliveryFee: number, discountTotal: number}}
 */
function applyOffers(offers, itemsTotal, deliveryFee) {
  let effectiveDelivery = deliveryFee;
  let discountTotal = 0;
  let bestPercentDiscount = 0;
  for (const o of offers) {
    if (o.minSpend && itemsTotal < o.minSpend) continue;
    if (o.type === 'free-delivery') {
      effectiveDelivery = 0;
    } else if (o.type === 'percent' && o.percent > 0) {
      const d = Math.min(itemsTotal * o.percent, o.cap ?? Infinity);
      bestPercentDiscount = Math.max(bestPercentDiscount, d);
    } else if (o.amount > 0) {
      discountTotal += o.amount;
    }
  }
  return { deliveryFee: effectiveDelivery, discountTotal: discountTotal + bestPercentDiscount };
}

/**
 * @param {Array<{referenceItem, platformItem, matched: boolean}>} matches
 * @param {number} deliveryFee
 * @param {number} serviceFee - flat fee; if 0 and serviceFeePct is given, the fee
 *   is estimated as a percentage of the matched subtotal (capped) and flagged.
 * @param {Array<{type?: string, minSpend?: number, percent?: number, cap?: number, amount?: number, description?: string}>} offers
 * @param {{serviceFeePct?: number, serviceFeeMin?: number, serviceFeeMax?: number, serviceFeeEstimated?: boolean}} [opts]
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

  const { deliveryFee: effectiveDelivery, discountTotal } = applyOffers(offers, itemsTotal, deliveryFee);

  return {
    itemsTotal,
    deliveryFee: effectiveDelivery,
    serviceFee: effectiveServiceFee,
    serviceFeeEstimated,
    discountTotal,
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
