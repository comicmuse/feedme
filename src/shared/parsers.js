const { PLATFORM, DELIVEROO_SERVICE_FEE_PCT, DELIVEROO_SERVICE_FEE_CAP } = require('./constants');

function classifyResponse(platform, data) {
  if (!data || typeof data !== 'object') return null;
  try {
    if (platform === PLATFORM.UBER_EATS && data?.data?.catalogSectionsMap?.items?.length > 0) return 'menu';
    // Deliveroo menus are server-rendered into the page's __NEXT_DATA__ blob,
    // not returned by a fetch/XHR, so we classify on that embedded shape.
    if (
      platform === PLATFORM.DELIVEROO &&
      deliverooRoot(data) &&
      Object.keys(deliverooRoot(data).items ?? {}).length > 0
    ) {
      return 'menu';
    }
    // Just Eat menus are server-rendered into __NEXT_DATA__ (preloadedState),
    // reached via the area listing → restaurant menu flow.
    if (
      platform === PLATFORM.JUST_EAT &&
      justEatCdn(data) &&
      Object.keys(justEatCdn(data).items ?? {}).length > 0
    ) {
      return 'menu';
    }
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

// Uber store pages (other branches of the chain) server-render their catalogue
// into the page's catalog blob, but it's not fetched via an interceptable XHR and
// is custom-escaped. The Schema.org Restaurant JSON-LD on the same page carries a
// clean menu (hasMenu.hasMenuSection[].hasMenuItem[] with offer prices), which is
// enough for a cross-branch price comparison. No modifiers or fees are available
// here, so fees default to 0 (mirroring the SSR-only Just Eat path).
function asArray(v) {
  return Array.isArray(v) ? v : v ? [v] : [];
}

function parseUberStore(ld) {
  const sections = asArray(ld?.hasMenu?.hasMenuSection ?? ld?.hasMenu);
  const items = [];
  for (const section of sections) {
    for (const it of asArray(section?.hasMenuItem)) {
      const offer = asArray(it?.offers)[0] ?? it?.offers;
      items.push({
        name: it?.name ?? '',
        description: it?.description ?? '',
        unitPrice: parseFloat(offer?.price ?? 0) || 0,
      });
    }
  }
  return {
    restaurantName: ld?.name ?? '',
    postcode: ld?.address?.postalCode ?? '',
    items,
    deliveryFee: 0,
    serviceFee: 0,
    serviceFeePct: 0,
    offers: [],
  };
}

// The menu root inside Deliveroo's __NEXT_DATA__ blob.
function deliverooRoot(data) {
  return data?.props?.initialState?.menuPage?.menu?.metas?.root ?? null;
}

// Standard delivery fee from the menu header. The header rows use flattened
// dotted strings as literal keys (e.g. data['delivery-fee.content']), and
// props['free-delivery-visible'] flags an active free-delivery offer.
// The service fee is a basket-dependent percentage not present on the menu page.
function deliverooDeliveryFee(data) {
  const header = data?.props?.initialState?.menuPage?.menu?.header;
  const row = (header?.uiRows ?? []).find(
    (r) => r?.data && ('delivery-fee.content' in r.data || 'free-delivery.content' in r.data)
  );
  const d = row?.data;
  if (!d) return 0;
  if (d['props.free-delivery-visible'] === true) return 0;
  const match = String(d['delivery-fee.content'] ?? '').match(/£(\d+(?:\.\d+)?)/);
  return match ? parseFloat(match[1]) : 0;
}

function deliverooOfferDescription(offer) {
  const mov = offer?.minimumOrderValue?.formatted;
  const kind =
    {
      FreeItemOffer: 'a free item',
      FreeDeliveryOffer: 'free delivery',
      PercentageOffer: 'a discount',
    }[offer?.typeName] ?? 'an offer';
  return mov ? `Spend ${mov} for ${kind}` : kind;
}

// Offers are scattered through root.offer (offers[], the progress-bar node, etc.),
// so collect every "*Offer" object with a minimum-order value and de-dupe.
function collectDeliverooOffers(offerNode) {
  const found = [];
  const seen = new Set();
  const keys = new Set();
  const walk = (o) => {
    if (!o || typeof o !== 'object' || seen.has(o)) return;
    seen.add(o);
    if (typeof o.typeName === 'string' && /Offer$/.test(o.typeName) && o.minimumOrderValue) {
      const key = `${o.typeName}|${o.minimumOrderValue.fractional}`;
      if (!keys.has(key)) {
        keys.add(key);
        found.push(o);
      }
    }
    for (const k of Object.keys(o)) walk(o[k]);
  };
  walk(offerNode);
  return found;
}

// Turn a platform offer into a structured, applicable form. computeTotal applies
// free-delivery and percentage offers whose minimum spend the order meets.
function deliverooOffers(root) {
  return collectDeliverooOffers(root.offer).map((o) => {
    const minSpend = (o.minimumOrderValue?.fractional ?? 0) / 100;
    const description = deliverooOfferDescription(o);
    if (o.typeName === 'FreeDeliveryOffer') return { type: 'free-delivery', minSpend, description };
    if (o.typeName === 'PercentageOffer') {
      return { type: 'percent', minSpend, percent: (o.percentage ?? 0) / 100, description };
    }
    return { type: 'other', minSpend, description };
  });
}

// Paid options available for a Deliveroo item: its modifier groups' options each
// carry their own price inline. Returned as [{name, price}] so the same option a
// user picked elsewhere can be priced here.
function deliverooItemModifiers(item, groupsById) {
  return (item.modifierGroupIds ?? [])
    .flatMap((gid) => groupsById[gid]?.modifierOptions ?? [])
    .map((o) => ({ name: o.name, price: (o.price?.fractional ?? 0) / 100 }))
    .filter((o) => o.name && o.price > 0);
}

function parseDeliveroo(data) {
  const root = deliverooRoot(data);
  if (!root) throw new Error('Deliveroo: no menu root in __NEXT_DATA__');

  const groupsById = {};
  for (const g of root.modifierGroups ?? []) groupsById[g.id] = g;

  // items is a map keyed by item id, each with price.fractional (pence).
  const items = Object.values(root.items ?? {})
    .map((i) => ({
      name: i.name,
      description: i.description ?? '',
      unitPrice: (i.price?.fractional ?? 0) / 100,
      modifiers: deliverooItemModifiers(i, groupsById),
    }))
    .filter((i) => i.name);

  const address1 = root.restaurant?.location?.address?.address1 ?? '';
  const postcodeMatch = address1.match(/[A-Z]{1,2}\d{1,2}[A-Z]?\s?\d[A-Z]{2}/i);

  return {
    restaurantName: root.restaurant?.name ?? '',
    postcode: postcodeMatch?.[0]?.toUpperCase() ?? '',
    items,
    deliveryFee: deliverooDeliveryFee(data),
    // Service fee is a basket-dependent percentage computed only once items are in
    // the basket, so it isn't on the menu page. computeTotal estimates it from the
    // matched subtotal using this rate/cap and flags the total as estimated.
    serviceFee: 0,
    serviceFeePct: DELIVEROO_SERVICE_FEE_PCT,
    serviceFeeMin: 0,
    serviceFeeMax: DELIVEROO_SERVICE_FEE_CAP,
    serviceFeeEstimated: true,
    offers: deliverooOffers(root),
  };
}

// The menu catalogue slice inside Just Eat's __NEXT_DATA__ blob.
function justEatCdn(data) {
  return data?.props?.appProps?.preloadedState?.menu?.restaurant?.cdn ?? null;
}

// Just Eat exposes the exact fee rules in its menu/dynamic API, which the scraper
// fetches and attaches as data._feedmeDynamic. Delivery is a banded flat fee;
// service is either fixed or a percentage clamped between a min and max.
function justEatDeliveryFee(dynamic) {
  const bands = dynamic?.DeliveryFees?.Bands ?? [];
  const base = bands.slice().sort((a, b) => (a.MinimumAmount ?? 0) - (b.MinimumAmount ?? 0))[0];
  return base ? (base.Fee ?? 0) / 100 : 0;
}

function justEatServiceFee(dynamic) {
  const st = dynamic?.RestaurantFees?.ServiceFee?.ServiceTypes?.Delivery;
  if (st?.Use === 'fixed' && st.Fixed) {
    return { serviceFee: (st.Fixed.Amount ?? 0) / 100, serviceFeePct: 0, serviceFeeMin: 0, serviceFeeMax: Infinity };
  }
  if (st?.Use === 'percentage' && st.Percentage) {
    return {
      serviceFee: 0,
      serviceFeePct: (st.Percentage.Percent ?? 0) / 100,
      serviceFeeMin: (st.Percentage.MinAmount ?? 0) / 100,
      serviceFeeMax: st.Percentage.MaxAmount != null ? st.Percentage.MaxAmount / 100 : Infinity,
    };
  }
  return { serviceFee: 0, serviceFeePct: 0, serviceFeeMin: 0, serviceFeeMax: Infinity };
}

// Paid options for a Just Eat item: each item's variation references modifier
// groups, whose members are modifierSets carrying the option name + additionPrice.
function justEatItemModifiers(item, groupsById, modifierBySetId) {
  const groupIds = (item.variations ?? []).flatMap((v) => v.modifierGroupsIds ?? []);
  return groupIds
    .flatMap((gid) => groupsById[gid]?.modifiers ?? [])
    .map((setId) => modifierBySetId[setId])
    .filter(Boolean)
    .map((m) => ({ name: m.name, price: m.additionPrice ?? 0 }))
    .filter((o) => o.name && o.price > 0);
}

// Recursively lower-case the first letter of every object key. Large Just Eat
// menus defer the catalogue to a CDN file that uses PascalCase keys; this maps it
// onto the camelCase shape the SSR (and this parser) use.
function camelizeKeys(value) {
  if (Array.isArray(value)) return value.map(camelizeKeys);
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value)) out[k.charAt(0).toLowerCase() + k.slice(1)] = camelizeKeys(value[k]);
    return out;
  }
  return value;
}

