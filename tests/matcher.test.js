const { matchItems, computeTotal } = require('../src/shared/matcher');

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
});
