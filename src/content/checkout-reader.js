const { PLATFORM, MSG, platformFromUrl } = require('../shared/constants');
const {
  uberCompositionDefaults,
  uberRemovals,
  uberCartItemIds,
  normalizeTitle,
} = require('../shared/uber-composition');

const UBER_DRAFTS_API = '/_p/api/getDraftOrdersByEaterUuidV1?localeCode=gb';
const UBER_ITEM_API = '/_p/api/getMenuItemV1?localeCode=gb';
// The capture blocks the sidebar's first render, so a hung request must not hold
// it open — a timed-out call is treated exactly like a failed one. This is the
// budget for the WHOLE enrichment, not per call: the item fetches run in
// sequence, so a per-call timeout would put the worst case at 4s x (1 + items).
// Every call races the time remaining against one deadline set at the start.
const UBER_API_TIMEOUT = 4000;

// Same-origin POST to one of Uber's own web APIs, abandoned at `deadline`
// (epoch ms). Resolves the parsed body, or null on any failure (non-200,
// network error, timeout, unparseable). Never rejects: the capture must not
// throw, and no removals is a correct answer.
function uberPost(fetchFn, url, body, deadline) {
  // Started inside a resolved promise so a SYNCHRONOUS throw from fetchFn
  // (e.g. Chrome's "Illegal invocation" when fetch is called unbound) lands in
  // the .catch below instead of escaping the chain outright.
  const request = Promise.resolve()
    .then(() => fetchFn(url, {
      method: 'POST',
      // The drafts endpoint is authenticated. A content script's fetch defaults
      // to 'same-origin', which Chrome may treat as extension-initiated and
      // strip the session cookie from — be explicit (#33 review).
      credentials: 'include',
      headers: { 'content-type': 'application/json', 'x-csrf-token': 'x' },
      body: JSON.stringify(body),
    }))
    .then((r) => (r && r.ok ? r.json() : null))
    .catch(() => null);
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), Math.max(0, deadline - Date.now()));
  });
  return Promise.race([request, timeout]).then((result) => {
    clearTimeout(timer);
    return result;
  });
}

// Uber's cart lists only the KEPT defaults of a composition group, so an
// ingredient the user removed is visible only as an absence. Fetch the item's
// full defaults and append the difference as decline options the target's
// "Remove" group can satisfy (#33). Bounded: one draft-order call for the whole
// cart, then one item call per distinct composition-bearing item. Any failure
// leaves the items untouched, which is the pre-#33 behaviour.
async function addUberRemovals(doc, items) {
  const needing = items.filter((i) => i._compositionRows.length);
  // The page's own fetch, with deliberately no global-fetch fallback (that would
  // fire real requests in tests). Bound to the window: an unbound page `fetch`
  // throws "Illegal invocation" in Chrome, and a synchronous throw would escape
  // the promise chain in uberPost.
  const rawFetch = doc.defaultView?.fetch;
  if (!needing.length || typeof rawFetch !== 'function') return;
  const fetchFn = rawFetch.bind(doc.defaultView);
  const deadline = Date.now() + UBER_API_TIMEOUT;
  // The capture must never throw: a drifted response shape (wrong type where
  // an array/object was expected) can raise downstream in uberCompositionDefaults
  // / uberRemovals just as easily as a network failure can, and no removals is
  // the correct answer either way — so the whole enrichment is best-effort.
  try {
    const drafts = await uberPost(fetchFn, UBER_DRAFTS_API, {}, deadline);
    if (!drafts) {
      console.info('[FeedMe checkout] no draft-order response — skipping Uber removals');
      return;
    }
    // The response holds every cart the user has open, so the captured item
    // names are what pick this store's draft out of it.
    const idsByTitle = uberCartItemIds(drafts?.data?.draftOrders, items.map((i) => i.name));
    const detailByItem = new Map();
    for (const item of needing) {
      const ids = idsByTitle.get(normalizeTitle(item.name));
      if (!ids) {
        console.info('[FeedMe checkout] no draft-order ids for', JSON.stringify(item.name));
        continue;
      }
      if (!detailByItem.has(ids.itemUuid)) {
        detailByItem.set(
          ids.itemUuid,
          await uberPost(fetchFn, UBER_ITEM_API, {
            itemRequestType: 'ITEM',
            storeUuid: ids.storeUuid,
            sectionUuid: ids.sectionUuid,
            subsectionUuid: ids.subsectionUuid,
            menuItemUuid: ids.itemUuid,
            isEditFlow: false,
            cbType: 'EATER_ENDORSED',
            includeCheaperAlternatives: false,
          }, deadline)
        );
      }
      const detail = detailByItem.get(ids.itemUuid);
      if (!detail) {
        console.info('[FeedMe checkout] no item detail for', JSON.stringify(item.name));
        continue;
      }
      const removals = uberRemovals(item._compositionRows, uberCompositionDefaults(detail));
      if (removals.length) {
        console.info('[FeedMe checkout] removals on', JSON.stringify(item.name), '—',
          removals.map((r) => r.name).join(', '));
        item.options.push(...removals);
      }
    }
  } catch (_) {
    // Drifted shape somewhere downstream — leave items untouched.
  }
}

