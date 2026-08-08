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

const { themeCssVars } = require('../shared/theme');

const ADD_BUTTON_RE = /\badd\b.*\b(basket|order|bag|cart)\b|add for|add\s*·|add\s*£/i;
const DIALOG_SELECTOR = '[role="dialog"], [aria-modal="true"]';
// Uber meal wizard sub-screens (#47) carry this control; it is how a screen
// entered by clicking a category row is recognised and backed out of.
const GO_BACK_SELECTOR = 'button[aria-label="Go back"]';

// Diagnostic trail: the builder acts on the user's real basket in their own tab,
// where we have no other visibility — every decision is logged so a failed run
// can be diagnosed from the tab's console.
function dlog(...args) {
  try { console.info('[FeedMe builder]', ...args); } catch (_) {}
}

// One-line description of a DOM element for the log.
function describeEl(el, doc) {
  if (!el) return null;
  const bits = [el.tagName.toLowerCase()];
  for (const attr of ['data-qa', 'data-testid', 'role', 'href']) {
    const v = el.getAttribute && el.getAttribute(attr);
    if (v) bits.push(`${attr}="${String(v).slice(0, 60)}"`);
  }
  const name = accessibleName(el, doc || el.ownerDocument);
  if (name) bits.push(`name="${name.slice(0, 60)}"`);
  return bits.join(' ');
}

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

// Deliveroo prefixes promo cards' labels with a badge ("NEW ✨ Crunchy Cheese
// Bites …"), which a plain prefix match misses — and then a superstring sibling
// ("… Sharebox") wins instead (#37). Strip ONLY that badge before matching; an
// ordinary word prefix ("Deluxe …") must keep failing or superstring items
// would match again.
const LABEL_BADGE_RE = /^new\b[\s\W]*/i;
function nameStartsWith(label, name) {
  return label.startsWith(name) || label.replace(LABEL_BADGE_RE, '').startsWith(name);
}

// The item name portion of a card label: platforms append description and price
// after a separator (Deliveroo "Name, desc, kcal, £p"; Uber "Name£p • kcal";
// Just Eat "Name from £p"). An EXACT segment match distinguishes the item from a
// superstring sibling ("… Sharebox®") no matter how verbose either label is —
// the live #37 failure was a compact Sharebox carousel label beating the plain
// item's long-description card in the shortest-label sort.
function nameSegment(label) {
  return label.replace(LABEL_BADGE_RE, '').replace(/( from £|,|£).*$/, '').trim();
}
function nameExact(label, name) {
  return nameSegment(label) === name;
}

// Selectors for elements that actually respond to a click. A name match on a
// container (e.g. a Just Eat search-result <li>) is useless unless we descend to
// the real clickable overlay inside it.
const ACTIONABLE_SELECTOR = '[data-qa="item"], [role="button"], button, a';

// Resolve a name-matching element to the control that should be clicked. The most
// specific real click target is the platform's item overlay ([data-qa="item"] on
// Just Eat) — always prefer it, whether it IS this element or lives inside it,
// because a wrapping container may itself be "actionable" yet not open the dialog.
// Falls back to any actionable descendant, then the element itself. Returns null
// for a non-actionable container with no actionable descendant (the overlay may
// not have hydrated yet) so the caller keeps polling rather than clicking nothing.
function resolveClickable(el, name, doc) {
  const nameMatches = (c) => nameStartsWith(accessibleName(c, doc), name);
  const smallestName = (list) => list.slice().sort(
    (a, b) => accessibleName(a, doc).length - accessibleName(b, doc).length)[0];

  if (el.matches && el.matches('[data-qa="item"]')) return el;
  // Prefer the item overlay inside this container. We do NOT re-gate on the
  // overlay's own accessible name: the container already matched by its visible
  // text, and the overlay's aria-labelledby may not have wired up yet (the Just
  // Eat search list re-renders), yet the overlay is still what opens the dialog.
  // If several overlays match by name, take the tightest; otherwise take the first.
  const overlays = [...el.querySelectorAll('[data-qa="item"]')];
  if (overlays.length) {
    const named = overlays.filter(nameMatches);
    return named.length ? smallestName(named) : overlays[0];
  }

  if (el.matches && el.matches(ACTIONABLE_SELECTOR)) return el;
  const inner = [...el.querySelectorAll(ACTIONABLE_SELECTOR)].filter(nameMatches);
  return inner.length ? smallestName(inner) : null;
}

// Find the most specific clickable element representing a menu item. Prefer a
// native id attribute when the page exposes one, then natively clickable
// elements matched by accessible name, then looser containers.
function findItemCard(doc, line, platform) {
  // Just Eat tags its search-result <li> with data-item-id = the item's id, but that
  // row is a decoy — clicking it does nothing; only the [data-qa="item"] overlay
  // opens the dialog. So skip the id fast path there and match the overlay by name.
  if (line.id && platform !== 'just-eat') {
    for (const sel of [`[data-item-id="${cssEscape(line.id)}"]`, `[data-test-id="${cssEscape(line.id)}"]`, `[data-testid="${cssEscape(line.id)}"]`]) {
      const el = safeQuery(doc, sel);
      if (el) return el;
    }
  }
  const name = norm(line.name);
  if (!name) return null;

  // Just Eat exposes a dedicated [data-qa="item"] overlay as the one element that
  // opens the customise dialog. Its search results also render role="button" <li>
  // decoy rows that carry the same name text but do nothing when clicked — and in
  // the first frames after a search only the decoy exists, before any overlay has
  // rendered at all. So target ONLY the overlays, matched by resolved name.
  // Rank exact-name-segment matches above superstring variants, then shorter
  // labels (the item itself rather than a section/wrapper around it).
  const rank = (a, b) => {
    const an = accessibleName(a, doc);
    const bn = accessibleName(b, doc);
    return (nameExact(bn, name) - nameExact(an, name)) || (an.length - bn.length);
  };
  const itemOverlays = [...doc.querySelectorAll('[data-qa="item"]')]
    .filter((el) => nameStartsWith(accessibleName(el, doc), name));
  if (itemOverlays.length) {
    itemOverlays.sort(rank);
    return itemOverlays[0];
  }
  // Wait (return null → keep polling) rather than clicking a decoy: on Just Eat
  // always, and — only when the platform is unknown — on any page already showing
  // overlays but not yet a matching one. On a known other platform a stray
  // [data-qa="item"] element must not suppress the generic tier below.
  if (platform === 'just-eat' || (!platform && safeQuery(doc, '[data-qa="item"]'))) return null;

  // Other platforms (Deliveroo/Uber) have no such overlay — the clickable is a
  // button/link/[role=button], possibly wrapped in a container we descend into.
  for (const tier of ['button, a, [role="button"]', '[data-item-id], [data-testid]']) {
    const candidates = [...doc.querySelectorAll(tier)]
      .filter((el) => nameStartsWith(accessibleName(el, doc), name));
    candidates.sort(rank);
    for (const candidate of candidates) {
      const clickable = resolveClickable(candidate, name, doc);
      if (clickable) return clickable;
    }
  }
  return null;
}

