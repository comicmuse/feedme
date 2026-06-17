const { PLATFORM, CHECKOUT_PATTERNS, MSG, buildSearchUrl, getConfig, browser } = require('../shared/constants');
const { matchItems, computeTotal } = require('../shared/matcher');
const { buildSnapshot } = require('../shared/snapshot');
const { createScheduler } = require('../shared/pool');

// Keyed by source tabId.
const comparisons = new Map();

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
  [PLATFORM.UBER_EATS]: { file: 'dist/platform-scraper.js', world: 'MAIN' },
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

async function injectInto(tabId, file, world, ctx) {
  await browser.scripting.executeScript({
    target: { tabId },
    func: (c) => { window.__feedmeCompare = c; },
    args: [ctx],
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
  };
  comparisons.set(tabId, comparison);

  // Seed the current branch from the live order (authoritative, not scraped).
  seedCurrentBranch(comparison);
  pushUpdate(comparison);

  for (const platform of ALL_PLATFORMS) {
    const url = buildSearchUrl(platform, order.restaurantName, order.postcode);
    if (!url) { onPlatformDone(comparison, platform); continue; }
    const bgTab = await browser.tabs.create({ url, active: false });
    comparison.enumTabs.set(bgTab.id, platform);
    comparison.timeouts.set(`enum|${platform}`, setTimeout(
      () => { onPlatformDone(comparison, platform); browser.tabs.remove(bgTab.id).catch(() => {}); },
      ENUM_TIMEOUT_MS
    ));
  }
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
  const snapshot = buildSnapshot(comparison.order, [...comparison.branches.values()], comparison.loading);
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
  browser.tabs.remove(sender.tab.id).catch(() => {});
  comparison.enumTabs.delete(sender.tab.id);

  // Drop the user's current branch from the source platform's scrape set so it
  // isn't shown twice (dedupe by normalised label against the live cart).
  const currentLabel = normaliseLabel(comparison.order.restaurantName);
  const found = (msg.branches || []).filter((b) =>
    !(platform === comparison.order.platform && normaliseLabel(b.label) && normaliseLabel(b.label) === currentLabel));

  if (!found.length) { onPlatformDone(comparison, platform); return; }

  const keys = [];
  for (const b of found) {
    const key = `${platform}|${b.id}`;
    comparison.branches.set(key, { platform, key, label: b.label, distance: b.distance, isCurrent: false, status: 'pending', result: null });
    comparison.queued.set(key, { platform, menuUrl: b.menuUrl });
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
    const { platform, menuUrl } = comparison.queued.get(key);
    comparison.queued.delete(key);
    const url = menuUrl.startsWith('http') ? menuUrl : originFor(platform) + menuUrl;
    const tab = await browser.tabs.create({ url, active: false }).catch(() => null);
    if (!tab) { failBranch(comparison, key, 'tab-failed'); continue; }
    comparison.menuTabs.set(tab.id, key);
    comparison.timeouts.set(key, setTimeout(() => failBranch(comparison, key, 'timeout'), MENU_TIMEOUT_MS));
  }
}

function originFor(platform) {
  if (platform === PLATFORM.JUST_EAT) return 'https://www.just-eat.co.uk';
  if (platform === PLATFORM.DELIVEROO) return 'https://deliveroo.co.uk';
  return 'https://www.ubereats.com';
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
    const total = computeTotal(matches, msg.parsed.deliveryFee, msg.parsed.serviceFee, msg.parsed.offers ?? [], {
      serviceFeePct: msg.parsed.serviceFeePct, serviceFeeMin: msg.parsed.serviceFeeMin,
      serviceFeeMax: msg.parsed.serviceFeeMax, serviceFeeEstimated: msg.parsed.serviceFeeEstimated,
    });
    branch.status = 'done';
    branch.result = { restaurantName: msg.parsed.restaurantName, matches, total, offers: msg.parsed.offers ?? [] };
    if (!branch.label && msg.parsed.restaurantName) branch.label = msg.parsed.restaurantName;
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
