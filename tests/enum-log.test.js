const { enumLog, pageSummary } = require('../src/shared/enum-log');

describe('pageSummary', () => {
  test('returns an empty object when there is no document/window (service-worker context)', () => {
    // pageSummary is pure over its args, so the worker case is just null inputs.
    expect(pageSummary(null, null)).toEqual({});
  });

  test('reads href, readyState and title from the page when present', () => {
    const doc = { readyState: 'complete', title: 'Menu' };
    const win = { location: { href: 'https://x/menu' } };
    expect(pageSummary(doc, win)).toEqual({ href: 'https://x/menu', readyState: 'complete', title: 'Menu' });
  });

  test('never throws even if reading the page does', () => {
    const doc = { get readyState() { throw new Error('torn down'); } };
    const win = { location: { href: 'https://x' } };
    expect(pageSummary(doc, win)).toEqual({});
  });
});

describe('enumLog', () => {
  test('never throws — logging must not be able to break a scraper mid-enumeration', () => {
    const original = console.info;
    console.info = () => { throw new Error('console gone'); };
    try {
      expect(() => enumLog('just-eat', 'anything', { candidateCount: 0 })).not.toThrow();
    } finally {
      console.info = original;
    }
  });

  test('emits the greppable [FeedMe enum] prefix and the platform', () => {
    const calls = [];
    const original = console.info;
    console.info = (...args) => calls.push(args);
    try {
      enumLog('uber-eats', 'no cards', { storeCardsSeen: 0 });
    } finally {
      console.info = original;
    }
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe('[FeedMe enum]');
    expect(calls[0][1]).toBe('uber-eats');
    expect(calls[0][calls[0].length - 1]).toMatchObject({ storeCardsSeen: 0 });
  });
});
