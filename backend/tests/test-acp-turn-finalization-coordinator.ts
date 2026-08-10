const assert = require('assert');

const { AcpTurnFinalizationCoordinator } = require('../acp-turn-finalization-coordinator.cjs');

function acpAgent(id) {
  return {
    id,
    command: 'codex',
    status: 'running',
    runtimeEpoch: `${id}-epoch`,
    runtimeBinding: {
      kind: 'acp',
      state: 'idle',
      stopReason: 'end_turn',
      supportsSteer: true,
      supportsFork: true,
      pendingPermission: null,
      pendingPermissions: [],
      pendingElicitation: null,
      pendingElicitations: [],
      activeElicitations: [],
      sessionRevision: 1,
      sessionUpdatedAt: '',
      error: '',
    },
    attentionSeq: 0,
    readAttentionSeq: 0,
    unread: false,
    acpFinalizedTurnHandle: '',
  };
}

async function run() {
  const first = acpAgent('first');
  const second = acpAgent('second');
  const agents = new Map([[first.id, first], [second.id, second]]);
  const persisted = [];
  const observed = [];
  const metadata = [];
  const reads = [];
  const runtimeEpochs = new Map([
    [first.id, first.runtimeEpoch],
    [second.id, second.runtimeEpoch],
  ]);
  const coordinator = new AcpTurnFinalizationCoordinator({
    agents,
    attention: {
      emitAgentReadState: agent => reads.push(agent.id),
      recordAgentAttentionEvent: agent => {
        agent.attentionSeq += 1;
        agent.attentionReason = 'turn-complete';
        agent.unread = true;
        return { agentId: agent.id, unread: true };
      },
    },
    observeProviderSession: agentId => observed.push(agentId),
    persistence: {
      assertRuntimeOwner: () => {},
      config: null,
      persistAgent: agent => {
        persisted.push(`${agent.id}:${agent.acpFinalizedTurnHandle}`);
        return `agent_${agent.id}`;
      },
      setRecordId: (agent, recordId) => { agent.agentRecordId = recordId; },
    },
    runtime: {
      bindingEpoch: agentId => runtimeEpochs.get(agentId) || '',
      getTranscriptSessionForRead: async () => ({ entries: [] }),
    },
    updateProviderMetadata: agent => metadata.push(agent.id),
  });

  assert.strictEqual(coordinator.observeSettledTurn({
    agentId: first.id,
    exactTurnSummary: 'done',
    settledTurnHandle: 'binding-1:1',
    stopReason: 'end_turn',
  }), true);
  assert.strictEqual(coordinator.observeSettledTurn({
    agentId: first.id,
    exactTurnSummary: 'duplicate',
    settledTurnHandle: 'binding-1:1',
    stopReason: 'end_turn',
  }), false);
  assert.strictEqual(coordinator.observeSettledTurn({
    agentId: first.id,
    exactTurnSummary: 'newer',
    settledTurnHandle: 'binding-1:2',
    stopReason: 'end_turn',
  }), true);
  assert.strictEqual(coordinator.observeSettledTurn({
    agentId: second.id,
    exactTurnSummary: 'other',
    settledTurnHandle: 'binding-2:1',
    stopReason: 'end_turn',
  }), true);
  await coordinator.whenIdle();

  assert.deepStrictEqual(persisted.filter(value => value.startsWith('first:')), [
    'first:binding-1:1',
    'first:binding-1:2',
  ]);
  assert(persisted.includes('second:binding-2:1'));
  assert.strictEqual(first.acpFinalizedTurnHandle, 'binding-1:2');
  assert.strictEqual(coordinator.finalizedTurnHandle(first.id), 'binding-1:2');
  assert.deepStrictEqual(metadata, reads);
  assert.deepStrictEqual([...observed].sort(), ['first', 'first', 'second']);

  coordinator.observeSettledTurn({
    agentId: first.id,
    exactTurnSummary: 'stale',
    settledTurnHandle: 'binding-1:3',
    stopReason: 'end_turn',
  });
  runtimeEpochs.set(first.id, 'replacement-epoch');
  await coordinator.whenIdle(first.id);
  assert(!persisted.includes('first:binding-1:3'), 'a stale runtime epoch must fence finalization');

  coordinator.forget(first.id);
  assert.strictEqual(coordinator.finalizedTurnHandle(first.id), '');
  coordinator.dispose();
  assert.strictEqual(coordinator.pendingOperations().size, 0);
}

run().then(() => {
  console.log('ACP Turn finalization coordinator tests passed');
}).catch(error => {
  console.error(error);
  process.exitCode = 1;
});