// Find the container of a modifier group by its heading text, so option matching
// can be scoped within it. Returns null when the group can't be located.
function findGroupContainer(dialog, group) {
  const g = norm(group);
  if (!g) return null;
  const heading = [...dialog.querySelectorAll('*')]
    .find((el) => el.children.length === 0 && norm(el.textContent) === g);
  let node = heading && heading.parentElement;
  for (let i = 0; i < 5 && node && node !== dialog; i++) {
    if (node.querySelector('label, li, button, [role="checkbox"], [role="radio"], pie-radio, pie-checkbox')) return node;
    node = node.parentElement;
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
  // Scope to the option's group when known so a name repeated across groups
  // (e.g. "No Thanks") lands in the correct one.
  const scope = findGroupContainer(dialog, mod.group) || dialog;
  // pie-radio carries role=radio but pie-checkbox has NO role attribute (live
  // McDonald's multi-select, 2026-07-11) — include the hosts by tag name too.
  // Uber "Choose up to N" stepper rows (#54) carry the text in an input-less
  // div[data-testid="customization-option-label"], so match that too.
  const candidates = [...scope.querySelectorAll('label, li, button, [role="checkbox"], [role="radio"], pie-radio, pie-checkbox, [data-testid="customization-option-label"]')]
    .filter((el) => norm(el.textContent).includes(name));
  candidates.sort((a, b) => a.textContent.length - b.textContent.length);
  return candidates[0] || null;
}

// Uber's modifier rows (live 2026-07-14, #26) put the option text in a <label>
// whose `for` points at a SIBLING input — nothing inside the label itself. The
// label's native `control` accessor is the only route from the matched text to
// the real input, for both clicking and reading `checked` back.
function ownInput(target) {
  if (target.tagName === 'INPUT') return target;
  if (target.tagName === 'LABEL' && target.control) return target.control;
  return target.querySelector('input');
}

// Uber's "Choose up to N" add-on groups (live 2026-07-18, #54) render each
// option as a QUANTITY STEPPER, not an input: the text sits in a
// div[data-testid="customization-option-label"] with NO input, and the control
// is the row's button[data-testid="quantity-increment-selection-button"] (svg
// only). Selecting means clicking Increment once; "selected" shows as a matching
// decrement button (quantity ≥ 1) appearing in the row — there is no `checked`.
// Return the row container (nearest ancestor of the label holding an increment
// button) so both the control and the readback stay scoped to this one option;
// non-stepper targets yield null and every other shape is left untouched.
const STEPPER_INC = '[data-testid="quantity-increment-selection-button"]';
const STEPPER_DEC = '[data-testid="quantity-decrement-selection-button"]';
function stepperRow(target) {
  if (!target.closest) return null;
  const label = target.matches && target.matches('[data-testid="customization-option-label"]')
    ? target
    : target.closest('[data-testid="customization-option-label"]');
  if (!label) return null;
  let row = label;
  for (let i = 0; i < 5 && row.parentElement; i++) {
    row = row.parentElement;
    if (row.querySelector(STEPPER_INC)) return row;
  }
  return null;
}

// The element to actually click for a modifier target. Web components only
// respond to a click on their shadow-DOM input (verified live on Just Eat);
// native inputs take the click directly (it bubbles to any row handler).
// Deliveroo wraps a readonly, React-controlled input in the row <button>:
// clicking the input registers only via bubbling and leaves `checked` false
// (#37's false "NOT selected" logs) — the button is the real control. Rows
// without a button ancestor (Uber's label rows, plain labels) keep the input.
function modifierClickTarget(target) {
  if (target.shadowRoot) {
    const inner = target.shadowRoot.querySelector('input');
    if (inner) return inner;
  }
  const input = ownInput(target);
  if (input) return input.closest('button') || input;
  // Uber quantity-stepper add-on (#54): no input — click the Increment button.
  const row = stepperRow(target);
  if (row) return row.querySelector(STEPPER_INC);
  return target;
}

function modifierSelected(target) {
  const input = (target.shadowRoot && target.shadowRoot.querySelector('input')) || ownInput(target);
  if (input && input.checked) return true;
  // Uber quantity-stepper add-on (#54): selected = quantity ≥ 1, which surfaces
  // as a Decrement button appearing in the row (there is no `checked` to read).
  const row = stepperRow(target);
  if (row) return !!row.querySelector(STEPPER_DEC);
  const host = target.closest('[aria-checked], [role="radio"], [role="checkbox"]') || target;
  return host.getAttribute && host.getAttribute('aria-checked') === 'true';
}

// Within a customise dialog, tick the modifier matching mod and wait for the
// selection to settle. The settle wait is essential: React-rendered dialogs
// (Just Eat) drop all but the last of several selections clicked in one task.
// Option lists can be collapsed behind a "Show N more" toggle (Just Eat:
// span[data-qa="item-choices-options-multi-action-toggle"]) — expand them so
// collapsed options become findable. An expanded toggle flips its text to
// "Show N less" while keeping the same data-qa, so only click while it says
// "more" — re-clicking would collapse the group a previous miss just expanded.
function expandCollapsedOptions(dialog) {
  const toggles = [...dialog.querySelectorAll('button, pie-button, [role="button"], [data-qa*="action-toggle"]')]
    .filter((el) => (el.getAttribute('data-qa') || '').includes('action-toggle')
      || /\bshow\s+(\d+\s+)?more\b/i.test(norm(el.textContent)));
  for (const t of toggles) {
    if (/\bmore\b/i.test(norm(t.textContent))) clickEl(t);
  }
}

async function selectModifier(dialog, mod, wait = defaultWait) {
  let target = findModifierTarget(dialog, mod);
  if (!target) {
    // The option may be collapsed behind a "show more" toggle, or its whole
    // group may only render after an earlier selection (conditional groups) —
    // expand and wait for the row instead of giving up on the first miss.
    expandCollapsedOptions(dialog);
    target = await wait(() => findModifierTarget(dialog, mod), { timeout: 2000 });
  }
  if (!target) return false;
  if (modifierSelected(target)) return true;
  clickEl(modifierClickTarget(target));
  // React re-renders can REPLACE the row's nodes after a selection — verify
  // against a freshly resolved target, not the clicked (possibly detached) one.
  return !!(await wait(() => {
    const fresh = findModifierTarget(dialog, mod) || target;
    return modifierSelected(fresh);
  }, { timeout: 2000 }));
}

function findAddButton(dialog) {
  return [...dialog.querySelectorAll('button, [role="button"], pie-button')]
    .filter((b) => !b.disabled && b.getAttribute('aria-disabled') !== 'true'
      && !/(^|-)disabled$/.test(b.getAttribute('data-qa') || ''))
    .find((b) => ADD_BUTTON_RE.test(norm(b.textContent)) || b.classList.contains('add'));
}

// The bottom "Save • £X" button that commits an Uber wizard sub-screen and
// returns to the parent screen (live 2026-07-14, #47). Deliberately distinct
// from findAddButton: Save never adds to the basket.
function findSaveButton(dialog) {
  return [...dialog.querySelectorAll('button, [role="button"]')]
    .filter((b) => !b.disabled && b.getAttribute('aria-disabled') !== 'true')
    .find((b) => /^save\b/i.test(norm(b.textContent)));
}

// ── Uber meal wizard navigation (#47) ────────────────────────────────────────
// Meal dialogs hide concrete options behind CATEGORY radios ("Cold Drink",
// "Bottled Drinks"…): clicking one REPLACES the whole dialog with a sub-screen
// (Go back button, the category's own option groups, a bottom Save button).
// Save commits and returns to the parent — or stays and flags when the
// screen's Required groups are unmet (the platform's own validation). Go back
// discards. Sub-screens do NOT contain the item name, and the real add button
// exists only on the top-level screen. (Live: McDonald's Bethnal Green Road,
// 2026-07-14.)
//
// When a modifier misses on the current screen, iterate its unchecked radio
// rows (bounded): a click that swaps in a sub-screen (its radio group vanished
// and a Go back control appeared) is searched recursively and committed via
// Save on success or abandoned via Go back on a miss. A click that did NOT
// navigate selected a concrete option the user never asked for — restore the
// row that was checked before, or flag the line for review when the group had
// no previous selection to restore.
const MAX_WIZARD_CANDIDATES = 6;
const MAX_WIZARD_DEPTH = 2;

// Candidate rows ranked to reach the right sub-screen with the fewest wrong
// turns (all keys read off the row text, deterministically):
//  - a row whose size word conflicts with the modifier's ("Large … Meal" for
//    "Medium Fries") goes last;
//  - undecorated rows (no kcal/price — the category shape) come before
//    concrete-looking ones, so strays are rare;
//  - rows sharing a word with the modifier ("Medium … Meal" for "Medium
//    Fries") come first within their tier.
const SIZE_TOKEN_RE = /^(small|medium|large|regular)$/;
function wizardCandidates(scope, mod) {
  const tokens = (s) => norm(s).split(/[^a-z0-9®]+/).filter((t) => t.length > 2);
  const modTokens = new Set(tokens(mod.name));
  const rank = (name) => {
    const ts = tokens(name);
    const conflict = ts.some((t) => SIZE_TOKEN_RE.test(t) && !modTokens.has(t)) ? 4 : 0;
    const decorated = /\d\s*kcal|£/.test(name) ? 2 : 0;
    const shares = ts.some((t) => modTokens.has(t)) ? 0 : 1;
    return conflict + decorated + shares;
  };
  return [...scope.querySelectorAll('input[type="radio"]')]
    .filter((i) => !i.checked)
    .map((i) => {
      const label = (i.id && scope.querySelector(`label[for="${i.id}"]`)) || i.closest('label');
      return label ? norm(label.textContent) : '';
    })
    .filter(Boolean)
    .sort((a, b) => rank(a) - rank(b))
    .slice(0, MAX_WIZARD_CANDIDATES);
}

async function wizardPick(screen, mod, ctx, depth, tryDirect = true) {
  const { doc, wait, line } = ctx;
  let stray = false;
  try {
    if (tryDirect && await selectModifier(screen(), mod, wait)) return { picked: true, stray };
    if (depth <= 0 || !screen()) return { picked: false, stray };
    const scope = findGroupContainer(screen(), mod.group) || screen();
    // Candidates are captured as TEXT: the platform replaces nodes freely, so
    // every iteration re-finds its row by name on the live screen.
    for (const rowName of wizardCandidates(scope, mod)) {
      const current = screen();
      if (!current) break;
      const target = findModifierTarget(current, { name: rowName });
      const input = target && ownInput(target);
      if (!input || input.type !== 'radio' || input.checked) continue;
      const groupName = input.getAttribute('name') || '';
      const groupSel = `input[name="${cssEscape(groupName)}"]`;
      const prev = groupName && [...current.querySelectorAll(groupSel)].find((i) => i.checked);
      const prevValue = (prev && prev.getAttribute('value')) || null;
      dlog(`"${line.name}": wizard — trying "${rowName}" for "${mod.name}"`);
      clickEl(modifierClickTarget(target));
      const navigated = await wait(() => {
        const live = screen();
        if (!live || !live.querySelector(GO_BACK_SELECTOR)) return null;
        // Still seeing the clicked row's radio group means the same screen
        // (possibly re-rendered, #26) — not a navigation.
        return live.querySelector(groupSel) ? null : live;
      }, { timeout: 1600 });
      if (!navigated) {
        // The click selected a concrete option in some group — undo it.
        const live = screen();
        const group = live ? [...live.querySelectorAll(groupSel)] : [];
        const nowChecked = group.find((i) => i.checked);
        const nowValue = nowChecked && nowChecked.getAttribute('value');
        if (nowValue && nowValue !== prevValue) {
          const restore = prevValue && group.find((i) => i.getAttribute('value') === prevValue);
          if (restore) {
            dlog(`"${line.name}": wizard — "${rowName}" was a concrete option, restoring the previous selection`);
            clickEl(modifierClickTarget(restore));
          } else {
            dlog(`"${line.name}": wizard — stray selection "${rowName}" cannot be undone, flagging for review`);
            stray = true;
          }
        }
        continue;
      }
      dlog(`"${line.name}": wizard — entered "${rowName}"`);
      const sub = await wizardPick(screen, mod, ctx, depth - 1);
      stray = stray || sub.stray;
      if (sub.picked) {
        // Commit the entered screen so the selection survives leaving it. A
        // Save refused because of other unmet Required groups simply stays
        // put — later modifiers and the add phase continue from there.
        const committed = screen();
        const save = committed && findSaveButton(committed);
        if (save) {
          const leafInput = committed.querySelector('input[type="radio"]');
          const leafSel = leafInput && `input[name="${cssEscape(leafInput.getAttribute('name') || '')}"]`;
          dlog(`"${line.name}": wizard — committing "${rowName}" via`, describeEl(save, doc));
          clickEl(save);
          if (leafSel) {
            await wait(() => {
              const live = screen();
              return live && !live.querySelector(leafSel) ? live : null;
            }, { timeout: 2500 });
          }
        }
        return { picked: true, stray };
      }
      dlog(`"${line.name}": wizard — "${rowName}" does not offer "${mod.name}", backing out`);
      const back = screen() && screen().querySelector(GO_BACK_SELECTOR);
      if (!back) break;
      clickEl(back);
      const returned = await wait(() => {
        const live = screen();
        return live && live.querySelector(groupSel) ? live : null;
      }, { timeout: 2500 });
      if (!returned) break; // stuck off-course — stop navigating, fail honestly
    }
  } catch (e) {
    dlog(`"${line.name}": wizard navigation failed —`, e && e.message);
  }
  return { picked: false, stray };
}

// The enabled add button for the current dialog, committing any wizard screens
// in the way: a fill that ended mid-wizard sits on a Save screen, and each
// Save hop returns one level closer to the top-level screen that owns the real
// add button. A Save that changes nothing means the platform refused it
// (required choices unmet) — the line must fail honestly.
async function resolveAddButton(screen, wait, doc, line) {
  for (let hops = 0; hops < 4; hops++) {
    const found = await wait(() => {
      const d = screen();
      if (!d) return null;
      const add = findAddButton(d);
      if (add) return { add };
      const save = d.querySelector(GO_BACK_SELECTOR) && findSaveButton(d);
      return save ? { save } : null;
    }, { timeout: 3000 });
    if (!found) return null;
    if (found.add) return found.add;
    const before = norm(screen().textContent);
    dlog(`"${line.name}": committing wizard screen via`, describeEl(found.save, doc));
    clickEl(found.save);
    const moved = await wait(() => {
      const d = screen();
      return d && norm(d.textContent) !== before ? d : null;
    }, { timeout: 2500 });
    if (!moved) {
      dlog(`"${line.name}": wizard Save refused (required choices unmet) — line failed`);
      return null;
    }
  }
  return null;
}

function dismissDialog(doc, dialog) {
  const close = dialog.querySelector('[aria-label*="close" i], [data-testid*="close" i], button.close');
  if (close) return clickEl(close);
  doc.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
}

// ── Basket clearing (issue #24) ──────────────────────────────────────────────
// Pre-existing basket items make the filled basket diverge from the sidebar's
// comparison, so the plan starts by emptying the basket via the platform's own
// remove/decrease controls. Per-platform hooks: `surface` (optional) returns a
// control that reveals the basket view when it isn't rendered; `removeButtons`
// returns the current remove/decrease controls. Deliveroo and Uber selectors
// are candidates until the live-verification pass pins them.
const CLEAR_HOOKS = {
  'just-eat': {
    // Live shapes 2026-07-11: toggle button [data-qa="cart-modal-toggle-element"];
    // decrease control is an EMPTY span[role=button][data-qa=
    // "cart-item-amount-action-decrement"]; close is [data-qa=
    // "cart-modal-header-action-close"]. The aria-label variants are kept as a
    // drift fallback.
    surface: (doc) => doc.querySelector('[data-qa="cart-modal-toggle-element"]')
      || [...doc.querySelectorAll('button, [role="button"]')]
        .find((b) => /view basket/i.test(accessibleName(b, doc))) || null,
    removeButtons: (doc) => [...doc.querySelectorAll(
      '[data-qa="cart-item-amount-action-decrement"],'
      + ' button[aria-label^="Decrease quantity"], [role="button"][aria-label^="Decrease quantity"]')],
    dismiss: (doc) => {
      const close = doc.querySelector(
        '[data-qa="cart-modal-header-action-close"], [data-qa="cart-modal"] [aria-label*="close" i]');
      if (close) clickEl(close);
    },
  },
  deliveroo: {
    // Live shapes 2026-07-11 (Popeyes Shoreditch): the basket aside carries a
    // one-click [aria-label="Delete all items"] control guarded by an "Are you
    // sure…?" confirm. The aside ALSO hosts "People also added" quick-add
    // steppers (aria-label "Decrease quantity") that must never be clicked, so
    // Deliveroo clears via clearAll only — no removeButtons loop. Row buttons
    // read "Nx Item £…"; the leading quantities give the removed count.
    // The aside renders even when the basket is empty — its presence says the
    // basket UI has hydrated.
    ready: (doc) => doc.querySelector('aside[aria-label="Basket"]'),
    countItems: (doc) => [...doc.querySelectorAll('[aria-label="Basket"] button')]
      .map((b) => ((b.textContent || '').match(/^\s*(\d+)\s*x/i) || [])[1])
      .filter(Boolean)
      .reduce((s, n) => s + Number(n), 0),
    clearAll: {
      trigger: (doc) => doc.querySelector('[aria-label="Basket"] [aria-label="Delete all items"]'),
      confirm: (doc) => [...doc.querySelectorAll('[role="dialog"] button, [aria-modal="true"] button')]
        .find((b) => /delete this basket/i.test(norm(b.textContent))) || null,
    },
  },
  'uber-eats': {
    // Live shapes 2026-07-11 (KFC Mile End, anonymous) and 2026-07-13 (logged-in
    // multi-cart account, issue #43). The badge (data-test-id="view-carts-btn")
    // opens one of two views:
    //  - This store HAS a cart (badge "BasketN", even for a cart saved under a
    //    different delivery address): the per-store drawer opens DIRECTLY. Each
    //    row is an <li> with a mod=editItem link whose href carries the store
    //    path, plus Decrement/Increment steppers — Decrement at quantity 1
    //    removes the row (trash icon). Rows are scoped to the CURRENT store via
    //    the editItem href so another store's cart is never touched. The
    //    Decrement labels carry no quantity, so settling is detected from the
    //    row text (the `state` hook) instead of the button labels.
    //  - This store has NO cart but the account holds carts elsewhere (badge
    //    "BasketsN", N = cart count): a cart SWITCHER opens instead — one
    //    li[role=menuitem] tile per restaurant ("<Name>Subtotal: £…"), carts at
    //    other addresses grouped under a "You seem far away from the shop"
    //    heading. There is nothing of this store's to clear, so the no-rows →
    //    empty conclusion is correct; tiles must NOT be clicked (opening
    //    another restaurant's cart can trigger its stale-items validation
    //    modal). The switcher has no Close button — dismiss re-clicks the
    //    badge, which toggles it shut.
    // The old view-carts-badge testid no longer exists; kept as a drift fallback.
    surface: (doc) => doc.querySelector('[data-test-id="view-carts-btn"], [data-testid="view-carts-badge"]')
      || [...doc.querySelectorAll('button')].find((b) => /^baskets?\s*\d+$/i.test(norm(b.textContent))) || null,
    removeButtons: (doc) => {
      const path = String((doc.location && doc.location.pathname) || '');
      const scoped = path.includes('/store/');
      return [...doc.querySelectorAll('a[href*="editItem"]')]
        .filter((a) => !scoped || (a.getAttribute('href') || '').includes(path))
        .map((a) => a.closest('li'))
        .filter(Boolean)
        .map((li) => [...li.querySelectorAll('button')].find((b) => (b.getAttribute('aria-label') || '') === 'Decrement'))
        .filter(Boolean);
    },
    state: (doc) => [...doc.querySelectorAll('a[href*="editItem"]')]
      .map((a) => { const li = a.closest('li'); return li ? norm(li.textContent) : ''; })
      .join('|'),
    dismiss: (doc) => {
      const close = [...doc.querySelectorAll('button[aria-label="Close"]')].pop();
      if (close) return clickEl(close);
      const switcherOpen = [...doc.querySelectorAll('li[role="menuitem"]')]
        .some((el) => /subtotal:?\s*£/i.test(norm(el.textContent)));
      if (switcherOpen) {
        const badge = CLEAR_HOOKS['uber-eats'].surface(doc);
        if (badge) clickEl(badge);
      }
    },
  },
};

// Each click removes one UNIT (a decrease at quantity 1 removes the row), so the
// bound is on clicks, not rows. Big enough for any real basket, small enough to
// end a stuck loop quickly.
const MAX_CLEAR_CLICKS = 60;

// Empty the platform basket. Never throws. `cleared: false` means items may
// remain (the caller warns and proceeds — user-confirmed behaviour).
async function clearBasket(doc, platform, wait = defaultWait) {
  const hooks = CLEAR_HOOKS[platform];
  const result = { hadItems: false, cleared: true, removed: 0 };
  if (!hooks || !doc) return result;
  let surfaced = false;
  try {
    // The basket UI hydrates from the platform's basket API AFTER the page
    // completes, and the builder is injected right at complete — a single
    // instant sample raced it and concluded "empty" over a stale basket (live
    // #24 retest failure, Just Eat same-restaurant, 2026-07-12). Wait for any
    // sign of the basket UI before deciding. Platforms whose basket UI renders
    // even when empty publish `ready`; Just Eat renders NO cart container when
    // empty, so a genuinely empty basket there simply waits out the timeout.
    const uiPresent = () => {
      if (hooks.clearAll && hooks.clearAll.trigger(doc)) return true;
      if (hooks.removeButtons && hooks.removeButtons(doc).length) return true;
      if (hooks.surface && hooks.surface(doc)) return true;
      if (hooks.ready && hooks.ready(doc)) return true;
      return null;
    };
    if (!uiPresent()) {
      dlog('clear: waiting for the basket UI to hydrate');
      await wait(uiPresent, { timeout: 6000 });
    }
    // Platforms with a native "delete basket" affordance clear in one action:
    // click it, accept its confirm, and wait for the control to disappear (the
    // platform's own emptied signal). The row count from before the click is
    // the honest removed count.
    if (hooks.clearAll) {
      const trigger = hooks.clearAll.trigger(doc);
      if (!trigger) return result;
      result.hadItems = true;
      const count = hooks.countItems ? hooks.countItems(doc) : 0;
      dlog('clear: clearing all via', describeEl(trigger, doc));
      clickEl(trigger);
      const confirmBtn = await wait(() => hooks.clearAll.confirm(doc), { timeout: 3000 });
      if (confirmBtn) {
        dlog('clear: confirming via', describeEl(confirmBtn, doc));
        clickEl(confirmBtn);
      }
      const emptied = await wait(() => !hooks.clearAll.trigger(doc), { timeout: 5000 });
      if (emptied) {
        result.removed = count || 1;
        dlog(`clear: basket emptied (${result.removed} item(s))`);
      } else {
        dlog('clear: basket did not empty after clear-all');
        result.cleared = false;
      }
      return result;
    }
    // A removal is confirmed by the platform's own signal: the hook's state
    // string changing — by default the remove controls' accessible names (Just
    // Eat embeds "from N to M" quantities there); platforms whose labels carry
    // no quantity (Uber) provide a `state` hook over the row text instead.
    const state = () => (hooks.state
      ? hooks.state(doc)
      : hooks.removeButtons(doc).map((b) => accessibleName(b, doc)).join('|'));
    if (!hooks.removeButtons(doc).length && hooks.surface) {
      const s = hooks.surface(doc);
      if (s) {
        dlog('clear: surfacing basket view via', describeEl(s, doc));
        clickEl(s);
        surfaced = true;
        await wait(() => hooks.removeButtons(doc).length, { timeout: 3000 });
      }
    }
    for (let i = 0; i < MAX_CLEAR_CLICKS; i++) {
      const buttons = hooks.removeButtons(doc);
      if (!buttons.length) {
        if (result.removed) dlog(`clear: basket empty after ${result.removed} removal(s)`);
        break;
      }
      result.hadItems = true;
      if (i === MAX_CLEAR_CLICKS - 1) {
        dlog('clear: hit the click bound with items remaining');
        result.cleared = false;
        break;
      }
      // Just Eat keeps a decremented row's control mounted for a beat at
      // quantity 0 ("from 0 to -1") — clicking that is a wasted click that
      // inflates the removed count. Wait for it to unmount instead.
      const live = buttons.filter((b) => !/\bfrom\s+(0|-\d+)\s+to\b/i.test(accessibleName(b, doc)));
      if (!live.length) {
        const stale = state();
        const gone = await wait(() => state() !== stale, { timeout: 4000 });
        if (!gone) {
          dlog('clear: quantity-0 control never unmounted — stopping');
          result.cleared = false;
          break;
        }
        continue;
      }
      const before = state();
      dlog('clear: removing via', describeEl(live[0], doc));
      clickEl(live[0]);
      const settled = await wait(() => state() !== before, { timeout: 4000 });
      if (!settled) {
        dlog('clear: removal did not register — stopping with items left');
        result.cleared = false;
        break;
      }
      result.removed += 1;
    }
  } catch (e) {
    dlog('clear: failed —', e && e.message);
    result.cleared = false;
  }
  // Close whatever the surface click opened: a lingering cart view's text (the
  // stale items) would otherwise be mistaken for an item's customise dialog.
  if (surfaced && hooks.dismiss) {
    try { hooks.dismiss(doc); } catch (_) {}
  }
  return result;
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

// Deliveroo renders menu sections lazily as they scroll into view and has no
// menu search box, so an unrendered item's card is unfindable in place (#37).
// Walk the window through the page's full height — real scrolls fire the
// platform's IntersectionObservers and scroll listeners — polling for the card,
// then restore the original position.
async function scrollItemIntoDom(doc, line, wait, platform, { exactOnly = false } = {}) {
  const win = doc.defaultView;
  if (!win) return null;
  const startY = win.scrollY || 0;
  const height = () => Math.max(
    doc.body ? doc.body.scrollHeight : 0,
    doc.documentElement ? doc.documentElement.scrollHeight : 0
  );
  const step = Math.max(400, (win.innerHeight || 800) * 0.8);
  dlog(`"${line.name}": scrolling to force lazy menu sections (height ${height()})`);
  // When hunting past an already-rendered superstring card, only an exact
  // name-segment match ends the scroll — findItemCard alone would return the
  // superstring again on the first poll.
  const probe = () => {
    const card = findItemCard(doc, line, platform);
    if (!card) return null;
    return !exactOnly || nameExact(accessibleName(card, doc), norm(line.name)) ? card : null;
  };
  let found = null;
  for (let y = 0, i = 0; y <= height() && i < 60 && !found; y += step, i++) {
    try {
      win.scrollTo(0, y);
      win.dispatchEvent(new win.Event('scroll'));
    } catch (_) {}
    found = await wait(probe, { timeout: 350 });
  }
  try {
    win.scrollTo(0, startY);
    win.dispatchEvent(new win.Event('scroll'));
  } catch (_) {}
  return found;
}

// The menu-scoped search box, when the platform has one. Only Just Eat does:
// Uber store pages carry ONLY the global header search ("Search Uber Eats", a
// restaurant search that can never surface a menu card — live KFC Mile End,
// 2026-07-14, #26) which the generic placeholder match used to catch, and
// Deliveroo menus have no search box at all.
function menuSearchBox(doc, platform) {
  if (platform === 'uber-eats') return null;
  return safeQuery(doc, 'input[type="search"], [data-qa="menu-category-nav-search-element"], input[placeholder*="search" i]');
}

// Get the item's card into the DOM. Just Eat menus open on a category grid with
// no items rendered, so when the card isn't found, type the name into the menu
// search box and wait for the results to render. Menus with no search box
// (Deliveroo, Uber) get the scroll fallback instead.
async function surfaceItem(doc, line, wait, platform) {
  const card = await wait(() => findItemCard(doc, line, platform), { timeout: 2500 });
  if (card) {
    // A prefix-only hit may be a superstring sibling ("… Sharebox®") while the
    // exact item's card sits in an unrendered lazy section — scroll to look for
    // an exact match before settling for the superstring (#37 retest).
    if (!nameExact(accessibleName(card, doc), norm(line.name))
        && !menuSearchBox(doc, platform)) {
      dlog(`"${line.name}": only a superstring card rendered (${describeEl(card, doc)}) — scrolling for an exact match`);
      const exact = await scrollItemIntoDom(doc, line, wait, platform, { exactOnly: true });
      if (exact && nameExact(accessibleName(exact, doc), norm(line.name))) {
        dlog(`"${line.name}": exact card after scroll:`, describeEl(exact, doc));
        return exact;
      }
    }
    dlog(`"${line.name}": card found directly:`, describeEl(card, doc));
    return card;
  }
  const box = menuSearchBox(doc, platform);
  if (!box) {
    const scrolled = await scrollItemIntoDom(doc, line, wait, platform);
    dlog(`"${line.name}": card after scroll:`, describeEl(scrolled, doc));
    return scrolled;
  }
  dlog(`"${line.name}": not in DOM, typing into search box:`, describeEl(box, doc));
  setNativeValue(box, line.name);
  const found = await wait(() => findItemCard(doc, line, platform));
  dlog(`"${line.name}": card after search:`, describeEl(found, doc));
  return found;
}

// Click the item's card and wait for its customise dialog to open. The Just Eat
// search results are a transient list that re-renders (the matched element can be
// swapped out from under a single click), so re-find the card and retry a few
// times before giving up. Returns the open dialog, or null if none appeared.
// The customise dialog currently open for this line, or null. Matched by the
// item name (its heading) so an unrelated dialog — e.g. the Just Eat location
// panel — is never mistaken for it. The Just Eat CART modal is also
// role=dialog and lists the basket's items by name (live failure 2026-07-11),
// so it is excluded explicitly.
function findOpenDialog(doc, line) {
  const all = [...doc.querySelectorAll(DIALOG_SELECTOR)]
    .filter((d) => !(d.matches && d.matches('[data-qa="cart-modal"]')));
  return all.find((d) => norm(d.textContent).includes(norm(line.name)))
    // An Uber wizard sub-screen (#47) titles itself after the CATEGORY ("Cold
    // Drink"), not the item — recognise it by its Go back control so
    // mid-wizard re-resolution and the closed check keep working.
    || all.find((d) => d.querySelector(GO_BACK_SELECTOR))
    || null;
}

async function openItemDialog(doc, line, wait, surface, platform) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const card = attempt === 0 && surface
      ? await surfaceItem(doc, line, wait, platform)
      : await wait(() => findItemCard(doc, line, platform), { timeout: 2500 });
    if (!card) continue;
    dlog(`"${line.name}": clicking card (attempt ${attempt + 1}):`, describeEl(card, doc));
    clickEl(card);
    const dialog = await wait(() => findOpenDialog(doc, line), { timeout: 1500 });
    if (dialog) return dialog;
    // A cross-restaurant confirm can also block the customise dialog from
    // opening at all — accept it and retry the click.
    if (acceptNewBasketPrompt(doc, line)) continue;
    dlog(`"${line.name}": no dialog after click (attempt ${attempt + 1})`);
  }
  return null;
}

