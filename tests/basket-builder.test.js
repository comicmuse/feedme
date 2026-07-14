/**
 * @jest-environment jsdom
 */
const { buildBasket, findItemCard, selectModifier, findAddButton, clearBasket } = require('../src/content/basket-builder');

// A synthetic menu DOM that mirrors the shape the engine targets: item rows whose
// visible text carries the name, a customise dialog with labelled options, and an
// "Add to basket" button. Hardening the real per-platform selectors is Phase B4.
function mountMenu({ withDialog = true } = {}) {
  document.body.innerHTML = `
    <main>
      <div class="menu">
        <button class="item" data-item-id="dr-1">Whopper <span>£5.89</span></button>
        <button class="item" data-item-id="dr-9">Honey BBQ Sandwich <span>£9.99</span></button>
        <button class="item" data-item-id="dr-3">Large Fries <span>£3.19</span></button>
      </div>
      <div id="dialog-root"></div>
    </main>`;

  // Clicking an item "opens" a dialog with its modifiers + an add button.
  document.querySelectorAll('.item').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (!withDialog) { btn.dataset.added = (Number(btn.dataset.added || 0) + 1).toString(); return; }
      const root = document.getElementById('dialog-root');
      // Live dialogs on all three platforms carry the item name as their heading.
      root.innerHTML = `
        <div role="dialog">
          <h2>${btn.textContent.replace(/£[\d.]+/, '').trim()}</h2>
          <label><input type="checkbox" data-mod-id="opt-1"> Regular Fries (£2.50)</label>
          <label><input type="checkbox" data-mod-id="opt-2"> Large Fries (£3.59)</label>
          <button class="add">Add to basket</button>
        </div>`;
      root.querySelector('.add').addEventListener('click', () => {
        btn.dataset.added = (Number(btn.dataset.added || 0) + 1).toString();
        root.innerHTML = '';
      });
    });
  });
}

const fastWait = (fn) => Promise.resolve(fn());

describe('buildBasket engine', () => {
  beforeEach(() => mountMenu());

  test('adds a simple line by name and reports success', async () => {
    const plan = [{ id: 'dr-1', name: 'Whopper', quantity: 1, modifiers: [], prefillable: true }];
    const results = await buildBasket({ basketPlan: plan }, { wait: fastWait, headless: true });
    expect(results).toEqual([{ name: 'Whopper', requested: 1, added: 1, ok: true }]);
    expect(document.querySelector('[data-item-id="dr-1"]').dataset.added).toBe('1');
  });

  test('adds the requested quantity', async () => {
    const plan = [{ id: 'dr-3', name: 'Large Fries', quantity: 3, modifiers: [], prefillable: true }];
    const results = await buildBasket({ basketPlan: plan }, { wait: fastWait, headless: true });
    expect(results[0]).toMatchObject({ added: 3, ok: true });
    expect(document.querySelector('[data-item-id="dr-3"]').dataset.added).toBe('3');
  });

  test('selects a named modifier in the dialog before adding', async () => {
    const plan = [{
      id: 'dr-9', name: 'Honey BBQ Sandwich', quantity: 1,
      modifiers: [{ id: 'opt-1', name: 'Regular Fries' }], prefillable: true,
    }];
    let checkedDuringAdd = false;
    // Spy: when the add fires, the Regular Fries box must already be checked.
    document.getElementById('dialog-root').addEventListener('click', (e) => {
      if (e.target.classList.contains('add')) {
        checkedDuringAdd = document.querySelector('[data-mod-id="opt-1"]').checked;
      }
    }, true);
    const results = await buildBasket({ basketPlan: plan }, { wait: fastWait, headless: true });
    expect(results[0].ok).toBe(true);
    expect(checkedDuringAdd).toBe(true);
  });

  // Live false-success (#26, McDonald's Bow 2026-07-14): Uber REPLACES the
  // quick-view dialog node when its customizations hydrate, shortly after it
  // opens. The builder kept acting on the detached original — modifier clicks
  // and the add click did nothing — and then took the stale node's absence
  // (`!doc.contains(dialog)`) as "closed after add", counting a line the
  // platform never received. Every step must re-resolve the LIVE dialog, and
  // "closed" must mean no matching dialog exists anywhere.
  test('re-resolves a React-replaced dialog node and only counts a real add (#26)', async () => {
    mountMenu();
    const root = document.getElementById('dialog-root');
    const item = document.querySelector('[data-item-id="dr-1"]');
    const plan = [{
      id: 'dr-1', name: 'Whopper', quantity: 1, prefillable: true,
      modifiers: [{ id: 'opt-1', name: 'Regular Fries' }],
    }];
    // The builder's own modifier click triggers the re-render: the dialog node
    // it holds is swapped for a fresh identical one (clones carry no
    // listeners); only the FRESH dialog's add button reaches the platform.
    let swapped = false;
    root.addEventListener('click', (e) => {
      if (swapped || !e.target.matches('[data-mod-id="opt-1"]')) return;
      swapped = true;
      const stale = root.querySelector('[role="dialog"]');
      const fresh = stale.cloneNode(true);
      fresh.querySelector('[data-mod-id="opt-1"]').checked = true; // selection survives the re-render
      // Like live React's delegated events: once detached, the stale dialog's
      // controls are dead — strip the original add button's listener.
      stale.querySelector('.add').replaceWith(stale.querySelector('.add').cloneNode(true));
      root.appendChild(fresh);
      stale.remove();
      fresh.querySelector('.add').addEventListener('click', () => {
        item.dataset.added = (Number(item.dataset.added || 0) + 1).toString();
        root.innerHTML = '';
      });
    });
    const results = await buildBasket({ basketPlan: plan }, { wait: fastWait, headless: true });
    expect(results[0]).toMatchObject({ added: 1, ok: true });
    expect(item.dataset.added).toBe('1'); // the LIVE dialog's add fired, not the stale one's
  });

  // Same replacement, harder case (the live McDonald's Bow failure): the
  // modifier attempt itself burns against the pre-hydration node — its input
  // is React-controlled (a direct click never flips checked) and the node is
  // swapped mid-selection, losing the click entirely. The builder must retry
  // the modifier once on the replaced dialog or the required group stays
  // unpicked and the add button never enables.
  test('retries a modifier lost to a mid-selection dialog replacement (#26)', async () => {
    mountMenu();
    const root = document.getElementById('dialog-root');
    const item = document.querySelector('[data-item-id="dr-1"]');
    item.addEventListener('click', () => {
      const d = root.querySelector('[role="dialog"]');
      const opt = d.querySelector('[data-mod-id="opt-1"]');
      // React-controlled: the click never flips checked on THIS node…
      opt.addEventListener('click', (e) => {
        e.preventDefault();
        // …and triggers the hydration re-render: a fresh dialog whose input
        // is plain (clickable) and whose add button works only once checked.
        // The clone must start unchecked: cloning copies the input's transient
        // pre-revert checkedness, but live React renders from state the
        // prevented click never reached.
        const fresh = d.cloneNode(true);
        fresh.querySelector('[data-mod-id="opt-1"]').checked = false;
        d.remove();
        root.appendChild(fresh);
        fresh.querySelector('.add').addEventListener('click', () => {
          if (!fresh.querySelector('[data-mod-id="opt-1"]').checked) return;
          item.dataset.added = (Number(item.dataset.added || 0) + 1).toString();
          root.innerHTML = '';
        });
      }, { once: true });
    });
    const plan = [{
      id: 'dr-1', name: 'Whopper', quantity: 1, prefillable: true,
      modifiers: [{ id: 'opt-1', name: 'Regular Fries' }],
    }];
    const results = await buildBasket({ basketPlan: plan }, { wait: fastWait, headless: true });
    expect(results[0]).toMatchObject({ added: 1, ok: true });
    expect(item.dataset.added).toBe('1');
  });

  test('does not count an add whose click landed on a stale detached dialog (#26)', async () => {
    mountMenu();
    const root = document.getElementById('dialog-root');
    const item = document.querySelector('[data-item-id="dr-1"]');
    // The add click itself triggers the re-render: the held node detaches, a
    // fresh dialog stays OPEN (the platform never received the add), and the
    // fresh add button is inert. The line must not be counted.
    let swapped = false;
    root.addEventListener('click', (e) => {
      if (swapped || !e.target.matches('.add')) return;
      swapped = true;
      e.stopImmediatePropagation(); // the platform never processes this add
      const stale = root.querySelector('[role="dialog"]');
      const fresh = stale.cloneNode(true);
      root.appendChild(fresh);
      stale.remove();
    }, true);
    const plan = [{ id: 'dr-1', name: 'Whopper', quantity: 1, modifiers: [], prefillable: true }];
    const results = await buildBasket({ basketPlan: plan }, { wait: fastWait, headless: true });
    expect(results[0]).toMatchObject({ added: 0, ok: false });
    expect(item.dataset.added).toBeUndefined();
  });

  // Uber store pages carry ONLY the global header search ("Search Uber Eats",
  // a restaurant search) — typing an item name there can never surface a menu
  // card (live, KFC Mile End 2026-07-14, #26). Menu-scoped search boxes exist
  // only on Just Eat, so on uber-eats the missing-card fallback must scroll,
  // never type.
  test('never types into the global search box on Uber (scroll fallback instead)', async () => {
    document.body.innerHTML = `
      <input type="text" role="combobox" data-testid="search-input" placeholder="Search Uber Eats">
      <div id="menu"></div>`;
    const plan = [{ name: 'Sticky BBQ Drip Burger Box Meal', quantity: 1, modifiers: [], prefillable: true }];
    const results = await buildBasket({ platform: 'uber-eats', basketPlan: plan }, { wait: fastWait, headless: true });
    expect(results[0]).toMatchObject({ added: 0, ok: false });
    expect(document.querySelector('[data-testid="search-input"]').value).toBe('');
  });

  test('records a line that cannot be located as not-ok (graceful fallback)', async () => {
    const plan = [{ id: 'x', name: 'Vegan Flatbread', quantity: 1, modifiers: [], prefillable: true }];
    const results = await buildBasket({ basketPlan: plan }, { wait: fastWait, headless: true });
    expect(results[0]).toMatchObject({ name: 'Vegan Flatbread', added: 0, ok: false });
  });

  test('never throws even with a malformed plan', async () => {
    await expect(
      buildBasket({ basketPlan: [null, { name: '', quantity: 1 }] }, { wait: fastWait, headless: true })
    ).resolves.toBeDefined();
  });

  // A click that opens no customise dialog (a dead click on the wrong element, or an
  // item that never renders) must NOT be reported as added — the earlier bug counted
  // it as success and the overlay lied "basket filled" over an empty basket.
  // The dialog closing after the add click is the only observable sign the item
  // actually landed — a swallowed click (React re-render, server-side validation
  // keeping the dialog open) must not count the unit.
  test('does not count a unit whose add click leaves the dialog open', async () => {
    document.body.innerHTML = `
      <button class="item" data-item-id="dr-1">Whopper <span>£5.89</span></button>
      <div id="dialog-root"></div>`;
    document.querySelector('.item').addEventListener('click', () => {
      // The add button has no handler: clicking it neither adds nor closes.
      document.getElementById('dialog-root').innerHTML = `
        <div role="dialog"><h2>Whopper</h2><button class="add">Add to basket</button></div>`;
    });
    const plan = [{ id: 'dr-1', name: 'Whopper', quantity: 1, modifiers: [], prefillable: true }];
    const results = await buildBasket({ basketPlan: plan }, { wait: fastWait, headless: true });
    expect(results[0]).toMatchObject({ name: 'Whopper', added: 0, ok: false });
  });

  test('does not report success when clicking the item opens no dialog', async () => {
    document.body.innerHTML = `
      <button class="item" data-item-id="dead-1">Ghost Meal <span>£1.00</span></button>`;
    // No click handler is attached, so clicking never opens a dialog.
    const plan = [{ id: 'dead-1', name: 'Ghost Meal', quantity: 1, modifiers: [], prefillable: true }];
    const results = await buildBasket({ basketPlan: plan }, { wait: fastWait, headless: true });
    expect(results[0]).toMatchObject({ name: 'Ghost Meal', added: 0, ok: false });
  });

  // A line the matcher couldn't fully resolve (prefillable: false) is still worth
  // attempting — the builder selects what it can and the add often works. But the
  // basket may then be missing a selection the user made on the source platform,
  // so a successful add on such a line must be flagged for review, never presented
  // as a clean fill.
  test('flags a filled line as review when its plan line was not fully resolved', async () => {
    const plan = [{ id: 'dr-1', name: 'Whopper', quantity: 1, modifiers: [], prefillable: false }];
    const results = await buildBasket({ basketPlan: plan }, { wait: fastWait, headless: true });
    expect(results[0]).toMatchObject({ name: 'Whopper', added: 1, ok: true, review: true });
  });

  test('does not flag a fully resolved line as review', async () => {
    const plan = [{ id: 'dr-1', name: 'Whopper', quantity: 1, modifiers: [], prefillable: true }];
    const results = await buildBasket({ basketPlan: plan }, { wait: fastWait, headless: true });
    expect(results[0].review).toBeFalsy();
  });
});

