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

  test('eligibility matches fuzzily so wording differences still qualify', () => {
    const matches = [line('Footlong Sub', 6.0), line('Footlong Sub', 5.0)];
    const offers = [
      { type: 'item-deal', rule: 'cheapest-free', eligibleItems: ['Footlong'], quantity: 2, description: 'BOGOF on footlongs' },
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
