// Pure view decisions for the sidebar. sidebar.js is a browser-only IIFE that
// builds DOM; the *wording and state* choices it makes — footer text per
// snapshot.footer, the click-failure message per reason, the switch CTA's
// "Switch & fill N of M" — live here as plain CommonJS so they run (and are
// tested) under Jest with no DOM. Getting the logic right but the words wrong
// is the exact regression #107 exists to catch, so this is the seam that
// catches it. sidebar.js imports these and only assembles the elements.
const { PLATFORM } = require('./constants');

const PLATFORM_LABEL = {
  [PLATFORM.UBER_EATS]: { name: 'Uber Eats' },
  [PLATFORM.DELIVEROO]: { name: 'Deliveroo' },
  [PLATFORM.JUST_EAT]: { name: 'Just Eat' },
};

const formatMoney = (n) => `£${(+n || 0).toFixed(2)}`;

// A platform's display name, optionally qualified by a branch label in parens.
function platformName(platform, label) {
  return `${PLATFORM_LABEL[platform].name}${label ? ` (${label})` : ''}`;
}

// Reasons a user can act on, in their own terms. Anything else stays generic
// rather than inventing a remedy we do not have.
const CLICK_FAILURE_TEXT = {
  expired: 'This comparison has expired — reload the page to compare again',
  'not-switchable': 'That branch can no longer be opened — reload the page to compare again',
  'bad-url': "That branch's menu link failed validation, so it was not opened",
  'tab-failed': 'The browser refused to open a new tab for that branch',
};
const CLICK_FAILURE_FALLBACK = 'That click could not be completed';

function clickFailureText(reason) {
  return CLICK_FAILURE_TEXT[reason] || CLICK_FAILURE_FALLBACK;
}

// The line that explains why a cheaper-looking branch did not win (#3): it
// priced only part of the cart, so its lower total is not a real saving.
function undercutNote(undercut) {
  if (!undercut) return null;
  return `${platformName(undercut.platform, undercut.label)} is ${formatMoney(undercut.total)},`
    + ` but priced only ${undercut.matchedCount} of your ${undercut.totalCount} items`;
}

// The footer's wording and state, decided from snapshot.footer. The sidebar
// turns these fields into styled spans; the words are all decided here.
function footerView(footer) {
  if (footer.kind === 'switch') {
    return {
      kind: 'switch',
      // Clickable only when the cheapest branch has a validated URL to open.
      clickable: !!footer.switchUrl,
      who: platformName(footer.platform, footer.label),
      saving: formatMoney(footer.saving),
      undercut: undercutNote(footer.undercut),
    };
  }
  if (footer.kind === 'best') {
    return {
      kind: 'best',
      message: footer.undercut
        ? "✅ You're on the cheapest branch with every item"
        : "✅ You're already on the cheapest branch",
      undercut: undercutNote(footer.undercut),
    };
  }
  return { kind: 'unknown', message: 'Comparing branches…', undercut: null };
}

// Label for a branch's switch button, reflecting how much of the basket can be
// pre-filled (vs. opened for manual add). Returns null when there's no usable URL.
function switchButtonLabel(branch) {
  if (!branch.switchUrl) return null;
  const plan = branch.result?.basketPlan ?? [];
  const fillable = plan.filter((l) => l.prefillable).length;
  // A line with a matched item id is worth attempting even when its options
  // only carry names (#51 — Uber targets expose no option data, so nothing
  // there is ever fully "prefillable"): the builder selects options by name
  // text and review-flags what it can't complete. Only a plan with no matched
  // items at all falls back to the plain menu link.
  const attemptable = plan.filter((l) => l.id != null).length;
  if (!plan.length || attemptable === 0) return { text: 'Open menu ↗', plain: true };
  if (fillable === plan.length) return { text: 'Switch & fill basket ↗', plain: false };
  return { text: `Switch & fill ${attemptable} of ${plan.length} ↗`, plain: false };
}

module.exports = {
  PLATFORM_LABEL,
  formatMoney,
  platformName,
  CLICK_FAILURE_TEXT,
  clickFailureText,
  undercutNote,
  footerView,
  switchButtonLabel,
};
