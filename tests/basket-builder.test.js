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
      <button class="item">Mighty Bucket</button>`;
    let panelClicked = false;
    document.querySelector('[data-qa="location-panel"] .add').addEventListener('click', () => { panelClicked = true; });
    let itemAdds = 0;
    document.querySelector('.item').addEventListener('click', () => { itemAdds += 1; });

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
      <div id="results"></div>`;
    // Like the live menu: matching cards render only after a search.
    document.querySelector('input[type="search"]').addEventListener('input', (e) => {
      if (/zinger/i.test(e.target.value)) {
        document.getElementById('results').innerHTML =
          '<button class="item">Zinger Tower Burger</button>';
        document.querySelector('.item').addEventListener('click', function () {
          this.dataset.added = (Number(this.dataset.added || 0) + 1).toString();
        });
      }
    });

    const plan = [{ name: 'Zinger Tower Burger', quantity: 1, modifiers: [], prefillable: true }];
    const results = await buildBasket({ basketPlan: plan }, { wait: pollWait, headless: true });
    expect(results[0]).toMatchObject({ added: 1, ok: true });
  });
});
