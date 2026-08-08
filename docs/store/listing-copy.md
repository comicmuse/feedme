# Store listing copy

Submission copy for the Chrome Web Store, Edge Add-ons and addons.mozilla.org.
Written for #82. The **assets** (screenshots, promo tile) are tracked separately
— they need a running extension and a real multi-branch comparison to capture.

> **Field limits and dashboard field names drift.** Every character count below
> was checked against the limit noted, but check the live dashboard at
> submission time rather than trusting this file. `web-ext lint` already caught
> one rule that postdated what was assumed when #74 was written.

---

## Name

```
FeedMe
```

Chrome allows 45 characters, AMO 50. If a fuller name is ever wanted for search,
`FeedMe — Takeaway Price Comparison` is 34 and fits both.

---

## Single-purpose statement

Chrome requires a single purpose, and it must cover *everything* the extension
does. The basket builder is the part most likely to read as a second purpose, so
the statement is written to contain it explicitly rather than hope it passes.

```
FeedMe compares the price of the takeaway order already in your basket across
Uber Eats, Deliveroo and Just Eat, including nearby branches of the same
restaurant, and — if you choose a cheaper one — refills that same order in the
basket on the branch you picked.
```

The refill is the same single purpose carried to its conclusion: it moves the
order the user already assembled, and it only ever runs from an explicit click
on a comparison result. It adds no items the user did not already have.

---

## Short description

Chrome's limit is 132 characters; AMO's summary allows 250. This is 120, so it
serves both.

```
Compare your takeaway basket across Uber Eats, Deliveroo and Just Eat — same items, real fees, nearby branches. UK only.
```

Leading with "UK only" was considered and rejected: it reads as a limitation
before the value is established. It stays at the end of the short description,
in the first line of the long one, and in the store regions.

---

## Detailed description

```
Would this exact order be cheaper from another branch, or on another platform?

FeedMe answers that at checkout. Open your basket on Uber Eats, Deliveroo or
Just Eat, and FeedMe reads the order you have already built — every item, every
quantity, every selected option — then finds the same restaurant's nearby
branches across all three platforms and re-prices your order on each one.

Covers UK delivery only.

WHAT YOU SEE

• A side-by-side total for each branch, on each platform.
• A full fee breakdown: delivery, service, bag and small-order fees.
• The offers each platform is actually advertising on those items.
• How many of your items the branch's menu carries, when it isn't all of them.

WHAT MAKES IT ACCURATE

FeedMe prices your order from each platform's own menu data, not from a
guess. Modifiers and option groups are resolved against the target branch's
own menu, so a size upgrade retargets to that branch's equivalent size rather
than being dropped. Offer eligibility is decided by exact catalogue-name
matching, never by fuzzy similarity.

Where a figure genuinely cannot be known before checkout, FeedMe labels it
rather than quietly inventing one — you will see "Delivery (approx.)" instead
of a confident wrong number.

ONE-CLICK SWITCH

Found something cheaper? Click it. FeedMe opens that branch's menu and refills
your basket there — items, sizes and options included. Anything it cannot fill
with certainty is reported as "add manually" rather than silently skipped, so
you always know what to check before you pay.

PRIVACY

FeedMe has no server. Your order never leaves your browser. There is no
account, no telemetry, no analytics, no advertising and no tracking of any
kind. It reads no page outside the three delivery platforms, and it never
sees your name, address, payment details or order history.

Full policy: https://comicmuse.net/feedme/privacy/

OPEN SOURCE

MIT licensed. The complete source is public:
https://github.com/comicmuse/feedme
```

The privacy policy URL is `https://comicmuse.net/feedme/privacy/`, settled in
#79. It is the same field the Chrome dashboard and the AMO listing both require.
The page is generated from `PRIVACY.md` on every push to `main`, so the hosted
policy and the repo's cannot drift.

---

## Per-permission justifications

Chrome's dashboard takes one justification per permission, and broad host
permissions are the most common cause of review delay — so each of these names
the specific code path that needs it. Every claim below was checked against the
source rather than assumed.

### `tabs`

```
The comparison opens each candidate branch's menu in a background tab, reads
its menu data, and closes it again. FeedMe needs to create those tabs, know
which of its own tabs has finished loading, and remove them when done. It also
needs the URL of the tab a comparison was started from, to know which delivery
platform the basket belongs to.
```

Used at `src/background/service-worker.js` — `tabs.create`, `tabs.get`,
`tabs.remove`, `tabs.sendMessage`, `tabs.onUpdated`, `tabs.onRemoved`.

### `scripting`

```
FeedMe injects its menu-reading scripts into the background tabs it opened,
the comparison sidebar into the checkout page, and the basket builder into the
branch page the user chose to switch to. All injected files are bundled in the
extension package; no remote code is fetched or executed.
```

