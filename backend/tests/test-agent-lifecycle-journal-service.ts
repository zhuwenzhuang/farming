import assert from 'assert';
import type { AgentRecord, PersistedAgentPrivateMetadata } from '../agent-manager-record-types.js';
import { AgentLifecycleJournalService } from '../agent-lifecycle-journal-service.cjs';

async function main() {
  const agents = new Map<string, AgentRecord>();
  const records: PersistedAgentPrivateMetadata[] = [];
  const writes: Array<{
    agent: AgentRecord;
    patch: Partial<PersistedAgentPrivateMetadata>;
  }> = [];
  let persistError = '';
  const persistence = {
    isRequired: () => true,
    persist(agent: AgentRecord, patch: Partial<PersistedAgentPrivateMetadata> = {}) {
      if (persistError) throw new Error(persistError);
      writes.push({
        agent: JSON.parse(JSON.stringify(agent)) as AgentRecord,
        patch,
      });
      agent.agentRecordId = 'record-1';
      agent.persistentSessionId = 'record-1';
      return 'record-1';
    },
  };
  const service = new AgentLifecycleJournalService({
    getAgent: agentId => agents.get(agentId),
    getInFlightPromise: () => null,
    listRecords: () => records,
    persistence,
  });
  const agent: AgentRecord = { id: 'agent-1', status: 'running' };
  agents.set(agent.id, agent);

  const admitted = service.begin(agent, 'update', 'rename:one', { customTitle: 'One' });
  assert.ok(admitted.operation);
  assert.strictEqual(admitted.operation.state, 'pending');
  assert.strictEqual(writes.length, 1);

  const conflict = service.begin(agent, 'delete', 'delete');
  assert.match(conflict.error || '', /has not reached a terminal state/);
  assert.strictEqual(writes.length, 1, 'conflicting admission must not rewrite persistence');

  const operationId = admitted.operation.id;
  service.checkpointRequest(agent, operationId, { checkpoint: 'saved' });
  assert.strictEqual(agent.lifecycleJournal?.entries[0]?.request.checkpoint, 'saved');
  const journalBeforeFailure = JSON.parse(JSON.stringify(agent.lifecycleJournal));
  persistError = 'simulated transition failure';
  assert.throws(
    () => service.transition(agent, operationId, 'runtime-pending'),
    /simulated transition failure/,
  );
  assert.deepStrictEqual(
    agent.lifecycleJournal,
    journalBeforeFailure,
    'failed persistence must restore the previous journal',
  );

  persistError = '';
  service.complete(agent, operationId, { agentId: agent.id }, { customTitle: 'One' });
  assert.strictEqual(agent.lifecycleJournal?.entries[0]?.state, 'succeeded');
  assert.strictEqual(agent.agentRecordId, 'record-1');
  const deduplicated = service.beginUpdate(agent, 'rename:one', { customTitle: 'One' });
  assert.strictEqual(deduplicated.deduplicated, true);

  const createAgent: AgentRecord = { id: 'agent-create', status: 'running' };
  agents.set(createAgent.id, createAgent);
  const create = service.begin(
    createAgent,
    'create',
    'create-request:req-1',
    { agentId: createAgent.id, signature: 'signature-1' },
  );
  assert.ok(create.operation);
  service.transition(createAgent, create.operation.id, 'succeeded');
  const recorded = service.recordCreateRequestResult(
    createAgent.id,
    'req-1',
    { controlApi: { status: 201 } },
  );
  assert.strictEqual(recorded.operationId, create.operation.id);
  assert.deepStrictEqual(
    createAgent.lifecycleJournal?.entries[0]?.result,
    { controlApi: { status: 201 } },
  );
  records.push({
    id: 'record-create',
    runtimeAgentId: createAgent.id,
    lifecycleJournal: JSON.parse(JSON.stringify(createAgent.lifecycleJournal)),
  });
  assert.deepStrictEqual(
    await service.replayCreateRequest('req-1', 'signature-1'),
    {
      agentId: createAgent.id,
      deduplicated: true,
      createResult: { controlApi: { status: 201 } },
    },
  );
  assert.match(
    String((await service.replayCreateRequest('req-1', 'different-signature'))?.error || ''),
    /different Agent parameters/,
  );

  persistError = 'simulated result failure';
  const unchangedResult = JSON.parse(JSON.stringify(createAgent.lifecycleJournal));
  assert.match(
    service.recordCreateRequestResult(createAgent.id, 'req-1', { controlApi: { status: 500 } }).error || '',
    /simulated result failure/,
  );
  assert.deepStrictEqual(createAgent.lifecycleJournal, unchangedResult);

  console.log('Agent lifecycle journal service tests passed');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
