const { PLATFORM, CHECKOUT_PATTERNS, MSG, JUST_EAT_SMALL_ORDER_THRESHOLD, buildSearchUrl, isAllowedMenuUrl, isMenuPageUrl, getConfig, browser } = require('../shared/constants');
const { matchItems, computeTotal, estimateUberFees, uberOneWaiverOffer, uberOneAccountOffers } = require('../shared/matcher');
const { buildSnapshot } = require('../shared/snapshot');
const { createScheduler } = require('../shared/pool');

// Keyed by source tabId.
const comparisons = new Map();

// Foreground tabs opened by a "switch" click, awaiting basket-building once loaded.
// Keyed by the new tab's id -> { platform, basketPlan }.
const pendingBuilds = new Map();

const ALL_PLATFORMS = [PLATFORM.UBER_EATS, PLATFORM.DELIVEROO, PLATFORM.JUST_EAT];

// Which dist script enumerates each platform, and how to start enumeration.
const ENUMERATORS = {
  [PLATFORM.DELIVEROO]: 'dist/deliveroo-scraper.js',
  [PLATFORM.JUST_EAT]: 'dist/just-eat-scraper.js',
  [PLATFORM.UBER_EATS]: 'dist/uber-scraper.js',
};
// Menu scraping: Deliveroo/Just Eat use their own script in menu mode; Uber uses
// the generic MAIN-world interceptor.
const MENU_SCRAPERS = {
  [PLATFORM.DELIVEROO]: { file: 'dist/deliveroo-scraper.js', world: 'ISOLATED' },
  [PLATFORM.JUST_EAT]: { file: 'dist/just-eat-scraper.js', world: 'ISOLATED' },
  // Other Uber branches are store pages: uber-scraper.js reads their JSON-LD menu
  // in menu mode (the old MAIN-world XHR interceptor only fits the checkout page).
  [PLATFORM.UBER_EATS]: { file: 'dist/uber-scraper.js', world: 'ISOLATED' },
};

const ENUM_TIMEOUT_MS = 30000;
const MENU_TIMEOUT_MS = 20000;

function findTab(tabId) {
  for (const comparison of comparisons.values()) {
    if (comparison.enumTabs.get(tabId)) {
      return { comparison, kind: 'enum', platform: comparison.enumTabs.get(tabId) };
    }
    const branchKey = comparison.menuTabs.get(tabId);
    if (branchKey) return { comparison, kind: 'menu', branchKey };
  }
  return null;
}

// ── Injection helper ─────────────────────────────────────────────────────────

async function injectInto(tabId, file, world, ctx, ctxKey = '__feedmeCompare') {
  await browser.scripting.executeScript({
    target: { tabId },
    func: (k, c) => { window[k] = c; },
    args: [ctxKey, ctx],
  }).catch(() => {});
  await browser.scripting.executeScript({
    target: { tabId },
    files: [file],
    ...(world === 'MAIN' ? { world: 'MAIN' } : {}),
  }).catch(() => {});
}

// ── Re-inject on tab load / SPA navigation for any comparison tab we own ────

browser.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status !== 'complete') return;
  const owner = findTab(tabId);
  if (!owner) return;
  injectForTab(tabId, owner);
});

// When a tab opened by a "switch" click finishes loading the branch's MENU page,
// inject the basket-builder once with its plan. A consent/login/location
// interstitial can fire status:complete first — consuming the plan there would
// inject the builder into the wrong document and lose the build — so the plan
// stays pending (cleared on tab close) until a complete lands on a menu URL.
// Once it does, clear it so SPA re-completes don't re-add items; the builder
// polls for readiness itself, so a single injection is enough.
browser.tabs.onUpdated.addListener(async (tabId, info) => {
  if (info.status !== 'complete') return;
  const build = pendingBuilds.get(tabId);
  if (!build) return;
  let url = '';
  try { url = (await browser.tabs.get(tabId)).url ?? ''; } catch (_) {}
  if (!isMenuPageUrl(build.platform, url)) {
    console.info('[FeedMe switch] tab', tabId, 'completed on a non-menu page — keeping build pending. url=', url);
    return;
  }
  pendingBuilds.delete(tabId);
  console.info('[FeedMe switch] injecting basket-builder into tab', tabId, 'url=', url,
    'plan lines=', build.basketPlan.map((l) => `${l.quantity}x ${l.name}`).join(', '));
  await injectInto(tabId, 'dist/basket-builder.js', 'ISOLATED', build, '__feedmeBuild');
});

