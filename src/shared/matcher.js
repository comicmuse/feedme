const Fuse = require('fuse.js');

const FUSE_THRESHOLD = 0.4;

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
    if (results.length === 0) {
      return { referenceItem: ref, platformItem: null, matched: false };
    }
    return { referenceItem: ref, platformItem: results[0].item, matched: true };
  });
}

/**
 * @param {Array<{referenceItem, platformItem, matched: boolean}>} matches
 * @param {number} deliveryFee
 * @param {number} serviceFee
 * @param {Array<{amount: number, label: string}>} discounts
 */
function computeTotal(matches, deliveryFee, serviceFee, discounts) {
  const itemsTotal = matches
    .filter((m) => m.matched)
    .reduce((sum, m) => sum + m.platformItem.unitPrice * m.referenceItem.quantity, 0);
  const discountTotal = discounts.reduce((sum, d) => sum + d.amount, 0);
  return {
    itemsTotal,
    deliveryFee,
    serviceFee,
    discountTotal,
    total: itemsTotal + deliveryFee + serviceFee - discountTotal,
    matchedCount: matches.filter((m) => m.matched).length,
    totalCount: matches.length,
  };
}

module.exports = { matchItems, computeTotal };
