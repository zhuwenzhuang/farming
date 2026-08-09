const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { AgentManager } = require('../agent-manager.cjs');
const {
  activeLifecycleOperation,
  beginLifecycleOperation,
  latestLifecycleOperation,
  transitionLifecycleOperation,
} = require('../agent-lifecycle-journal.cjs');
const { FarmingSessionStore } = require('../farming-session-store.cjs');

function configForStore(store, workspace) {
  return {
    getWorkspace: () => workspace,
    getHeartbeatInterval: () => 60_000,
    getTaskHistory: () => [],
    getCodingAgentEngine: () => 'local',
    getMainPageSessionKeys: () => store.getMainPageSessionKeys(),
    listAgentSessionRecords: () => store.listAgentRecords(),
    getAgentSessionRecordForProviderSessionKey: key => store.getRecordForProviderSessionKey(key),
    ensureAgentSessionRecord: (agent, patch) => store.ensureRecordForAgent(agent, patch),
    rememberAgentSessionRecord: agent => store.rememberAgent(agent),
    removeMainPageSessionKeys: keys => store.removeMainPageSessionKeys(keys),
  };
}

type TerminalAgentFixture = {
  id: string;
  command: string;
  forkCommand: string;
  forkRequestId?: string;
  forkRequestSignature?: string;
  cwd: string;
  projectWorkspace: string;
  status: string;
  engineName: string;
  category: string;
  source: string;
  runtimeBinding: { kind: string };
  providerSessionProvider?: string;
  providerHomeId?: string;
  providerSessionId?: string;
  providerSessionKey?: string;
  providerSessionTemporary?: boolean;
  persistentSessionId?: string;
  customTitle?: string;
  lifecycleJournal?: {
    entries: Array<{ request: Record<string, unknown> }>;
  };
};

function terminalAgent(id: string, workspace: string, operationType: string): TerminalAgentFixture {
  const agent: TerminalAgentFixture = {
    id,
    command: 'bash',
    forkCommand: 'bash',
    cwd: workspace,
    projectWorkspace: workspace,
    status: 'running',
    engineName: 'native',
    category: 'shell',
    source: 'ui',
    runtimeBinding: { kind: 'terminal' },
  };
  beginLifecycleOperation(
    agent,
    operationType,
    operationType,
    { command: 'bash', cwd: workspace, runtimeKind: 'terminal' },
  );
  return agent;
}

