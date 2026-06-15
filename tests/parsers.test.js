const { classifyResponse, parseMenuResponse } = require('../src/shared/parsers');
const { PLATFORM } = require('../src/shared/constants');

const ubereats = require('./fixtures/ubereats-menu.json');
const deliveroo = require('./fixtures/deliveroo-menu.json');
const justeat = require('./fixtures/just-eat-menu.json');

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
    expect(result.offers.some((o) => /£20\.00/.test(o.description))).toBe(true);
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
  test('extracts items from the cdn map', () => { expect(result.items).toHaveLength(3); });
  test('first item unitPrice in pounds', () => { expect(result.items[0].unitPrice).toBeCloseTo(5.69); });
  test('resolves the item\'s paid modifier options via modifierSets', () => {
    expect(result.items[0].modifiers).toEqual([{ name: 'Regular Fries', price: 2.50 }]);
  });
  test('uses the cheapest variation for multi-variation items', () => {
    const fries = result.items.find((i) => i.name === 'Large Fries');
    expect(fries.unitPrice).toBeCloseTo(3.09);
  });
  test('extracts delivery fee from the fee API band', () => { expect(result.deliveryFee).toBeCloseTo(0.29); });
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
  test('does not treat item-level discounts as order-level percent offers', () => {
    const itemLevel = result.offers.find((o) => /Meal Deal/.test(o.description));
    expect(itemLevel.type).toBe('other');
    expect(result.offers.filter((o) => o.type === 'percent')).toHaveLength(1);
  });
});
