// tests/snapshot.test.js
const { buildSnapshot } = require('../src/shared/snapshot');
const { PLATFORM } = require('../src/shared/constants');

const order = { platform: PLATFORM.UBER_EATS, restaurantName: 'Burger King' };

const done = (total, matched = 3, count = 3) => ({
  status: 'done',
  result: { restaurantName: 'Burger King', matches: [], offers: [],
    total: { total, matchedCount: matched, totalCount: count } },
});

function branches() {
  return [
    { platform: PLATFORM.UBER_EATS, key: 'uber|cur', label: 'Whitechapel', distance: 0.4, isCurrent: true, ...done(11.79) },
    { platform: PLATFORM.DELIVEROO, key: 'del|wc', label: 'Whitechapel', distance: 0.4, isCurrent: false, ...done(11.40) },
    { platform: PLATFORM.DELIVEROO, key: 'del|al', label: 'Aldgate', distance: 0.9, isCurrent: false, ...done(12.30) },
    { platform: PLATFORM.JUST_EAT, key: 'je|al', label: 'Aldgate', distance: 0.9, isCurrent: false, ...done(12.05) },
  ];
}

describe('buildSnapshot', () => {
  test('picks the cheapest complete branch per platform', () => {
    const snap = buildSnapshot(order, branches(), new Set());
    const del = snap.platforms.find((p) => p.platform === PLATFORM.DELIVEROO);
    expect(del.cheapestKey).toBe('del|wc');
  });
  test('footer recommends switching to the overall cheapest with the saving', () => {
    const snap = buildSnapshot(order, branches(), new Set());
    expect(snap.footer.kind).toBe('switch');
    expect(snap.footer.platform).toBe(PLATFORM.DELIVEROO);
    expect(snap.footer.label).toBe('Whitechapel');
    expect(snap.footer.saving).toBeCloseTo(0.39);
    expect(snap.currentTotal).toBeCloseTo(11.79);
  });
  test('footer says best when the current branch is cheapest', () => {
    const only = [{ platform: PLATFORM.UBER_EATS, key: 'uber|cur', label: 'WC', distance: 0.4, isCurrent: true, ...done(9.99) }];
    expect(buildSnapshot(order, only, new Set()).footer.kind).toBe('best');
  });
  test('incomplete branches are never cheapest', () => {
    const b = [
      { platform: PLATFORM.UBER_EATS, key: 'uber|cur', label: 'WC', distance: 0.4, isCurrent: true, ...done(11.79) },
      { platform: PLATFORM.DELIVEROO, key: 'del|wc', label: 'WC', distance: 0.4, isCurrent: false, ...done(5.00, 2, 3) },
    ];
    const snap = buildSnapshot(order, b, new Set());
    expect(snap.platforms.find((p) => p.platform === PLATFORM.DELIVEROO).cheapestKey).toBeNull();
    expect(snap.footer.kind).toBe('best');
  });
  test('spinner set for platforms still loading; unknown footer with nothing complete', () => {
    const snap = buildSnapshot(order, [], new Set([PLATFORM.DELIVEROO]));
    const del = snap.platforms.find((p) => p.platform === PLATFORM.DELIVEROO);
    expect(del.spinner).toBe(true);
    expect(snap.footer.kind).toBe('unknown');
  });
});
