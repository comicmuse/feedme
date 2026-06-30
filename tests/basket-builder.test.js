/**
 * @jest-environment jsdom
 */
const { buildBasket } = require('../src/content/basket-builder');

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
      root.innerHTML = `
        <div role="dialog">
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
