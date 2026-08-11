# Gated-page detection for the basket builder

Issue: [#110](https://github.com/comicmuse/feedme/issues/110) — *Builder cannot distinguish a page gated behind a modal from a missing item*

Date: 2026-08-11

## Problem

When a platform page is gated behind a blocking modal, the builder cannot tell
that apart from an item that genuinely isn't on the menu. Both end as three
clicks that open nothing and the same report: `added: 0, ok: false`.

The reproducible case (observed live 2026-08-09, Firefox fresh profile, Popeyes
Whitechapel, switching an Uber Eats basket to Just Eat): Just Eat had its address
modal open — *"Please enter your street and house number" / "Finding your
location"* — because the profile had no delivery address set. Just Eat will not
open an item's customise dialog until it can resolve deliverability, so every
click reached its handler and was declined. The report gave no hint that the fix
was ten seconds of typing an address, and the failure was indistinguishable from
a Firefox-specific fill bug until a screenshot showed otherwise.

The page state was legible the whole time:

- The Just Eat location/address panel was open. `findOpenDialog`
  (`src/content/basket-builder.js:884`) already excludes it when matching the
  customise dialog, so its presence is recognisable — currently discarded rather
  than reported.
- The basket panel showed fee **ranges** (`Service £0.99 - £2.99`,
  `Small order £0.00 - £2.00`). Just Eat renders fee ranges when no address is
  resolved and single values once one is. Deterministic, not a heuristic.

`clickEl` is `el.click()` (`src/content/basket-builder.js:58`), a synthetic
dispatch that bypasses hit-testing, so a covering backdrop is not what stopped
the click — the platform genuinely refused.

## Goals

- A gated page reports the gate, naming the action the user has to take.
- "Item not found" is reported only when the page was actually usable.
- The gate is surfaced **once per run**, not once per line — the gate blocks
  every line, so N identical failures is noise.
- Unit coverage over both paths, with the gated Just Eat DOM pinned as a fixture.

## Non-goals

- The builder does **not** dismiss the modal or enter an address. The address
  determines price and deliverability, so it is the user's to set (spec #24: the
  builder acts only on explicit intent).
- No new message channel to the sidebar. The builder's results do not currently
  flow back to the service worker; the user-facing report is the in-page overlay
  (`createOverlay`) plus `dlog` console output. The gate surfaces there.

## Current reporting reality

`buildBasket` returns a `results` array (one entry per plan line). At the
real-page bootstrap (`src/content/basket-builder.js:1165`) the return value is
**not captured** — the only thing the user sees is the overlay's "Add these
manually:" / "Check the options on:" sections. So:

- The user-visible surface for the gate is the **overlay**.
- The `buildBasket` return shape matters only to the ~30 unit-test call sites,
  all of which read it as an array (`.find`, `[0].ok`). That contract must not
  change.

## Design

### 1. Gate detection — extracted predicates + one `detectPageGate`

A small set of named, deterministic predicates, one per signal, composed by a
single entry point:

```js
// Returns a gate descriptor { reason, action } or null.
function detectPageGate(doc, platform) { … }
```

- `jeLocationPanel(doc)` — the Just Eat address/location dialog is open. This is
  the exact panel `findOpenDialog` already excludes; it is extracted into this
  shared predicate and `findOpenDialog`'s exclusion is rewritten to call it, so
  the knowledge lives in one place.
- `jeUnresolvedFees(doc)` — the basket panel shows a fee **range** (e.g.
  `£0.99 - £2.99`) rather than a single value, which Just Eat renders only when
  no address is resolved. Corroborates a gated state where the panel was
  dismissed but no address was set.

`detectPageGate` for `just-eat` returns a gate when **either** signal holds. The
panel is the primary/direct signal; the fee-range check is the fallback.

Uber Eats and Deliveroo start with no detector — only whatever the cookie audit
(section 3) finds gates.

