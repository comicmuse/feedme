const { selectNearestBranches } = require('../shared/branches');
const { MSG, PLATFORM, browser } = require('../shared/constants');
const { parseMenuResponse, parseDeliverooSearch } = require('../shared/parsers');
const { enumLog } = require('../shared/enum-log');

// Location comes from the listing URL phase 1 navigated to
// (/restaurants/{city}/{neighborhood}?...&geohash=...).
function deliverooSearchLocation() {
  const u = new URL(window.location.href);
  const seg = u.pathname.split('/'); // ['', 'restaurants', city, neighborhood]
  return {
    geohash: u.searchParams.get('geohash') || '',
    city_uname: seg[2] || '',
    neighborhood_uname: seg[3] || '',
    postcode: '',
  };
}

// The API host is cross-origin and PerimeterX-guarded, so the actual fetch runs
// in the service worker (host_permissions exempts it from CORS; a content-script
// POST does not get that bypass in Firefox MV3). We hand it the brand + location
// and get back { json } or { error }.
async function deliverooSearch(brand) {
  const location = deliverooSearchLocation();
  if (!location.geohash) return { json: null, error: 'no geohash on listing URL' };
  const reply = await browser.runtime.sendMessage({ type: MSG.DELIVEROO_SEARCH, brand, location })
    .catch((err) => ({ error: String((err && err.message) || err) }));
  return { json: reply?.json ?? null, error: reply?.error ?? null };
}

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
    if (!input) {
      enumLog(PLATFORM.DELIVEROO, 'phase 1: no #location-search input on the homepage after 8s — homepage did not load as expected');
      chrome.runtime.sendMessage({ type: MSG.BRANCHES_FOUND, platform: PLATFORM.DELIVEROO, branches: [] });
      return;
    }
    setInputValue(input, target.postcode ?? '');

    const suggestion = await waitFor(() =>
      [...document.querySelectorAll('li')].find((li) => /,\s*UK\s*$/i.test(li.textContent.trim()))
    );
    if (!suggestion) {
      enumLog(PLATFORM.DELIVEROO, `phase 1: postcode "${target.postcode ?? ''}" produced no ", UK" address suggestion — the Places lookup did not resolve`, { postcode: target.postcode ?? '' });
      chrome.runtime.sendMessage({ type: MSG.BRANCHES_FOUND, platform: PLATFORM.DELIVEROO, branches: [] });
      return;
    }
    const clickable = suggestion.querySelector('button, a, [role="button"]') ?? suggestion;
    clickable.click(); // navigates to the listing page (re-injection follows)
    return;
  }

  // PHASE 2 — listing: replay Deliveroo's own text_search GraphQL query and parse
  // the JSON, rather than typing into the search box and scraping rendered links.
  // A cross-origin fetch to the API host (granted in host_permissions) is immune
  // to the first-order promo modal and the background-tab render throttling that
  // hid search results from the old DOM-scrape path — which silently dropped every
  // chain not already in the ~18 curated landing cards (#131). selectNearestBranches
  // still filters to the target brand exactly as before.
  if (path.startsWith('/restaurants/')) {
    const ctx = window.__feedmeCompare ?? {};
    const brand = (ctx.restaurantName ?? '').trim().split(/\s+/)[0] || '';

    const { json, error } = await deliverooSearch(brand);
    if (!json) {
      enumLog(PLATFORM.DELIVEROO, `phase 2: search request did not return data (${error})`, { brand });
      chrome.runtime.sendMessage({ type: MSG.BRANCHES_FOUND, platform: PLATFORM.DELIVEROO, branches: [] });
      return;
    }

    const candidates = parseDeliverooSearch(json).map((r) => {
      const href = r.menuUrl;
      const areaSeg = href.split('?')[0].split('/')[3] || '';
      const label = areaSeg.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
      return { id: href.split('?')[0], name: r.name, label, distance: r.distance, menuUrl: href };
    }).filter((c) => c.name && c.menuUrl);

    const branches = selectNearestBranches(candidates, ctx.restaurantName ?? '', ctx.branchCount ?? 3)
      .map(({ id, label, distance, menuUrl }) => ({ id, label, distance, menuUrl }));

    enumLog(PLATFORM.DELIVEROO, `phase 2: reporting ${branches.length} branch(es) from ${candidates.length} search result(s)`, { brand, branchCount: branches.length, candidateCount: candidates.length });
    chrome.runtime.sendMessage({ type: MSG.BRANCHES_FOUND, platform: PLATFORM.DELIVEROO, branches });
    return;
  }

  // PHASE 3 — menu: parse the embedded data and report back.
  if (path.startsWith('/menu/')) {
    const blob = await waitFor(() => document.querySelector('#__NEXT_DATA__')?.textContent);
    if (!blob) {
      enumLog(PLATFORM.DELIVEROO, 'menu: #__NEXT_DATA__ never appeared on the branch menu page — branch cannot be priced');
      return;
    }

    let parsed;
    try {
      parsed = parseMenuResponse(PLATFORM.DELIVEROO, JSON.parse(blob));
    } catch (err) {
      enumLog(PLATFORM.DELIVEROO, 'menu: __NEXT_DATA__ present but failed to parse', { error: String(err && err.message || err) });
      return;
    }

    chrome.runtime.sendMessage({
      type: MSG.PLATFORM_DATA,
      platform: PLATFORM.DELIVEROO,
      classification: 'menu',
      parsed,
      sourceUrl: window.location.href,
    });
    return;
  }

  // None of the three phases matched this path — the multi-step flow landed
  // somewhere unexpected (a redirect off the homepage/listing, a consent wall),
  // so the scraper would otherwise exit with no trace but the 15s enum timeout.
  enumLog(PLATFORM.DELIVEROO, `ran but matched no phase for path "${path}" — the flow was redirected before it could be read`, { path });
})();
