// What a switch needs to survive the service worker dying under it.
//
// FeedMe's comparison state lives in a Map in the MV3 service worker, which
// Chrome terminates after about 30 seconds idle (#103). The sidebar lives in the
// page and survives, so its buttons stay clickable and simply stop working. The
// fix is not to keep the worker alive — it is to notice that SWITCH_TO_BRANCH
// needs almost none of that state, and to keep that little bit somewhere the
// worker's death cannot reach.
//
// Deliberately a plain serialisable object: it goes through storage.session,
// which is structured-cloned and cleared when the browser closes. That lifetime
// is exactly right — a switch is only meaningful for the browsing session that
// produced the comparison.

// One entry per source tab, so two compared carts in two tabs cannot collide.
const switchTableKey = (tabId) => `switch|${tabId}`;

/**
 * Reduce live branch records to the fields a switch actually consumes.
 * Branches with no validated switchUrl are dropped rather than stored as
 * unusable rows: the handler would reject them anyway, and keeping them would
 * make a restored table look richer than it is.
 * @param {Iterable} branches live branch records
 */
function buildSwitchTable(branches) {
  const table = {};
  for (const b of branches || []) {
    if (!b || !b.key || !b.switchUrl) continue;
    table[b.key] = {
      platform: b.platform,
      label: b.label ?? null,
      switchUrl: b.switchUrl,
      isCurrent: !!b.isCurrent,
      // The plan is the point: without it a restored switch would open the
      // right menu and then fill nothing, which looks more broken than a dead
      // button rather than less.
      basketPlan: b.result?.basketPlan ?? [],
    };
  }
  return table;
}

/**
 * Look a branch up in a restored table.
 * @returns {?object} the entry, or null when absent or unusable
 */
function switchEntry(table, branchKey) {
  const entry = table && branchKey ? table[branchKey] : null;
  return entry && entry.switchUrl ? entry : null;
}

module.exports = { switchTableKey, buildSwitchTable, switchEntry };
