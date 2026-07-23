const assert = require('assert');
const { importTsModule } = require('./helpers/import-ts-module');

const {
  MAX_RETAINED_AGENT_VIEWS,
  normalizeAgentViewCache,
  reconcileAgentViewCache,
  touchAgentViewCache,
} = importTsModule('src/components/code/agent-view-cache.ts');

function run() {
  assert.strictEqual(MAX_RETAINED_AGENT_VIEWS, 6);

  const fullCache = ['agent-1', 'agent-2', 'agent-3', 'agent-4', 'agent-5', 'agent-6'];
  assert.strictEqual(
    touchAgentViewCache(fullCache, 'agent-6'),
    fullCache,
    'touching the current MRU should preserve the cache reference and avoid an empty React update',
  );
  assert.strictEqual(
    reconcileAgentViewCache(fullCache, [...fullCache]),
    fullCache,
    'a no-op lifecycle reconciliation should preserve the cache reference',
  );
  assert.deepStrictEqual(
    touchAgentViewCache(fullCache, 'agent-7'),
    ['agent-2', 'agent-3', 'agent-4', 'agent-5', 'agent-6', 'agent-7'],
    'adding a seventh view should evict the least recently used Agent',
  );
  assert.deepStrictEqual(
    touchAgentViewCache(fullCache, 'agent-2'),
    ['agent-1', 'agent-3', 'agent-4', 'agent-5', 'agent-6', 'agent-2'],
    'touching a cached Agent should make it most recently used without growing the cache',
  );
  assert.deepStrictEqual(
    normalizeAgentViewCache(['old-id', 'agent-2', 'new-id', 'agent-2']),
    ['old-id', 'new-id', 'agent-2'],
    'replacement or duplicate ids should preserve the latest recency position',
  );
  assert.deepStrictEqual(
    touchAgentViewCache(['agent-1'], '', 6),
    ['agent-1'],
    'an invalid Agent id should not consume cache capacity',
  );
  assert.deepStrictEqual(
    touchAgentViewCache(['agent-1'], 'agent-2', 0),
    [],
    'a zero-sized cache should retain no frontend views',
  );

  console.log('test-agent-view-cache passed');
}

run();
