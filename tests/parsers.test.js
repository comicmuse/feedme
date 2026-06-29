const { classifyResponse, parseMenuResponse, parseUberStore } = require('../src/shared/parsers');
const { matchItems, computeTotal } = require('../src/shared/matcher');
const { PLATFORM } = require('../src/shared/constants');

const ubereats = require('./fixtures/ubereats-menu.json');
const deliveroo = require('./fixtures/deliveroo-menu.json');
const justeat = require('./fixtures/just-eat-menu.json');
const uberStoreLd = require('./fixtures/ubereats-store-ld.json');
const uberStoreCatalog = require('./fixtures/ubereats-store-catalog.json');

describe('parseUberStore (Uber store-page JSON-LD)', () => {
  test('flattens JSON-LD menu sections into priced items', () => {
    const m = parseUberStore(uberStoreLd);
    expect(m.restaurantName).toBe('Subway Mile End Halal');
    expect(m.items.length).toBe(176);
    const bites = m.items.find((i) => i.name === 'Chipotle Cheesy Bites - 5 pieces');
    expect(bites.unitPrice).toBeCloseTo(3.89);
    expect(m.items.every((i) => typeof i.unitPrice === 'number' && !Number.isNaN(i.unitPrice))).toBe(true);
  });

  test('produces the standard parsed shape (fees default to 0, offers empty)', () => {
    const m = parseUberStore(uberStoreLd);
    expect(m).toMatchObject({ deliveryFee: 0, serviceFee: 0, offers: [] });
  });

  test('without a catalog blob there are no offers (back-compat)', () => {
    expect(parseUberStore(uberStoreLd).offers).toEqual([]);
  });
});

describe('parseUberStore item-level deals (catalog blob)', () => {
  test('maps a buyXGetYItemPromotion to a structured cheapest-free item-deal', () => {
    const m = parseUberStore(uberStoreLd, uberStoreCatalog);
    const deal = m.offers.find((o) => o.type === 'item-deal');
    expect(deal).toBeTruthy();
    expect(deal.rule).toBe('cheapest-free');
    expect(deal.quantity).toBe(2);
  });

  test('groups promo items into one deal with their titles as eligibleItems', () => {
    const m = parseUberStore(uberStoreLd, uberStoreCatalog);
    const deals = m.offers.filter((o) => o.type === 'item-deal');
    expect(deals).toHaveLength(1);
    expect(deals[0].eligibleItems).toEqual([
      'Chipotle Cheesy Bites - 5 pieces',
      'Nacho Chicken Bites - 6 Bites',
    ]);
  });

  test('ignores items that carry no itemPromotion', () => {
    const m = parseUberStore(uberStoreLd, uberStoreCatalog);
    const deals = m.offers.filter((o) => o.type === 'item-deal');
    expect(deals[0].eligibleItems).not.toContain('Legendary Teriyaki');
  });
});

describe('Uber store buy-one-get-one deal applied end-to-end', () => {
  const parsed = parseUberStore(uberStoreLd, uberStoreCatalog);

  test('frees the cheapest item when two eligible items are in the cart', () => {
    const matches = matchItems(
      [
        { name: 'Chipotle Cheesy Bites - 5 pieces', quantity: 1 },
        { name: 'Nacho Chicken Bites - 6 Bites', quantity: 1 },
      ],
      parsed.items
    );
    const result = computeTotal(matches, 0, 0, parsed.offers);
    expect(result.discountTotal).toBeCloseTo(3.89);
    expect(result.appliedDeals).toHaveLength(1);
  });

  test('does not discount when only one eligible unit is in the cart', () => {
    const matches = matchItems(
      [{ name: 'Chipotle Cheesy Bites - 5 pieces', quantity: 1 }],
      parsed.items
    );
    const result = computeTotal(matches, 0, 0, parsed.offers);
    expect(result.discountTotal).toBe(0);
    expect(result.appliedDeals).toEqual([]);
  });
});

