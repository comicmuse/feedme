// tests/format.test.js
const { formatDistance } = require('../src/shared/format');

describe('formatDistance', () => {
  test('rounds to 1 decimal place', () => {
    expect(formatDistance(0.83)).toBe('0.8 mi');
  });
  test('rounds up when the second decimal is 5 or more', () => {
    expect(formatDistance(1.25)).toBe('1.3 mi');
  });
  test('a whole number stays a single trailing zero, not "1"', () => {
    expect(formatDistance(1)).toBe('1.0 mi');
  });
  test('null renders nothing, so the sidebar can skip the sub-line entirely', () => {
    expect(formatDistance(null)).toBe('');
  });
  test('undefined renders nothing', () => {
    expect(formatDistance(undefined)).toBe('');
  });
});
