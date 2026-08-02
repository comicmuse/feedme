const { findByKey, selectNearestBranches } = require('../src/shared/branches');

const candidates = [
  { id: 'bk-cw',  name: 'Burger King', label: 'Canary Wharf', distance: 1.8, menuUrl: '/restaurants-bk-cw/menu' },
  { id: 'bk-wc',  name: 'Burger King', label: 'Whitechapel',  distance: 0.4, menuUrl: '/restaurants-bk-wc/menu' },
  { id: 'bk-al',  name: 'Burger King', label: 'Aldgate',      distance: 0.9, menuUrl: '/restaurants-bk-al/menu' },
  { id: 'kfc-al', name: 'KFC',          label: 'Aldgate',      distance: 0.3, menuUrl: '/restaurants-kfc-al/menu' },
];

describe('findByKey', () => {
  test('finds a nested object by key', () => {
    expect(findByKey({ a: { b: { restaurantData: { x: 1 } } } }, 'restaurantData')).toEqual({ x: 1 });
  });
  test('returns null when absent', () => {
    expect(findByKey({ a: 1 }, 'missing')).toBeNull();
  });
});

describe('selectNearestBranches', () => {
  test('returns the nearest N of the matching chain, sorted by distance', () => {
    const out = selectNearestBranches(candidates, 'Burger King', 2);
    expect(out.map((b) => b.id)).toEqual(['bk-wc', 'bk-al']);
  });
  test('excludes other chains', () => {
    const out = selectNearestBranches(candidates, 'Burger King', 5);
    expect(out.every((b) => b.name === 'Burger King')).toBe(true);
  });
  test('independent restaurant: a single match yields exactly one branch', () => {
    const solo = [{ id: 'pizza-1', name: 'Tony\'s Pizza', label: '', distance: 0.5, menuUrl: '/r/menu' }];
    const out = selectNearestBranches(solo, 'Tonys Pizza', 3);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('pizza-1');
  });
  test('empty target name yields no branches', () => {
    expect(selectNearestBranches(candidates, '', 3)).toEqual([]);
  });
  test('de-dupes by id', () => {
    const dup = [...candidates, { ...candidates[1] }];
    const out = selectNearestBranches(dup, 'Burger King', 5);
    expect(out.filter((b) => b.id === 'bk-wc')).toHaveLength(1);
  });
});

describe('selectNearestBranches — deterministic brand matching', () => {
  // The source name is the verbose platform store name; candidates may be just
  // the brand. Matching must be brand-based, not fuzzy on the whole string.
  const mixed = [
    { id: 'sub-1', name: 'Subway',               label: 'Aldgate',   distance: 0.3, menuUrl: '/m/1' },
    { id: 'sub-2', name: 'Subway - Mile End',     label: 'Mile End',  distance: 0.6, menuUrl: '/m/2' },
    { id: 'bm',    name: 'BurgerMania',           label: 'X',         distance: 0.2, menuUrl: '/m/3' },
    { id: 'be',    name: 'Burger Eats',           label: 'Y',         distance: 0.1, menuUrl: '/m/4' },
    { id: 'bk',    name: 'Burger King - Canary Wharf', label: 'CW',   distance: 0.9, menuUrl: '/m/5' },
  ];

  test('verbose source name matches every same-brand branch (divergent localities)', () => {
    const out = selectNearestBranches(mixed, 'Subway Mile End Halal', 5).map((b) => b.id);
    expect(out).toContain('sub-1'); // "Subway"
    expect(out).toContain('sub-2'); // "Subway - Mile End"
    expect(out).not.toContain('bm'); // "BurgerMania" — different brand
    expect(out).not.toContain('bk'); // "Burger King …" — different brand
  });

  test('excludes partial-word lookalikes (different first token)', () => {
    // "BurgerMania" is one token != "burger", so it is filtered at enumeration.
    const out = selectNearestBranches(mixed, 'Burger King', 5).map((b) => b.id);
    expect(out).not.toContain('bm');
  });

  test('a sibling brand sharing the first word is enumerated (dropped later by item match)', () => {
    // First-token matching cannot tell "Burger Eats" from "Burger King"; the
    // service worker drops 0-item-match branches after scraping (stage 2).
    const out = selectNearestBranches(mixed, 'Burger King', 5).map((b) => b.id);
    expect(out).toContain('bk'); // real Burger King
    expect(out).toContain('be'); // "Burger Eats" — survives enumeration, dropped post-scrape
  });

  test('apostrophe/punctuation differences still match', () => {
    const solo = [{ id: 'tp', name: "Tony's Pizza", label: '', distance: 0.5, menuUrl: '/m' }];
    expect(selectNearestBranches(solo, 'Tonys Pizza', 3).map((b) => b.id)).toEqual(['tp']);
  });
});

