// Basket builder — runs on a branch's menu page (opened by a "switch" click) and
// scripts the user's matched items into the basket. It is injected by the service
// worker with window.__feedmeBuild = { platform, basketPlan }.
//
// Design constraints:
//  - It acts on the user's REAL, logged-in basket, so it only ever runs from an
//    explicit user click and NEVER throws — any step that fails skips its line and
//    is reported, leaving the user to add it manually.
//  - Item/modifier matching is primarily by visible name text (robust across DOM
//    changes), with native ids used as a hint where the page exposes them. The
//    per-platform CSS selectors here are best-effort and must be hardened against
//    live pages (#2 Phase B4); the name-text path is the resilient fallback.

const ADD_BUTTON_RE = /\badd\b.*\b(basket|order|bag|cart)\b|add for|add\s*·|add\s*£/i;
const DIALOG_SELECTOR = '[role="dialog"], [aria-modal="true"]';

// Poll fn() until it returns truthy or the timeout elapses. Injectable so tests can
// resolve synchronously.
function defaultWait(fn, { timeout = 8000, interval = 150 } = {}) {
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

function clickEl(el) {
  try { el.click(); } catch (_) {}
}

const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();

// The name an assistive tech would read for an element: its text, else its
// aria-label (Deliveroo overlays), else the text of the elements referenced by
// aria-labelledby (Just Eat overlays). The clickable item element on both
// platforms is an EMPTY overlay, so text alone is not enough.
function accessibleName(el, doc) {
  let t = norm(el.textContent);
  if (!t && el.getAttribute) t = norm(el.getAttribute('aria-label'));
  if (!t && el.getAttribute) {
    const ids = el.getAttribute('aria-labelledby');
    if (ids && doc.getElementById) {
      t = norm(ids.split(/\s+/).map((id) => {
        const ref = doc.getElementById(id);
        return ref ? ref.textContent : '';
      }).join(' '));
    }
  }
  return t;
}

// Find the most specific clickable element representing a menu item. Prefer a
// native id attribute when the page exposes one, then natively clickable
// elements matched by accessible name, then looser containers.
function findItemCard(doc, line) {
  if (line.id) {
    for (const sel of [`[data-item-id="${cssEscape(line.id)}"]`, `[data-test-id="${cssEscape(line.id)}"]`, `[data-testid="${cssEscape(line.id)}"]`]) {
      const el = safeQuery(doc, sel);
      if (el) return el;
    }
  }
  const name = norm(line.name);
  if (!name) return null;
  // Clickables first: a matching li/container is useless if the click handler
  // lives on an overlay button (Deliveroo/Just Eat).
  for (const tier of ['button, a, [role="button"]', 'li, [data-item-id], [data-testid]']) {
    const candidates = [...doc.querySelectorAll(tier)]
      .filter((el) => accessibleName(el, doc).includes(name));
    if (candidates.length) {
      // Shortest name = the item itself rather than a section/wrapper around it.
      candidates.sort((a, b) => accessibleName(a, doc).length - accessibleName(b, doc).length);
      return candidates[0];
    }
  }
  return null;
}

// Locate the element representing a modifier option: by id hint first (input
// values carry the option id on Deliveroo), then by visible name text. Option
// rows differ per platform: pie-radio/pie-checkbox web components (Just Eat),
// <button> rows (Deliveroo), li rows wrapping a lone input (Uber).
function findModifierTarget(dialog, mod) {
  if (mod.id) {
    const id = cssEscape(mod.id);
    const hit = safeQuery(dialog, `[data-mod-id="${id}"], [data-modifier-id="${id}"], input[value="${id}"], [id^="${id}"]`);
    if (hit) return hit;
  }
  const name = norm(mod.name);
  if (!name) return null;
  const candidates = [...dialog.querySelectorAll('label, li, button, [role="checkbox"], [role="radio"]')]
    .filter((el) => norm(el.textContent).includes(name));
  candidates.sort((a, b) => a.textContent.length - b.textContent.length);
  return candidates[0] || null;
}

// The element to actually click for a modifier target. Web components only
// respond to a click on their shadow-DOM input (verified live on Just Eat);
// native inputs take the click directly (it bubbles to any row handler).
function modifierClickTarget(target) {
  if (target.shadowRoot) {
    const inner = target.shadowRoot.querySelector('input');
    if (inner) return inner;
  }
  if (target.tagName === 'INPUT') return target;
  return target.querySelector('input') || target;
}

function modifierSelected(target) {
  const input = target.tagName === 'INPUT' ? target
    : (target.shadowRoot && target.shadowRoot.querySelector('input')) || target.querySelector('input');
  if (input && input.checked) return true;
  const host = target.closest('[aria-checked], [role="radio"], [role="checkbox"]') || target;
  return host.getAttribute && host.getAttribute('aria-checked') === 'true';
}

// Within a customise dialog, tick the modifier matching mod and wait for the
// selection to settle. The settle wait is essential: React-rendered dialogs
// (Just Eat) drop all but the last of several selections clicked in one task.
async function selectModifier(dialog, mod, wait = defaultWait) {
  const target = findModifierTarget(dialog, mod);
  if (!target) return false;
  if (modifierSelected(target)) return true;
  clickEl(modifierClickTarget(target));
  return !!(await wait(() => modifierSelected(target), { timeout: 2000 }));
}

function findAddButton(dialog) {
  return [...dialog.querySelectorAll('button, [role="button"], pie-button')]
    .filter((b) => !b.disabled && b.getAttribute('aria-disabled') !== 'true'
      && !/(^|-)disabled$/.test(b.getAttribute('data-qa') || ''))
    .find((b) => ADD_BUTTON_RE.test(norm(b.textContent)) || b.classList.contains('add'));
}

function dismissDialog(doc, dialog) {
  const close = dialog.querySelector('[aria-label*="close" i], [data-testid*="close" i], button.close');
  if (close) return clickEl(close);
  doc.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
}

// Set an input's value the way React-controlled pages expect: through the
// native value setter, followed by an input event.
function setNativeValue(input, value) {
  try {
    const proto = Object.getPrototypeOf(input);
    const desc = Object.getOwnPropertyDescriptor(proto, 'value')
      || (typeof HTMLInputElement !== 'undefined' && Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value'));
    if (desc && desc.set) desc.set.call(input, value); else input.value = value;
  } catch (_) { try { input.value = value; } catch (_) {} }
  try { input.dispatchEvent(new Event('input', { bubbles: true })); } catch (_) {}
}

// Get the item's card into the DOM. Just Eat menus open on a category grid with
// no items rendered, so when the card isn't found, type the name into the menu
// search box and wait for the results to render.
async function surfaceItem(doc, line, wait) {
  const card = await wait(() => findItemCard(doc, line), { timeout: 2500 });
  if (card) return card;
  const box = safeQuery(doc, 'input[type="search"], [data-qa="menu-category-nav-search-element"], input[placeholder*="search" i]');
  if (!box) return null;
  setNativeValue(box, line.name);
  return wait(() => findItemCard(doc, line));
}

// Add a single plan line (respecting its quantity). Returns a per-line result; it
// never throws — failures simply leave `added` short of `requested`.
async function addLine(line, ctx) {
  const { doc, wait } = ctx;
  const requested = Math.max(1, line.quantity || 1);
  let added = 0;
  for (let q = 0; q < requested; q++) {
    const card = q === 0
      ? await surfaceItem(doc, line, wait)
      : await wait(() => findItemCard(doc, line));
    if (!card) break;
    clickEl(card);
    // A customise dialog may open; if it does, pick the modifiers and confirm.
    // Match it by the item name (its heading) so an unrelated dialog — e.g. the
    // Just Eat location panel — is never mistaken for the customise dialog.
    const dialog = await wait(() => {
      const all = [...doc.querySelectorAll(DIALOG_SELECTOR)];
      return all.find((d) => norm(d.textContent).includes(norm(line.name))) || null;
    }, { timeout: 1500 });
    if (dialog) {
      for (const mod of line.modifiers || []) {
        try { await selectModifier(dialog, mod, wait); } catch (_) {}
      }
      // The add button stays disabled until required choices are made, so this
      // wait doubles as "wait for it to enable".
      const addBtn = await wait(() => findAddButton(dialog), { timeout: 3000 });
      if (!addBtn) { dismissDialog(doc, dialog); break; }
      clickEl(addBtn);
      await wait(() => !doc.contains(dialog), { timeout: 3000 });
    }
    added += 1;
  }
  return { name: line.name || '', requested, added, ok: added >= requested };
}

// Drive the whole basket plan. Resolves to a results array (one per plan line).
async function buildBasket(build, opts = {}) {
  const doc = opts.doc || (typeof document !== 'undefined' ? document : null);
  const wait = opts.wait || defaultWait;
  const plan = (build && build.basketPlan) || [];
  const overlay = opts.headless || !doc ? null : createOverlay(doc, plan.length);

  const results = [];
  for (const line of plan) {
    if (!line || !line.name) {
      results.push({ name: (line && line.name) || '', requested: (line && line.quantity) || 1, added: 0, ok: false });
    } else {
      let r;
      try { r = await addLine(line, { doc, wait }); } catch (_) { r = { name: line.name, requested: line.quantity || 1, added: 0, ok: false }; }
      results.push(r);
    }
    if (overlay) overlay.update(results);
  }
  if (overlay) overlay.finish(results);
  return results;
}

// ── DOM helpers (null-safe) ──────────────────────────────────────────────────

function safeQuery(root, sel) {
  try { return root.querySelector(sel); } catch (_) { return null; }
}

// Minimal CSS.escape fallback (service-worker-injected pages always have it, but
// keep node/test safe).
function cssEscape(s) {
  if (typeof CSS !== 'undefined' && CSS.escape) return CSS.escape(s);
  return String(s).replace(/[^a-zA-Z0-9_-]/g, (c) => '\\' + c);
}

// ── Progress overlay (shadow DOM, safe DOM construction — no innerHTML) ───────

function createOverlay(doc, total) {
  const host = doc.createElement('div');
  host.id = 'feedme-builder';
  host.style.cssText = 'position:fixed;top:12px;right:12px;z-index:2147483647;';
  const shadow = host.attachShadow({ mode: 'open' });
  const box = doc.createElement('div');
  box.style.cssText = 'background:#fff;border:1px solid #e5e7eb;border-radius:10px;'
    + 'box-shadow:0 4px 24px rgba(0,0,0,.15);padding:12px 14px;min-width:220px;'
    + "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:12px;color:#374151;";
  const title = doc.createElement('div');
  title.style.cssText = 'font-weight:800;margin-bottom:6px;color:#111;';
  title.textContent = 'FeedMe — filling basket…';
  const status = doc.createElement('div');
  const list = doc.createElement('div');
  list.style.cssText = 'margin-top:6px;color:#ef4444;font-size:11px;';
  box.appendChild(title); box.appendChild(status); box.appendChild(list);
  shadow.appendChild(box);
  doc.body.appendChild(host);

  return {
    update(results) {
      const done = results.filter((r) => r.ok).length;
      status.textContent = `Added ${done} of ${total}`;
    },
    finish(results) {
      const failed = results.filter((r) => !r.ok);
      title.textContent = failed.length ? 'FeedMe — almost there' : '✅ FeedMe — basket filled';
      if (failed.length) {
        list.textContent = '';
        const lead = doc.createElement('div');
        lead.textContent = 'Add these manually:';
        list.appendChild(lead);
        failed.forEach((r) => {
          const li = doc.createElement('div');
          li.textContent = `• ${r.name || 'item'}`;
          list.appendChild(li);
        });
      }
      setTimeout(() => host.remove(), failed.length ? 12000 : 4000);
    },
  };
}

module.exports = { buildBasket, findItemCard, selectModifier, findAddButton };

// Bootstrap when injected into a real page (guarded so require() in tests is inert).
if (typeof window !== 'undefined' && window.__feedmeBuild) {
  buildBasket(window.__feedmeBuild, {});
}
