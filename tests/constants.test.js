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

  // Uber's store JSON-LD publishes a TRUNCATED postcode — live 2026-08-08, Tayyab
  // Sheesh Kebab (83-89 Fieldgate St, Whitechapel) reports "E1 1", the outward code
  // plus the first digit of the inward one. Stripping the space collapsed that to
  // "e11", which is not E1 at all: /area/e11 is Leytonstone, four miles away, so
  // the listing came back with no Tayyabs and the sidebar said "No branches found"
  // however many times it was retried. Nothing errored, because E11 is a perfectly
  // real district — that is what made it invisible.
  describe('truncated postcodes (#89 follow-up)', () => {
    test('an incomplete inward code is dropped rather than fused into the outward one', () => {
      expect(buildSearchUrl(PLATFORM.JUST_EAT, 'Tayyabs', 'E1 1'))
        .toBe('https://www.just-eat.co.uk/area/e1/restaurants');
    });

    // The same collapse turns every one of these into a different real district,
    // which is why this cannot be treated as a one-restaurant curiosity.
    test.each([
      ['N1 1', 'n1'],
      ['W1 1', 'w1'],
      ['SW1 1', 'sw1'],
      ['EC1 2', 'ec1'],
    ])('%s searches its own district, not %s-as-fused', (postcode, expected) => {
      expect(buildSearchUrl(PLATFORM.JUST_EAT, 'Subway', postcode))
        .toBe(`https://www.just-eat.co.uk/area/${expected}/restaurants`);
    });

    test('a complete postcode is still used in full', () => {
      expect(buildSearchUrl(PLATFORM.JUST_EAT, 'Subway', 'E1 1JU'))
        .toBe('https://www.just-eat.co.uk/area/e11ju/restaurants');
      expect(buildSearchUrl(PLATFORM.JUST_EAT, 'Subway', 'E14 7LG'))
        .toBe('https://www.just-eat.co.uk/area/e147lg/restaurants');
    });

    // An outward code on its own is already what we would reduce to.
    test('a bare outward code passes through', () => {
      expect(buildSearchUrl(PLATFORM.JUST_EAT, 'Subway', 'E1'))
        .toBe('https://www.just-eat.co.uk/area/e1/restaurants');
    });

    // Better a null the caller can skip than /area//restaurants, which 404s and
    // reads to the user as a platform with genuinely no branches.
    test('an unusable postcode yields no URL at all', () => {
      expect(buildSearchUrl(PLATFORM.JUST_EAT, 'Subway', '')).toBeNull();
      expect(buildSearchUrl(PLATFORM.JUST_EAT, 'Subway', '   ')).toBeNull();
    });
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