describe('classifyResponse', () => {
  test('identifies Uber Eats menu response', () => {
    expect(classifyResponse(PLATFORM.UBER_EATS, ubereats)).toBe('menu');
  });
  test('identifies Deliveroo menu response', () => {
    expect(classifyResponse(PLATFORM.DELIVEROO, deliveroo)).toBe('menu');
  });
  test('identifies Just Eat menu response', () => {
    expect(classifyResponse(PLATFORM.JUST_EAT, justeat)).toBe('menu');
  });
  test('returns null for unrecognised response', () => {
    expect(classifyResponse(PLATFORM.UBER_EATS, { random: true })).toBeNull();
  });
  test('returns null for null input', () => {
    expect(classifyResponse(PLATFORM.DELIVEROO, null)).toBeNull();
  });
});

describe('parseMenuResponse - Uber Eats', () => {
  let result;
  beforeAll(() => { result = parseMenuResponse(PLATFORM.UBER_EATS, ubereats); });

  test('extracts restaurant name', () => { expect(result.restaurantName).toBe('Burger King - Victoria'); });
  test('extracts postcode', () => { expect(result.postcode).toBe('SW1E 5JE'); });
  test('extracts 3 items', () => { expect(result.items).toHaveLength(3); });
  test('first item has correct name and unitPrice in pounds', () => {
    expect(result.items[0].name).toBe('Whopper');
    expect(result.items[0].unitPrice).toBeCloseTo(5.49);
  });
  test('extracts delivery fee in pounds', () => { expect(result.deliveryFee).toBe(0); });
});

describe('parseMenuResponse - Deliveroo', () => {
  let result;
  beforeAll(() => { result = parseMenuResponse(PLATFORM.DELIVEROO, deliveroo); });

  test('extracts restaurant name', () => { expect(result.restaurantName).toBe('Burger King - Victoria'); });
  test('extracts postcode from address', () => { expect(result.postcode).toBe('SW1E 5JE'); });
  test('flattens items from the items map', () => { expect(result.items).toHaveLength(3); });
  test('first item name and unitPrice in pounds', () => {
    expect(result.items[0].name).toBe('Whopper');
    expect(result.items[0].unitPrice).toBeCloseTo(5.89);
  });
  test('resolves the item\'s paid modifier options', () => {
    expect(result.items[0].modifiers).toEqual([{ name: 'Regular Fries', price: 2.50 }]);
  });
  test('extracts standard delivery fee from the header', () => {
    expect(result.deliveryFee).toBeCloseTo(1.29);
  });
  test('service fee is 0 (basket-dependent, not on the menu page)', () => {
    expect(result.serviceFee).toBe(0);
  });
  test('collects offers including a structured free-delivery threshold', () => {
    const freeDel = result.offers.find((o) => o.type === 'free-delivery');
    expect(freeDel).toBeTruthy();
    expect(freeDel.minSpend).toBeCloseTo(10);
  });
  test('maps a FreeItemOffer to a structured free-item item-deal', () => {
    const deal = result.offers.find((o) => o.type === 'item-deal');
    expect(deal).toBeTruthy();
    expect(deal.rule).toBe('free-item');
    expect(deal.minSpend).toBeCloseTo(20);
  });
  test('resolves FreeItemOffer itemIds to branch item names as eligibleItems', () => {
    const deal = result.offers.find((o) => o.type === 'item-deal');
    expect(deal.eligibleItems).toEqual(['Large Fries']);
  });
});

describe('Deliveroo free-item deal applied end-to-end', () => {
  const parsed = parseMenuResponse(PLATFORM.DELIVEROO, deliveroo);

  test('frees the named item once the minimum spend is met and it is in the cart', () => {
    // Double Whopper £7.89 x3 = £23.67 + Large Fries £3.19 = £26.86 subtotal (>= £20)
    const matches = matchItems(
      [{ name: 'Double Whopper', quantity: 3 }, { name: 'Large Fries', quantity: 1 }],
      parsed.items
    );
    const result = computeTotal(matches, 0, 0, parsed.offers);
    expect(result.discountTotal).toBeCloseTo(3.19);
    expect(result.appliedDeals).toHaveLength(1);
  });
  test('does not free the item when the minimum spend is not met', () => {
    const matches = matchItems([{ name: 'Large Fries', quantity: 1 }], parsed.items);
    const result = computeTotal(matches, 0, 0, parsed.offers);
    expect(result.discountTotal).toBe(0);
    expect(result.appliedDeals).toEqual([]);
  });
  test('does not free the item when it is not in the cart', () => {
    const matches = matchItems([{ name: 'Double Whopper', quantity: 3 }], parsed.items);
    const result = computeTotal(matches, 0, 0, parsed.offers);
    expect(result.discountTotal).toBe(0);
    expect(result.appliedDeals).toEqual([]);
  });
});

