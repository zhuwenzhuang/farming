const assert = require('assert');
const EventEmitter = require('events');

const { AgentManager } = require('../agent-manager.cjs');
const { encodeProviderSessionKey } = require('../../shared/provider-session-identity.js');

class RecoveryRuntime extends EventEmitter {
  bindings = new Map();
  async initialize() {}
  hasBinding(agentId) { return this.bindings.has(agentId); }
  publishRecoveredBindings() {}
  unregisterAgent(agentId) { this.bindings.delete(agentId); }
  async dispose() { this.bindings.clear(); }
}

function legacyMainRecord(index) {
  return {
    id: `legacy-main-record-${index}`,
    runtimeAgentId: `legacy-main-${index}`,
    command: 'codex',
    forkCommand: 'codex',
    cwd: '/repo/.farming',
    projectWorkspace: '/repo',
    wantsMain: true,
    archived: false,
    agentRuntimeMode: 'terminal',
    updatedAt: index,
  };
}

function indexedHistoryRecord(index) {
  const sessionId = `10000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
  const providerSessionKey = encodeProviderSessionKey('codex', sessionId, 'default');
  return {
    record: {
      id: `history-record-${index}`,
      runtimeAgentId: `history-agent-${index}`,
      command: index === 0 ? 'bash' : `codex resume ${sessionId}`,
      forkCommand: index === 0 ? 'bash' : 'codex',
      mainWorkspace: index === 0 ? '/repo/.farming' : '',
      cwd: '/repo',
      projectWorkspace: '/repo',
      provider: 'codex',
      providerHomeId: 'default',
      providerSessionId: sessionId,
      providerSessionKey,
      wantsMain: true,
      archived: false,
      agentRuntimeMode: 'terminal',
      updatedAt: 10_000 + index,
    },
    providerSessionKey,
  };
}

async function run() {
  const legacyRecords = Array.from({ length: 6_565 }, (_, index) => legacyMainRecord(index));
  const indexed = Array.from({ length: 50 }, (_, index) => indexedHistoryRecord(index));
  const archivedRecords = Array.from({ length: 1_837 }, (_, index) => ({
    ...legacyMainRecord(20_000 + index),
    id: `archived-record-${index}`,
    runtimeAgentId: `archived-agent-${index}`,
    archived: true,
  }));
  const retiredMainShells = Array.from({ length: 45 }, (_, index) => ({
    ...legacyMainRecord(index),
    id: `retired-shell-record-${index}`,
    runtimeAgentId: `retired-shell-${index}`,
    command: 'bash',
    forkCommand: 'bash',
    mainWorkspace: '/repo/.farming',
    wantsMain: false,
    visibleOnMainPage: true,
    lifecycleJournal: { sequence: 1, entries: [{
      id: 'aop_1', type: 'create', state: 'succeeded', startedAt: 1, updatedAt: 2,
    }] },
  }));
  const ordinaryShells = Array.from({ length: 9 }, (_, index) => ({
    ...retiredMainShells[index],
    id: `ordinary-shell-record-${index}`,
    runtimeAgentId: `ordinary-shell-${index}`,
    mainWorkspace: '',
    cwd: '/repo',
  }));
  const records = [...legacyRecords, ...indexed.map(entry => entry.record), ...archivedRecords, ...retiredMainShells, ...ordinaryShells];
  assert.strictEqual(records.length, 8_506, 'fixture includes 45 demoted Main Shells and 9 ordinary Shells');
  const runtime = new RecoveryRuntime();
  const manager = new AgentManager({
    farmingDir: '/tmp/farming-recovery-inventory-shape',
    getWorkspace: () => '/repo',
    getHeartbeatInterval: () => 60_000,
    getTaskHistory: () => [],
    getCodingAgentEngine: () => 'local',
    getMainPageSessionKeys: () => indexed.map(entry => entry.providerSessionKey),
    listAgentSessionRecords: () => records,
  }, { acpRuntime: runtime, skipExecutablePreflight: true });
  let releaseEngineRecovery;
  manager.engineBridge.recoverSessions = () => new Promise(resolve => {
    releaseEngineRecovery = resolve;
  });

  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.strictEqual(typeof releaseEngineRecovery, 'function');
    const state = manager.getState();
    assert.strictEqual(
      state.agents.length,
      51,
      'cold inventory must contain one Main and 50 indexed rows without fabricating Shells from metadata',
    );
    assert.strictEqual(
      state.agents.filter(agent => agent.isMain === true).length,
      1,
      'legacy wantsMain flags must project to one authoritative Main identity',
    );
    assert(state.mainAgentId, 'cold inventory must elect one deterministic Main identity');
    assert.deepStrictEqual(
      state.agents.filter(agent => agent.id.startsWith('ordinary-shell-')).map(agent => agent.status),
      [],
      'ordinary Shells must stay absent until native-host enumeration supplies recoverable state',
    );
    assert.deepStrictEqual(
      state.agents.filter(agent => agent.id.startsWith('history-agent-')).map(agent => agent.status),
      Array(50).fill('stopped'),
      'indexed history rows must be visible and explicitly cold until a user resumes one',
    );
  } finally {
    releaseEngineRecovery?.([]);
    await manager.dispose();
  }

  console.log('Agent recovery bounds legacy Main inventory and preserves indexed history placeholders');
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
