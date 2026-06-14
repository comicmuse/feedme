const fs = require('fs');
const path = require('path');

// Set up globals needed by JSDOM before importing it
const { TextEncoder, TextDecoder } = require('util');
global.TextEncoder = TextEncoder;
global.TextDecoder = TextDecoder;

const { JSDOM } = require('jsdom');
const { extractOrder } = require('../src/content/checkout-reader');
const { PLATFORM } = require('../src/shared/constants');

function docFromFixture(name) {
  const html = fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
  return new JSDOM(html).window.document;
}

describe('extractOrder - Uber Eats', () => {
  let order;
  beforeAll(() => { order = extractOrder(PLATFORM.UBER_EATS, docFromFixture('ubereats-checkout.html')); });

  test('extracts restaurant name', () => { expect(order.restaurantName).toBe('Burger King - Victoria'); });
  test('extracts postcode', () => { expect(order.postcode).toBe('SW1E 5JE'); });
  test('extracts two items', () => { expect(order.items).toHaveLength(2); });
  test('first item name, quantity, and unitPrice', () => {
    expect(order.items[0]).toEqual({ name: 'Whopper', quantity: 1, unitPrice: 5.49 });
  });
  test('second item quantity is 2', () => { expect(order.items[1].quantity).toBe(2); });
  test('extracts delivery fee as 0', () => { expect(order.deliveryFee).toBe(0); });
  test('extracts service fee', () => { expect(order.serviceFee).toBeCloseTo(1.50); });
  test('extracts one discount', () => {
    expect(order.discounts).toHaveLength(1);
    expect(order.discounts[0].amount).toBeCloseTo(1.80);
  });
});

describe('extractOrder - Deliveroo', () => {
  let order;
  beforeAll(() => { order = extractOrder(PLATFORM.DELIVEROO, docFromFixture('deliveroo-checkout.html')); });

  test('extracts restaurant name', () => { expect(order.restaurantName).toBe('Burger King - Victoria'); });
  test('extracts two items', () => { expect(order.items).toHaveLength(2); });
  test('first item unitPrice in pounds', () => { expect(order.items[0].unitPrice).toBeCloseTo(5.89); });
  test('extracts delivery fee', () => { expect(order.deliveryFee).toBeCloseTo(2.99); });
  test('has empty discounts array', () => { expect(order.discounts).toEqual([]); });
});

describe('extractOrder - Just Eat', () => {
  let order;
  beforeAll(() => { order = extractOrder(PLATFORM.JUST_EAT, docFromFixture('just-eat-checkout.html')); });

  test('extracts restaurant name', () => { expect(order.restaurantName).toBe('Burger King - Victoria'); });
  test('extracts two items', () => { expect(order.items).toHaveLength(2); });
  test('first item unitPrice in pounds', () => { expect(order.items[0].unitPrice).toBeCloseTo(5.69); });
});
