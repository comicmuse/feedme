const Fuse = require('fuse.js');

const FUSE_THRESHOLD = 0.4;

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
  if (!targetName) return [];
  const fuse = new Fuse(candidates, { keys: ['name'], threshold: FUSE_THRESHOLD });
  const matched = fuse.search(targetName).map((r) => r.item);
  const seen = new Set();
  const unique = [];
  for (const c of matched) {
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    unique.push(c);
  }
  unique.sort((a, b) => (a.distance ?? Infinity) - (b.distance ?? Infinity));
  return unique.slice(0, n);
}

// Build branch candidates from a Just Eat area-listing __NEXT_DATA__ object.
// brandName is the chain ("Burger King"); name may carry the locality. The
// label prefers an explicit area field, falling back to the suffix of name.
function justEatCandidates(nextData) {
  const map = findByKey(nextData, 'restaurantData') || {};
  return Object.values(map)
    .filter((r) => r && r.uniqueName && r.name)
    .map((r) => ({
      id: r.uniqueName,
      name: r.brandName || r.name,
      label: r.cuisineArea || (r.name.includes(' - ') ? r.name.split(' - ').pop().trim() : ''),
      distance: typeof r.distanceInMiles === 'number' ? r.distanceInMiles : null,
      menuUrl: `/restaurants-${r.uniqueName}/menu`,
    }));
}

module.exports = { findByKey, selectNearestBranches, justEatCandidates };
