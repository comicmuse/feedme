# Extension icons

`src/*.svg` are the editable sources. The `.png` files beside them are rendered
output, committed so the extension loads straight from a clone and store
packaging does not depend on a designer's toolchain.

After editing any SVG:

```sh
./scripts/render-icons.sh
```

`tests/icons.test.js` checks every declared size exists at the right dimensions,
carries real content, and still has its SVG source.

## Why the sizes differ

They are not one drawing scaled four ways. Each size is drawn to what it can
actually resolve — at 16px the whole icon is smaller than one row of the 128px
composition.

| Size | Where it appears | What it carries |
|---|---|---|
| 16 | Toolbar | Burger, three bands |
| 32 | Toolbar (Firefox; Chrome at 2x) | Burger, seeds, outlines |
| 48 | Extensions page, install prompt, toolbar at 3x | Burger, finer seeds |
| 128 | Store listing, install prompt | Clipboard, price rows, £ price-drop arrow, burger |

## Why only 128 has the arrow

The toolbar icon is the **identity** layer and never changes. The badge is the
**state** layer: `src/background/service-worker.js` paints a green `#22c55e`
badge over the bottom-right of the toolbar icon when an order is captured.

A green price-drop arrow in the icon would be overpainted by that badge, in a
near-identical green, while making a different claim — the badge means "order
detected here", the arrow means "cheaper available". It would also assert
"cheaper available" on every tab, including ones with no order at all.

So every toolbar-capable size (16, 32 and 48 — Chrome can use the 48 at 300%
display scaling) is the burger alone. Only 128, which is never drawn in the
toolbar, carries the full idea.

Green is reserved for "cheaper" throughout, which is why the burger has no
lettuce.
