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

// Metres-per-mile, for converting Just Eat's driveDistanceMeters to miles so
// distances are comparable with the other platforms.
const METRES_PER_MILE = 1609.344;

// Build branch candidates from a Just Eat area-listing __NEXT_DATA__ object.
// Field names confirmed against live restaurantData (Task 11): each record has
// `id`, `uniqueName`, `name` (carries brand + locality, e.g. "KFC Bishopsgate"),
// `driveDistanceMeters`, and an `address` object. There is no brandName /
// distanceInMiles / cuisineArea. The label uses the street (address.firstLine),
// falling back to the city; distance is metres converted to miles.
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
    }));
}

module.exports = { findByKey, selectNearestBranches, justEatCandidates };