async function run() {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-terminal-lifecycle-recovery-'));
  const store = new FarmingSessionStore(configDir);
  store.init();
  const liveCreate = terminalAgent('agent-live-create', configDir, 'create');
  const liveDelete = terminalAgent('agent-live-delete', configDir, 'delete');
  const committedCreate = terminalAgent('agent-committed-create', configDir, 'create');
  committedCreate.providerSessionProvider = 'claude';
  committedCreate.providerHomeId = 'default';
  committedCreate.providerSessionId = '66666666-6666-4666-8666-666666666666';
  committedCreate.providerSessionKey = `agent-session:claude:${committedCreate.providerSessionId}`;
  committedCreate.providerSessionTemporary = false;
  committedCreate.forkRequestId = 'persisted-fork-request';
  committedCreate.forkRequestSignature = 'a'.repeat(64);
  transitionLifecycleOperation(
    committedCreate,
    activeLifecycleOperation(committedCreate).id,
    'membership-pending',
  );
  const missingCreate = terminalAgent('agent-missing-create', configDir, 'create');
  const missingDelete = terminalAgent('agent-missing-delete', configDir, 'delete');
  const missingUpdate = {
    ...terminalAgent('agent-missing-update', configDir, 'update'),
    customTitle: 'Old title',
  };
  missingUpdate.lifecycleJournal.entries.at(-1).request = { customTitle: 'Recovered title' };
  for (const agent of [
    liveCreate,
    liveDelete,
    committedCreate,
    missingCreate,
    missingDelete,
    missingUpdate,
  ]) {
    agent.persistentSessionId = store.ensureRecordForAgent(agent, {
      visibleOnMainPage: true,
      archived: false,
    });
  }

  const manager = new AgentManager(configForStore(store, configDir), {
    skipExecutablePreflight: true,
  });
  const originalEngineBridge = manager.engineBridge;
  await originalEngineBridge.dispose();
  const liveRuntimeIds = new Set([liveCreate.id, liveDelete.id, committedCreate.id]);
  const killed = [];
  const metadataUpdates = [];
  const engine = {
    async killSession(agentId) {
      killed.push(agentId);
      liveRuntimeIds.delete(agentId);
    },
    async getSessionState(agentId) {
      return liveRuntimeIds.has(agentId) ? { status: 'running' } : null;
    },
    async updateSessionMetadata(_agentId, patch) {
      metadataUpdates.push(patch);
    },
  };
  manager.engineBridge = {
    async recoverSessions() {
      return [liveCreate, liveDelete, committedCreate].map(agent => ({
        engineName: 'native',
        agentId: agent.id,
        metadata: {
          agentId: agent.id,
          command: agent.command,
          cwd: agent.cwd,
          category: agent.category,
          source: agent.source,
          forkRequestId: 'stale-host-request',
          forkRequestSignature: 'b'.repeat(64),
        },
        state: { status: 'running', startedAt: 1000 },
      }));
    },
    consumeRuntimeRotations: () => [],
    getEngine: () => engine,
    killSession: async (_engineName, agentId) => engine.killSession(agentId),
    dispose: async () => {},
  };

  try {
    await manager.recoverEngineSessions();

    const recoveredCreate = manager.agents.get(liveCreate.id);
    assert(recoveredCreate, 'a live pending Create must recover as the same Agent');
    assert.strictEqual(activeLifecycleOperation(recoveredCreate), null);
    assert.strictEqual(latestLifecycleOperation(recoveredCreate).state, 'succeeded');

    assert(
      manager.agents.has(committedCreate.id),
      'a runtime-confirmed Create must survive the membership-index crash window',
    );
    const recoveredCommittedCreate = manager.agents.get(committedCreate.id);
    assert.strictEqual(recoveredCommittedCreate.forkRequestId, 'persisted-fork-request');
    assert.strictEqual(recoveredCommittedCreate.forkRequestSignature, 'a'.repeat(64));
    manager.updateEngineProviderSessionMetadata(recoveredCommittedCreate);
    await new Promise(resolve => setImmediate(resolve));
    assert.strictEqual(metadataUpdates.at(-1).forkRequestId, 'persisted-fork-request');
    assert.strictEqual(metadataUpdates.at(-1).forkRequestSignature, 'a'.repeat(64));
    assert(
      store.getMainPageSessionKeys().includes(committedCreate.providerSessionKey),
      'recovery must repair provider membership from committed Create metadata',
    );

    assert.strictEqual(manager.agents.has(liveDelete.id), false);
    assert(killed.includes(liveDelete.id), 'a live pending Delete must resume runtime cleanup');
    const liveDeleteRecord = store.readRecord(liveDelete.persistentSessionId);
    assert.strictEqual(latestLifecycleOperation(liveDeleteRecord).state, 'succeeded');
    assert.strictEqual(liveDeleteRecord.runtimeAgentId, '');

    const missingCreateRecord = store.readRecord(missingCreate.persistentSessionId);
    assert.strictEqual(latestLifecycleOperation(missingCreateRecord).state, 'failed');
    assert.strictEqual(missingCreateRecord.runtimeAgentId, '');

    const missingDeleteRecord = store.readRecord(missingDelete.persistentSessionId);
    assert.strictEqual(latestLifecycleOperation(missingDeleteRecord).state, 'succeeded');
    assert.strictEqual(missingDeleteRecord.runtimeAgentId, '');
    assert.strictEqual(missingDeleteRecord.archived, true);

    const missingUpdateRecord = store.readRecord(missingUpdate.persistentSessionId);
    assert.strictEqual(latestLifecycleOperation(missingUpdateRecord).state, 'succeeded');
    assert.strictEqual(missingUpdateRecord.customTitle, 'Recovered title');
  } finally {
    await manager.dispose();
    fs.rmSync(configDir, { recursive: true, force: true });
  }

  console.log('native Terminal lifecycle journal reconciles live and missing runtimes');
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
