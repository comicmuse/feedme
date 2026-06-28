// A pure bounded-concurrency scheduler. The caller does the actual async work
// (opening tabs); this only tracks which keys may run now and how many are live.
function createScheduler(maxConcurrent) {
  const queue = [];
  let active = 0;
  return {
    add(keys) {
      for (const k of keys) queue.push(k);
    },
    take() {
      const out = [];
      while (active < maxConcurrent && queue.length) {
        out.push(queue.shift());
        active += 1;
      }
      return out;
    },
    release() {
      if (active > 0) active -= 1;
    },
    get pending() {
      return queue.length + active;
    },
  };
}

module.exports = { createScheduler };
