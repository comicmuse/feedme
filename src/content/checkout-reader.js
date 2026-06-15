const { PLATFORM, MSG, platformFromUrl } = require('../shared/constants');

function parsePrice(text) {
  // If multiple prices exist (e.g. "£0.99  £0.00" with a strikethrough), take the last one
  const matches = [...(text ?? '').matchAll(/£?([\d.]+)/g)].map(m => parseFloat(m[1]));
  return matches[matches.length - 1] ?? 0;
}

function waitForElement(doc, selector, timeout = 10000) {
  return new Promise((resolve) => {
    const existing = doc.querySelector(selector);
    if (existing) { resolve(existing); return; }
    const timer = setTimeout(() => { mo.disconnect(); resolve(null); }, timeout);
    const mo = new MutationObserver(() => {
      const found = doc.querySelector(selector);
      if (found) { clearTimeout(timer); mo.disconnect(); resolve(found); }
    });
    mo.observe(doc.body, { childList: true, subtree: true });
  });
}

async function extractUberEats(doc) {
  // Wait for React to render the checkout UI (SPA loads a spinner first)
  const panel = await waitForElement(doc, '[data-testid="cart-summary-panel"]');
  if (!panel) return { platform: PLATFORM.UBER_EATS, restaurantName: '', postcode: '', items: [], deliveryFee: 0, serviceFee: 0, discounts: [], checkoutTotal: 0 };

  // Cart items are lazy-loaded inside the panel — expand it if needed
  if (!doc.querySelector('[data-testid="cart-items-list"]')) {
    const toggle = doc.querySelector('[data-testid="cart_summary_toggle"]');
    if (toggle) {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 3000);
        const mo = new MutationObserver(() => {
          if (doc.querySelector('[data-testid="cart-items-list"]')) {
            clearTimeout(timer);
            mo.disconnect();
            resolve();
          }
        });
        mo.observe(doc.body, { childList: true, subtree: true });
        toggle.click();
      });
    }
  }

  // Fee breakdown may load in a second async phase — wait for it before reading prices
  await waitForElement(doc, '[data-testid="fare-breakdown-charge-badge-total"]', 5000);

  const itemsList = doc.querySelector('[data-testid="cart-items-list"]');
  const items = itemsList
    ? [...itemsList.querySelectorAll('[data-testid^="cart-item-"]')]
        .map((el) => {
          const name = el.querySelector('img')?.alt?.trim() ?? '';
          // Line total is a bare price span (e.g. "£27.39"); modifier prices are
          // inside parentheses (e.g. "Medium 11.5\" (£13.00)") so we match only
          // spans whose entire text is a price. Take the last (handles strikethrough).
          const priceSpans = [...el.querySelectorAll('span')].filter((s) =>
            /^£\d+(\.\d+)?$/.test(s.textContent.trim())
          );
          const lineTotal = priceSpans.length
            ? parsePrice(priceSpans[priceSpans.length - 1].textContent)
            : 0;
          // Quantity is only rendered as a leading "N ×"/"Nx" prefix when > 1.
          const qtyMatch = el.textContent.match(/^\s*(\d+)\s*[×x]\s/);
          const quantity = qtyMatch ? parseInt(qtyMatch[1], 10) : 1;
          // Paid options/modifiers render as "{name} (£{price})" (a group label
          // like "Add:" may prefix it). Capturing name + price lets comparison
          // platforms be priced using their OWN cost for the same option, falling
          // back to this price only when a platform doesn't list it.
          const options = [...el.querySelectorAll('span')]
            .map((s) => s.textContent.trim().match(/^(?:[^():]*:\s*)?(.+?)\s*\(£(\d+(?:\.\d+)?)\)$/))
            .filter(Boolean)
            .map((m) => ({ name: m[1].trim(), price: parseFloat(m[2]) }))
            .filter((o) => o.name && o.price > 0);
          const optionsTotal = options.reduce((sum, o) => sum + o.price, 0);
          return {
            name,
            quantity,
            unitPrice: quantity > 0 ? lineTotal / quantity : lineTotal,
            options,
            optionsTotal,
          };
        })
        .filter((i) => i.name)
    : [];

  const addressText =
    doc.querySelector('[data-testid="checkout-delivery-address-section"]')?.textContent ?? '';
  const postcodeMatch = addressText.match(/[A-Z]{1,2}\d{1,2}[A-Z]?\s?\d[A-Z]{2}/);

  // The checkout page title is just "Checkout | Uber Eats", so derive the
  // restaurant name from the store link (the one that isn't "Back to store").
  const storeLinks = [...doc.querySelectorAll('a[href*="/store/"]')];
  const restLink =
    storeLinks.find((a) => !/back to store/i.test(a.textContent)) ?? storeLinks[0];
  // The name is the first leaf element with text; the address follows in a
  // sibling <p>, so we can't just read the link's whole textContent.
  const nameLeaf = restLink
    ? [...restLink.querySelectorAll('*')].find(
        (e) => e.children.length === 0 && e.textContent.trim()
      )
    : null;
  const restaurantName = nameLeaf?.textContent.trim() ?? restLink?.textContent.trim() ?? '';

  const feeEl = (testid) =>
    doc.querySelector(`[data-testid="${testid}"]`);

  const membershipEl = feeEl('fare-breakdown-charge-badge-membership-benefit');
  const membershipText = membershipEl?.textContent?.trim() ?? '';
  const membershipAmount = membershipText
    ? Math.abs(parsePrice(membershipText))
    : 0;

  return {
    platform: PLATFORM.UBER_EATS,
    restaurantName,
    postcode: postcodeMatch?.[0]?.replace(/\s+/, ' ') ?? '',
    items,
    deliveryFee: parsePrice(feeEl('fare-breakdown-charge-badge-delivery-fee')?.textContent),
    serviceFee: parsePrice(feeEl('fare-breakdown-charge-badge-fees')?.textContent),
    discounts: membershipAmount > 0
      ? [{ amount: membershipAmount, label: membershipText }]
      : [],
    // Actual total from the checkout page (avoids needing per-item prices)
    checkoutTotal: parsePrice(feeEl('fare-breakdown-charge-badge-total')?.textContent),
  };
}

