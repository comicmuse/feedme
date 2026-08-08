// Per-target manifest generation.
//
// The two stores need genuinely different manifests, not one file with both
// background keys:
//
//   Chromium runs an MV3 background as a service worker and has no other option.
//   Firefox does not support background.service_worker at all (bugzil.la/1573659)
//   — MV3 there is an event page declared with background.scripts.
//
// Carrying both keys in one manifest does work on Firefox 121+, but Chrome then
// warns that 'background.scripts' requires manifest_version 2, and a warning
// during store review is worth avoiding when we already ship a separate artefact
// to each store.
//
// The same dist/service-worker.js bundle serves both: it uses no service-worker-
// specific API (no self.*, importScripts, clients, or install/activate handlers),
// so it runs unchanged as a Firefox event page.
const base = require('../manifest.base.json');
const pkg = require('../package.json');

const BACKGROUND_BUNDLE = 'dist/service-worker.js';

// Firefox floor. Two numbers, because they answer different questions: what the
// add-on needs to RUN, and what a manifest key needs to be UNDERSTOOD.
//
//   109  MV3 itself
//   115  storage.session, used by the background and popup to hold the order
//   140  gecko.data_collection_permissions, below which web-ext lint raises
//        KEY_FIREFOX_UNSUPPORTED_BY_MIN_VERSION
//   142  the same key on Firefox for Android
//
// The functional floor is 115. The 140/142 pair buys nothing here: that key
// exists to carry a data-collection disclosure, and ours declares `none`, so a
// Firefox old enough to ignore it withholds nothing from the user. Setting the
// floor there only locked people out — 142 excluded LibreWolf 139, the browser
// this add-on is developed against (#101).
//
// So the floor is the oldest release the add-on is actually TESTED on, not the
// oldest it is believed to work on: 139. Older is plausible (the APIs date to
// 115) but unverified, and an add-on that installs and then breaks is worse
// than one that declines to install. Mozilla archives every release, so this
// can be lowered on evidence; raise it when a newer API is adopted.
const FIREFOX_MIN_VERSION = '139.0';

// Declared separately so the desktop floor is not dragged up by a key that only
// lands on Android at 142. This is not a claim that the add-on is usable there:
// it drives several background tabs and injects a sidebar, which is a
// desktop-shaped workflow, and it has never been run on Android.
const FIREFOX_ANDROID_MIN_VERSION = '142.0';

// Required for all new Firefox extensions since 3 November 2025. Mozilla's test
// is transmission: "any data collected, used, transferred, shared, or handled
// outside the add-on or the local browser".
//
// FeedMe declares "none" because it has no server of its own and sends nothing
// to the developer or any third party. Its only network traffic goes to the
// three delivery platforms, reproducing the requests those platforms' own pages
// already make, on the session the user is already logged into.
//
// The arguable case against: the Just Eat menu/dynamic call passes latLong and
// areaId, so location does leave the browser — to Just Eat, which supplied it a
// moment earlier and to whom the user is already sending it continuously. That
// is a first-party round trip, not collection, which is why "none" stands.
// Revisit the moment any data goes anywhere the user is not already transacting
// with, and note the reasoning in the AMO submission.
const DATA_COLLECTION = { required: ['none'] };

const TARGETS = ['chrome', 'firefox'];

const overrides = {
  chrome: () => ({
    background: { service_worker: BACKGROUND_BUNDLE },
  }),
  firefox: () => ({
    background: { scripts: [BACKGROUND_BUNDLE] },
    browser_specific_settings: {
      gecko: {
        id: 'feedme@feedme.dev',
        strict_min_version: FIREFOX_MIN_VERSION,
        data_collection_permissions: DATA_COLLECTION,
      },
      gecko_android: {
        strict_min_version: FIREFOX_ANDROID_MIN_VERSION,
      },
    },
  }),
};

/**
 * Build the manifest for one target. The version always comes from package.json
 * so a release bump cannot leave the manifest behind.
 * @param {'chrome'|'firefox'} target
 */
function buildManifest(target) {
  const override = overrides[target];
  if (!override) throw new Error(`unknown target: ${target} (expected one of ${TARGETS.join(', ')})`);
  // manifest_version leads and version follows it, matching how the stores show
  // the file; the spread order below is what puts them there.
  return { ...base, version: pkg.version, ...override() };
}

module.exports = { buildManifest, TARGETS, FIREFOX_MIN_VERSION };