// Drop a queued build if its tab is closed before it ever finished loading.
browser.tabs.onRemoved.addListener((tabId) => { pendingBuilds.delete(tabId); });
browser.webNavigation.onHistoryStateUpdated.addListener((details) => {
  const owner = findTab(details.tabId);
  if (owner) injectForTab(details.tabId, owner);
});

async function injectForTab(tabId, owner) {
  const { comparison } = owner;
  let url = '';
  try { url = (await browser.tabs.get(tabId)).url ?? ''; } catch (_) { return; }
  const dedupeKey = `${tabId}|${url}`;
  if (comparison.injectedUrls.has(dedupeKey)) return;
  comparison.injectedUrls.add(dedupeKey);

  if (owner.kind === 'enum') {
    await injectInto(tabId, ENUMERATORS[owner.platform], 'ISOLATED',
      { mode: 'enumerate', restaurantName: comparison.order.restaurantName, postcode: comparison.order.postcode, branchCount: comparison.branchCount });
  } else {
    const branch = comparison.branches.get(owner.branchKey);
    const spec = MENU_SCRAPERS[branch.platform];
    await injectInto(tabId, spec.file, spec.world,
      { mode: 'menu', restaurantName: comparison.order.restaurantName, postcode: comparison.order.postcode });
  }
}

// ── Re-inject checkout-reader on SPA navigation to checkout URLs ─────────────
// (Preserved from original — must not be removed.)

browser.webNavigation.onHistoryStateUpdated.addListener((details) => {
  const platform = Object.entries(CHECKOUT_PATTERNS).find(([, re]) => re.test(details.url))?.[0];
  if (!platform) return;
  browser.scripting.executeScript({
    target: { tabId: details.tabId },
    files: ['dist/checkout-reader.js'],
  }).catch(() => {});
});

// ── Store order + set badge when checkout-reader detects an order ─────────────
// (Preserved from original — must not be removed.)

browser.runtime.onMessage.addListener((msg, sender) => {
  if (msg.type !== MSG.ORDER_DETECTED) return;
  browser.storage.session.set({ currentOrder: msg.order });
  browser.action.setBadgeText({ text: '✓', tabId: sender.tab?.id });
  browser.action.setBadgeBackgroundColor({ color: '#22c55e', tabId: sender.tab?.id });
});

// ── START_COMPARISON: inject sidebar, seed current branch, open enum tabs ────

browser.runtime.onMessage.addListener(async (msg) => {
  if (msg.type !== MSG.START_COMPARISON) return;

  const stored = await browser.storage.session.get('currentOrder');
  const order = stored.currentOrder;
  if (!order || order.items.length === 0) return;

  const tabId = msg.tabId;
  const { branchCount, maxConcurrent } = await getConfig();
  await browser.scripting.executeScript({ target: { tabId }, files: ['dist/sidebar.js'] });

  const comparison = {
    sourceTabId: tabId,
    order,
    branchCount,
    branches: new Map(),               // branchKey -> branch record
    enumTabs: new Map(),               // tabId -> platform
    menuTabs: new Map(),               // tabId -> branchKey
    scheduler: createScheduler(maxConcurrent),
    queued: new Map(),                 // branchKey -> { platform, label, distance, menuUrl }
    loading: new Set(ALL_PLATFORMS),
    injectedUrls: new Set(),
    timeouts: new Map(),
    enumErrors: new Set(),             // platforms whose enumeration timed out (retryable)
  };
  comparisons.set(tabId, comparison);

  // Seed the current branch from the live order (authoritative, not scraped).
  seedCurrentBranch(comparison);
  pushUpdate(comparison);

  for (const platform of ALL_PLATFORMS) {
    await startEnumeration(comparison, platform);
  }
});

// ── Enumeration bootstrap — used at initial START_COMPARISON and on retry ───

