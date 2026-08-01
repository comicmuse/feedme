const { uberCompositionDefaults, uberRemovals, uberCartItemIds, normalizeTitle } = require('../src/shared/uber-composition');
const bigMac = require('./fixtures/ubereats-item-bigmac.json');
const drafts = require('./fixtures/ubereats-draft-orders.json');

describe('uberCompositionDefaults', () => {
  test('finds a "Comes With" group nested under childCustomizationList', () => {
    const defaults = uberCompositionDefaults(bigMac);
    expect([...defaults.keys()]).toEqual(['Big Mac® Comes With']);
  });

  test('records each default option with its defaultQuantity', () => {
    const group = uberCompositionDefaults(bigMac).get('Big Mac® Comes With');
    expect([...group.entries()]).toEqual([
      ['Sauce', 1], ['Pickles', 1], ['Lettuce', 1], ['Onions', 1],
      ['Cheese', 1], ['Beef Patty', 2], ['Bun', 1],
    ]);
  });

  test('ignores non-composition groups (Additions, Select Option, Meal Add On)', () => {
    const defaults = uberCompositionDefaults(bigMac);
    expect(defaults.has('Big Mac® Additions')).toBe(false);
    expect(defaults.has('Select Option')).toBe(false);
    expect(defaults.has('Meal Add On')).toBe(false);
  });

  test('keeps only options that are actually defaults (defaultQuantity >= 1)', () => {
    const detail = { data: { customizationsList: [{
      title: 'Wrap Comes With', options: [
        { title: 'Lettuce', defaultQuantity: 1 },
        { title: 'Jalapenos', defaultQuantity: 0 },
      ],
    }] } };
    expect([...uberCompositionDefaults(detail).get('Wrap Comes With').keys()]).toEqual(['Lettuce']);
  });

  test('merges the same group title repeated across meal branches', () => {
    // This fixture is trimmed to two of the live response's size branches, and
    // so carries "Big Mac® Comes With" twice (Large meal + plain item) with
    // identical options; one merged entry is the right answer.
    expect(uberCompositionDefaults(bigMac).get('Big Mac® Comes With').size).toBe(7);
  });

  test('drops a group title whose defaults genuinely conflict rather than guessing', () => {
    const detail = { data: { customizationsList: [
      { title: 'Burger Comes With', options: [{ title: 'Cheese', defaultQuantity: 1 }] },
      { title: 'Burger Comes With', options: [{ title: 'Cheese', defaultQuantity: 2 }] },
    ] } };
    expect(uberCompositionDefaults(detail).has('Burger Comes With')).toBe(false);
  });

  test('accepts the inner data object as well as the response envelope', () => {
    expect(uberCompositionDefaults(bigMac.data).get('Big Mac® Comes With').size).toBe(7);
  });

  test('returns an empty map for junk input', () => {
    expect(uberCompositionDefaults(null).size).toBe(0);
    expect(uberCompositionDefaults({}).size).toBe(0);
  });
});

