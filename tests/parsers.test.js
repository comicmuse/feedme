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

  test('flattens items from categories', () => { expect(result.items).toHaveLength(3); });
  test('first item unitPrice in pounds', () => { expect(result.items[0].unitPrice).toBeCloseTo(5.89); });
  test('extracts delivery fee', () => { expect(result.deliveryFee).toBeCloseTo(2.99); });
  test('extracts service fee', () => { expect(result.serviceFee).toBeCloseTo(1.72); });
  test('extracts offers', () => {
    expect(result.offers).toHaveLength(1);
    expect(result.offers[0].description).toContain('Free delivery');
  });
});

describe('parseMenuResponse - Just Eat', () => {
  let result;
  beforeAll(() => { result = parseMenuResponse(PLATFORM.JUST_EAT, justeat); });

  test('extracts items', () => { expect(result.items).toHaveLength(3); });
  test('first item unitPrice in pounds', () => { expect(result.items[0].unitPrice).toBeCloseTo(5.69); });
  test('extracts delivery fee', () => { expect(result.deliveryFee).toBeCloseTo(2.99); });
});