async function startEnumeration(comparison, platform) {
  const url = buildSearchUrl(platform, comparison.order.restaurantName, comparison.order.postcode);
  if (!url) { onPlatformDone(comparison, platform); return; }
  const bgTab = await browser.tabs.create({ url, active: false });
  comparison.enumTabs.set(bgTab.id, platform);
  comparison.timeouts.set(`enum|${platform}`, setTimeout(
    () => {
      // Unmap the stale tab before anything else — otherwise a late BRANCHES_FOUND
      // from it could still route via findTab() (keyed by tabId, not by any status
      // gate) after RETRY_PLATFORM has moved on, mirroring the analogous menuTabs
      // leak fixed in pump()'s timeout path.
      comparison.enumTabs.delete(bgTab.id);
      comparison.enumErrors.add(platform);
      onPlatformDone(comparison, platform);
      browser.tabs.remove(bgTab.id).catch(() => {});
    },
    ENUM_TIMEOUT_MS
  ));
}

// ── SWITCH_TO_BRANCH: open the chosen branch foreground + queue basket build ──

browser.runtime.onMessage.addListener(async (msg, sender) => {
  if (msg.type !== MSG.SWITCH_TO_BRANCH) return;
  // Every rejected click logs its reason: a switch that silently does nothing is
  // undiagnosable from a user report (#38).
  // The sidebar runs in the source tab, which keys the comparison.
  const comparison = comparisons.get(sender.tab?.id);
  if (!comparison) {
    console.info('[FeedMe switch] click ignored — no comparison for tab', sender.tab?.id);
    return;
  }
  const branch = comparison.branches.get(msg.branchKey);
  if (!branch || branch.isCurrent || !branch.switchUrl) {
    console.info('[FeedMe switch] click ignored —',
      !branch ? 'unknown branch key' : branch.isCurrent ? 'branch is the current one' : 'branch has no switch URL',
      msg.branchKey);
    return;
  }
  // Defence in depth: the URL was validated when enqueued, re-check before opening.
  if (!isAllowedMenuUrl(branch.platform, branch.switchUrl)) {
    console.info('[FeedMe switch] click ignored — URL failed origin validation', branch.switchUrl);
    return;
  }

  const tab = await browser.tabs.create({ url: branch.switchUrl, active: true }).catch(() => null);
  if (!tab) {
    console.info('[FeedMe switch] tabs.create failed for', branch.switchUrl);
    return;
  }
  // Stash the whole plan for the builder to claim once the tab has loaded. Lines
  // the matcher couldn't fully resolve (prefillable: false) are attempted too —
  // the builder fills what it can and flags them for review; dropping them here
  // made the overlay claim a complete fill over a short basket.
  const basketPlan = branch.result?.basketPlan ?? [];
  console.info('[FeedMe switch] to', branch.platform, branch.switchUrl,
    '— plan', basketPlan.filter((l) => l.prefillable).length, 'prefillable of',
    basketPlan.length, 'lines:', JSON.stringify(basketPlan));
  if (basketPlan.length) pendingBuilds.set(tab.id, { platform: branch.platform, basketPlan });
});

// ── RETRY_PLATFORM: re-run enumeration for a platform whose scan timed out ──

browser.runtime.onMessage.addListener(async (msg, sender) => {
  if (msg.type !== MSG.RETRY_PLATFORM) return;
  // The sidebar runs in the source tab, which keys the comparison.
  const comparison = comparisons.get(sender.tab?.id);
  if (!comparison) {
    console.info('[FeedMe retry] platform retry ignored — no comparison for tab', sender.tab?.id);
    return;
  }
  if (comparison.loading.has(msg.platform)) {
    console.info('[FeedMe retry] platform retry ignored — already enumerating', msg.platform);
    return;
  }
  comparison.enumErrors.delete(msg.platform);
  comparison.loading.add(msg.platform);
  pushUpdate(comparison);
  await startEnumeration(comparison, msg.platform);
});

// ── RETRY_BRANCH: re-run a single branch's menu scrape after a failure ──────

