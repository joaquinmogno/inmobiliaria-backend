const test = require('node:test');
const assert = require('node:assert/strict');
const { cached, invalidatePerformanceCache } = require('../dist/services/performance-cache.service');

test('performance cache deduplicates concurrent summary calculations', async () => {
  let calls = 0;
  const loader = async () => {
    calls += 1;
    await new Promise(resolve => setTimeout(resolve, 10));
    return { total: 42 };
  };
  const key = `inmobiliaria:991:caja:${Date.now()}`;
  const [first, second] = await Promise.all([cached(key, 1_000, loader), cached(key, 1_000, loader)]);

  assert.deepEqual(first, { total: 42 });
  assert.deepEqual(second, { total: 42 });
  assert.equal(calls, 1);
});

test('performance cache invalidates every summary for the changed agency', async () => {
  let calls = 0;
  const key = `inmobiliaria:992:dashboard:${Date.now()}`;
  await cached(key, 10_000, async () => ++calls);
  invalidatePerformanceCache(992);
  const value = await cached(key, 10_000, async () => ++calls);

  assert.equal(value, 2);
  assert.equal(calls, 2);
});
