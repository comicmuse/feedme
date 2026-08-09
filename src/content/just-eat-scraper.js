const { readCompleteAreaListing, classifyAreaEnumeration } = require('../shared/branches');
const { MSG, PLATFORM, isJeApiUrl } = require('../shared/constants');
const { parseMenuResponse } = require('../shared/parsers');
const { enumLog } = require('../shared/enum-log');

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
    // Poll until a COMPLETE, location-resolved __NEXT_DATA__ arrives. Just Eat
    // keeps rewriting the blob after readyState:"complete", so the old gate
    // (text.includes('restaurantData'), a substring near the start) fired on a
    // partial read: JSON.parse then threw on the torn ~5 MB blob and the failure
    // was swallowed as an empty area, carrying no Retry (#105). The predicate
    // returns the parsed data only once it parses AND has real candidates, so a
    // truncated or pre-location read simply keeps the poll waiting.
    const data = await waitFor(() =>
      readCompleteAreaListing(document.querySelector('#__NEXT_DATA__')?.textContent));

    const outcome = classifyAreaEnumeration(data, ctx.restaurantName ?? '', ctx.branchCount ?? 3);
    if (outcome.status === 'unreadable') {
      // No complete, candidate-bearing listing ever arrived — the listing failed
      // to load or would not parse (a slow hydrate in a background tab is an
      // ordinary event for a 5 MB blob). This is NOT "no branches found": surface
      // it as retryable, the same state the enum timeout produces, so the sidebar
      // shows a Retry ↻ instead of a confident false negative (#105). One final
      // read names WHY for the log, rather than the parse failure staying silent.
      const text = document.querySelector('#__NEXT_DATA__')?.textContent;
      let reason = text ? 'present but incomplete/unparseable' : 'never appeared';
      if (text) { try { JSON.parse(text); reason = 'parsed but location unresolved (0 candidates)'; } catch (err) { reason = `parse failed — ${String(err && err.message || err)}`; } }
      enumLog(PLATFORM.JUST_EAT, `enumerate: no complete area listing after 8s (${reason}) — reporting as retryable, not empty (#105)`, { length: text ? text.length : 0 });
      chrome.runtime.sendMessage({ type: MSG.BRANCHES_ERROR, platform: PLATFORM.JUST_EAT });
      return;
    }

    const branches = outcome.branches ?? [];
    enumLog(PLATFORM.JUST_EAT, `enumerate: reporting ${branches.length} branch(es) from ${outcome.candidateCount} listed restaurant(s)`, { branchCount: branches.length, candidateCount: outcome.candidateCount });
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
    if (!blob) {
      enumLog(PLATFORM.JUST_EAT, 'menu: server-rendered __NEXT_DATA__ (preloadedState + cdn) never appeared — branch cannot be priced');
      return;
    }

    let data;
    try {
      data = JSON.parse(blob);
    } catch (err) {
      enumLog(PLATFORM.JUST_EAT, 'menu: __NEXT_DATA__ present but failed to parse', { error: String(err && err.message || err) });
      return;
    }

    // Fetch the exact fee rules (delivery band + service fee formula) and current
    // offers. Same-origin CORS lets the just-eat.co.uk page call these; failures
    // just leave fees at 0 / offers empty.
    const rawRestaurantId = data?.props?.appProps?.preloadedState?.menu?.restaurant?.cdn?.restaurant?.restaurantId;
    // restaurantId comes from the page's own __NEXT_DATA__ and is interpolated
    // straight into request paths/query strings below; reject anything that isn't
    // a bare numeric id rather than trusting a potentially-tampered page.
    const restaurantId = /^\d+$/.test(String(rawRestaurantId)) ? rawRestaurantId : null;
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
        // itemsUrl/itemDetailsUrl are also page-supplied — a plain string
        // concatenation onto a fixed origin can't itself redirect elsewhere, but
        // assert it explicitly so a later refactor (e.g. to new URL()) can't
        // silently reopen that door.
        const itemsUrl = base + cdn.restaurant.itemsUrl;
        if (isJeApiUrl(itemsUrl)) {
          reqs.push(
            fetch(itemsUrl)
              .then((r) => r.json())
              .then((d) => {
                data._feedmeItems = d?.Items ?? [];
              })
              .catch(() => {})
          );
        }
        if (cdn.restaurant.itemDetailsUrl) {
          const itemDetailsUrl = base + cdn.restaurant.itemDetailsUrl;
          if (isJeApiUrl(itemDetailsUrl)) {
            reqs.push(
              fetch(itemDetailsUrl)
                .then((r) => r.json())
                .then((d) => {
                  data._feedmeItemDetails = d;
                })
                .catch(() => {})
            );
          }
        }
      }
      await Promise.all(reqs);
    }

    let parsed;
    try {
      parsed = parseMenuResponse(PLATFORM.JUST_EAT, data);
    } catch (err) {
      enumLog(PLATFORM.JUST_EAT, 'menu: catalogue parse threw after data loaded', { error: String(err && err.message || err) });
      return;
    }

    chrome.runtime.sendMessage({
      type: MSG.PLATFORM_DATA,
      platform: PLATFORM.JUST_EAT,
      classification: 'menu',
      parsed,
      sourceUrl: window.location.href,
    });
    return;
  }

  // Neither phase matched. The enum tab opened on /area/{postcode}/restaurants
  // but is now somewhere else, so Just Eat redirected it before the scraper could
  // read anything — a logged-out location gate, a consent wall, or an off-listing
  // bounce. Without this the scraper exits silently and the only trace is the
  // service worker's 15s enum timeout (#80/#112).
  enumLog(PLATFORM.JUST_EAT, `ran but matched no phase for path "${path}" — the area listing was redirected before it could be read`, { path });
})();