const { justEatCandidates } = require('../src/shared/branches');
const jeListing = require('./fixtures/just-eat-listing.json');

describe('justEatCandidates', () => {
  test('builds candidates from restaurantData', () => {
    const cands = justEatCandidates(jeListing);
    expect(cands).toHaveLength(4);
    const wc = cands.find((c) => c.id === '81738');
    expect(wc.name).toBe('KFC Whitechapel');
    expect(wc.label).toBe('84 Whitechapel High Street');
    expect(wc.distance).toBeCloseTo(912 / 1609.344); // ~0.567 miles
    expect(wc.menuUrl).toBe('/restaurants-kfc-whitechapelaldgate/menu');
  });
  // The area listing's per-branch deliveryFees is postcode-adjusted — it is what
  // the basket actually charges (menu/dynamic bands are the branch's base fee;
  // live: Popeyes Whitechapel dynamic said £0.59 while both the listing for the
  // user's postcode and the basket said £0.79). Single-band fees are exact.
  test('extracts the postcode-adjusted delivery fee (pounds, min/max/bands)', () => {
    const cands = justEatCandidates(jeListing);
    const wc = cands.find((c) => c.id === '81738');
    expect(wc.listedDeliveryFee).toEqual({ min: 0.79, max: 0.79, numBands: 1 });
    const bg = cands.find((c) => c.id === '73853');
    expect(bg.listedDeliveryFee).toEqual({ min: 0.49, max: 1.49, numBands: 2 });
  });
  test('a record without deliveryFees yields a null listedDeliveryFee', () => {
    const cands = justEatCandidates(jeListing);
    const other = cands.find((c) => c.id === '132');
    expect(other.listedDeliveryFee).toBeNull();
  });
  // StampCard participation is published per-branch as a typed enum in the area
  // listing, with no login (live 2026-08-02: 824 of 1834 branches at one E1
  // postcode). Checked against the authenticated stampcards/status endpoint's
  // `optInDate != null` over a 24-branch sample: 24/24 agreement, so the listing
  // alone decides eligibility. Do NOT read that endpoint's `offerInformation`
  // instead — it returns the same default 5/10% for branches that are not in the
  // scheme at all, and non-participants answer 200 rather than 404.
  test('flags branches whose deals include a StampCard', () => {
    const cands = justEatCandidates(jeListing);
    expect(cands.find((c) => c.id === '132').earnsStampCard).toBe(true);
    expect(cands.find((c) => c.id === '73853').earnsStampCard).toBe(true);
  });
  test('a branch with only non-StampCard deals is not flagged', () => {
    const cands = justEatCandidates(jeListing);
    expect(cands.find((c) => c.id === '81738').earnsStampCard).toBe(false);
  });
  test('a record without deals at all is not flagged', () => {
    const cands = justEatCandidates(jeListing);
    expect(cands.find((c) => c.id === '67207').earnsStampCard).toBe(false);
  });
  test('matches end-to-end through selectNearestBranches', () => {
    // KFC branches sorted by distance: Whitechapel (912m) < Bishopsgate (1562m)
    // < Hackney (3162m); the Aniseed Bar entry is a different chain.
    const out = selectNearestBranches(justEatCandidates(jeListing), 'KFC', 2);
    expect(out.map((b) => b.id)).toEqual(['81738', '73853']);
  });
});