describe('uberRemovals', () => {
  const defaults = () => uberCompositionDefaults(bigMac);
  const row = (name) => [{ group: 'Big Mac® Comes With', name }];

  test('a removed ingredient becomes a decline option in a "Remove" group', () => {
    const kept = 'Sauce, Lettuce, Onions, Cheese, 2 Beef Patty, Bun';
    expect(uberRemovals(row(kept), defaults())).toEqual([
      { group: 'Remove', name: 'No Pickles', price: 0 },
    ]);
  });

  test('every default kept yields no removals', () => {
    const kept = 'Sauce, Pickles, Lettuce, Onions, Cheese, 2 Beef Patty, Bun';
    expect(uberRemovals(row(kept), defaults())).toEqual([]);
  });

  test('several removals come back in the group\'s own order', () => {
    const kept = 'Sauce, Lettuce, Cheese, 2 Beef Patty, Bun';
    expect(uberRemovals(row(kept), defaults())).toEqual([
      { group: 'Remove', name: 'No Pickles', price: 0 },
      { group: 'Remove', name: 'No Onions', price: 0 },
    ]);
  });

  test('a quantity prefix is stripped so "2 Beef Patty" matches the "Beef Patty" default', () => {
    // Without stripping, the kept entry would not match and the patties would
    // be reported as removed. This is the only test that isolates that step.
    const defs = new Map([['Burger Comes With', new Map([['Beef Patty', 2]])]]);
    expect(uberRemovals([{ group: 'Burger Comes With', name: '2 Beef Patty' }], defs)).toEqual([]);
  });

  test('a default whose own name starts with a digit still matches itself', () => {
    // "4 Chicken McNuggets®" is a real Uber option title: stripping alone would
    // turn it into "Chicken McNuggets®", miss the default, and invent a removal.
    const defs = new Map([['Meal Comes With', new Map([['4 Chicken McNuggets®', 1]])]]);
    expect(uberRemovals([{ group: 'Meal Comes With', name: '4 Chicken McNuggets®' }], defs)).toEqual([]);
  });

  test('a quantity reduced but not to zero emits nothing (no target models it)', () => {
    // Beef Patty default 2, kept 1: still present, so not a removal.
    const kept = 'Sauce, Pickles, Lettuce, Onions, Cheese, Beef Patty, Bun';
    expect(uberRemovals(row(kept), defaults())).toEqual([]);
  });

  test('an unknown group yields nothing rather than declining every default', () => {
    const rows = [{ group: 'Side Salad Comes With', name: 'Cucumber, Tomato' }];
    expect(uberRemovals(rows, defaults())).toEqual([]);
  });

  test('a kept list split across two rows is one list, not two partial ones', () => {
    // The cart parser can emit more than one value span for a single group
    // label, so the kept defaults arrive split. Diffing each half against the
    // full defaults would decline every ingredient missing from that half —
    // seven bogus removals for an item the user never touched (#33 review).
    const rows = [
      { group: 'Big Mac® Comes With', name: 'Sauce, Pickles' },
      { group: 'Big Mac® Comes With', name: 'Lettuce, Onions, Cheese, 2 Beef Patty, Bun' },
    ];
    expect(uberRemovals(rows, defaults())).toEqual([]);
  });

  test('a split kept list still reports a genuine removal exactly once', () => {
    const rows = [
      { group: 'Big Mac® Comes With', name: 'Sauce' },
      { group: 'Big Mac® Comes With', name: 'Lettuce, Onions, Cheese, 2 Beef Patty, Bun' },
    ];
    expect(uberRemovals(rows, defaults())).toEqual([
      { group: 'Remove', name: 'No Pickles', price: 0 },
    ]);
  });

  test('a kept entry matching no default silences that whole group', () => {
    // "Pickle" vs the catalogue's "Pickles" means the two sides do not name
    // ingredients identically, so every absence is suspect. Prefer honest
    // incompleteness (no removals) over inventing "No Pickles" (#33 review).
    const rows = [{
      group: 'Big Mac® Comes With',
      name: 'Sauce, Pickle, Lettuce, Onions, Cheese, 2 Beef Patty, Bun',
    }];
    expect(uberRemovals(rows, defaults())).toEqual([]);
  });

  test('an unrecognised entry silences only its own group', () => {
    const defs = new Map([
      ['Burger Comes With', new Map([['Cheese', 1], ['Pickles', 1]])],
      ['Wrap Comes With', new Map([['Lettuce', 1], ['Mayo', 1]])],
    ]);
    const rows = [
      { group: 'Burger Comes With', name: 'Cheese, Gherkin' },
      { group: 'Wrap Comes With', name: 'Lettuce' },
    ];
    expect(uberRemovals(rows, defs)).toEqual([
      { group: 'Remove', name: 'No Mayo', price: 0 },
    ]);
  });

  test('group titles are matched after case and whitespace normalisation', () => {
    const defs = new Map([['Burger  Comes With', new Map([['Cheese', 1], ['Pickles', 1]])]]);
    expect(uberRemovals([{ group: 'burger comes with', name: 'Cheese' }], defs)).toEqual([
      { group: 'Remove', name: 'No Pickles', price: 0 },
    ]);
  });

  test('handles empty and junk input without throwing', () => {
    expect(uberRemovals([], defaults())).toEqual([]);
    expect(uberRemovals(null, defaults())).toEqual([]);
    expect(uberRemovals(row('Sauce'), new Map())).toEqual([]);
  });
});

describe('uberCartItemIds', () => {
  test('indexes every cart line across every draft order by normalised title', () => {
    const ids = uberCartItemIds(drafts.data.draftOrders);
    expect([...ids.keys()].sort()).toEqual(['big arch® with bacon', 'big mac®', 'whopper']);
  });

  test('carries the four ids getMenuItemV1 needs', () => {
    expect(uberCartItemIds(drafts.data.draftOrders).get('big mac®')).toEqual({
      storeUuid: '7c0b936e-53cc-4f7b-9558-b41691071f19',
      sectionUuid: '82a88175-4085-50b2-9ac1-9cfda241af83',
      subsectionUuid: '6af6e4d6-c531-53d8-bb5f-82109718d392',
      itemUuid: '436063f7-19ba-5d0f-ba15-137deab02561',
    });
  });

  test('the same title in two lines is one entry, not an ambiguity', () => {
    // Two Big Mac lines with different removals share one item, so the second
    // occurrence must not knock the entry out.
    const twice = [{ shoppingCart: { items: [
      ...drafts.data.draftOrders[0].shoppingCart.items,
      { ...drafts.data.draftOrders[0].shoppingCart.items[0], shoppingCartItemUuid: 'line-1b' },
    ] } }];
    expect(uberCartItemIds(twice).has('big mac®')).toBe(true);
  });

  test('a title genuinely pointing at two different items is dropped', () => {
    const conflicting = [{ shoppingCart: { items: [
      drafts.data.draftOrders[0].shoppingCart.items[0],
      { ...drafts.data.draftOrders[0].shoppingCart.items[0], uuid: 'different-item-uuid' },
    ] } }];
    expect(uberCartItemIds(conflicting).has('big mac®')).toBe(false);
  });

  test('a line missing any id is skipped rather than half-indexed', () => {
    const partial = [{ shoppingCart: { items: [
      { uuid: 'x', storeUuid: 'y', title: 'Half Item' },
    ] } }];
    expect(uberCartItemIds(partial).size).toBe(0);
  });

  test('handles junk input without throwing', () => {
    expect(uberCartItemIds(null).size).toBe(0);
    expect(uberCartItemIds([{}]).size).toBe(0);
  });
});

describe('normalizeTitle', () => {
  test('lowercases and collapses whitespace so img alt text matches cart titles', () => {
    expect(normalizeTitle('  Big   Mac®  ')).toBe('big mac®');
    expect(normalizeTitle(null)).toBe('');
  });
});