function parseJustEat(data) {
  const cdn = justEatCdn(data);
  if (!cdn) throw new Error('Just Eat: no menu cdn in __NEXT_DATA__');

  // Large menus ship an empty cdn.items in the page and defer the full catalogue +
  // modifier details to CDN files (PascalCase), which the scraper fetches and
  // attaches. Fall back to those, then to the truncated preview as a last resort.
  let itemSource = cdn.items;
  let modifierGroups = cdn.modifierGroups ?? [];
  let modifierSets = cdn.modifierSets ?? [];
  if (!Object.keys(itemSource ?? {}).length) {
    if (data._feedmeItems) {
      itemSource = camelizeKeys(data._feedmeItems);
      const details = camelizeKeys(data._feedmeItemDetails ?? {});
      modifierGroups = details.modifierGroups ?? [];
      modifierSets = details.modifierSets ?? [];
    } else if (Object.keys(cdn.truncatedItems ?? {}).length) {
      itemSource = cdn.truncatedItems;
    }
  }

  const groupsById = {};
  for (const g of modifierGroups) groupsById[g.id] = g;
  const modifierBySetId = {};
  for (const s of modifierSets) if (s.modifier) modifierBySetId[s.id] = s.modifier;

  // Include deals (meals/bundles) as well as plain items so a "... Meal" reference
  // can match the real meal rather than a bare burger. Sizes are separate items,
  // but guard for any with multiple variations by taking the cheapest base price.
  const items = Object.values(itemSource ?? {})
    .filter((i) => i && (i.type === 'menuitem' || i.type === 'deal') && i.name)
    .map((i) => {
      // dealOnly variations are deal-component placeholders (often £0/£1), not
      // standalone-orderable, so exclude them and price from real variations only.
      const prices = (i.variations ?? [])
        .filter((v) => !v.dealOnly)
        .map((v) => v.basePrice)
        .filter((p) => typeof p === 'number' && p > 0);
      return {
        name: i.name,
        description: i.description ?? '',
        unitPrice: prices.length ? Math.min(...prices) : 0,
        modifiers: justEatItemModifiers(i, groupsById, modifierBySetId),
      };
    });

  const rInfo = cdn.restaurant?.restaurantInfo ?? {};
  const svc = justEatServiceFee(data._feedmeDynamic);

  return {
    restaurantName: rInfo.name ?? '',
    postcode: rInfo.location?.postCode ?? '',
    items,
    deliveryFee: justEatDeliveryFee(data._feedmeDynamic),
    // Service fee comes from Just Eat's own published formula, so it's exact.
    serviceFee: svc.serviceFee,
    serviceFeePct: svc.serviceFeePct,
    serviceFeeMin: svc.serviceFeeMin,
    serviceFeeMax: svc.serviceFeeMax,
    serviceFeeEstimated: false,
    offers: justEatOffers(data._feedmeOffers),
  };
}

