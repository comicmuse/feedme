const { matchItems, computeTotal, estimateUberFees } = require('../src/shared/matcher');

describe('estimateUberFees', () => {
  test('derives the service-fee percentage and delivery fee from the live cart', () => {
    const order = { items: [{ unitPrice: 5, quantity: 2 }], deliveryFee: 0.99, serviceFee: 1.5, checkoutTotal: 12.49, discounts: [] };
    const est = estimateUberFees(order);
    expect(est.deliveryFee).toBeCloseTo(0.99);
    expect(est.serviceFeePct).toBeCloseTo(0.15); // 1.5 / 10
  });

  test('falls back to the checkout total when per-item prices are unknown', () => {
    const order = { items: [{ unitPrice: 0, quantity: 1 }], deliveryFee: 1, serviceFee: 2, checkoutTotal: 23, discounts: [] };
    const est = estimateUberFees(order); // subtotal = 23 - 1 - 2 = 20 -> pct = 0.1
    expect(est.serviceFeePct).toBeCloseTo(0.1);
  });

  test('no divide-by-zero when subtotal is unknown', () => {
    const est = estimateUberFees({ items: [], deliveryFee: 0, serviceFee: 0, checkoutTotal: 0, discounts: [] });
    expect(est.serviceFeePct).toBe(0);
  });
});

const PLATFORM_ITEMS = [
  { name: 'Whopper', description: 'Flame-grilled beef burger', unitPrice: 5.89 },
  { name: 'Double Whopper', description: 'Two flame-grilled patties', unitPrice: 7.89 },
  { name: 'Large Fries', description: 'Seasoned shoestring fries', unitPrice: 3.19 },
  { name: 'Coca-Cola Large', description: '330ml drink', unitPrice: 2.49 },
];

describe('matchItems', () => {
  test('matches exact name', () => {
    const ref = [{ name: 'Whopper', quantity: 1, unitPrice: 5.49 }];
    const [result] = matchItems(ref, PLATFORM_ITEMS);
    expect(result.matched).toBe(true);
    expect(result.platformItem.name).toBe('Whopper');
  });

  test('matches near-identical name (case difference)', () => {
    const ref = [{ name: 'large fries', quantity: 1, unitPrice: 2.99 }];
    const [result] = matchItems(ref, PLATFORM_ITEMS);
    expect(result.matched).toBe(true);
    expect(result.platformItem.name).toBe('Large Fries');
  });

  test('returns unmatched for item well outside threshold', () => {
    const ref = [{ name: 'Vegan Artisan Flatbread', quantity: 1, unitPrice: 9.00 }];
    const [result] = matchItems(ref, PLATFORM_ITEMS);
    expect(result.matched).toBe(false);
    expect(result.platformItem).toBeNull();
  });

  test('treats a name match with no usable price as unmatched', () => {
    const ref = [{ name: 'Whopper', quantity: 1, unitPrice: 5.49 }];
    const [result] = matchItems(ref, [{ name: 'Whopper', description: 'combo builder', unitPrice: 0 }]);
    expect(result.matched).toBe(false);
    expect(result.platformItem).toBeNull();
  });

  test('prefers a priced duplicate over a £0 entry of the same name', () => {
    const ref = [{ name: 'Honey BBQ Wrap', quantity: 1, unitPrice: 8.29 }];
    const platform = [
      { name: 'Honey BBQ Wrap', description: 'combo builder', unitPrice: 0 },
      { name: 'Honey BBQ Wrap', description: '', unitPrice: 8.29 },
    ];
    const [result] = matchItems(ref, platform);
    expect(result.matched).toBe(true);
    expect(result.platformItem.unitPrice).toBeCloseTo(8.29);
  });

  test('prefers the plain item over a meal/combo of the same words', () => {
    const ref = [{ name: 'Chicken Sandwich', quantity: 1, unitPrice: 6.99 }];
    const platform = [
      { name: 'Chicken Sandwich Meal for 2', description: '', unitPrice: 26.99 },
      { name: 'Chicken Sandwich', description: '', unitPrice: 6.99 },
    ];
    const [result] = matchItems(ref, platform);
    expect(result.matched).toBe(true);
    expect(result.platformItem.name).toBe('Chicken Sandwich');
  });

  test('still matches a combo when the reference item is itself a combo', () => {
    const ref = [{ name: 'Family Bundle Box', quantity: 1, unitPrice: 20 }];
    const platform = [{ name: 'Family Bundle Box', description: '', unitPrice: 19.99 }];
    const [result] = matchItems(ref, platform);
    expect(result.matched).toBe(true);
    expect(result.platformItem.unitPrice).toBeCloseTo(19.99);
  });

  test('prices an option at the platform\'s own modifier price (exact, not estimated)', () => {
    const ref = [{
      name: 'Honey BBQ Sandwich', quantity: 1, unitPrice: 12.68,
      options: [{ name: 'Regular Fries', price: 2.69 }], optionsTotal: 2.69,
    }];
    const platform = [{
      name: 'Honey BBQ Sandwich', description: '', unitPrice: 9.99,
      modifiers: [{ name: 'Regular Fries', price: 2.50 }, { name: 'Large Fries', price: 3.59 }],
    }];
    const [result] = matchItems(ref, platform);
    expect(result.platformItem.unitPrice).toBeCloseTo(12.49); // 9.99 + platform's own 2.50
    expect(result.platformItem.optionsEstimated).toBe(false);
  });

  test('falls back to the source option price (flagged) when the platform lacks the option', () => {
    const ref = [{
      name: 'Honey BBQ Sandwich', quantity: 1, unitPrice: 12.68,
      options: [{ name: 'Regular Fries', price: 2.69 }], optionsTotal: 2.69,
    }];
    const platform = [{ name: 'Honey BBQ Sandwich', description: '', unitPrice: 9.99, modifiers: [] }];
    const [result] = matchItems(ref, platform);
    expect(result.platformItem.unitPrice).toBeCloseTo(12.68); // 9.99 + source 2.69
    expect(result.platformItem.optionsEstimated).toBe(true);
  });

  test('falls back to the options sum when no option names were captured', () => {
    const ref = [{ name: 'Honey BBQ Sandwich', quantity: 1, unitPrice: 12.68, optionsTotal: 2.69 }];
    const platform = [{ name: 'Honey BBQ Sandwich', description: '', unitPrice: 9.99 }];
    const [result] = matchItems(ref, platform);
    expect(result.platformItem.unitPrice).toBeCloseTo(12.68);
    expect(result.platformItem.optionsEstimated).toBe(true);
  });

  test('leaves the matched price unchanged when there are no options', () => {
    const ref = [{ name: 'Large Fries', quantity: 1, unitPrice: 4.59, optionsTotal: 0 }];
    const platform = [{ name: 'Large Fries', description: '', unitPrice: 4.59 }];
    const [result] = matchItems(ref, platform);
    expect(result.platformItem.unitPrice).toBeCloseTo(4.59);
    expect(result.platformItem.optionsEstimated).toBeUndefined();
  });
});

