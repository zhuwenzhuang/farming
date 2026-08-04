const assert = require('assert');
const path = require('path');

const { createSlashCommandDiscoveryCache } = require('../slash-command-cache.cjs');

async function run() {
  let now = 1_000;
  let calls = 0;
  let releaseFirst: (() => void) | null = null;
  const firstDiscovery = new Promise<void>(resolve => {
    releaseFirst = resolve;
  });
  const cache = createSlashCommandDiscoveryCache({
    ttlMs: 30_000,
    now: () => now,
    discover: async request => {
      calls += 1;
      if (calls === 1) await firstDiscovery;
      return [{
        command: `$${path.basename(request.workspace || 'none')}`,
        label: request.providerHomePath,
        description: request.provider,
        source: 'skill',
        scope: 'Repo',
      }];
    },
  });
  const baseRequest = {
    provider: 'codex',
    providerHomePath: '/tmp/farming-cache-home',
    workspace: '/tmp/farming-cache-workspace',
  };

  const first = cache.get(baseRequest);
  const joined = cache.get({
    ...baseRequest,
    provider: 'CODEX',
    workspace: '/tmp/farming-cache-workspace/../farming-cache-workspace',
  });
  await Promise.resolve();
  assert.strictEqual(calls, 1, 'equivalent concurrent requests should share one discovery');
  releaseFirst?.();
  assert.deepStrictEqual(await joined, await first);

  await cache.get(baseRequest);
  assert.strictEqual(calls, 1, 'a fresh cache hit should not repeat discovery');

  await cache.get({ ...baseRequest, providerHomePath: '/tmp/farming-cache-other-home' });
  await cache.get({ ...baseRequest, workspace: '/tmp/farming-cache-other-workspace' });
  assert.strictEqual(calls, 3, 'Agent Home and Workspace identities must remain isolated');

  now += 30_001;
  await cache.get(baseRequest);
  assert.strictEqual(calls, 4, 'an expired entry should be discovered again');

  let boundedCalls = 0;
  const bounded = createSlashCommandDiscoveryCache({
    maxEntries: 2,
    discover: async request => {
      boundedCalls += 1;
      return [{
        command: `$${path.basename(request.workspace || 'none')}`,
        label: request.providerHomePath,
        description: request.provider,
        source: 'skill',
        scope: 'Repo',
      }];
    },
  });
  await bounded.get({ ...baseRequest, workspace: '/tmp/cache-one' });
  await bounded.get({ ...baseRequest, workspace: '/tmp/cache-two' });
  await bounded.get({ ...baseRequest, workspace: '/tmp/cache-three' });
  await bounded.get({ ...baseRequest, workspace: '/tmp/cache-one' });
  assert.strictEqual(boundedCalls, 4, 'the least-recently-used key should be evicted at the cache bound');

  console.log('test-slash-command-cache passed');
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