function extractDeliveroo(doc) {
  const items = [...doc.querySelectorAll('.basket-item')].map((el) => ({
    name: el.querySelector('.item-name')?.textContent?.trim() ?? '',
    quantity: parseInt(el.querySelector('.item-count')?.textContent ?? '1', 10),
    unitPrice: parsePrice(el.querySelector('.item-price')?.textContent),
  }));
  return {
    platform: PLATFORM.DELIVEROO,
    restaurantName: doc.querySelector('.restaurant-title')?.textContent?.trim() ?? '',
    postcode: doc.querySelector('.delivery-postcode')?.textContent?.trim() ?? '',
    items,
    deliveryFee: parsePrice(doc.querySelector('.fee-delivery')?.textContent),
    serviceFee: parsePrice(doc.querySelector('.fee-service')?.textContent),
    discounts: [],
  };
}

function extractJustEat(doc) {
  const items = [...doc.querySelectorAll('.order-item')].map((el) => ({
    name: el.querySelector('.name')?.textContent?.trim() ?? '',
    quantity: parseInt(el.querySelector('.quantity')?.textContent ?? '1', 10),
    unitPrice: parsePrice(el.querySelector('.price')?.textContent),
  }));
  return {
    platform: PLATFORM.JUST_EAT,
    restaurantName: doc.querySelector('.restaurant-name')?.textContent?.trim() ?? '',
    postcode: doc.querySelector('.postcode')?.textContent?.trim() ?? '',
    items,
    deliveryFee: parsePrice(doc.querySelector('.delivery-fee')?.textContent),
    serviceFee: parsePrice(doc.querySelector('.service-fee')?.textContent),
    discounts: [],
  };
}

async function extractOrder(platform, doc) {
  if (platform === PLATFORM.UBER_EATS) return extractUberEats(doc);
  if (platform === PLATFORM.DELIVEROO) return extractDeliveroo(doc);
  if (platform === PLATFORM.JUST_EAT) return extractJustEat(doc);
  throw new Error(`Unsupported platform: ${platform}`);
}

// Browser entry point
if (typeof window !== 'undefined' && typeof chrome !== 'undefined') {
  (async () => {
    const platform = platformFromUrl(window.location.href);
    if (platform) {
      const order = await extractOrder(platform, document);
      if (order.items.length > 0) {
        chrome.runtime.sendMessage({ type: MSG.ORDER_DETECTED, order });
      }
    }
  })();
}

module.exports = { extractOrder };
