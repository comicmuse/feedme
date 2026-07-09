---
name: verify
description: Drive FeedMe's real pipeline against live delivery platforms to verify a change end-to-end (capture → match → fill), without loading the extension
---

# Verifying FeedMe changes live

FeedMe is a browser extension; the Playwright MCP chromium cannot load it. Instead, run the real modules directly:

- **Shared logic** (`src/shared/parsers.js`, `matcher.js`) is plain CommonJS — run it in Node over data captured from live pages.
- **Content scripts** (`dist/*.js` after `npm run build`, or a scratch esbuild bundle of one module) — inject into the live page with `browser_run_code_unsafe`.

## Recipe (used for the #21 acceptance, 2026-07-09)

1. `npm run build` (esbuild, `dist/`).
2. To expose one module in a page: bundle a one-line entry, e.g.
   `window.__feedmeExtract = require('<repo>/src/content/checkout-reader.js').extractOrder;`
   with `npx esbuild entry.js --bundle --format=iife`.
3. Inject via `browser_run_code_unsafe` with `filename:` pointing at a snippet file under `.playwright-mcp/` (gitignored). Embed the bundle with `JSON.stringify(src)` and `page.evaluate((src) => eval(src), src)`.
   **Never base64+`atob` the bundle** — `atob` mangles UTF-8, silently corrupting every `£` in the code so price regexes stop matching (cost a debugging round).
4. Source capture (Uber): store page → add items (works anonymously) → `/gb/checkout` renders `[data-testid="cart-summary-panel"]` without login → run `extractOrder('uber-eats', document)`.
5. Target menu (Just Eat): `/restaurants-<slug>/menu`, dump `window.__NEXT_DATA__`; in Node run `parseMenuResponse('just-eat', data)` + `matchItems(order.items, parsed.items)` → `basketPlan` (as `service-worker.js` does).
6. Fill: on the target menu page set `window.__feedmeBuild = { platform, basketPlan }` then eval `dist/basket-builder.js`. Poll `document.getElementById('feedme-builder')?.shadowRoot?.textContent` for "basket filled" / "almost there". The builder logs every decision as `[FeedMe builder]` console.info — read the MCP console log file for the trail.
7. Confirm for real: open the platform's basket (JE: "View basket" button on narrow viewports; `/basket` is a 404) and check the item + modifier lines, then screenshot.

## Gotchas

- Fresh MCP profile → cookie banners come back; Uber saved address lives in the profile.
- If MCP errors "Browser ... is not installed", run the exact `npx @playwright/mcp install-browser <name>` command it prints; first navigate after install can fail once ("browser has been closed") — just retry.
- The persistent profile's baskets accumulate test items across sessions — check what's already there before attributing items to your run.
- Uber quick-view dialog DOM drifts (2026-07-09: option rows are plain divs, `input` name/value are uuids, `closest('li')` spans the whole group) — re-dump the DOM rather than trusting old notes.
