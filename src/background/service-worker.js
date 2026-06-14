const { PLATFORM, MSG, SCRAPER_TIMEOUT_MS, buildSearchUrl, browser } = require('../shared/constants');
const { matchItems, computeTotal } = require('../shared/matcher');

// Keyed by source tabId — tracks in-flight comparisons
const comparisons = new Map();

// Set badge when checkout-reader detects an order
browser.runtime.onMessage.addListener((msg, sender) => {
  if (msg.type !== MSG.ORDER_DETECTED) return;
  browser.action.setBadgeText({ text: '✓', tabId: sender.tab?.id });
  browser.action.setBadgeBackgroundColor({ color: '#22c55e', tabId: sender.tab?.id });
});

// Start comparison when popup sends START_COMPARISON
browser.runtime.onMessage.addListener(async (msg) => {
  if (msg.type !== MSG.START_COMPARISON) return;

  const stored = await browser.storage.session.get('currentOrder');
  const order = stored.currentOrder;
  if (!order || order.items.length === 0) return;

  const tabId = msg.tabId;

  await browser.scripting.executeScript({ target: { tabId }, files: ['dist/sidebar.js'] });

  const allPlatforms = [PLATFORM.UBER_EATS, PLATFORM.DELIVEROO, PLATFORM.JUST_EAT];
  const comparisonPlatforms = allPlatforms.filter((p) => p !== order.platform);

  const comparison = { sourceTabId: tabId, order, results: {}, tabs: {}, timeouts: {} };
  comparisons.set(tabId, comparison);

  for (const platform of comparisonPlatforms) {
    const url = buildSearchUrl(platform, order.restaurantName, order.postcode);
    if (!url) {
      finalisePlatform(tabId, platform, { error: 'no-search-url' });
      continue;
    }

    const bgTab = await browser.tabs.create({ url, active: false });
    comparison.tabs[platform] = bgTab.id;

    comparison.timeouts[platform] = setTimeout(
      () => finalisePlatform(tabId, platform, { error: 'timeout' }),
      SCRAPER_TIMEOUT_MS
    );

    browser.tabs.onUpdated.addListener(async function listener(updatedTabId, info) {
      if (updatedTabId !== bgTab.id || info.status !== 'complete') return;
      browser.tabs.onUpdated.removeListener(listener);
      await browser.scripting.executeScript({
        target: { tabId: bgTab.id },
        files: ['dist/platform-scraper.js'],
        world: 'MAIN',
      });
    });
  }
});

// Receive data from platform-scraper in background tabs
browser.runtime.onMessage.addListener((msg, sender) => {
  if (msg.type !== MSG.PLATFORM_DATA) return;

  for (const [sourceTabId, comparison] of comparisons) {
    if (comparison.tabs[msg.platform] !== sender.tab?.id) continue;

    clearTimeout(comparison.timeouts[msg.platform]);
    browser.tabs.remove(sender.tab.id).catch(() => {});

    const matches = matchItems(comparison.order.items, msg.parsed.items);
    const total = computeTotal(
      matches,
      msg.parsed.deliveryFee,
      msg.parsed.serviceFee,
      msg.parsed.offers ?? []
    );

    finalisePlatform(sourceTabId, msg.platform, {
      restaurantName: msg.parsed.restaurantName,
      matches,
      total,
      offers: msg.parsed.offers ?? [],
    });
    break;
  }
});

function finalisePlatform(sourceTabId, platform, result) {
  const comparison = comparisons.get(sourceTabId);
  if (!comparison) return;

  comparison.results[platform] = result;

  const done = Object.keys(comparison.tabs).every((p) => comparison.results[p] !== undefined);
  if (!done) return;

  browser.tabs.sendMessage(sourceTabId, {
    type: MSG.COMPARISON_RESULT,
    order: comparison.order,
    results: comparison.results,
  }).catch(() => {});
  comparisons.delete(sourceTabId);
}
