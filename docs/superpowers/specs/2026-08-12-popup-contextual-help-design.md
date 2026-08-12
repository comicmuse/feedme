# Context-aware help in the popup idle state

## Problem

The browser-action popup's idle state (`popup/popup.html`, `#state-idle`) tells users
they can start a comparison from any of three checkouts:

- Uber Eats checkout
- Deliveroo checkout
- Just Eat order page

This is false in v1. `src/content/checkout-reader.js` implements order capture only
for Uber Eats; `extractDeliveroo` (#23) and `extractJustEat` (#22) are explicit
unimplemented stubs that return zero items, so `ORDER_DETECTED` never fires from
those platforms. Deliveroo and Just Eat exist in v1 only as comparison
*destinations* (branches you can switch to), never as *sources*.

The popup is the natural home for "how to use it" help, but its current copy
actively misleads users into starting somewhere that cannot work.

## Goal

Replace the single static idle message with context-aware help that:

1. Explains how to use FeedMe.
2. Makes clear you must **start from Uber Eats**.
3. Gives **full instructions** when the user is not on any supported platform,
   and a **contextual** message when they are on one.

## Scope

Only the "no order captured yet" branch of `src/popup.js` (today's `#state-idle`)
changes. Out of scope, untouched:

- `#state-ready` — an order is captured; shows restaurant + "Compare prices".
- `#state-blocked` — revoked host access (#77); independent warning box.
- The manifest, permissions, capture flow, and any other platform.

No new surfaces (no options page, no help tab). No manifest changes.

## Behaviour

When no order is captured, the popup reads the active tab's URL and shows exactly
one message:

| Tab context | State key | Message |
|---|---|---|
| Not on a supported platform, or URL unknown/undefined | `elsewhere` | **Full instructions:** "How to compare prices — 1. Open your basket on Uber Eats. 2. Go to the Uber Eats checkout. 3. Click FeedMe here." plus "Deliveroo & Just Eat are compared automatically — you don't start there." |
| Uber Eats, but not the checkout URL | `uber-other` | "You're on Uber Eats. Open your basket and go to the checkout, then click FeedMe here." |
| Uber Eats checkout URL (no order read yet) | `uber-checkout` | "You're on the Uber Eats checkout — if nothing shows here, add items to your basket, then reopen FeedMe." |
| Deliveroo or Just Eat (any page) | `destination` | "You're on {Deliveroo / Just Eat}. FeedMe compares these for you automatically — but you start from an Uber Eats basket." |

The `destination` case is where the "you don't start here" point matters most: it
is exactly where a user on Deliveroo/Just Eat would otherwise expect to start and
be confused. The platform label ("Deliveroo" / "Just Eat") is filled from the
detected platform.

The `uber-checkout` copy is deliberately plain and static — it makes no claim of
live activity, since the popup does not re-read the basket. It covers the small
window where the popup is opened on the checkout before `checkout-reader.js` has
reported an order, or when the basket is empty. Once an order is captured,
`#state-ready` takes over as today.

## Architecture

Add one pure function, `idleStateFor(url)`, that maps a tab URL to a state:

```
idleStateFor(url) -> { key, platform }
```

- `key`: one of `'elsewhere' | 'uber-other' | 'uber-checkout' | 'destination'`.
- `platform`: the detected `PLATFORM.*` value, or `null` — used only to label the
  `destination` message.

It is built on the existing exports from `src/shared/constants.js`:

- `platformFromUrl(url)` — host → `PLATFORM.*` or `null`.
- `CHECKOUT_PATTERNS[PLATFORM.UBER_EATS]` — regex for the Uber Eats checkout URL.

Mapping logic:

- No platform (or falsy url) → `elsewhere`.
- Uber Eats + URL matches the Uber checkout pattern → `uber-checkout`.
- Uber Eats otherwise → `uber-other`.
- Deliveroo or Just Eat → `destination` (with `platform`).

`init()` in `src/popup.js`, in the no-order branch, queries the active tab
(`browser.tabs.query({ active: true, currentWindow: true })`), calls
`idleStateFor(tab?.url)`, unhides the matching `<div>`, and — for `destination` —
sets the platform label via `textContent`.

The four messages are static hidden `<div>`s in `popup/popup.html`, following the
existing `#state-idle / #state-ready / #state-blocked` toggle-by-`hidden`-class
pattern; `init()` unhides exactly one. The memory difference between four static
divs and one text-swapped container is negligible (a few hundred bytes of markup
that lives in the tiny popup document, torn down when the popup closes), so this
follows the existing static-div pattern for consistency rather than to save bytes.

### Data flow

```
popup opens
  -> showRevokedAccess()            (unchanged; #state-blocked may also show)
  -> storage.session currentOrder?
       yes -> #state-ready          (unchanged)
       no  -> tabs.query active tab
              -> idleStateFor(tab?.url)
              -> unhide matching help div
```

### Why the URL is readable

The extension holds `host_permissions` for the supported hosts, so `tab.url` is
populated for Uber Eats / Deliveroo / Just Eat tabs. On other sites `tab.url` may
be undefined; `idleStateFor` treats a falsy/unknown url as `elsewhere`, which is
the correct "full instructions" outcome — no extra permission needed.

## Error handling

- `tabs.query` returning no tab, or a tab with no `url` → `elsewhere` (full
  instructions). This is a safe, useful default, never a blank popup.
- The function never throws on malformed URLs: `platformFromUrl` already guards URL
  parsing and returns `null`, which maps to `elsewhere`.

## Testing (TDD)

`idleStateFor(url)` is deterministic, so it is unit-tested first (failing, then
implemented). Representative cases:

- `https://www.ubereats.com/gb/checkout?...` → `uber-checkout`
- `https://www.ubereats.com/gb/store/...` → `uber-other`
- `https://www.ubereats.com/gb/` → `uber-other`
- `https://deliveroo.co.uk/menu/...` → `destination`, platform Deliveroo
- `https://www.just-eat.co.uk/restaurants-x/menu` → `destination`, platform Just Eat
- `https://www.google.com/` → `elsewhere`
- `undefined` / `''` → `elsewhere`

The DOM wiring in `init()` stays thin; if a popup DOM test exists or is
cheap to add, assert that each state key unhides exactly one div and that the
`destination` label reads the right platform name. No live-site probing is needed —
this is pure URL logic over already-pinned patterns.

## Out of scope / non-goals

- No onboarding tab or options page.
- No auto-open on install.
- No change to what platforms can be a source — that is the #22 / #23 work. This
  spec only stops the popup from claiming they already are.
