const { uberCompositionDefaults, uberRemovals } = require('../src/shared/uber-composition');
const bigMac = require('./fixtures/ubereats-item-bigmac.json');

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
    // The fixture carries "Big Mac® Comes With" twice (Large meal + plain item)
    // with identical options; one merged entry is the right answer.
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

  test('handles empty and junk input without throwing', () => {
    expect(uberRemovals([], defaults())).toEqual([]);
    expect(uberRemovals(null, defaults())).toEqual([]);
    expect(uberRemovals(row('Sauce'), new Map())).toEqual([]);
  });
});
