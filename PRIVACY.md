# FeedMe — Privacy Policy

**Last updated: 2 August 2026**

FeedMe is a browser extension that compares the price of a takeaway order across
Uber Eats, Deliveroo and Just Eat.

**FeedMe has no server.** It is not backed by any service operated by the
developer. There is no account, no login, no analytics and no telemetry. Nothing
you do in the extension is transmitted to the developer, and the developer
cannot see your orders, your location, or that you use the extension at all.

Everything below follows from that: the extension reads data from the delivery
platforms' own pages inside your browser, uses it there, and discards it.

## What FeedMe reads

When you open a basket or checkout page on a supported delivery platform, and
only then, FeedMe reads from that page:

- **Your order** — the items in your basket, their quantities, and the options
  selected for each (sizes, extras, declines).
- **The restaurant** — its name and branch.
- **Your delivery area** — the location the platform has already applied to your
  session, used to look up nearby branches of the same chain. FeedMe does not
  request your device's GPS location and holds no `geolocation` permission.

FeedMe does **not** read your name, email address, phone number, delivery
address, payment details, saved cards, or order history. It does not read pages
on any site other than the three delivery platforms listed below.

## What FeedMe stores

| What | Where | Lifetime |
|---|---|---|
| The captured order, while a comparison is running | `storage.session` | Cleared when you close your browser |
| Two display settings (how many branches to compare, how many tabs at once) | `storage.local` | Until you uninstall the extension |

Both live only in your own browser profile. Neither is transmitted anywhere.
There is no cookie, no device identifier and no persistent user ID.

## What FeedMe sends, and to whom

To price your order at another branch, FeedMe requests menu, fee and offer data
from the delivery platforms themselves — the same requests their own websites
make. These go only to:

- `www.ubereats.com`
- `deliveroo.co.uk` and `www.deliveroo.co.uk`
- `www.just-eat.co.uk`, `uk.api.just-eat.io`, `menu-globalmenucdn.je-apis.com`

These requests carry your existing session with those platforms, exactly as
browsing their sites normally does. Your use of those sites remains governed by
**their** privacy policies, not this one. FeedMe sends no data to any other
destination.

FeedMe opens background tabs on these platforms to read branch menus. This is
how the comparison is built, and those tabs are closed when it finishes.

## Filling a basket

If you choose to switch to another branch, FeedMe adds your matched items to
that branch's basket by acting on the page as you would. This only ever happens
after you explicitly click to switch. FeedMe never places an order, never
submits a payment, and never completes a checkout.

## Data sharing and sale

FeedMe does not collect data, so there is nothing to share or sell. Specifically,
and as required by the extension stores:

- Your data is **not sold** to third parties.
- Your data is **not used or transferred** for any purpose unrelated to the
  extension's single purpose — comparing the price of your order.
- Your data is **not used or transferred** to determine creditworthiness or for
  lending purposes.
- Your data is **not used** for advertising, profiling or tracking.

## Permissions, and why each is needed

| Permission | Why |
|---|---|
| Host access to the three delivery platforms | Read your basket, read branch menus, and fill a basket when you switch |
| `tabs`, `webNavigation` | Open and follow the background tabs that read branch menus |
| `scripting`, `activeTab` | Run the comparison sidebar and the basket builder on those pages |
| `storage` | Hold the current order for the duration of the comparison, and your two settings |

FeedMe requests no other permissions, and holds no access to any site outside
those listed.

## Children

FeedMe is not directed at children and collects no data from anyone.

## Changes

If this policy changes, the "Last updated" date above changes with it and the
revision will be visible in the project's public history.

## Contact

Questions about this policy: **<CONTACT EMAIL>**

Controller for the purposes of UK GDPR, to the extent it applies:
**<YOUR NAME>**.
