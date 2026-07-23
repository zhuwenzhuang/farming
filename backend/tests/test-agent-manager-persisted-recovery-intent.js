const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const AgentManager = require('../agent-manager');
const { AcpRuntime } = require('../acp-runtime');
const { FarmingSessionStore } = require('../farming-session-store');

function configForStore(store, workspace) {
  return {
    farmingDir: store.configDir,
    getWorkspace: () => workspace,
    getHeartbeatInterval: () => 60_000,
    getTaskHistory: () => [],
    getCodingAgentEngine: () => 'local',
    getMainPageSessionKeys: () => store.getMainPageSessionKeys(),
    listAgentSessionRecords: () => store.listAgentRecords(),
    ensureAgentSessionRecord: (agent, patch) => store.ensureRecordForAgent(agent, patch),
    rememberAgentSessionRecord: agent => store.rememberAgent(agent),
    removeMainPageSessionKeys: keys => store.removeMainPageSessionKeys(keys),
  };
}

async function run() {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-persisted-recovery-intent-'));
  const store = new FarmingSessionStore(configDir);
  store.init();
  const sessionId = '55555555-5555-4555-8555-555555555555';
  const sessionKey = `agent-session:claude:${sessionId}`;
  const agent = {
    id: 'agent-closed-claude',
    command: 'claude',
    forkCommand: 'claude',
    cwd: configDir,
    projectWorkspace: configDir,
    status: 'running',
    engineName: 'native',
    category: 'coding',
    source: `claude-history:${sessionId}`,
    providerSessionProvider: 'claude',
    providerHomeId: 'default',
    providerSessionId: sessionId,
    providerSessionKey: sessionKey,
    providerSessionTemporary: false,
    runtimeBinding: { kind: 'acp', state: 'idle' },
    customTitle: '',
  };
  const firstRuntime = new AcpRuntime();
  const firstManager = new AgentManager(
    configForStore(store, configDir),
    { acpRuntime: firstRuntime, skipExecutablePreflight: true },
  );
  firstManager.engineBridge.getEngine = () => ({ killSession: async () => {} });

  try {
    await firstManager.whenRecovered();
    store.rememberAgent(agent);
    firstManager.agents.set(agent.id, agent);
    firstManager.lastActivity.set(agent.id, Date.now());
    firstManager.renameAgent(agent.id, 'Persisted Claude name');
    assert.strictEqual(
      store.listAgentRecords().find(record => record.providerSessionKey === sessionKey).customTitle,
      'Persisted Claude name',
      'rename must be written to the real Farming session store',
    );

    const archived = await firstManager.archiveAgent(agent.id);
    assert.strictEqual(archived.error, undefined);
    assert.deepStrictEqual(store.getMainPageSessionKeys(), []);
    const hiddenRecord = store.listAgentRecords().find(record => record.providerSessionKey === sessionKey);
    assert.strictEqual(hiddenRecord.visibleOnMainPage, false);
    assert.strictEqual(hiddenRecord.customTitle, 'Persisted Claude name');
  } finally {
    await firstManager.dispose();
  }

  const recoveredStore = new FarmingSessionStore(configDir);
  recoveredStore.init();
  assert.deepStrictEqual(recoveredStore.getMainPageSessionKeys(), []);
  assert.strictEqual(
    recoveredStore.listAgentRecords().find(record => record.providerSessionKey === sessionKey).customTitle,
    'Persisted Claude name',
    'a fresh session store must read the renamed title from disk',
  );

  const recoveredRuntime = new AcpRuntime();
  const recoveredManager = new AgentManager(
    configForStore(recoveredStore, configDir),
    { acpRuntime: recoveredRuntime, skipExecutablePreflight: true },
  );
  try {
    await recoveredManager.whenRecovered();
    assert.strictEqual(
      recoveredManager.agents.has(agent.id),
      false,
      'a fresh manager must not restore a Claude session removed from persisted main-page metadata',
    );
    assert.strictEqual(recoveredRuntime.bindings.has(agent.id), false);
  } finally {
    await recoveredManager.dispose();
    fs.rmSync(configDir, { recursive: true, force: true });
  }

  console.log('✓ Persisted main-page metadata controls Claude recovery and rename survives storage');
}

run().catch(error => {
  console.error(error);
  process.exit(1);
});
