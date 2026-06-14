const { PLATFORM } = require('./constants');

function classifyResponse(platform, data) {
  if (!data || typeof data !== 'object') return null;
  try {
    if (platform === PLATFORM.UBER_EATS && data?.data?.catalogSectionsMap?.items?.length > 0) return 'menu';
    if (platform === PLATFORM.DELIVEROO && data?.restaurant?.menu?.categories?.length > 0) return 'menu';
    if (platform === PLATFORM.JUST_EAT && Array.isArray(data?.menuItems) && data.menuItems.length > 0) return 'menu';
  } catch (_) {}
  return null;
}

function parseMenuResponse(platform, data) {
  if (platform === PLATFORM.UBER_EATS) return parseUberEats(data);
  if (platform === PLATFORM.DELIVEROO) return parseDeliveroo(data);
  if (platform === PLATFORM.JUST_EAT) return parseJustEat(data);
  throw new Error(`Unknown platform: ${platform}`);
}

function parseUberEats(data) {
  const store = data.data.storeInfo;
  return {
    restaurantName: store.title,
    postcode: store.location?.address?.postalCode ?? '',
    items: data.data.catalogSectionsMap.items.map((i) => ({
      name: i.title,
      description: i.itemDescription ?? '',
      unitPrice: (i.price ?? 0) / 100,
    })),
    deliveryFee: (store.deliveryFee?.price ?? 0) / 100,
    serviceFee: 0,
    serviceFeePct: store.serviceFeePct ?? 0,
    offers: [],
  };
}

function parseDeliveroo(data) {
  const r = data.restaurant;
  const items = r.menu.categories.flatMap((cat) =>
    cat.items.map((i) => ({ name: i.name, description: i.description ?? '', unitPrice: (i.price ?? 0) / 100 }))
  );
  return {
    restaurantName: r.name,
    postcode: r.postcode ?? '',
    items,
    deliveryFee: (r.deliveryFee ?? 0) / 100,
    serviceFee: (r.serviceFee ?? 0) / 100,
    serviceFeePct: 0,
    offers: (r.offers ?? []).map((o) => ({ description: o.description ?? '', amount: 0 })),
  };
}

function parseJustEat(data) {
  return {
    restaurantName: data.name,
    postcode: data.address?.postCode ?? '',
    items: data.menuItems.map((i) => ({ name: i.name, description: i.description ?? '', unitPrice: (i.price ?? 0) / 100 })),
    deliveryFee: (data.deliveryFee ?? 0) / 100,
    serviceFee: 0,
    serviceFeePct: data.serviceFeePercent ?? 0,
    offers: (data.promotions ?? []).map((p) => ({ description: p.description ?? '', amount: 0 })),
  };
}

module.exports = { classifyResponse, parseMenuResponse };
