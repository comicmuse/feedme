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
  test('matches end-to-end through selectNearestBranches', () => {
    // KFC branches sorted by distance: Whitechapel (912m) < Bishopsgate (1562m)
    // < Hackney (3162m); the Aniseed Bar entry is a different chain.
    const out = selectNearestBranches(justEatCandidates(jeListing), 'KFC', 2);
    expect(out.map((b) => b.id)).toEqual(['81738', '73853']);
  });
});