// Uber models size upgrades as a modifier on the base item ("Select Option:
// Big Mac® FIFA World Cup™ Large Meal (£1.10)" on the Medium item), while other
// platforms list each size as its own item. A selected option whose name equals
// the reference item's name up to size words IS the reference item in another
// size — retarget the line to that item when the platform lists it (issue #28).
describe('matchItems variant retargeting (size upgrades)', () => {
  const mcd = () => [
    {
      id: 'je-med', name: 'Big Mac® FIFA World Cup™ Medium Meal', description: '', unitPrice: 10.09,
      modifiers: [
        { name: 'Side Salad', price: 0, id: 'm-salad', groupId: 'g-ms', group: 'Medium Side' },
        { name: '4 Chicken McNuggets®', price: 2.59, id: 'm-nug', groupId: 'g-ma', group: 'Meal Add On' },
      ],
    },
    {
      id: 'je-lrg', name: 'Big Mac® FIFA World Cup™ Large Meal', description: '', unitPrice: 11.19,
      modifiers: [
        { name: 'Side Salad', price: 0, id: 'l-salad', groupId: 'g-ls', group: 'Large Side' },
        { name: '4 Chicken McNuggets®', price: 2.59, id: 'l-nug', groupId: 'g-la', group: 'Meal Add On' },
      ],
    },
    // a standalone item sharing an add-on option's exact name must never steal the line
    { id: 'je-nug', name: '4 Chicken McNuggets®', description: '', unitPrice: 3.99, modifiers: [] },
  ];

  test('retargets the line to the upgraded size item and drops the upgrade option', () => {
    const ref = [{
      name: 'Big Mac® FIFA World Cup™ Medium Meal', quantity: 1, unitPrice: 14.78,
      options: [
        { group: 'Select Option', name: 'Big Mac® FIFA World Cup™ Large Meal', price: 1.10 },
        { group: 'Large Side', name: 'Side Salad', price: 0 },
        { group: 'Meal Add On', name: '4 Chicken McNuggets®', price: 2.59 },
      ],
    }];
    const [result] = matchItems(ref, mcd());
    expect(result.platformItem.name).toBe('Big Mac® FIFA World Cup™ Large Meal');
    // Large's own base price + its own option prices; the £1.10 upgrade is gone.
    expect(result.platformItem.unitPrice).toBeCloseTo(11.19 + 2.59);
    expect(result.platformItem.optionsEstimated).toBeFalsy();
    expect(result.basketLine).toMatchObject({ id: 'je-lrg', name: 'Big Mac® FIFA World Cup™ Large Meal', prefillable: true });
    expect(result.basketLine.modifiers).toEqual([
      expect.objectContaining({ id: 'l-salad' }),
      expect.objectContaining({ id: 'l-nug' }),
    ]);
  });

  test('falls back to the base item when the platform has no upgraded-size item', () => {
    const items = mcd().filter((i) => i.id !== 'je-lrg');
    const ref = [{
      name: 'Big Mac® FIFA World Cup™ Medium Meal', quantity: 1, unitPrice: 14.78,
      options: [
        { group: 'Select Option', name: 'Big Mac® FIFA World Cup™ Large Meal', price: 1.10 },
        { group: 'Meal Add On', name: '4 Chicken McNuggets®', price: 2.59 },
      ],
    }];
    const [result] = matchItems(ref, items);
    expect(result.platformItem.name).toBe('Big Mac® FIFA World Cup™ Medium Meal');
    // upgrade option unresolved: source price carried, flagged estimated, manual line
    expect(result.platformItem.unitPrice).toBeCloseTo(10.09 + 1.10 + 2.59);
    expect(result.platformItem.optionsEstimated).toBe(true);
    expect(result.basketLine.prefillable).toBe(false);
  });

  test('an add-on option that names another catalogue item does not retarget the line', () => {
    const ref = [{
      name: 'Big Mac® FIFA World Cup™ Medium Meal', quantity: 1, unitPrice: 12.68,
      options: [{ group: 'Meal Add On', name: '4 Chicken McNuggets®', price: 2.59 }],
    }];
    const [result] = matchItems(ref, mcd());
    expect(result.platformItem.name).toBe('Big Mac® FIFA World Cup™ Medium Meal');
    expect(result.basketLine.modifiers).toEqual([expect.objectContaining({ id: 'm-nug' })]);
  });

  test('a source without size-variant options is untouched (no upgrade detected)', () => {
    const ref = [{
      name: 'Big Mac® FIFA World Cup™ Medium Meal', quantity: 1, unitPrice: 10.09,
      options: [{ group: 'Medium Side', name: 'Side Salad', price: 0 }],
    }];
    const [result] = matchItems(ref, mcd());
    expect(result.platformItem.name).toBe('Big Mac® FIFA World Cup™ Medium Meal');
    expect(result.basketLine.prefillable).toBe(true);
  });
});

