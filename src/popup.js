const { MSG, browser } = require('./shared/constants');
const { PLATFORM_ORIGINS, missingOrigins, originLabel } = require('./shared/permissions');

// Firefox lets host access be revoked at any time (#77). The popup is the only
// surface that can ask for it back: permissions.request() needs a user gesture
// and is not exposed to content scripts, so neither the sidebar nor the service
// worker can do this — hence the button lives here and the sidebar only points
// at it.
async function showRevokedAccess() {
  const platforms = Object.keys(PLATFORM_ORIGINS);
  const missing = (await Promise.all(platforms.map((p) => missingOrigins(p)))).flat();
  const origins = [...new Set(missing)];
  if (!origins.length) return;

  const box = document.getElementById('state-blocked');
  box.classList.remove('hidden');
  document.getElementById('blocked-origins').textContent = origins.map(originLabel).join(', ');

  document.getElementById('grant-btn').addEventListener('click', async () => {
    // Must be called directly in the click handler: awaiting anything first
    // spends the user gesture and Firefox rejects the request.
    const granted = await browser.permissions.request({ origins }).catch(() => false);
    if (granted) window.close();
  });
}

async function init() {
  await showRevokedAccess();
  const stored = await browser.storage.session.get('currentOrder');
  const order = stored.currentOrder;

  if (order && order.items.length > 0) {
    document.getElementById('state-idle').classList.add('hidden');
    document.getElementById('state-ready').classList.remove('hidden');

    // Use textContent to safely insert restaurant name from external data
    document.getElementById('restaurant-name').textContent = order.restaurantName;
    document.getElementById('item-count').textContent =
      `${order.items.length} item${order.items.length !== 1 ? 's' : ''} · ${order.postcode}`;

    document.getElementById('compare-btn').addEventListener('click', async () => {
      const tabs = await browser.tabs.query({ active: true, currentWindow: true });
      if (!tabs || tabs.length === 0) return;
      await browser.runtime.sendMessage({ type: MSG.START_COMPARISON, tabId: tabs[0].id });
      window.close();
    });
  }
}

init();
