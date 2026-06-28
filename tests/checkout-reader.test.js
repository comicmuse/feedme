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
  beforeAll(async () => {
    order = await extractOrder(PLATFORM.UBER_EATS, docFromFixture('ubereats-checkout.html'));
  });

  test('extracts restaurant name from store link', () => {
    expect(order.restaurantName).toBe('Burger King - Victoria');
  });
  test('extracts postcode from address section', () => {
    expect(order.postcode).toBe('SW1E 5JE');
  });
  test('extracts two items', () => { expect(order.items).toHaveLength(2); });
  test('first item name and quantity', () => {
    expect(order.items[0].name).toBe('Whopper');
    expect(order.items[0].quantity).toBe(1);
  });
  test('first item unitPrice ignores modifier prices in parens', () => {
    expect(order.items[0].unitPrice).toBeCloseTo(10.38);
  });
  test('captures paid options total from parenthesised modifier prices', () => {
    expect(order.items[0].optionsTotal).toBeCloseTo(1.00);
  });
  test('second item name, price, and zero options', () => {
    expect(order.items[1].name).toBe('Large Fries');
    expect(order.items[1].unitPrice).toBeCloseTo(2.50);
    expect(order.items[1].optionsTotal).toBe(0);
  });
  test('extracts delivery fee as 0', () => { expect(order.deliveryFee).toBe(0); });
  test('extracts service fee', () => { expect(order.serviceFee).toBeCloseTo(1.50); });
  test('extracts membership discount', () => {
    expect(order.discounts).toHaveLength(1);
    expect(order.discounts[0].amount).toBeCloseTo(1.80);
  });
  test('extracts checkout total', () => {
    expect(order.checkoutTotal).toBeCloseTo(12.58);
  });
});

describe('extractOrder - Uber Eats quantities (real DOM)', () => {
  let order;
  beforeAll(async () => {
    order = await extractOrder(PLATFORM.UBER_EATS, docFromFixture('ubereats-checkout-qty.html'));
  });

  test('reads quantity from the row stepper, not the item text', () => {
    // BMT is a Buy-1-get-1 deal: the line shows no "N ×" prefix, only the stepper
    // value of 2. Previously defaulted to 1, under-counting the order everywhere.
    expect(order.items[0].name).toBe('Classic B.M.T.®');
    expect(order.items[0].quantity).toBe(2);
  });

  test('does not mistake a leading "Nx" in the product NAME for a quantity', () => {
    // "3x Chocolate Chunk Cookies" is one pack (stepper = 1); the old regex read 3.
    expect(order.items[1].name).toBe('3x Chocolate Chunk Cookies');
    expect(order.items[1].quantity).toBe(1);
  });

  test('unit price divides the line total by the real quantity', () => {
    // Line total £34.96 (pre-deal, the strikethrough) / 2 = £17.48 per sandwich.
    expect(order.items[0].unitPrice).toBeCloseTo(17.48);
    expect(order.items[1].unitPrice).toBeCloseTo(2.59);
  });
});

describe('extractOrder - Deliveroo', () => {
  let order;
  beforeAll(async () => {
    order = await extractOrder(PLATFORM.DELIVEROO, docFromFixture('deliveroo-checkout.html'));
  });

  test('extracts restaurant name', () => { expect(order.restaurantName).toBe('Burger King - Victoria'); });
  test('extracts two items', () => { expect(order.items).toHaveLength(2); });
  test('first item unitPrice in pounds', () => { expect(order.items[0].unitPrice).toBeCloseTo(5.89); });
  test('extracts delivery fee', () => { expect(order.deliveryFee).toBeCloseTo(2.99); });
  test('has empty discounts array', () => { expect(order.discounts).toEqual([]); });
});

describe('extractOrder - Just Eat', () => {
  let order;
  beforeAll(async () => {
    order = await extractOrder(PLATFORM.JUST_EAT, docFromFixture('just-eat-checkout.html'));
  });

  test('extracts restaurant name', () => { expect(order.restaurantName).toBe('Burger King - Victoria'); });
  test('extracts two items', () => { expect(order.items).toHaveLength(2); });
  test('first item unitPrice in pounds', () => { expect(order.items[0].unitPrice).toBeCloseTo(5.69); });
});
