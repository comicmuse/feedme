// src/content/uber-scraper.js
const { selectNearestBranches, nameTokens } = require('../shared/branches');
const { MSG, PLATFORM } = require('../shared/constants');
const { parseUberStore } = require('../shared/parsers');

// Uber feed lists store cards as links to /gb/store/<slug>/<uuid>. This scraper
// runs in two modes, keyed by URL:
//   - enumerate (feed page): read the rendered store cards, report nearest-N branches
//   - menu (a /gb/store/ page): read the Schema.org Restaurant JSON-LD and report
//     the priced catalogue. (The store page server-renders its catalogue into a
//     custom-escaped, non-interceptable blob; the JSON-LD is the clean source.)

// The store name on a feed card lives in its heading element. Feed cards usually
// carry no aria-label, so the previous textContent fallback concatenated the name
// with the rating/ETA/fee (no separators) and never brand-matched. Prefer the
// heading, then aria-label, then the first text line as a last resort.
function cardName(a) {
  const heading = a.querySelector('h1, h2, h3, h4, h5, h6, [role="heading"]');
  const headingText = heading?.textContent.trim();
  if (headingText) return headingText;
  const text = a.getAttribute('aria-label') || a.textContent || '';
  return text.split('\n')[0].split('  ')[0].trim();
}

// Pure: read the rendered feed and return de-duped store cards (by store path).
function extractUberStoreCards(doc) {
  const byHref = new Map();
  for (const a of doc.querySelectorAll('a[href*="/gb/store/"]')) {
    const href = (a.getAttribute('href') || '').split('?')[0];
    if (!href || byHref.has(href)) continue;
    const text = a.getAttribute('aria-label') || a.textContent || '';
    const distMatch = text.match(/([\d.]+)\s*mi\b/i);
    byHref.set(href, {
      id: href,
      name: cardName(a),
      label: '',                       // refined against live data in Task 11
      distance: distMatch ? parseFloat(distMatch[1]) : null,
      menuUrl: href,
    });
  }
  return [...byHref.values()];
}

async function runUberScraper() {
  const ctx = window.__feedmeCompare ?? {};

  function waitFor(fn, timeout = 8000, interval = 200) {
    return new Promise((resolve) => {
      const start = Date.now();
      const tick = () => {
        let v = null;
        try { v = fn(); } catch (_) {}
        if (v) return resolve(v);
        if (Date.now() - start > timeout) return resolve(null);
        setTimeout(tick, interval);
      };
      tick();
    });
  }

  // MENU mode — a store page for a (non-cart) branch.
  if (window.location.pathname.includes('/store/')) {
    if (window.__feedmeUberStoreParsed) return;
    window.__feedmeUberStoreParsed = true;

    const ld = await waitFor(() => {
      for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
        try {
          const j = JSON.parse(s.textContent);
          if (j && j['@type'] === 'Restaurant' && j.hasMenu) return j;
        } catch (_) {}
      }
      return null;
    });
    if (!ld) {
      chrome.runtime.sendMessage({ type: MSG.PLATFORM_DATA, platform: PLATFORM.UBER_EATS, error: 'no-ld-menu', sourceUrl: window.location.href });
      return;
    }
    chrome.runtime.sendMessage({
      type: MSG.PLATFORM_DATA, platform: PLATFORM.UBER_EATS, classification: 'menu',
      parsed: parseUberStore(ld), sourceUrl: window.location.href,
    });
    return;
  }

  // ENUMERATE mode — search results page.
  if (window.__feedmeUberEnumerated) return;
  window.__feedmeUberEnumerated = true;

  // The search page interleaves generic "you might also like" recommendations with
  // the brand's own results, and they stream in over time. Resolving on the first
  // /gb/store/ link snapshots a recommendation before the chain's branches render
  // (the old storeCards=1, matched=0 failure). Instead wait until a card actually
  // matches the brand — then the real results are present — and fall back to
  // whatever is there at timeout.
  const brand = nameTokens(ctx.restaurantName ?? '')[0] || '';
  const ready = await waitFor(() => {
    const found = extractUberStoreCards(document);
    if (!found.length) return null;
    if (!brand) return found;
    return found.some((c) => nameTokens(c.name)[0] === brand) ? found : null;
  });
  if (!ready) {
    chrome.runtime.sendMessage({ type: MSG.BRANCHES_FOUND, platform: PLATFORM.UBER_EATS, branches: [] });
    return;
  }

  const cards = extractUberStoreCards(document);
  // Use the card heading as the branch label. The store-page JSON-LD name is just
  // the bare brand for some branches ("Subway" for Crossrail Place), whereas the
  // feed heading carries the locality ("Subway (Crossrail Place)").
  const branches = selectNearestBranches(cards, ctx.restaurantName ?? '', ctx.branchCount ?? 3)
    .map(({ id, name, distance, menuUrl }) => ({ id, label: name, distance, menuUrl }));

  chrome.runtime.sendMessage({ type: MSG.BRANCHES_FOUND, platform: PLATFORM.UBER_EATS, branches });
}

// Browser entry point — runs only in the extension content-script context.
if (typeof window !== 'undefined' && typeof chrome !== 'undefined') {
  runUberScraper();
}

module.exports = { extractUberStoreCards };