function parsePrice(text) {
  // If multiple prices exist (e.g. "£0.99  £0.00" with a strikethrough), take the last one
  const matches = [...(text ?? '').matchAll(/£?([\d.]+)/g)].map(m => parseFloat(m[1]));
  return matches[matches.length - 1] ?? 0;
}

function waitForElement(doc, selector, timeout = 10000) {
  return new Promise((resolve) => {
    const existing = doc.querySelector(selector);
    if (existing) { resolve(existing); return; }
    const timer = setTimeout(() => { mo.disconnect(); resolve(null); }, timeout);
    const MO = doc.defaultView?.MutationObserver ?? MutationObserver;
    const mo = new MO(() => {
      const found = doc.querySelector(selector);
      if (found) { clearTimeout(timer); mo.disconnect(); resolve(found); }
    });
    mo.observe(doc.body, { childList: true, subtree: true });
  });
}

// Resolves true once predicate() holds, or false after a bounded timeout.
function waitUntil(doc, predicate, timeout) {
  return new Promise((resolve) => {
    if (predicate()) { resolve(true); return; }
    const timer = setTimeout(() => { mo.disconnect(); resolve(false); }, timeout);
    const MO = doc.defaultView?.MutationObserver ?? MutationObserver;
    const mo = new MO(() => {
      if (predicate()) { clearTimeout(timer); mo.disconnect(); resolve(true); }
    });
    mo.observe(doc.body, { childList: true, subtree: true });
  });
}

// A dotted identifier with no spaces (e.g. "store.shared.backToStore") is a
// raw i18n key that leaked before translations hydrated — never a real name.
const I18N_KEY = /^[\w-]+(\.[\w-]+)+$/;

// Derive a usable name from the store-link slug: /gb/store/kfc-bethnal-green/id
// → "kfc bethnal green". Correct the moment the href exists, independent of
// i18n hydration; enumeration matches on lowercase tokens so the slug is usable.
function storeSlugName(href) {
  const segs = (href || '').split('?')[0].split('/').filter(Boolean);
  const i = segs.indexOf('store');
  const slug = i >= 0 && i + 1 < segs.length ? segs[i + 1] : '';
  return slug.replace(/-/g, ' ').trim();
}

