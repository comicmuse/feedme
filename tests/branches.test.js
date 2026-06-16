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

const { justEatCandidates } = require('../src/shared/branches');
const jeListing = require('./fixtures/just-eat-listing.json');

describe('justEatCandidates', () => {
  test('builds candidates from restaurantData', () => {
    const cands = justEatCandidates(jeListing);
    expect(cands).toHaveLength(3);
    const wc = cands.find((c) => c.id === 'burger-king-whitechapel');
    expect(wc.name).toBe('Burger King');
    expect(wc.label).toBe('Whitechapel');
    expect(wc.distance).toBeCloseTo(0.4);
    expect(wc.menuUrl).toBe('/restaurants-burger-king-whitechapel/menu');
  });
  test('matches end-to-end through selectNearestBranches', () => {
    const out = selectNearestBranches(justEatCandidates(jeListing), 'Burger King', 3);
    expect(out.map((b) => b.id)).toEqual(['burger-king-whitechapel', 'burger-king-aldgate']);
  });
});
