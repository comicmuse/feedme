// Distance is stored to full parseFloat precision (branch.distance) so
// selectNearestBranches can sort on it — this only rounds it for display.
// Scrapers report null when a branch published no distance; that renders
// as '' so callers can skip the sub-line entirely rather than show "mi".
function formatDistance(miles) {
  if (miles == null) return '';
  return `${miles.toFixed(1)} mi`;
}

module.exports = { formatDistance };
