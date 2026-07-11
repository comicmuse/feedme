# Clear the basket before filling it in Fill & Switch (issue #24)

## Problem

`buildBasket` (`src/content/basket-builder.js`) adds the plan's lines on top of
whatever is already in the target platform's basket. Pre-existing items — stale
test leftovers or things the user added earlier — make the filled basket and its
total diverge from the sidebar's comparison (live incident 2026-07-10: a stale
£0.99 Hot Honey in a Deliveroo basket made the fill look "wildly off").

## Decision

Always clear the target basket before running the plan (user-confirmed). If
clearing fails or only partly succeeds, proceed with the fill anyway and show an
amber warning in the overlay (user-confirmed). Clearing acts through each
platform's real basket UI — no basket APIs.

## Design

### New unit: `clearBasket(doc, platform, wait)`

Async function in `src/content/basket-builder.js`, same contract as the rest of
the builder: **never throws**, acts only via the platform's own UI, logs every
decision as `[FeedMe builder]`.

Returns `{ hadItems, cleared, removed }`:

- `hadItems` — whether any pre-existing basket rows were found.
- `removed` — how many remove/decrease actions landed (confirmed by the row set
  shrinking).
- `cleared` — the basket ended empty.

Mechanics (shared loop, per-platform hooks):

1. Surface the basket view if it isn't rendered (e.g. Just Eat's "View basket"
   control on narrow viewports; Uber's cart panel behind
   `[data-testid="view-carts-badge"]`, scoped to the target store's cart only).
2. While a remove/decrease affordance exists: click the first one, await settle
   (the affordance set shrinks or its accessible name changes), repeat.
   - Just Eat hook (live-verified 2026-07-11): buttons with
     `aria-label="Decrease quantity of X from N to M"`; at quantity 1 the
     decrease removes the row.
   - Deliveroo and Uber Eats hooks: re-probe live during implementation (DOM
     drifts; don't trust notes) and pin what's found in tests.
3. Bounded: a maximum iteration count and an overall timeout defend against a
   stepper that never empties. Hitting either bound → `cleared: false`.

### Integration

`buildBasket` calls `clearBasket` once, before the plan loop, only when the plan
is non-empty. Line results are unchanged.

Edge case: Just Eat shows a "start a new basket?" confirm when the first add
targets a different restaurant than the existing basket. If that dialog appears
during the first `addLine`, accept it — the platform performs the clear itself.

### Overlay

One new line in the existing overlay:

- Success with items removed: "Removed N item(s) already in the basket".
- `cleared: false`: amber section — "Couldn't clear pre-existing items — check
  your basket." The fill still runs.
- `hadItems: false`: no new output.

### Out of scope

No changes to the matcher, parsers, service-worker, plan format, or snapshot.

## Testing

- TDD (jsdom fake baskets in `tests/basket-builder.test.js`): rows removed on
  click per platform shape; empty basket is a no-op; bounded-loop guard trips on
  a non-emptying basket and reports `cleared: false`; `buildBasket` runs the
  clear before the first add; overlay renders the removed-count line and the
  amber failure section.
- Live verification on all three platforms via `.claude/skills/verify/SKILL.md`
  (the MCP profile's baskets already hold stale test items to clear).