browser.runtime.onMessage.addListener((msg, sender) => {
  if (msg.type !== MSG.RETRY_BRANCH) return;
  // The sidebar runs in the source tab, which keys the comparison.
  const comparison = comparisons.get(sender.tab?.id);
  if (!comparison) {
    console.info('[FeedMe retry] branch retry ignored — no comparison for tab', sender.tab?.id);
    return;
  }
  const branch = comparison.branches.get(msg.branchKey);
  if (!branch || branch.status !== 'error' || branch.result?.error === 'bad-url') {
    console.info('[FeedMe retry] branch retry ignored —',
      !branch ? 'unknown branch key' : branch.status !== 'error' ? 'branch is not in an error state' : 'bad-url is permanent, not retryable',
      msg.branchKey);
    return;
  }
  branch.status = 'pending';
  branch.result = null;
  comparison.queued.set(msg.branchKey, { platform: branch.platform });
  comparison.scheduler.add([msg.branchKey]);
  pushUpdate(comparison);
  pump(comparison);
});

// ── Seed + snapshot helpers ──────────────────────────────────────────────────

// Build the "YOUR CART" branch from the live checkout order.
function seedCurrentBranch(comparison) {
  const { order } = comparison;
  const discountTotal = order.discounts.reduce((s, d) => s + d.amount, 0);
  const itemsKnown = order.items.some((i) => i.unitPrice > 0);
  const computedItems = order.items.reduce((s, i) => s + i.unitPrice * i.quantity, 0);
  const currentTotal = order.checkoutTotal > 0
    ? order.checkoutTotal
    : computedItems + order.deliveryFee + order.serviceFee - discountTotal;
  const itemsTotal = itemsKnown ? computedItems
    : currentTotal - order.deliveryFee - order.serviceFee + discountTotal;

  comparison.branches.set('current', {
    platform: order.platform,
    key: 'current',
    label: 'Your cart',
    distance: null,
    isCurrent: true,
    status: 'done',
    result: {
      restaurantName: order.restaurantName,
      matches: order.items.map((i) => ({ referenceItem: i, platformItem: i, matched: true })),
      offers: order.discounts.map((d) => ({ description: d.label })),
      total: {
        itemsTotal, deliveryFee: order.deliveryFee, serviceFee: order.serviceFee,
        discountTotal, total: currentTotal,
        matchedCount: order.items.length, totalCount: order.items.length,
      },
    },
  });
}

function pushUpdate(comparison, done = false) {
  const snapshot = buildSnapshot(comparison.order, [...comparison.branches.values()], comparison.loading, comparison.enumErrors);
  browser.tabs.sendMessage(comparison.sourceTabId, {
    type: MSG.COMPARISON_UPDATE, order: comparison.order, snapshot, done,
  }).catch(() => {});
}

// ── BRANCHES_FOUND: close enum tab, enqueue menu scrapes ────────────────────

browser.runtime.onMessage.addListener((msg, sender) => {
  if (msg.type !== MSG.BRANCHES_FOUND) return;
  const owner = findTab(sender.tab?.id);
  if (!owner || owner.kind !== 'enum') return;
  const { comparison, platform } = owner;

  clearTimeout(comparison.timeouts.get(`enum|${platform}`));
  comparison.enumErrors.delete(platform);
  browser.tabs.remove(sender.tab.id).catch(() => {});
  comparison.enumTabs.delete(sender.tab.id);

  // Drop the user's current branch from the source platform's scrape set so it
  // isn't shown twice: prefer the exact store id (Uber), fall back to the
  // normalised label matching the live cart's restaurant name.
  const currentLabel = normaliseLabel(comparison.order.restaurantName);
  const currentStoreId = comparison.order.sourceStoreId || '';
  const found = (msg.branches || []).filter((b) => {
    if (platform !== comparison.order.platform) return true;
    if (currentStoreId && String(b.id).includes(currentStoreId)) return false;
    return !(normaliseLabel(b.label) && normaliseLabel(b.label) === currentLabel);
  });

  if (!found.length) { onPlatformDone(comparison, platform); return; }

  const keys = [];
  for (const b of found) {
    const key = `${platform}|${b.id}`;
    // Resolve+validate the scraped menu URL once, here, so it's reused both to open
    // the menu tab for scraping (pump) and to let the user switch to this branch
    // later. An off-platform/look-alike URL yields null and disables both.
    const switchUrl = resolveMenuUrl(platform, b.menuUrl);
    comparison.branches.set(key, {
      platform, key, label: b.label, distance: b.distance, isCurrent: false,
      status: 'pending', result: null, switchUrl,
      // Just Eat only: the area listing's postcode-adjusted delivery fee, which
      // is what the basket actually charges (menu/dynamic bands are base fees).
      listedDeliveryFee: b.listedDeliveryFee ?? null,
    });
    comparison.queued.set(key, { platform });
    keys.push(key);
  }
  comparison.scheduler.add(keys);
  pushUpdate(comparison);
  pump(comparison);
});

