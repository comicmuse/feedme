// Uber renders an item's ingredient composition in the cart as one comma-joined
// row of the *kept* defaults ("Big Mac® Comes With: Sauce, Pickles, …"), so an
// ingredient the user removed shows up only as an absence. The full defaults are
// not on the store page — the store catalog blob carries no customisation data at
// all (probed live 2026-08-01) — they come from the per-item getMenuItemV1 API,
// where every option carries its defaultQuantity. Diffing the two yields the
// removals, which the target platform models as explicit "No X" options (#33).

// Composition groups are titled "<Item> Comes With"; every other group
// (additions, size pickers, add-ons) is a real selection group.
const COMES_WITH_RE = /\bcomes with$/i;

const sameDefaults = (a, b) =>
  a.size === b.size && [...a].every(([name, qty]) => b.get(name) === qty);

/**
 * Index an item's default composition from a getMenuItemV1 response.
 *
 * Customisation groups nest: each option may carry its own
 * `childCustomizationList`, so a meal's composition hangs several levels below
 * the top-level "Select Option" group. One item response repeats the same
 * composition group under every size branch (plain / Medium meal / Large meal)
 * with identical options, so entries merge by title. A title seen with genuinely
 * different defaults is dropped rather than resolved by guessing — same rule as
 * `uberCatalogIdByName` applies to a name with two uuids.
 *
 * @param {object} itemDetail the API response, or its inner `data` object
 * @returns {Map<string, Map<string, number>>} group title -> (option title -> defaultQuantity)
 */
function uberCompositionDefaults(itemDetail) {
  const byGroup = new Map();
  const conflicting = new Set();
  const walkGroup = (group) => {
    const title = String(group?.title ?? '').trim();
    const options = Array.isArray(group?.options) ? group.options : [];
    if (COMES_WITH_RE.test(title) && !conflicting.has(title)) {
      const defaults = new Map();
      for (const opt of options) {
        const name = String(opt?.title ?? '').trim();
        const qty = opt?.defaultQuantity ?? 0;
        if (name && qty >= 1) defaults.set(name, qty);
      }
      const existing = byGroup.get(title);
      if (existing == null) {
        byGroup.set(title, defaults);
      } else if (!sameDefaults(existing, defaults)) {
        byGroup.delete(title);
        conflicting.add(title);
      }
    }
    for (const opt of options) {
      for (const child of opt?.childCustomizationList ?? []) walkGroup(child);
    }
  };
  const root = itemDetail?.data ?? itemDetail;
  for (const group of root?.customizationsList ?? []) walkGroup(group);
  return byGroup;
}

module.exports = { uberCompositionDefaults };
