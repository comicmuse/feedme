/**
 * @jest-environment jsdom
 */
const { buildBasket } = require('../src/content/basket-builder');

// Just Eat sells sizes as a required variation radio GROUP, not a modifier
// (#102). A multi-variation item renders "from £X" and opens a customise dialog
// whose Add button stays DISABLED until a <pie-radio> size is picked. parseJustEat
// prices the plan line from a specific variation and stamps its catalogue id on
// `variationId` (distinct from the item `id`, e.g. "<id>-0"); the live pie-radio
// host carries that same id (Tayyabs Aldgate, 2026-08-09):
//
//   <pie-radio data-qa="item-choices-variants-element-0" role="radio"
//              id="78099bca-…-0" name="Selects the size of the product"
//              aria-checked="false">  Small £15.60  </pie-radio>
//   … shadow: <input type="radio" data-test-id="pie-radio-input"
//              value="78099bca-…-0">
//   <pie-button data-qa="item-choices-action-submit">Add £15.60</pie-button>
//
// This fixture mirrors that shape in light DOM: a <pie-radio> host per size, each
// wrapping a real radio <input> whose value is the variation id, and an Add button
// gated on a selection. The single-variation ("fixed price") item opens a dialog
// with no radios and an already-enabled Add button.
function mountJustEatMenu() {
  document.body.innerHTML = `
    <main>
      <div class="menu">
        <button class="item" data-qa="item" data-item-id="kg">Karahi Gosht <span>from £15.60</span></button>
        <button class="item" data-qa="item" data-item-id="sk">Seekh Kebab (2 Pieces) <span>£4.80</span></button>
      </div>
      <div id="dialog-root"></div>
    </main>`;

  const sizes = {
    kg: [
      { id: 'kg-0', label: 'Small', price: '£15.60' },
      { id: 'kg-1', label: 'Large', price: '£30.00' },
    ],
  };

  document.querySelectorAll('.item').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.itemId;
      const name = btn.textContent.replace(/from\s*£[\d.]+|£[\d.]+/, '').trim();
      const root = document.getElementById('dialog-root');
      const variants = sizes[id];
      // Multi-variation: a required size group; Add disabled until a size is ticked.
      const radiosHtml = (variants || [])
        .map((v, i) => `
          <pie-radio data-qa="item-choices-variants-element-${i}" role="radio" id="${v.id}" aria-checked="false">
            <input type="radio" name="size" value="${v.id}" data-test-id="pie-radio-input">
            <span>${v.label} ${v.price}</span>
          </pie-radio>`)
        .join('');
      root.innerHTML = `
        <div role="dialog">
          <h2>${name}</h2>
          ${radiosHtml}
          <button class="add" data-qa="item-choices-action-submit" ${variants ? 'aria-disabled="true"' : ''}>Add to basket</button>
        </div>`;

      const add = root.querySelector('.add');
      // Ticking a size enables Add (mirrors the platform's own validation).
      root.querySelectorAll('input[type="radio"]').forEach((input) => {
        input.addEventListener('click', () => {
          root.querySelectorAll('pie-radio').forEach((r) => r.setAttribute('aria-checked', 'false'));
          input.closest('pie-radio').setAttribute('aria-checked', 'true');
          add.setAttribute('aria-disabled', 'false');
        });
      });
      add.addEventListener('click', () => {
        if (add.getAttribute('aria-disabled') === 'true') return; // disabled: no-op
        const chosen = root.querySelector('pie-radio[aria-checked="true"]');
        btn.dataset.added = (Number(btn.dataset.added || 0) + 1).toString();
        if (chosen) btn.dataset.variation = chosen.id;
        root.innerHTML = '';
      });
    });
  });
}

// fastWait runs the predicate once, synchronously — jsdom clicks settle radios
// and enable the Add button in the same tick, so a single evaluation suffices.
const fastWait = (fn) => Promise.resolve(fn());

describe('Just Eat variation selection (#102)', () => {
  beforeEach(() => mountJustEatMenu());

  test('selects the priced variation radio (its id) and enables Add', async () => {
    const plan = [{
      id: 'kg', variationId: 'kg-0', name: 'Karahi Gosht', quantity: 1,
      modifiers: [], prefillable: true,
    }];
    const results = await buildBasket(
      { platform: 'just-eat', basketPlan: plan }, { wait: fastWait, headless: true });
    expect(results[0]).toMatchObject({ added: 1, ok: true });
    expect(results[0].review).toBeUndefined();
    const card = document.querySelector('[data-item-id="kg"]');
    expect(card.dataset.added).toBe('1');
    // The SAME variation the sidebar priced (cheapest, "-0"), not merely any size.
    expect(card.dataset.variation).toBe('kg-0');
  });

  test('a priced variation not present surfaces for review, never a clean fill', async () => {
    const plan = [{
      id: 'kg', variationId: 'kg-9', name: 'Karahi Gosht', quantity: 1,
      modifiers: [], prefillable: true,
    }];
    const results = await buildBasket(
      { platform: 'just-eat', basketPlan: plan }, { wait: fastWait, headless: true });
    // The priced size cannot be picked, so Add never enables — the line fails
    // honestly (surfaces in the manual list) rather than filling a wrong size.
    expect(results[0].ok).toBe(false);
    const card = document.querySelector('[data-item-id="kg"]');
    expect(card.dataset.added).toBeUndefined();
    // No other size was silently ticked.
    expect(card.dataset.variation).toBeUndefined();
  });

  test('a single-variation line (variationId === id) is unaffected', async () => {
    const plan = [{
      id: 'sk', variationId: 'sk', name: 'Seekh Kebab (2 Pieces)', quantity: 1,
      modifiers: [], prefillable: true,
    }];
    const results = await buildBasket(
      { platform: 'just-eat', basketPlan: plan }, { wait: fastWait, headless: true });
    expect(results[0]).toMatchObject({ added: 1, ok: true });
    expect(results[0].review).toBeUndefined();
    expect(document.querySelector('[data-item-id="sk"]').dataset.added).toBe('1');
  });
});
