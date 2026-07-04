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

  const previousPath = process.env.PATH;
  const previousCodexBin = process.env.FARMING_CODEX_BIN;
  const previousHome = process.env.HOME;
  process.env.PATH = `${binDir}${path.delimiter}${previousPath || ''}`;
  process.env.FARMING_CODEX_BIN = path.join(binDir, 'codex');
  process.env.HOME = tmpRoot;

  const settings = { mainPageSessionKeys: [] };
  const captured = [];
  const metadataUpdates = [];
  const engine = {
    async createSession(options) {
      captured.push(options);
    },
    async updateSessionMetadata(agentId, patch) {
      metadataUpdates.push({ agentId, patch });
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
    manager.stopCodexProviderSessionResolver(codexId);

    const incompleteCodexSessionId = '11111111-2222-4333-8444-555555555555';
    const completeCodexSessionId = '22222222-3333-4444-8555-666666666666';
    const startedAt = Number(codexAgent.startedAt) || Date.now();
    const codexHistoryWorkspace = fs.realpathSync(path.join(__dirname, '../..'));
    const liveCodexAgent = manager.agents.get(codexId);
    liveCodexAgent.projectWorkspace = codexHistoryWorkspace;
    liveCodexAgent.cwd = codexHistoryWorkspace;
    writeCodexSession(tmpRoot, incompleteCodexSessionId, [
      {
        timestamp: new Date(startedAt + 1000).toISOString(),
        type: 'event_msg',
        payload: { type: 'user_message', message: 'hello' },
      },
    ]);
    const unresolvedCodexSession = await manager.findCodexSessionForTemporaryAgent(liveCodexAgent);
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
    ]);
    manager.engineBridge.router.engines.local.emit('session-output', {
      sessionId: codexId,
      data: 'Codex output after session metadata',
    });
    await waitFor(() => manager.agents.get(codexId).providerSessionId === completeCodexSessionId);
    const resolvedCodexAgent = manager.getState().agents.find(agent => agent.id === codexId);
    assert.strictEqual(resolvedCodexAgent.providerSessionId, completeCodexSessionId);
    assert.strictEqual(resolvedCodexAgent.providerSessionTemporary, false);
    assert.strictEqual(settings.mainPageSessionKeys[0], `agent-session:codex:${completeCodexSessionId}`);
    assert(!settings.mainPageSessionKeys.some(key => key.includes('tmp_uuid')));
    assert.strictEqual(metadataUpdates.at(-1).patch.providerSessionId, completeCodexSessionId);

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

    console.log('✓ AgentManager assigns unique provider session identities for Codex and Claude');
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
      manager.stopCodexProviderSessionResolver(agent.id);
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
