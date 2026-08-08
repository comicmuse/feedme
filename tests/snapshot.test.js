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
  test('highlights only the single overall-cheapest branch (no per-column highlight)', () => {
    const snap = buildSnapshot(order, branches(), new Set());
    expect(snap.cheapestKey).toBe('del|wc'); // 11.40 is the lowest of all branches
    expect(snap.platforms.every((p) => !('cheapestKey' in p))).toBe(true);
  });
  test('footer recommends switching to the overall cheapest with the saving', () => {
    const snap = buildSnapshot(order, branches(), new Set());
    expect(snap.footer.kind).toBe('switch');
    expect(snap.footer.platform).toBe(PLATFORM.DELIVEROO);
    expect(snap.footer.label).toBe('Whitechapel');
    expect(snap.footer.saving).toBeCloseTo(0.39);
    expect(snap.currentTotal).toBeCloseTo(11.79);
  });
  test('switch footer carries the cheapest branch key + switchUrl for the click target', () => {
    const b = branches();
    b[1].switchUrl = 'https://deliveroo.co.uk/menu/london/whitechapel/bk';
    const snap = buildSnapshot(order, b, new Set());
    expect(snap.footer.key).toBe('del|wc');
    expect(snap.footer.switchUrl).toBe('https://deliveroo.co.uk/menu/london/whitechapel/bk');
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
    expect(snap.cheapestKey).toBe('uber|cur'); // only the complete current branch qualifies
    expect(snap.footer.kind).toBe('best');
  });
  test('spinner set for platforms still loading; unknown footer with nothing complete', () => {
    const snap = buildSnapshot(order, [], new Set([PLATFORM.DELIVEROO]));
    const del = snap.platforms.find((p) => p.platform === PLATFORM.DELIVEROO);
    expect(del.spinner).toBe(true);
    expect(snap.footer.kind).toBe('unknown');
  });
  test('marks a platform enumFailed when enumErrors names it, independent of spinner/branches', () => {
    const snap = buildSnapshot(order, [], new Set(), new Set([PLATFORM.JUST_EAT]));
    const je = snap.platforms.find((p) => p.platform === PLATFORM.JUST_EAT);
    expect(je.enumFailed).toBe(true);
    expect(je.spinner).toBe(false);
    const uber = snap.platforms.find((p) => p.platform === PLATFORM.UBER_EATS);
    expect(uber.enumFailed).toBe(false);
  });
  test('enumFailed defaults to false when the 4th argument is omitted (backward compatible)', () => {
    const snap = buildSnapshot(order, branches(), new Set());
    expect(snap.platforms.every((p) => p.enumFailed === false)).toBe(true);
  });

  // #3: a branch that priced only some of the cart is cheaper for the wrong
  // reason, so it cannot win — but showing its bare total next to "you're
  // already on the cheapest branch" reads as the comparison being broken.
  // Live 2026-08-08: Deliveroo Whitechapel showed £54.09 against Uber's £60.31
  // and lost, because £54.09 bought four of five items.
  describe('undercut by an incomplete branch', () => {
    const short = (total, matched, count) => ({
      status: 'done',
      result: { restaurantName: 'Burger King', matches: [], offers: [],
        total: { total, matchedCount: matched, totalCount: count } },
    });

    const withShortfall = () => [
      { platform: PLATFORM.UBER_EATS, key: 'uber|cur', label: 'WC', distance: 0.4, isCurrent: true, ...done(60.31, 5, 5) },
      { platform: PLATFORM.DELIVEROO, key: 'del|wc', label: 'Whitechapel', distance: 0.4, isCurrent: false, ...short(54.09, 4, 5) },
    ];

    test('an incomplete branch never becomes the cheapest, however low its total', () => {
      const snap = buildSnapshot(order, withShortfall(), new Set());
      expect(snap.cheapestKey).toBe('uber|cur');
    });

    test('the footer reports what undercut the winner and why it did not count', () => {
      const snap = buildSnapshot(order, withShortfall(), new Set());
      expect(snap.footer.kind).toBe('best');
      expect(snap.footer.undercut).toEqual({
        platform: PLATFORM.DELIVEROO,
        label: 'Whitechapel',
        total: 54.09,
        matchedCount: 4,
        totalCount: 5,
      });
    });

    test('only a cheaper incomplete branch is called out, not a dearer one', () => {
      const b = withShortfall();
      b[1].result.total.total = 70.00;
      expect(buildSnapshot(order, b, new Set()).footer.undercut).toBeUndefined();
    });

    test('the nearest miss is reported when several branches fall short', () => {
      const b = withShortfall();
      b.push({ platform: PLATFORM.JUST_EAT, key: 'je|al', label: 'Aldgate', distance: 0.9, isCurrent: false, ...short(50.00, 3, 5) });
      // 50.00 is lower, but 54.09 is the closest thing to a real alternative.
      expect(buildSnapshot(order, b, new Set()).footer.undercut.total).toBe(54.09);
    });

    test('nothing is reported when every branch priced the whole cart', () => {
      expect(buildSnapshot(order, branches(), new Set()).footer.undercut).toBeUndefined();
    });

    test('a switch recommendation can also be undercut by an incomplete branch', () => {
      const b = withShortfall();
      b.push({ platform: PLATFORM.JUST_EAT, key: 'je|al', label: 'Aldgate', distance: 0.9, isCurrent: false, ...done(58.00, 5, 5) });
      const snap = buildSnapshot(order, b, new Set());
      expect(snap.footer.kind).toBe('switch');
      expect(snap.footer.undercut.total).toBe(54.09);
    });
  });
});