describe('overlay honesty', () => {
  beforeEach(() => mountMenu());

  const overlayText = () =>
    document.getElementById('feedme-builder').shadowRoot.textContent;

  test('lists a review line separately from manual lines and qualifies the title', async () => {
    const plan = [
      { id: 'dr-1', name: 'Whopper', quantity: 1, modifiers: [], prefillable: true },
      { id: 'dr-9', name: 'Honey BBQ Sandwich', quantity: 1, modifiers: [], prefillable: false },
      { id: 'x', name: 'Vegan Flatbread', quantity: 1, modifiers: [], prefillable: true },
    ];
    await buildBasket({ basketPlan: plan }, { wait: fastWait });
    const text = overlayText();
    expect(text).toContain('Added 2 of 3');
    expect(text).toContain('Add these manually:');
    expect(text).toContain('Vegan Flatbread');
    expect(text).toContain('Check the options on:');
    expect(text).toContain('Honey BBQ Sandwich');
    document.getElementById('feedme-builder').remove();
  });

  test('a clean full fill keeps the unqualified success title', async () => {
    const plan = [{ id: 'dr-1', name: 'Whopper', quantity: 1, modifiers: [], prefillable: true }];
    await buildBasket({ basketPlan: plan }, { wait: fastWait });
    const text = overlayText();
    expect(text).toContain('basket filled');
    expect(text).not.toContain('Check the options on:');
    expect(text).not.toContain('Add these manually:');
    document.getElementById('feedme-builder').remove();
  });

  test('review-only results report filled but ask for an options check', async () => {
    const plan = [{ id: 'dr-1', name: 'Whopper', quantity: 1, modifiers: [], prefillable: false }];
    await buildBasket({ basketPlan: plan }, { wait: fastWait });
    const text = overlayText();
    expect(text).toContain('basket filled');
    expect(text).toContain('Check the options on:');
    expect(text).toContain('Whopper');
    document.getElementById('feedme-builder').remove();
  });
});

