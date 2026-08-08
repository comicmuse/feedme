// Single source of truth for every colour the extension paints.
//
// FeedMe's UI is injected over Uber Eats, Deliveroo and Just Eat pages, so the
// palette has one constraint an ordinary app's does not: it must not look like
// it belongs to the page it is sitting on. tests/theme.test.js enforces that
// mechanically against PLATFORM_BRAND below.

// The three brands, as they appear on the pages the sidebar opens over.
// Sourced by eye from the live sites; only used to keep our own palette away
// from them, never to draw anything.
const PLATFORM_BRAND = {
  JUST_EAT: ['#ff8000', '#f36d00'],
  DELIVEROO: ['#00ccbc'],
  UBER_EATS: ['#06c167', '#142328'],
};

const THEME = {
  '--fm-surface': '#ffffff',
  '--fm-surface-sunken': '#fafafa',
  '--fm-surface-muted': '#f3f4f6',
  '--fm-border': '#e5e7eb',

  '--fm-text': '#111111',
  '--fm-text-strong': '#374151',
  '--fm-text-muted': '#6b7280',
  '--fm-text-faint': '#9ca3af',

  // Indigo, at 147 degrees from Just Eat, 92 from Uber Eats and 68 from
  // Deliveroo — the widest berth available once those three claim H25-30 and
  // H142-175. It also reads as a tool rather than as a food brand, which is
  // what an overlay on someone else's shop ought to look like.
  '--fm-accent': '#4f46e5',
  '--fm-accent-strong': '#4338ca',
  '--fm-accent-hover': '#3730a3',
  '--fm-accent-tint': '#eef2ff',
  '--fm-accent-tint-hover': '#e0e7ff',
  '--fm-accent-border': '#c7d2fe',

  // Savings stay green, because green means money saved and no substitute
  // carries that for free. The distance from Uber Eats' green is bought with
  // lightness instead of hue: theirs is a vivid L39/S94 brand green, this is
  // a dark ledger green that cannot be mistaken for one of their surfaces.
  '--fm-win': '#15803d',
  '--fm-win-text': '#166534',
  '--fm-win-tint': '#f0fdf4',
  '--fm-win-border': '#bbf7d0',
  '--fm-win-rule': '#dcfce7',

  // Deep enough to read as burnt umber rather than as Just Eat's orange.
  '--fm-warn': '#92400e',
  '--fm-error': '#ef4444',
  '--fm-error-border': '#fecaca',
};

// The sidebar and the builder overlay both live in shadow roots, so the
// custom properties have to be declared inside each one — nothing inherits
// from the host page, which is the point.
function themeCssVars(selector = ':host') {
  const body = Object.entries(THEME).map(([k, v]) => `${k}:${v};`).join('');
  return `${selector}{${body}}`;
}

module.exports = { THEME, PLATFORM_BRAND, themeCssVars };
