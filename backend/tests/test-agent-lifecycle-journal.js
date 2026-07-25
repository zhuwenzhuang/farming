const assert = require('assert');
const {
  activeLifecycleOperation,
  beginLifecycleOperation,
  lifecycleJournal,
  transitionLifecycleOperation,
} = require('../agent-lifecycle-journal');

function run() {
  const agent = {};
  const first = beginLifecycleOperation(agent, 'delete', 'delete', { reason: 'manual' }, 100);
  assert.strictEqual(first.joined, false);
  assert.strictEqual(first.operation.id, 'aop_1');
  assert.strictEqual(activeLifecycleOperation(agent).state, 'pending');

  const duplicate = beginLifecycleOperation(agent, 'delete', 'delete', { reason: 'manual' }, 101);
  assert.strictEqual(duplicate.joined, true);
  assert.strictEqual(duplicate.operation.id, first.operation.id);

  const conflict = beginLifecycleOperation(agent, 'update', 'rename:new-name', { customTitle: 'new-name' }, 102);
  assert.strictEqual(conflict.conflict.id, first.operation.id);

  transitionLifecycleOperation(agent, first.operation.id, 'blocked', 'exit proof unavailable', 103);
  assert.strictEqual(activeLifecycleOperation(agent).state, 'blocked');
  transitionLifecycleOperation(agent, first.operation.id, 'succeeded', '', 104);
  assert.strictEqual(activeLifecycleOperation(agent), null);

  const next = beginLifecycleOperation(agent, 'update', 'rename:new-name', { customTitle: 'new-name' }, 105);
  assert.strictEqual(next.operation.id, 'aop_2');
  transitionLifecycleOperation(agent, next.operation.id, 'succeeded', '', 106);

  const serialized = JSON.parse(JSON.stringify(agent.lifecycleJournal));
  assert.deepStrictEqual(lifecycleJournal({ lifecycleJournal: serialized }), serialized);

  const longLivedAgent = {};
  const create = beginLifecycleOperation(
    longLivedAgent,
    'create',
    'create-request:stable-client-request',
    {
      agentId: 'agent-stable',
      previousState: {
        acpMcpServers: [{ name: 'private', env: [{ name: 'TOKEN', value: 'secret' }] }],
      },
    },
    200,
  );
  transitionLifecycleOperation(longLivedAgent, create.operation.id, 'succeeded', '', 201);
  for (let index = 0; index < 40; index += 1) {
    const update = beginLifecycleOperation(
      longLivedAgent,
      'update',
      `rename:title-${index}`,
      { customTitle: `title-${index}` },
      202 + index * 2,
    );
    transitionLifecycleOperation(longLivedAgent, update.operation.id, 'succeeded', '', 203 + index * 2);
  }
  assert(
    lifecycleJournal(longLivedAgent).entries.some(operation => (
      operation.requestKey === 'create-request:stable-client-request'
    )),
    'an explicit Create idempotency key must outlive bounded recent Update history',
  );
  const retainedCreate = lifecycleJournal(longLivedAgent).entries.find(operation => (
    operation.requestKey === 'create-request:stable-client-request'
  ));
  assert.strictEqual(
    Object.prototype.hasOwnProperty.call(retainedCreate.request, 'previousState'),
    false,
    'terminal Create history must not retain rollback-only MCP secrets',
  );
  console.log('agent lifecycle journal tests passed');
}

run();
