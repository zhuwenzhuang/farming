const assert = require('assert');
const EventEmitter = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sessionEngineBridgePath = require.resolve('../session-engine-bridge');

class FakeSessionEngineBridge extends EventEmitter {
  async recoverSessions() {
    return [];
  }

  consumeRuntimeRotations() {
    return [];
  }

  async killSession() {}

  getEngine() {
    return null;
  }

  dispose() {}
}

require.cache[sessionEngineBridgePath] = {
  id: sessionEngineBridgePath,
  filename: sessionEngineBridgePath,
  loaded: true,
  exports: FakeSessionEngineBridge,
};

const AgentManager = require('../agent-manager');
const { serializeTerminalState } = require('../terminal-state-serialization');

function configManager() {
  return {
    getWorkspace() {
      return process.cwd();
    },
    getHeartbeatInterval() {
      return 1000;
    },
    getCodingAgentEngine() {
      return 'local';
    },
    getVtBaseUrl() {
      return 'http://localhost:4020';
    },
    getTaskHistory() {
      return [];
    },
    listAgentSessionRecords() {
      return [{
        runtimeAgentId: 'recovered-codex',
        source: 'ui',
        projectWorkspace: '/repo',
        provider: 'codex',
        providerHomeId: 'default',
        providerHomePath: '/home/test/.codex',
        providerSessionId: '11111111-1111-4111-8111-111111111111',
        providerSessionKey: 'agent-session:codex:11111111-1111-4111-8111-111111111111',
        providerSessionTemporary: false,
        providerSessionSource: 'codex-rollout',
        providerSessionResolvedAt: 1234,
        providerSessionTitle: 'Recovered Codex session',
        providerSessionWorkspace: '/repo',
        terminalInputReceived: true,
        agentRuntimeMode: 'terminal',
        pinned: true,
        projectOrder: 4096,
        pinnedOrder: 2048,
      }];
    },
  };
}

