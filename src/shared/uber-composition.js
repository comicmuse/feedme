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

// The cart packs the kept defaults into one comma-joined value, each entry
// optionally prefixed with its quantity ("2 Beef Patty"). Returns one array of
// candidate readings per entry, so a caller can tell "this entry matched the
// catalogue somehow" from "this entry matched nothing at all".
function keptEntries(value) {
  const entries = [];
  for (const part of String(value ?? '').split(',')) {
    const entry = part.trim();
    if (!entry) continue;
    // Entries carry the kept quantity as a prefix ("2 Beef Patty"), but an
    // option's own name may legitimately start with a digit ("4 Chicken
    // McNuggets®"), so record both readings and let an exact catalogue match win.
    const stripped = entry.replace(/^\d+\s+/, '');
    entries.push(stripped && stripped !== entry ? [entry, stripped] : [entry]);
  }
  return entries;
}

/**
 * Diff the cart's kept composition against the item's defaults.
 *
 * A default missing from the kept list is an ingredient the user removed on
 * Uber. It's emitted as a decline in a synthetic "Remove" group: `priceOptions`
 * treats a name matching /^(no|none|without)\b/ as a decline, and a decline's
 * candidate pool locks to whichever target group "Remove" fuzzy-matched — it
 * never takes the widening retry that other options get (matcher.js:105-132).
 * Wherever it lands it can only pair with another decline, and finding none is
 * clean: omitting the selection IS the decline. Carrying the source group name
 * ("Big Mac® Comes With") instead would fuzzy-match nothing on any target.
 *
 * A quantity that was reduced but not to zero (2 patties -> 1) emits nothing:
 * no target platform models a partial reduction, so there is nothing honest to
 * put in the plan.
 *
 * Two guards keep a naming mismatch from removing food the user asked for:
 * the kept entries of one group are unioned across rows before diffing (the
 * cart parser can split one group's value over several spans), and a group with
 * any kept entry that matches no default is dropped whole — if the two sides
 * don't name ingredients identically, every absence is suspect.
 *
 * @param {Array<{group: string, name: string}>} compositionRows cart "Comes With" rows
 * @param {Map<string, Map<string, number>>} defaults from uberCompositionDefaults
 * @returns {Array<{group: string, name: string, price: number}>}
 */
function uberRemovals(compositionRows, defaults) {
  // Item titles already normalise on both sides of the lookup; group titles are
  // rendered by the cart and the API independently too, so key them the same way.
  const defaultsByGroup = new Map();
  const clashing = new Set();
  for (const [title, groupDefaults] of defaults ?? []) {
    const key = normalizeTitle(title);
    if (!key || clashing.has(key)) continue;
    const existing = defaultsByGroup.get(key);
    if (existing == null) {
      defaultsByGroup.set(key, groupDefaults);
    } else if (!sameDefaults(existing, groupDefaults)) {
      // Same group under two spellings with different defaults: no basis to pick.
      defaultsByGroup.delete(key);
      clashing.add(key);
    }
  }

  // One group's kept list may arrive as several rows; union them before diffing.
  const keptByGroup = new Map();
  for (const row of compositionRows ?? []) {
    const key = normalizeTitle(row?.group);
    if (!key || !defaultsByGroup.has(key)) continue;
    const entries = keptByGroup.get(key) ?? [];
    entries.push(...keptEntries(row?.name));
    keptByGroup.set(key, entries);
  }

  const removals = [];
  for (const [key, entries] of keptByGroup) {
    const groupDefaults = defaultsByGroup.get(key);
    const kept = new Set();
    let unrecognised = false;
    for (const readings of entries) {
      const known = readings.filter((r) => groupDefaults.has(r));
      if (!known.length) { unrecognised = true; break; }
      for (const name of known) kept.add(name);
    }
    if (unrecognised) continue;
    for (const name of groupDefaults.keys()) {
      if (!kept.has(name)) removals.push({ group: 'Remove', name: `No ${name}`, price: 0 });
    }
  }
  return removals;
}

// The cart line's name comes from the row's <img alt>, the draft order's from
// its `title` field. Normalise both sides so incidental case/spacing drift
// between the two doesn't lose the lookup.
const normalizeTitle = (s) => String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();

const sameIds = (a, b) =>
  a.storeUuid === b.storeUuid && a.sectionUuid === b.sectionUuid
  && a.subsectionUuid === b.subsectionUuid && a.itemUuid === b.itemUuid;

/**
 * Index the ids getMenuItemV1 needs, per cart item, from a
 * getDraftOrdersByEaterUuidV1 response's `draftOrders` array.
 *
 * Keyed by title because composition defaults belong to the *item*, not to the
 * line's own customisations: two differently-customised Big Mac lines resolve
 * through one entry. A title that genuinely points at two different items is
 * dropped rather than tagged with whichever line came first.
 *
 * @param {Array<object>} draftOrders
 * @returns {Map<string, {storeUuid: string, sectionUuid: string, subsectionUuid: string, itemUuid: string}>}
 */
function uberCartItemIds(draftOrders) {
  const byTitle = new Map();
  const ambiguous = new Set();
  for (const draft of draftOrders ?? []) {
    for (const item of draft?.shoppingCart?.items ?? []) {
      const key = normalizeTitle(item?.title);
      if (!key || ambiguous.has(key)) continue;
      const ids = {
        storeUuid: item.storeUuid,
        sectionUuid: item.sectionUuid,
        subsectionUuid: item.subsectionUuid,
        itemUuid: item.uuid,
      };
      if (Object.values(ids).some((v) => !v)) continue;
      const existing = byTitle.get(key);
      if (existing == null) {
        byTitle.set(key, ids);
      } else if (!sameIds(existing, ids)) {
        byTitle.delete(key);
        ambiguous.add(key);
      }
    }
  }
  return byTitle;
}

module.exports = { uberCompositionDefaults, uberRemovals, uberCartItemIds, normalizeTitle };
