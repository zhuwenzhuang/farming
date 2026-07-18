const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const AgentManager = require('../agent-manager');

async function run() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-provider-session-'));
  const binDir = path.join(tmpRoot, 'bin');
  const workspace = path.join(tmpRoot, 'repo');
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  writeFakeExecutable(path.join(binDir, 'codex'), 'codex 9.9.9\n');
  writeFakeExecutable(path.join(binDir, 'claude'), 'claude 9.9.9\n');
  writeFakeExecutable(path.join(binDir, 'opencode'), 'opencode 9.9.9\n');
  writeFakeExecutable(path.join(binDir, 'qodercli'), 'qodercli 9.9.9\n');

  const previousPath = process.env.PATH;
  const previousCodexBin = process.env.FARMING_CODEX_BIN;
  const previousHome = process.env.HOME;
  process.env.PATH = `${binDir}${path.delimiter}${previousPath || ''}`;
  process.env.FARMING_CODEX_BIN = path.join(binDir, 'codex');
  process.env.HOME = tmpRoot;

  const providerHomes = {
    codex: [{ id: 'default', path: path.join(tmpRoot, '.codex') }, { id: 'work', path: path.join(tmpRoot, '.codex-work') }],
    claude: [{ id: 'default', path: path.join(tmpRoot, '.claude') }],
    opencode: [{ id: 'default', path: path.join(tmpRoot, '.opencode') }, { id: 'work', path: path.join(tmpRoot, '.opencode-work') }],
    qoder: [{ id: 'default', path: path.join(tmpRoot, '.qoder') }],
  };
  const settings = { mainPageSessionKeys: [], agentHomes: providerHomes };
  const captured = [];
  const metadataUpdates = [];
  const sessionStates = new Map();
  const engine = {
    async createSession(options) {
      captured.push(options);
    },
    async updateSessionMetadata(agentId, patch) {
      metadataUpdates.push({ agentId, patch });
    },
    async getSessionState(agentId) {
      return sessionStates.get(agentId) || null;
    },
  };
  const manager = new AgentManager({
    getWorkspace() {
      return tmpRoot;
    },
    getHeartbeatInterval() {
      return 1000;
    },
    getDangerouslySkipAgentPermissionsByDefault() {
      return false;
    },
    getSettings() {
      return settings;
    },
    getAgentHome(provider, homeId) {
      return (providerHomes[provider] || []).find(home => home.id === homeId) || null;
    },
    updateSettings(patch) {
      Object.assign(settings, patch);
    },
  });

  manager.engineBridge.resolve = () => ({
    engineName: 'local',
    engine,
    spec: { category: 'coding' },
  });
  manager.engineBridge.getEngine = () => engine;

  try {
    const codexId = await startAgent(manager, 'codex', workspace, { wantsMain: false });
    const codexAgent = manager.getState().agents.find(agent => agent.id === codexId);
    assert.strictEqual(codexAgent.providerSessionProvider, 'codex');
    assert.strictEqual(codexAgent.providerSessionTemporary, true);
    assert(codexAgent.providerSessionId.startsWith('tmp_uuid'), 'Codex should start with a tmp_uuid provider id');
    assert.strictEqual(codexAgent.providerSessionKey, `agent-session:codex:${codexAgent.providerSessionId}`);
    assert.deepStrictEqual(settings.mainPageSessionKeys, [], 'temporary Codex ids must not enter main page history');
    manager.providerSessionService.stop(codexId);

    const incompleteCodexSessionId = '11111111-2222-4333-8444-555555555555';
    const completeCodexSessionId = '22222222-3333-4444-8555-666666666666';
    const startedAt = Number(codexAgent.startedAt) || Date.now();
    const codexHistoryWorkspace = fs.realpathSync(path.join(__dirname, '../..'));
    const liveCodexAgent = manager.agents.get(codexId);
    liveCodexAgent.engineStarted = true;
    liveCodexAgent.projectWorkspace = codexHistoryWorkspace;
    liveCodexAgent.cwd = codexHistoryWorkspace;
    writeCodexSession(tmpRoot, incompleteCodexSessionId, [
      {
        timestamp: new Date(startedAt + 1000).toISOString(),
        type: 'event_msg',
        payload: { type: 'user_message', message: 'hello' },
      },
    ]);
    const unresolvedCodexSession = await manager.providerSessionService.findTemporaryCodexSession(liveCodexAgent);
    assert.strictEqual(
      unresolvedCodexSession,
      null,
      'Codex rollout should wait if the session file exists before Codex writes cwd metadata'
    );

    writeCodexSession(tmpRoot, completeCodexSessionId, [
      {
        timestamp: new Date(startedAt + 5000).toISOString(),
        type: 'session_meta',
        payload: { id: completeCodexSessionId, cwd: codexHistoryWorkspace, source: 'codex_cli' },
      },
      {
        timestamp: new Date(startedAt + 5100).toISOString(),
        type: 'event_msg',
        payload: { type: 'user_message', message: '看下cron worker怎么加新模块' },
      },
    ]);
    manager.engineBridge.router.engines.local.emit('session-started', {
      sessionId: codexId,
      status: 'running',
    });
    await waitFor(() => manager.agents.get(codexId).providerSessionId === completeCodexSessionId);
    const resolvedCodexAgent = manager.getState().agents.find(agent => agent.id === codexId);
    assert.strictEqual(resolvedCodexAgent.providerSessionId, completeCodexSessionId);
    assert.strictEqual(resolvedCodexAgent.providerSessionTemporary, false);
    assert.strictEqual(resolvedCodexAgent.providerSessionTitle, '看下cron worker怎么加新模块');
    assert.strictEqual(settings.mainPageSessionKeys[0], `agent-session:codex:${completeCodexSessionId}`);
    assert(!settings.mainPageSessionKeys.some(key => key.includes('tmp_uuid')));
    assert.strictEqual(metadataUpdates.at(-1).patch.providerSessionId, completeCodexSessionId);
    assert.strictEqual(metadataUpdates.at(-1).patch.providerSessionTitle, '看下cron worker怎么加新模块');

    const recoveredCodexId = 'agent-recovered-codex-title';
    manager.agents.set(recoveredCodexId, {
      id: recoveredCodexId,
      command: 'codex',
      forkCommand: 'codex',
      cwd: codexHistoryWorkspace,
      projectWorkspace: codexHistoryWorkspace,
      output: '',
      status: 'running',
      engineName: 'local',
      wantsMain: false,
      category: 'coding',
      task: '',
      sessionTitle: 'warehouse-engine',
      source: 'recovered',
      providerSessionProvider: 'codex',
      providerSessionId: completeCodexSessionId,
      providerSessionKey: `agent-session:codex:${completeCodexSessionId}`,
      providerSessionTemporary: false,
      providerSessionSource: 'codex-rollout',
      providerSessionTitle: '',
      validated: true,
      engineStarted: true,
      startedAt,
    });
    const titleResolved = await manager.providerSessionService.resolveTitle(recoveredCodexId, { force: true });
    const recoveredCodexAgent = manager.getState().agents.find(agent => agent.id === recoveredCodexId);
    assert.strictEqual(titleResolved, true);
    assert.strictEqual(recoveredCodexAgent.providerSessionTitle, '看下cron worker怎么加新模块');
    const recoveredMetadataUpdate = metadataUpdates.find(update => update.agentId === recoveredCodexId);
    assert.strictEqual(recoveredMetadataUpdate.patch.providerSessionTitle, '看下cron worker怎么加新模块');

    const claudeId = await startAgent(manager, 'claude', workspace, { wantsMain: false });
    const claudeAgent = manager.getState().agents.find(agent => agent.id === claudeId);
    const claudeSessionArgIndex = captured.at(-1).args.indexOf('--session-id');
    assert(claudeSessionArgIndex >= 0, 'new Claude sessions should receive an explicit --session-id');
    assert.strictEqual(captured.at(-1).args[claudeSessionArgIndex + 1], claudeAgent.providerSessionId);
    assert.strictEqual(claudeAgent.providerSessionTemporary, false);
    assert.strictEqual(settings.mainPageSessionKeys[0], `agent-session:claude:${claudeAgent.providerSessionId}`);

    const resumeCodexSessionId = '44444444-5555-4666-8777-888888888888';
    const resumedCodexId = await startAgent(manager, `codex resume ${resumeCodexSessionId}`, workspace, { wantsMain: false });
    const resumedCodexAgent = manager.getState().agents.find(agent => agent.id === resumedCodexId);
    assert.strictEqual(resumedCodexAgent.providerSessionId, resumeCodexSessionId);
    assert.strictEqual(resumedCodexAgent.providerSessionTemporary, false);
    assert.strictEqual(settings.mainPageSessionKeys[0], `agent-session:codex:${resumeCodexSessionId}`);

    const workCodexSessionId = '44444444-5555-4666-8777-888888888889';
    const workCodexId = await startAgent(manager, `codex resume ${workCodexSessionId}`, workspace, {
      wantsMain: false,
      providerHomeId: 'work',
      source: `codex-history:home:work:${workCodexSessionId}`,
    });
    const workCodexAgent = manager.getState().agents.find(agent => agent.id === workCodexId);
    assert.strictEqual(workCodexAgent.providerSessionKey, `agent-session:codex:home:work:${workCodexSessionId}`);
    assert.strictEqual(workCodexAgent.providerHomePath, providerHomes.codex[1].path);
    assert.strictEqual(captured.at(-1).env.CODEX_HOME, providerHomes.codex[1].path);

    const openCodeId = await startAgent(manager, 'opencode', workspace, { wantsMain: false, providerHomeId: 'work' });
    const openCodeAgent = manager.getState().agents.find(agent => agent.id === openCodeId);
    assert.strictEqual(openCodeAgent.providerHomeId, 'work');
    assert.strictEqual(captured.at(-1).env.OPENCODE_CONFIG_DIR, providerHomes.opencode[1].path);
    const openCodeSessionId = 'ses_0b5c8bfdbffepm0O5sc1lPLtzK';
    const resumedOpenCodeId = await startAgent(manager, `opencode --session ${openCodeSessionId}`, workspace, {
      wantsMain: false,
      source: `opencode-history:home:work:${openCodeSessionId}`,
      providerHomeId: 'work',
    });
    const resumedOpenCodeAgent = manager.getState().agents.find(agent => agent.id === resumedOpenCodeId);
    assert.strictEqual(resumedOpenCodeAgent.providerSessionProvider, 'opencode');
    assert.strictEqual(resumedOpenCodeAgent.providerSessionId, openCodeSessionId);
    assert.strictEqual(resumedOpenCodeAgent.providerSessionTemporary, false);
    assert.strictEqual(resumedOpenCodeAgent.providerSessionKey, `agent-session:opencode:home:work:${openCodeSessionId}`);
    assert.strictEqual(settings.mainPageSessionKeys[0], `agent-session:opencode:home:work:${openCodeSessionId}`);
    await assert.rejects(
      startAgent(manager, 'codex', workspace, { wantsMain: false, providerHomeId: 'missing' }),
      /Unknown codex agent home: missing/
    );

    const sourceClaudeSessionId = '55555555-6666-4777-8888-999999999999';
    const forkedClaudeId = await startAgent(manager, `claude --resume ${sourceClaudeSessionId} --fork-session`, workspace, {
      wantsMain: false,
      source: `claude-history-fork:${sourceClaudeSessionId}`,
    });
    const forkedClaudeAgent = manager.getState().agents.find(agent => agent.id === forkedClaudeId);
    assert.notStrictEqual(forkedClaudeAgent.providerSessionId, sourceClaudeSessionId);
    assert.strictEqual(forkedClaudeAgent.forkedFromProviderSessionId, sourceClaudeSessionId);
    assert.strictEqual(captured.at(-1).args[0], '--session-id');
    assert.strictEqual(captured.at(-1).args[1], forkedClaudeAgent.providerSessionId);

    const qoderId = await startAgent(manager, 'qoder', workspace, { wantsMain: false, providerHomeId: 'default' });
    const qoderAgent = manager.getState().agents.find(agent => agent.id === qoderId);
    const qoderSessionArgIndex = captured.at(-1).args.indexOf('--session-id');
    assert(qoderSessionArgIndex >= 0, 'new Qoder sessions should receive an explicit --session-id');
    assert.strictEqual(captured.at(-1).args[qoderSessionArgIndex + 1], qoderAgent.providerSessionId);
    assert.strictEqual(captured.at(-1).command, path.join(binDir, 'qodercli'));
    assert.strictEqual(qoderAgent.command, 'qodercli');
    assert.strictEqual(manager.agents.get(qoderId).forkCommand, 'qoder');
    assert.strictEqual(qoderAgent.providerSessionProvider, 'qoder');
    assert.strictEqual(qoderAgent.providerSessionTemporary, false);
    assert.strictEqual(captured.at(-1).env.QODER_CONFIG_DIR, providerHomes.qoder[0].path);
    assert.strictEqual(settings.mainPageSessionKeys[0], `agent-session:qoder:${qoderAgent.providerSessionId}`);

    const liveQoderAgent = manager.agents.get(qoderId);
    liveQoderAgent.status = 'dead';
    liveQoderAgent.engineStatus = 'dead';
    liveQoderAgent.exitedAt = Date.now();
    sessionStates.set(qoderId, {
      status: 'running',
      output: 'Qoder ready',
      previewText: 'Qoder ready',
      startedAt: liveQoderAgent.startedAt,
      previewCols: 80,
      previewRows: 30,
    });
    const qoderView = await manager.getAgentSessionView(qoderId);
    assert.strictEqual(qoderView.status, 'running', 'Qoder should be revived when the native host still has a live session');
    assert.strictEqual(manager.agents.get(qoderId).status, 'running');
    assert.strictEqual(manager.agents.get(qoderId).exitedAt, null);

    const qoderStartupRaceId = await startAgent(manager, 'qoder', workspace, { wantsMain: false });
    const qoderStartupRaceView = await manager.getAgentSessionView(qoderStartupRaceId);
    assert.strictEqual(
      qoderStartupRaceView.status,
      'running',
      'a newly launched Qoder session should not be marked dead during the native-host startup grace period'
    );
    assert.strictEqual(manager.agents.get(qoderStartupRaceId).status, 'running');

    const sourceQoderSessionId = '66666666-7777-4888-9999-000000000000';
    const forkedQoderId = await startAgent(manager, `qodercli --resume ${sourceQoderSessionId} --fork-session`, workspace, {
      wantsMain: false,
      source: `qoder-history-fork:${sourceQoderSessionId}`,
    });
    const forkedQoderAgent = manager.getState().agents.find(agent => agent.id === forkedQoderId);
    assert.notStrictEqual(forkedQoderAgent.providerSessionId, sourceQoderSessionId);
    assert.strictEqual(forkedQoderAgent.forkedFromProviderSessionId, sourceQoderSessionId);
    assert.strictEqual(captured.at(-1).args[0], '--session-id');
    assert.strictEqual(captured.at(-1).args[1], forkedQoderAgent.providerSessionId);

    console.log('✓ AgentManager assigns provider session identities for Codex, Claude, OpenCode, and Qoder');
  } finally {
    if (previousCodexBin === undefined) {
      delete process.env.FARMING_CODEX_BIN;
    } else {
      process.env.FARMING_CODEX_BIN = previousCodexBin;
    }
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    process.env.PATH = previousPath;
    for (const agent of manager.getState().agents) {
      manager.providerSessionService.stop(agent.id);
    }
    clearInterval(manager.heartbeatInterval);
    manager.engineBridge.dispose();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

function writeFakeExecutable(filePath, versionOutput) {
  fs.writeFileSync(filePath, `#!/usr/bin/env node
if (process.argv.includes('--version')) {
  process.stdout.write(${JSON.stringify(versionOutput)});
}
`);
  fs.chmodSync(filePath, 0o755);
}

function writeCodexSession(home, sessionId, events) {
  const sessionsDir = path.join(home, '.codex', 'sessions', '2026', '07', '03');
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.writeFileSync(
    path.join(sessionsDir, `rollout-${sessionId}.jsonl`),
    `${events.map(event => JSON.stringify(event)).join('\n')}\n`
  );
}

function startAgent(manager, command, workspace, options) {
  return new Promise((resolve, reject) => {
    manager.startAgent(command, workspace, (agentId, error) => {
      if (error) {
        reject(new Error(error));
        return;
      }
      resolve(agentId);
    }, options).catch(reject);
  });
}

async function waitFor(predicate, timeoutMs = 1000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert(predicate(), 'condition was not met before timeout');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
