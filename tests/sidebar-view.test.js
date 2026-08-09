// Pure view-decision logic for the sidebar (#107): the text/state choices that
// decide what words the footer, click-failure message and switch CTA render.
// These are the exact failure mode #107 targets — right logic, wrong words —
// so they are tested directly, with no DOM.
const {
  footerView, clickFailureText, switchButtonLabel,
} = require('../src/shared/sidebar-view');
const { PLATFORM } = require('../src/shared/constants');

describe('footerView', () => {
  test('switch footer names the platform and formats the saving', () => {
    const view = footerView({
      kind: 'switch',
      key: 'k',
      platform: PLATFORM.UBER_EATS,
      label: 'Victoria',
      switchUrl: 'https://www.ubereats.com/gb/store/x',
      saving: 3,
      undercut: undefined,
    });
    expect(view.kind).toBe('switch');
    expect(view.clickable).toBe(true);
    expect(view.who).toBe('Uber Eats (Victoria)');
    expect(view.saving).toBe('£3.00');
  });

  test('switch footer is not clickable without a validated switch URL', () => {
    const view = footerView({
      kind: 'switch', key: 'k', platform: PLATFORM.DELIVEROO, label: '',
      switchUrl: null, saving: 1.5, undercut: undefined,
    });
    expect(view.clickable).toBe(false);
    // No label => bare platform name, no parens.
    expect(view.who).toBe('Deliveroo');
    expect(view.saving).toBe('£1.50');
  });

  test('best footer without an undercut says you are on the cheapest branch', () => {
    const view = footerView({ kind: 'best', undercut: undefined });
    expect(view.kind).toBe('best');
    expect(view.message).toBe("✅ You're already on the cheapest branch");
    expect(view.undercut).toBeNull();
  });

  test('best footer with an undercut explains why the lower number did not win', () => {
    const view = footerView({
      kind: 'best',
      undercut: {
        platform: PLATFORM.JUST_EAT, label: 'Soho',
        total: 12.5, matchedCount: 4, totalCount: 5,
      },
    });
    expect(view.message).toBe("✅ You're on the cheapest branch with every item");
    expect(view.undercut).toBe('Just Eat (Soho) is £12.50, but priced only 4 of your 5 items');
  });

  test('unknown footer is the comparing placeholder', () => {
    const view = footerView({ kind: 'unknown' });
    expect(view.kind).toBe('unknown');
    expect(view.message).toBe('Comparing branches…');
  });
});

describe('clickFailureText', () => {
  test('expired reason spells out the reload remedy', () => {
    expect(clickFailureText('expired'))
      .toBe('This comparison has expired — reload the page to compare again');
  });
  test('not-switchable reason', () => {
    expect(clickFailureText('not-switchable'))
      .toBe('That branch can no longer be opened — reload the page to compare again');
  });
  test('bad-url reason', () => {
    expect(clickFailureText('bad-url'))
      .toBe("That branch's menu link failed validation, so it was not opened");
  });
  test('tab-failed reason', () => {
    expect(clickFailureText('tab-failed'))
      .toBe('The browser refused to open a new tab for that branch');
  });
  test('an unknown reason falls back to a generic message rather than inventing a remedy', () => {
    expect(clickFailureText('who-knows')).toBe('That click could not be completed');
  });
});

describe('switchButtonLabel', () => {
  const withPlan = (plan) => ({
    switchUrl: 'https://x/menu', result: { basketPlan: plan },
  });

  test('returns null when the branch has no usable switch URL', () => {
    expect(switchButtonLabel({ switchUrl: null, result: { basketPlan: [] } })).toBeNull();
  });

  test('a fully prefillable plan offers a full basket fill', () => {
    const label = switchButtonLabel(withPlan([
      { id: 1, prefillable: true }, { id: 2, prefillable: true },
    ]));
    expect(label).toEqual({ text: 'Switch & fill basket ↗', plain: false });
  });

  test('a partly matched plan reports how many of how many will fill', () => {
    const label = switchButtonLabel(withPlan([
      { id: 1, prefillable: true }, { id: 2, prefillable: false }, { id: null },
    ]));
    expect(label).toEqual({ text: 'Switch & fill 2 of 3 ↗', plain: false });
  });

  test('a plan with nothing matched falls back to the plain menu link', () => {
    const label = switchButtonLabel(withPlan([{ id: null }, { id: null }]));
    expect(label).toEqual({ text: 'Open menu ↗', plain: true });
  });
});
