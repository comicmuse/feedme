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
 * @param {Set<string>} enumErrors platforms whose enumeration timed out
 */
function buildSnapshot(order, branches, loadingPlatforms, enumErrors = new Set()) {
  const current = branches.find((b) => b.isCurrent);
  const currentTotal = current && current.status === 'done' ? current.result.total.total : Infinity;

  const platforms = ORDER.map((platform) => ({
    platform,
    spinner: loadingPlatforms.has(platform),
    enumFailed: enumErrors.has(platform),
    branches: branches.filter((b) => b.platform === platform),
  }));

  // Overall cheapest complete branch across everything, including the current one.
  // This is the only branch the sidebar highlights (no per-column highlight).
  let overall = null;
  for (const b of branches) {
    if (!isComplete(b)) continue;
    if (!overall || b.result.total.total < overall.result.total.total) overall = b;
  }

  // A branch that priced only part of the cart is cheaper for a reason that is
  // not a saving, so it can never win — but leaving that unsaid puts a lower
  // number on screen beside "you're already on the cheapest branch" and reads as
  // the comparison being broken (#3). Name the nearest such miss so the sidebar
  // can explain itself: fewest missing items first, then cheapest, because the
  // closest thing to a real alternative is the one short of the least.
  const undercutOf = (winner) => {
    if (!winner) return undefined;
    const missing = (b) => b.result.total.totalCount - b.result.total.matchedCount;
    const contenders = branches
      .filter((b) => b.status === 'done' && b.result.total && !isComplete(b))
      .filter((b) => b.result.total.total < winner.result.total.total)
      .sort((a, b) => missing(a) - missing(b) || a.result.total.total - b.result.total.total);
    const near = contenders[0];
    return near ? {
      platform: near.platform,
      label: near.label,
      total: near.result.total.total,
      matchedCount: near.result.total.matchedCount,
      totalCount: near.result.total.totalCount,
    } : undefined;
  };

  let footer;
  if (!overall) {
    footer = { kind: 'unknown' };
  } else if (overall.isCurrent || overall.result.total.total >= currentTotal) {
    footer = { kind: 'best', undercut: undercutOf(overall) };
  } else {
    footer = {
      kind: 'switch',
      key: overall.key,
      platform: overall.platform,
      label: overall.label,
      // The click target for the footer CTA; null when the branch's menu URL failed
      // origin validation (the sidebar then renders the footer non-clickable).
      switchUrl: overall.switchUrl ?? null,
      saving: currentTotal - overall.result.total.total,
      undercut: undercutOf(overall),
    };
  }

  return { platforms, cheapestKey: overall ? overall.key : null, footer, currentTotal: currentTotal === Infinity ? 0 : currentTotal };
}

/**
 * How much of the cart a branch actually priced, or null when it priced all of
 * it (or has nothing to say yet). The sidebar draws from this so the badge and
 * the cheapest-branch rule can never disagree about what "complete" means.
 * @param {object} branch
 * @returns {?{matchedCount:number,totalCount:number}}
 */
function branchShortfall(branch) {
  const total = branch && branch.status === 'done' ? branch.result?.total : null;
  if (!total || total.matchedCount === total.totalCount) return null;
  return { matchedCount: total.matchedCount, totalCount: total.totalCount };
}

module.exports = { buildSnapshot, branchShortfall };