// Live DOM shapes verified on the real platforms (2026-07-06): the clickable item
// element often carries NO text of its own — the name is reachable only through
// aria-label (Deliveroo) or aria-labelledby (Just Eat).
describe('findItemCard accessible-name matching', () => {
  test('matches an empty overlay whose name is in aria-label (Deliveroo shape)', () => {
    document.body.innerHTML = `
      <li>
        <div class="MenuItemCardV2-x">
          <div role="button" tabindex="0" aria-label="Boneless Box Meal, 3 tenders and fries, £12.99"></div>
          <p>Boneless Box Meal</p>
        </div>
      </li>`;
    const card = findItemCard(document, { name: 'Boneless Box Meal' });
    expect(card).not.toBeNull();
    expect(card.getAttribute('aria-label')).toMatch(/Boneless Box Meal/);
  });

  test('matches an empty overlay whose name resolves via aria-labelledby (Just Eat shape)', () => {
    document.body.innerHTML = `
      <div class="wrapper">
        <span role="button" tabindex="0" aria-labelledby="item_61 item_price_62" data-qa="item"></span>
        <span id="item_61" data-qa="item-name">Zinger Tower Burger</span>
        <span id="item_price_62">£7.49</span>
      </div>`;
    const card = findItemCard(document, { name: 'Zinger Tower Burger' });
    expect(card).not.toBeNull();
    expect(card.getAttribute('data-qa')).toBe('item');
  });

  // Just Eat search results render as a plain <li> whose text carries the name,
  // with the real clickable overlay nested inside and hydrating a beat later.
  // Matching the bare <li> and clicking it does nothing (regression: false success).
  test('never returns a non-actionable container before its overlay hydrates', () => {
    document.body.innerHTML = `
      <li class="item-search-list-style_item">
        Box Meals Spicy Chicken Sandwich Box Meal £13.29 Bring the heat...
      </li>`;
    expect(findItemCard(document, { name: 'Spicy Chicken Sandwich Box Meal' })).toBeNull();
  });

  test('returns the nested overlay clickable once it has hydrated inside the li', () => {
    document.body.innerHTML = `
      <li class="item-search-list-style_item">
        <span role="button" data-qa="item" aria-labelledby="n1"></span>
        <span id="n1">Spicy Chicken Sandwich Box Meal</span>
        <span>£13.29 Bring the heat...</span>
      </li>`;
    const card = findItemCard(document, { name: 'Spicy Chicken Sandwich Box Meal' });
    expect(card && card.getAttribute('data-qa')).toBe('item');
  });

  // While only the transient text row is present and the overlay's own name has
  // not resolved yet, findItemCard returns nothing so the caller keeps polling —
  // clicking the text row does nothing on the live site. Once the overlay's name
  // resolves (previous test) it is returned and clicked.
  test('waits (returns null) while only the text row exists and the overlay name is unresolved', () => {
    document.body.innerHTML = `
      <li class="item-search-list-style_item">
        Box Meals Spicy Chicken Sandwich Box Meal £13.29 Bring the heat...
        <span role="button" data-qa="item" aria-labelledby="not-here-yet"></span>
      </li>`;
    expect(findItemCard(document, { name: 'Spicy Chicken Sandwich Box Meal' })).toBeNull();
  });

  // Live regression (Popeyes JE, 2026-07-10): searching "Spicy Chicken Sandwich
  // Box Meal" rendered the DELUXE variant's card first; substring matching
  // committed to it and the +£1 Deluxe landed in the basket under a green
  // "basket filled". On every platform the accessible name STARTS with the item
  // name, so a card whose name merely contains the wanted name is a different
  // item — keep waiting for the right card instead.
  test('never matches a card whose name merely contains the wanted name (superstring variant)', () => {
    document.body.innerHTML = `
      <div class="wrapper">
        <span role="button" data-qa="item" aria-labelledby="d1"></span>
        <span id="d1">Deluxe Spicy Chicken Sandwich Box Meal</span>
      </div>`;
    expect(findItemCard(document, { name: 'Spicy Chicken Sandwich Box Meal' })).toBeNull();
  });

  test('picks the exact item when it renders alongside a superstring variant', () => {
    document.body.innerHTML = `
      <div class="wrapper">
        <span role="button" data-qa="item" aria-labelledby="d1"></span>
        <span id="d1">Deluxe Spicy Chicken Sandwich Box Meal</span>
        <span role="button" data-qa="item" aria-labelledby="p1"></span>
        <span id="p1">Spicy Chicken Sandwich Box Meal</span>
      </div>`;
    const card = findItemCard(document, { name: 'Spicy Chicken Sandwich Box Meal' });
    expect(card && card.getAttribute('aria-labelledby')).toBe('p1');
  });

  test('generic tiers also reject a superstring variant (Uber/Deliveroo shapes)', () => {
    document.body.innerHTML = '<a href="#">Deluxe Spicy Chicken Sandwich Box Meal£14.29 • desc</a>';
    expect(findItemCard(document, { name: 'Spicy Chicken Sandwich Box Meal' })).toBeNull();
  });

  // The live Just Eat search row is itself role="button" (a decoy that carries the
  // name text but does nothing on click); the real target is the [data-qa="item"]
  // overlay. findItemCard must pick the overlay, never the decoy.
  test('prefers the item overlay over a role=button decoy carrying the same name', () => {
    document.body.innerHTML = `
      <li role="button" class="item-search-list-style_item" aria-labelledby="d1">
        <span id="d1">Spicy Chicken Sandwich Box Meal £13.29</span>
        <span role="button" data-qa="item" aria-labelledby="o1"></span>
        <span id="o1">Spicy Chicken Sandwich Box Meal</span>
      </li>`;
    const card = findItemCard(document, { name: 'Spicy Chicken Sandwich Box Meal' });
    expect(card && card.getAttribute('data-qa')).toBe('item');
    expect(card.tagName).toBe('SPAN');
  });

  // Before the overlay's name resolves, the decoy must NOT be clicked — wait instead.
  test('does not fall back to a role=button decoy while the overlay name is unresolved', () => {
    document.body.innerHTML = `
      <li role="button" class="item-search-list-style_item" aria-labelledby="d1">
        <span id="d1">Spicy Chicken Sandwich Box Meal £13.29</span>
        <span role="button" data-qa="item" aria-labelledby="not-here-yet"></span>
      </li>`;
    expect(findItemCard(document, { name: 'Spicy Chicken Sandwich Box Meal' })).toBeNull();
  });

  // In the first frames after a Just Eat search only the role=button decoy exists —
  // no [data-qa="item"] overlay yet. With platform="just-eat" we must still wait for
  // the overlay rather than clicking the decoy (which does nothing on the live site).
  // The [data-qa="item"] decoy-wait is a Just Eat behaviour: a stray element with
  // that attribute on another platform must not suppress the generic button/link
  // tier that would find the item.
  test('still uses the generic tier on Deliveroo when an unrelated data-qa item exists', () => {
    document.body.innerHTML = `
      <div data-qa="item" aria-label="Unrelated promo tile"></div>
      <button>Whopper £5.89</button>`;
    const el = findItemCard(document, { name: 'Whopper' }, 'deliveroo');
    expect(el).toBe(document.querySelector('button'));
  });

  test('waits for the overlay on Just Eat even when only the decoy exists', () => {
    document.body.innerHTML = `
      <li role="button" class="item-search-list-style_item" aria-labelledby="d1">
        <span id="d1">Spicy Chicken Sandwich Box Meal £13.29 Bring the heat...</span>
      </li>`;
    expect(findItemCard(document, { name: 'Spicy Chicken Sandwich Box Meal' }, 'just-eat')).toBeNull();
  });

  // Just Eat tags the decoy search row with data-item-id = the item id. The id fast
  // path must NOT return that row on Just Eat — it is not the element that opens the
  // dialog. With no overlay present yet, findItemCard waits (returns null).
  test('ignores the data-item-id decoy row on Just Eat and waits for the overlay', () => {
    document.body.innerHTML = `
      <li data-item-id="abc-123" role="button">
        Spicy Chicken Sandwich Box Meal £13.29
      </li>`;
    const line = { id: 'abc-123', name: 'Spicy Chicken Sandwich Box Meal' };
    expect(findItemCard(document, line, 'just-eat')).toBeNull();
  });
});

// Short real polling wait for tests that exercise async settling.
const pollWait = (fn, opts = {}) => new Promise((resolve) => {
  const start = Date.now();
  const tick = () => {
    let v = null;
    try { v = fn(); } catch (_) {}
    if (v) return resolve(v);
    if (Date.now() - start > (opts.timeout || 500)) return resolve(null);
    setTimeout(tick, 5);
  };
  tick();
});