// Read the Uber restaurant identity from the store links. `hydrated` is false
// while the name is still a raw i18n key, so callers can wait for it to resolve.
function readUberRestaurant(doc) {
  const storeLinks = [...doc.querySelectorAll('a[href*="/store/"]')];
  // Pick the store link that is neither the "Back to store" nav link nor a link
  // still showing a raw key. The back link is first in the DOM, so before this
  // guard a leaked key (which slips past /back to store/i) got chosen as the name.
  const restLink =
    storeLinks.find((a) => {
      const t = a.textContent.trim();
      return t && !/back to store/i.test(t) && !I18N_KEY.test(t);
    }) ?? storeLinks[0];
  const href = restLink?.getAttribute('href') ?? '';
  // The name is the first leaf element with text; the address follows in a
  // sibling <p>, so we can't just read the link's whole textContent.
  const nameLeaf = restLink
    ? [...restLink.querySelectorAll('*')].find(
        (e) => e.children.length === 0 && e.textContent.trim()
      )
    : null;
  const leaf = nameLeaf?.textContent.trim() ?? restLink?.textContent.trim() ?? '';
  const hydrated = !!leaf && !I18N_KEY.test(leaf);
  // The store UUID (last path segment) identifies this exact branch, so the
  // enumerator can drop it from the Uber column (avoids showing it twice).
  const sourceStoreId = href.split('?')[0].split('/').filter(Boolean).pop() ?? '';
  return { name: hydrated ? leaf : storeSlugName(href), sourceStoreId, hydrated };
}

// Every fare row this reader knows about — the ones it reads, plus the labels and
// siblings it deliberately ignores.
const KNOWN_UBER_FARE_ROWS = new Set([
  'fare-breakdown-charge-badge-subtotal',
  'fare-breakdown-charge-badge-subtotal-label',
  'fare-breakdown-charge-badge-delivery-fee',
  'fare-breakdown-charge-badge-delivery-fee-label',
  'fare-breakdown-charge-badge-fees',
  'fare-breakdown-charge-badge-fees-label',
  'fare-breakdown-charge-badge-total',
  'fare-breakdown-charge-badge-total-label',
  'fare-breakdown-charge-badge-uber-one-monthly-benefit',
  'fare-breakdown-charge-badge-uber-one-monthly-benefit-label',
  'fare-breakdown-charge-badge-uber-one-credits',
  'fare-breakdown-charge-badge-uber-one-credits-label',
]);

// Uber's checkout testids have drifted twice (#53/#55, #55's name element and #65's
// membership row), and both times it failed silently: a missing data-testid reads
// as "no such row", which is indistinguishable from a cart that genuinely lacks it,
// so neither the tests nor the console noticed — the fixtures kept passing precisely
// because they had frozen the old DOM.
//
// Asserting that required rows exist would NOT have caught #65, whose vanished row
// was a conditional one. The signal that would have is the inverse: a fare row on
// the page this reader has no mapping for, which is exactly what a rename looks
// like from here. The missing-total check is a cheap second net for a wholesale
// change. Both only report — the reader must never throw (#70).
function reportFareRowDrift(doc) {
  const seen = [...doc.querySelectorAll('[data-testid^="fare-breakdown-charge-badge-"]')]
    .map((el) => el.getAttribute('data-testid'));
  const unknown = [...new Set(seen)].filter((id) => !KNOWN_UBER_FARE_ROWS.has(id));
  if (unknown.length) {
    console.warn('[FeedMe checkout] unrecognised fare row — Uber may have renamed a testid:',
      unknown.join(', '));
  }
  if (!seen.includes('fare-breakdown-charge-badge-total')) {
    console.warn('[FeedMe checkout] no total fare row on the page — checkout DOM has drifted');
  }
}

