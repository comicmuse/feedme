const { MSG, DEFAULT_BRANCH_COUNT, DEFAULT_MAX_CONCURRENT, getConfig, buildSearchUrl, isAllowedMenuUrl, isJeApiUrl, isMenuPageUrl, PLATFORM } = require('../src/shared/constants');

describe('isAllowedMenuUrl', () => {
  test('allows the platform\'s own origin (www and apex)', () => {
    expect(isAllowedMenuUrl(PLATFORM.UBER_EATS, 'https://www.ubereats.com/gb/store/x/abc')).toBe(true);
    expect(isAllowedMenuUrl(PLATFORM.DELIVEROO, 'https://deliveroo.co.uk/menu/london/x')).toBe(true);
    expect(isAllowedMenuUrl(PLATFORM.DELIVEROO, 'https://www.deliveroo.co.uk/menu/london/x')).toBe(true);
    expect(isAllowedMenuUrl(PLATFORM.JUST_EAT, 'https://www.just-eat.co.uk/restaurants-x/menu')).toBe(true);
  });
  test('rejects an off-platform host', () => {
    expect(isAllowedMenuUrl(PLATFORM.UBER_EATS, 'https://evil.com/gb/store/x')).toBe(false);
  });
  test('rejects a look-alike suffix host', () => {
    expect(isAllowedMenuUrl(PLATFORM.UBER_EATS, 'https://ubereats.com.evil.com/gb/store/x')).toBe(false);
  });
  test('rejects a URL for a different platform', () => {
    expect(isAllowedMenuUrl(PLATFORM.JUST_EAT, 'https://www.ubereats.com/gb/store/x')).toBe(false);
  });
  test('rejects a malformed URL', () => {
    expect(isAllowedMenuUrl(PLATFORM.UBER_EATS, 'not a url')).toBe(false);
  });
});

describe('isJeApiUrl', () => {
  test('allows the menu/dynamic + offers host', () => {
    expect(isJeApiUrl('https://uk.api.just-eat.io/restaurant/uk/123/menu/dynamic')).toBe(true);
  });
  test('allows the CDN host', () => {
    expect(isJeApiUrl('https://menu-globalmenucdn.je-apis.com/items/123.json')).toBe(true);
  });
  test('rejects an off-platform host', () => {
    expect(isJeApiUrl('https://evil.com/restaurant/uk/123/menu/dynamic')).toBe(false);
  });
  test('rejects a look-alike suffix host', () => {
    expect(isJeApiUrl('https://uk.api.just-eat.io.evil.com/x')).toBe(false);
  });
  test('rejects a malformed URL', () => {
    expect(isJeApiUrl('not a url')).toBe(false);
  });
});

// A switch tab can complete on a consent/login/location interstitial (often on
// the platform's own host) before the menu ever loads — the basket build must
// only be claimed once the tab is really on a menu page.
describe('isMenuPageUrl', () => {
  test('accepts each platform\'s menu page shape', () => {
    expect(isMenuPageUrl(PLATFORM.UBER_EATS, 'https://www.ubereats.com/gb/store/kfc-london-mile-end-road/g_s9XoGVSkmubs6Lk1hziA')).toBe(true);
    expect(isMenuPageUrl(PLATFORM.DELIVEROO, 'https://deliveroo.co.uk/menu/london/stepney/popeyes-whitechapel?item-id=123')).toBe(true);
    expect(isMenuPageUrl(PLATFORM.JUST_EAT, 'https://www.just-eat.co.uk/restaurants-kfc-mile-end-bow/menu')).toBe(true);
  });
  test('rejects same-host interstitials (home, area listing, consent, login)', () => {
    expect(isMenuPageUrl(PLATFORM.JUST_EAT, 'https://www.just-eat.co.uk/')).toBe(false);
    expect(isMenuPageUrl(PLATFORM.JUST_EAT, 'https://www.just-eat.co.uk/area/e147lg/restaurants')).toBe(false);
    expect(isMenuPageUrl(PLATFORM.DELIVEROO, 'https://deliveroo.co.uk/login')).toBe(false);
    expect(isMenuPageUrl(PLATFORM.UBER_EATS, 'https://www.ubereats.com/gb/login-redirect')).toBe(false);
  });
  test('rejects a menu-shaped path on the wrong host', () => {
    expect(isMenuPageUrl(PLATFORM.JUST_EAT, 'https://evil.com/restaurants-x/menu')).toBe(false);
  });
  test('rejects a malformed URL', () => {
    expect(isMenuPageUrl(PLATFORM.JUST_EAT, 'not a url')).toBe(false);
  });
});

describe('buildSearchUrl', () => {
  test('Uber search query uses the brand (first token), not the verbose store name', () => {
    const url = buildSearchUrl(PLATFORM.UBER_EATS, 'Subway Mile End Halal', 'E14 7LG');
    // The brand-search results page lives at /gb/search with these params; without
    // searchType=GLOBAL_SEARCH the same q= returns a generic feed with one store.
    expect(url).toContain('/gb/search?');
    expect(url).toContain('q=Subway');
    expect(url).toContain('searchType=GLOBAL_SEARCH');
    expect(url).not.toContain('Mile'); // locality words dropped so sibling branches surface
    // No pl=: Uber ignores a shorthand postcode and resolves the session location
    // via a 307 redirect, so passing one only triggered an error page.
    expect(url).not.toContain('pl=');
  });
  test('Just Eat listing uses the normalised postcode', () => {
    expect(buildSearchUrl(PLATFORM.JUST_EAT, 'Subway', 'E14 7LG'))
      .toBe('https://www.just-eat.co.uk/area/e147lg/restaurants');
  });
  test('Deliveroo has no addressable search URL (homepage entry point)', () => {
    expect(buildSearchUrl(PLATFORM.DELIVEROO, 'Subway', 'E14 7LG')).toBe('https://deliveroo.co.uk/');
  });
});

describe('constants', () => {
  test('exposes new message types', () => {
    expect(MSG.BRANCHES_FOUND).toBe('BRANCHES_FOUND');
    expect(MSG.COMPARISON_UPDATE).toBe('COMPARISON_UPDATE');
    expect(MSG.RETRY_BRANCH).toBe('RETRY_BRANCH');
    expect(MSG.RETRY_PLATFORM).toBe('RETRY_PLATFORM');
  });
  test('exposes config defaults', () => {
    expect(DEFAULT_BRANCH_COUNT).toBe(3);
    expect(DEFAULT_MAX_CONCURRENT).toBe(4);
  });
  test('getConfig falls back to defaults when storage is unavailable', async () => {
    const cfg = await getConfig();
    expect(cfg).toEqual({ branchCount: 3, maxConcurrent: 4 });
  });
});
