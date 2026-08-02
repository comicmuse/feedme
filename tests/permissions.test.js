const { requiredOrigins, missingOrigins, originLabel } = require('../src/shared/permissions');

// Minimal stand-in for the polyfilled `browser`. `granted` lists the origin
// patterns permissions.contains() should answer true for.
function fakeBrowser({ hostPermissions = ['*://a.example/*', '*://b.example/*'], granted = null, noPermissionsApi = false } = {}) {
  const allow = granted === null ? hostPermissions : granted;
  const b = { runtime: { getManifest: () => ({ host_permissions: hostPermissions }) } };
  if (!noPermissionsApi) {
    b.permissions = {
      contains: async ({ origins }) => origins.every((o) => allow.includes(o)),
    };
  }
  return b;
}

describe('requiredOrigins', () => {
  test('comes from the manifest, so it cannot drift from what we declare', () => {
    expect(requiredOrigins(fakeBrowser())).toEqual(['*://a.example/*', '*://b.example/*']);
  });
  test('a manifest without host_permissions yields none', () => {
    const b = { runtime: { getManifest: () => ({}) } };
    expect(requiredOrigins(b)).toEqual([]);
  });
});

describe('missingOrigins', () => {
  test('returns nothing when every origin is granted — the Chrome case', async () => {
    expect(await missingOrigins(fakeBrowser())).toEqual([]);
  });

  // Named individually rather than as one all-or-nothing check: Firefox lets the
  // API origins be revoked separately from the site they belong to, so "you
  // revoked just-eat.co.uk" and "you revoked uk.api.just-eat.io" are different
  // problems with different fixes.
  test('names exactly the origins that are missing', async () => {
    const b = fakeBrowser({ granted: ['*://a.example/*'] });
    expect(await missingOrigins(b)).toEqual(['*://b.example/*']);
  });

  test('reports all of them when everything is revoked', async () => {
    const b = fakeBrowser({ granted: [] });
    expect(await missingOrigins(b)).toEqual(['*://a.example/*', '*://b.example/*']);
  });

  // Must never be the reason a comparison refuses to run. If the API is absent
  // or throws, assume access is fine and let the real request fail with its own
  // error, rather than inventing a permissions problem.
  test('assumes granted when the permissions API is unavailable', async () => {
    expect(await missingOrigins(fakeBrowser({ noPermissionsApi: true }))).toEqual([]);
  });

  test('assumes granted when contains() throws', async () => {
    const b = fakeBrowser();
    b.permissions.contains = async () => { throw new Error('nope'); };
    expect(await missingOrigins(b)).toEqual([]);
  });
});

describe('originLabel', () => {
  test('reduces a match pattern to the host a user would recognise', () => {
    expect(originLabel('*://uk.api.just-eat.io/*')).toBe('uk.api.just-eat.io');
    expect(originLabel('*://www.ubereats.com/*')).toBe('www.ubereats.com');
    expect(originLabel('https://deliveroo.co.uk/*')).toBe('deliveroo.co.uk');
  });
  test('passes anything unrecognised through unchanged rather than mangling it', () => {
    expect(originLabel('<all_urls>')).toBe('<all_urls>');
  });
});
