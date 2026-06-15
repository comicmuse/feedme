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
  test('extracts offers with a readable description', () => {
    expect(result.offers).toHaveLength(1);
    expect(result.offers[0].description).toContain('£20.00');
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
  test('extracts offers from notifications', () => {
    expect(result.offers).toHaveLength(1);
    expect(result.offers[0].description).toBe('20% off when you spend £20 before 23:00');
  });
});
