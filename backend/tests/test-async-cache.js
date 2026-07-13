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

  let boundedCalls = 0;
  const boundedCache = new AsyncCache(async () => {
    boundedCalls += 1;
    return `bounded:${boundedCalls}`;
  }, {
    ttlMs: 1_000,
    staleMs: 2_000,
    now: () => now,
  });
  assert.strictEqual(await boundedCache.get('value', { maxAgeMs: 3 }), 'bounded:1');
  now += 2;
  assert.strictEqual(await boundedCache.get('value', { maxAgeMs: 3 }), 'bounded:1');
  now += 2;
  assert.strictEqual(
    await boundedCache.get('value', { maxAgeMs: 3 }),
    'bounded:2',
    'a caller-specific maximum age should wait for a current value instead of serving stale data'
  );
  assert.strictEqual(boundedCalls, 2);

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

  let expiringCalls = 0;
  const expiringCache = new AsyncCache(async () => {
    expiringCalls += 1;
    if (expiringCalls > 1) throw new Error('refresh failed');
    return 'initial';
  }, {
    ttlMs: 10,
    staleMs: 20,
    now: () => now,
  });
  assert.strictEqual(await expiringCache.get('value'), 'initial');
  now += 15;
  assert.strictEqual(await expiringCache.get('value'), 'initial', 'stale window should return the old value while refreshing');
  await waitForMicrotasks();
  now += 10;
  await assert.rejects(
    () => expiringCache.get('value'),
    /refresh failed/,
    'a failed refresh beyond the stale window must not silently return an indefinitely old value'
  );

  console.log('✓ AsyncCache coalesces refreshes and supports bounded current reads');
}

run().catch(error => {
  console.error(error);
  process.exit(1);
});