// Structured offers from Just Eat's notifications. Percent offers carry the
// minimum spend; the rate and cap are only in the description text. Free-delivery
// notifications keep the threshold in the text too.
function justEatOffers(notifications) {
  return (notifications ?? [])
    .filter((o) => o && o.description)
    .map((o) => {
      const desc = o.description;
      const minSpend = o.minimumSpendValue
        ? o.minimumSpendValue.value / 100
        : parseFloat((desc.match(/spend £(\d+(?:\.\d+)?)/i) ?? [])[1]) || 0;
      if (/free deliver/i.test(desc)) return { type: 'free-delivery', minSpend, description: desc };
      // Only an order-level percentage offer (offerType "Percent") is applied to the
      // whole subtotal. "ItemLevelDiscount" offers ("31% off X Meal") are tied to a
      // specific item we can't assume is ordered, so they're display-only.
      if (o.offerType === 'Percent') {
        const percent = (parseFloat((desc.match(/(\d+(?:\.\d+)?)%/) ?? [])[1]) || 0) / 100;
        const cap = parseFloat((desc.match(/up to £(\d+(?:\.\d+)?)/i) ?? [])[1]) || Infinity;
        return { type: 'percent', minSpend, percent, cap, description: desc };
      }
      return { type: 'other', minSpend, description: desc };
    });
}

module.exports = { classifyResponse, parseMenuResponse, parseUberStore };