// Cross-restaurant switch: adding while another restaurant's basket exists makes
// the platform confirm before replacing it ("Starting a new order will clear your
// basket at …"). Accepting IS the clear (spec #24), so find such a prompt and
// click its affirmative. Excludes the item's own customise dialog by name.
const NEW_BASKET_RE = /\b(new (basket|order)|start (a )?(new|fresh|again)|clear your basket)\b/i;
function acceptNewBasketPrompt(doc, line) {
  const prompt = [...doc.querySelectorAll(DIALOG_SELECTOR)]
    .find((d) => NEW_BASKET_RE.test(norm(d.textContent))
      && !norm(d.textContent).includes(norm(line.name)));
  if (!prompt) return false;
  const yes = [...prompt.querySelectorAll('button, [role="button"], pie-button')]
    .find((b) => NEW_BASKET_RE.test(norm(b.textContent))
      || /^(yes|ok|continue|confirm)$/.test(norm(b.textContent)));
  if (!yes) return false;
  dlog(`"${line.name}": accepting new-basket prompt via`, describeEl(yes, doc));
  clickEl(yes);
  return true;
}

// Add a single plan line (respecting its quantity). Returns a per-line result; it
// never throws — failures simply leave `added` short of `requested`.
async function addLine(line, ctx) {
  const { doc, wait, platform } = ctx;
  const requested = Math.max(1, line.quantity || 1);
  let added = 0;
  let missedSelection = false;
  for (let q = 0; q < requested; q++) {
    let dialog = await openItemDialog(doc, line, wait, q === 0, platform);
    // On all three platforms clicking an item card opens a customise dialog (even
    // for items with no options). No dialog means the click landed on nothing, so
    // the line is NOT added — reporting it as "add manually" instead of silently
    // claiming success over an empty basket.
    if (!dialog) {
      dlog(`"${line.name}": no customise dialog opened after clicking the item — not counting as added`);
      break;
    }
    dlog(`"${line.name}": customise dialog open:`, describeEl(dialog, doc));
    // Uber REPLACES the whole dialog node when its customizations hydrate or a
    // selection re-renders it (live false-success, #26 McDonald's Bow
    // 2026-07-14) — clicks on the held node then land on a detached subtree
    // and do nothing. Re-resolve the LIVE dialog before every step, and treat
    // "closed" as NO matching dialog existing, not the old node being gone.
    const liveDialog = () => {
      if (doc.contains(dialog)) return dialog;
      const fresh = findOpenDialog(doc, line);
      if (fresh) {
        dlog(`"${line.name}": dialog node was replaced — re-resolved the live one`);
        dialog = fresh;
      }
      return dialog;
    };
    for (const mod of line.modifiers || []) {
      let picked = false;
      const attempted = liveDialog();
      try { picked = await selectModifier(attempted, mod, wait); } catch (_) {}
      // A replacement DURING the attempt means the click landed on (or was
      // read back from) the detached node — one retry on the live dialog.
      if (!picked && liveDialog() !== attempted) {
        dlog(`"${line.name}": dialog replaced mid-selection — retrying "${mod.name}" on the live one`);
        try { picked = await selectModifier(dialog, mod, wait); } catch (_) {}
      }
      // Uber meal dialogs hide concrete options behind category sub-screens
      // (#47) — navigate into them before giving the modifier up.
      if (!picked && platform === 'uber-eats') {
        const w = await wizardPick(liveDialog, mod, { doc, wait, line }, MAX_WIZARD_DEPTH, false);
        picked = w.picked;
        if (w.stray) missedSelection = true;
      }
      dlog(`"${line.name}": modifier "${mod.name}" ${picked ? 'selected' : 'NOT selected'}`);
      // A lost selection means the added item may not match the user's order —
      // the line must surface for review, never read as a clean fill (#37).
      if (!picked) missedSelection = true;
    }
    // The add button stays disabled until required choices are made, so this
    // wait doubles as "wait for it to enable". A wizard fill may still sit on
    // a sub-screen — resolveAddButton Saves its way back to the top level.
    const addBtn = await resolveAddButton(liveDialog, wait, doc, line);
    if (!addBtn) {
      dlog(`"${line.name}": no enabled add button appeared — dismissing dialog, line failed`);
      dismissDialog(doc, liveDialog());
      break;
    }
    dlog(`"${line.name}": clicking add button:`, describeEl(addBtn, doc));
    clickEl(addBtn);
    const dialogGone = () => !doc.contains(dialog) && !findOpenDialog(doc, line);
    const closed = await wait(dialogGone, { timeout: 3000 });
    dlog(`"${line.name}": dialog ${closed ? 'closed' : 'did NOT close'} after add`);
    // The dialog closing is the only observable sign the add landed; a swallowed
    // click (button replaced mid-click, unmet server-side validation) leaves it
    // open — counting that unit would report a filled basket the platform never
    // received, and the stale dialog would be re-matched on the next unit.
    if (!closed) {
      // The add may be blocked by a cross-restaurant confirm — accept it (that
      // IS the basket clear) and re-await the close before failing the line.
      let closedAfterPrompt = false;
      if (acceptNewBasketPrompt(doc, line)) {
        closedAfterPrompt = await wait(dialogGone, { timeout: 3000 });
        dlog(`"${line.name}": dialog ${closedAfterPrompt ? 'closed' : 'still open'} after accepting the prompt`);
      }
      if (!closedAfterPrompt) {
        dismissDialog(doc, liveDialog());
        break;
      }
    }
    added += 1;
  }
  const result = { name: line.name || '', requested, added, ok: added >= requested };
  if (result.ok && missedSelection) result.review = true;
  return result;
}

