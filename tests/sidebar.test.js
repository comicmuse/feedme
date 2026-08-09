// DOM coverage for the three sidebar features that shipped with none (#107):
//  - the platform legend dot (#98)
//  - the "N OF M ITEMS" shortfall tag (#3)
//  - the "This comparison has expired" click-failure footer (#103/#104)
// sidebar.js self-installs on injection but also exports its renderers, so a
// snapshot can be rendered into jsdom and asserted here. The default test
// environment is jsdom, so document/window already exist.
const sidebar = require('../src/content/sidebar');
const { buildSnapshot } = require('../src/shared/snapshot');
const { PLATFORM } = require('../src/shared/constants');

// Total shape the snapshot/renderers read from a 'done' branch.
function total({ items = 10, matched = 5, count = 5 } = {}) {
  return {
    total: items, itemsTotal: items, deliveryFee: 0, serviceFee: 0,
    bagFee: 0, smallOrderFee: 0, discountTotal: 0,
    deliveryFeeEstimated: false, serviceFeeEstimated: false,
    matchedCount: matched, totalCount: count,
  };
}

function branch(over = {}) {
  return {
    platform: PLATFORM.UBER_EATS,
    key: 'b1',
    label: 'Test Branch',
    isCurrent: false,
    status: 'done',
    distance: null,
    switchUrl: null,
    earnsStampCard: false,
    result: { restaurantName: 'Test Branch', total: total(), basketPlan: [] },
    ...over,
  };
}

const order = { restaurantName: 'Testaurant', items: [{}, {}], postcode: 'SW1' };

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('self-install seam', () => {
  test('install() draws the sidebar host into the page', () => {
    expect(document.getElementById('feedme-root')).toBeNull();
    sidebar.install();
    expect(document.getElementById('feedme-root')).not.toBeNull();
  });

  test('install() is idempotent — a second call does not double-inject', () => {
    sidebar.install();
    sidebar.install();
    expect(document.querySelectorAll('#feedme-root')).toHaveLength(1);
  });
});

describe('shortfall tag (#3)', () => {
  test('a branch that priced only part of the cart shows an "N OF M ITEMS" tag', () => {
    const card = sidebar.buildBranchCard(
      branch({ result: { restaurantName: 'X', total: total({ matched: 4, count: 5 }), basketPlan: [] } }),
      false,
    );
    const tag = card.querySelector('.tag.sh');
    expect(tag).not.toBeNull();
    expect(tag.textContent).toBe('4 OF 5 ITEMS');
  });

  test('a complete branch shows no shortfall tag', () => {
    const card = sidebar.buildBranchCard(
      branch({ result: { restaurantName: 'X', total: total({ matched: 5, count: 5 }), basketPlan: [] } }),
      false,
    );
    expect(card.querySelector('.tag.sh')).toBeNull();
  });
});

describe('platform legend dot (#98)', () => {
  test('each column dot carries its platform custom property', () => {
    sidebar.install();
    const snapshot = buildSnapshot(
      order,
      [branch({ platform: PLATFORM.DELIVEROO, key: 'd1', isCurrent: true })],
      new Set(),
    );
    sidebar.render(snapshot, order);
    const shadow = document.getElementById('feedme-root').shadowRoot;
    // The .dot rule paints `background: var(--dot-bg)`, and each column sets
    // --dot-bg to its own platform property — so the dot carries the platform.
    const dots = [...shadow.querySelectorAll('.dot')].map((d) => d.style.getPropertyValue('--dot-bg'));
    expect(dots).toContain(`var(--fm-dot-${PLATFORM.UBER_EATS})`);
    expect(dots).toContain(`var(--fm-dot-${PLATFORM.DELIVEROO})`);
    expect(dots).toContain(`var(--fm-dot-${PLATFORM.JUST_EAT})`);
  });
});

describe('expired click-failure footer (#103/#104)', () => {
  test('a click failure replaces the normal footer with the expired message', () => {
    sidebar.install();
    // A current + a cheaper sibling produces a clickable "switch" footer.
    const branches = [
      branch({ key: 'cur', isCurrent: true, result: { restaurantName: 'X', total: total({ items: 20 }), basketPlan: [] } }),
      branch({ key: 'alt', switchUrl: 'https://www.ubereats.com/gb/store/x',
        result: { restaurantName: 'X', total: total({ items: 10 }), basketPlan: [] } }),
    ];
    const snapshot = buildSnapshot(order, branches, new Set());
    sidebar.render(snapshot, order);
    const shadow = document.getElementById('feedme-root').shadowRoot;
    expect(shadow.querySelector('.ft.sw')).not.toBeNull();
    expect(shadow.querySelector('.ft.err')).toBeNull();

    sidebar.showClickFailure('expired');
    // The normal footer is gone, replaced by exactly one error footer.
    expect(shadow.querySelectorAll('.ft')).toHaveLength(1);
    const err = shadow.querySelector('.ft.err');
    expect(err).not.toBeNull();
    expect(err.textContent).toContain('This comparison has expired');
  });
});
