const { MSG, browser } = require('./shared/constants');

async function init() {
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