describe('selectModifier live dialog shapes', () => {
  test('clicks the shadow-DOM input of a web-component radio (Just Eat pie-radio)', async () => {
    document.body.innerHTML = '<div role="dialog"></div>';
    const dialog = document.querySelector('[role="dialog"]');
    const host = document.createElement('pie-radio');
    host.setAttribute('role', 'radio');
    host.setAttribute('aria-checked', 'false');
    host.textContent = 'Regular Signature Fries 1096 kJ';
    const shadow = host.attachShadow({ mode: 'open' });
    const input = document.createElement('input');
    input.type = 'radio';
    shadow.appendChild(input);
    // Like the real PIE component: only a click on the internal input selects.
    input.addEventListener('click', () => host.setAttribute('aria-checked', 'true'));
    dialog.appendChild(host);

    const ok = await selectModifier(dialog, { name: 'Regular Signature Fries' }, pollWait);
    expect(ok).toBe(true);
    expect(host.getAttribute('aria-checked')).toBe('true');
  });

  test('matches an option row that is an li wrapping a single input (Uber shape)', async () => {
    document.body.innerHTML = `
      <div role="dialog">
        <ul>
          <li><span>Large Fries</span><label data-baseweb="radio"><input type="radio" name="0" value="0"></label></li>
          <li><span>Regular Fries</span><label data-baseweb="radio"><input type="radio" name="0" value="1"></label></li>
        </ul>
      </div>`;
    const dialog = document.querySelector('[role="dialog"]');
    const ok = await selectModifier(dialog, { name: 'Regular Fries' }, pollWait);
    expect(ok).toBe(true);
    expect(dialog.querySelector('input[value="1"]').checked).toBe(true);
  });

  // Live shape re-pinned 2026-07-14 (#26, KFC Mile End): Uber's real modifier
  // groups now render each option as a div holding the input (name =
  // "<groupUuid>+<idx>", value = a dialog-local option uuid that does NOT match
  // the catalog ids we mine) and a for-ASSOCIATED <label> carrying the text —
  // the input is NOT inside the label, so selection must resolve and verify
  // via label.control or the click lands on a bare label and the readback
  // always says "NOT selected".
  test('selects and verifies via the for-associated label (Uber 2026-07 shape)', async () => {
    document.body.innerHTML = `
      <div role="dialog">
        <div>Choice of Chicken</div>
        <div><input type="radio" id="qv-1" name="g-uuid+0" value="opt-uuid-tender"><label for="qv-1">1 Tender125 kcal</label></div>
        <div><input type="radio" id="qv-2" name="g-uuid+0" value="opt-uuid-wings"><label for="qv-2">2 Hot Wings179 kcal</label></div>
      </div>`;
    const dialog = document.querySelector('[role="dialog"]');
    const ok = await selectModifier(dialog, { name: '2 Hot Wings' }, pollWait);
    expect(ok).toBe(true);
    expect(dialog.querySelector('#qv-2').checked).toBe(true);
    expect(dialog.querySelector('#qv-1').checked).toBe(false);
  });

  // Live shape re-pinned 2026-07-12 (#37, McDonald's Commercial Road): the row
  // input is readonly, tabindex=-1 and React-CONTROLLED — clicking it registers
  // with the platform only via bubbling and leaves `checked` false (the false
  // "NOT selected" logs in #37). Only the wrapping <button>'s handler both
  // registers the selection and yields a truthful checked signal.
  test('selects by modifier id by clicking the row button, not the readonly input (Deliveroo shape)', async () => {
    document.body.innerHTML = `
      <div role="dialog">
        <button type="button"><span>Bold BBQ Sauce Dip</span><input type="checkbox" value="2610419456" name="2610419456" readonly tabindex="-1"></button>
      </div>`;
    const dialog = document.querySelector('[role="dialog"]');
    const input = dialog.querySelector('input');
    // Controlled input: a direct click never flips checked…
    input.addEventListener('click', (e) => e.preventDefault());
    // …only the button's own handler does.
    dialog.querySelector('button').addEventListener('click', () => { input.checked = true; });
    const ok = await selectModifier(dialog, { id: '2610419456', name: 'Bold BBQ Sauce Dip' }, pollWait);
    expect(ok).toBe(true);
    expect(input.checked).toBe(true);
  });

  // Live regression (#37, 2026-07-12): React re-renders the option row after a
  // selection, REPLACING the input node — the builder verified the stale
  // detached node and reported a landed selection as "NOT selected".
  test('verifies against a freshly resolved node when React replaces the input', async () => {
    document.body.innerHTML = `
      <div role="dialog">
        <button type="button"><span>Add Extra Bacon</span><input type="checkbox" value="2638278848" name="2638278848" readonly tabindex="-1"></button>
      </div>`;
    const dialog = document.querySelector('[role="dialog"]');
    const button = dialog.querySelector('button');
    // Controlled: the original input never flips from a direct click.
    button.querySelector('input').addEventListener('click', (e) => e.preventDefault());
    button.addEventListener('click', () => {
      // Simulate the React re-render: swap in a NEW checked input.
      const fresh = document.createElement('input');
      fresh.type = 'checkbox';
      fresh.value = '2638278848';
      fresh.checked = true;
      button.querySelector('input').replaceWith(fresh);
    });
    const ok = await selectModifier(dialog, { id: '2638278848', name: 'Add Extra Bacon' }, pollWait);
    expect(ok).toBe(true);
  });

  // Live regression (McDonald's JE, 2026-07-11): checkbox options are bare
  // pie-checkbox hosts with NO role attribute (unlike pie-radio[role=radio]), so
  // the candidate query missed every multi-select option in the dialog.
  test('matches a role-less pie-checkbox host by its text (Just Eat multi-select)', async () => {
    document.body.innerHTML = '<div role="dialog"></div>';
    const dialog = document.querySelector('[role="dialog"]');
    const host = document.createElement('pie-checkbox');
    host.setAttribute('data-qa', 'item-choices-options-multi-check');
    host.textContent = 'Extra 2x Bacon +£1.49';
    const shadow = host.attachShadow({ mode: 'open' });
    const input = document.createElement('input');
    input.type = 'checkbox';
    shadow.appendChild(input);
    input.addEventListener('click', () => { input.checked = true; });
    dialog.appendChild(host);

    const ok = await selectModifier(dialog, { name: 'Extra 2x Bacon' }, pollWait);
    expect(ok).toBe(true);
    expect(input.checked).toBe(true);
  });

  // Live regression (McDonald's JE, 2026-07-11): "Extra 2x Bacon" lives behind the
  // group's "Show N more" toggle, so it isn't in the DOM until the toggle is
  // clicked — the builder reported it NOT selected and the paid extra was lost.
  test('expands a "show more" toggle to reach a collapsed option (Just Eat shape)', async () => {
    document.body.innerHTML = `
      <div role="dialog">
        <p>Add extra</p>
        <label><input type="checkbox"> Extra Cheese</label>
        <button data-qa="item-choices-options-multi-action-toggle">Show 2 more</button>
      </div>`;
    const dialog = document.querySelector('[role="dialog"]');
    dialog.querySelector('[data-qa="item-choices-options-multi-action-toggle"]').addEventListener('click', (e) => {
      const label = document.createElement('label');
      const input = document.createElement('input');
      input.type = 'checkbox';
      label.appendChild(input);
      label.appendChild(document.createTextNode(' Extra 2x Bacon'));
      dialog.insertBefore(label, e.target);
    });
    const ok = await selectModifier(dialog, { name: 'Extra 2x Bacon', group: 'Add extra' }, pollWait);
    expect(ok).toBe(true);
    expect([...dialog.querySelectorAll('input')].some((i) => i.checked && i.parentElement.textContent.includes('Extra 2x Bacon'))).toBe(true);
  });

  // A group can render only after an earlier selection (McDonald's "Salad Dressing
  // Choice" appears once Side Salad is picked) — wait for the row, don't give up
  // on the first miss.
  test('waits for an option row that renders late (conditional group)', async () => {
    document.body.innerHTML = '<div role="dialog"></div>';
    const dialog = document.querySelector('[role="dialog"]');
    setTimeout(() => {
      const label = document.createElement('label');
      const input = document.createElement('input');
      input.type = 'radio';
      label.appendChild(input);
      label.appendChild(document.createTextNode(' Balsamic Dressing'));
      dialog.appendChild(label);
    }, 20);
    const ok = await selectModifier(dialog, { name: 'Balsamic Dressing' }, pollWait);
    expect(ok).toBe(true);
    expect(dialog.querySelector('input').checked).toBe(true);
  });

  // Expanded toggles flip to "Show N less" (same data-qa). A later miss must NOT
  // re-click them — live, the second unfound modifier collapsed the group the
  // first miss had just expanded, hiding the option again.
  test('does not re-click an already-expanded toggle ("Show N less")', async () => {
    document.body.innerHTML = `
      <div role="dialog">
        <label><input type="checkbox"> Extra Cheese</label>
        <span role="button" data-qa="item-choices-options-multi-action-toggle">Show 4 more</span>
      </div>`;
    const dialog = document.querySelector('[role="dialog"]');
    const toggle = dialog.querySelector('[data-qa*="action-toggle"]');
    toggle.addEventListener('click', () => {
      const expanded = toggle.textContent.includes('more');
      if (expanded) {
        const label = document.createElement('label');
        const input = document.createElement('input');
        input.type = 'checkbox';
        label.appendChild(input);
        label.appendChild(document.createTextNode(' Extra 2x Bacon'));
        label.id = 'hidden-option';
        dialog.insertBefore(label, toggle);
        toggle.textContent = 'Show 4 less';
      } else {
        dialog.querySelector('#hidden-option').remove();
        toggle.textContent = 'Show 4 more';
      }
    });
    // First miss expands the group…
    const ok1 = await selectModifier(dialog, { name: 'Extra 2x Bacon' }, pollWait);
    expect(ok1).toBe(true);
    // …a second unfindable modifier must not collapse it again.
    await selectModifier(dialog, { name: 'Unicorn Dust' }, pollWait);
    expect(dialog.querySelector('#hidden-option')).not.toBeNull();
  });

  test('still reports false for an option that never appears (after expanding toggles)', async () => {
    document.body.innerHTML = `
      <div role="dialog">
        <label><input type="checkbox"> Extra Cheese</label>
        <button data-qa="item-choices-options-multi-action-toggle">Show 2 more</button>
      </div>`;
    const dialog = document.querySelector('[role="dialog"]');
    const ok = await selectModifier(dialog, { name: 'Unicorn Dust' }, pollWait);
    expect(ok).toBe(false);
  });

  test('resolves only after the selection has settled (async aria-checked)', async () => {
    document.body.innerHTML = '<div role="dialog"></div>';
    const dialog = document.querySelector('[role="dialog"]');
    const host = document.createElement('div');
    host.setAttribute('role', 'radio');
    host.setAttribute('aria-checked', 'false');
    host.textContent = 'Pepsi MAX Can';
    // Like React-rendered options: state lands a tick after the click.
    host.addEventListener('click', () => {
      setTimeout(() => host.setAttribute('aria-checked', 'true'), 20);
    });
    dialog.appendChild(host);

    const ok = await selectModifier(dialog, { name: 'Pepsi MAX Can' }, pollWait);
    expect(ok).toBe(true);
    expect(host.getAttribute('aria-checked')).toBe('true');
  });
});

describe('selectModifier group scoping', () => {
  test('selects the same-named option inside the requested group only', async () => {
    document.body.innerHTML = `
      <div role="dialog">
        <section><h3>Add a Side?</h3>
          <label><input type="checkbox" id="side-no"> No Thanks</label>
          <label><input type="checkbox" id="side-fr"> Fries</label>
        </section>
        <section><h3>Add a Shake?</h3>
          <label><input type="checkbox" id="shake-no"> No Thanks</label>
          <label><input type="checkbox" id="shake-or"> Oreo Shake</label>
        </section>
      </div>`;
    const dialog = document.querySelector('[role="dialog"]');
    const ok = await selectModifier(dialog, { name: 'No Thanks', group: 'Add a Shake?' }, pollWait);
    expect(ok).toBe(true);
    expect(document.getElementById('shake-no').checked).toBe(true);
    expect(document.getElementById('side-no').checked).toBe(false);
  });
});

describe('findAddButton live dialog shapes', () => {
  test('finds a custom-element submit (Just Eat pie-button)', () => {
    document.body.innerHTML = `
      <div role="dialog">
        <pie-button data-qa="item-choices-action-submit">Add£12.99</pie-button>
      </div>`;
    const btn = findAddButton(document.querySelector('[role="dialog"]'));
    expect(btn).toBeTruthy();
    expect(btn.tagName.toLowerCase()).toBe('pie-button');
  });

  test('skips a disabled native add button until it enables (Deliveroo shape)', () => {
    document.body.innerHTML = `
      <div role="dialog">
        <button disabled>Add for £12.99</button>
      </div>`;
    const dialog = document.querySelector('[role="dialog"]');
    expect(findAddButton(dialog)).toBeFalsy();
    dialog.querySelector('button').disabled = false;
    expect(findAddButton(dialog)).toBeTruthy();
  });

  test('skips a web-component submit flagged disabled via data-qa (Just Eat shape)', () => {
    document.body.innerHTML = `
      <div role="dialog">
        <pie-button data-qa="item-choices-action-submit-disabled">Add£12.99</pie-button>
      </div>`;
    expect(findAddButton(document.querySelector('[role="dialog"]'))).toBeFalsy();
  });
});

