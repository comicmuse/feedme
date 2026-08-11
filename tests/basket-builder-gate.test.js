/**
 * @jest-environment jsdom
 */
const {
  jeLocationPanel, jeUnresolvedFees, findOpenDialog, detectPageGate,
} = require('../src/content/basket-builder');

// Just Eat's address dialog when no delivery address is resolved (live 2026-08-09,
// Popeyes Whitechapel): a role=dialog asking for the street / "Finding your
// location". A separate [data-qa="cart-modal"] with a decrement control is present
// too, so Task 3 can prove clearBasket is SKIPPED, not merely empty.
function mountJeLocationGate() {
  document.body.innerHTML = `
    <main>
      <div class="menu"><button class="item" data-item-id="x">Chicken Sandwich Box Meal</button></div>
      <div data-qa="cart-modal">
        <div>1x Chicken Sandwich Box Meal</div>
        <span role="button" data-qa="cart-item-amount-action-decrement"></span>
      </div>
      <div role="dialog" aria-modal="true" data-qa="address-panel">
        <h2>Where should we deliver?</h2>
        <p>Please enter your street and house number</p>
        <p>Finding your location…</p>
      </div>
    </main>`;
}

// Address dismissed but never set: the CART panel still shows fee RANGES.
function mountJeFeeRangeGate() {
  document.body.innerHTML = `
    <main>
      <div class="menu"><button class="item" data-item-id="x">Chicken Sandwich Box Meal</button></div>
      <div data-qa="cart-modal">
        <div class="fee-row"><span>Service</span><span>£0.99 - £2.99</span></div>
        <div class="fee-row"><span>Small order</span><span>£0.00 - £2.00</span></div>
      </div>
    </main>`;
}

// A resolved, usable Just Eat menu: single fee values, no location dialog.
function mountJeResolved() {
  document.body.innerHTML = `
    <main>
      <div class="menu"><button class="item" data-item-id="x">Chicken Sandwich Box Meal</button></div>
      <div data-qa="cart-modal">
        <div class="fee-row"><span>Service</span><span>£1.49</span></div>
        <div class="fee-row"><span>Delivery</span><span>£2.49</span></div>
      </div>
    </main>`;
}

// A menu whose PRICES carry a range, but the cart has no fee range and no address
// dialog — proves jeUnresolvedFees is scoped to the cart, not the whole page.
function mountJeMenuWithPriceRange() {
  document.body.innerHTML = `
    <main>
      <div class="menu">
        <button class="item" data-item-id="b">Bundle for Two <span>£20.00 - £30.00</span></button>
      </div>
      <div data-qa="cart-modal"><div class="fee-row"><span>Service</span><span>£1.49</span></div></div>
    </main>`;
}

describe('Just Eat gate predicates (#110)', () => {
  test('jeLocationPanel: true on the open address dialog', () => {
    mountJeLocationGate();
    expect(jeLocationPanel(document)).toBe(true);
  });

  test('jeLocationPanel: false on a resolved menu (cart present, no address dialog)', () => {
    mountJeResolved();
    expect(jeLocationPanel(document)).toBe(false);
  });

  test('jeUnresolvedFees: true when the cart shows fee ranges', () => {
    mountJeFeeRangeGate();
    expect(jeUnresolvedFees(document)).toBe(true);
  });

  test('jeUnresolvedFees: false when cart fees are single values', () => {
    mountJeResolved();
    expect(jeUnresolvedFees(document)).toBe(false);
  });

  test('jeUnresolvedFees: false for a menu price range OUTSIDE the cart', () => {
    mountJeMenuWithPriceRange();
    expect(jeUnresolvedFees(document)).toBe(false);
  });

  test('findOpenDialog: skips the location panel even if it names the item', () => {
    document.body.innerHTML = `
      <div role="dialog" data-qa="address-panel">
        <h2>Where should we deliver?</h2>
        <p>Please enter your street and house number for your Chicken Sandwich Box Meal</p>
      </div>`;
    // Without the explicit skip, the name match would wrongly return this panel.
    expect(findOpenDialog(document, { name: 'Chicken Sandwich Box Meal' })).toBeNull();
  });

  test('findOpenDialog: KEEPS a customise dialog headed by the item, delivery-ish body notwithstanding', () => {
    // The guard on the core add path: a real dialog whose heading is the item must
    // never be dropped just because its body matches the location regex (#110).
    document.body.innerHTML = `
      <div role="dialog">
        <h2>Chicken Sandwich Box Meal</h2>
        <p>Where should we deliver this order?</p>
        <button class="add">Add to basket</button>
      </div>`;
    const dialog = findOpenDialog(document, { name: 'Chicken Sandwich Box Meal' });
    expect(dialog).not.toBeNull();
    expect(dialog.querySelector('h2').textContent).toBe('Chicken Sandwich Box Meal');
  });
});

describe('detectPageGate (#110)', () => {
  test('just-eat + location dialog → je-address gate', () => {
    mountJeLocationGate();
    expect(detectPageGate(document, 'just-eat')).toEqual({
      reason: 'je-address',
      action: 'Just Eat needs a delivery address before items can be added — set it, then switch again.',
    });
  });

  test('just-eat + fee ranges → je-address gate', () => {
    mountJeFeeRangeGate();
    expect(detectPageGate(document, 'just-eat')).toMatchObject({ reason: 'je-address' });
  });

  test('just-eat + resolved menu → null', () => {
    mountJeResolved();
    expect(detectPageGate(document, 'just-eat')).toBeNull();
  });

  test('the same gated DOM on another platform → null (JE-only for now)', () => {
    mountJeLocationGate();
    expect(detectPageGate(document, 'uber-eats')).toBeNull();
    expect(detectPageGate(document, 'deliveroo')).toBeNull();
  });

  test('null doc → null', () => {
    expect(detectPageGate(null, 'just-eat')).toBeNull();
  });
});
