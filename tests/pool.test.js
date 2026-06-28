const { createScheduler } = require('../src/shared/pool');

describe('createScheduler', () => {
  test('take() respects the concurrency cap', () => {
    const s = createScheduler(2);
    s.add(['a', 'b', 'c', 'd']);
    expect(s.take()).toEqual(['a', 'b']);
    expect(s.take()).toEqual([]); // at capacity
  });
  test('release() frees a slot for the next key', () => {
    const s = createScheduler(2);
    s.add(['a', 'b', 'c']);
    s.take();          // a, b active
    s.release();       // a done
    expect(s.take()).toEqual(['c']);
  });
  test('pending counts queued + active until drained', () => {
    const s = createScheduler(1);
    s.add(['a', 'b']);
    expect(s.pending).toBe(2);
    s.take();             // a active, b queued
    expect(s.pending).toBe(2);
    s.release();          // a done -> 1 queued
    expect(s.pending).toBe(1);
    s.take(); s.release();
    expect(s.pending).toBe(0);
  });
  test('keys added after take() are scheduled on later takes', () => {
    const s = createScheduler(2);
    s.add(['a']);
    expect(s.take()).toEqual(['a']);
    s.add(['b', 'c']);
    expect(s.take()).toEqual(['b']); // one slot left (a still active)
  });
});
