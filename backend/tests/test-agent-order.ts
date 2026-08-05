const assert = require('assert');
const {
  AgentOrderAllocator,
  comparePinnedAgents,
  compareProjectAgents,
  reorderedPinnedAgentOrders,
  reorderedProjectAgentOrders,
} = require('../agent-order.cjs');

interface TestAgentOrderRecord {
  cwd: string;
  id: string;
  pinned: boolean;
  pinnedOrder?: number;
  projectOrder?: number;
  projectWorkspace: string;
  startedAt: number;
}

function agent(
  id: string,
  projectOrder: number | undefined,
  overrides: Partial<TestAgentOrderRecord> = {},
): TestAgentOrderRecord {
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

  const baselineAllocator = new AgentOrderAllocator();
  agents.forEach(item => baselineAllocator.ensure(item));
  const created = baselineAllocator.ensure(agent('new', undefined));
  assert.strictEqual(created.projectOrder, 4096);

  const allocator = new AgentOrderAllocator();
  allocator.ensure(agent('restored', 8192));
  assert.strictEqual(
    allocator.ensure(agent('created-after-restore', undefined)).projectOrder,
    9216,
    'persisted Project order should seed the next allocation without scanning the live Agent collection',
  );
  assert.strictEqual(
    allocator.ensure(agent('other-project', undefined, { cwd: '/other', projectWorkspace: '/other' })).projectOrder,
    1024,
    'Project order allocation should remain independent per workspace',
  );
  allocator.ensure(agent('restored-pin', 1, { pinned: true, pinnedOrder: 4096 }));
  assert.strictEqual(allocator.nextPinnedOrder(), 5120);
  allocator.ensure(agent('untracked-old-pin', 1, { pinned: false, pinnedOrder: 8192 }));
  assert.strictEqual(
    allocator.nextPinnedOrder(),
    5120,
    'an unpinned Agent should not move the active pinned-order high-water mark',
  );
  assert.strictEqual(
    allocator.ensure(agent('next-active-project-agent', undefined)).projectOrder,
    10240,
    'an active Project should keep monotonic order allocation',
  );

  const movingAgent = agent('moving', 4096);
  const movingAllocator = new AgentOrderAllocator();
  movingAllocator.ensure(movingAgent);
  movingAgent.projectWorkspace = '/other';
  movingAgent.cwd = '/other';
  movingAgent.projectOrder = 8192;
  movingAllocator.observe(movingAgent);
  assert.strictEqual(
    movingAllocator.ensure(agent('other-after-move', undefined, {
      cwd: '/other',
      projectWorkspace: '/other',
    })).projectOrder,
    9216,
    'moving an Agent should seed the destination Project high-water mark',
  );
  assert.strictEqual(
    movingAllocator.ensure(agent('old-project-reused', undefined)).projectOrder,
    1024,
    'a Project with no remaining Agents should release its high-water entry',
  );

  const removableAllocator = new AgentOrderAllocator();
  const removable = removableAllocator.ensure(agent('removable', undefined));
  removableAllocator.remove(removable);
  assert.strictEqual(
    removableAllocator.ensure(agent('after-empty-project', undefined)).projectOrder,
    1024,
    'deleting the final Agent should restore the empty-Project allocation baseline',
  );
  const removablePinnedAllocator = new AgentOrderAllocator();
  const removablePinned = removablePinnedAllocator.ensure(agent('removable-pin', 1024, { pinned: true }));
  removablePinnedAllocator.remove(removablePinned);
  assert.strictEqual(
    removablePinnedAllocator.ensure(agent('pin-after-empty-set', 2048, { pinned: true })).pinnedOrder,
    1024,
    'deleting the final pinned Agent should restore the empty pinned-order baseline',
  );

  const pinAllocator = new AgentOrderAllocator();
  pinAllocator.ensure(agent('pin-a', 2048, { pinned: true, pinnedOrder: 1024 }));
  pinAllocator.ensure(agent('pin-b', 1024, { pinned: true, pinnedOrder: 2048 }));
  const pinning = pinAllocator.ensure(agent('pin-new', 4096, { pinned: true }));
  assert.strictEqual(pinning.pinnedOrder, 3072);
  const repinned = agent('repinned', 5120, { pinned: true, pinnedOrder: 4096 });
  pinAllocator.ensure(repinned);
  repinned.pinned = false;
  pinAllocator.observe(repinned);
  repinned.pinned = true;
  repinned.pinnedOrder = pinAllocator.nextPinnedOrder();
  pinAllocator.observe(repinned);
  assert.strictEqual(
    repinned.pinnedOrder,
    5120,
    're-pinning should append after the current pinned high-water mark',
  );
  pinAllocator.remove(repinned);
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

  const reorderedAllocator = new AgentOrderAllocator();
  agents.forEach(item => reorderedAllocator.ensure(item));
  const movedToFront = reorderedProjectAgentOrders(agents, 'c', '', 'a');
  assert.strictEqual(movedToFront.updates.get('c'), 4096);
  agents[2].projectOrder = movedToFront.updates.get('c');
  reorderedAllocator.observe(agents[2]);
  assert.strictEqual(
    reorderedAllocator.ensure(agent('created-after-reorder', undefined)).projectOrder,
    5120,
    'a new Agent should sort after the maximum committed reorder value',
  );

  const adjacent = [agent('a', 3), agent('b', 2), agent('c', 1)];
  const adjacentBefore = adjacent.map(item => ({ ...item }));
  const rebalanced = reorderedProjectAgentOrders(adjacent, 'c', 'a', 'b');
  assert.strictEqual(rebalanced.updates.get('c'), 1536);
  assert.strictEqual(rebalanced.updates.get('a'), 2048);
  assert.strictEqual(rebalanced.updates.get('b'), 1024);
  assert.deepStrictEqual(adjacent, adjacentBefore, 'reorder planning must not mutate live Agent records');

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
