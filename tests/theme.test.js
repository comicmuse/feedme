const fs = require('fs');
const path = require('path');
const {
  THEME, PLATFORM_BRAND, PLATFORM_DOT, themeCssVars,
} = require('../src/shared/theme');
const { PLATFORM } = require('../src/shared/constants');

const root = path.join(__dirname, '..');

// Every file allowed to name a colour. The sidebar renders over a platform's
// own page, so its palette is the one that has to stay visibly not-theirs —
// but the popup and the toolbar badge carry the same brand, so they are held
// to the same rule.
const UI_SOURCES = [
  'src/shared/theme.js',
  'src/content/sidebar.js',
  'src/content/basket-builder.js',
  'src/background/service-worker.js',
  'popup/popup.css',
];

const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

function toRgb(hex) {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
}

function toHsl(hex) {
  const [r, g, b] = toRgb(hex).map((v) => v / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (!d) return { h: 0, s: 0, l: l * 100 };
  const s = d / (1 - Math.abs(2 * l - 1));
  let h;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return { h: ((h * 60) + 360) % 360, s: s * 100, l: l * 100 };
}

// WCAG 2.1 relative luminance and contrast ratio.
function luminance(hex) {
  const [r, g, b] = toRgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

function hueGap(a, b) {
  const d = Math.abs(toHsl(a).h - toHsl(b).h);
  return Math.min(d, 360 - d);
}

// What makes a colour read as *someone's brand* rather than as chrome: it has
// to be both saturated and mid-toned. All three platform marks sit in a narrow
// band (Just Eat L50, Deliveroo L40, Uber Eats L39, all S>90), so a colour
// outside this band cannot be mistaken for one however close its hue is —
// which is what lets the savings green stay green by going dark (#15803d, L29)
// instead of abandoning the money-colour convention for a clash it never had.
const BRAND_LIKE = { minSaturation: 40, minLightness: 35, maxLightness: 70 };
// Hue degrees. Deliberately wide: the failure being prevented is "this overlay
// looks like it belongs to the site", which needs nothing like an exact match.
// 25 is the largest threshold that still keeps the error red (H0) clear of
// Just Eat's orange (H30), the tightest legitimate pairing in the palette.
const MIN_HUE_GAP = 25;

const isBrandLike = (hex) => {
  const { s, l } = toHsl(hex);
  return s >= BRAND_LIKE.minSaturation
    && l >= BRAND_LIKE.minLightness
    && l <= BRAND_LIKE.maxLightness;
};

function collidingPlatform(hex) {
  if (!isBrandLike(hex)) return null;
  for (const [platform, brands] of Object.entries(PLATFORM_BRAND)) {
    for (const brand of brands) {
      if (isBrandLike(brand) && hueGap(hex, brand) < MIN_HUE_GAP) return platform;
    }
  }
  return null;
}

// Hex literals anywhere in a UI source, including inside template strings and
// inline cssText — the sidebar builds its CSS as a string, so a regex over the
// raw text is what actually sees every colour that reaches a user.
function hexesIn(rel) {
  const found = read(rel).match(/#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b/g) || [];
  return [...new Set(found.map((h) => h.toLowerCase()))];
}

// The one sanctioned use of a platform's own colour, per #98: the legend dot
// beside that platform's name. Everything else the extension paints is chrome
// and must stay clear of all three brands.
const dotTokens = () => Object.fromEntries(
  Object.entries(PLATFORM_DOT).map(([platform, hex]) => [`--fm-dot-${platform}`, hex]),
);

// The colours a file could actually paint as chrome. Identical to hexesIn
// everywhere except the theme module, which also names the three brands twice
// over: as the reference data this whole check is measured against, and as the
// legend dots. Neither is chrome, and scanning them would flag the yardstick
// as the offence.
function paintedBy(rel) {
  if (rel === 'src/shared/theme.js') return Object.values(THEME).map((h) => h.toLowerCase());
  return hexesIn(rel);
}

describe('platform collision', () => {
  // The bug in #98: the accent was #f97316, five hue-degrees off Just Eat's
  // #FF8000, so on a Just Eat page the comparison overlay read as Just Eat's
  // own furniture. This is the regression guard for the whole palette.
  test.each(UI_SOURCES)('%s uses no colour that reads as a platform brand', (rel) => {
    const offenders = paintedBy(rel)
      .map((hex) => ({ hex, platform: collidingPlatform(hex) }))
      .filter((x) => x.platform);
    expect(offenders).toEqual([]);
  });

  test('the guard rejects the colours that caused #98', () => {
    expect(collidingPlatform('#f97316')).toBe('JUST_EAT');
    expect(collidingPlatform('#22c55e')).toBe('UBER_EATS');
    expect(collidingPlatform('#d97706')).toBe('JUST_EAT');
  });

  test('the guard clears the palette that replaced them', () => {
    expect(collidingPlatform(THEME['--fm-accent'])).toBeNull();
    expect(collidingPlatform(THEME['--fm-win'])).toBeNull();
    expect(collidingPlatform(THEME['--fm-warn'])).toBeNull();
    expect(collidingPlatform(THEME['--fm-error'])).toBeNull();
  });
});

describe('platform dots', () => {
  // These were three arbitrary emoji (🟠 Uber Eats, 🔵 Deliveroo, 🟣 Just Eat),
  // which put Just Eat's orange next to Uber Eats' name and got all three
  // wrong. A legend is the one place a brand colour carries information, so
  // here — and only here — the dots are the brands themselves.
  test.each([
    [PLATFORM.UBER_EATS, '#06c167'],
    [PLATFORM.DELIVEROO, '#00ccbc'],
    [PLATFORM.JUST_EAT, '#ff8000'],
  ])('%s is dotted in its own brand colour', (platform, hex) => {
    expect(PLATFORM_DOT[platform]).toBe(hex);
  });

  // Copying the hexes rather than deriving them is how the dots would drift
  // away from the yardstick the collision guard measures against.
  test('every dot is the brand primary the guard measures against', () => {
    for (const [key, brands] of Object.entries(PLATFORM_BRAND)) {
      expect(PLATFORM_DOT[PLATFORM[key]]).toBe(brands[0]);
    }
  });

  test('every platform has a dot', () => {
    expect(Object.keys(PLATFORM_DOT).sort()).toEqual(Object.values(PLATFORM).sort());
  });

  // The carve-out is the dot role, not a softening of the rule. These same
  // colours must still be rejected anywhere chrome could pick them up.
  // Attribution is deliberately not asserted: Uber Eats' green (H152) and
  // Deliveroo's teal (H175) are 23 degrees apart, inside MIN_HUE_GAP, so each
  // matches whichever brand the guard reaches first. What has to hold is that
  // all three are still refused as chrome.
  test.each(Object.values(PLATFORM))('the guard still rejects %s\'s dot as chrome', (platform) => {
    expect(collidingPlatform(PLATFORM_DOT[platform])).not.toBeNull();
  });

  test('no dot colour leaked into the chrome palette', () => {
    const dots = Object.values(PLATFORM_DOT).map((h) => h.toLowerCase());
    const leaked = Object.entries(THEME).filter(([, v]) => dots.includes(v.toLowerCase()));
    expect(leaked).toEqual([]);
  });

  // Emoji were at the mercy of the host page's font stack; a painted dot is
  // not, but teal and green on white need a rim or they read as smudges.
  test('the dot is drawn as a bordered element, not a glyph', () => {
    const css = read('src/content/sidebar.js');
    expect(css).toMatch(/\.dot\s*{[^}]*border-radius:\s*50%/);
    expect(css).toMatch(/\.dot\s*{[^}]*box-shadow/);
  });

  test('the sidebar no longer renders platform emoji', () => {
    expect(read('src/content/sidebar.js')).not.toMatch(/[\u{1F7E0}-\u{1F7EB}\u{1F535}\u{1F534}]/u);
  });
});

describe('legibility', () => {
  // These carry 9-15px text, which is where the old palette actually hurt:
  // the orange accent was 2.80:1 on white and the winner green 2.28:1, both
  // well under AA, on the logo and on the white-on-fill CHEAPEST badge.
  const onWhite = [
    '--fm-accent', '--fm-accent-strong', '--fm-accent-hover',
    '--fm-win', '--fm-win-text', '--fm-warn', '--fm-text',
    '--fm-text-strong', '--fm-text-muted',
  ];
  test.each(onWhite)('%s meets WCAG AA against the sidebar background', (token) => {
    expect(contrast(THEME[token], THEME['--fm-surface'])).toBeGreaterThanOrEqual(4.5);
  });

  // Fills that carry white text: the Switch CTA, the CHEAPEST badge and pill.
  test.each(['--fm-accent-strong', '--fm-accent-hover', '--fm-win'])(
    'white text on %s meets WCAG AA',
    (token) => {
      expect(contrast(THEME[token], '#ffffff')).toBeGreaterThanOrEqual(4.5);
    },
  );
});

describe('single source of truth', () => {
  // popup.css is static CSS and cannot require the token module, so it
  // redeclares the variables it needs. This is what stops the two drifting.
  test('popup.css redeclares tokens with the same values as the theme module', () => {
    const declared = [...read('popup/popup.css').matchAll(/(--fm-[a-z-]+)\s*:\s*(#[0-9a-fA-F]{3,6})/g)];
    expect(declared.length).toBeGreaterThan(0);
    for (const [, token, value] of declared) {
      expect(THEME).toHaveProperty(token);
      expect(value.toLowerCase()).toBe(THEME[token].toLowerCase());
    }
  });

  // Once a colour is a token, using its literal again is how a palette drifts
  // back apart. Outside the token module and popup.css's :root block, the UI
  // must reference var(--fm-*) rather than name a colour.
  test.each(['src/content/sidebar.js', 'src/background/service-worker.js'])(
    '%s names no colour of its own',
    (rel) => {
      expect(hexesIn(rel)).toEqual([]);
    },
  );

  test('every theme token is referenced somewhere in the UI', () => {
    const usage = UI_SOURCES.filter((r) => r !== 'src/shared/theme.js').map(read).join('\n');
    const unused = Object.keys(THEME).filter((token) => !usage.includes(token));
    expect(unused).toEqual([]);
  });

  // The inverse of the above, and the more dangerous direction: a mistyped
  // var() is not an error, it just yields an invalid declaration and the text
  // silently falls back to whatever it inherited. Nothing at runtime says so.
  test.each(UI_SOURCES)('%s references no token that does not exist', (rel) => {
    const referenced = [...read(rel).matchAll(/var\((--fm-[a-z-]+)\)/g)].map((m) => m[1]);
    const known = { ...THEME, ...dotTokens() };
    expect(referenced.filter((t) => !(t in known))).toEqual([]);
  });

  test('themeCssVars emits every token as a custom property', () => {
    const css = themeCssVars();
    for (const [token, value] of Object.entries({ ...THEME, ...dotTokens() })) {
      expect(css).toContain(`${token}:${value}`);
    }
  });
});
