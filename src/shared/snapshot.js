const { PLATFORM } = require('./constants');

const ORDER = [PLATFORM.UBER_EATS, PLATFORM.DELIVEROO, PLATFORM.JUST_EAT];

function isComplete(b) {
  return b.status === 'done' && b.result.total &&
    b.result.total.matchedCount === b.result.total.totalCount;
}

/**
 * Build the render snapshot the sidebar draws from.
 * @param {{platform:string}} order
 * @param {Array} branches  branch records (see Task 5 interface)
 * @param {Set<string>} loadingPlatforms
 */
function buildSnapshot(order, branches, loadingPlatforms) {
  const current = branches.find((b) => b.isCurrent);
  const currentTotal = current && current.status === 'done' ? current.result.total.total : Infinity;

  const platforms = ORDER.map((platform) => ({
    platform,
    spinner: loadingPlatforms.has(platform),
    branches: branches.filter((b) => b.platform === platform),
  }));

  // Overall cheapest complete branch across everything, including the current one.
  // This is the only branch the sidebar highlights (no per-column highlight).
  let overall = null;
  for (const b of branches) {
    if (!isComplete(b)) continue;
    if (!overall || b.result.total.total < overall.result.total.total) overall = b;
  }

  let footer;
  if (!overall) {
    footer = { kind: 'unknown' };
  } else if (overall.isCurrent || overall.result.total.total >= currentTotal) {
    footer = { kind: 'best' };
  } else {
    footer = {
      kind: 'switch',
      platform: overall.platform,
      label: overall.label,
      saving: currentTotal - overall.result.total.total,
    };
  }

  return { platforms, cheapestKey: overall ? overall.key : null, footer, currentTotal: currentTotal === Infinity ? 0 : currentTotal };
}

module.exports = { buildSnapshot };
