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

// Drop a trailing plural/possessive "s" so a brand written both ways reads the
// same ("Tayyabs" == "Tayyab"). Tokens of three characters or fewer are left
// alone: there the "s" carries too much of the word to strip safely.
function brandStem(token) {
  return token.length > 3 && token.endsWith('s') ? token.slice(0, -1) : token;
}

/**
 * Whether two restaurant names denote the same brand, comparing leading tokens.
 * Branch names diverge after the brand ("Subway", "Subway - Mile End", "Subway
 * Chronos Building …"), so only the first token is compared; "BurgerMania" is a
 * single token != "burger" and so never matches "Burger King".
 * @param {string} candidateName
 * @param {string} targetName
 * @param {{stemmed?: boolean}} [opts] stemmed: also ignore a trailing "s" (#89).
 */
function sameBrand(candidateName, targetName, { stemmed = false } = {}) {
  const a = nameTokens(candidateName)[0];
  const b = nameTokens(targetName)[0];
  if (!a || !b) return false;
  return stemmed ? brandStem(a) === brandStem(b) : a === b;
}

/**
 * From a platform's branch candidates, keep those that match the chain name,
 * de-dupe by id, sort by ascending distance, and take the nearest n.
 * A single independent restaurant is the degenerate case: one match in, one out.
 * @param {Array<{id:string,name:string,label:string,distance:?number,menuUrl:string}>} candidates
 * @param {string} targetName
 * @param {number} n
 */
function selectNearestBranches(candidates, targetName, n) {
  if (!nameTokens(targetName)[0]) return [];
  const seen = new Set();
  const exact = [];
  const stemmed = [];
  for (const c of candidates) {
    // A true sibling brand sharing the first word ("Burger Eats" vs "Burger
    // King") survives here and is dropped later by the cart item match.
    if (!sameBrand(c.name, targetName, { stemmed: true })) continue;
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    (sameBrand(c.name, targetName) ? exact : stemmed).push(c);
  }
  const byDistance = (a, b) => (a.distance ?? Infinity) - (b.distance ?? Infinity);
  exact.sort(byDistance);
  stemmed.sort(byDistance);
  // Exact matches claim the nearest-n slots first; stemmed ones (#89) only fill
  // what is left over. Ranking rather than falling back matters because an exact
  // match can be the WRONG restaurant: live 2026-08-02, Uber's search for
  // "Tayyabs" returns both "Tayyabs Express" (Ilford, exact, ~8mi) and the
  // intended "Tayyab Sheesh Kebab" (stemmed, 0.4mi), so a fallback that ran only
  // when exact found nothing would still never reach the right store.
  return exact.concat(stemmed).slice(0, n);
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

// Only these fields cross the wire to the service worker's BRANCHES_FOUND handler.
function projectBranch({ id, label, distance, menuUrl, listedDeliveryFee, earnsStampCard }) {
  return { id, label, distance, menuUrl, listedDeliveryFee, earnsStampCard };
}

/**
 * The Just Eat enumerate-phase poll predicate (#105).
 *
 * `readyState:"complete"` does NOT mean #__NEXT_DATA__ is done: Just Eat keeps
 * rewriting it after load — first with an empty listing (location unresolved),
 * then streaming ~5 MB of restaurantData in. Gating on the substring
 * "restaurantData" (which appears near the START of the blob) fired on a partial,
 * still-streaming value, so JSON.parse threw on a torn read and the failure was
 * swallowed as an empty area.
 *
 * Poll on THIS instead: it returns the parsed data ONLY when the text is a
 * complete, parseable blob that already carries real candidates. A truncated
 * mid-stream read fails to parse and a pre-location-resolution read yields 0
 * candidates — both return null, so the poll simply keeps waiting.
 *
 * @param {?string} text  #__NEXT_DATA__.textContent
 * @returns {?object} the parsed __NEXT_DATA__ object, or null to keep waiting
 */
function readCompleteAreaListing(text) {
  if (!text) return null;
  let data;
  try {
    data = JSON.parse(text);
  } catch (_) {
    // Torn read: the blob is still streaming. Not an error — keep polling.
    return null;
  }
  // Parsed clean, but a listing read before the location resolves has an empty
  // restaurantData map. Wait for candidates rather than report a false empty.
  return justEatCandidates(data).length ? data : null;
}

/**
 * Decide what a Just Eat area-listing read means, given the parsed data the poll
 * resolved with (or null if it timed out). Pure so the three enumerate outcomes
 * can be unit-tested without the scraper IIFE (#105):
 *
 *  - `unreadable` — no complete, candidate-bearing blob ever arrived. The caller
 *    must surface this as RETRYABLE (like the enum timeout), never as an empty.
 *  - `empty`      — the listing was read, but nothing matched the target brand.
 *    This is the only honest "No branches found".
 *  - `matched`    — the listing was read and yielded branches.
 *
 * @param {?object} data  parsed __NEXT_DATA__ from readCompleteAreaListing, or null
 * @param {string} targetName  the chain being compared
 * @param {number} branchCount  nearest-N to keep
 * @returns {{status:'unreadable'} | {status:'empty',candidateCount:number} | {status:'matched',branches:object[],candidateCount:number}}
 */
function classifyAreaEnumeration(data, targetName, branchCount) {
  if (!data) return { status: 'unreadable' };
  const candidates = justEatCandidates(data);
  const branches = selectNearestBranches(candidates, targetName ?? '', branchCount).map(projectBranch);
  return branches.length
    ? { status: 'matched', branches, candidateCount: candidates.length }
    : { status: 'empty', candidateCount: candidates.length };
}

module.exports = {
  findByKey,
  selectNearestBranches,
  justEatCandidates,
  nameTokens,
  sameBrand,
  readCompleteAreaListing,
  classifyAreaEnumeration,
};