Used at `src/background/service-worker.js` — four `scripting.executeScript`
call sites, each naming a file from the extension's own `dist/`.

### `storage`

```
Holds the captured order in session storage for the duration of a comparison
(cleared when the browser closes), and the user's two settings — how many
branches to compare, and how many tabs to open at once — in local storage.
Nothing is transmitted.
```

Used at `src/background/service-worker.js`, `src/popup.js` and
`src/shared/constants.js`.

### `webNavigation`

```
Two of the three platforms are single-page apps: navigating to the checkout
updates the URL without loading a new document, so no page-load event fires.
FeedMe listens for that history-state change to know when a checkout has been
opened and its basket can be read.
```

Used at `src/background/service-worker.js` — two
`webNavigation.onHistoryStateUpdated` listeners.

### Host permissions

```
FeedMe only works on the pages it is comparing, so it needs access to the three
delivery platforms and nothing else:

• www.ubereats.com, deliveroo.co.uk, www.just-eat.co.uk — read the basket at
  checkout, read each branch's menu, and refill the basket on a branch the user
  switched to.
• uk.api.just-eat.io and menu-globalmenucdn.je-apis.com — Just Eat serves its
  menus, delivery-fee bands and offers from these two API hosts rather than
  from the site itself, so branch pricing is impossible without them.

There are no other host permissions. Every host is a UK domain or the UK path
of ubereats.com; FeedMe reads no page on any other site.
```

---

## Reviewer note: fetch and XMLHttpRequest patching

Volunteer this rather than waiting to be asked — a reviewer will find it, and it
looks alarming without the explanation.

```
src/content/platform-scraper.js wraps window.fetch and XMLHttpRequest on the
delivery platform's own page. This is observation only: the original function
is called unchanged and its response returned untouched to the page. Nothing
is injected, modified, blocked or executed, and no request is originated by
the patch.

Its only purpose is to notice when the platform's own site fetches menu data,
so FeedMe can price the order from the same data the page is already using
rather than re-requesting it.

The response body is inspected in handleJson(), which forwards a response to
the extension only when classifyResponse() recognises it as menu data. Any
other response — account, payment, session — is read for that classification
check and then discarded. It is never forwarded, stored or transmitted.

The file is injected only on hosts in host_permissions, and derives its
platform from window.location, throwing if the host is unrecognised.
```

The constraints above are also recorded as a comment at the top of
`src/content/platform-scraper.js`, so the guarantee stays with the code.

## Reviewer note: the basket builder

```
src/content/basket-builder.js scripts the platform's own menu UI to add the
user's items to a basket. It runs only after an explicit click on a comparison
result, only on the branch page the user chose, and only with items already in
the basket the user assembled themselves. It never completes a purchase, never
touches payment, and stops at the basket.
```

---

## Data disclosure answers

Chrome's data-use section and AMO's data-collection fields both ask the same
substance. `PRIVACY.md` is already the authority for these; all three Chrome
limited-use certifications can be affirmed:

| Asked | Answer |
|---|---|
| Personally identifiable information | Not collected |
| Health, financial, authentication information | Not collected |
| Personal communications, location, web history | Not collected |
| User activity | Not collected |
| Website content | Read on the three delivery platforms only, in the page, not transmitted anywhere |
| Sold to third parties | No |
| Used or transferred for purposes unrelated to the single purpose | No |
| Used or transferred to determine creditworthiness or for lending | No |
| Remote code | None — all executed code ships in the package |

Firefox's `data_collection_permissions` key in the generated manifest (#76)
must stay consistent with this table.

---

## Regions

Set to **United Kingdom only** on every store.

Every host permission is a `.co.uk` domain or the `/gb` path of `ubereats.com`,
so the extension does nothing at all outside the UK. Listing it worldwide earns
confused installs and one-star reviews from people it was never built to serve.
Broadening coverage is scraper work, not a listing change.

---

## Category and metadata

| Field | Value |
|---|---|
| Category | Shopping |
| Language | English (UK) |
| Support email | Per #85 — `feedme@comicmuse.net`, once confirmed to route somewhere read |
| Privacy policy URL | https://comicmuse.net/feedme/privacy/ |
| Homepage | https://comicmuse.net/feedme/ |

---

## Assets still needed

Not in this document — they need a running extension:

- Screenshots of the sidebar mid-comparison showing a real multi-branch result,
  with at least one branch that is genuinely cheaper and one fee breakdown
  expanded. Chrome wants 1280×800 or 640×400; check the live dashboard.
- A small promotional tile for the Chrome Web Store.
- The icons themselves are #78.
