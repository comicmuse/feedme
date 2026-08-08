const { buildManifest, TARGETS } = require('../scripts/manifest');
const pkg = require('../package.json');

describe('buildManifest', () => {
  test('exposes exactly the targets we submit to a store', () => {
    expect(TARGETS).toEqual(['chrome', 'firefox']);
  });

  test('takes its version from package.json, so the two cannot drift', () => {
    for (const t of TARGETS) expect(buildManifest(t).version).toBe(pkg.version);
  });

  test('shared keys are identical across targets', () => {
    const [chrome, firefox] = TARGETS.map(buildManifest);
    for (const key of ['name', 'description', 'permissions', 'host_permissions', 'content_scripts', 'action', 'manifest_version']) {
      expect(firefox[key]).toEqual(chrome[key]);
    }
  });

  // Every declared permission costs a written justification in the Chrome
  // dashboard and draws reviewer attention on AMO, so the set is asserted
  // exactly rather than by absence: adding one has to be a deliberate edit here
  // too. activeTab was declared and never used (#92) — the popup's
  // tabs.query({ active: true, currentWindow: true }) is served by `tabs`.
  test('declares exactly the permissions the code uses', () => {
    for (const t of TARGETS) {
      expect(buildManifest(t).permissions).toEqual(['tabs', 'scripting', 'storage', 'webNavigation']);
    }
  });

  // Chromium is the only engine that runs an MV3 background as a service worker.
  test('chrome gets background.service_worker and no gecko block', () => {
    const m = buildManifest('chrome');
    expect(m.background).toEqual({ service_worker: 'dist/service-worker.js' });
    expect(m.browser_specific_settings).toBeUndefined();
  });

  // Firefox does not support background.service_worker at all (bugzil.la/1573659);
  // MV3 there is an event page declared with background.scripts. Emitting a
  // separate manifest rather than carrying both keys keeps Chrome from warning
  // that background.scripts requires manifest_version 2.
  test('firefox gets background.scripts and no service_worker', () => {
    const m = buildManifest('firefox');
    expect(m.background).toEqual({ scripts: ['dist/service-worker.js'] });
    expect(m.background.service_worker).toBeUndefined();
  });

  // The floor must clear everything the add-on declares or calls, not just MV3:
  // storage.session needs 115, and data_collection_permissions needs 140 on
  // desktop / 142 on Android. The previous 109 was the MV3 floor, which would
  // have installed the add-on onto browsers where it throws on first use.
  test('firefox declares a minimum version that supports every API and key used', () => {
    const gecko = buildManifest('firefox').browser_specific_settings.gecko;
    expect(gecko.id).toBe('feedme@feedme.dev');
    expect(Number(gecko.strict_min_version.split('.')[0])).toBeGreaterThanOrEqual(142);
  });

  // Required for all new Firefox extensions since 3 November 2025; web-ext lint
  // flags its absence as MISSING_DATA_COLLECTION_PERMISSIONS. "none" is the
  // declaration for an extension that transmits nothing outside the browser —
  // see the reasoning recorded in scripts/manifest.js.
  test('firefox declares its data collection', () => {
    const gecko = buildManifest('firefox').browser_specific_settings.gecko;
    expect(gecko.data_collection_permissions).toEqual({ required: ['none'] });
  });

  // The key is gecko-specific; Chrome's equivalent disclosure lives in the
  // dashboard, not the manifest, and an unknown key here would be a review flag.
  test('chrome carries no gecko data collection key', () => {
    expect(JSON.stringify(buildManifest('chrome'))).not.toMatch(/data_collection_permissions/);
  });

  test('rejects an unknown target rather than emitting a silently wrong manifest', () => {
    expect(() => buildManifest('safari')).toThrow(/unknown target/i);
  });
});