async function extractUberEats(doc) {
  // Wait for React to render the checkout UI (SPA loads a spinner first)
  const panel = await waitForElement(doc, '[data-testid="cart-summary-panel"]');
  if (!panel) return { platform: PLATFORM.UBER_EATS, restaurantName: '', postcode: '', items: [], deliveryFee: 0, serviceFee: 0, discounts: [], checkoutTotal: 0 };

  // Cart items are lazy-loaded inside the panel — expand it if needed
  if (!doc.querySelector('[data-testid="cart-items-list"]')) {
    const toggle = doc.querySelector('[data-testid="cart_summary_toggle"]');
    if (toggle) {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 3000);
        const mo = new MutationObserver(() => {
          if (doc.querySelector('[data-testid="cart-items-list"]')) {
            clearTimeout(timer);
            mo.disconnect();
            resolve();
          }
        });
        mo.observe(doc.body, { childList: true, subtree: true });
        toggle.click();
      });
    }
  }

  // Fee breakdown may load in a second async phase — wait for it before reading prices
  await waitForElement(doc, '[data-testid="fare-breakdown-charge-badge-total"]', 5000);

  const itemsList = doc.querySelector('[data-testid="cart-items-list"]');
  const items = itemsList
    ? [...itemsList.querySelectorAll('[data-testid^="cart-item-"]')]
        .map((el) => {
          const name = el.querySelector('img')?.alt?.trim() ?? '';
          // Line total is a bare price span (e.g. "£27.39"); modifier prices are
          // inside parentheses (e.g. "Medium 11.5\" (£13.00)") so we match only
          // spans whose entire text is a price. Take the last (handles strikethrough).
          const priceSpans = [...el.querySelectorAll('span')].filter((s) =>
            /^£\d+(\.\d+)?$/.test(s.textContent.trim())
          );
          const lineTotal = priceSpans.length
            ? parsePrice(priceSpans[priceSpans.length - 1].textContent)
            : 0;
          // Quantity (the stepper value) is rendered in the row wrapper OUTSIDE the
          // cart-item content. Reading it from the item's own text was unreliable: it
          // matched digits in product names (e.g. "3x Chocolate Chunk Cookies" → 3)
          // and missed deal lines that show no "N ×" prefix (e.g. a Buy-1-get-1 line,
          // which still steps to 2). Find the standalone integer in the enclosing
          // <li> that isn't inside the item content.
          const row = el.closest('li');
          const qtyEl = row && [...row.querySelectorAll('div, span')].find(
            (n) => !el.contains(n) && /^\d+$/.test(n.textContent.trim())
          );
          const quantity = qtyEl ? parseInt(qtyEl.textContent.trim(), 10) : 1;
          // Selections render as rich-text spans: [group label ending ":"] then
          // [option value] pairs (or, on some cart rows, group + value packed into
          // a single span as "Group: Value (£price)"); paid values carry
          // "(£price)", free ones don't. Only rich-text spans are selections —
          // other cart-row text (promo badges, "Add note", price displays) must
          // not become phantom free options. Capture every option (free included)
          // with its group so cross-platform fill can satisfy the target's
          // required groups.
          const allOptions = [];
          const groupLabels = new Set();
          let currentGroup = '';
          for (const s of el.querySelectorAll('span[data-testid="rich-text"]')) {
            const text = s.textContent.trim();
            if (!text || /^£\d+(\.\d+)?$/.test(text)) continue; // skip blanks + line total
            // Two or more £-amounts in one span is a price display (e.g. a
            // strikethrough pair), never a selection.
            if ((text.match(/£\d/g) || []).length >= 2) continue;
            if (text.endsWith(':')) {
              currentGroup = text.slice(0, -1).trim();
              groupLabels.add(currentGroup);
              continue;
            }
            // Group = everything before the FIRST ": " — a character class can't
            // be used here because group names may contain parentheses
            // ("Choose Drink (Large): Coke (£0.50)").
            const labelled = text.match(/^(.+?):\s*(.+)$/);
            const group = labelled ? labelled[1].trim() : currentGroup;
            if (labelled) groupLabels.add(group);
            const rest = labelled ? labelled[2] : text;
            const priced = rest.match(/^(.*)\(£(\d+(?:\.\d+)?)\)$/);
            const name = (priced ? priced[1] : rest).trim();
            const price = priced ? parseFloat(priced[2]) : 0;
            if (name) allOptions.push({ group, name, price });
          }
          // Two row kinds are not selections (live McDonald's, issue #29):
          //  - "X Comes With:" groups list the composition's kept defaults
          //    (comma-joined), which no target platform models as a modifier;
          //  - nested group headers whose free value is exactly ANOTHER group's
          //    label ("Large Drink: Bottled Drink" then "Bottled Drink: …").
          // Captured as options they'd stay unresolved forever and review-flag
          // the line, so drop them here. A value that repeats its OWN group name
          // ("6 Boneless: 6 Boneless") is a real selection and stays.
          const options = allOptions.filter((o) =>
            !/comes with$/i.test(o.group)
            && !(o.price === 0 && o.name !== o.group && groupLabels.has(o.name)));
          const optionsTotal = options.reduce((sum, o) => sum + o.price, 0);
          return {
            name,
            quantity,
            unitPrice: quantity > 0 ? lineTotal / quantity : lineTotal,
            options,
            optionsTotal,
            // The dropped composition rows, kept only long enough for
            // addUberRemovals to diff them; stripped before the order is sent.
            _compositionRows: allOptions.filter((o) => /comes with$/i.test(o.group)),
          };
        })
        .filter((i) => i.name)
    : [];

  await addUberRemovals(doc, items);
  for (const item of items) delete item._compositionRows;

  const addressText =
    doc.querySelector('[data-testid="checkout-delivery-address-section"]')?.textContent ?? '';
  const postcodeMatch = addressText.match(/[A-Z]{1,2}\d{1,2}[A-Z]?\s?\d[A-Z]{2}/);

  // The checkout page title is just "Checkout | Uber Eats", so derive the
  // restaurant name from the store link. Uber sometimes renders the cart panel
  // (our readiness gate above) before i18n strings resolve, leaving the links
  // showing raw keys like "store.shared.backToStore"; wait — bounded — for the
  // name to hydrate before reading, then fall back to the URL slug if it never
  // does, so enumeration and display never inherit a leaked key (#53, #55).
  // Only block while a store link is present but still key-like — if there's no
  // link at all, waiting can't help, so don't stall the read.
  await waitUntil(
    doc,
    () => readUberRestaurant(doc).hydrated || !doc.querySelector('a[href*="/store/"]'),
    3000
  );
  const { name: restaurantName, sourceStoreId, hydrated } = readUberRestaurant(doc);
  console.info('[FeedMe checkout] restaurant name:', JSON.stringify(restaurantName), '— hydrated:', hydrated);

  const feeEl = (testid) =>
    doc.querySelector(`[data-testid="${testid}"]`);

  reportFareRowDrift(doc);

  // Uber One waives the delivery fee rather than the store offering free delivery:
  // the row renders the real fee struck through, the Uber One logo, then £0.00
  // ("£1.79 £0.00", live 2026-08-01). Both halves matter — the logo tells the
  // membership waiver apart from an ordinary store promo, and a final price of 0
  // proves the benefit actually applied to THIS basket rather than merely being
  // offered. Sibling pricing uses this as proof the member is above Uber's
  // unpublished basket minimum at this subtotal (#64).
  const deliveryEl = feeEl('fare-breakdown-charge-badge-delivery-fee');
  const deliveryPrices = [...(deliveryEl?.textContent ?? '').matchAll(/£\s*([\d.]+)/g)];
  const uberOneDeliveryWaived =
    deliveryPrices.length > 1 &&
    parseFloat(deliveryPrices[deliveryPrices.length - 1][1]) === 0 &&
    !!deliveryEl?.querySelector('img[src*="uber_one"]');

  // Uber One's two entitlements are separate fare rows, and only one of them
  // labels its amount: `uber-one-credits` has a value testid, while the monthly
  // benefit renders its amount as an untestidded baseweb tag beside the label, so
  // it has to be read from the enclosing row (live shapes, 2026-08-01). The
  // `membership-benefit` testid this used to read no longer exists on the page at
  // all, so the old capture silently returned nothing. Each row keeps a stable id
  // so sibling pricing can identify it without matching localised label text (#65).
  const uberOneDiscount = (key, label) => {
    const labelEl = feeEl(`fare-breakdown-charge-badge-${key}-label`);
    if (!labelEl) return null;
    const valueEl = feeEl(`fare-breakdown-charge-badge-${key}`);
    // Fall back to the whole row, minus the label, so the untestidded amount is
    // still found — and so a future testid appearing for it changes nothing.
    const text = valueEl
      ? valueEl.textContent ?? ''
      : (labelEl.closest('li')?.textContent ?? '').replace(labelEl.textContent ?? '', '');
    if (!/\d/.test(text)) return null; // an unreadable row is skipped, not discounted by £0
    return { id: key, amount: Math.abs(parsePrice(text)), label };
  };
  const discounts = [
    uberOneDiscount('uber-one-monthly-benefit', 'Uber One monthly benefit'),
    uberOneDiscount('uber-one-credits', 'Uber One credits'),
  ].filter((d) => d && d.amount > 0);

  return {
    platform: PLATFORM.UBER_EATS,
    restaurantName,
    sourceStoreId,
    postcode: postcodeMatch?.[0]?.replace(/\s+/, ' ') ?? '',
    items,
    deliveryFee: parsePrice(deliveryEl?.textContent),
    uberOneDeliveryWaived,
    serviceFee: parsePrice(feeEl('fare-breakdown-charge-badge-fees')?.textContent),
    discounts,
    // Actual total from the checkout page (avoids needing per-item prices)
    checkoutTotal: parsePrice(feeEl('fare-breakdown-charge-badge-total')?.textContent),
  };
}

