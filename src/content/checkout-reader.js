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
          // Quantity (the stepper value) is rendered in the row wrapper OUTSIDE the
          // cart-item content. Reading it from the item's own text was unreliable: it
          // matched digits in product names (e.g. "3x Chocolate Chunk Cookies" → 3)
          // and missed deal lines that show no "N ×" prefix (e.g. a Buy-1-get-1 line,
          // which still steps to 2). Find the standalone integer in the enclosing
          // <li> that isn't inside the item content.
          const row = el.closest('li');
          const qtyEl = row && [...row.querySelectorAll('div, span')].find(
            (n) => !el.contains(n) && /^\d+$/.test(n.textContent.trim())
          );
          const quantity = qtyEl ? parseInt(qtyEl.textContent.trim(), 10) : 1;
          // Selections render as [group label ending ":"] then [option value] span
          // pairs (or, on some cart rows, group + value packed into a single span
          // as "Group: Value (£price)"); paid values carry "(£price)", free ones
          // don't; a bare-price span is the line total. Capture every option (free
          // included) with its group so cross-platform fill can satisfy the
          // target's required groups.
          const options = [];
          let currentGroup = '';
          for (const s of el.querySelectorAll('span')) {
            const text = s.textContent.trim();
            if (!text || /^£\d+(\.\d+)?$/.test(text)) continue; // skip blanks + line total
            if (text.endsWith(':')) { currentGroup = text.slice(0, -1).trim(); continue; }
            const labelled = text.match(/^([^():]+):\s*(.+)$/);
            const group = labelled ? labelled[1].trim() : currentGroup;
            const rest = labelled ? labelled[2] : text;
            const priced = rest.match(/^(.*)\(£(\d+(?:\.\d+)?)\)$/);
            const name = (priced ? priced[1] : rest).trim();
            const price = priced ? parseFloat(priced[2]) : 0;
            if (name) options.push({ group, name, price });
          }
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
  // The store UUID (last path segment of the store link) identifies this exact
  // branch, so the enumerator can drop it from the Uber column (avoids showing the
  // cart's own store twice).
  const sourceStoreId = (restLink?.getAttribute('href') ?? '').split('?')[0].split('/').filter(Boolean).pop() ?? '';

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
    sourceStoreId,
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