describe('dialog scoping', () => {
  test('ignores an open dialog that is not the item customise dialog', async () => {
    // A location panel (Just Eat) can be open as role=dialog; the builder must
    // not treat it as the customise dialog and try to "add" from it.
    document.body.innerHTML = `
      <div role="dialog" data-qa="location-panel">
        <h2>Enter your location</h2>
        <button class="add">Add a new address</button>
      </div>
      <button class="item">Mighty Bucket</button>
      <div id="dialog-root"></div>`;
    let panelClicked = false;
    document.querySelector('[data-qa="location-panel"] .add').addEventListener('click', () => { panelClicked = true; });
    let itemAdds = 0;
    // Clicking the item opens its own customise dialog (as every live platform does).
    document.querySelector('.item').addEventListener('click', () => {
      itemAdds += 1;
      const root = document.getElementById('dialog-root');
      root.innerHTML = '<div role="dialog"><h2>Mighty Bucket</h2><button class="add">Add to basket</button></div>';
      root.querySelector('.add').addEventListener('click', () => { root.innerHTML = ''; });
    });

    const plan = [{ name: 'Mighty Bucket', quantity: 1, modifiers: [], prefillable: true }];
    const results = await buildBasket({ basketPlan: plan }, { wait: fastWait, headless: true });
    expect(panelClicked).toBe(false);
    expect(itemAdds).toBe(1);
    expect(results[0].ok).toBe(true);
  });
});

describe('surfacing items via the menu search box (Just Eat)', () => {
  test('types the name into the search box when the item is not in the DOM', async () => {
    document.body.innerHTML = `
      <input type="search" data-qa="menu-category-nav-search-element" placeholder="Search in KFC">
      <div id="results"></div>
      <div id="dialog-root"></div>`;
    // Like the live menu: matching cards render only after a search, and clicking
    // one opens its customise dialog.
    document.querySelector('input[type="search"]').addEventListener('input', (e) => {
      if (/zinger/i.test(e.target.value)) {
        document.getElementById('results').innerHTML =
          '<button class="item">Zinger Tower Burger</button>';
        document.querySelector('.item').addEventListener('click', function () {
          this.dataset.added = (Number(this.dataset.added || 0) + 1).toString();
          const root = document.getElementById('dialog-root');
          root.innerHTML = '<div role="dialog"><h2>Zinger Tower Burger</h2><button class="add">Add to basket</button></div>';
          root.querySelector('.add').addEventListener('click', () => { root.innerHTML = ''; });
        });
      }
    });

    const plan = [{ name: 'Zinger Tower Burger', quantity: 1, modifiers: [], prefillable: true }];
    const results = await buildBasket({ basketPlan: plan }, { wait: pollWait, headless: true });
    expect(results[0]).toMatchObject({ added: 1, ok: true });
  });
});

// ── clearBasket ──────────────────────────────────────────────────────────────
// A synthetic Just Eat basket pane: one decrease button per item row, labelled
// "Decrease quantity of X from N to M" (live shape, 2026-07-11). Clicking
// decrements the quantity; at zero the row (and its button) disappears.
function mountBasketPane(rows) {
  const pane = document.createElement('aside');
  pane.id = 'pane';
  document.body.appendChild(pane);
  rows.forEach(({ name, qty }) => {
    // LIVE shape (2026-07-11): an empty span[role=button] with
    // data-qa="cart-item-amount-action-decrement" — NOT a <button>.
    const btn = document.createElement('span');
    btn.setAttribute('role', 'button');
    btn.setAttribute('data-qa', 'cart-item-amount-action-decrement');
    let n = qty;
    const label = () => `Decrease quantity of ${name} from ${n} to ${n - 1}`;
    btn.setAttribute('aria-label', label());
    btn.addEventListener('click', () => {
      n -= 1;
      if (n <= 0) btn.remove(); else btn.setAttribute('aria-label', label());
    });
    pane.appendChild(btn);
  });
  return pane;
}

describe('clearBasket', () => {
  beforeEach(() => { document.body.innerHTML = ''; });
  const fastWait = (fn) => Promise.resolve(fn());

  test('removes every unit and reports the count (Just Eat shape)', async () => {
    mountBasketPane([{ name: 'Spicy Mayo Dip', qty: 2 }, { name: 'Big Mac Sauce', qty: 1 }]);
    const r = await clearBasket(document, 'just-eat', fastWait);
    expect(r).toEqual({ hadItems: true, cleared: true, removed: 3 });
    expect(document.querySelectorAll('#pane [role="button"]')).toHaveLength(0);
  });

  test('is a no-op on an empty basket', async () => {
    const r = await clearBasket(document, 'just-eat', fastWait);
    expect(r).toEqual({ hadItems: false, cleared: true, removed: 0 });
  });

  test('is a no-op for an unknown platform', async () => {
    mountBasketPane([{ name: 'Stray', qty: 1 }]);
    const r = await clearBasket(document, 'unknown-platform', fastWait);
    expect(r).toEqual({ hadItems: false, cleared: true, removed: 0 });
    expect(document.querySelectorAll('#pane [role="button"]')).toHaveLength(1);
  });

  test('stops and reports cleared:false when a removal does not register', async () => {
    // A button whose click changes nothing (platform swallowed it).
    const pane = document.createElement('aside');
    const btn = document.createElement('button');
    btn.setAttribute('aria-label', 'Decrease quantity of Stuck Item from 1 to 0');
    pane.appendChild(btn);
    document.body.appendChild(pane);
    const r = await clearBasket(document, 'just-eat', fastWait);
    expect(r).toEqual({ hadItems: true, cleared: false, removed: 0 });
  });

  test('surfaces a hidden basket view before clearing (Just Eat "View basket")', async () => {
    const view = document.createElement('button');
    view.textContent = 'View basket';
    view.addEventListener('click', () => mountBasketPane([{ name: 'Old Fries', qty: 1 }]));
    document.body.appendChild(view);
    const r = await clearBasket(document, 'just-eat', fastWait);
    expect(r).toEqual({ hadItems: true, cleared: true, removed: 1 });
  });

  // Live finding 2026-07-11: after the final decrement Just Eat keeps the
  // control mounted for a beat with the label "from 0 to -1" — clicking it is a
  // wasted click that inflated the removed count (4 reported for 3 units).
  // The builder must wait for it to unmount instead.
  test('does not click or count the lingering quantity-0 control', async () => {
    const pollWait = (fn, { timeout = 500 } = {}) => new Promise((resolve) => {
      const start = Date.now();
      const tick = () => {
        let v = null; try { v = fn(); } catch (_) {}
        if (v) return resolve(v);
        if (Date.now() - start > timeout) return resolve(null);
        setTimeout(tick, 10);
      };
      tick();
    });
    const pane = document.createElement('aside');
    pane.id = 'pane';
    document.body.appendChild(pane);
    const btn = document.createElement('span');
    btn.setAttribute('role', 'button');
    btn.setAttribute('data-qa', 'cart-item-amount-action-decrement');
    btn.setAttribute('aria-label', 'Decrease quantity of Old Fries from 1 to 0');
    let clicks = 0;
    btn.addEventListener('click', () => {
      clicks += 1;
      btn.setAttribute('aria-label', 'Decrease quantity of Old Fries from 0 to -1');
      setTimeout(() => btn.remove(), 20); // unmounts a beat later, as live
    });
    pane.appendChild(btn);
    const r = await clearBasket(document, 'just-eat', pollWait);
    expect(clicks).toBe(1);
    expect(r).toEqual({ hadItems: true, cleared: true, removed: 1 });
  });

  // Live finding 2026-07-11: the surfaced cart modal stays open and its text
  // (the stale items) then hijacks the customise-dialog matcher — the builder
  // must close what it opened.
  test('dismisses the surfaced Just Eat cart modal after clearing', async () => {
    const view = document.createElement('button');
    view.setAttribute('data-qa', 'cart-modal-toggle-element');
    view.textContent = 'View basket';
    view.addEventListener('click', () => {
      const modal = document.createElement('div');
      modal.setAttribute('role', 'dialog');
      modal.setAttribute('data-qa', 'cart-modal');
      const close = document.createElement('span');
      close.setAttribute('role', 'button');
      close.setAttribute('data-qa', 'cart-modal-header-action-close');
      close.setAttribute('aria-label', 'Close');
      close.addEventListener('click', () => modal.remove());
      modal.appendChild(close);
      document.body.appendChild(modal);
      const pane = mountBasketPane([{ name: 'Old Fries', qty: 1 }]);
      modal.appendChild(pane);
    });
    document.body.appendChild(view);
    const r = await clearBasket(document, 'just-eat', fastWait);
    expect(r).toEqual({ hadItems: true, cleared: true, removed: 1 });
    expect(document.querySelector('[data-qa="cart-modal"]')).toBeNull();
  });
});