function extractDeliveroo(doc) {
  const items = [...doc.querySelectorAll('.basket-item')].map((el) => ({
    name: el.querySelector('.item-name')?.textContent?.trim() ?? '',
    quantity: parseInt(el.querySelector('.item-count')?.textContent ?? '1', 10),
    unitPrice: parsePrice(el.querySelector('.item-price')?.textContent),
  }));
  return {
    platform: PLATFORM.DELIVEROO,
    restaurantName: doc.querySelector('.restaurant-title')?.textContent?.trim() ?? '',
    postcode: doc.querySelector('.delivery-postcode')?.textContent?.trim() ?? '',
    items,
    deliveryFee: parsePrice(doc.querySelector('.fee-delivery')?.textContent),
    serviceFee: parsePrice(doc.querySelector('.fee-service')?.textContent),
    discounts: [],
  };
}

function extractJustEat(doc) {
  const items = [...doc.querySelectorAll('.order-item')].map((el) => ({
    name: el.querySelector('.name')?.textContent?.trim() ?? '',
    quantity: parseInt(el.querySelector('.quantity')?.textContent ?? '1', 10),
    unitPrice: parsePrice(el.querySelector('.price')?.textContent),
  }));
  return {
    platform: PLATFORM.JUST_EAT,
    restaurantName: doc.querySelector('.restaurant-name')?.textContent?.trim() ?? '',
    postcode: doc.querySelector('.postcode')?.textContent?.trim() ?? '',
    items,
    deliveryFee: parsePrice(doc.querySelector('.delivery-fee')?.textContent),
    serviceFee: parsePrice(doc.querySelector('.service-fee')?.textContent),
    discounts: [],
  };
}

async function extractOrder(platform, doc) {
  if (platform === PLATFORM.UBER_EATS) return extractUberEats(doc);
  if (platform === PLATFORM.DELIVEROO) return extractDeliveroo(doc);
  if (platform === PLATFORM.JUST_EAT) return extractJustEat(doc);
  throw new Error(`Unsupported platform: ${platform}`);
}

// Browser entry point
if (typeof window !== 'undefined' && typeof chrome !== 'undefined') {
  (async () => {
    const platform = platformFromUrl(window.location.href);
    if (platform) {
      const order = await extractOrder(platform, document);
      if (order.items.length > 0) {
        chrome.runtime.sendMessage({ type: MSG.ORDER_DETECTED, order });
      }
    }
  })();
}

module.exports = { extractOrder, reportFareRowDrift };