describe('matchItems basketLine (for scripted basket pre-fill)', () => {
  test('carries the platform item id and quantity, prefillable when no options', () => {
    const ref = [{ name: 'Whopper', quantity: 2, unitPrice: 5.49 }];
    const platform = [{ id: 'dr-1', name: 'Whopper', description: '', unitPrice: 5.89, modifiers: [] }];
    const [result] = matchItems(ref, platform);
    expect(result.basketLine).toMatchObject({ id: 'dr-1', quantity: 2, modifiers: [], prefillable: true });
  });

  test('resolves a selected option to the platform modifier id/groupId', () => {
    const ref = [{
      name: 'Honey BBQ Sandwich', quantity: 1, unitPrice: 12.68,
      options: [{ name: 'Regular Fries', price: 2.69 }], optionsTotal: 2.69,
    }];
    const platform = [{
      id: 'dr-9', name: 'Honey BBQ Sandwich', description: '', unitPrice: 9.99,
      modifiers: [{ name: 'Regular Fries', price: 2.50, id: 'opt-1', groupId: 'mg-1' }],
    }];
    const [result] = matchItems(ref, platform);
    expect(result.basketLine.prefillable).toBe(true);
    expect(result.basketLine.modifiers).toEqual([{ id: 'opt-1', groupId: 'mg-1', group: '', name: 'Regular Fries' }]);
  });

  test('resolves repeated option names to distinct groups (No Thanks x2)', () => {
    const reference = [{
      name: 'Box Meal', quantity: 1, unitPrice: 13.29, optionsTotal: 0,
      options: [
        { group: 'Add a Side?', name: 'No Thanks', price: 0 },
        { group: 'Add a Shake?', name: 'No Thanks', price: 0 },
      ],
    }];
    const platform = [{
      id: 'je-1', name: 'Box Meal', description: '', unitPrice: 13.29,
      modifiers: [
        { name: 'No Thanks', price: 0, id: 'side-no', groupId: 'gs', group: 'Add a Side?' },
        { name: 'Fries',     price: 0, id: 'side-fr', groupId: 'gs', group: 'Add a Side?' },
        { name: 'No Thanks', price: 0, id: 'shake-no', groupId: 'gk', group: 'Add a Shake?' },
        { name: 'Oreo Shake', price: 3, id: 'shake-or', groupId: 'gk', group: 'Add a Shake?' },
      ],
    }];
    const [result] = matchItems(reference, platform);
    expect(result.basketLine.prefillable).toBe(true);
    expect(result.basketLine.modifiers).toEqual([
      { id: 'side-no', groupId: 'gs', group: 'Add a Side?', name: 'No Thanks' },
      { id: 'shake-no', groupId: 'gk', group: 'Add a Shake?', name: 'No Thanks' },
    ]);
    // Free options add nothing to the priced total.
    expect(result.platformItem.unitPrice).toBeCloseTo(13.29);
  });

  test('a paid option resolves to the paid platform modifier, not a free negation of the same words', () => {
    // Fuse ranks 'No Cheese' above 'Extra Cheese' for the query 'Cheese', so without
    // a price-band preference the paid selection is priced at £0 and the builder
    // would tick 'No Cheese' on the real basket.
    const ref = [{
      name: 'Whopper', quantity: 1, unitPrice: 6.99,
      options: [{ name: 'Cheese', price: 1.00 }], optionsTotal: 1.00,
    }];
    const platform = [{
      id: 'je-2', name: 'Whopper', description: '', unitPrice: 5.99,
      modifiers: [
        { name: 'No Cheese', price: 0, id: 'no-cheese' },
        { name: 'Extra Cheese', price: 1.00, id: 'extra-cheese' },
      ],
    }];
    const [result] = matchItems(ref, platform);
    expect(result.basketLine.modifiers).toEqual([expect.objectContaining({ id: 'extra-cheese' })]);
    expect(result.platformItem.unitPrice).toBeCloseTo(6.99); // 5.99 + the platform's own £1.00
  });

  // Live regression (McDonald's JE, 2026-07-11): the user's "Salad Dressing
  // Choice: No Dressing" decline resolved to "Balsamic Dressing" — the group's
  // only (positive) option — and the builder added a dressing the user refused.
  // A decline means "select nothing": it may only resolve to another decline in
  // its own group, and an unresolvable decline is a clean skip, not a failure.
  test('a decline never resolves to a positive option — it skips cleanly', () => {
    const ref = [{
      name: 'Big Mac Meal', quantity: 1, unitPrice: 10.09, optionsTotal: 0,
      options: [{ group: 'Salad Dressing Choice', name: 'No Dressing', price: 0 }],
    }];
    const platform = [{
      id: 'je-9', name: 'Big Mac Meal', description: '', unitPrice: 10.09,
      modifiers: [
        { name: 'Balsamic Dressing', price: 0, id: 'balsamic', groupId: 'gd', group: 'Salad Dressing Choice' },
        // another group's decline must not be picked up via the full-pool retry
        { name: 'No Sauce', price: 0, id: 'no-sauce', groupId: 'gr', group: 'Remove' },
      ],
    }];
    const [result] = matchItems(ref, platform);
    expect(result.basketLine.modifiers).toEqual([]);
    expect(result.basketLine.prefillable).toBe(true); // skipping IS the decline
    expect(result.platformItem.unitPrice).toBeCloseTo(10.09);
  });

  test('a free positive option does not resolve to a decline of the same words', () => {
    const ref = [{
      name: 'Whopper', quantity: 1, unitPrice: 6.99, optionsTotal: 0,
      options: [{ name: 'Cheese', price: 0 }],
    }];
    const platform = [{
      id: 'je-10', name: 'Whopper', description: '', unitPrice: 5.99,
      modifiers: [{ name: 'No Cheese', price: 0, id: 'no-cheese' }],
    }];
    const [result] = matchItems(ref, platform);
    expect(result.basketLine.modifiers).toEqual([]);
    expect(result.basketLine.prefillable).toBe(false); // a real selection went unresolved
  });

  test('an option missing from its matched group falls back to the full modifier pool', () => {
    // Platforms group the same option differently — scoping must not turn a
    // present-but-elsewhere modifier into an unresolved (non-prefillable) line.
    const ref = [{
      name: 'Box Meal', quantity: 1, unitPrice: 13.29, optionsTotal: 3,
      options: [{ group: 'Add a Side?', name: 'Oreo Shake', price: 3 }],
    }];
    const platform = [{
      id: 'je-1', name: 'Box Meal', description: '', unitPrice: 13.29,
      modifiers: [
        { name: 'No Thanks', price: 0, id: 'side-no', groupId: 'gs', group: 'Add a Side?' },
        { name: 'Fries', price: 1, id: 'side-fr', groupId: 'gs', group: 'Add a Side?' },
        { name: 'Oreo Shake', price: 2.79, id: 'shake-or', groupId: 'gk', group: 'Add a Shake?' },
      ],
    }];
    const [result] = matchItems(ref, platform);
    expect(result.basketLine.prefillable).toBe(true);
    expect(result.basketLine.modifiers).toEqual([expect.objectContaining({ id: 'shake-or' })]);
    expect(result.platformItem.unitPrice).toBeCloseTo(16.08); // 13.29 + the platform's own 2.79
  });

  test('duplicate selections do not resolve to the same platform modifier twice', () => {
    // The builder can only tick a modifier once, so a second identical selection
    // must count as unresolved (honest manual-add) rather than silently pricing
    // and "filling" a modifier that ends up in the basket only once.
    const ref = [{
      name: 'Wrap Deal', quantity: 1, unitPrice: 10.99, optionsTotal: 1.98,
      options: [
        { name: 'The Big Ranch', price: 0.99 },
        { name: 'The Big Ranch', price: 0.99 },
      ],
    }];
    const platform = [{
      id: 'je-3', name: 'Wrap Deal', description: '', unitPrice: 9.5,
      modifiers: [{ name: 'The Big Ranch', price: 0.89, id: 'dip-ranch' }],
    }];
    const [result] = matchItems(ref, platform);
    expect(result.basketLine.modifiers).toEqual([expect.objectContaining({ id: 'dip-ranch' })]);
    expect(result.basketLine.prefillable).toBe(false);
    // First dup at the platform's own £0.89; the unresolved second falls back to
    // the source £0.99 and flags the total estimated.
    expect(result.platformItem.unitPrice).toBeCloseTo(11.38); // 9.5 + 0.89 + 0.99
    expect(result.platformItem.optionsEstimated).toBe(true);
  });

  test('is not prefillable when a selected option has no matching platform modifier', () => {
    const ref = [{
      name: 'Honey BBQ Sandwich', quantity: 1, unitPrice: 12.68,
      options: [{ name: 'Regular Fries', price: 2.69 }], optionsTotal: 2.69,
    }];
    const platform = [{ id: 'dr-9', name: 'Honey BBQ Sandwich', description: '', unitPrice: 9.99, modifiers: [] }];
    const [result] = matchItems(ref, platform);
    expect(result.basketLine.prefillable).toBe(false);
  });

  test('is not prefillable when the matched item carries no id (e.g. Uber JSON-LD)', () => {
    const ref = [{ name: 'Whopper', quantity: 1, unitPrice: 5.49 }];
    const platform = [{ name: 'Whopper', description: '', unitPrice: 5.89 }];
    const [result] = matchItems(ref, platform);
    expect(result.basketLine.prefillable).toBe(false);
    expect(result.basketLine.id).toBeUndefined();
  });

  test('unmatched lines carry no basketLine', () => {
    const ref = [{ name: 'Vegan Artisan Flatbread', quantity: 1, unitPrice: 9 }];
    const platform = [{ id: 'x', name: 'Whopper', unitPrice: 5.89 }];
    const [result] = matchItems(ref, platform);
    expect(result.basketLine).toBeNull();
  });

  test('returns one result per reference item', () => {
    const ref = [
      { name: 'Whopper', quantity: 1, unitPrice: 5.49 },
      { name: 'Large Fries', quantity: 2, unitPrice: 2.99 },
    ];
    expect(matchItems(ref, PLATFORM_ITEMS)).toHaveLength(2);
  });

  test('preserves reference item in result', () => {
    const ref = [{ name: 'Whopper', quantity: 3, unitPrice: 5.49 }];
    const [result] = matchItems(ref, PLATFORM_ITEMS);
    expect(result.referenceItem.quantity).toBe(3);
  });
});

