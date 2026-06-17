const { selectNearestBranches } = require('../shared/branches');
const { MSG, PLATFORM } = require('../shared/constants');
const { parseMenuResponse } = require('../shared/parsers');

// Deliveroo can't be reached with a single URL: there is no menu page derivable
// from a restaurant name + postcode. Instead this scraper drives the site like a
// user across three full page loads (the JS context is destroyed each navigation,
// so the background service worker re-injects this script on every load):
//
//   1. homepage  — type the postcode, pick the first Places suggestion
//   2. listing   — fuzzy-match the target restaurant, open its menu
//   3. menu      — read the server-rendered __NEXT_DATA__ blob, parse, report
//
// The target order is provided by the service worker as window.__feedmeCompare.

(async () => {
  const path = window.location.pathname;

  // Guard against running the same phase twice. Keyed by pathname (not a bare
  // boolean) so that if a transition turns out to be an SPA route within one
  // document, a later phase still runs instead of being blocked by phase 1.
  if (window.__feedmeDeliverooPhase === path) return;
  window.__feedmeDeliverooPhase = path;

  const target = window.__feedmeCompare ?? {};

  // Poll until fn() returns a truthy value or the timeout elapses.
  function waitFor(fn, timeout = 8000, interval = 200) {
    return new Promise((resolve) => {
      const start = Date.now();
      const tick = () => {
        let value = null;
        try {
          value = fn();
        } catch (_) {}
        if (value) return resolve(value);
        if (Date.now() - start > timeout) return resolve(null);
        setTimeout(tick, interval);
      };
      tick();
    });
  }

  // Set a React-controlled input's value so the framework notices the change.
  function setInputValue(input, value) {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value'
    ).set;
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // PHASE 1 — homepage: enter postcode and select the first suggestion.
  if (path === '/' || path === '') {
    const input = await waitFor(() => document.querySelector('#location-search'));
    if (!input) return;
    setInputValue(input, target.postcode ?? '');

    const suggestion = await waitFor(() =>
      [...document.querySelectorAll('li')].find((li) => /,\s*UK\s*$/i.test(li.textContent.trim()))
    );
    if (!suggestion) return;
    const clickable = suggestion.querySelector('button, a, [role="button"]') ?? suggestion;
    clickable.click(); // navigates to the listing page (re-injection follows)
    return;
  }

  // PHASE 2 — listing: fuzzy-match the restaurant and open its menu.
  if (path.startsWith('/restaurants/')) {
    const links = await waitFor(() => {
      const found = [...document.querySelectorAll('a[href*="/menu/"]')];
      return found.length ? found : null;
    });
    if (!links) return;

    // The listing lazy-loads restaurants on scroll; load more so a target further
    // down isn't missed (and we don't open the wrong one).
    for (let i = 0; i < 6; i += 1) {
      window.scrollTo(0, document.body.scrollHeight);
      await new Promise((r) => setTimeout(r, 500));
    }

    const ctx = window.__feedmeCompare ?? {};
    const candidates = [...document.querySelectorAll('a[href*="/menu/"]')]
      .map((a) => {
        const label = a.getAttribute('aria-label') ?? a.textContent ?? '';
        // Labels read "Name. 0.3 mi. Delivers at 15. Rated 4.8..."
        const parts = label.split('. ');
        const name = parts[0].trim();
        const distMatch = label.match(/([\d.]+)\s*mi\b/i);
        const href = a.getAttribute('href') || '';
        return {
          id: href,                       // the menu path uniquely identifies a branch
          name,
          label: (parts[1] || '').trim(), // area / "0.3 mi" segment; refined in Task 11
          distance: distMatch ? parseFloat(distMatch[1]) : null,
          menuUrl: href,
        };
      })
      .filter((c) => c.name && c.menuUrl);

    const branches = selectNearestBranches(candidates, ctx.restaurantName ?? '', ctx.branchCount ?? 3)
      .map(({ id, label, distance, menuUrl }) => ({ id, label, distance, menuUrl }));

    chrome.runtime.sendMessage({ type: MSG.BRANCHES_FOUND, platform: PLATFORM.DELIVEROO, branches });
    return;
  }

  // PHASE 3 — menu: parse the embedded data and report back.
  if (path.startsWith('/menu/')) {
    const blob = await waitFor(() => document.querySelector('#__NEXT_DATA__')?.textContent);
    if (!blob) return;

    let parsed;
    try {
      parsed = parseMenuResponse(PLATFORM.DELIVEROO, JSON.parse(blob));
    } catch (_) {
      return;
    }

    chrome.runtime.sendMessage({
      type: MSG.PLATFORM_DATA,
      platform: PLATFORM.DELIVEROO,
      classification: 'menu',
      parsed,
      sourceUrl: window.location.href,
    });
  }
})();
