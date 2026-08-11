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

- `jeLocationPanel(doc)` — the Just Eat address/location dialog is open, matched
  by its literal live text ("enter your street and house number" / "finding your
  location" / "where should we deliver"). It scans `DIALOG_SELECTOR` and, like
  `findOpenDialog`, skips `[data-qa="cart-modal"]` so the basket modal is never
  mistaken for it. `findOpenDialog` today excludes the location panel only
  *implicitly* — it matches the customise dialog by item name, which the panel
  lacks. This change makes it explicit: `findOpenDialog` also skips anything
  `isJeLocationDialog` matches, so the "this is the location panel" knowledge
  lives in one predicate rather than drifting between two. Because this now sits
  on the **core add path**, the skip is guarded — a dialog whose *heading* is the
  item name is never dropped (it is the real customise dialog even if its body
  mentions delivery), so a stray regex match can't silently starve a line.
- `jeUnresolvedFees(doc)` — the basket/cart panel (`[data-qa="cart-modal"]`, the
  same container `clearBasket` and `findOpenDialog` already target, live-verified
  2026-07-11) shows a fee **range** (e.g. `Service £0.99 - £2.99`) rather than a
  single value, which Just Eat renders only when no address is resolved. The scan
  is scoped to the cart container — **never** the whole document — so a menu or
  marketing price range elsewhere on the page ("Free delivery over £20 – £30", a
  bundle's "from £X – £Y") can never false-positive. This predicate ships scoped
  to the already-live-verified `[data-qa="cart-modal"]` container; its exact
  fee-row shape is *confirmed and refined* against live JE during the audit (§3) —
  it lands before that audit, which is safe because `jeLocationPanel` is the
  primary signal and this only corroborates, and a miss under-reports a gate
  rather than breaking a usable page.

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
line loop — but **after the page settles**, not at the injection instant:

```js
// The builder is injected at page-`complete`, BEFORE the basket UI hydrates —
// a single instant sample would race the modal's render and miss the gate,
// falling back into the very #110 bug this fixes. clearBasket already waits for
// this hydration (uiPresent); the probe waits the same way: until the page has
// settled OR a gate is already visible, then samples once.
await wait(() => pageSettled(doc, platform) || detectPageGate(doc, platform),
  { timeout: 4000 });
const gate = detectPageGate(doc, platform);
if (gate) {
  dlog('page is gated:', gate.reason, '—', gate.action);
  try { if (overlay) overlay.setGate(gate); } catch (_) {}
  const results = [];
  results.gate = gate;      // property on the array; array contract unchanged
  return results;
}
```

- **Wait for settle, then sample.** `pageSettled(doc, platform)` is true once the
  Just Eat **menu** is interactable — keyed on the live-verified menu search box
  (or an item card), **not** a basket marker. This matters: Just Eat renders no
  cart container when the basket is empty (documented at `basket-builder.js:674`),
  and the primary #110 case — switching an *empty* basket to JE — is exactly that,
  so a cart-based signal would never fire and every good run would burn the full
  timeout. A menu signal is present on any usable page regardless of basket
  contents, so a good run resolves the instant the menu renders and pays no fixed
  penalty. Non-JE platforms have no gate and settle immediately. The 4 s ceiling
  is a fail-safe; because `detectPageGate` is polled *within* the same wait, a
  gate that mounts late is still caught even if the menu rendered first.
- **`overlay.setGate` is guarded** in `try/catch` like every DOM call in this
  file — the builder must never throw (the real bootstrap has no `.catch`).
- **No clear, no adds** when gated. The user's basket is left untouched, since we
  act on nothing.
- **`results.gate`** is a property on the returned array. The existing tests read
  the return as an array and are unaffected; the gate path gets its own
  assertions. The real-page bootstrap ignores the return, so this shape serves
  only the tests.
- **Overlay** gets a new `setGate(gate)` method that renders one prominent line
  with `gate.action`, styled as a blocking notice (warn colour), distinct from
  the per-item "Add these manually" / "Check the options on" sections. This is
  the once-per-run surface. Unlike `finish()`, it schedules **no** auto-dismiss
  timeout: the notice names an action the user must take, so it persists until
  they set the address and switch again. This is deliberate, not an oversight.

Probing up front (rather than per line, after a failure) is correct here because
the Just Eat address gate is present from page load and blocks every line
identically — re-checking it per line would re-run the same detection N times and
still burn three wasted click-loops per line. The cross-restaurant confirm, which
*does* appear mid-run, is a separate modal already handled by
`acceptNewBasketPrompt` and is unaffected by this change.

### 3. Live audit (in scope)

An empirical phase using the `verify` skill / Playwright-chromium, in two parts:

**3a. Confirm the Just Eat gate DOM.** The Task-1 predicates are modelled from the
2026-08-09 observation, not a captured DOM. Load a JE menu with no address
resolved and confirm: the address-modal's **heading** matches `JE_LOCATION_RE`
(the exclusion reads the heading, so this is load-bearing), and a fee-row inside
`[data-qa="cart-modal"]` has its label+range in one leaf-ish element as
`FEE_ROW_RE` assumes. Re-pin the two gate fixtures and tighten the regexes if the
live shape differs.

**3b. Cookie-banner audit.** For each of Uber Eats, Just Eat, Deliveroo, load a
menu with the cookie banner **undismissed** and attempt to open an item dialog:

1. Record: does the banner **block** the dialog (a real gate) or merely sit as a
   cosmetic overlay that `el.click()` sails through?
2. For every banner that genuinely gates: add a `cookieBanner(doc)` predicate +
   pinned fixture, wired into `detectPageGate` with an action message
   (e.g. *"Accept or dismiss the cookie banner to continue."*).
3. Cosmetic banners get no code — recorded as checked, nothing to do.

Fixtures are pinned from the live DOM so the tests never depend on live sessions.
Findings are written back into this doc (a "Live audit results" section) so the
record of what was checked survives.

### 4. Testing

- `detectPageGate` / predicate unit tests over pinned fixtures:
  - gated Just Eat DOM, location-panel variant → gate descriptor `je-address`.
  - gated Just Eat DOM, fee-range variant (panel dismissed, fees unresolved) →
    gate descriptor `je-address`.
  - a clean Just Eat / Uber / Deliveroo menu → `null`.
- `buildBasket` over a gated doc → `results` empty, `results.gate` set,
  **no clear attempted, no adds**. The fixture carries an observable clear
  affordance (a decrement control with a click spy) so the test proves the clear
  was *skipped*, not merely that it found nothing to remove.
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