describe('computeTotal', () => {
  test('sums matched items times quantity, adds fees, subtracts discounts', () => {
    const matches = [
      { referenceItem: { quantity: 1 }, platformItem: { unitPrice: 5.89 }, matched: true },
      { referenceItem: { quantity: 2 }, platformItem: { unitPrice: 3.19 }, matched: true },
    ];
    // items: 5.89 + 6.38 = 12.27; + 1.99 delivery + 1.50 service - 2.00 discount = 13.76
    const result = computeTotal(matches, 1.99, 1.50, [{ amount: 2.00, label: '20% off' }]);
    expect(result.itemsTotal).toBeCloseTo(12.27);
    expect(result.total).toBeCloseTo(13.76);
    expect(result.discountTotal).toBeCloseTo(2.00);
    expect(result.matchedCount).toBe(2);
    expect(result.totalCount).toBe(2);
  });

  test('applies a free-delivery offer when the spend threshold is met', () => {
    const matches = [{ referenceItem: { quantity: 1 }, platformItem: { unitPrice: 16.00 }, matched: true }];
    const offers = [{ type: 'free-delivery', minSpend: 15 }];
    const result = computeTotal(matches, 1.29, 0, offers);
    expect(result.deliveryFee).toBe(0);
    expect(result.total).toBeCloseTo(16.00);
  });

  test('does not apply an offer below its spend threshold', () => {
    const matches = [{ referenceItem: { quantity: 1 }, platformItem: { unitPrice: 10.00 }, matched: true }];
    const offers = [{ type: 'free-delivery', minSpend: 15 }];
    const result = computeTotal(matches, 1.29, 0, offers);
    expect(result.deliveryFee).toBeCloseTo(1.29);
  });

  test('applies a capped percentage offer as a discount', () => {
    const matches = [{ referenceItem: { quantity: 1 }, platformItem: { unitPrice: 22.87 }, matched: true }];
    // 20% of 22.87 = 4.57, capped at 10 -> 4.57 discount
    const offers = [{ type: 'percent', minSpend: 15, percent: 0.20, cap: 10 }];
    const result = computeTotal(matches, 0, 0, offers);
    expect(result.discountTotal).toBeCloseTo(4.574);
    expect(result.total).toBeCloseTo(18.296);
  });

  test('caps a large percentage discount', () => {
    const matches = [{ referenceItem: { quantity: 1 }, platformItem: { unitPrice: 80.00 }, matched: true }];
    const offers = [{ type: 'percent', minSpend: 15, percent: 0.20, cap: 10 }];
    const result = computeTotal(matches, 0, 0, offers);
    expect(result.discountTotal).toBeCloseTo(10);
  });

  test('excludes unmatched items from total', () => {
    const matches = [
      { referenceItem: { quantity: 1 }, platformItem: { unitPrice: 5.89 }, matched: true },
      { referenceItem: { quantity: 1 }, platformItem: null, matched: false },
    ];
    const result = computeTotal(matches, 0, 0, []);
    expect(result.itemsTotal).toBeCloseTo(5.89);
    expect(result.matchedCount).toBe(1);
    expect(result.totalCount).toBe(2);
  });

  test('handles zero fees and empty discounts', () => {
    const matches = [
      { referenceItem: { quantity: 1 }, platformItem: { unitPrice: 10.00 }, matched: true },
    ];
    const result = computeTotal(matches, 0, 0, []);
    expect(result.total).toBeCloseTo(10.00);
    expect(result.discountTotal).toBe(0);
    expect(result.serviceFeeEstimated).toBe(false);
  });

  test('derives service fee as a percentage of subtotal, flagged when estimated', () => {
    const matches = [
      { referenceItem: { quantity: 1 }, platformItem: { unitPrice: 16.70 }, matched: true },
    ];
    const result = computeTotal(matches, 0, 0, [], { serviceFeePct: 0.11, serviceFeeMax: 3.49, serviceFeeEstimated: true });
    expect(result.serviceFee).toBeCloseTo(1.84); // 16.70 * 0.11
    expect(result.serviceFeeEstimated).toBe(true);
    expect(result.total).toBeCloseTo(18.54);
  });

  test('caps the percentage service fee at the max', () => {
    const matches = [
      { referenceItem: { quantity: 1 }, platformItem: { unitPrice: 100.00 }, matched: true },
    ];
    const result = computeTotal(matches, 0, 0, [], { serviceFeePct: 0.11, serviceFeeMax: 2.99 });
    expect(result.serviceFee).toBeCloseTo(2.99);
  });

  test('floors the percentage service fee at the min (Just Eat exact, not estimated)', () => {
    const matches = [
      { referenceItem: { quantity: 1 }, platformItem: { unitPrice: 4.00 }, matched: true },
    ];
    // 4.00 * 0.11 = 0.44, below the £0.99 floor
    const result = computeTotal(matches, 0, 0, [], { serviceFeePct: 0.11, serviceFeeMin: 0.99, serviceFeeMax: 2.99, serviceFeeEstimated: false });
    expect(result.serviceFee).toBeCloseTo(0.99);
    expect(result.serviceFeeEstimated).toBe(false);
  });

  test('prefers a scraped flat service fee over the percentage', () => {
    const matches = [
      { referenceItem: { quantity: 1 }, platformItem: { unitPrice: 16.70 }, matched: true },
    ];
    const result = computeTotal(matches, 0, 2.00, [], { serviceFeePct: 0.11, serviceFeeMax: 3.49 });
    expect(result.serviceFee).toBeCloseTo(2.00);
    expect(result.serviceFeeEstimated).toBe(false);
  });

  // Just Eat delivery fees are banded by basket subtotal (higher spend -> cheaper),
  // so the applicable fee is the band with the highest threshold the subtotal meets.
  describe('basket-dependent delivery fee bands', () => {
    const bands = [
      { minSubtotal: 0, fee: 3.99 },
      { minSubtotal: 10, fee: 1.99 },
    ];
    test('selects the cheaper band once the subtotal reaches its threshold', () => {
      const matches = [{ referenceItem: { quantity: 1 }, platformItem: { unitPrice: 12.00 }, matched: true }];
      const result = computeTotal(matches, 0, 0, [], { deliveryFeeBands: bands });
      expect(result.deliveryFee).toBeCloseTo(1.99);
      expect(result.total).toBeCloseTo(13.99);
    });
    test('uses the base band when the subtotal is below the next threshold', () => {
      const matches = [{ referenceItem: { quantity: 1 }, platformItem: { unitPrice: 8.00 }, matched: true }];
      const result = computeTotal(matches, 0, 0, [], { deliveryFeeBands: bands });
      expect(result.deliveryFee).toBeCloseTo(3.99);
    });
    test('a free-delivery offer still overrides the selected band', () => {
      const matches = [{ referenceItem: { quantity: 1 }, platformItem: { unitPrice: 12.00 }, matched: true }];
      const result = computeTotal(matches, 0, 0, [{ type: 'free-delivery', minSpend: 10 }], { deliveryFeeBands: bands });
      expect(result.deliveryFee).toBe(0);
    });
    test('falls back to the flat delivery fee when no bands are given', () => {
      const matches = [{ referenceItem: { quantity: 1 }, platformItem: { unitPrice: 12.00 }, matched: true }];
      const result = computeTotal(matches, 2.50, 0, []);
      expect(result.deliveryFee).toBeCloseTo(2.50);
    });
  });

  // Just Eat's small-order fee is a flat SmallOrderFee.MaxAmount charged when the
  // subtotal is at or below a threshold — inclusive at the boundary (live capture
  // 2026-07-11, McDonald's Bow: £2 charged at a £10.00 subtotal, none at £10.50).
  // The bag fee is a flat per-order charge.
  describe('Just Eat bag and small-order fees', () => {
    const basket = (price) => [{ referenceItem: { quantity: 1 }, platformItem: { unitPrice: price }, matched: true }];
    const jeFees = { serviceFeePct: 0.11, serviceFeeMin: 0.99, serviceFeeMax: 2.99, smallOrderFeeMax: 2.00, smallOrderFeeThreshold: 10 };

    test('adds the flat bag fee to the total and exposes it', () => {
      const result = computeTotal(basket(12.00), 0, 0, [], { bagFee: 0.10 });
      expect(result.bagFee).toBeCloseTo(0.10);
      expect(result.total).toBeCloseTo(12.10);
    });

    test('charges the flat fee when the subtotal is at or below the threshold', () => {
      // Live: 10.00 + 1.19 delivery + 1.10 service + 2.00 small order = 14.29
      const result = computeTotal(basket(10.00), 1.19, 0, [], jeFees);
      expect(result.smallOrderFee).toBeCloseTo(2.00);
      expect(result.total).toBeCloseTo(14.29);
    });

    test('charges nothing above the threshold', () => {
      const result = computeTotal(basket(10.50), 1.19, 0, [], jeFees);
      expect(result.smallOrderFee).toBe(0);
      expect(result.total).toBeCloseTo(10.50 + 1.19 + 10.50 * 0.11);
    });

    test('defaults both fees to 0 when the branch publishes none', () => {
      const result = computeTotal(basket(5.00), 0, 0, [], { smallOrderFeeThreshold: 10 });
      expect(result.smallOrderFee).toBe(0);
      expect(result.bagFee).toBe(0);
      expect(result.total).toBeCloseTo(5.00);
    });

    test('charges no small-order fee without a threshold (other platforms)', () => {
      const result = computeTotal(basket(5.00), 0, 0, [], { smallOrderFeeMax: 2.00 });
      expect(result.smallOrderFee).toBe(0);
      expect(result.total).toBeCloseTo(5.00);
    });
  });
});