async function run() {
  const testConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-agent-recovery-'));
  const killed = [];
  const manager = new AgentManager(configManager());
  manager.engineBridge = {
    async recoverSessions() {
      return [
        {
          engineName: 'native',
          agentId: 'recovered-codex',
          metadata: {
            agentId: 'recovered-codex',
            command: 'codex',
            cwd: '/repo',
            category: 'coding',
            source: 'ui',
            launchPermissionMode: 'full',
          },
          state: { status: 'running', startedAt: 1234 },
        },
        {
          engineName: 'native',
          agentId: 'main-bash',
          metadata: {
            agentId: 'main-bash',
            command: 'bash',
            cwd: '/main',
            category: 'other',
            source: 'ui',
            wantsMain: true,
          },
          state: { status: 'running', startedAt: 2000 },
        },
        {
          engineName: 'native',
          agentId: 'untracked-bash',
          metadata: {
            agentId: 'untracked-bash',
            command: 'bash',
            cwd: '/repo',
            category: 'other',
            source: 'ui',
          },
          state: { status: 'running', startedAt: 2345 },
        },
        {
          engineName: 'native',
          agentId: 'untracked-shell-category',
          metadata: {
            agentId: 'untracked-shell-category',
            command: 'codex',
            cwd: '/repo',
            category: 'shell',
            source: 'ui',
          },
          state: { status: 'running', startedAt: 3456 },
        },
      ];
    },
    async killSession(engineName, sessionId) {
      killed.push({ engineName, sessionId });
    },
    getEngine() {
      return null;
    },
    dispose() {},
  };

  try {
    await manager.recoverEngineSessions();

    assert(manager.agents.has('recovered-codex'), 'recoverable coding sessions should be restored');
    assert.strictEqual(manager.agents.get('recovered-codex').launchPermissionMode, 'full');
    assert.strictEqual(manager.agents.get('recovered-codex').pinned, true);
    assert.strictEqual(manager.agents.get('recovered-codex').projectOrder, 4096);
    assert.strictEqual(manager.agents.get('recovered-codex').pinnedOrder, 2048);
    assert.strictEqual(manager.agents.get('recovered-codex').providerSessionProvider, 'codex');
    assert.strictEqual(
      manager.agents.get('recovered-codex').providerSessionId,
      '11111111-1111-4111-8111-111111111111',
      'the first recovered projection must retain the persisted provider identity even when a legacy host omits it'
    );
    assert.strictEqual(manager.agents.get('recovered-codex').providerSessionTemporary, false);
    assert.strictEqual(manager.agents.get('recovered-codex').terminalInputReceived, true);
    assert.strictEqual(
      manager.getState().agents.find(agent => agent.id === 'recovered-codex').launchPermissionMode,
      'full'
    );
    assert(manager.agents.has('main-bash'), 'Main Agent shell sessions should be restored');
    assert.strictEqual(manager.mainAgentId, 'main-bash');
    assert.strictEqual(manager.getState().agents.find(agent => agent.id === 'main-bash').isMain, true);
    assert.strictEqual(manager.agents.has('untracked-bash'), false, 'shell sessions should not be restored');
    assert.strictEqual(manager.agents.has('untracked-shell-category'), false, 'shell-category sessions should not be restored');
    assert.deepStrictEqual(
      killed,
      [
        { engineName: 'native', sessionId: 'untracked-bash' },
        { engineName: 'native', sessionId: 'untracked-shell-category' },
      ],
      'unrecovered shell sessions should be killed so the native pty host cannot accumulate invisible PTYs'
    );
  } finally {
    await manager.dispose({ preserveTerminalHost: true });
  }

  const providerSessionId = '11111111-1111-4111-8111-111111111111';
  const providerSessionKey = `agent-session:codex:${providerSessionId}`;
  const appServerSessionKey = 'agent-session:codex:33333333-3333-4333-8333-333333333333';
  const rotationRecord = {
    id: 'fsess_rotation_test',
    runtimeAgentId: 'agent-before-upgrade',
    command: 'codex',
    forkCommand: 'codex',
    cwd: process.cwd(),
    projectWorkspace: process.cwd(),
    provider: 'codex',
    providerHomeId: 'default',
    providerHomePath: '',
    providerSessionId,
    providerSessionKey,
    providerSessionTitle: 'Upgrade recovery test',
    agentRuntimeMode: 'terminal',
    launchPermissionMode: 'full',
    customTitle: 'Pinned recovery',
    pinned: true,
    projectOrder: 4096,
    pinnedOrder: 2048,
    terminalInputReceived: true,
    attentionSeq: 3,
    readAttentionSeq: 1,
    archived: false,
    updatedAt: 20,
  };
  const duplicateRecord = {
    ...rotationRecord,
    id: 'fsess_rotation_duplicate',
    runtimeAgentId: 'agent-duplicate-before-upgrade',
    customTitle: 'Stale duplicate',
    updatedAt: 10,
  };
  const hiddenRecord = {
    ...rotationRecord,
    id: 'fsess_rotation_hidden',
    runtimeAgentId: 'agent-hidden-before-upgrade',
    providerSessionId: '22222222-2222-4222-8222-222222222222',
    providerSessionKey: 'agent-session:codex:22222222-2222-4222-8222-222222222222',
  };
  const appServerRecord = {
    ...rotationRecord,
    id: 'fsess_rotation_app_server',
    runtimeAgentId: 'agent-app-server-before-upgrade',
    providerSessionId: '33333333-3333-4333-8333-333333333333',
    providerSessionKey: appServerSessionKey,
    codexRuntimeMode: 'app-server',
  };
  const rotationManager = new AgentManager({
    ...configManager(),
    farmingDir: testConfigDir,
    getMainPageSessionKeys() {
      return [providerSessionKey, appServerSessionKey];
    },
    listAgentSessionRecords() {
      return [duplicateRecord, rotationRecord, hiddenRecord, appServerRecord];
    },
  });
  await rotationManager.whenRecovered();
  const restoredStarts = [];
  rotationManager.engineBridge = {
    async recoverSessions() {
      return [];
    },
    consumeRuntimeRotations() {
      return [{
        engineName: 'native',
        previous: null,
        current: { protocolVersion: 2, buildId: 'a'.repeat(64), version: '2.2.9' },
      }];
    },
    getEngine() {
      return null;
    },
    dispose() {},
  };
  rotationManager.startAgent = async (command, cwd, callback, options) => {
    restoredStarts.push({ command, cwd, options });
    const agentId = 'agent-after-upgrade';
    rotationManager.agents.set(agentId, {
      id: agentId,
      providerSessionProvider: 'codex',
      providerSessionId,
      providerHomeId: 'default',
      customTitle: '',
    });
    return agentId;
  };
  try {
    await rotationManager.recoverEngineSessions();
    assert.strictEqual(
      restoredStarts.length,
      1,
      'only the newest authoritative main-page Terminal record should restart; duplicates and migrated ACP records must not'
    );
    assert(restoredStarts[0].command.includes(providerSessionId), restoredStarts[0].command);
    assert.strictEqual(restoredStarts[0].options.skipRecoveryWait, true);
    assert.strictEqual(restoredStarts[0].options.persistentSessionId, rotationRecord.id);
    assert.strictEqual(restoredStarts[0].options.runtimeAgentId, rotationRecord.runtimeAgentId);
    const replacement = rotationManager.agents.get('agent-after-upgrade');
    assert.strictEqual(replacement.customTitle, 'Pinned recovery');
    assert.strictEqual(replacement.pinned, true);
    assert.strictEqual(replacement.terminalInputReceived, true);
    assert.strictEqual(replacement.unread, true);
  } finally {
    await rotationManager.dispose({ preserveTerminalHost: true });
  }

  const shellRotationRecord = {
    id: 'fsess_shell_rotation',
    runtimeAgentId: 'agent-shell-before-upgrade',
    command: 'bash',
    forkCommand: 'bash',
    cwd: process.cwd(),
    projectWorkspace: process.cwd(),
    category: 'other',
    source: 'ui',
    agentRuntimeMode: 'terminal',
    archived: false,
    updatedAt: 30,
  };
  const serializedRotationState = serializeTerminalState([
    {
      id: rotationRecord.runtimeAgentId,
      metadata: rotationRecord,
      processDetails: { cwd: rotationRecord.cwd, title: 'Codex' },
      processLaunchConfig: { command: 'codex', args: [], category: 'coding' },
      replayEvent: { events: [{ data: 'codex output before rotation', cols: 100, rows: 32 }] },
      timestamp: 100,
    },
    {
      id: shellRotationRecord.runtimeAgentId,
      metadata: shellRotationRecord,
      processDetails: { cwd: shellRotationRecord.cwd, title: 'bash' },
      processLaunchConfig: { command: 'bash', args: [], category: 'other' },
      replayEvent: { events: [{ data: 'shell output before rotation', cols: 120, rows: 40 }] },
      timestamp: 101,
    },
  ]);
  const serializedRotationManager = new AgentManager({
    ...configManager(),
    farmingDir: testConfigDir,
    getMainPageSessionKeys() {
      return [providerSessionKey];
    },
    listAgentSessionRecords() {
      return [rotationRecord, shellRotationRecord, hiddenRecord, appServerRecord];
    },
  });
  await serializedRotationManager.whenRecovered();
  const serializedRestarts = [];
  serializedRotationManager.engineBridge = {
    async recoverSessions() {
      return [];
    },
    consumeRuntimeRotations() {
      return [{
        engineName: 'native',
        previous: null,
        current: { protocolVersion: 7, buildId: 'b'.repeat(64), version: '2.2.9' },
        serializedTerminalState: serializedRotationState,
      }];
    },
    getEngine() {
      return null;
    },
    dispose() {},
  };
  serializedRotationManager.startAgent = async (command, cwd, callback, options) => {
    serializedRestarts.push({ command, cwd, options });
    const agentId = options.runtimeAgentId;
    serializedRotationManager.agents.set(agentId, {
      id: agentId,
      providerSessionProvider: command.includes(providerSessionId) ? 'codex' : '',
      providerSessionId: command.includes(providerSessionId) ? providerSessionId : '',
      providerHomeId: 'default',
      customTitle: '',
    });
    return agentId;
  };
  try {
    await serializedRotationManager.recoverEngineSessions();
    assert.strictEqual(
      serializedRestarts.length,
      2,
      'the exact serialized live-session set should revive provider and ordinary shell terminals'
    );
    const providerRestart = serializedRestarts.find(entry => entry.options.runtimeAgentId === rotationRecord.runtimeAgentId);
    const shellRestart = serializedRestarts.find(entry => entry.options.runtimeAgentId === shellRotationRecord.runtimeAgentId);
    assert(providerRestart);
    assert(shellRestart);
    assert(providerRestart.command.includes(providerSessionId));
    assert.strictEqual(providerRestart.options.reviveTerminalState.replayEvent.events[0].data, 'codex output before rotation');
    assert.strictEqual(shellRestart.command, 'bash');
    assert.strictEqual(shellRestart.options.reviveTerminalState.replayEvent.events[0].data, 'shell output before rotation');
    assert.strictEqual(serializedRotationManager.agents.has(hiddenRecord.runtimeAgentId), false);
    assert.strictEqual(serializedRotationManager.agents.has(appServerRecord.runtimeAgentId), true);
    assert.strictEqual(
      serializedRotationManager.agents.get(appServerRecord.runtimeAgentId).runtimeBinding.kind,
      'acp',
      'legacy App Server records should migrate to ACP instead of reviving a PTY or App Server process'
    );
  } finally {
    await serializedRotationManager.dispose({ preserveTerminalHost: true });
  }

  const persistedRuntimeAgentIds = [];
  const rollbackManager = new AgentManager({
    ...configManager(),
    ensureAgentSessionRecord(agent) {
      persistedRuntimeAgentIds.push(agent.id);
      return agent.persistentSessionId || 'fsess_restart_rollback';
    },
  });
  rollbackManager.engineBridge = {
    resolve() {
      return {
        engineName: 'native',
        engine: {
          async createSession() {
            throw new Error('simulated replacement host launch failure');
          },
        },
        spec: { category: 'shell' },
      };
    },
    dispose() {},
  };
  try {
    const restartedAgentId = await rollbackManager.startAgent(
      'bash',
      process.cwd(),
      null,
      {
        wantsMain: false,
        dangerouslySkipPermissions: false,
        persistentSessionId: 'fsess_restart_rollback',
        restoreRuntimeAgentIdOnFailure: 'agent-before-failed-restart',
      }
    );
    assert.strictEqual(restartedAgentId, null);
    assert.strictEqual(persistedRuntimeAgentIds.length, 2);
    assert.match(persistedRuntimeAgentIds[0], /^agent-/);
    assert.strictEqual(
      persistedRuntimeAgentIds[1],
      'agent-before-failed-restart',
      'a failed replacement launch must restore the persisted record to its previous runtime Agent id'
    );
  } finally {
    await rollbackManager.dispose({ preserveTerminalHost: true });
  }

  fs.rmSync(testConfigDir, { recursive: true, force: true });
  console.log('✓ Agent manager restores the Main Agent shell and kills unrecovered scratch shells');
}

run().catch(error => {
  console.error(error);
  process.exit(1);
});
