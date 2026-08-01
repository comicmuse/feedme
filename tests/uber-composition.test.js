const { uberCompositionDefaults } = require('../src/shared/uber-composition');
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
