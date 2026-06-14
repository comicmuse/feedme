const { PLATFORM, MSG, platformFromUrl } = require('../shared/constants');

function parsePrice(text) {
  return parseFloat((text ?? '').replace(/[^0-9.]/g, '')) || 0;
}

function extractUberEats(doc) {
  const items = [...doc.querySelectorAll('[data-testid="cart-item"]')].map((el) => ({
    name: el.querySelector('[data-testid="item-name"]')?.textContent?.trim() ?? '',
    quantity: parseInt(el.querySelector('[data-testid="item-quantity"]')?.textContent ?? '1', 10),
    unitPrice: parsePrice(el.querySelector('[data-testid="item-price"]')?.textContent),
  }));
  const promoEl = doc.querySelector('[data-testid="promo-discount"]');
  return {
    platform: PLATFORM.UBER_EATS,
    restaurantName: doc.querySelector('[data-testid="restaurant-name"]')?.textContent?.trim() ?? '',
    postcode: doc.querySelector('[data-testid="delivery-postcode"]')?.textContent?.trim() ?? '',
    items,
    deliveryFee: parsePrice(doc.querySelector('[data-testid="delivery-fee"]')?.textContent),
    serviceFee: parsePrice(doc.querySelector('[data-testid="service-fee"]')?.textContent),
    discounts: promoEl
      ? [{ amount: parseFloat(promoEl.dataset.amount ?? '0'), label: promoEl.textContent?.trim() ?? '' }]
      : [],
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

function extractOrder(platform, doc) {
  if (platform === PLATFORM.UBER_EATS) return extractUberEats(doc);
  if (platform === PLATFORM.DELIVEROO) return extractDeliveroo(doc);
  if (platform === PLATFORM.JUST_EAT) return extractJustEat(doc);
  throw new Error(`Unsupported platform: ${platform}`);
}

// Browser entry point — not reached during Jest tests
// Note: action.* and storage.session are background-only; content script only sends a message
if (typeof window !== 'undefined' && typeof chrome !== 'undefined') {
  const platform = platformFromUrl(window.location.href);
  if (platform) {
    const order = extractOrder(platform, document);
    if (order.items.length > 0) {
      chrome.runtime.sendMessage({ type: MSG.ORDER_DETECTED, order });
    }
  }
}

module.exports = { extractOrder };
