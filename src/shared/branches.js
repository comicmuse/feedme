// Normalise a restaurant name to comparable tokens: lowercase, drop apostrophes
// (so "Tony's" == "Tonys"), split on any other non-alphanumeric run.
function nameTokens(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

// Recursively locate a named property (some platform blobs nest the data at a
// deep, version-dependent path). Shared by the Just Eat scraper and candidate
// extraction.
function findByKey(obj, key, depth = 0) {
  if (depth > 12 || !obj || typeof obj !== 'object') return null;
  if (obj[key] && typeof obj[key] === 'object') return obj[key];
  for (const k of Object.keys(obj)) {
    const found = findByKey(obj[k], key, depth + 1);
    if (found) return found;
  }
  return null;
}

/**
 * From a platform's branch candidates, keep those that fuzzy-match the chain
 * name, de-dupe by id, sort by ascending distance, and take the nearest n.
 * A single independent restaurant is the degenerate case: one match in, one out.
 * @param {Array<{id:string,name:string,label:string,distance:?number,menuUrl:string}>} candidates
 * @param {string} targetName
 * @param {number} n
 */
function selectNearestBranches(candidates, targetName, n) {
  const brand = nameTokens(targetName)[0];
  if (!brand) return [];
  const seen = new Set();
  const matched = [];
  for (const c of candidates) {
    // Brand match on the first token (whole word). Branch names diverge after the
    // brand ("Subway", "Subway - Mile End", "Subway Chronos Building …"), so we
    // anchor on the leading token only. "BurgerMania" is one token != "burger" so
    // it's excluded; a true sibling brand sharing the first word ("Burger Eats"
    // vs "Burger King") survives here and is dropped later by the cart item match.
    if (nameTokens(c.name)[0] !== brand) continue;
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    matched.push(c);
  }
  matched.sort((a, b) => (a.distance ?? Infinity) - (b.distance ?? Infinity));
  return matched.slice(0, n);
}

// Metres-per-mile, for converting Just Eat's driveDistanceMeters to miles so
// distances are comparable with the other platforms.
const METRES_PER_MILE = 1609.344;

// Build branch candidates from a Just Eat area-listing __NEXT_DATA__ object.
// Field names confirmed against live restaurantData (Task 11): each record has
// `id`, `uniqueName`, `name` (carries brand + locality, e.g. "KFC Bishopsgate"),
// `driveDistanceMeters`, and an `address` object. There is no brandName /
// distanceInMiles / cuisineArea. The label uses the street (address.firstLine),
// falling back to the city; distance is metres converted to miles.
// The listing's per-branch `deliveryFees` summary is POSTCODE-ADJUSTED — it is
// the fee the basket actually charges, unlike menu/dynamic's base bands (live:
// Popeyes Whitechapel dynamic said £0.59 while the listing for the user's
// postcode and the real basket both said £0.79). Fees arrive in pence.
function listedDeliveryFee(r) {
  const df = r.deliveryFees;
  if (!df || !df.byMinFee) return null;
  return {
    min: (df.byMinFee.fee ?? 0) / 100,
    max: (df.byMaxFee?.fee ?? df.byMinFee.fee ?? 0) / 100,
    numBands: df.numBands ?? 1,
  };
}

// Whether this branch is in the StampCard scheme. The listing's `deals` array
// carries a typed `offerType` per offer (live 2026-08-02 at one E1 postcode:
// StampCard 824, Percent 566, ItemLevelDiscount 180, FreeItem 136,
// BogofMixMatch 117, Notification 9), so participation needs no login and no
// extra request. Cross-checked against the authenticated
// consumers/uk/stampcards/status/{id} endpoint's `optInDate != null` over a
// 24-branch sample (12 with, 12 without): 24/24 agreement.
// That endpoint's `offerInformation` is deliberately NOT used — it returns the
// same scheme-wide default (size 5, 10%) even for branches with optInDate null,
// so reading it would flag every restaurant on Just Eat.
function earnsStampCard(r) {
  return Array.isArray(r.deals) && r.deals.some((d) => d && d.offerType === 'StampCard');
}

function justEatCandidates(nextData) {
  const map = findByKey(nextData, 'restaurantData') || {};
  return Object.values(map)
    .filter((r) => r && r.uniqueName && r.name)
    .map((r) => ({
      id: r.id || r.uniqueName,
      name: r.name,
      label: (r.address && (r.address.firstLine || r.address.city)) || '',
      distance: typeof r.driveDistanceMeters === 'number' ? r.driveDistanceMeters / METRES_PER_MILE : null,
      menuUrl: `/restaurants-${r.uniqueName}/menu`,
      listedDeliveryFee: listedDeliveryFee(r),
      earnsStampCard: earnsStampCard(r),
    }));
}

module.exports = { findByKey, selectNearestBranches, justEatCandidates, nameTokens };