// Live finding 2026-07-11: the Just Eat cart modal is role=dialog and its text
// contains the stale basket items' names — clicking an item card while it is
// open made openItemDialog treat the CART as the customise dialog (no add
// button → line failed). The customise-dialog matcher must skip it.
describe('cart modal never mistaken for the customise dialog', () => {
  const fastWait = (fn) => Promise.resolve(fn());
  beforeEach(() => { document.body.innerHTML = ''; });

  test('fills a line whose name also appears in an open cart modal', async () => {
    mountMenu();
    const cart = document.createElement('div');
    cart.setAttribute('role', 'dialog');
    cart.setAttribute('data-qa', 'cart-modal');
    cart.textContent = 'Basket: Whopper £5.89 — 1 item';
    // Prepend: on the live page the cart modal can precede the customise dialog
    // in document order, which is what made find() return it first.
    document.body.prepend(cart);
    const plan = [{ id: 'dr-1', name: 'Whopper', quantity: 1, modifiers: [], prefillable: true }];
    const results = await buildBasket({ basketPlan: plan }, { wait: fastWait, headless: true });
    expect(results[0]).toMatchObject({ name: 'Whopper', added: 1, ok: true });
  });
});

// A synthetic Deliveroo basket in the LIVE shape (2026-07-11, Popeyes
// Shoreditch): an aside[aria-label="Basket"] with "Nx Item £…" row buttons and
// a "Delete all items" control that opens an "Are you sure…?" confirm dialog;
// confirming empties the basket in one action. The aside ALSO hosts a "People
// also added" carousel with quick-add steppers that must never be clicked.
function mountRooBasket(rows, { stickyConfirm = false } = {}) {
  const aside = document.createElement('aside');
  aside.setAttribute('aria-label', 'Basket');
  document.body.appendChild(aside);
  rows.forEach(({ name, qty }) => {
    const row = document.createElement('button');
    row.className = 'roo-row';
    row.textContent = `${qty}x${name}£1.00`;
    aside.appendChild(row);
  });
  const decoy = document.createElement('button');
  decoy.setAttribute('aria-label', 'Decrease quantity');
  decoy.dataset.decoyClicks = '0';
  decoy.addEventListener('click', () => { decoy.dataset.decoyClicks = String(Number(decoy.dataset.decoyClicks) + 1); });
  aside.appendChild(decoy);
  const del = document.createElement('button');
  del.setAttribute('aria-label', 'Delete all items');
  del.addEventListener('click', () => {
    const dlg = document.createElement('div');
    dlg.setAttribute('role', 'dialog');
    dlg.setAttribute('aria-modal', 'true');
    const p = document.createElement('p');
    p.textContent = 'Are you sure you want to delete this basket?';
    const yes = document.createElement('button');
    yes.textContent = 'Delete this basket';
    yes.addEventListener('click', () => {
      dlg.remove();
      if (stickyConfirm) return; // simulates a confirm whose click never lands
      [...aside.querySelectorAll('.roo-row')].forEach((r) => r.remove());
      del.remove();
    });
    dlg.appendChild(p); dlg.appendChild(yes);
    document.body.appendChild(dlg);
  });
  aside.appendChild(del);
  return aside;
}

describe('clearBasket — Deliveroo clear-all flow', () => {
  const fastWait = (fn) => Promise.resolve(fn());
  beforeEach(() => { document.body.innerHTML = ''; });

  test('clears via Delete all items + confirm, counting the basket rows', async () => {
    mountRooBasket([{ name: 'Stale Hot Honey', qty: 2 }, { name: 'Stale Fries', qty: 1 }]);
    const r = await clearBasket(document, 'deliveroo', fastWait);
    expect(r).toEqual({ hadItems: true, cleared: true, removed: 3 });
    expect(document.querySelector('[aria-label="Delete all items"]')).toBeNull();
  });

  test('never clicks the recommended-items quick-add steppers in the aside', async () => {
    mountRooBasket([{ name: 'Stale A', qty: 1 }]);
    await clearBasket(document, 'deliveroo', fastWait);
    expect(document.querySelector('[aria-label="Decrease quantity"]').dataset.decoyClicks).toBe('0');
  });

  test('is a no-op when the Deliveroo basket is empty (no delete-all control)', async () => {
    mountRooBasket([]);
    document.querySelector('[aria-label="Delete all items"]').remove();
    const r = await clearBasket(document, 'deliveroo', fastWait);
    expect(r).toEqual({ hadItems: false, cleared: true, removed: 0 });
  });

  test('reports cleared:false when confirming never empties the basket', async () => {
    mountRooBasket([{ name: 'Stuck', qty: 1 }], { stickyConfirm: true });
    const r = await clearBasket(document, 'deliveroo', fastWait);
    expect(r).toMatchObject({ hadItems: true, cleared: false });
  });
});

describe('buildBasket clears the basket first', () => {
  const fastWait = (fn) => Promise.resolve(fn());
  beforeEach(() => { document.body.innerHTML = ''; });

  test('empties pre-existing items before adding the plan (order matters)', async () => {
    mountMenu();
    const events = [];
    mountRooBasket([{ name: 'Stale Hot Honey', qty: 1 }]);
    document.querySelector('[aria-label="Delete all items"]').addEventListener('click', () => events.push('cleared'));
    document.querySelector('[data-item-id="dr-1"]').addEventListener('click', () => events.push('add-clicked'));
    const plan = [{ id: 'dr-1', name: 'Whopper', quantity: 1, modifiers: [], prefillable: true }];
    const results = await buildBasket({ platform: 'deliveroo', basketPlan: plan }, { wait: fastWait, headless: true });
    expect(results[0]).toMatchObject({ ok: true });
    expect(events[0]).toBe('cleared');
    expect(events).toContain('add-clicked');
    expect(document.querySelectorAll('.roo-row')).toHaveLength(0);
  });

  test('does not clear when the plan is empty', async () => {
    mountRooBasket([{ name: 'Keep Me', qty: 1 }]);
    await buildBasket({ platform: 'deliveroo', basketPlan: [] }, { wait: fastWait, headless: true });
    expect(document.querySelectorAll('.roo-row')).toHaveLength(1);
  });

  test('overlay reports how many pre-existing items were removed', async () => {
    mountMenu();
    mountRooBasket([{ name: 'Stale A', qty: 1 }, { name: 'Stale B', qty: 1 }]);
    const plan = [{ id: 'dr-1', name: 'Whopper', quantity: 1, modifiers: [], prefillable: true }];
    await buildBasket({ platform: 'deliveroo', basketPlan: plan }, { wait: fastWait });
    const shadow = document.getElementById('feedme-builder').shadowRoot;
    expect(shadow.textContent).toContain('Removed 2 item(s) already in the basket');
  });

  test('overlay warns in amber when clearing fails, and the fill still runs', async () => {
    mountMenu();
    mountRooBasket([{ name: 'Stuck', qty: 1 }], { stickyConfirm: true });
    const plan = [{ id: 'dr-1', name: 'Whopper', quantity: 1, modifiers: [], prefillable: true }];
    const results = await buildBasket({ platform: 'deliveroo', basketPlan: plan }, { wait: fastWait });
    expect(results[0]).toMatchObject({ ok: true });
    const shadow = document.getElementById('feedme-builder').shadowRoot;
    expect(shadow.textContent).toContain("Couldn't clear pre-existing items — check your basket.");
  });
});

describe('cross-restaurant new-basket prompt', () => {
  const fastWait = (fn) => Promise.resolve(fn());
  beforeEach(() => { document.body.innerHTML = ''; });

  test('accepts a "start new order?" confirm that blocks the add, then counts the line', async () => {
    mountMenu();
    // First add-click spawns a Deliveroo-style confirm instead of closing the
    // dialog; clicking "New order" removes the confirm AND completes the add.
    const root = document.getElementById('dialog-root');
    let intercepted = false;
    root.addEventListener('click', (e) => {
      if (!e.target.classList.contains('add') || intercepted) return;
      intercepted = true;
      e.stopPropagation();
      const confirm = document.createElement('div');
      confirm.setAttribute('role', 'dialog');
      confirm.id = 'confirm';
      const p = document.createElement('p');
      p.textContent = 'Starting a new order will clear your basket at Popeyes Whitechapel';
      const yes = document.createElement('button');
      yes.textContent = 'New order';
      yes.addEventListener('click', () => { confirm.remove(); root.innerHTML = ''; });
      confirm.appendChild(p); confirm.appendChild(yes);
      document.body.appendChild(confirm);
    }, true);
    const plan = [{ id: 'dr-1', name: 'Whopper', quantity: 1, modifiers: [], prefillable: true }];
    const results = await buildBasket({ platform: 'deliveroo', basketPlan: plan }, { wait: fastWait, headless: true });
    expect(results[0]).toMatchObject({ name: 'Whopper', added: 1, ok: true });
    expect(document.getElementById('confirm')).toBeNull();
  });
});

