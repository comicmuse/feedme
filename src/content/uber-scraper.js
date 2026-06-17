// src/content/uber-scraper.js
const { selectNearestBranches } = require('../shared/branches');
const { MSG, PLATFORM } = require('../shared/constants');

// Uber feed lists store cards as links to /gb/store/<slug>/<uuid>. This scraper
// runs only in "enumerate" mode: it reads the rendered feed, builds branch
// candidates, and reports the nearest N. Menu pricing reuses platform-scraper.js.
(async () => {
  if (window.__feedmeUberEnumerated) return;
  window.__feedmeUberEnumerated = true;

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

  const links = await waitFor(() => {
    const found = [...document.querySelectorAll('a[href*="/gb/store/"]')];
    return found.length ? found : null;
  });
  if (!links) {
    chrome.runtime.sendMessage({ type: MSG.BRANCHES_FOUND, platform: PLATFORM.UBER_EATS, branches: [] });
    return;
  }

  // De-dupe by store path; the card's aria-label / text carries the store name
  // and often an ETA/distance line.
  const byHref = new Map();
  for (const a of links) {
    const href = (a.getAttribute('href') || '').split('?')[0];
    if (!href || byHref.has(href)) continue;
    const text = a.getAttribute('aria-label') || a.textContent || '';
    const name = text.split('\n')[0].split('  ')[0].trim();
    const distMatch = text.match(/([\d.]+)\s*mi\b/i);
    byHref.set(href, {
      id: href,
      name,
      label: '',                       // refined against live data in Task 11
      distance: distMatch ? parseFloat(distMatch[1]) : null,
      menuUrl: href,
    });
  }

  const branches = selectNearestBranches([...byHref.values()], ctx.restaurantName ?? '', ctx.branchCount ?? 3)
    .map(({ id, label, distance, menuUrl }) => ({ id, label, distance, menuUrl }));

  chrome.runtime.sendMessage({ type: MSG.BRANCHES_FOUND, platform: PLATFORM.UBER_EATS, branches });
})();
