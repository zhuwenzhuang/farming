import assert from 'assert';
import type { AgentRecord, PersistedAgentPrivateMetadata } from '../agent-manager-record-types.js';
import { AcpSessionOptionsStore } from '../acp-session-options-store.cjs';
import { AgentSessionPersistenceService } from '../agent-session-persistence-service.cjs';

function main() {
  const agents = new Map<string, AgentRecord>();
  const sessionOptions = new AcpSessionOptionsStore();
  const records = new Map<string, PersistedAgentPrivateMetadata>();
  const writes: Array<Partial<PersistedAgentPrivateMetadata>> = [];
  const orderObservations: boolean[] = [];
  let recoveryComplete = false;
  const config = {
    ensureAgentSessionRecord(_agent: AgentRecord, patch: Partial<PersistedAgentPrivateMetadata>) {
      writes.push(patch);
      return 'record-new';
    },
    getAgentSessionRecordForProviderSessionKey(sessionKey: string) {
      return records.get(sessionKey) || null;
    },
  };
  const service = new AgentSessionPersistenceService({
    config,
    getAgent: agentId => agents.get(agentId),
    isRecoveryComplete: () => recoveryComplete,
    isVerifiedStopped: agentId => agents.get(agentId)?.status === 'stopped',
    observeOrder: (_agent, live) => orderObservations.push(live),
    sessionOptions,
  });
  assert.strictEqual(service.isRequired(), true);
  const sessionKey = 'claude\u0000session-a';
  const agent: AgentRecord = {
    id: 'agent-new',
    agentRecordId: 'record-old',
    providerSessionKey: sessionKey,
    status: 'running',
  };
  agents.set(agent.id, agent);
  sessionOptions.set(sessionKey, {
    additionalDirectories: ['/shared'],
    configOverrides: [{ configId: 'model', value: 'sonnet' }],
    mcpServers: [{ name: 'private' }],
  });
  records.set(sessionKey, {
    id: 'record-new',
    agentRecordId: 'record-new',
    runtimeAgentId: agent.id,
    projectWorkspace: '/canonical',
    pinned: true,
  });
  assert.strictEqual(service.persist(agent), 'record-new');
  assert.strictEqual(agent.projectWorkspace, '/canonical');
  assert.strictEqual(agent.pinned, true);
  assert.deepStrictEqual(writes[0]?.acpAdditionalDirectories, ['/shared']);
  assert.deepStrictEqual(orderObservations, [true]);

  records.set(sessionKey, { id: 'record-new', runtimeAgentId: 'agent-owner' });
  assert.throws(() => service.persist(agent), /before recovery completes/);
  recoveryComplete = true;
  agents.set('agent-owner', { id: 'agent-owner', status: 'running' });
  assert.throws(() => service.persist(agent), /owned by Runtime agent-owner/);
  agents.get('agent-owner')!.status = 'stopped';
  assert.strictEqual(service.persist(agent), 'record-new');

  console.log('Agent session persistence service tests passed');
}

main();
