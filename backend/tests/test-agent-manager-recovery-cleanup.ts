const assert = require('assert');
const crypto = require('crypto');
const EventEmitter = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sessionEngineBridgePath = require.resolve('../session-engine-bridge.cjs');

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
  exports: { SessionEngineBridge: FakeSessionEngineBridge },
} as NodeModule;

const { AgentManager } = require('../agent-manager.cjs');
const { serializeTerminalState } = require('../terminal-state-serialization.cjs');

function composerCommand(requestId, message, state = 'accepted') {
  const contentHash = crypto.createHash('sha256')
    .update(JSON.stringify({
      delivery: 'auto',
      prompt: [{ text: message, type: 'text' }],
    }))
    .digest('hex');
  return {
    requestId,
    contentHash,
    state,
    result: state === 'accepted' ? { kind: 'terminal' } : null,
    error: state === 'unknown' ? 'delivery outcome is unknown' : '',
    createdAt: 100,
    updatedAt: 200,
  };
}

const recoveredAcceptedCommand = composerCommand(
  'recovered-terminal-accepted',
  'do not replay after backend recovery',
);
const recoveredUnknownCommand = composerCommand(
  'recovered-terminal-unknown',
  'do not replay an uncertain backend recovery',
  'unknown',
);
const rotationAcceptedCommand = composerCommand(
  'rotated-terminal-accepted',
  'do not replay after runtime rotation',
);

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
    getDangerouslySkipAgentPermissionsByDefault() {
      return false;
    },
    getVtBaseUrl() {
      return 'http://localhost:4020';
    },
    getTaskHistory() {
      return [];
    },
    getMainPageSessionKeys() {
      return [
        'agent-session:codex:11111111-1111-4111-8111-111111111111',
        'agent-session:codex:44444444-4444-4444-8444-444444444444',
      ];
    },
    listAgentSessionRecords() {
      return [
        {
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
          customTitle: 'Persisted Agent name',
          terminalInputReceived: true,
          composerCommands: [recoveredAcceptedCommand, recoveredUnknownCommand],
          agentRuntimeMode: 'terminal',
          pinned: true,
          projectOrder: 4096,
          pinnedOrder: 2048,
        },
        {
          runtimeAgentId: 'recovered-cleared-title',
          source: 'ui',
          projectWorkspace: '/repo',
          provider: 'codex',
          providerHomeId: 'default',
          providerSessionId: '44444444-4444-4444-8444-444444444444',
          providerSessionKey: 'agent-session:codex:44444444-4444-4444-8444-444444444444',
          customTitle: '',
          agentRuntimeMode: 'terminal',
        },
        {
          id: 'fsess_recovered_temporary_codex',
          runtimeAgentId: 'recovered-temporary-codex',
          command: 'codex',
          source: 'ui',
          cwd: '/repo',
          projectWorkspace: '/repo',
          provider: 'codex',
          providerHomeId: 'default',
          providerHomePath: '/home/test/.codex',
          providerSessionId: 'tmp_uuid_recovered-temporary-codex',
          providerSessionKey: '',
          providerSessionTemporary: true,
          providerSessionSource: 'codex-temporary',
          visibleOnMainPage: true,
          archived: false,
          pinned: true,
          customTitle: 'Temporary recovery',
          terminalInputReceived: true,
          agentRuntimeMode: 'terminal',
        },
      ];
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
            customTitle: 'Stale runtime name',
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
          agentId: 'recovered-cleared-title',
          metadata: {
            agentId: 'recovered-cleared-title',
            command: 'codex',
            cwd: '/repo',
            category: 'coding',
            source: 'ui',
            customTitle: 'Stale title that must stay cleared',
          },
          state: { status: 'running', startedAt: 2100 },
        },
        {
          engineName: 'native',
          agentId: 'recovered-temporary-codex',
          metadata: {
            agentId: 'recovered-temporary-codex',
            command: 'codex',
            cwd: '/repo',
            category: 'coding',
            source: 'ui',
            providerSessionProvider: 'codex',
            providerSessionId: 'tmp_uuid_recovered-temporary-codex',
            providerSessionKey: 'agent-session:codex:tmp_uuid_recovered-temporary-codex',
            providerSessionTemporary: true,
          },
          state: { status: 'running', startedAt: 2200 },
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
    assert.strictEqual(manager.agents.get('recovered-codex').customTitle, 'Persisted Agent name');
    assert.strictEqual(
      manager.agents.get('recovered-cleared-title').customTitle,
      '',
      'an explicitly cleared persisted title must override stale native-host metadata',
    );
    assert.strictEqual(manager.agents.get('recovered-codex').terminalInputReceived, true);
    assert.deepStrictEqual(
      manager.agents.get('recovered-codex').composerCommands,
      [recoveredAcceptedCommand, recoveredUnknownCommand],
      'backend recovery must project the persisted Terminal Composer idempotency ledger over stale host metadata',
    );
    let recoveredTerminalWrites = 0;
    manager.engineBridge.getEngine = () => ({
      async sendInput() {
        recoveredTerminalWrites += 1;
        return { sent: true };
      },
    });
    const recoveredDuplicate = await manager.sendPersistentComposerMessage(
      'recovered-codex',
      'do not replay after backend recovery',
      'recovered-terminal-accepted',
    );
    assert.strictEqual(recoveredDuplicate.deduplicated, true);
    await assert.rejects(
      () => manager.sendPersistentComposerMessage(
        'recovered-codex',
        'do not replay an uncertain backend recovery',
        'recovered-terminal-unknown',
      ),
      error => error?.uncertain === true,
    );
    assert.strictEqual(
      recoveredTerminalWrites,
      0,
      'accepted and unknown Composer requests recovered with a live PTY must perform zero duplicate writes',
    );
    assert(manager.agents.has('recovered-temporary-codex'), 'visible temporary Codex sessions should survive server recovery');
    assert.strictEqual(manager.agents.get('recovered-temporary-codex').providerSessionTemporary, true);
    assert.strictEqual(manager.agents.get('recovered-temporary-codex').persistentSessionId, 'fsess_recovered_temporary_codex');
    assert.strictEqual(manager.agents.get('recovered-temporary-codex').customTitle, 'Temporary recovery');
    assert.strictEqual(manager.agents.get('recovered-temporary-codex').pinned, true);
    assert.strictEqual(manager.agents.get('recovered-temporary-codex').terminalInputReceived, true);
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
    attentionOutputEpoch: 'runtime-before-upgrade',
    attentionOutputSeq: 42,
    readOutputEpoch: 'runtime-before-upgrade',
    readOutputSeq: 42,
    composerCommands: [rotationAcceptedCommand],
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
  const rotationManager = new AgentManager({
    ...configManager(),
    farmingDir: testConfigDir,
    getMainPageSessionKeys() {
      return [providerSessionKey];
    },
    listAgentSessionRecords() {
      return [duplicateRecord, rotationRecord, hiddenRecord];
    },
  }, { skipExecutablePreflight: true });
  await rotationManager.recoveryGate.wait();
  const rotationBridge = rotationManager.engineBridge;
  const createdRotationSessions = [];
  let rotatedTerminalWrites = 0;
  const rotationEngine = {
    on() {},
    async createSession(options) {
      createdRotationSessions.push(options);
      const runtimeEpoch = 'runtime-after-upgrade';
      rotationBridge.emit('session-started', {
        engineName: 'native',
        sessionId: options.agentId,
        status: 'running',
        startedAt: 300,
        runtimeEpoch,
        outputSeq: 0,
        stateRevision: 1,
      });
      rotationBridge.emit('session-output', {
        engineName: 'native',
        sessionId: options.agentId,
        data: '\u001b[?25hCodex restored after runtime rotation',
        runtimeEpoch,
        outputSeq: 1,
        stateRevision: 2,
      });
      return { created: true };
    },
    async sendInput() {
      rotatedTerminalWrites += 1;
      return { sent: true };
    },
    async killSession() {
      return { killed: true };
    },
    async getSessionState() {
      return null;
    },
    async getSessionPreview() {
      return '';
    },
    getSessionSource() {
      return 'buffer';
    },
    dispose() {},
  };
  rotationBridge.recoverSessions = async () => [];
  rotationBridge.consumeRuntimeRotations = () => [{
    engineName: 'native',
    previous: null,
    current: { protocolVersion: 2, buildId: 'a'.repeat(64), version: '2.2.9' },
  }];
  rotationBridge.resolve = () => ({
    engineName: 'native',
    engine: rotationEngine,
    spec: { category: 'coding' },
  });
  rotationBridge.getEngine = () => rotationEngine;
  const previousFarmingCodexBin = process.env.FARMING_CODEX_BIN;
  try {
    process.env.FARMING_CODEX_BIN = process.execPath;
    try {
      await rotationManager.recoverEngineSessions();
    } finally {
      if (previousFarmingCodexBin === undefined) delete process.env.FARMING_CODEX_BIN;
      else process.env.FARMING_CODEX_BIN = previousFarmingCodexBin;
    }
    assert.strictEqual(
      createdRotationSessions.length,
      1,
      'only the newest authoritative main-page Terminal record should restart; duplicates and migrated ACP records must not'
    );
    assert.strictEqual(
      createdRotationSessions[0].agentId,
      rotationRecord.runtimeAgentId,
      'runtime rotation must retain the stable Runtime Agent id through real startAgent initialization',
    );
    assert.strictEqual(createdRotationSessions[0].reviveState, null);
    const replacement = rotationManager.agents.get(rotationRecord.runtimeAgentId);
    assert(replacement, 'real startAgent must install the replacement under the persisted Runtime Agent id');
    assert.strictEqual(replacement.customTitle, 'Pinned recovery');
    assert.strictEqual(replacement.pinned, true);
    assert.strictEqual(replacement.terminalInputReceived, true);
    assert.strictEqual(replacement.unread, true);
    assert.strictEqual(replacement.attentionOutputEpoch, 'runtime-before-upgrade');
    assert.strictEqual(replacement.attentionOutputSeq, 42);
    assert.strictEqual(replacement.readOutputEpoch, 'runtime-before-upgrade');
    assert.strictEqual(replacement.readOutputSeq, 42);
    assert.deepStrictEqual(
      replacement.composerCommands,
      [rotationAcceptedCommand],
      'the real replacement agentRecord must retain the normalized Composer idempotency ledger',
    );
    const rotatedDuplicate = await rotationManager.sendPersistentComposerMessage(
      rotationRecord.runtimeAgentId,
      'do not replay after runtime rotation',
      'rotated-terminal-accepted',
    );
    assert.strictEqual(rotatedDuplicate.deduplicated, true);
    assert.strictEqual(
      rotatedTerminalWrites,
      0,
      'an accepted Composer request must remain deduplicated after native PTY runtime rotation',
    );
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
    visibleOnMainPage: true,
    archived: false,
    updatedAt: 30,
  };
  const temporaryCodexRotationRecord = {
    id: 'fsess_temporary_codex_rotation',
    runtimeAgentId: 'agent-temporary-codex-before-upgrade',
    command: 'codex',
    forkCommand: 'codex',
    cwd: process.cwd(),
    projectWorkspace: process.cwd(),
    category: 'coding',
    source: 'codex-temporary',
    provider: 'codex',
    providerSessionProvider: 'codex',
    providerSessionId: 'tmp_uuid_rotation-recovery-guard',
    providerSessionTemporary: true,
    providerHomeId: 'default',
    terminalInputReceived: true,
    agentRuntimeMode: 'terminal',
    visibleOnMainPage: true,
    archived: false,
    updatedAt: 31,
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
    {
      id: temporaryCodexRotationRecord.runtimeAgentId,
      metadata: temporaryCodexRotationRecord,
      processDetails: { cwd: temporaryCodexRotationRecord.cwd, title: 'Codex' },
      processLaunchConfig: { command: 'codex', args: [], category: 'coding' },
      replayEvent: { events: [{ data: 'temporary Codex output before rotation', cols: 100, rows: 32 }] },
      timestamp: 102,
    },
  ]);
  const serializedRotationManager = new AgentManager({
    ...configManager(),
    farmingDir: testConfigDir,
    getMainPageSessionKeys() {
      return [providerSessionKey];
    },
    listAgentSessionRecords() {
      return [
        rotationRecord,
        shellRotationRecord,
        temporaryCodexRotationRecord,
        hiddenRecord,
      ];
    },
  });
  await serializedRotationManager.recoveryGate.wait();
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
    assert.strictEqual(
      serializedRotationManager.agents.has(temporaryCodexRotationRecord.runtimeAgentId),
      false,
      'a temporary Codex Terminal with user input must never be replaced by a fresh process after rotation'
    );
  } finally {
    await serializedRotationManager.dispose({ preserveTerminalHost: true });
  }

  const persistedRuntimeAgentIds: string[] = [];
  const rollbackManager = new AgentManager({
    ...configManager(),
    ensureAgentSessionRecord(
      agent: { id: string; persistentSessionId?: string },
      patch: { runtimeAgentId?: string } = {},
    ) {
      persistedRuntimeAgentIds.push(
        typeof patch.runtimeAgentId === 'string' ? patch.runtimeAgentId : agent.id,
      );
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
          async killSession() {},
          async getSessionState() {
            return null;
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
    assert(
      persistedRuntimeAgentIds.length >= 2,
      'replacement recovery must persist Create intent before launch and then persist rollback',
    );
    assert.strictEqual(
      persistedRuntimeAgentIds[0] === 'agent-before-failed-restart',
      false,
      'the durable Create intent must identify the attempted replacement runtime',
    );
    assert.strictEqual(
      persistedRuntimeAgentIds.at(-1),
      'agent-before-failed-restart',
      'a failed replacement launch must retain the previous runtime Agent id'
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
