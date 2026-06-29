const { TextEncoder, TextDecoder } = require('util');
global.TextEncoder = TextEncoder;
global.TextDecoder = TextDecoder;

const { JSDOM } = require('jsdom');
const { extractUberStoreCards, extractUberStoreCatalog } = require('../src/content/uber-scraper');
const { parseUberStore } = require('../src/shared/parsers');

function docFromHtml(html) {
  return new JSDOM(`<!DOCTYPE html><body>${html}</body>`).window.document;
}

describe('extractUberStoreCards', () => {
  test('reads the store name from the card heading, not concatenated text', () => {
    // Real Uber feed cards have no aria-label; the name lives in a heading while
    // the rest of the card text is rating/ETA/fee with no separators.
    const doc = docFromHtml(`
      <a href="/gb/store/burger-king-victoria/abc-123">
        <div>
          <h3>Burger King</h3>
          <span>4.5</span><span>20–35 min</span><span>£3.49 Delivery Fee</span>
        </div>
      </a>
    `);
    const cards = extractUberStoreCards(doc);
    expect(cards).toHaveLength(1);
    expect(cards[0].name).toBe('Burger King');
  });

  test('de-dupes multiple links pointing at the same store path', () => {
    const doc = docFromHtml(`
      <a href="/gb/store/bk-victoria/abc-123"><h3>Burger King</h3></a>
      <a href="/gb/store/bk-victoria/abc-123?diningMode=DELIVERY"><h3>Burger King</h3></a>
      <a href="/gb/store/bk-canary/def-456"><h3>Burger King</h3></a>
    `);
    const cards = extractUberStoreCards(doc);
    expect(cards).toHaveLength(2);
    expect(cards.map((c) => c.menuUrl)).toEqual([
      '/gb/store/bk-victoria/abc-123',
      '/gb/store/bk-canary/def-456',
    ]);
  });

  test('parses distance in miles from card text', () => {
    const doc = docFromHtml(`
      <a href="/gb/store/bk-victoria/abc-123">
        <h3>Burger King</h3><span>1.2 mi</span>
      </a>
    `);
    expect(extractUberStoreCards(doc)[0].distance).toBeCloseTo(1.2);
  });

  test('falls back to aria-label when there is no heading element', () => {
    const doc = docFromHtml(`
      <a href="/gb/store/bk-victoria/abc-123" aria-label="Burger King">
        <div>4.5 · 20–35 min</div>
      </a>
    `);
    expect(extractUberStoreCards(doc)[0].name).toBe('Burger King');
  });
});

describe('extractUberStoreCatalog', () => {
  // Reproduce Uber's wire encoding of the react-query blob: `"` -> " and a
  // structural backslash -> %5C (so an escaped quote `\"` becomes %5C").
  const encode = (j) => j.replace(/\\/g, '%5C').replace(/"/g, '\\u0022');
  const blob = {
    mutations: [],
    queries: [{ state: { data: {
      title: 'Subway Mile End Halal',
      sections: [{ items: [
        {
          title: 'Chipotle Cheesy Bites - 5 pieces',
          price: 389,
          // an embedded HTML field carrying escaped quotes, to exercise the %5C path
          priceTagline: { textFormat: '<span style="color:#000">£3.89</span>' },
          itemPromotion: {
            buyXGetYItemPromotion: { buyQuantity: 1, getQuantity: 1, maxRedemptionCount: 3 },
            type: 'buyXGetYItemPromotion',
          },
        },
        { title: 'Legendary Teriyaki', price: 925 },
      ] }],
    } } }],
  };
  const storeDoc = () =>
    docFromHtml(`<script type="application/json">${encode(JSON.stringify(blob))}</script>`);

  test('decodes the double-escaped react-query blob to the store data', () => {
    const data = extractUberStoreCatalog(storeDoc());
    expect(data).toBeTruthy();
    expect(data.title).toBe('Subway Mile End Halal');
  });

  test('the decoded catalogue yields the buy-one-get-one item-deal via parseUberStore', () => {
    const data = extractUberStoreCatalog(storeDoc());
    const deal = parseUberStore({}, data).offers.find((o) => o.type === 'item-deal');
    expect(deal.rule).toBe('cheapest-free');
    expect(deal.eligibleItems).toEqual(['Chipotle Cheesy Bites - 5 pieces']);
  });

  test('returns null when no store catalogue blob is present', () => {
    expect(extractUberStoreCatalog(docFromHtml('<div>no script here</div>'))).toBeNull();
  });
});
