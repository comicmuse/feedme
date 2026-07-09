/**
 * @jest-environment jsdom
 */
const { buildBasket, findItemCard, selectModifier, findAddButton } = require('../src/content/basket-builder');

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

  test('selects deterministically by modifier id via input value (Deliveroo shape)', async () => {
    document.body.innerHTML = `
      <div role="dialog">
        <button type="button"><span>Bold BBQ Sauce Dip</span><input type="radio" value="2610419456" name="2610419456"></button>
      </div>`;
    const dialog = document.querySelector('[role="dialog"]');
    const ok = await selectModifier(dialog, { id: '2610419456', name: 'Bold BBQ Sauce Dip' }, pollWait);
    expect(ok).toBe(true);
    expect(dialog.querySelector('input').checked).toBe(true);
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
