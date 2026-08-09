const { readCompleteAreaListing, classifyAreaEnumeration } = require('../src/shared/branches');
const listing = require('./fixtures/just-eat-listing.json');

// A complete, location-resolved area listing serialised the way #__NEXT_DATA__
// carries it. The scraper reads `.textContent` of that <script>, so these tests
// exercise the exact string → decision path.
const completeBlob = JSON.stringify(listing);

// Same shape but before Just Eat resolves the location: the listing hydrates
// with an empty restaurantData map (title "…in , | Just Eat", 0 restaurants).
const unresolvedBlob = JSON.stringify({ props: { initialState: { restaurantData: {} } } });

describe('readCompleteAreaListing — the enumerate poll predicate (#105)', () => {
  test('a complete, candidate-bearing blob parses to the data object', () => {
    const data = readCompleteAreaListing(completeBlob);
    expect(data).not.toBeNull();
    // findByKey(data, 'restaurantData') must reach the real map.
    expect(data.props.initialState.restaurantData['73853'].name).toBe('KFC Bishopsgate');
  });

  test('a truncated mid-stream read (unterminated JSON) yields null, so the poll keeps waiting', () => {
    // Cut the blob in half — exactly the torn read that threw ~2.49 MB in live
    // JSON.parse and was previously swallowed as an empty listing.
    const truncated = completeBlob.slice(0, Math.floor(completeBlob.length / 2));
    expect(() => JSON.parse(truncated)).toThrow(); // sanity: it really is torn
    expect(readCompleteAreaListing(truncated)).toBeNull();
  });

  test('a clean parse before the location resolves (0 candidates) yields null, not a false empty', () => {
    expect(readCompleteAreaListing(unresolvedBlob)).toBeNull();
  });

  test('empty / missing text yields null', () => {
    expect(readCompleteAreaListing('')).toBeNull();
    expect(readCompleteAreaListing(undefined)).toBeNull();
    expect(readCompleteAreaListing(null)).toBeNull();
  });
});

describe('classifyAreaEnumeration — the three enumerate outcomes (#105)', () => {
  test('could-not-read (no complete blob) → unreadable, which the scraper surfaces as retryable', () => {
    // The poll timed out: it resolved with null.
    expect(classifyAreaEnumeration(null, 'KFC', 3)).toEqual({ status: 'unreadable' });
  });

  test('read but nothing matched the target brand → honest empty', () => {
    const data = readCompleteAreaListing(completeBlob);
    const out = classifyAreaEnumeration(data, 'Nando\'s', 3);
    expect(out.status).toBe('empty');
    expect(out.branches).toBeUndefined();
    // It did read a populated listing — 4 restaurants, just none of them Nando's.
    expect(out.candidateCount).toBe(4);
  });

  test('read with matching branches → branches (nearest first)', () => {
    const data = readCompleteAreaListing(completeBlob);
    const out = classifyAreaEnumeration(data, 'KFC', 3);
    expect(out.status).toBe('matched');
    expect(out.branches.map((b) => b.id)).toEqual(['81738', '73853', '67207']);
    // Only the projected fields the service worker consumes cross the wire.
    expect(Object.keys(out.branches[0]).sort()).toEqual(
      ['distance', 'earnsStampCard', 'id', 'label', 'listedDeliveryFee', 'menuUrl']
    );
  });
});
