const { TextEncoder, TextDecoder } = require('util');
global.TextEncoder = TextEncoder;
global.TextDecoder = TextDecoder;

const { JSDOM } = require('jsdom');
const { extractUberStoreCards } = require('../src/content/uber-scraper');

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
