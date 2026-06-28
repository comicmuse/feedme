const { MSG, DEFAULT_BRANCH_COUNT, DEFAULT_MAX_CONCURRENT, getConfig, buildSearchUrl, PLATFORM } = require('../src/shared/constants');

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