describe('computeTotal — item-level deals', () => {
  const line = (name, unitPrice, quantity = 1) => ({
    referenceItem: { quantity },
    platformItem: { name, unitPrice },
    matched: true,
  });

  test('cheapest-free (2-for-1) frees the cheaper of two qualifying items', () => {
    const matches = [line('Footlong Sub', 6.0), line('Footlong Sub', 5.0)];
    const offers = [
      { type: 'item-deal', rule: 'cheapest-free', eligibleItems: ['Footlong Sub'], quantity: 2, description: 'Buy one get one free' },
    ];
    const result = computeTotal(matches, 0, 0, offers);
    expect(result.discountTotal).toBeCloseTo(5.0);
    expect(result.total).toBeCloseTo(6.0);
  });

  test('percent-off-items discounts only eligible lines and respects the cap', () => {
    const matches = [line('Pizza', 20.0), line('Coke', 2.0)];
    const offers = [
      { type: 'item-deal', rule: 'percent-off-items', eligibleItems: ['Pizza'], percent: 0.5, cap: 8, description: '50% off pizzas' },
    ];
    // 50% of the £20 pizza = £10, capped at £8; the £2 Coke is untouched.
    const result = computeTotal(matches, 0, 0, offers);
    expect(result.discountTotal).toBeCloseTo(8.0);
    expect(result.total).toBeCloseTo(14.0);
  });

  test('free-item frees the named item once when it is in the matched cart', () => {
    const matches = [line('Burger', 9.0), line('Fries', 3.5)];
    const offers = [
      { type: 'item-deal', rule: 'free-item', eligibleItems: ['Fries'], description: 'Free fries' },
    ];
    const result = computeTotal(matches, 0, 0, offers);
    expect(result.discountTotal).toBeCloseTo(3.5);
    expect(result.total).toBeCloseTo(9.0);
  });

  test('free-item gives no discount when the named item is absent', () => {
    const matches = [line('Burger', 9.0)];
    const offers = [
      { type: 'item-deal', rule: 'free-item', eligibleItems: ['Fries'], description: 'Free fries' },
    ];
    const result = computeTotal(matches, 0, 0, offers);
    expect(result.discountTotal).toBe(0);
    expect(result.total).toBeCloseTo(9.0);
  });

  // Eligible names and matched item names both come from the SAME platform's
  // catalogue (offer item ids resolved to names), so eligibility is exact — a
  // similar-but-different product must not qualify. Live regression (Popeyes JE,
  // 2026-07-10): "6 Boneless & a dip" fuzzy-matched the 50%-off eligible item
  // "6 boneless saucin' wings" and the sidebar invented a -£4.25 discount the
  // real basket didn't have.
  test('eligibility is exact: a similar-but-different item does not qualify', () => {
    const matches = [line('6 Boneless & a dip', 8.49)];
    const offers = [
      { type: 'item-deal', rule: 'percent-off-items', eligibleItems: ["6 boneless saucin' wings"], percent: 0.5, cap: Infinity, description: '50% off selected items' },
    ];
    const result = computeTotal(matches, 0, 0, offers);
    expect(result.discountTotal).toBe(0);
    expect(result.appliedDeals).toEqual([]);
  });

  test('eligibility ignores case and whitespace differences', () => {
    const matches = [line('Footlong  Sub', 6.0), line('footlong sub', 5.0)];
    const offers = [
      { type: 'item-deal', rule: 'cheapest-free', eligibleItems: ['Footlong Sub'], quantity: 2, description: 'BOGOF on footlongs' },
    ];
    const result = computeTotal(matches, 0, 0, offers);
    expect(result.discountTotal).toBeCloseTo(5.0);
  });

  test('a deal with no eligible items is display-only (total unchanged)', () => {
    const matches = [line('Footlong Sub', 6.0), line('Footlong Sub', 5.0)];
    const offers = [
      { type: 'item-deal', rule: 'cheapest-free', eligibleItems: [], quantity: 2, description: 'unlocatable deal' },
    ];
    const result = computeTotal(matches, 0, 0, offers);
    expect(result.discountTotal).toBe(0);
    expect(result.appliedDeals).toEqual([]);
    expect(result.total).toBeCloseTo(11.0);
  });

  test('cheapest-free frees one per group of N (3-for-2, odd counts)', () => {
    const threeForTwo = [
      { type: 'item-deal', rule: 'cheapest-free', eligibleItems: ['Cookie'], quantity: 3, description: '3 for 2' },
    ];
    // 3 cookies -> floor(3/3)=1 free (the cheapest)
    expect(
      computeTotal([line('Cookie', 2), line('Cookie', 1.5), line('Cookie', 1)], 0, 0, threeForTwo).discountTotal
    ).toBeCloseTo(1);
    // 2 cookies -> floor(2/3)=0 free
    expect(
      computeTotal([line('Cookie', 2), line('Cookie', 1.5)], 0, 0, threeForTwo).discountTotal
    ).toBe(0);
  });

  test('an item-deal composes with an order-level percentage offer', () => {
    const matches = [line('Sub', 6.0), line('Sub', 6.0)];
    const offers = [
      { type: 'item-deal', rule: 'cheapest-free', eligibleItems: ['Sub'], quantity: 2, description: 'BOGOF' },
      { type: 'percent', minSpend: 0, percent: 0.1, cap: 5 },
    ];
    // BOGOF frees one £6 sub (6); 10% of the £12 subtotal (1.20) also applies.
    const result = computeTotal(matches, 0, 0, offers);
    expect(result.discountTotal).toBeCloseTo(7.2);
    expect(result.total).toBeCloseTo(4.8);
  });

  test('appliedDeals lists each applied item-deal with its discount', () => {
    const matches = [line('Sub', 6.0), line('Sub', 5.0)];
    const offers = [
      { type: 'item-deal', rule: 'cheapest-free', eligibleItems: ['Sub'], quantity: 2, description: 'Buy one get one free' },
    ];
    const result = computeTotal(matches, 0, 0, offers);
    expect(result.appliedDeals).toEqual([{ description: 'Buy one get one free', discount: 5.0 }]);
  });
});