describe('parseMenuResponse - Just Eat dealOnly placeholders and deals', () => {
  // The same burger appears as £0/£1 deal-component placeholders (dealOnly: true)
  // plus the real £9.79 standalone (dealOnly: false), and the meal as a "deal".
  const data = {
    props: { appProps: { preloadedState: { menu: { restaurant: { cdn: {
      restaurant: { restaurantInfo: { name: 'Burger King', location: { postCode: 'E14 7LG' } } },
      items: {
        a: { id: 'a', name: 'Bacon Double Cheese XL', type: 'menuitem', variations: [{ basePrice: 1, dealOnly: true }] },
        b: { id: 'b', name: 'Bacon Double Cheese XL', type: 'menuitem', variations: [{ basePrice: 0, dealOnly: true }] },
        c: { id: 'c', name: 'Bacon Double Cheese XL', type: 'menuitem', variations: [{ basePrice: 9.79, dealOnly: false }] },
        d: { id: 'd', name: 'Bacon Double Cheese XL Meal', type: 'deal', variations: [{ basePrice: 12.59, dealOnly: false }] },
      },
    } } } } } },
  };
  let result;
  beforeAll(() => { result = parseMenuResponse(PLATFORM.JUST_EAT, data); });

  test('prices dealOnly placeholder copies at 0 and the real entry at its price', () => {
    const burgers = result.items.filter((i) => i.name === 'Bacon Double Cheese XL');
    expect(burgers.map((b) => b.unitPrice).sort((x, y) => x - y)).toEqual([0, 0, 9.79]);
  });
  test('includes deal (meal) items', () => {
    const meal = result.items.find((i) => i.name === 'Bacon Double Cheese XL Meal');
    expect(meal.unitPrice).toBeCloseTo(12.59);
  });
  test('matching skips the placeholders and resolves real prices', () => {
    const [burger] = matchItems([{ name: 'Bacon Double Cheese XL', quantity: 1 }], result.items);
    expect(burger.platformItem.unitPrice).toBeCloseTo(9.79);
    const [meal] = matchItems([{ name: 'Bacon Double Cheese XL Meal', quantity: 1 }], result.items);
    expect(meal.platformItem.unitPrice).toBeCloseTo(12.59);
  });
});

describe('parseMenuResponse - Just Eat deferred (large menu) catalogue', () => {
  // Large menus ship empty cdn.items + a PascalCase CDN catalogue the scraper attaches.
  const data = {
    props: { appProps: { preloadedState: { menu: { restaurant: { cdn: {
      restaurant: { restaurantInfo: { name: 'Pizza Hut', location: { postCode: 'E14 7LG' } } },
      items: {},
    } } } } } },
    _feedmeItems: [
      { Id: 'p1', Name: 'Pepperoni Feast', Description: '', Type: 'menuitem',
        Variations: [{ BasePrice: 14.99, ModifierGroupsIds: ['mg1'] }] },
    ],
    _feedmeItemDetails: {
      ModifierGroups: [{ Id: 'mg1', Name: 'Extras', Modifiers: ['s1'] }],
      ModifierSets: [{ Id: 's1', Modifier: { Id: 'm1', Name: 'Extra Cheese', AdditionPrice: 1.50 } }],
    },
  };
  let result;
  beforeAll(() => { result = parseMenuResponse(PLATFORM.JUST_EAT, data); });

  test('falls back to the deferred CDN catalogue and normalises PascalCase', () => {
    expect(result.items).toHaveLength(1);
    expect(result.items[0].name).toBe('Pepperoni Feast');
    expect(result.items[0].unitPrice).toBeCloseTo(14.99);
  });
  test('resolves modifiers from the deferred item details', () => {
    expect(result.items[0].modifiers).toEqual([{ name: 'Extra Cheese', price: 1.50 }]);
  });
});

