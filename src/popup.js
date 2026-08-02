const { MSG, browser } = require('./shared/constants');
const { missingOrigins, originLabel } = require('./shared/permissions');

function show(id) {
  for (const s of ['state-idle', 'state-ready', 'state-permission']) {
    document.getElementById(s).classList.toggle('hidden', s !== id);
  }
}

async function activeTabId() {
  const tabs = await browser.tabs.query({ active: true, currentWindow: true });
  return tabs && tabs.length ? tabs[0].id : null;
}

// The revoked-access state. Rendered instead of the idle state because without
// host access the checkout is never read, so there is no order to offer and
// "go to a checkout page" would send the user round a loop that cannot succeed.
function renderPermissionState(missing) {
  const list = document.getElementById('missing-origins');
  for (const origin of missing) {
    const li = document.createElement('li');
    li.textContent = originLabel(origin);
    list.appendChild(li);
  }
  show('state-permission');

  document.getElementById('grant-btn').addEventListener('click', async () => {
    // permissions.request() must be called from a user gesture. Nothing may be
    // awaited before it — an await here consumes the gesture and Firefox rejects
    // the request. This is why the permission check runs at popup load rather
    // than inside this handler.
    let granted = false;
    try {
      granted = await browser.permissions.request({ origins: missing });
    } catch (_) {
      granted = false;
    }
    if (!granted) {
      document.getElementById('grant-note').textContent =
        'Access was not granted, so prices can’t be compared.';
      return;
    }
    // Content scripts do not inject retroactively: the checkout page was loaded
    // while access was denied, so checkout-reader never ran there. Reloading is
    // what actually makes the order readable.
    const tabId = await activeTabId();
    if (tabId != null) await browser.tabs.reload(tabId);
    window.close();
  });
}

function renderReadyState(order) {
  document.getElementById('restaurant-name').textContent = order.restaurantName;
  document.getElementById('item-count').textContent =
    `${order.items.length} item${order.items.length !== 1 ? 's' : ''} · ${order.postcode}`;
  show('state-ready');

  document.getElementById('compare-btn').addEventListener('click', async () => {
    const tabId = await activeTabId();
    if (tabId == null) return;
    await browser.runtime.sendMessage({ type: MSG.START_COMPARISON, tabId });
    window.close();
  });
}

async function init() {
  // Both are needed before deciding what to render, and neither depends on the
  // other, so they run together.
  const [stored, missing] = await Promise.all([
    browser.storage.session.get('currentOrder'),
    missingOrigins(browser),
  ]);
  const order = stored.currentOrder;

  // Missing access wins over everything: it explains an absent order, and it
  // would break a comparison even when an order was captured before the
  // revocation.
  if (missing.length > 0) return renderPermissionState(missing);
  if (order && order.items.length > 0) return renderReadyState(order);
  show('state-idle');
}

init();
