const assert = require('assert');
const {
  comparePinnedAgents,
  compareProjectAgents,
  ensureAgentOrders,
  reorderedPinnedAgentOrders,
  reorderedProjectAgentOrders,
} = require('../agent-order');

function agent(id, projectOrder, overrides = {}) {
  return {
    id,
    cwd: '/repo',
    projectWorkspace: '/repo',
    projectOrder,
    pinned: false,
    startedAt: 1,
    ...overrides,
  };
}

function run() {
  const agents = [agent('a', 3072), agent('b', 2048), agent('c', 1024)];
  assert.deepStrictEqual(agents.slice().sort(compareProjectAgents).map(item => item.id), ['a', 'b', 'c']);

  const created = ensureAgentOrders(agent('new', undefined), agents);
  assert.strictEqual(created.projectOrder, 4096);

  const pinning = ensureAgentOrders(agent('pin-new', 4096, { pinned: true }), [
    agent('pin-a', 2048, { pinned: true, pinnedOrder: 1024 }),
    agent('pin-b', 1024, { pinned: true, pinnedOrder: 2048 }),
  ]);
  assert.strictEqual(pinning.pinnedOrder, 3072);
  assert.deepStrictEqual([
    agent('pin-b', 1, { pinned: true, pinnedOrder: 2048 }),
    agent('pin-a', 1, { pinned: true, pinnedOrder: 1024 }),
  ].sort(comparePinnedAgents).map(item => item.id), ['pin-a', 'pin-b']);

  const pinnedMoved = reorderedPinnedAgentOrders([
    agent('pin-a', 1, { pinned: true, pinnedOrder: 1024 }),
    agent('pin-b', 1, { pinned: true, pinnedOrder: 2048 }),
    agent('pin-c', 1, { pinned: true, pinnedOrder: 3072 }),
  ], 'pin-c', 'pin-a', 'pin-b');
  assert.strictEqual(pinnedMoved.error, undefined);
  assert.strictEqual(pinnedMoved.updates.get('pin-c'), 1536);

  const pinnedRebalanced = reorderedPinnedAgentOrders([
    agent('pin-a', 1, { pinned: true, pinnedOrder: 1 }),
    agent('pin-b', 1, { pinned: true, pinnedOrder: 2 }),
    agent('pin-c', 1, { pinned: true, pinnedOrder: 3 }),
  ], 'pin-c', 'pin-a', 'pin-b');
  assert.strictEqual(pinnedRebalanced.updates.get('pin-a'), 1024);
  assert.strictEqual(pinnedRebalanced.updates.get('pin-c'), 1536);
  assert.strictEqual(pinnedRebalanced.updates.get('pin-b'), 2048);
  assert.strictEqual(
    reorderedPinnedAgentOrders([agent('plain', 1)], 'plain', '', '').error,
    'Only pinned Agents can be reordered in Pinned'
  );

  const moved = reorderedProjectAgentOrders(agents, 'c', 'a', 'b');
  assert.strictEqual(moved.error, undefined);
  assert.strictEqual(moved.updates.get('c'), 2560);

  const adjacent = [agent('a', 3), agent('b', 2), agent('c', 1)];
  const rebalanced = reorderedProjectAgentOrders(adjacent, 'c', 'a', 'b');
  assert.strictEqual(rebalanced.updates.get('c'), 1536);
  assert.strictEqual(rebalanced.updates.get('a'), 2048);
  assert.strictEqual(rebalanced.updates.get('b'), 1024);

  const pinnedGap = [
    agent('a', 4096),
    agent('hidden', 3072, { pinned: true, pinnedOrder: 1024 }),
    agent('b', 2048),
    agent('c', 1024),
  ];
  const aroundPinned = reorderedProjectAgentOrders(pinnedGap, 'c', 'a', 'b');
  assert.strictEqual(aroundPinned.updates.get('c'), 3584);

  assert.strictEqual(
    reorderedProjectAgentOrders(agents, 'c', 'a', '').error,
    'Reorder neighbors are stale'
  );
  assert.strictEqual(
    reorderedProjectAgentOrders([agent('a', 1, { pinned: true })], 'a', '', '').error,
    'Pinned Agents cannot be reordered inside a Project'
  );

  console.log('agent order assertions passed');
}

run();