describe('parseMenuResponse - Just Eat', () => {
  let result;
  beforeAll(() => { result = parseMenuResponse(PLATFORM.JUST_EAT, justeat); });

  test('extracts restaurant name', () => { expect(result.restaurantName).toBe('Burger King - Victoria'); });
  test('extracts postcode', () => { expect(result.postcode).toBe('SW1E 5JE'); });
  test('extracts items from the cdn map', () => { expect(result.items).toHaveLength(4); });
  test('first item unitPrice in pounds', () => { expect(result.items[0].unitPrice).toBeCloseTo(5.69); });
  test('resolves the item\'s paid modifier options via modifierSets', () => {
    expect(result.items[0].modifiers).toEqual([{ name: 'Regular Fries', price: 2.50 }]);
  });
  test('uses the cheapest variation for multi-variation items', () => {
    const fries = result.items.find((i) => i.name === 'Large Fries');
    expect(fries.unitPrice).toBeCloseTo(3.09);
  });
  test('extracts delivery fee from the fee API band', () => { expect(result.deliveryFee).toBeCloseTo(0.29); });
  test('exposes the delivery fee bands (sorted, in pounds) for basket-dependent selection', () => {
    expect(result.deliveryFeeBands).toEqual([{ minSubtotal: 0, fee: 0.29 }]);
  });
  test('exposes the exact service-fee formula (not estimated)', () => {
    expect(result.serviceFeePct).toBeCloseTo(0.11);
    expect(result.serviceFeeMin).toBeCloseTo(0.99);
    expect(result.serviceFeeMax).toBeCloseTo(2.99);
    expect(result.serviceFeeEstimated).toBe(false);
  });
  test('parses structured free-delivery and percent offers from notifications', () => {
    const freeDel = result.offers.find((o) => o.type === 'free-delivery');
    expect(freeDel).toBeTruthy();
    expect(freeDel.minSpend).toBeCloseTo(15);
    const percent = result.offers.find((o) => o.type === 'percent');
    expect(percent.minSpend).toBeCloseTo(15);
    expect(percent.percent).toBeCloseTo(0.20);
    expect(percent.cap).toBeCloseTo(10);
  });
  test('maps an ItemLevelDiscount to a structured percent-off-items item-deal', () => {
    const deal = result.offers.find((o) => o.type === 'item-deal');
    expect(deal).toBeTruthy();
    expect(deal.rule).toBe('percent-off-items');
    expect(deal.percent).toBeCloseTo(0.25);
    expect(deal.cap).toBe(Infinity);
  });
  test('resolves offerMenuItems Product ids to branch item names as eligibleItems', () => {
    const deal = result.offers.find((o) => o.type === 'item-deal');
    expect(deal.eligibleItems).toEqual(['Whopper', 'Large Fries']);
  });
  test('ignores Category-type offerMenuItems that cannot be resolved to items', () => {
    const deal = result.offers.find((o) => o.type === 'item-deal');
    expect(deal.eligibleItems).toHaveLength(2);
  });
  test('does not treat the item-level discount as an order-level percent offer', () => {
    expect(result.offers.filter((o) => o.type === 'percent')).toHaveLength(1);
  });
});

describe('Just Eat item-level deal applied end-to-end', () => {
  const parsed = parseMenuResponse(PLATFORM.JUST_EAT, justeat);

  test('discounts an eligible item that is in the cart', () => {
    const matches = matchItems([{ name: 'Whopper', quantity: 1 }], parsed.items);
    const result = computeTotal(matches, 0, 0, parsed.offers);
    expect(result.discountTotal).toBeCloseTo(5.69 * 0.25);
    expect(result.appliedDeals).toHaveLength(1);
  });

  test('leaves the total unchanged when no eligible item is in the cart', () => {
    const matches = matchItems([{ name: 'Onion Rings', quantity: 1 }], parsed.items);
    const result = computeTotal(matches, 0, 0, parsed.offers);
    expect(result.discountTotal).toBe(0);
    expect(result.appliedDeals).toEqual([]);
  });
});
