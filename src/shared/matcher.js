const Fuse = require('fuse.js');

const FUSE_THRESHOLD = 0.4;

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
    // Menus often have several entries with the same name — a £0 combo-builder
    // placeholder alongside the real à-la-carte item (and meal deals). Take the
    // best-scoring match that actually has a usable price; if none do, it's
    // unmatched, which counts against the platform's completeness rather than
    // silently lowering its total with a £0 line.
    const item = results.find((r) => r.item.unitPrice > 0)?.item;
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
 * @param {Array<{referenceItem, platformItem, matched: boolean}>} matches
 * @param {number} deliveryFee
 * @param {number} serviceFee - flat fee; if 0 and serviceFeePct is given, the fee
 *   is estimated as a percentage of the matched subtotal (capped) and flagged.
 * @param {Array<{amount: number, label: string}>} discounts
 * @param {{serviceFeePct?: number, serviceFeeMin?: number, serviceFeeMax?: number, serviceFeeEstimated?: boolean}} [opts]
 */
function computeTotal(matches, deliveryFee, serviceFee, discounts, opts = {}) {
  const serviceFeePct = opts.serviceFeePct ?? 0;
  const serviceFeeMin = opts.serviceFeeMin ?? 0;
  const serviceFeeMax = opts.serviceFeeMax ?? Infinity;
  const itemsTotal = matches
    .filter((m) => m.matched)
    .reduce((sum, m) => sum + m.platformItem.unitPrice * m.referenceItem.quantity, 0);
  const discountTotal = discounts.reduce((sum, d) => sum + d.amount, 0);

  // Prefer a scraped flat fee; otherwise derive it from the matched subtotal,
  // clamped to the platform's min/max. Whether that derivation is exact (Just Eat
  // publishes the formula) or a guess (Deliveroo) is signalled by opts.
  let effectiveServiceFee = serviceFee;
  let serviceFeeEstimated = false;
  if (!effectiveServiceFee && serviceFeePct > 0) {
    effectiveServiceFee = Math.min(Math.max(itemsTotal * serviceFeePct, serviceFeeMin), serviceFeeMax);
    serviceFeeEstimated = opts.serviceFeeEstimated ?? false;
  }

  return {
    itemsTotal,
    deliveryFee,
    serviceFee: effectiveServiceFee,
    serviceFeeEstimated,
    discountTotal,
    total: itemsTotal + deliveryFee + effectiveServiceFee - discountTotal,
    matchedCount: matches.filter((m) => m.matched).length,
    totalCount: matches.length,
  };
}

module.exports = { matchItems, computeTotal };