// Drive the whole basket plan. Resolves to a results array (one per plan line).
async function buildBasket(build, opts = {}) {
  const doc = opts.doc || (typeof document !== 'undefined' ? document : null);
  const wait = opts.wait || defaultWait;
  const plan = (build && build.basketPlan) || [];
  const platform = build && build.platform;
  dlog('starting on', doc && doc.location ? String(doc.location.href) : '(no doc)',
    'platform=', platform, 'readyState=', doc && doc.readyState, 'plan=', JSON.stringify(plan));
  const overlay = opts.headless || !doc ? null : createOverlay(doc, plan.length);

  // Pre-existing basket items would sit under the plan and skew the total away
  // from the sidebar's comparison — empty the basket first (issue #24). A failed
  // clear warns and proceeds: most of a fill is better than none (user-confirmed).
  if (plan.length) {
    const clear = await clearBasket(doc, platform, wait);
    if (overlay) overlay.setClear(clear);
  }

  const results = [];
  for (const line of plan) {
    if (!line || !line.name) {
      results.push({ name: (line && line.name) || '', requested: (line && line.quantity) || 1, added: 0, ok: false });
    } else {
      let r;
      try { r = await addLine(line, { doc, wait, platform }); } catch (_) { r = { name: line.name, requested: line.quantity || 1, added: 0, ok: false }; }
      // Flag a successful add for review only when a selection the user made is
      // genuinely at risk: options the plan couldn't carry by name (uncarried),
      // so the builder never even attempted them. A merely non-prefillable line
      // whose carried name-only options were all found and platform-confirmed is
      // as verified as a resolved one — addLine already sets review on any lost
      // selection (missedSelection), so no blanket prefillable flag here (#52).
      if (r.ok && (line.uncarried || 0) > 0) r.review = true;
      results.push(r);
    }
    if (overlay) overlay.update(results);
  }
  if (overlay) overlay.finish(results);
  dlog('finished:', JSON.stringify(results));
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
  // The custom properties have to be declared inside this shadow root: nothing
  // is inherited from the platform's page, which is what keeps the overlay's
  // colours ours rather than theirs.
  const styleEl = doc.createElement('style');
  styleEl.textContent = themeCssVars();
  shadow.appendChild(styleEl);
  const box = doc.createElement('div');
  box.style.cssText = 'background:var(--fm-surface);border:1px solid var(--fm-border);border-radius:10px;'
    + 'box-shadow:0 4px 24px rgba(0,0,0,.15);padding:12px 14px;min-width:220px;'
    + "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:12px;color:var(--fm-text-strong);";
  const title = doc.createElement('div');
  title.style.cssText = 'font-weight:800;margin-bottom:6px;color:var(--fm-text);';
  title.textContent = 'FeedMe — filling basket…';
  const status = doc.createElement('div');
  const clearLine = doc.createElement('div');
  clearLine.style.cssText = 'margin-top:4px;font-size:11px;color:var(--fm-text-muted);display:none;';
  const list = doc.createElement('div');
  list.style.cssText = 'margin-top:6px;color:var(--fm-error);font-size:11px;';
  box.appendChild(title); box.appendChild(status); box.appendChild(clearLine); box.appendChild(list);
  let uncleared = false;
  shadow.appendChild(box);
  doc.body.appendChild(host);

  return {
    setClear(clear) {
      if (!clear.hadItems) return;
      clearLine.style.display = 'block';
      if (clear.cleared) {
        clearLine.textContent = `Removed ${clear.removed} item(s) already in the basket`;
      } else {
        uncleared = true;
        clearLine.style.color = 'var(--fm-warn)';
        clearLine.textContent = "Couldn't clear pre-existing items — check your basket.";
      }
    },
    update(results) {
      const done = results.filter((r) => r.ok).length;
      status.textContent = `Added ${done} of ${total}`;
    },
    finish(results) {
      const failed = results.filter((r) => !r.ok);
      const review = results.filter((r) => r.ok && r.review);
      title.textContent = failed.length ? 'FeedMe — almost there' : '✅ FeedMe — basket filled';
      list.textContent = '';
      const section = (label, rows, color) => {
        const wrap = doc.createElement('div');
        wrap.style.cssText = `color:${color};`;
        const lead = doc.createElement('div');
        lead.textContent = label;
        wrap.appendChild(lead);
        rows.forEach((r) => {
          const li = doc.createElement('div');
          li.textContent = `• ${r.name || 'item'}`;
          wrap.appendChild(li);
        });
        list.appendChild(wrap);
      };
      if (failed.length) section('Add these manually:', failed, 'var(--fm-error)');
      if (review.length) section('Check the options on:', review, 'var(--fm-warn)');
      setTimeout(() => host.remove(), failed.length || review.length || uncleared ? 12000 : 4000);
    },
  };
}

module.exports = { buildBasket, findItemCard, selectModifier, findAddButton, clearBasket };

// Bootstrap when injected into a real page (guarded so require() in tests is inert).
if (typeof window !== 'undefined' && window.__feedmeBuild) {
  buildBasket(window.__feedmeBuild, {});
}
