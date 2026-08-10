const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { AgentManager } = require('../agent-manager.cjs');

interface ComposerCommandProbe {
  requestId?: string;
  state?: 'intent' | 'accepted' | 'unknown' | 'failed';
}

interface StaleComposerAgentRecord {
  id: string;
  command: string;
  forkCommand: string;
  cwd: string;
  projectWorkspace: string;
  providerSessionProvider: string;
  providerSessionId: string;
  providerSessionTemporary: boolean;
  providerHomeId: string;
  providerHomePath: string;
  runtimeBinding: { kind: string; state: string };
  status: string;
  composerCommands?: ComposerCommandProbe[];
}

interface ComposerTerminalInputOptions {
  expectedRuntimeEpoch?: string;
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, reject, resolve };
}

(async () => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-runtime-switch-'));
  const sessionsDir = path.join(codexHome, 'sessions', '2026', '07', '12');
  fs.mkdirSync(sessionsDir, { recursive: true });
  const manager = new AgentManager({
    getHeartbeatInterval: () => 60_000,
    getTaskHistory: () => [],
  });
  const sessionId = '019f5577-59c5-7572-bb21-56b487be14d4';
  fs.writeFileSync(path.join(sessionsDir, `rollout-${sessionId}.jsonl`), [
    JSON.stringify({
      timestamp: '2026-07-12T08:00:00.000Z',
      type: 'session_meta',
      payload: { id: sessionId, cwd: '/repo/project', source: 'cli' },
    }),
    JSON.stringify({
      timestamp: '2026-07-12T08:01:00.000Z',
      type: 'turn_context',
      payload: { turn_id: 'turn-1', cwd: '/repo/project', model: 'gpt-5.6-sol', effort: 'xhigh' },
    }),
    '',
  ].join('\n'));
  manager.agents.set('agent-old', {
    id: 'agent-old',
    command: 'codex',
    forkCommand: 'codex',
    cwd: '/tmp/project',
    projectWorkspace: '/tmp/project',
    providerSessionProvider: 'codex',
    providerSessionId: sessionId,
    providerSessionTemporary: false,
    providerHomeId: 'zwz',
    providerHomePath: codexHome,
    providerSessionTitle: 'JSON demo',
    agentRuntimeMode: 'terminal',
    launchPermissionMode: 'approve',
    projectOrder: 1,
    pinnedOrder: 2,
    pinned: true,
    unread: false,
    status: 'running',
    output: '',
    jsonCliEvents: [{ type: 'turn.started', turn_id: 'turn-old' }],
  });
  let killed = '';
  let started = null;
  let terminalComposerWrites = 0;
  manager.killAgent = async agentId => {
    killed = agentId;
    manager.agents.delete(agentId);
  };
  manager.ensurePersistentAgentSession = () => 'fsess_test';
  manager.engineBridge.getEngine = () => ({
    async sendInput() {
      terminalComposerWrites += 1;
      return { sent: true };
    },
  });
  manager.startAgent = async (command, cwd, callback, options) => {
    started = { command, cwd, options };
    manager.agents.set('agent-new', {
      id: 'agent-new',
      ...options,
      runtimeEpoch: 'runtime-new',
      status: 'running',
    });
    callback('agent-new');
    return 'agent-new';
  };

  const result = await manager.restartAgentRuntimeMode('agent-old', 'json');
  assert.strictEqual(result.error, 'Unsupported Agent runtime mode');
  assert.strictEqual(killed, '');
  assert.strictEqual(started, null);

  manager.agents.set('agent-acp-switch', {
    id: 'agent-acp-switch',
    command: 'codex',
    forkCommand: 'codex',
    cwd: '/tmp/project',
    projectWorkspace: '/tmp/project',
    providerSessionProvider: 'codex',
    providerSessionId: sessionId,
    providerSessionTemporary: false,
    providerHomeId: 'zwz',
    providerHomePath: codexHome,
    providerSessionTitle: 'ACP demo',
    agentRecordId: 'agent_record_acp_switch',
    persistentSessionId: 'agent_record_acp_switch',
    agentRuntimeMode: 'terminal',
    runtimeEpoch: 'runtime-acp-switch',
    status: 'running',
    output: '',
  });
  const crossRuntimeAdmission = await manager.sendPersistentComposerMessage(
    'agent-acp-switch',
    'retain this command across Chat and Terminal',
    'runtime-switch-composer-ledger',
  );
  assert.strictEqual(crossRuntimeAdmission.accepted, true);
  assert.strictEqual(terminalComposerWrites, 1);
  const crossRuntimeComposerCommands = JSON.parse(JSON.stringify(
    manager.agents.get('agent-acp-switch').composerCommands,
  ));
  killed = '';
  started = null;
  const blockedAcpResult = await manager.restartAgentRuntimeMode('agent-acp-switch', 'chat');
  assert.match(blockedAcpResult.error, /delivery finished while the runtime switch was waiting/);
  assert.strictEqual(killed, '');
  const acpResult = await manager.restartAgentRuntimeMode('agent-acp-switch', 'chat');
  assert.strictEqual(killed, 'agent-acp-switch');
  assert.strictEqual(started.options.agentRuntimeMode, 'chat');
  assert.strictEqual(started.options.agentRecordId, 'agent_record_acp_switch');
  assert.strictEqual(started.options.restoreRuntimeAgentIdOnFailure, 'agent-acp-switch');
  assert.deepStrictEqual(started.options.composerCommands, crossRuntimeComposerCommands);
  assert.deepStrictEqual(manager.agents.get('agent-new').composerCommands, crossRuntimeComposerCommands);
  assert.strictEqual(acpResult.agentRuntimeMode, 'chat');

  manager.agents.set('agent-live-acp-switch', {
    id: 'agent-live-acp-switch',
    command: 'codex',
    forkCommand: 'codex',
    cwd: '/tmp/project',
    projectWorkspace: '/tmp/project',
    providerSessionProvider: 'codex',
    providerSessionId: sessionId,
    providerSessionKey: `agent-session:codex:home:zwz:${sessionId}`,
    providerSessionTemporary: false,
    providerHomeId: 'zwz',
    providerHomePath: codexHome,
    providerSessionTitle: 'Fresh ACP demo',
    agentRecordId: 'agent_record_live_acp_switch',
    persistentSessionId: 'agent_record_live_acp_switch',
    agentRuntimeMode: 'acp',
    acpState: 'idle',
    status: 'running',
    output: '',
  });
  manager.acpSessionOptionsStore.set(`agent-session:codex:home:zwz:${sessionId}`, {
    additionalDirectories: [],
    configOverrides: [{ configId: 'fast-mode', value: true }],
    mcpServers: [],
  });
  const originalGetAcpSession = manager.acpRuntime.getSession.bind(manager.acpRuntime);
  const originalHasAcpBinding = manager.acpRuntime.hasBinding.bind(manager.acpRuntime);
  const originalReconnectAcpAgent = manager.acpRuntime.reconnectAgent.bind(manager.acpRuntime);
  const originalSubmitAcpMessage = manager.acpRuntime.submitMessage.bind(manager.acpRuntime);
  const originalFindRuntimeSwitchSession = manager.findRuntimeSwitchSession.bind(manager);
  manager.acpRuntime.getSession = () => ({ sessionId, state: 'idle' });
  manager.acpRuntime.hasBinding = agentId => agentId === 'agent-live-acp-switch';
  manager.acpRuntime.reconnectAgent = async () => ({ reconnected: false });
  let acpComposerSubmissions = 0;
  manager.acpRuntime.submitMessage = async (agentId, prompt, options) => {
    assert.strictEqual(agentId, 'agent-live-acp-switch');
    assert.deepStrictEqual(prompt, [{
      type: 'text',
      text: 'accept this command through Chat before switching to Terminal',
    }]);
    acpComposerSubmissions += 1;
    options.onSubmitted();
    return { stopReason: 'end_turn' };
  };
  manager.findRuntimeSwitchSession = async () => null;
  const liveAcpAdmission = await manager.sendPersistentComposerMessage(
    'agent-live-acp-switch',
    'accept this command through Chat before switching to Terminal',
    'chat-to-terminal-composer-ledger',
    { delivery: 'prompt' },
  );
  assert.strictEqual(liveAcpAdmission.accepted, true);
  assert.strictEqual(liveAcpAdmission.kind, 'acp');
  assert.strictEqual(acpComposerSubmissions, 1);
  const liveAcpComposerCommands = JSON.parse(JSON.stringify(
    manager.agents.get('agent-live-acp-switch').composerCommands,
  ));
  killed = '';
  started = null;
  const blockedLiveAcpResult = await manager.restartAgentRuntimeMode('agent-live-acp-switch', 'terminal');
  assert.match(blockedLiveAcpResult.error, /delivery finished while the runtime switch was waiting/);
  assert.strictEqual(killed, '');
  const liveAcpResult = await manager.restartAgentRuntimeMode('agent-live-acp-switch', 'terminal');
  assert.strictEqual(killed, 'agent-live-acp-switch');
  assert.strictEqual(started.options.agentRuntimeMode, 'terminal');
  assert.strictEqual(started.options.agentRecordId, 'agent_record_live_acp_switch');
  assert.strictEqual(started.options.restoreRuntimeAgentIdOnFailure, 'agent-live-acp-switch');
  assert.deepStrictEqual(started.options.acpConfigOverrides, [
    { configId: 'fast-mode', value: true },
  ]);
  assert.deepStrictEqual(started.options.composerCommands, liveAcpComposerCommands);
  assert.deepStrictEqual(manager.agents.get('agent-new').composerCommands, liveAcpComposerCommands);
  assert.strictEqual(liveAcpResult.agentRuntimeMode, 'terminal');
  const writesBeforeTerminalRetry = terminalComposerWrites;
  const terminalRetry = await manager.sendPersistentComposerMessage(
    'agent-new',
    'accept this command through Chat before switching to Terminal',
    'chat-to-terminal-composer-ledger',
    { delivery: 'prompt' },
  );
  assert.strictEqual(terminalRetry.deduplicated, true);
  assert.strictEqual(
    terminalComposerWrites,
    writesBeforeTerminalRetry,
    'Chat to Terminal switch must not replay an accepted Composer request',
  );
  manager.acpRuntime.getSession = originalGetAcpSession;
  manager.acpRuntime.hasBinding = originalHasAcpBinding;
  manager.acpRuntime.reconnectAgent = originalReconnectAcpAgent;
  manager.acpRuntime.submitMessage = originalSubmitAcpMessage;
  manager.findRuntimeSwitchSession = originalFindRuntimeSwitchSession;

  const permissionSessionKey = `agent-session:codex:home:zwz:${sessionId}`;
  manager.agents.set('agent-permission-config', {
    id: 'agent-permission-config',
    command: 'codex',
    forkCommand: 'codex',
    cwd: '/tmp/project',
    projectWorkspace: '/tmp/project',
    providerSessionProvider: 'codex',
    providerSessionId: sessionId,
    providerSessionKey: permissionSessionKey,
    providerSessionTemporary: false,
    providerHomeId: 'zwz',
    providerHomePath: codexHome,
    agentRuntimeMode: 'acp',
    acpState: 'idle',
    launchPermissionMode: 'approve',
    status: 'running',
    output: '',
  });
  manager.acpSessionOptionsStore.set(permissionSessionKey, {
    additionalDirectories: [],
    configOverrides: [
      { configId: 'model', value: 'gpt-5.6-luna' },
      { configId: 'reasoning', value: 'low' },
      { configId: 'fast-mode', value: true },
    ],
    mcpServers: [],
  });
  killed = '';
  started = null;
  const permissionRestart = await manager.performAgentPermissionRestart(
    'agent-permission-config',
    'full',
    Symbol('permission-config-test'),
  );
  assert.strictEqual(killed, 'agent-permission-config');
  assert.strictEqual(started.options.codexApprovalMode, 'full');
  assert.deepStrictEqual(started.options.acpConfigOverrides, [
    { configId: 'model', value: 'gpt-5.6-luna' },
    { configId: 'reasoning', value: 'low' },
    { configId: 'fast-mode', value: true },
  ], 'permission restart must preserve the exact explicit config override set');
  assert.strictEqual(permissionRestart.launchPermissionMode, 'full');

  manager.agents.set('agent-qoder-switch', {
    id: 'agent-qoder-switch',
    command: 'qodercli',
    forkCommand: 'qodercli',
    cwd: '/tmp/project',
    projectWorkspace: '/tmp/project',
    providerSessionProvider: 'qoder',
    providerSessionId: 'c4fa82d7-cf26-4c62-9c35-00aabfcc032a',
    providerSessionTemporary: false,
    providerHomeId: 'default',
    providerHomePath: '/tmp/qoder-home',
    providerSessionTitle: 'Qoder ACP demo',
    agentRuntimeMode: 'terminal',
    status: 'running',
    output: '',
  });
  manager.findRuntimeSwitchSession = async () => ({ provider: 'qoder' });
  killed = '';
  started = null;
  const qoderAcpResult = await manager.restartAgentRuntimeMode('agent-qoder-switch', 'chat');
  assert.strictEqual(killed, 'agent-qoder-switch');
  assert.strictEqual(started.command.includes('qodercli --resume'), true);
  assert.strictEqual(started.options.agentRuntimeMode, 'chat');
  assert.strictEqual(qoderAcpResult.agentRuntimeMode, 'chat');

  manager.agents.set('agent-qwen-switch', {
    id: 'agent-qwen-switch',
    command: 'qwen',
    forkCommand: 'qwen',
    cwd: '/tmp/project',
    projectWorkspace: '/tmp/project',
    providerSessionProvider: 'qwen',
    providerSessionId: 'e6fa82d7-cf26-4c62-9c35-00aabfcc032c',
    providerSessionTemporary: false,
    providerHomeId: 'default',
    providerHomePath: '/tmp/qwen-home',
    providerSessionTitle: 'Qwen ACP demo',
    agentRuntimeMode: 'terminal',
    status: 'running',
    output: '',
  });
  manager.findRuntimeSwitchSession = async () => ({ provider: 'qwen' });
  killed = '';
  started = null;
  const qwenAcpResult = await manager.restartAgentRuntimeMode('agent-qwen-switch', 'chat');
  assert.strictEqual(killed, 'agent-qwen-switch');
  assert.strictEqual(started.command.includes('qwen --resume'), true);
  assert.strictEqual(started.options.agentRuntimeMode, 'chat');
  assert.strictEqual(qwenAcpResult.agentRuntimeMode, 'chat');

  manager.agents.set('agent-fresh-qoder-switch', {
    id: 'agent-fresh-qoder-switch',
    command: 'qodercli',
    forkCommand: 'qodercli',
    cwd: '/tmp/project',
    projectWorkspace: '/tmp/project',
    providerSessionProvider: 'qoder',
    providerSessionId: 'd5fa82d7-cf26-4c62-9c35-00aabfcc032b',
    providerSessionTemporary: false,
    providerSessionSource: 'qoder-session-id',
    providerHomeId: 'default',
    providerHomePath: '/tmp/qoder-home',
    agentRuntimeMode: 'terminal',
    terminalInputReceived: false,
    status: 'running',
    output: '',
  });
  manager.findRuntimeSwitchSession = async () => null;
  killed = '';
  started = null;
  const freshQoderAcpResult = await manager.restartAgentRuntimeMode('agent-fresh-qoder-switch', 'chat');
  assert.strictEqual(killed, 'agent-fresh-qoder-switch');
  assert.strictEqual(started.command, 'qodercli');
  assert.strictEqual(started.options.acpStartFresh, true);
  assert.strictEqual(started.options.source, 'ui-runtime-switch-fresh');
  assert.strictEqual(freshQoderAcpResult.agentRuntimeMode, 'chat');

  manager.agents.set('agent-fresh-codex-switch', {
    id: 'agent-fresh-codex-switch',
    command: 'codex',
    forkCommand: 'codex',
    cwd: '/tmp/project',
    projectWorkspace: '/tmp/project',
    providerSessionProvider: 'codex',
    providerSessionId: 'tmp_uuid_aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    providerSessionTemporary: true,
    providerSessionSource: 'codex-temporary',
    providerHomeId: 'default',
    providerHomePath: codexHome,
    agentRuntimeMode: 'terminal',
    terminalInputReceived: false,
    status: 'running',
    output: '',
  });
  killed = '';
  started = null;
  const freshCodexAcpResult = await manager.restartAgentRuntimeMode('agent-fresh-codex-switch', 'chat');
  assert.strictEqual(killed, 'agent-fresh-codex-switch');
  assert.strictEqual(started.command, 'codex');
  assert.strictEqual(started.options.acpStartFresh, true);
  assert.strictEqual(started.options.source, 'ui-runtime-switch-fresh');
  assert.strictEqual(freshCodexAcpResult.agentRuntimeMode, 'chat');

  manager.agents.set('agent-used-codex-temporary-switch', {
    id: 'agent-used-codex-temporary-switch',
    command: 'codex',
    forkCommand: 'codex',
    cwd: '/tmp/project',
    projectWorkspace: '/tmp/project',
    providerSessionProvider: 'codex',
    providerSessionId: 'tmp_uuid_bbbbbbbb-cccc-4ddd-8eee-ffffffffffff',
    providerSessionTemporary: true,
    providerSessionSource: 'codex-temporary',
    providerHomeId: 'default',
    providerHomePath: codexHome,
    agentRuntimeMode: 'terminal',
    terminalInputReceived: true,
    status: 'running',
    output: '',
  });
  killed = '';
  started = null;
  const usedTemporaryCodexResult = await manager.restartAgentRuntimeMode(
    'agent-used-codex-temporary-switch',
    'chat',
  );
  assert.match(usedTemporaryCodexResult.error, /requires a resumable provider session/);
  assert.strictEqual(killed, '');
  assert.strictEqual(started, null);

  manager.agents.set('agent-used-qoder-switch', {
    id: 'agent-used-qoder-switch',
    command: 'qodercli',
    forkCommand: 'qodercli',
    cwd: '/tmp/project',
    projectWorkspace: '/tmp/project',
    providerSessionProvider: 'qoder',
    providerSessionId: 'e6fa82d7-cf26-4c62-9c35-00aabfcc032c',
    providerSessionTemporary: false,
    providerSessionSource: 'qoder-session-id',
    providerHomeId: 'default',
    providerHomePath: '/tmp/qoder-home',
    agentRuntimeMode: 'terminal',
    terminalInputReceived: true,
    status: 'running',
    output: '',
  });
  killed = '';
  started = null;
  const usedQoderResult = await manager.restartAgentRuntimeMode('agent-used-qoder-switch', 'chat');
  assert.strictEqual(usedQoderResult.error, 'The saved Agent session is no longer available in the selected Agent Home.');
  assert.strictEqual(killed, '');
  assert.strictEqual(started, null);

  manager.agents.set('agent-active', {
    id: 'agent-active',
    cwd: '/tmp/project',
    projectWorkspace: '/tmp/project',
    providerSessionProvider: 'codex',
    providerSessionId: sessionId,
    providerHomeId: 'zwz',
    providerHomePath: codexHome,
    providerSessionTemporary: false,
    agentRuntimeMode: 'acp',
    acpState: 'working',
    status: 'running',
  });
  manager.findRuntimeSwitchSession = async () => ({ provider: 'codex' });
  const activeResult = await manager.restartAgentRuntimeMode('agent-active', 'terminal');
  assert.match(activeResult.error, /Interrupt the active Agent turn/);
  assert.strictEqual(manager.agents.has('agent-active'), true);

  manager.agents.set('agent-rollback', {
    id: 'agent-rollback',
    command: 'codex',
    forkCommand: 'codex',
    cwd: '/tmp/project',
    projectWorkspace: '/tmp/project',
    providerSessionProvider: 'codex',
    providerSessionId: sessionId,
    providerSessionTemporary: false,
    providerHomeId: 'zwz',
    providerHomePath: codexHome,
    agentRecordId: 'agent_record_runtime_rollback',
    persistentSessionId: 'agent_record_runtime_rollback',
    agentRuntimeMode: 'terminal',
    terminalBusy: false,
    runtimeEpoch: 'runtime-rollback',
    composerCommands: [],
    status: 'running',
    output: '',
  });
  const rollbackAdmission = await manager.sendPersistentComposerMessage(
    'agent-rollback',
    'retain this command when runtime switching rolls back',
    'runtime-switch-rollback-ledger',
  );
  assert.strictEqual(rollbackAdmission.accepted, true);
  const rollbackComposerCommands = JSON.parse(JSON.stringify(
    manager.agents.get('agent-rollback').composerCommands,
  ));
  const writesBeforeRollback = terminalComposerWrites;
  let rollbackStarts = 0;
  const rollbackStartOptions = [];
  manager.startAgent = async (command, cwd, callback, options) => {
    rollbackStarts += 1;
    rollbackStartOptions.push(options);
    if (rollbackStarts === 1) {
      callback(null, 'ACP adapter failed');
      return null;
    }
    manager.agents.set('agent-restored', {
      id: 'agent-restored',
      ...options,
      runtimeEpoch: 'runtime-restored',
      status: 'running',
    });
    callback('agent-restored');
    return 'agent-restored';
  };
  const blockedRollbackResult = await manager.restartAgentRuntimeMode('agent-rollback', 'chat');
  assert.match(blockedRollbackResult.error, /delivery finished while the runtime switch was waiting/);
  assert.strictEqual(rollbackStarts, 0);
  const rollbackResult = await manager.restartAgentRuntimeMode('agent-rollback', 'chat');
  assert.strictEqual(rollbackStarts, 2);
  assert.strictEqual(rollbackResult.switchFailed, true);
  assert.strictEqual(rollbackResult.restartedAgentId, 'agent-restored');
  assert.strictEqual(rollbackResult.agentRuntimeMode, 'terminal');
  assert.match(rollbackResult.warning, /Original runtime restored/);
  assert.deepStrictEqual(rollbackStartOptions[0].composerCommands, rollbackComposerCommands);
  assert.deepStrictEqual(rollbackStartOptions[1].composerCommands, rollbackComposerCommands);
  assert.strictEqual(rollbackStartOptions[0].agentRecordId, 'agent_record_runtime_rollback');
  assert.strictEqual(rollbackStartOptions[1].agentRecordId, 'agent_record_runtime_rollback');
  assert.strictEqual(rollbackStartOptions[0].restoreRuntimeAgentIdOnFailure, 'agent-rollback');
  assert.strictEqual(rollbackStartOptions[1].restoreRuntimeAgentIdOnFailure, 'agent-rollback');
  assert.deepStrictEqual(manager.agents.get('agent-restored').composerCommands, rollbackComposerCommands);
  assert.strictEqual(manager.agents.get('agent-restored').agentRecordId, 'agent_record_runtime_rollback');
  assert.strictEqual(manager.agents.get('agent-restored').runtimeBinding.kind, 'terminal');
  const rollbackRetry = await manager.sendPersistentComposerMessage(
    'agent-restored',
    'retain this command when runtime switching rolls back',
    'runtime-switch-rollback-ledger',
  );
  assert.strictEqual(rollbackRetry.deduplicated, true);
  assert.strictEqual(
    terminalComposerWrites,
    writesBeforeRollback,
    'runtime-switch rollback must not replay an already accepted Terminal Composer request',
  );

  manager.agents.set('agent-uncertain-switch', {
    id: 'agent-uncertain-switch',
    command: 'codex',
    forkCommand: 'codex',
    cwd: '/tmp/project',
    projectWorkspace: '/tmp/project',
    providerSessionProvider: 'codex',
    providerSessionId: sessionId,
    providerSessionTemporary: false,
    providerHomeId: 'zwz',
    providerHomePath: codexHome,
    agentRuntimeMode: 'terminal',
    terminalBusy: false,
    status: 'running',
    output: '',
  });
  manager.findRuntimeSwitchSession = async () => ({ provider: 'codex' });
  let uncertainStarts = 0;
  manager.startAgent = async (_command, _cwd, callback, options) => {
    uncertainStarts += 1;
    manager.agents.set('agent-uncertain-replacement', {
      id: 'agent-uncertain-replacement',
      ...options,
      status: 'error',
    });
    callback('agent-uncertain-replacement', 'replacement cleanup is uncertain');
    return null;
  };
  manager.killAgent = async agentId => {
    if (agentId === 'agent-uncertain-replacement') {
      return { agentId, error: 'cleanup proof unavailable' };
    }
    manager.agents.delete(agentId);
    return { agentId, killed: true };
  };
  const uncertainSwitch = await manager.restartAgentRuntimeMode('agent-uncertain-switch', 'chat');
  assert.strictEqual(uncertainStarts, 1, 'an uncertain replacement must block rollback start');
  assert.strictEqual(uncertainSwitch.cleanupUncertain, true);
  assert.strictEqual(uncertainSwitch.restartedAgentId, 'agent-uncertain-replacement');
  assert.match(uncertainSwitch.error, /cleanup could not be verified/i);
  assert.strictEqual(manager.agents.has('agent-uncertain-replacement'), true);

  await manager.dispose();

  const raceManager = new AgentManager({
    getHeartbeatInterval: () => 60_000,
    getTaskHistory: () => [],
  });
  raceManager.ensurePersistentAgentSession = () => 'race-record';
  raceManager.findRuntimeSwitchSession = async () => ({ provider: 'codex' });
  let raceKills = 0;
  let raceStarts = 0;
  let raceTerminalWrites = 0;
  raceManager.killAgent = async agentId => {
    raceKills += 1;
    raceManager.agents.delete(agentId);
    return { agentId, killed: true };
  };
  raceManager.startAgent = async (_command, _cwd, callback, options) => {
    raceStarts += 1;
    const replacementId = `race-replacement-${raceStarts}`;
    raceManager.agents.set(replacementId, {
      id: replacementId,
      ...options,
      runtimeEpoch: `replacement-epoch-${raceStarts}`,
      status: 'running',
    });
    callback(replacementId);
    return replacementId;
  };
  raceManager.engineBridge.getEngine = () => ({
    async sendInput() {
      raceTerminalWrites += 1;
      return { sent: true };
    },
  });

  raceManager.agents.set('switch-first', {
    id: 'switch-first',
    command: 'codex',
    forkCommand: 'codex',
    cwd: '/tmp/project',
    projectWorkspace: '/tmp/project',
    providerSessionProvider: 'codex',
    providerSessionId: sessionId,
    providerSessionTemporary: false,
    providerHomeId: 'zwz',
    providerHomePath: codexHome,
    agentRuntimeMode: 'terminal',
    runtimeEpoch: 'switch-first-epoch',
    status: 'running',
  });
  const switchFirst = raceManager.restartAgentRuntimeMode('switch-first', 'chat');
  await assert.rejects(
    () => raceManager.sendPersistentComposerMessage(
      'switch-first',
      'must not cross a runtime switch',
      'switch-first-request',
    ),
    /lifecycle change already in progress: runtime switch/,
  );
  assert.strictEqual(raceTerminalWrites, 0, 'switch-first Composer must not reach the old runtime');
  assert.strictEqual((await switchFirst).agentRuntimeMode, 'chat');

  let bindingEpoch = 'binding-1';
  raceManager.acpRuntime.bindingEpoch = () => bindingEpoch;
  raceManager.acpRuntime.hasBinding = () => true;
  raceManager.acpRuntime.getSession = () => ({ sessionId, state: 'idle' });
  const reconnectStarted = deferred();
  const reconnectRelease = deferred();
  raceManager.acpRuntime.reconnectAgent = async () => {
    reconnectStarted.resolve();
    await reconnectRelease.promise;
    return { reconnected: false };
  };
  const providerTurn = deferred();
  let raceAcpSubmissions = 0;
  raceManager.acpRuntime.submitMessage = async (_agentId, _prompt, options) => {
    raceAcpSubmissions += 1;
    options.onSubmitted?.();
    await providerTurn.promise;
    return { stopReason: 'end_turn' };
  };
  raceManager.agents.set('prompt-first', {
    id: 'prompt-first',
    command: 'codex',
    forkCommand: 'codex',
    cwd: '/tmp/project',
    projectWorkspace: '/tmp/project',
    providerSessionProvider: 'codex',
    providerSessionId: sessionId,
    providerSessionTemporary: false,
    providerHomeId: 'zwz',
    providerHomePath: codexHome,
    runtimeBinding: { kind: 'acp', state: 'idle' },
    status: 'running',
  });
  const promptFirst = raceManager.sendPersistentComposerMessage(
    'prompt-first',
    'finish this exact delivery before switching',
    'prompt-first-request',
  );
  await reconnectStarted.promise;
  const switchAfterPrompt = raceManager.restartAgentRuntimeMode('prompt-first', 'terminal');
  await assert.rejects(
    () => raceManager.sendPersistentComposerMessage(
      'prompt-first',
      'must be rejected behind the switch owner',
      'prompt-after-switch-request',
    ),
    /lifecycle change already in progress: runtime switch/,
  );
  await new Promise(resolve => setImmediate(resolve));
  assert.strictEqual(raceKills, 1, 'runtime switch must not kill while Composer reconnect is pending');
  reconnectRelease.resolve();
  const acceptedPrompt = await promptFirst;
  assert.strictEqual(acceptedPrompt.accepted, true);
  assert.strictEqual(raceAcpSubmissions, 1);
  let switchAfterPromptSettled = false;
  void switchAfterPrompt.finally(() => {
    switchAfterPromptSettled = true;
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.strictEqual(switchAfterPromptSettled, false, 'accepted callback must not release a pending delivery effect');
  assert.strictEqual(raceKills, 1, 'accepted callback must not allow destructive runtime replacement');
  providerTurn.resolve();
  const promptFirstSwitchResult = await switchAfterPrompt;
  assert.match(promptFirstSwitchResult.error, /delivery finished while the runtime switch was waiting/);
  assert.strictEqual(raceKills, 1, 'prompt-first switch must terminate without killing the admitted runtime');

  raceManager.acpRuntime.getTranscriptSessionForRead = async () => ({ sessionId, entries: [] });
  const rebindReconnectStarted = deferred();
  const rebindReconnectRelease = deferred();
  raceManager.acpRuntime.reconnectAgent = async () => {
    rebindReconnectStarted.resolve();
    await rebindReconnectRelease.promise;
    return { reconnected: true };
  };
  const hostRebindAgent = {
    id: 'host-rebind',
    command: 'codex',
    forkCommand: 'codex',
    cwd: '/tmp/project',
    projectWorkspace: '/tmp/project',
    providerSessionProvider: 'codex',
    providerSessionId: sessionId,
    providerSessionTemporary: false,
    providerHomeId: 'zwz',
    providerHomePath: codexHome,
    runtimeBinding: { kind: 'acp', state: 'idle' },
    status: 'running',
  };
  raceManager.agents.set('host-rebind', hostRebindAgent);
  const rebindAdmission = raceManager.sendPersistentComposerMessage(
    'host-rebind',
    'admit through a recovered Host binding',
    'host-rebind-request',
  );
  await rebindReconnectStarted.promise;
  bindingEpoch = 'binding-2';
  hostRebindAgent.runtimeBinding = { ...hostRebindAgent.runtimeBinding };
  rebindReconnectRelease.resolve();
  assert.strictEqual((await rebindAdmission).accepted, true);
  assert.strictEqual(raceAcpSubmissions, 2, 'Host recovery on the exact record must submit exactly once');
  assert.strictEqual(
    raceManager.agents.get('host-rebind').composerCommands.at(-1).state,
    'accepted',
    'a recovered Host binding on the exact record is not a cross-runtime ownership change',
  );

  const staleReconnectStarted = deferred();
  const staleReconnectRelease = deferred();
  raceManager.acpRuntime.reconnectAgent = async () => {
    staleReconnectStarted.resolve();
    await staleReconnectRelease.promise;
    return { reconnected: true };
  };
  const staleRecord: StaleComposerAgentRecord = {
    id: 'stale-record',
    command: 'codex',
    forkCommand: 'codex',
    cwd: '/tmp/project',
    projectWorkspace: '/tmp/project',
    providerSessionProvider: 'codex',
    providerSessionId: sessionId,
    providerSessionTemporary: false,
    providerHomeId: 'zwz',
    providerHomePath: codexHome,
    runtimeBinding: { kind: 'acp', state: 'idle' },
    status: 'running',
  };
  raceManager.agents.set('stale-record', staleRecord);
  const staleAdmission = raceManager.sendPersistentComposerMessage(
    'stale-record',
    'never submit through a replaced record',
    'stale-record-request',
  );
  await staleReconnectStarted.promise;
  raceManager.agents.set('stale-record', { ...staleRecord, composerCommands: [] });
  staleReconnectRelease.resolve();
  await assert.rejects(
    staleAdmission,
    error => error?.uncertain === true && /record was replaced/.test(error.message),
  );
  assert.strictEqual(raceAcpSubmissions, 2, 'a replaced Agent record must fail before provider submission');
  assert.strictEqual(
    staleRecord.composerCommands.at(-1).state,
    'intent',
    'stale ownership must not persist a terminal outcome through the old record',
  );

  const rotatedTerminalAgent = {
    id: 'terminal-epoch-rotation',
    command: 'codex',
    forkCommand: 'codex',
    cwd: '/tmp/project',
    projectWorkspace: '/tmp/project',
    providerSessionProvider: 'codex',
    providerSessionId: sessionId,
    providerSessionTemporary: false,
    providerHomeId: 'zwz',
    providerHomePath: codexHome,
    agentRuntimeMode: 'terminal',
    runtimeEpoch: 'terminal-epoch-1',
    status: 'running',
  };
  raceManager.agents.set('terminal-epoch-rotation', rotatedTerminalAgent);
  let terminalSessionEpoch = 'terminal-epoch-1';
  let rotatedTerminalWrites = 0;
  let gateRotatedTerminalInput = true;
  const rotatedInputStarted = deferred();
  const rotatedInputRelease = deferred();
  raceManager.engineBridge.getEngine = () => ({
    async sendInput(_agentId, _input, options: ComposerTerminalInputOptions = {}) {
      if (gateRotatedTerminalInput) {
        gateRotatedTerminalInput = false;
        rotatedInputStarted.resolve();
        await rotatedInputRelease.promise;
      }
      if (options.expectedRuntimeEpoch && options.expectedRuntimeEpoch !== terminalSessionEpoch) {
        return { status: 'input-rejected', reason: 'runtime-epoch-mismatch' };
      }
      rotatedTerminalWrites += 1;
      return { sent: true };
    },
  });
  const rotatedAdmission = raceManager.sendPersistentComposerMessage(
    'terminal-epoch-rotation',
    'never write through a rotated Terminal runtime',
    'terminal-epoch-rotation-request',
  );
  await rotatedInputStarted.promise;
  terminalSessionEpoch = 'terminal-epoch-2';
  rotatedTerminalAgent.runtimeEpoch = 'terminal-epoch-2';
  rotatedInputRelease.resolve();
  await assert.rejects(
    rotatedAdmission,
    error => error?.uncertain !== true && /epoch advanced before Composer input/.test(error.message),
  );
  assert.strictEqual(rotatedTerminalWrites, 0, 'a rotated Terminal runtime must reject before the PTY write');
  assert.strictEqual(
    raceManager.agents.get('terminal-epoch-rotation').composerCommands.at(-1).state,
    'failed',
    'a rejection proven before the PTY write is a definitive failure on the exact record',
  );
  const rotatedRetry = await raceManager.sendPersistentComposerMessage(
    'terminal-epoch-rotation',
    'never write through a rotated Terminal runtime',
    'terminal-epoch-rotation-request',
  );
  assert.strictEqual(rotatedRetry.accepted, true);
  assert.strictEqual(
    rotatedTerminalWrites,
    1,
    'the definitive retry must write exactly once through the new runtime epoch',
  );

  raceManager.agents.clear();
  await raceManager.dispose();
  fs.rmSync(codexHome, { recursive: true, force: true });
  console.log('agent runtime switch tests passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
