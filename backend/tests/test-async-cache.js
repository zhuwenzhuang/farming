const assert = require('assert');
const { AsyncCache } = require('../async-cache');

async function waitForMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

async function run() {
  let now = 1_000;
  const calls = [];
  const cache = new AsyncCache(async (key) => {
    calls.push(key);
    return `${key}:${calls.length}`;
  }, {
    ttlMs: 100,
    staleMs: 1_000,
    now: () => now,
  });

  const [first, second] = await Promise.all([
    cache.get('sessions'),
    cache.get('sessions'),
  ]);
  assert.strictEqual(first, 'sessions:1');
  assert.strictEqual(second, 'sessions:1');
  assert.deepStrictEqual(calls, ['sessions']);

  assert.strictEqual(await cache.get('sessions'), 'sessions:1');
  assert.deepStrictEqual(calls, ['sessions']);

  now += 200;
  assert.strictEqual(await cache.get('sessions'), 'sessions:1');
  await waitForMicrotasks();
  assert.deepStrictEqual(calls, ['sessions', 'sessions']);
  assert.strictEqual(await cache.get('sessions'), 'sessions:2');

  let failingCalls = 0;
  const failingCache = new AsyncCache(async () => {
    failingCalls += 1;
    throw new Error('boom');
  }, {
    ttlMs: 10,
    staleMs: 20,
    now: () => now,
  });

  await assert.rejects(() => failingCache.get('missing'), /boom/);
  assert.strictEqual(failingCalls, 1);

  console.log('✓ AsyncCache coalesces refreshes and serves stale values while refreshing');
}

run().catch(error => {
  console.error(error);
  process.exit(1);
});
