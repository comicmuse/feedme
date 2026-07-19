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
  test('splits a single-span "Group: Value (£price)" modifier into group and name', () => {
    // The live fixture packs the group label and value into one span
    // ("Add: Cheese (£1.00)"), unlike the two-span group/value layout used
    // elsewhere — both must resolve to the same { group, name, price } shape.
    expect(order.items[0].options).toEqual([
      { group: 'Add', name: 'Cheese', price: 1.00 },
    ]);
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

describe('extractOrder - Uber Eats free & grouped options', () => {
  function boxMealDoc() {
    const html = `<!DOCTYPE html><html><body>
      <div data-testid="cart-summary-panel"></div>
      <div data-testid="fare-breakdown-charge-badge-total">£13.29</div>
      <div data-testid="cart-items-list">
        <li><div data-testid="cart-item-1">
          <img alt="Spicy Chicken Sandwich Box Meal" />
          <span data-testid="rich-text">Spicy Chicken Sandwich:</span><span data-testid="rich-text">Spicy Chicken Sandwich</span>
          <span data-testid="rich-text">Choose Your Chicken:</span><span data-testid="rich-text">3 Hot Wings</span>
          <span data-testid="rich-text">Choose Your Fries:</span><span data-testid="rich-text">Regular Fries</span>
          <span data-testid="rich-text">Add a Side?:</span><span data-testid="rich-text">No Thanks</span>
          <span data-testid="rich-text">Add a Shake?:</span><span data-testid="rich-text">No Thanks</span>
          <span>£13.29</span>
        </div></li>
      </div></body></html>`;
    return new JSDOM(html).window.document;
  }

  test('captures free options with their group, keeps optionsTotal at 0', async () => {
    const order = await extractOrder(PLATFORM.UBER_EATS, boxMealDoc());
    expect(order.items[0].optionsTotal).toBe(0);
    expect(order.items[0].options).toEqual([
      { group: 'Spicy Chicken Sandwich', name: 'Spicy Chicken Sandwich', price: 0 },
      { group: 'Choose Your Chicken', name: '3 Hot Wings', price: 0 },
      { group: 'Choose Your Fries', name: 'Regular Fries', price: 0 },
      { group: 'Add a Side?', name: 'No Thanks', price: 0 },
      { group: 'Add a Shake?', name: 'No Thanks', price: 0 },
    ]);
  });

  // Live McDonald's shapes (2026-07-11, issue #29): the cart also renders rows
  // that are not selections — "X Comes With:" ingredient-composition lists (the
  // group's kept defaults, comma-joined) and nested group headers whose value is
  // itself the next group's label ("Large Drink: Bottled Drink" followed by
  // "Bottled Drink: Robinsons® Fruit Shoot"). Captured as options they can never
  // resolve on a target platform and chronically review-flag the line.
  test('drops "Comes With" composition rows and nested group-header rows', async () => {
    const html = `<!DOCTYPE html><html><body>
      <div data-testid="cart-summary-panel"></div>
      <div data-testid="fare-breakdown-charge-badge-total">£14.78</div>
      <div data-testid="cart-items-list">
        <li><div data-testid="cart-item-1">
          <img alt="Big Mac® FIFA World Cup™ Medium Meal" />
          <span data-testid="rich-text">Select Option:</span><span data-testid="rich-text">Big Mac® FIFA World Cup™ Large Meal (£1.10)</span>
          <span data-testid="rich-text">Large Side:</span><span data-testid="rich-text">Side Salad</span>
          <span data-testid="rich-text">Side Salad Comes With:</span><span data-testid="rich-text">Crispy Onion, Cucumber, Tomato, Lettuce</span>
          <span data-testid="rich-text">Large Drink:</span><span data-testid="rich-text">Bottled Drink</span>
          <span data-testid="rich-text">Bottled Drink:</span><span data-testid="rich-text">Robinsons® Fruit Shoot</span>
          <span data-testid="rich-text">Big Mac® Comes With:</span><span data-testid="rich-text">Sauce, Pickles, Lettuce, Onions, Cheese, 2 Beef Patty, Bun</span>
          <span data-testid="rich-text">Big Mac® Additions:</span><span data-testid="rich-text">2x Bacon (£1.00)</span>
          <span>£14.78</span>
        </div></li>
      </div></body></html>`;
    const order = await extractOrder(PLATFORM.UBER_EATS, new JSDOM(html).window.document);
    expect(order.items[0].options).toEqual([
      { group: 'Select Option', name: 'Big Mac® FIFA World Cup™ Large Meal', price: 1.10 },
      { group: 'Large Side', name: 'Side Salad', price: 0 },
      { group: 'Bottled Drink', name: 'Robinsons® Fruit Shoot', price: 0 },
      { group: 'Big Mac® Additions', name: '2x Bacon', price: 1.00 },
    ]);
  });

  test('an option merely sharing words with a group label is kept (only exact header rows drop)', async () => {
    const html = `<!DOCTYPE html><html><body>
      <div data-testid="cart-summary-panel"></div>
      <div data-testid="fare-breakdown-charge-badge-total">£9.99</div>
      <div data-testid="cart-items-list">
        <li><div data-testid="cart-item-1">
          <img alt="Wrap Meal" />
          <span data-testid="rich-text">Choose Drink:</span><span data-testid="rich-text">Coke</span>
          <span data-testid="rich-text">Coke Extras:</span><span data-testid="rich-text">Ice</span>
          <span>£9.99</span>
        </div></li>
      </div></body></html>`;
    const order = await extractOrder(PLATFORM.UBER_EATS, new JSDOM(html).window.document);
    // "Coke" is a real selection even though a later group ("Coke Extras")
    // shares its words — only a value exactly equal to a group label drops.
    expect(order.items[0].options).toEqual([
      { group: 'Choose Drink', name: 'Coke', price: 0 },
      { group: 'Coke Extras', name: 'Ice', price: 0 },
    ]);
  });

  test('ignores non-selection spans (promo badges, notes, packed strikethrough prices)', async () => {
    // Live selections always render as rich-text spans; other cart-row text
    // (promo badges, "Add note", price displays) must not become phantom free
    // options that block prefill or fuzzy-match paid modifiers on other branches.
    const html = `<!DOCTYPE html><html><body>
      <div data-testid="cart-summary-panel"></div>
      <div data-testid="fare-breakdown-charge-badge-total">£25.71</div>
      <div data-testid="cart-items-list">
        <li><div data-testid="cart-item-1">
          <img alt="Classic B.M.T.®" />
          <span data-testid="rich-text">Extras: </span><span data-testid="rich-text">Philly-Style Steak (£3.99)</span>
          <span>Buy 1, Get 1 Free</span>
          <span>Add note</span>
          <span data-testid="rich-text">£25.71 £34.96</span>
          <span>£25.71</span>
        </div></li>
      </div></body></html>`;
    const order = await extractOrder(PLATFORM.UBER_EATS, new JSDOM(html).window.document);
    expect(order.items[0].options).toEqual([
      { group: 'Extras', name: 'Philly-Style Steak', price: 3.99 },
    ]);
  });

  test('splits a single-span label whose group name contains parentheses', async () => {
    const html = `<!DOCTYPE html><html><body>
      <div data-testid="cart-summary-panel"></div>
      <div data-testid="fare-breakdown-charge-badge-total">£5.49</div>
      <div data-testid="cart-items-list">
        <li><div data-testid="cart-item-1">
          <img alt="Meal Deal" />
          <span data-testid="rich-text">Choose Drink (Large): Coke (Zero) (£0.50)</span>
          <span>£5.49</span>
        </div></li>
      </div></body></html>`;
    const order = await extractOrder(PLATFORM.UBER_EATS, new JSDOM(html).window.document);
    expect(order.items[0].options).toEqual([
      { group: 'Choose Drink (Large)', name: 'Coke (Zero)', price: 0.5 },
    ]);
  });

  test('captures a single-span free option with its group (no price suffix)', async () => {
    const html = `<!DOCTYPE html><html><body>
      <div data-testid="cart-summary-panel"></div>
      <div data-testid="fare-breakdown-charge-badge-total">£5.49</div>
      <div data-testid="cart-items-list">
        <li><div data-testid="cart-item-1">
          <img alt="Kebab" />
          <span data-testid="rich-text">Add: Extra Sauce</span>
          <span>£5.49</span>
        </div></li>
      </div></body></html>`;
    const order = await extractOrder(PLATFORM.UBER_EATS, new JSDOM(html).window.document);
    expect(order.items[0].options).toEqual([
      { group: 'Add', name: 'Extra Sauce', price: 0 },
    ]);
  });

  test('still captures a paid option with its price and group', async () => {
    const html = `<!DOCTYPE html><html><body>
      <div data-testid="cart-summary-panel"></div>
      <div data-testid="fare-breakdown-charge-badge-total">£8.49</div>
      <div data-testid="cart-items-list">
        <li><div data-testid="cart-item-1">
          <img alt="6 Boneless & a dip" />
          <span data-testid="rich-text">6 Boneless:</span><span data-testid="rich-text">6 Boneless</span>
          <span data-testid="rich-text">Choose Dips:</span><span data-testid="rich-text">The Big Ranch (£1.00)</span>
          <span>£8.49</span>
        </div></li>
      </div></body></html>`;
    const order = await extractOrder(PLATFORM.UBER_EATS, new JSDOM(html).window.document);
    expect(order.items[0].optionsTotal).toBeCloseTo(1.0);
    expect(order.items[0].options).toEqual([
      { group: '6 Boneless', name: '6 Boneless', price: 0 },
      { group: 'Choose Dips', name: 'The Big Ranch', price: 1.0 },
    ]);
  });
});

describe('extractOrder - Uber Eats restaurant name hydration (#53/#55)', () => {
  // Uber sometimes renders the cart panel (our readiness gate) before i18n
  // strings resolve, so the store links still carry raw keys: the "Back to
  // store" nav link reads `store.shared.backToStore` (no spaces). It is FIRST
  // in the DOM, so the old `!/back to store/i` filter — which a raw key slips
  // past — picked it and scraped the key as the restaurant name.
  const gateEls = `
    <div data-testid="cart-summary-panel"></div>
    <div data-testid="fare-breakdown-charge-badge-total">£9.99</div>
    <div data-testid="cart-items-list">
      <li><div data-testid="cart-item-1"><img alt="Fries" /><span>£9.99</span></div></li>
    </div>`;
  const flakyLinks = `
    <a href="/gb/store/kfc-bethnal-green/uuid1">store.shared.backToStore</a>
    <a href="/gb/store/kfc-bethnal-green/uuid1">
      <div data-testid="store-name">store.shared.backToStore</div>
      <p>406 Bethnal Green Road</p>
    </a>`;
  const docOf = (inner) =>
    new JSDOM(`<!DOCTYPE html><html><body>${inner}</body></html>`).window.document;

  test('#53 skips a raw-key "Back to store" link and reads the real hydrated name', async () => {
    // Back link shows a leaked key; the real store link has hydrated. The link
    // filter must reject the key-like back link and pick the real one.
    const doc = docOf(gateEls + `
      <a href="/gb/store/kfc-bethnal-green/uuid1">store.shared.backToStore</a>
      <a href="/gb/store/kfc-bethnal-green/uuid1">
        <div>KFC Bethnal Green</div>
        <p>406 Bethnal Green Road</p>
      </a>`);
    const order = await extractOrder(PLATFORM.UBER_EATS, doc);
    expect(order.restaurantName).toBe('KFC Bethnal Green');
    expect(order.sourceStoreId).toBe('uuid1');
  });

  test('#53 falls back to the URL slug when the name never leaves i18n-key form', async () => {
    // Both links still show raw keys after the bounded wait — derive the name
    // deterministically from the store-link slug instead of scraping a key.
    jest.useFakeTimers();
    try {
      const doc = docOf(gateEls + flakyLinks);
      const p = extractOrder(PLATFORM.UBER_EATS, doc);
      await jest.advanceTimersByTimeAsync(3000);
      const order = await p;
      expect(order.restaurantName).toBe('kfc bethnal green');
      expect(order.sourceStoreId).toBe('uuid1');
    } finally {
      jest.useRealTimers();
    }
  });

  test('#55 waits for the name region to hydrate, then reads the translated name', async () => {
    // The name leaf starts as a raw key and hydrates a tick later; the reader
    // must hold until it resolves rather than reading the key (or the slug).
    const doc = docOf(gateEls + flakyLinks);
    const p = extractOrder(PLATFORM.UBER_EATS, doc);
    setTimeout(() => {
      doc.querySelector('[data-testid="store-name"]').textContent = 'KFC Bethnal Green';
    }, 10);
    const order = await p;
    expect(order.restaurantName).toBe('KFC Bethnal Green');
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
