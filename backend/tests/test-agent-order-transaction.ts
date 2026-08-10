const assert = require('assert');
const { commitAgentOrderTransaction } = require('../agent-order-transaction.cjs');

function createOwner(agents) {
  const writes = [];
  const metadataUpdates = [];
  const lifecycleOperations = new Map();
  let updateCount = 0;
  return {
    owner: {
      agents,
      getLifecycleOperation(agentId) {
        return lifecycleOperations.get(agentId);
      },
      hasLifecycleOperation(agentId) {
        return lifecycleOperations.has(agentId);
      },
      persistAgent(agent) {
        writes.push({ ...agent });
      },
      updateRuntimeMetadata(agent) {
        metadataUpdates.push(agent.id);
      },
      emitUpdate() {
        updateCount += 1;
      },
      setAgentRecordId(agent, recordId) {
        agent.agentRecordId = recordId;
        agent.persistentSessionId = recordId;
      },
      finiteOrder(value) {
        return Number.isFinite(value) ? value : 0;
      },
    },
    writes,
    lifecycleOperations,
    metadataUpdates,
    updateCount: () => updateCount,
  };
}

function run() {
  const agents = new Map([
    ['first', { id: 'first', projectOrder: 1, agentRecordId: 'record-first' }],
    ['second', { id: 'second', projectOrder: 2, agentRecordId: 'record-second' }],
  ]);
  const success = createOwner(agents);
  const result = commitAgentOrderTransaction(
    success.owner,
    'first',
    [['first', 3], ['second', 1]],
    'projectOrder',
  );
  assert.strictEqual(result.error, undefined);
  assert.strictEqual(agents.get('first').projectOrder, 3);
  assert.strictEqual(agents.get('second').projectOrder, 1);
  assert.deepStrictEqual(success.metadataUpdates, ['first', 'second']);
  assert.strictEqual(success.updateCount(), 1);

  const rollbackAgents = new Map([
    ['first', { id: 'first', pinnedOrder: 1, agentRecordId: 'record-first' }],
    ['second', { id: 'second', pinnedOrder: 2, agentRecordId: 'record-second' }],
  ]);
  const rollback = createOwner(rollbackAgents);
  let writeCount = 0;
  rollback.owner.persistAgent = agent => {
    rollback.writes.push({ ...agent });
    writeCount += 1;
    if (writeCount === 2) throw new Error('storage unavailable');
  };
  const failed = commitAgentOrderTransaction(
    rollback.owner,
    'first',
    [['first', 3], ['second', 1]],
    'pinnedOrder',
  );
  assert.match(failed.error, /storage unavailable/);
  assert.strictEqual(
    rollbackAgents.get('first').pinnedOrder,
    1,
    'failed persistence must not publish staged order to runtime state',
  );
  assert.strictEqual(rollback.updateCount(), 0);
  assert.strictEqual(
    rollback.writes.at(-1).pinnedOrder,
    1,
    'an already-written staged record must be restored after a later write fails',
  );

  const conflict = createOwner(agents);
  conflict.lifecycleOperations.set('second', { label: 'Delete Agent' });
  const blocked = commitAgentOrderTransaction(
    conflict.owner,
    'first',
    [['first', 2], ['second', 1]],
    'projectOrder',
  );
  assert.match(blocked.error, /Delete Agent/);
  assert.strictEqual(conflict.writes.length, 0);

  console.log('Agent order transaction tests passed');
}

run();
