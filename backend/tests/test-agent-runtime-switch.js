const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const AgentManager = require('../agent-manager');

(async () => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-runtime-switch-'));
  const sessionsDir = path.join(codexHome, 'sessions', '2026', '07', '12');
  fs.mkdirSync(sessionsDir, { recursive: true });
  const manager = new AgentManager({
    getHeartbeatInterval: () => 60_000,
    getTaskHistory: () => [],
  });
  const sessionId = '019f5577-59c5-7572-bb21-56b487be14d4';
  fs.writeFileSync(path.join(sessionsDir, `rollout-${sessionId}.jsonl`), `${JSON.stringify({
    timestamp: '2026-07-12T08:00:00.000Z',
    type: 'session_meta',
    payload: { id: sessionId, cwd: '/repo/project', source: 'cli' },
  })}\n`);
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
  manager.killAgent = async agentId => {
    killed = agentId;
    manager.agents.delete(agentId);
  };
  manager.ensurePersistentAgentSession = () => 'fsess_test';
  manager.startAgent = async (command, cwd, callback, options) => {
    started = { command, cwd, options };
    manager.agents.set('agent-new', { id: 'agent-new', ...options, status: 'running' });
    callback('agent-new');
    return 'agent-new';
  };

  const result = await manager.restartAgentRuntimeMode('agent-old', 'json');
  assert.strictEqual(killed, 'agent-old');
  assert.strictEqual(started.command.includes('codex resume'), true);
  assert.strictEqual(started.command.includes(sessionId), true);
  assert.strictEqual(started.options.agentRuntimeMode, 'json');
  assert.strictEqual(started.options.source.includes(sessionId), true);
  assert.strictEqual(started.options.source.includes(`home:zwz:${sessionId}`), true);
  assert.strictEqual(started.options.providerHomeId, 'zwz');
  assert.strictEqual(started.options.providerHomePath, codexHome);
  assert.deepStrictEqual(started.options.jsonCliEvents, [{ type: 'turn.started', turn_id: 'turn-old' }]);
  assert.strictEqual(result.restartedAgentId, 'agent-new');
  assert.strictEqual(result.agentRuntimeMode, 'json');

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
    agentRuntimeMode: 'terminal',
    status: 'running',
    output: '',
  });
  killed = '';
  started = null;
  const acpResult = await manager.restartAgentRuntimeMode('agent-acp-switch', 'acp');
  assert.strictEqual(killed, 'agent-acp-switch');
  assert.strictEqual(started.options.agentRuntimeMode, 'acp');
  assert.strictEqual(acpResult.agentRuntimeMode, 'acp');

  manager.agents.set('agent-app-server-switch', {
    id: 'agent-app-server-switch',
    command: 'codex',
    forkCommand: 'codex',
    cwd: '/tmp/project',
    projectWorkspace: '/tmp/project',
    providerSessionProvider: 'codex',
    providerSessionId: sessionId,
    providerSessionTemporary: false,
    providerHomeId: 'zwz',
    providerHomePath: codexHome,
    providerSessionTitle: 'App Server demo',
    codexRuntimeMode: 'app-server',
    agentRuntimeMode: 'terminal',
    status: 'running',
    output: '',
  });
  killed = '';
  started = null;
  const appServerTerminalResult = await manager.restartAgentRuntimeMode('agent-app-server-switch', 'terminal');
  assert.strictEqual(killed, 'agent-app-server-switch');
  assert.strictEqual(started.options.codexRuntimeMode, 'cli');
  assert.strictEqual(started.options.agentRuntimeMode, 'terminal');
  assert.strictEqual(appServerTerminalResult.agentRuntimeMode, 'terminal');

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
  const qoderAcpResult = await manager.restartAgentRuntimeMode('agent-qoder-switch', 'acp');
  assert.strictEqual(killed, 'agent-qoder-switch');
  assert.strictEqual(started.command.includes('qodercli --resume'), true);
  assert.strictEqual(started.options.agentRuntimeMode, 'acp');
  assert.strictEqual(qoderAcpResult.agentRuntimeMode, 'acp');

  manager.agents.set('agent-stale', {
    id: 'agent-stale',
    cwd: '/tmp/project',
    projectWorkspace: '/tmp/project',
    providerSessionProvider: 'codex',
    providerSessionId: '019f5577-59c5-7572-bb21-56b487be14d5',
    providerSessionTemporary: false,
    providerHomeId: 'zwz',
    providerHomePath: '/tmp/codex-home-zwz',
    agentRuntimeMode: 'json',
  });
  manager.findRuntimeSwitchSession = async () => null;
  killed = '';
  started = null;
  const staleResult = await manager.restartAgentRuntimeMode('agent-stale', 'terminal');
  assert.strictEqual(staleResult.error, 'The saved Agent session is no longer available in the selected Agent Home.');
  assert.strictEqual(killed, '');
  assert.strictEqual(started, null);
  assert.strictEqual(manager.agents.has('agent-stale'), true);

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
    agentRuntimeMode: 'terminal',
    codexRuntimeMode: 'cli',
    terminalBusy: false,
    status: 'running',
    output: '',
  });
  let rollbackStarts = 0;
  manager.startAgent = async (command, cwd, callback, options) => {
    rollbackStarts += 1;
    if (rollbackStarts === 1) {
      callback(null, 'ACP adapter failed');
      return null;
    }
    manager.agents.set('agent-restored', { id: 'agent-restored', ...options, status: 'running' });
    callback('agent-restored');
    return 'agent-restored';
  };
  const rollbackResult = await manager.restartAgentRuntimeMode('agent-rollback', 'acp');
  assert.strictEqual(rollbackStarts, 2);
  assert.strictEqual(rollbackResult.switchFailed, true);
  assert.strictEqual(rollbackResult.restartedAgentId, 'agent-restored');
  assert.strictEqual(rollbackResult.agentRuntimeMode, 'terminal');
  assert.match(rollbackResult.warning, /Original runtime restored/);
  assert.strictEqual(manager.agents.get('agent-restored').agentRuntimeMode, 'terminal');
  await manager.dispose();
  fs.rmSync(codexHome, { recursive: true, force: true });
  console.log('agent runtime switch tests passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