function normaliseLabel(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// ── Pool pump — open menu tabs up to capacity ────────────────────────────────

async function pump(comparison) {
  for (const key of comparison.scheduler.take()) {
    comparison.queued.delete(key);
    // switchUrl was resolved + origin-validated when the branch was enqueued; a null
    // means the scraped link pointed off-platform and must never be opened.
    const url = comparison.branches.get(key)?.switchUrl;
    if (!url) { failBranch(comparison, key, 'bad-url'); continue; }
    const tab = await browser.tabs.create({ url, active: false }).catch(() => null);
    if (!tab) { failBranch(comparison, key, 'tab-failed'); continue; }
    comparison.menuTabs.set(tab.id, key);
    comparison.timeouts.set(key, setTimeout(() => {
      // Close and unmap the stale tab before failing the branch — otherwise a
      // late response from it, after a later RETRY_BRANCH reactivates this key
      // to 'pending', could be matched via findTab() and wrongly accepted as
      // the retry's result while the real retry's tab leaks open forever.
      comparison.menuTabs.delete(tab.id);
      browser.tabs.remove(tab.id).catch(() => {});
      failBranch(comparison, key, 'timeout');
    }, MENU_TIMEOUT_MS));
  }
}

function originFor(platform) {
  if (platform === PLATFORM.JUST_EAT) return 'https://www.just-eat.co.uk';
  if (platform === PLATFORM.DELIVEROO) return 'https://deliveroo.co.uk';
  return 'https://www.ubereats.com';
}

// Make a scraped (possibly relative) menu URL absolute and validate it against the
// platform's own origin. Returns the safe absolute URL, or null to reject it.
function resolveMenuUrl(platform, menuUrl) {
  if (!menuUrl) return null;
  const url = menuUrl.startsWith('http') ? menuUrl : originFor(platform) + menuUrl;
  return isAllowedMenuUrl(platform, url) ? url : null;
}

// ── PLATFORM_DATA: match items, compute total, push snapshot ─────────────────

browser.runtime.onMessage.addListener((msg, sender) => {
  if (msg.type !== MSG.PLATFORM_DATA) return;
  const owner = findTab(sender.tab?.id);
  if (!owner || owner.kind !== 'menu') return;
  const { comparison, branchKey } = owner;
  const branch = comparison.branches.get(branchKey);
  if (!branch || branch.status !== 'pending') return;

  clearTimeout(comparison.timeouts.get(branchKey));
  browser.tabs.remove(sender.tab.id).catch(() => {});
  comparison.menuTabs.delete(sender.tab.id);

  if (msg.error || !msg.parsed) {
    branch.status = 'error';
    branch.result = { error: msg.error || 'parse-failed' };
  } else {
    const matches = matchItems(comparison.order.items, msg.parsed.items);
    const feeOpts = {
      serviceFeePct: msg.parsed.serviceFeePct, serviceFeeMin: msg.parsed.serviceFeeMin,
      serviceFeeMax: msg.parsed.serviceFeeMax, serviceFeeEstimated: msg.parsed.serviceFeeEstimated,
      deliveryFeeBands: msg.parsed.deliveryFeeBands,
      bagFee: msg.parsed.bagFee,
      smallOrderFeeMax: msg.parsed.smallOrderFeeMax,
    };
    // The threshold is our model, not scraped (see the constant) — only Just Eat
    // publishes a small-order fee, so only its branches get one.
    if (branch.platform === PLATFORM.JUST_EAT) {
      feeOpts.smallOrderFeeThreshold = JUST_EAT_SMALL_ORDER_THRESHOLD;
    }
    let { deliveryFee, serviceFee } = msg.parsed;
    // Just Eat: the area listing's postcode-adjusted fee is what the basket
    // actually charges; menu/dynamic bands are the branch's base fee (observed
    // live: dynamic £0.59 vs listing+basket £0.79). A single-band listing fee is
    // exact — use it and drop the base bands. Multi-band listings only summarise
    // min/max, so keep the dynamic bands (still marked approx in the sidebar).
    if (branch.listedDeliveryFee && branch.listedDeliveryFee.numBands === 1) {
      deliveryFee = branch.listedDeliveryFee.min;
      feeOpts.deliveryFeeBands = null;
    }
    const offers = [...(msg.parsed.offers ?? [])];
    // Other Uber branches: the store blob publishes the branch's OWN delivery fee,
    // so prefer it and fall back to copying the cart's only when it can't be
    // trusted (#63). The service fee is a basket-dependent percentage the store page
    // never carries, so it stays estimated from the cart either way.
    if (branch.platform === PLATFORM.UBER_EATS && branchKey !== 'current') {
      const est = estimateUberFees(comparison.order);
      serviceFee = 0;
      feeOpts.serviceFeePct = est.serviceFeePct;
      feeOpts.serviceFeeEstimated = true;
      if (msg.parsed.deliveryFeeKnown) {
        deliveryFee = msg.parsed.deliveryFee;
      } else {
        deliveryFee = est.deliveryFee;
        feeOpts.deliveryFeeEstimated = true;
      }
      // An Uber One member's waived fee applies to eligible branches too, but only
      // above the subtotal the captured cart proved it at — as an offer, so
      // applyOffers decides and the sidebar can explain the £0 (#64).
      const waiver = uberOneWaiverOffer(comparison.order, msg.parsed);
      if (waiver) offers.push(waiver);
      // The monthly benefit and credits are account-level, so they follow the user
      // to whichever Uber branch they order from (#65).
      offers.push(...uberOneAccountOffers(comparison.order));
    }
    const total = computeTotal(matches, deliveryFee, serviceFee, offers, feeOpts);
    branch.status = 'done';
    // Compact instructions for the basket-builder: one entry per source line —
    // including items that matched NO menu item, carried name-only so the builder
    // attempts them and honestly lists any it can't add, instead of them silently
    // vanishing from the fill and the "Added N of N" count (#50).
    const basketPlan = matches.filter((m) => m.basketLine).map((m) => m.basketLine);
    branch.result = { restaurantName: msg.parsed.restaurantName, matches, total, offers, basketPlan };
    if (!branch.label && msg.parsed.restaurantName) branch.label = msg.parsed.restaurantName;

    // Stage-2 validity: first-token brand enumeration can admit a sibling brand
    // that shares the leading word (e.g. "Burger Eats" for "Burger King"). Such a
    // branch carries none of the cart's items, so drop it rather than show a
    // misleading 0-matched card.
    if (total.matchedCount === 0) {
      comparison.branches.delete(branchKey);
    }
  }

  comparison.scheduler.release();
  afterBranchSettled(comparison);
});

function failBranch(comparison, key, error) {
  const branch = comparison.branches.get(key);
  if (!branch || branch.status !== 'pending') return;
  branch.status = 'error';
  branch.result = { error };
  comparison.scheduler.release();
  afterBranchSettled(comparison);
}

function afterBranchSettled(comparison) {
  // A platform is no longer loading once it has enumerated and none of its
  // branches are still pending.
  for (const platform of ALL_PLATFORMS) maybeClearLoading(comparison, platform);
  pump(comparison);
  const allSettled = [...comparison.branches.values()].every((b) => b.status !== 'pending');
  const drained = comparison.scheduler.pending === 0 && comparison.queued.size === 0;
  pushUpdate(comparison, allSettled && drained && comparison.loading.size === 0);
}

function onPlatformDone(comparison, platform) {
  // Enumeration produced nothing schedulable for this platform.
  comparison.loading.delete(platform);
  afterBranchSettled(comparison);
}

function maybeClearLoading(comparison, platform) {
  if (!comparison.loading.has(platform)) return;
  const stillEnumerating = [...comparison.enumTabs.values()].includes(platform);
  const pendingBranches = [...comparison.branches.values()]
    .some((b) => b.platform === platform && b.status === 'pending');
  const queuedBranches = [...comparison.queued.keys()].some((k) => k.startsWith(`${platform}|`));
  if (!stillEnumerating && !pendingBranches && !queuedBranches) comparison.loading.delete(platform);
}
