const { PLATFORM } = require('../src/shared/constants');
const { originsFor, missingOrigins, originLabel, PLATFORM_ORIGINS } = require('../src/shared/permissions');

// A fake permissions API. Records every call so the tests can assert HOW it was
// asked, not just what it answered — see the batching test below for why that
// matters.
function fakeApi(granted) {
  const calls = [];
  return {
    calls,
    contains: async ({ origins }) => {
      calls.push(origins);
      return origins.every((o) => granted.includes(o));
    },
  };
}

describe('originsFor', () => {
  test('Just Eat needs its two API hosts as well as the site', () => {
    expect(originsFor(PLATFORM.JUST_EAT)).toEqual(expect.arrayContaining([
      '*://www.just-eat.co.uk/*',
      '*://uk.api.just-eat.io/*',
      '*://menu-globalmenucdn.je-apis.com/*',
    ]));
  });

  test('Deliveroo needs both the apex and www origins', () => {
    expect(originsFor(PLATFORM.DELIVEROO)).toEqual(expect.arrayContaining([
      '*://www.deliveroo.co.uk/*',
      '*://deliveroo.co.uk/*',
    ]));
  });

  test('an unknown platform needs nothing, rather than throwing', () => {
    expect(originsFor('bootleg-eats')).toEqual([]);
  });
});

describe('missingOrigins', () => {
  test('nothing is missing when every origin is granted', async () => {
    const api = fakeApi(PLATFORM_ORIGINS[PLATFORM.JUST_EAT]);
    expect(await missingOrigins(PLATFORM.JUST_EAT, api)).toEqual([]);
  });

  test('names the specific revoked origin, not just that something is missing', async () => {
    // The API hosts are separate origins from the site and can be revoked on
    // their own, so "Just Eat is blocked" would not tell the user what to grant.
    const api = fakeApi(['*://www.just-eat.co.uk/*', '*://uk.api.just-eat.io/*']);
    expect(await missingOrigins(PLATFORM.JUST_EAT, api))
      .toEqual(['*://menu-globalmenucdn.je-apis.com/*']);
  });

  test('asks about each origin separately', async () => {
    // permissions.contains() answers with ONE boolean for the whole set, so a
    // batched call can only ever say "something is missing". Asking per origin
    // is the only way to name which — the point of the check.
    const api = fakeApi([]);
    await missingOrigins(PLATFORM.JUST_EAT, api);
    expect(api.calls).toHaveLength(originsFor(PLATFORM.JUST_EAT).length);
    for (const origins of api.calls) expect(origins).toHaveLength(1);
  });

  test('reports nothing missing when there is no permissions API', async () => {
    // Chrome grants host permissions at install and never revokes them, so the
    // whole path must be inert there rather than Firefox-gated.
    expect(await missingOrigins(PLATFORM.JUST_EAT, null)).toEqual([]);
    expect(await missingOrigins(PLATFORM.JUST_EAT, {})).toEqual([]);
  });

  test('every origin we might report reduces to a readable host', () => {
    // Whatever is shown has to match what the user will look for in Firefox's
    // own site-access UI, which lists hosts, not match patterns.
    for (const origin of Object.values(PLATFORM_ORIGINS).flat()) {
      const label = originLabel(origin);
      expect(label).not.toMatch(/[*:/]/);
      expect(origin).toContain(label);
    }
    expect(originLabel('*://uk.api.just-eat.io/*')).toBe('uk.api.just-eat.io');
    expect(originLabel('https://www.deliveroo.co.uk/')).toBe('www.deliveroo.co.uk');
  });

  test('fails open when the API throws', async () => {
    // A broken check must not invent a revocation: claiming "you revoked access"
    // over a working extension is worse than the silence this replaces.
    const api = { contains: async () => { throw new Error('nope'); } };
    expect(await missingOrigins(PLATFORM.JUST_EAT, api)).toEqual([]);
  });
});
