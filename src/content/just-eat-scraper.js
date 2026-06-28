const { selectNearestBranches, justEatCandidates } = require('../shared/branches');
const { MSG, PLATFORM } = require('../shared/constants');
const { parseMenuResponse } = require('../shared/parsers');

// Just Eat, like Deliveroo, server-renders its menu into __NEXT_DATA__ and destroys
// the JS context on each navigation, so the service worker re-injects this script
// on every load. It's simpler than Deliveroo — no geocode step, the area listing is
// directly addressable:
//
//   1. listing (/area/{postcode}) — enumerate mode: report the nearest-N branches
//   2. menu (/.../menu)            — menu mode: read __NEXT_DATA__ for items, fetch
//                                    the menu/dynamic API for the exact fees, report
//
// The target order is provided by the service worker as window.__feedmeCompare.

(async () => {
  const path = window.location.pathname;

  // Guard against running the same phase twice (keyed by pathname).
  if (window.__feedmeJustEatPhase === path) return;
  window.__feedmeJustEatPhase = path;

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

  const ctx = window.__feedmeCompare ?? {};

  // ENUMERATE — area listing: report the nearest-N branches, do not navigate.
  if (path.startsWith('/area/')) {
    const blob = await waitFor(() => {
      const text = document.querySelector('#__NEXT_DATA__')?.textContent;
      return text && text.includes('restaurantData') ? text : null;
    });
    if (!blob) {
      // Report rather than return silently — otherwise the platform only ends via
      // the enum timeout.
      chrome.runtime.sendMessage({ type: MSG.BRANCHES_FOUND, platform: PLATFORM.JUST_EAT, branches: [] });
      return;
    }

    let branches = [];
    try {
      const data = JSON.parse(blob);
      const cands = justEatCandidates(data);
      branches = selectNearestBranches(cands, ctx.restaurantName ?? '', ctx.branchCount ?? 3)
        .map(({ id, label, distance, menuUrl }) => ({ id, label, distance, menuUrl }));
    } catch (_) {}

    chrome.runtime.sendMessage({ type: MSG.BRANCHES_FOUND, platform: PLATFORM.JUST_EAT, branches });
    return;
  }

  // PHASE 2 — menu: parse the embedded catalogue and fetch the fee rules.
  if (path.includes('/menu')) {
    const blob = await waitFor(() => {
      const text = document.querySelector('#__NEXT_DATA__')?.textContent;
      // Wait for the fully server-rendered version that includes the catalogue.
      return text && text.includes('preloadedState') && /"cdn"/.test(text) ? text : null;
    });
    if (!blob) return;

    let data;
    try {
      data = JSON.parse(blob);
    } catch (_) {
      return;
    }

    // Fetch the exact fee rules (delivery band + service fee formula) and current
    // offers. Same-origin CORS lets the just-eat.co.uk page call these; failures
    // just leave fees at 0 / offers empty.
    const restaurantId = data?.props?.appProps?.preloadedState?.menu?.restaurant?.cdn?.restaurant?.restaurantId;
    if (restaurantId) {
      const dynamicReq = fetch(
        `https://uk.api.just-eat.io/restaurant/uk/${restaurantId}/menu/dynamic?orderTime=${new Date().toISOString()}`
      )
        .then((r) => r.json())
        .then((d) => {
          data._feedmeDynamic = d;
        })
        .catch(() => {});
      const offersReq = fetch(
        `https://uk.api.just-eat.io/consumeroffers/notifications/uk?restaurantIds=${restaurantId}&optionalProperties=offerMenuItems`
      )
        .then((r) => r.json())
        .then((d) => {
          data._feedmeOffers = d?.offerNotifications ?? [];
        })
        .catch(() => {});

      // Large menus ship an empty cdn.items and defer the full catalogue + modifier
      // details to a CDN (PascalCase). Fetch them so the order can still be priced.
      const cdn = data.props.appProps.preloadedState.menu.restaurant.cdn;
      const reqs = [dynamicReq, offersReq];
      if (!Object.keys(cdn.items ?? {}).length && cdn.restaurant?.itemsUrl) {
        const base = 'https://menu-globalmenucdn.je-apis.com/';
        reqs.push(
          fetch(base + cdn.restaurant.itemsUrl)
            .then((r) => r.json())
            .then((d) => {
              data._feedmeItems = d?.Items ?? [];
            })
            .catch(() => {})
        );
        if (cdn.restaurant.itemDetailsUrl) {
          reqs.push(
            fetch(base + cdn.restaurant.itemDetailsUrl)
              .then((r) => r.json())
              .then((d) => {
                data._feedmeItemDetails = d;
              })
              .catch(() => {})
          );
        }
      }
      await Promise.all(reqs);
    }

    let parsed;
    try {
      parsed = parseMenuResponse(PLATFORM.JUST_EAT, data);
    } catch (_) {
      return;
    }

    chrome.runtime.sendMessage({
      type: MSG.PLATFORM_DATA,
      platform: PLATFORM.JUST_EAT,
      classification: 'menu',
      parsed,
      sourceUrl: window.location.href,
    });
  }
})();
