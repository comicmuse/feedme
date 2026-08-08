const { switchTableKey, buildSwitchTable, switchEntry } = require('../src/shared/switch-table');
const { PLATFORM } = require('../src/shared/constants');

const branch = (over = {}) => ({
  key: 'del|wc',
  platform: PLATFORM.DELIVEROO,
  label: 'Whitechapel',
  isCurrent: false,
  switchUrl: 'https://deliveroo.co.uk/menu/london/whitechapel/tayyabs',
  result: { basketPlan: [{ id: 'a', name: 'Seekh Kebab', quantity: 1 }] },
  ...over,
});

describe('switchTableKey', () => {
  test('is namespaced per source tab so two compared carts cannot collide', () => {
    expect(switchTableKey(17)).toBe('switch|17');
    expect(switchTableKey(18)).not.toBe(switchTableKey(17));
  });
});

describe('buildSwitchTable', () => {
  test('keeps exactly what a switch consumes, keyed by branch', () => {
    expect(buildSwitchTable([branch()])).toEqual({
      'del|wc': {
        platform: PLATFORM.DELIVEROO,
        label: 'Whitechapel',
        switchUrl: 'https://deliveroo.co.uk/menu/london/whitechapel/tayyabs',
        isCurrent: false,
        basketPlan: [{ id: 'a', name: 'Seekh Kebab', quantity: 1 }],
      },
    });
  });

  // Without the plan a restored switch opens the right menu and fills nothing,
  // which reads as more broken than the dead button it replaced.
  test('carries the basket plan, and defaults it to empty rather than undefined', () => {
    expect(buildSwitchTable([branch()])['del|wc'].basketPlan).toHaveLength(1);
    expect(buildSwitchTable([branch({ result: null })])['del|wc'].basketPlan).toEqual([]);
    expect(buildSwitchTable([branch({ result: {} })])['del|wc'].basketPlan).toEqual([]);
  });

  test('drops branches with no validated switch URL instead of storing dead rows', () => {
    expect(buildSwitchTable([branch({ switchUrl: null })])).toEqual({});
    expect(buildSwitchTable([branch({ switchUrl: undefined })])).toEqual({});
  });

  test('survives junk in the branch list', () => {
    expect(buildSwitchTable([null, undefined, branch({ key: null })])).toEqual({});
    expect(buildSwitchTable([])).toEqual({});
    expect(buildSwitchTable(null)).toEqual({});
  });

  test('marks the current branch, which the handler refuses to switch to', () => {
    expect(buildSwitchTable([branch({ isCurrent: true })])['del|wc'].isCurrent).toBe(true);
  });

  test('the result is plain and serialisable — it has to cross storage.session', () => {
    const table = buildSwitchTable([branch()]);
    expect(JSON.parse(JSON.stringify(table))).toEqual(table);
  });
});

describe('switchEntry', () => {
  const table = buildSwitchTable([branch()]);

  test('finds a stored branch', () => {
    expect(switchEntry(table, 'del|wc').platform).toBe(PLATFORM.DELIVEROO);
  });

  test('returns null rather than throwing on a cold or unknown lookup', () => {
    expect(switchEntry(table, 'je|nope')).toBeNull();
    expect(switchEntry(undefined, 'del|wc')).toBeNull();
    expect(switchEntry(null, 'del|wc')).toBeNull();
    expect(switchEntry(table, undefined)).toBeNull();
  });

  test('refuses an entry whose URL did not survive', () => {
    expect(switchEntry({ 'del|wc': { platform: PLATFORM.DELIVEROO } }, 'del|wc')).toBeNull();
  });
});
