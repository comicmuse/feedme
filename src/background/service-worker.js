const { PLATFORM, CHECKOUT_PATTERNS, MSG, SCRAPER_TIMEOUT_MS, buildSearchUrl, browser } = require('../shared/constants');
const { matchItems, computeTotal } = require('../shared/matcher');

// Keyed by source tabId — tracks in-flight comparisons
const comparisons = new Map();

// Deliveroo and Just Eat are DOM-driven scrapers that navigate across several
// full page loads, re-injected on each. They map to their own bundled scripts;
// other platforms use the generic fetch/XHR interceptor in the page's MAIN world.
const MULTISTEP_SCRAPERS = {
  [PLATFORM.DELIVEROO]: 'dist/deliveroo-scraper.js',
  [PLATFORM.JUST_EAT]: 'dist/just-eat-scraper.js',
};

// These multi-load flows get a longer budget than the single-page scrapers.
const MULTISTEP_TIMEOUT_MS = 30000;

// Find the comparison + platform a background tab belongs to.
function findTabOwner(tabId) {
  for (const comparison of comparisons.values()) {
    const platform = Object.keys(comparison.tabs).find((p) => comparison.tabs[p] === tabId);
    if (platform) return { comparison, platform };
  }
  return null;
}

// Inject the right scraper for a freshly-loaded background tab. Deliveroo is a
// multi-step DOM-driven flow re-run on every navigation (deduped per URL); the
// others patch fetch/XHR in the page's MAIN world once.
async function injectScraper(tabId, platform, comparison) {
  let url = '';
  try {
    url = (await browser.tabs.get(tabId)).url ?? '';
  } catch (_) {
    return;
  }

  const key = `${platform}|${url}`;
  if (comparison.injectedUrls.has(key)) return;
  comparison.injectedUrls.add(key);

  const multistepFile = MULTISTEP_SCRAPERS[platform];
  if (multistepFile) {
    await browser.scripting
      .executeScript({
        target: { tabId },
        func: (ctx) => {
          window.__feedmeCompare = ctx;
        },
        args: [{ restaurantName: comparison.order.restaurantName, postcode: comparison.order.postcode }],
      })
      .catch(() => {});
    await browser.scripting
      .executeScript({ target: { tabId }, files: [multistepFile] })
      .catch(() => {});
    return;
  }

  await browser.scripting
    .executeScript({ target: { tabId }, files: ['dist/platform-scraper.js'], world: 'MAIN' })
    .catch(() => {});
}

// Re-inject on both full loads and SPA navigations for any background tab we own.
browser.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status !== 'complete') return;
  const owner = findTabOwner(tabId);
  if (owner) injectScraper(tabId, owner.platform, owner.comparison);
});
browser.webNavigation.onHistoryStateUpdated.addListener((details) => {
  const owner = findTabOwner(details.tabId);
  if (owner) injectScraper(details.tabId, owner.platform, owner.comparison);
});

// Re-inject checkout-reader on SPA navigation (pushState) to checkout URLs
browser.webNavigation.onHistoryStateUpdated.addListener((details) => {
  const platform = Object.entries(CHECKOUT_PATTERNS).find(([, re]) => re.test(details.url))?.[0];
  if (!platform) return;
  browser.scripting.executeScript({
    target: { tabId: details.tabId },
    files: ['dist/checkout-reader.js'],
  }).catch(() => {});
});

// Store order and set badge when checkout-reader detects an order
browser.runtime.onMessage.addListener((msg, sender) => {
  if (msg.type !== MSG.ORDER_DETECTED) return;
  browser.storage.session.set({ currentOrder: msg.order });
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

  const comparison = { sourceTabId: tabId, order, results: {}, tabs: {}, timeouts: {}, injectedUrls: new Set() };
  comparisons.set(tabId, comparison);

  for (const platform of comparisonPlatforms) {
    const url = buildSearchUrl(platform, order.restaurantName, order.postcode);
    if (!url) {
      finalisePlatform(tabId, platform, { error: 'no-search-url' });
      continue;
    }

    const bgTab = await browser.tabs.create({ url, active: false });
    comparison.tabs[platform] = bgTab.id;

    const timeout = MULTISTEP_SCRAPERS[platform] ? MULTISTEP_TIMEOUT_MS : SCRAPER_TIMEOUT_MS;
    comparison.timeouts[platform] = setTimeout(
      () => finalisePlatform(tabId, platform, { error: 'timeout' }),
      timeout
    );
    // The global onUpdated / onHistoryStateUpdated listeners inject the scraper
    // once this tab finishes loading (and again on each navigation it makes).
  }
});

// Receive data from platform-scraper in background tabs
browser.runtime.onMessage.addListener((msg, sender) => {
  if (msg.type !== MSG.PLATFORM_DATA) return;

  for (const [sourceTabId, comparison] of comparisons) {
    if (comparison.tabs[msg.platform] !== sender.tab?.id) continue;

    clearTimeout(comparison.timeouts[msg.platform]);
    browser.tabs.remove(sender.tab.id).catch(() => {});

    // A scraper can report it couldn't confidently find the restaurant.
    if (msg.error) {
      finalisePlatform(sourceTabId, msg.platform, { error: msg.error });
      break;
    }

    const matches = matchItems(comparison.order.items, msg.parsed.items);
    const total = computeTotal(
      matches,
      msg.parsed.deliveryFee,
      msg.parsed.serviceFee,
      msg.parsed.offers ?? [],
      {
        serviceFeePct: msg.parsed.serviceFeePct,
        serviceFeeMin: msg.parsed.serviceFeeMin,
        serviceFeeMax: msg.parsed.serviceFeeMax,
        serviceFeeEstimated: msg.parsed.serviceFeeEstimated,
      }
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