// #37 honesty: a line can add successfully while one of its selections never
// registered — presenting that as a clean fill hides a wrong basket. Any
// failed modifier selection must flag the line for review.
describe('failed modifier selections flag the line for review', () => {
  const fastWait = (fn) => Promise.resolve(fn());
  beforeEach(() => { document.body.innerHTML = ''; });

  test('ok line with an unselectable modifier gets review:true', async () => {
    mountMenu();
    const plan = [{
      id: 'dr-9', name: 'Honey BBQ Sandwich', quantity: 1,
      modifiers: [{ id: 'opt-1', name: 'Regular Fries' }, { id: 'nope', name: 'Unicorn Dust' }],
      prefillable: true,
    }];
    const results = await buildBasket({ basketPlan: plan }, { wait: fastWait, headless: true });
    expect(results[0]).toMatchObject({ name: 'Honey BBQ Sandwich', added: 1, ok: true, review: true });
  });

  test('ok line with all modifiers selected stays clean', async () => {
    mountMenu();
    const plan = [{
      id: 'dr-9', name: 'Honey BBQ Sandwich', quantity: 1,
      modifiers: [{ id: 'opt-1', name: 'Regular Fries' }],
      prefillable: true,
    }];
    const results = await buildBasket({ basketPlan: plan }, { wait: fastWait, headless: true });
    expect(results[0].ok).toBe(true);
    expect(results[0].review).toBeFalsy();
  });
});

// #37: Deliveroo lazy-renders menu sections (137 cards appear only after
// scrolling, live 2026-07-12) and has NO menu search box, so an unrendered
// item was unfindable and a rendered superstring card (the Sharebox) matched
// instead. With no search box the builder must scroll to force the sections.
describe('card discovery on lazily rendered menus', () => {
  beforeEach(() => { document.body.innerHTML = ''; });

  test('scrolls to force a lazy section to render when there is no search box', async () => {
    document.body.innerHTML = '<main><div class="menu"></div></main>';
    window.addEventListener('scroll', function once() {
      window.removeEventListener('scroll', once);
      const btn = document.createElement('button');
      btn.className = 'item';
      btn.textContent = 'Crunchy Cheese Bites £3.29';
      btn.addEventListener('click', () => {
        const dlg = document.createElement('div');
        dlg.setAttribute('role', 'dialog');
        const h = document.createElement('h2');
        h.textContent = 'Crunchy Cheese Bites';
        const add = document.createElement('button');
        add.className = 'add';
        add.textContent = 'Add to basket';
        add.addEventListener('click', () => dlg.remove());
        dlg.appendChild(h); dlg.appendChild(add);
        document.body.appendChild(dlg);
      });
      document.querySelector('.menu').appendChild(btn);
    });
    const plan = [{ name: 'Crunchy Cheese Bites', quantity: 1, modifiers: [], prefillable: true }];
    const results = await buildBasket({ platform: 'deliveroo', basketPlan: plan }, { wait: fastWait, headless: true });
    expect(results[0]).toMatchObject({ name: 'Crunchy Cheese Bites', added: 1, ok: true });
  });
});

// #37: Deliveroo prefixes promo cards' aria-labels with a badge ("NEW ✨ …"),
// which defeats the plain prefix match — the plan item's own card is invisible
// and a superstring sibling (the Sharebox) wins instead.
describe('promo-badged card labels', () => {
  beforeEach(() => { document.body.innerHTML = ''; });

  test('matches a card whose label carries a leading NEW badge', () => {
    document.body.innerHTML = `
      <div role="button" aria-label="NEW ✨ Crunchy Cheese Bites , A savoury blend, 482 kcal, £3.29"></div>
      <div role="button" aria-label="Crunchy Cheese Bites Sharebox®, A savoury blend, 963 kcal, £8.19"></div>`;
    const el = findItemCard(document, { name: 'Crunchy Cheese Bites' }, 'deliveroo');
    expect(el).toBeTruthy();
    expect(el.getAttribute('aria-label')).toMatch(/^NEW/);
  });

  test('does not treat an ordinary word prefix as a badge (superstring guard)', () => {
    document.body.innerHTML = `
      <div role="button" aria-label="Deluxe Crunchy Cheese Bites, 963 kcal, £8.19"></div>`;
    expect(findItemCard(document, { name: 'Crunchy Cheese Bites' }, 'deliveroo')).toBeNull();
  });
});

// Live failure (user retest of #24, 2026-07-12): the basket UI hydrates from the
// platform's basket API after page load, but clearBasket sampled the DOM once at
// injection time — on Just Eat the stale same-restaurant basket hadn't rendered
// yet, so the clear concluded "empty" and the fill stacked on top of it.
describe('clearBasket waits for the basket UI to hydrate', () => {
  beforeEach(() => { document.body.innerHTML = ''; });
  // Clamp the production wait timeouts (the hydration wait is 6s) so the
  // nothing-ever-hydrates case still finishes within jest's limit.
  const pollWait = (fn, { timeout = 500 } = {}) => new Promise((resolve) => {
    const start = Date.now();
    const capped = Math.min(timeout, 300);
    const tick = () => {
      let v = null; try { v = fn(); } catch (_) {}
      if (v) return resolve(v);
      if (Date.now() - start > capped) return resolve(null);
      setTimeout(tick, 10);
    };
    tick();
  });

  test('clears a Just Eat pane that renders after injection', async () => {
    setTimeout(() => mountBasketPane([{ name: 'Stale Sauce', qty: 1 }]), 30);
    const r = await clearBasket(document, 'just-eat', pollWait);
    expect(r).toEqual({ hadItems: true, cleared: true, removed: 1 });
  });

  test('clears a Deliveroo basket whose delete-all renders after injection', async () => {
    setTimeout(() => mountRooBasket([{ name: 'Stale Biscuit', qty: 1 }]), 30);
    const r = await clearBasket(document, 'deliveroo', pollWait);
    expect(r).toEqual({ hadItems: true, cleared: true, removed: 1 });
  });

  test('still reports an empty basket when nothing ever hydrates', async () => {
    const r = await clearBasket(document, 'just-eat', pollWait);
    expect(r).toEqual({ hadItems: false, cleared: true, removed: 0 });
  });
});

// Live #37 retest failure (2026-07-12, McDonald's Commercial Road): BOTH cards
// render, but the Sharebox has a compact carousel variant ("Crunchy Cheese Bites
// Sharebox®, 482 kcal, £8.19") whose label is SHORTER than the plain item's
// verbose card ("Crunchy Cheese Bites, A savoury blend…, 161 kcal, £3.59") — so
// the shortest-label sort picked the superstring. The label's NAME SEGMENT (text
// before the first comma/price) is the signal; an exact segment match must
// outrank any superstring regardless of description length.
describe('exact-name cards outrank superstring variants', () => {
  beforeEach(() => { document.body.innerHTML = ''; });

  test('prefers the exact-named card over a shorter superstring label', () => {
    document.body.innerHTML = `
      <div role="button" aria-label="Crunchy Cheese Bites Sharebox®, 482 kcal, £8.19"></div>
      <div role="button" aria-label="Crunchy Cheese Bites, A savoury blend of Mozzarella &amp; Gouda in a crunchy breadcrumb coating, served with BBQ dip. Allergen info: mcdonalds.co.uk/nutrition, 161 kcal, £3.59"></div>`;
    const el = findItemCard(document, { name: 'Crunchy Cheese Bites' }, 'deliveroo');
    expect(el).toBeTruthy();
    expect(el.getAttribute('aria-label')).toMatch(/^Crunchy Cheese Bites,/);
  });

  test('prefers the exact-named Just Eat overlay over a superstring one', () => {
    document.body.innerHTML = `
      <p id="n1">Crunchy Cheese Bites Sharebox® from £8.19</p>
      <span role="button" data-qa="item" aria-labelledby="n1"></span>
      <p id="n2">Crunchy Cheese Bites from £3.59</p>
      <span role="button" data-qa="item" aria-labelledby="n2"></span>`;
    const el = findItemCard(document, { name: 'Crunchy Cheese Bites' }, 'just-eat');
    expect(el).toBeTruthy();
    expect(el.getAttribute('aria-labelledby')).toBe('n2');
  });

  test('scrolls past a rendered superstring to reach the exact item', async () => {
    const fastWait = (fn) => Promise.resolve(fn());
    document.body.innerHTML = `
      <main><div class="menu">
        <div role="button" aria-label="Crunchy Cheese Bites Sharebox®, 482 kcal, £8.19"></div>
      </div></main>`;
    window.addEventListener('scroll', function once() {
      window.removeEventListener('scroll', once);
      const card = document.createElement('div');
      card.setAttribute('role', 'button');
      card.setAttribute('aria-label', 'Crunchy Cheese Bites, A savoury blend, 161 kcal, £3.59');
      card.addEventListener('click', () => {
        const dlg = document.createElement('div');
        dlg.setAttribute('role', 'dialog');
        const h = document.createElement('h2');
        h.textContent = 'Crunchy Cheese Bites';
        const add = document.createElement('button');
        add.className = 'add';
        add.textContent = 'Add to basket';
        add.addEventListener('click', () => dlg.remove());
        dlg.appendChild(h); dlg.appendChild(add);
        document.body.appendChild(dlg);
      });
      document.querySelector('.menu').appendChild(card);
    });
    const plan = [{ name: 'Crunchy Cheese Bites', quantity: 1, modifiers: [], prefillable: true }];
    const results = await buildBasket({ platform: 'deliveroo', basketPlan: plan }, { wait: fastWait, headless: true });
    expect(results[0]).toMatchObject({ name: 'Crunchy Cheese Bites', added: 1, ok: true });
  });
});