Each predicate is independently unit-testable against a pinned fixture. No
registry abstraction — there are only a handful of gates (YAGNI); a flat set of
predicates behind one function is enough and stays easy to read.

Gate descriptor shape:

```js
{ reason: 'je-address',   // stable id for logs/tests
  action: 'Just Eat needs a delivery address before items can be added — '
        + 'set it, then switch again.' }
```

### 2. Run flow & reporting

`buildBasket` probes **once, up front**, before `clearBasket` and before the
line loop:

```js
const gate = detectPageGate(doc, platform);
if (gate) {
  dlog('page is gated:', gate.reason, '— skipping run');
  if (overlay) overlay.setGate(gate);
  const results = [];
  results.gate = gate;      // property on the array; array contract unchanged
  return results;
}
```

- **No clear, no adds** when gated. The user's basket is left untouched, since we
  act on nothing.
- **`results.gate`** is a property on the returned array. The existing tests read
  the return as an array and are unaffected; the gate path gets its own
  assertions. The real-page bootstrap ignores the return, so this shape serves
  only the tests.
- **Overlay** gets a new `setGate(gate)` method that renders one prominent line
  with `gate.action`, styled as a blocking notice (warn colour), distinct from
  the per-item "Add these manually" / "Check the options on" sections. This is
  the once-per-run surface.

Probing up front (rather than per line, after a failure) is correct here because
the Just Eat address gate is present from page load and blocks every line
identically — re-checking it per line would re-run the same detection N times and
still burn three wasted click-loops per line. The cross-restaurant confirm, which
*does* appear mid-run, is a separate modal already handled by
`acceptNewBasketPrompt` and is unaffected by this change.

### 3. Cookie-banner audit (in scope)

An empirical phase whose findings determine which detectors get written:

1. Using the `verify` skill / Playwright-chromium, load a menu on each of Uber
   Eats, Just Eat, and Deliveroo with the cookie banner **undismissed**, and
   attempt to open an item dialog.
2. Record, per platform: does the banner **block** the dialog (a real gate) or is
   it merely a cosmetic overlay that `el.click()` sails through?
3. For every banner that genuinely gates:
   - add a `cookieBanner(doc)` predicate + pinned fixture,
   - wire it into `detectPageGate` with an action message
     (e.g. *"Accept or dismiss the cookie banner to continue."*).
4. Cosmetic banners get no code — recorded here as checked, nothing to do.

Fixtures are pinned from the live DOM so the tests never depend on live sessions.
Findings are written back into this doc (a "Cookie audit results" section) so the
record of what was checked survives.

### 4. Testing

- `detectPageGate` / predicate unit tests over pinned fixtures:
  - gated Just Eat DOM, location-panel variant → gate descriptor `je-address`.
  - gated Just Eat DOM, fee-range variant (panel dismissed, fees unresolved) →
    gate descriptor `je-address`.
  - a clean Just Eat / Uber / Deliveroo menu → `null`.
- `buildBasket` over a gated doc → `results` empty, `results.gate` set,
  **no clear attempted, no adds**.
- `buildBasket` over a clean doc where an item is genuinely absent → still
  reports that line as failed (the "item not found" path), proving the two
  outcomes stay distinct.
- Fixtures + tests for any gating cookie banner the audit finds.

## Acceptance (from #110)

- [ ] A gated page reports the gate, naming the action the user has to take.
- [ ] "Item not found" is reported only when the page was actually usable.
- [ ] Unit coverage over both paths, with the gated Just Eat DOM pinned as a
      fixture.
- [ ] Cookie-banner gating checked on all three platforms; detection added for
      any that gate, findings recorded for those that don't.

## Files touched

- `src/content/basket-builder.js` — `detectPageGate` + predicates, extract
  `jeLocationPanel` and reuse in `findOpenDialog`, up-front probe in
  `buildBasket`, `overlay.setGate`.
- `tests/basket-builder.test.js` (or a new `tests/basket-builder-gate.test.js`)
  — gate-path coverage + pinned fixtures.
