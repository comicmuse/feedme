const fs = require('fs');
const path = require('path');

// Set up globals needed by JSDOM before importing it
const { TextEncoder, TextDecoder } = require('util');
global.TextEncoder = TextEncoder;
global.TextDecoder = TextDecoder;

const { JSDOM } = require('jsdom');
const { extractOrder, reportFareRowDrift } = require('../src/content/checkout-reader');
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
  // Uber One's two entitlements are separate fare rows and are captured
  // separately, each tagged with a stable id so sibling pricing can identify them
  // without matching on localised label text (#65).
  test('extracts both Uber One entitlements as identified discounts', () => {
    expect(order.discounts).toHaveLength(2);
    expect(order.discounts).toEqual([
      { id: 'uber-one-monthly-benefit', amount: 1.80, label: 'Uber One monthly benefit' },
      { id: 'uber-one-credits', amount: 0.55, label: 'Uber One credits' },
    ]);
  });
  test('extracts checkout total', () => {
    expect(order.checkoutTotal).toBeCloseTo(12.58);
  });

  // Issue #33: an ingredient the user removed on Uber shows only as an absence
  // from the "Comes With" list. The defaults come from the per-item API, so the
  // capture fetches them and emits the difference as a decline the target's
  // Remove group can satisfy.
  const bigMacDetail = require('./fixtures/ubereats-item-bigmac.json');
  const draftOrders = require('./fixtures/ubereats-draft-orders.json');

  const compositionDom = (keptList) => new JSDOM(`<!DOCTYPE html><html><body>
      <div data-testid="cart-summary-panel"></div>
      <div data-testid="fare-breakdown-charge-badge-total">£5.89</div>
      <div data-testid="cart-items-list">
        <li><div data-testid="cart-item-1">
          <img alt="Big Mac®" />
          <span data-testid="rich-text">Big Mac® Comes With:</span><span data-testid="rich-text">${keptList}</span>
          <span>£5.89</span>
        </div></li>
      </div></body></html>`);

  // Two composition lines for different items: one call per distinct item.
  const twoItemCompositionDom = (secondName) => new JSDOM(`<!DOCTYPE html><html><body>
      <div data-testid="cart-summary-panel"></div>
      <div data-testid="fare-breakdown-charge-badge-total">£11.78</div>
      <div data-testid="cart-items-list">
        <li><div data-testid="cart-item-1">
          <img alt="Big Mac®" />
          <span data-testid="rich-text">Big Mac® Comes With:</span><span data-testid="rich-text">Sauce, Lettuce, Onions, Cheese, 2 Beef Patty, Bun</span>
          <span>£5.89</span>
        </div></li>
        <li><div data-testid="cart-item-2">
          <img alt="${secondName}" />
          <span data-testid="rich-text">${secondName} Comes With:</span><span data-testid="rich-text">Sauce, Bun</span>
          <span>£5.89</span>
        </div></li>
      </div></body></html>`);

  const okJson = (payload) => Promise.resolve({ ok: true, json: () => Promise.resolve(payload) });

  const stubUberApis = (dom) => {
    const calls = [];
    dom.window.fetch = (url, init) => {
      calls.push({ url, body: JSON.parse(init.body), credentials: init.credentials });
      if (url.includes('getDraftOrdersByEaterUuidV1')) return okJson(draftOrders);
      if (url.includes('getMenuItemV1')) return okJson(bigMacDetail);
      return Promise.reject(new Error(`unexpected ${url}`));
    };
    return calls;
  };

  test('a removed ingredient becomes a "No X" decline option', async () => {
    const dom = compositionDom('Sauce, Lettuce, Onions, Cheese, 2 Beef Patty, Bun');
    stubUberApis(dom);
    const order = await extractOrder(PLATFORM.UBER_EATS, dom.window.document);
    expect(order.items[0].options).toEqual([
      { group: 'Remove', name: 'No Pickles', price: 0 },
    ]);
  });

  test('the composition row itself is still excluded from options', async () => {
    const dom = compositionDom('Sauce, Lettuce, Onions, Cheese, 2 Beef Patty, Bun');
    stubUberApis(dom);
    const order = await extractOrder(PLATFORM.UBER_EATS, dom.window.document);
    expect(order.items[0].options.some((o) => /Comes With/i.test(o.group))).toBe(false);
  });

  test('untouched defaults produce no Remove selections', async () => {
    const dom = compositionDom('Sauce, Pickles, Lettuce, Onions, Cheese, 2 Beef Patty, Bun');
    stubUberApis(dom);
    const order = await extractOrder(PLATFORM.UBER_EATS, dom.window.document);
    expect(order.items[0].options).toEqual([]);
  });

  test('the item detail is requested with the ids from the draft order', async () => {
    const dom = compositionDom('Sauce, Lettuce, Onions, Cheese, 2 Beef Patty, Bun');
    const calls = stubUberApis(dom);
    await extractOrder(PLATFORM.UBER_EATS, dom.window.document);
    const itemCall = calls.find((c) => c.url.includes('getMenuItemV1'));
    expect(itemCall.body).toMatchObject({
      itemRequestType: 'ITEM',
      storeUuid: '7c0b936e-53cc-4f7b-9558-b41691071f19',
      sectionUuid: '82a88175-4085-50b2-9ac1-9cfda241af83',
      subsectionUuid: '6af6e4d6-c531-53d8-bb5f-82109718d392',
      menuItemUuid: '436063f7-19ba-5d0f-ba15-137deab02561',
    });
  });

  test('a failing fetch leaves the capture exactly as it was (no removals, no throw)', async () => {
    const dom = compositionDom('Sauce, Lettuce, Onions, Cheese, 2 Beef Patty, Bun');
    dom.window.fetch = () => Promise.reject(new Error('offline'));
    const order = await extractOrder(PLATFORM.UBER_EATS, dom.window.document);
    expect(order.items[0].options).toEqual([]);
    expect(order.items[0].name).toBe('Big Mac®');
  });

  test('a non-200 response yields no removals', async () => {
    const dom = compositionDom('Sauce, Lettuce, Onions, Cheese, 2 Beef Patty, Bun');
    dom.window.fetch = () => Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
    const order = await extractOrder(PLATFORM.UBER_EATS, dom.window.document);
    expect(order.items[0].options).toEqual([]);
  });

  test('no composition row means no network call at all', async () => {
    const dom = new JSDOM(`<!DOCTYPE html><html><body>
      <div data-testid="cart-summary-panel"></div>
      <div data-testid="fare-breakdown-charge-badge-total">£9.99</div>
      <div data-testid="cart-items-list">
        <li><div data-testid="cart-item-1">
          <img alt="Whopper" />
          <span data-testid="rich-text">Choose Drink:</span><span data-testid="rich-text">Coke</span>
          <span>£9.99</span>
        </div></li>
      </div></body></html>`);
    let called = false;
    dom.window.fetch = () => { called = true; return Promise.reject(new Error('should not fetch')); };
    const order = await extractOrder(PLATFORM.UBER_EATS, dom.window.document);
    expect(called).toBe(false);
    expect(order.items[0].options).toEqual([{ group: 'Choose Drink', name: 'Coke', price: 0 }]);
  });

  test('internal composition rows never leak onto the returned item', async () => {
    const dom = compositionDom('Sauce, Lettuce, Onions, Cheese, 2 Beef Patty, Bun');
    stubUberApis(dom);
    const order = await extractOrder(PLATFORM.UBER_EATS, dom.window.document);
    expect(Object.keys(order.items[0]).sort()).toEqual(
      ['name', 'options', 'optionsTotal', 'quantity', 'unitPrice'].sort()
    );
  });

  test('a fetch that throws synchronously does not reject the capture', async () => {
    // The page's fetch is called unbound in Chrome, which throws "Illegal
    // invocation" rather than returning a rejected promise (#33 review).
    const dom = compositionDom('Sauce, Lettuce, Onions, Cheese, 2 Beef Patty, Bun');
    dom.window.fetch = () => { throw new TypeError('Illegal invocation'); };
    const order = await extractOrder(PLATFORM.UBER_EATS, dom.window.document);
    expect(order.items[0].options).toEqual([]);
  });

  test('a drifted response shape yields no removals instead of throwing', async () => {
    // `??` guards null/undefined but not a wrong TYPE: customizationsList as a
    // number would make the for…of raise "not iterable".
    const dom = compositionDom('Sauce, Lettuce, Onions, Cheese, 2 Beef Patty, Bun');
    dom.window.fetch = (url) => Promise.resolve({
      ok: true,
      json: () => Promise.resolve(
        url.includes('getDraftOrdersByEaterUuidV1')
          ? draftOrders
          : { data: { customizationsList: 42 } }
      ),
    });
    const order = await extractOrder(PLATFORM.UBER_EATS, dom.window.document);
    expect(order.items[0].options).toEqual([]);
  });

  test('the authenticated POST carries the page session cookie explicitly', async () => {
    // A content script's fetch defaults to credentials: 'same-origin', which can
    // be treated as extension-initiated and drop the cookie — the drafts call
    // then 401s and the feature dies silently in Chrome only (#33 review).
    const dom = compositionDom('Sauce, Lettuce, Onions, Cheese, 2 Beef Patty, Bun');
    const calls = stubUberApis(dom);
    await extractOrder(PLATFORM.UBER_EATS, dom.window.document);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((c) => c.credentials === 'include')).toBe(true);
  });

  test('two lines of the same item fetch its detail exactly once', async () => {
    // Both lines resolve through one cache entry — and a cached null is not
    // retried either, which is what bounds the call count on failure (#33 review).
    const dom = twoItemCompositionDom('Big Mac®');
    const calls = stubUberApis(dom);
    await extractOrder(PLATFORM.UBER_EATS, dom.window.document);
    expect(calls.filter((c) => c.url.includes('getMenuItemV1'))).toHaveLength(1);
  });

  test('a stale draft holding the same item title does not kill the lookup', async () => {
    // getDraftOrdersByEaterUuidV1 returns EVERY open cart. Indexing them all made
    // "Big Mac®" ambiguous across stores and silently dropped the feature; the
    // captured cart's names must pick the one draft that covers them (#33 review).
    const stale = {
      data: {
        draftOrders: [
          { uuid: 'draft-stale', shoppingCart: { items: [{
            ...draftOrders.data.draftOrders[0].shoppingCart.items[0],
            uuid: 'stale-item-uuid',
            storeUuid: 'stale-store-uuid',
          }] } },
          draftOrders.data.draftOrders[0],
        ],
      },
    };
    const dom = twoItemCompositionDom('Big Arch® with Bacon');
    const calls = [];
    dom.window.fetch = (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) });
      if (url.includes('getDraftOrdersByEaterUuidV1')) return okJson(stale);
      return okJson(bigMacDetail);
    };
    const order = await extractOrder(PLATFORM.UBER_EATS, dom.window.document);
    expect(order.items[0].options).toEqual([{ group: 'Remove', name: 'No Pickles', price: 0 }]);
    expect(calls.find((c) => c.url.includes('getMenuItemV1')).body.menuItemUuid)
      .toBe('436063f7-19ba-5d0f-ba15-137deab02561');
  });

  test('one shared deadline bounds the whole enrichment, not each item', async () => {
    // Item fetches run in sequence, so a per-call timeout makes the worst case
    // 4s x (1 + N) of blocked first render. One deadline for the lot keeps the
    // added latency at UBER_API_TIMEOUT regardless of item count (#33 review).
    jest.useFakeTimers();
    try {
      const dom = twoItemCompositionDom('Big Arch® with Bacon');
      dom.window.fetch = (url) => (url.includes('getDraftOrdersByEaterUuidV1')
        ? okJson(draftOrders)
        : new Promise(() => {})); // item detail never answers
      let settled = false;
      const pending = extractOrder(PLATFORM.UBER_EATS, dom.window.document)
        .then((o) => { settled = true; return o; });
      await jest.advanceTimersByTimeAsync(4100); // UBER_API_TIMEOUT + slack
      expect(settled).toBe(true);
      const order = await pending;
      expect(order.items[0].options).toEqual([]);
    } finally {
      jest.useRealTimers();
    }
  });

  describe('give-up logging', () => {
    // The capture has no other visibility during live testing: a 401 on the
    // drafts call, an unresolvable item title and "nothing was removed" are
    // otherwise indistinguishable (AGENTS.md keeps the [FeedMe …] logging).
    let info;
    beforeEach(() => { info = jest.spyOn(console, 'info').mockImplementation(() => {}); });
    afterEach(() => { info.mockRestore(); });

    const logged = () => info.mock.calls.map((c) => c.join(' ')).join('\n');

    test('logs when the draft-orders call comes back empty', async () => {
      const dom = compositionDom('Sauce, Lettuce, Onions, Cheese, 2 Beef Patty, Bun');
      dom.window.fetch = () => Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
      await extractOrder(PLATFORM.UBER_EATS, dom.window.document);
      expect(logged()).toMatch(/\[FeedMe checkout\].*draft/i);
    });

    test('logs the item whose title no draft line resolves', async () => {
      const dom = compositionDom('Sauce, Lettuce, Onions, Cheese, 2 Beef Patty, Bun');
      dom.window.fetch = (url) => (url.includes('getDraftOrdersByEaterUuidV1')
        ? okJson({ data: { draftOrders: [] } })
        : okJson(bigMacDetail));
      await extractOrder(PLATFORM.UBER_EATS, dom.window.document);
      expect(logged()).toMatch(/\[FeedMe checkout\].*Big Mac®/);
    });

    test('logs the item whose detail call comes back empty', async () => {
      const dom = compositionDom('Sauce, Lettuce, Onions, Cheese, 2 Beef Patty, Bun');
      dom.window.fetch = (url) => (url.includes('getDraftOrdersByEaterUuidV1')
        ? okJson(draftOrders)
        : Promise.resolve({ ok: false, json: () => Promise.resolve({}) }));
      await extractOrder(PLATFORM.UBER_EATS, dom.window.document);
      expect(logged()).toMatch(/\[FeedMe checkout\].*detail.*Big Mac®/i);
    });
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

// Uber One's £0 delivery benefit is what lets sibling branches be priced with the
// fee waived (#64). The checkout row shows the struck-through fee next to the
// waived one ("£1.79 £0.00") with the Uber One logo between them — live shape,
// 2026-08-01. The logo is what tells the waiver apart from an ordinary store
// free-delivery promotion, which renders the same two prices without it.
describe('extractOrder - Uber One delivery waiver (#64)', () => {
  const cart = `
    <div data-testid="cart-summary-panel"></div>
    <div data-testid="fare-breakdown-charge-badge-total">£24.39</div>
    <div data-testid="cart-items-list">
      <li><div data-testid="cart-item-1"><img alt="Sub" /><span>£24.95</span></div></li>
    </div>`;
  const docWith = (deliveryRow) =>
    new JSDOM(`<!DOCTYPE html><html><body>${cart}${deliveryRow}</body></html>`).window.document;

  const waivedRow = `<div data-testid="fare-breakdown-charge-badge-delivery-fee">
      <span><span>£1.79</span>&nbsp;<span>
      <span><img src="https://d3smpkehiq8afm.cloudfront.net/email/2022/05/mt_40_costco/uber_one.png" width="14" height="14"></span>
      <span> £0.00</span></span></span></div>`;

  test('flags the waiver when the row shows a struck-through fee and the Uber One logo', async () => {
    const order = await extractOrder(PLATFORM.UBER_EATS, docWith(waivedRow));
    expect(order.uberOneDeliveryWaived).toBe(true);
    // The fee actually charged is still the waived one.
    expect(order.deliveryFee).toBe(0);
  });

  test('does not flag a £0 fee with no Uber One logo (a store free-delivery promo)', async () => {
    const row = `<div data-testid="fare-breakdown-charge-badge-delivery-fee">
      <span><span>£1.79</span>&nbsp;<span> £0.00</span></span></div>`;
    const order = await extractOrder(PLATFORM.UBER_EATS, docWith(row));
    expect(order.uberOneDeliveryWaived).toBe(false);
  });

  test('does not flag an ordinary charged fee', async () => {
    const row = `<div data-testid="fare-breakdown-charge-badge-delivery-fee">£2.79</div>`;
    const order = await extractOrder(PLATFORM.UBER_EATS, docWith(row));
    expect(order.uberOneDeliveryWaived).toBe(false);
  });

  test('does not flag a member row whose fee was NOT waived to zero', async () => {
    // Logo present but the final price is non-zero — the benefit didn't apply
    // (e.g. below the basket minimum), so no waiver may be inferred for siblings.
    const row = `<div data-testid="fare-breakdown-charge-badge-delivery-fee">
      <span><span>£1.79</span>&nbsp;<span><img src="/uber_one.png"><span> £0.99</span></span></span></div>`;
    const order = await extractOrder(PLATFORM.UBER_EATS, docWith(row));
    expect(order.uberOneDeliveryWaived).toBe(false);
  });

  test('does not flag when there is no delivery-fee row at all', async () => {
    const order = await extractOrder(PLATFORM.UBER_EATS, docWith(''));
    expect(order.uberOneDeliveryWaived).toBe(false);
  });
});

// The monthly-benefit amount carries NO testid of its own — it renders as an
// untestidded baseweb tag beside the label, so it has to be read from the row.
// Credits do carry a value testid. Live shapes, 2026-08-01. The testid the reader
// used before this (fare-breakdown-charge-badge-membership-benefit) no longer
// exists on the page at all (#65).
describe('extractOrder - Uber One entitlements (#65)', () => {
  const cart = `
    <div data-testid="cart-summary-panel"></div>
    <div data-testid="fare-breakdown-charge-badge-total">£20.00</div>
    <div data-testid="cart-items-list">
      <li><div data-testid="cart-item-1"><img alt="Sub" /><span>£24.95</span></div></li>
    </div>`;
  const docWith = (rows) =>
    new JSDOM(`<!DOCTYPE html><html><body>${cart}${rows}</body></html>`).window.document;

  const monthlyRow = `<li>
      <div><div data-testid="fare-breakdown-charge-badge-uber-one-monthly-benefit-label">Uber One monthly benefit</div></div>
      <span data-baseweb="tag"><svg><title>Uber one</title></svg><span>-£3.00</span></span>
    </li>`;
  const creditsRow = `<li>
      <div><div data-testid="fare-breakdown-charge-badge-uber-one-credits-label">Uber One credits</div></div>
      <div data-testid="fare-breakdown-charge-badge-uber-one-credits"><span> -£0.55</span></div>
    </li>`;

  test('reads the monthly benefit from the row when its amount has no testid', async () => {
    const order = await extractOrder(PLATFORM.UBER_EATS, docWith(monthlyRow));
    expect(order.discounts).toEqual([
      { id: 'uber-one-monthly-benefit', amount: 3.0, label: 'Uber One monthly benefit' },
    ]);
  });

  test('reads the credits row from its own value testid', async () => {
    const order = await extractOrder(PLATFORM.UBER_EATS, docWith(creditsRow));
    expect(order.discounts).toEqual([
      { id: 'uber-one-credits', amount: 0.55, label: 'Uber One credits' },
    ]);
  });

  test('captures nothing when neither entitlement is on the cart', async () => {
    const order = await extractOrder(PLATFORM.UBER_EATS, docWith(''));
    expect(order.discounts).toEqual([]);
  });

  test('ignores a row whose amount cannot be read rather than discounting £0', async () => {
    const broken = `<li>
      <div><div data-testid="fare-breakdown-charge-badge-uber-one-monthly-benefit-label">Uber One monthly benefit</div></div>
      <span data-baseweb="tag"><svg><title>Uber one</title></svg><span>—</span></span>
    </li>`;
    const order = await extractOrder(PLATFORM.UBER_EATS, docWith(broken));
    expect(order.discounts).toEqual([]);
  });
});

// A store or account promotion applied to the cart renders as its own fare row.
// Live console capture on a Five Guys checkout (2026-08-02, #87) reported
// `fare-breakdown-charge-badge-promotion-label` as unrecognised — and reported ONLY
// the label, so the amount carries no testid of its own, the same shape as the
// monthly benefit. Unlike the Uber One rows the label text is the offer's own
// description ("Save 40% when you order £25 or more" — the live Five Guys
// shopfront offer, 2026-08-02), which varies per promotion, so it is read from the
// row rather than hardcoded.
//
// Observed live: the label testid, and that no value testid accompanied it. The
// amount's own markup below is modelled on the monthly-benefit row rather than
// captured — the account was at Uber's six-cart cap, so a Five Guys cart could not
// be built to render one. Reading the row minus its label doesn't depend on that
// markup, which is why the third test pins the value-testid shape too.
describe('extractOrder - promotion fare row (#87)', () => {
  const cart = `
    <div data-testid="cart-summary-panel"></div>
    <div data-testid="fare-breakdown-charge-badge-total">£20.00</div>
    <div data-testid="cart-items-list">
      <li><div data-testid="cart-item-1"><img alt="Sub" /><span>£24.95</span></div></li>
    </div>`;
  const docWith = (rows) =>
    new JSDOM(`<!DOCTYPE html><html><body>${cart}${rows}</body></html>`).window.document;

  // The live shape: label testid present, amount an untestidded sibling.
  const promoRow = `<li>
      <div><div data-testid="fare-breakdown-charge-badge-promotion-label">Save 40% when you order £25 or more</div></div>
      <span data-baseweb="tag"><span>-£11.56</span></span>
    </li>`;

  test('reads the promotion from the row when its amount has no testid', async () => {
    const order = await extractOrder(PLATFORM.UBER_EATS, docWith(promoRow));
    expect(order.discounts).toEqual([
      { id: 'promotion', amount: 11.56, label: 'Save 40% when you order £25 or more' },
    ]);
  });

  // The label is the offer's description, so it must come from the DOM — a
  // hardcoded string would show every user the wrong promotion name.
  test('describes the discount with the row\'s own label text', async () => {
    const other = promoRow.replace('Save 40% when you order £25 or more', '15% off (up to £20) on large orders');
    const order = await extractOrder(PLATFORM.UBER_EATS, docWith(other));
    expect(order.discounts[0].label).toBe('15% off (up to £20) on large orders');
  });

  // Reading the row minus its label is shape-agnostic by construction, so a value
  // testid appearing later must change nothing.
  test('reads the amount from a value testid if Uber ever adds one', async () => {
    const withValue = `<li>
      <div><div data-testid="fare-breakdown-charge-badge-promotion-label">Promotion</div></div>
      <div data-testid="fare-breakdown-charge-badge-promotion"><span>-£4.00</span></div>
    </li>`;
    const order = await extractOrder(PLATFORM.UBER_EATS, docWith(withValue));
    expect(order.discounts).toEqual([{ id: 'promotion', amount: 4.0, label: 'Promotion' }]);
  });

  test('captures nothing when no promotion is applied', async () => {
    const order = await extractOrder(PLATFORM.UBER_EATS, docWith(''));
    expect(order.discounts).toEqual([]);
  });

  test('ignores a promotion row whose amount cannot be read rather than discounting £0', async () => {
    const broken = `<li>
      <div><div data-testid="fare-breakdown-charge-badge-promotion-label">Promotion</div></div>
      <span data-baseweb="tag"><span>—</span></span>
    </li>`;
    const order = await extractOrder(PLATFORM.UBER_EATS, docWith(broken));
    expect(order.discounts).toEqual([]);
  });

  test('no longer reports the promotion row as drift', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    await extractOrder(PLATFORM.UBER_EATS, docWith(promoRow));
    const messages = warn.mock.calls.map((c) => c.join(' '));
    warn.mockRestore();
    expect(messages.filter((m) => /unrecognised fare row/i.test(m))).toEqual([]);
  });
});

// Uber's checkout testids have drifted twice (#53/#55, #65) and both times the
// failure was silent: a missing data-testid reads as "no such row", which is
// indistinguishable from "this cart has no such row". Asserting that required rows
// exist would NOT have caught #65 — the row that vanished was a conditional one.
// The signal that would have caught it is the inverse: a fare row on the page that
// this reader doesn't recognise, which is exactly what a rename looks like from
// here (#70).
describe('extractOrder - Uber fare-row drift guard (#70)', () => {
  let warn;
  beforeEach(() => { warn = jest.spyOn(console, 'warn').mockImplementation(() => {}); });
  afterEach(() => { warn.mockRestore(); });

  const cart = `
    <div data-testid="cart-summary-panel"></div>
    <div data-testid="cart-items-list">
      <li><div data-testid="cart-item-1"><img alt="Sub" /><span>£10.00</span></div></li>
    </div>`;
  const docWith = (rows) =>
    new JSDOM(`<!DOCTYPE html><html><body>${cart}${rows}</body></html>`).window.document;
  const healthyRows = `
    <div data-testid="fare-breakdown-charge-badge-subtotal">£10.00</div>
    <div data-testid="fare-breakdown-charge-badge-delivery-fee">£1.79</div>
    <div data-testid="fare-breakdown-charge-badge-fees">£2.03</div>
    <div data-testid="fare-breakdown-charge-badge-total">£13.82</div>`;
  const warnings = () => warn.mock.calls.map((c) => c.join(' '));

  test('warns about a fare row the reader does not recognise', async () => {
    // Exactly the shape of the #65 rename: a new row appears under a name we
    // have no mapping for, while the old one quietly stops existing.
    await extractOrder(PLATFORM.UBER_EATS, docWith(
      healthyRows + '<div data-testid="fare-breakdown-charge-badge-uber-one-new-benefit">-£2.00</div>'
    ));
    const hit = warnings().find((m) => /unrecognised fare row/i.test(m));
    expect(hit).toBeDefined();
    expect(hit).toContain('fare-breakdown-charge-badge-uber-one-new-benefit');
  });

  test('stays quiet when every fare row on the page is recognised', async () => {
    await extractOrder(PLATFORM.UBER_EATS, docWith(healthyRows));
    expect(warnings()).toEqual([]);
  });

  // Driven directly: a document with no total row makes extractOrder wait out its
  // full element timeout, and this branch is about the report, not the waiting.
  // It is the only net for a wholesale prefix rename, where no row matches the
  // selector at all and the unrecognised-row check therefore sees nothing.
  test('warns when the total row — which every priced checkout has — is absent', () => {
    reportFareRowDrift(docWith('<div data-testid="fare-breakdown-charge-badge-subtotal">£10.00</div>'));
    expect(warnings().some((m) => /total/i.test(m))).toBe(true);
  });

  test('warns on a wholesale rename, where no known row matches at all', () => {
    reportFareRowDrift(docWith('<div data-testid="fare-summary-row-total">£13.82</div>'));
    expect(warnings().some((m) => /total/i.test(m))).toBe(true);
  });

  test('a drifted page still yields an order — the guard reports, it never throws', async () => {
    const order = await extractOrder(PLATFORM.UBER_EATS, docWith(
      healthyRows + '<div data-testid="fare-breakdown-charge-badge-unknown-thing">£1.00</div>'
    ));
    expect(order.platform).toBe(PLATFORM.UBER_EATS);
    expect(order.items).toHaveLength(1);
  });
});