// ── Uber meal wizard navigation (#47) ────────────────────────────────────────
// Live shapes (McDonald's Bethnal Green Road, 2026-07-14): meal items hide
// concrete options behind CATEGORY radios ("Cold Drink", "Bottled Drinks"…).
// Clicking a category REPLACES the whole dialog with a sub-screen carrying a
// button[aria-label="Go back"], the category's concrete options, and a bottom
// "Save • £X" button. Save commits and returns to the parent screen (or stays
// and flags when that screen's Required groups are unmet — the platform's own
// validation); Go back discards. Sub-screens do NOT contain the item name, and
// the real "Add 1 to order • £X" button exists only on the top-level screen.
describe('Uber meal wizard navigation (#47)', () => {
  // A faithful jsdom model of the wizard. Every screen render REPLACES the
  // dialog node (as live React does, #26), option rows use the live
  // input+sibling-label[for] shape, and radio input name attrs are unique per
  // screen (navigation is detectable by a radio group vanishing).
  function mountWizardStore({ defaults = false } = {}) {
    const state = {
      side: defaults ? 'Medium Fries' : null,
      drinkCat: null,
      drink: null,
      addOn: defaults ? 'No Thanks' : null,
      pendingDrink: null,
      added: 0,
      composition: null,
    };
    const CATS = {
      'Cold Drink': ['(Upgrade) Regular Frozen Cherry Lemonade', 'Medium Diet Coke®', 'Medium Coca-Cola® Zero Sugar'],
      'Bottled Drinks': ['GLACEAU Smartwater', 'Medium Oasis® Zero'],
      'Milkshake': ['(Upgrade) Medium Chocolate Milkshake'],
    };
    document.body.innerHTML = `
      <button class="item">Big Mac®£5.89 • 509 kcal</button>
      <div id="modal"></div>`;
    const modal = document.getElementById('modal');

    const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const radio = (group, label, checked) => {
      const v = slug(label);
      return `<input type="radio" name="${group}" value="${v}" id="qv-${group}-${v}"${checked ? ' checked' : ''}>`
        + `<label for="qv-${group}-${v}"><div>${label}</div></label>`;
    };

    const renderTop = () => {
      modal.innerHTML = `
        <div role="dialog">
          <button aria-label="Close">Close</button>
          <h1>Big Mac®</h1>
          <div data-testid="customization-pick-one"><div>Select Option</div><span>Choose 1</span><div>Required</div>
            ${radio('sel-uuid+0', 'Medium Big Mac® Meal', state.drink != null)}
            ${radio('sel-uuid+0', 'Big Mac®', false)}
          </div>
          <button class="top-add">Add 1 to order • £7.59</button>
        </div>`;
    };
    const renderMeal = () => {
      const drinkGroup = state.drink
        ? `<div>${state.drinkCat}${state.drink}Edit selections</div>`
        : Object.keys(CATS).map((c) => radio('drink-uuid+1', c, false)).join('');
      modal.innerHTML = `
        <div role="dialog">
          <button aria-label="Go back">Back</button>
          <div>Medium Big Mac® Meal</div>
          <div data-testid="customization-pick-one"><div>Medium Side</div><span>Choose 1</span><div>Required</div>
            ${radio('side-uuid+0', 'Medium Fries', state.side === 'Medium Fries')}
            ${radio('side-uuid+0', 'Side Salad', state.side === 'Side Salad')}
          </div>
          <div data-testid="customization-pick-one"><div>Medium Drink</div><span>Choose 1</span><div>Required</div>
            ${drinkGroup}
          </div>
          <div data-testid="customization-pick-one"><div>Meal Add On</div><span>Choose 1</span><div>Required</div>
            ${radio('addon-uuid+2', '4 Chicken McNuggets®', state.addOn === '4 Chicken McNuggets®')}
            ${radio('addon-uuid+2', 'No Thanks', state.addOn === 'No Thanks')}
          </div>
          <button class="save">Save • £7.59</button>
        </div>`;
    };
    const renderLeaf = (cat) => {
      modal.innerHTML = `
        <div role="dialog">
          <button aria-label="Go back">Back</button>
          <div>${cat}</div>
          <div data-testid="customization-pick-one"><div>${cat}</div><span>Choose 1</span><div>Required</div>
            ${CATS[cat].map((d) => radio('leaf-' + slug(cat) + '+0', d, state.pendingDrink === d)).join('')}
          </div>
          <button class="save">Save • £7.59</button>
        </div>`;
    };

    let screen = 'closed';
    document.querySelector('.item').addEventListener('click', () => {
      if (screen !== 'closed') return;
      screen = 'top';
      renderTop();
    });
    const findLabelText = (input) => {
      const lab = modal.querySelector(`label[for="${input.id}"]`);
      return lab ? lab.textContent.trim() : '';
    };
    modal.addEventListener('click', (e) => {
      const t = e.target;
      if (t.tagName === 'INPUT' && t.type === 'radio') {
        const label = findLabelText(t);
        if (screen === 'top') {
          if (label === 'Medium Big Mac® Meal') { screen = 'meal'; renderMeal(); }
          return;
        }
        if (screen === 'meal') {
          if (t.name.startsWith('side-')) { state.side = label; renderMeal(); return; }
          if (t.name.startsWith('addon-')) { state.addOn = label; renderMeal(); return; }
          if (t.name.startsWith('drink-')) {
            // entering a category resets the group's committed choice (live)
            state.drinkCat = label; state.drink = null; state.pendingDrink = null;
            screen = 'leaf'; renderLeaf(label);
          }
          return;
        }
        if (screen === 'leaf') { state.pendingDrink = label; renderLeaf(state.drinkCat); }
        return;
      }
      if (t.matches('button[aria-label="Go back"]')) {
        if (screen === 'leaf') { state.pendingDrink = null; screen = 'meal'; renderMeal(); }
        return;
      }
      if (t.matches('.save')) {
        if (screen === 'leaf') {
          if (state.pendingDrink) { state.drink = state.pendingDrink; screen = 'meal'; renderMeal(); }
          else renderLeaf(state.drinkCat); // validation: stays put
          return;
        }
        if (screen === 'meal') {
          if (state.side && state.drink && state.addOn) { screen = 'top'; renderTop(); }
          else renderMeal(); // validation: stays put, node still replaced
        }
        return;
      }
      if (t.matches('.top-add')) {
        state.added += 1;
        state.composition = { side: state.side, drinkCat: state.drinkCat, drink: state.drink, addOn: state.addOn };
        screen = 'closed';
        modal.innerHTML = '';
      }
    });
    return state;
  }

  test('navigates a category sub-screen to select a nested drink and restores a stray click', async () => {
    const state = mountWizardStore();
    const plan = [{
      name: 'Big Mac®', quantity: 1, prefillable: true,
      modifiers: [
        { group: 'Choose your side', name: 'Medium Fries' },
        { group: 'Choose your drink', name: 'Medium Diet Coke®' },
        { group: 'Meal Add On', name: 'No Thanks' },
      ],
    }];
    const results = await buildBasket({ platform: 'uber-eats', basketPlan: plan }, { wait: fastWait, headless: true });
    expect(results[0]).toMatchObject({ added: 1, ok: true });
    // The stray Side Salad candidate click must have been restored to Medium
    // Fries before moving on, so the composition matches the user's order.
    expect(state.composition).toEqual({
      side: 'Medium Fries', drinkCat: 'Cold Drink', drink: 'Medium Diet Coke®', addOn: 'No Thanks',
    });
    expect(results[0].review).toBeFalsy();
  });

  test('backs out of a category that lacks the drink and finds it in the next', async () => {
    const state = mountWizardStore({ defaults: true });
    const plan = [{
      name: 'Big Mac®', quantity: 1, prefillable: true,
      modifiers: [{ group: 'Choose your drink', name: 'Medium Oasis® Zero' }],
    }];
    const results = await buildBasket({ platform: 'uber-eats', basketPlan: plan }, { wait: fastWait, headless: true });
    expect(results[0]).toMatchObject({ added: 1, ok: true });
    expect(state.composition).toMatchObject({ drinkCat: 'Bottled Drinks', drink: 'Medium Oasis® Zero' });
  });

  test('fails the line honestly when Save keeps refusing (required groups unmet)', async () => {
    const state = mountWizardStore(); // no defaults: side/add-on never selected
    const plan = [{
      name: 'Big Mac®', quantity: 1, prefillable: true,
      modifiers: [{ group: 'Choose your drink', name: 'Medium Diet Coke®' }],
    }];
    const results = await buildBasket({ platform: 'uber-eats', basketPlan: plan }, { wait: fastWait, headless: true });
    expect(results[0]).toMatchObject({ added: 0, ok: false });
    expect(state.added).toBe(0);
  });

  test('findAddButton never mistakes a wizard Save button for the add', () => {
    document.body.innerHTML = `
      <div role="dialog">
        <button aria-label="Go back">Back</button>
        <button>Save • £7.59</button>
      </div>`;
    expect(findAddButton(document.querySelector('[role="dialog"]'))).toBeFalsy();
  });
});
