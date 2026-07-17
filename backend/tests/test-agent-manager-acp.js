const assert = require('assert');
const path = require('path');
const AgentManager = require('../agent-manager');
const { AcpRuntime } = require('../acp-runtime');

function config(overrides = {}) {
  return {
    getWorkspace: () => process.cwd(),
    getHeartbeatInterval: () => 60_000,
    getTaskHistory: () => [],
    getDangerouslySkipAgentPermissionsByDefault: () => false,
    getAgentLaunchProfiles: () => ({}),
    getCodexApprovalMode: () => 'full',
    getCodexModel: () => 'gpt-5.5',
    getCodexReasoningEffort: () => 'xhigh',
    getCodexServiceTier: () => 'priority',
    getCodexRuntimeMode: () => 'cli',
    getAgentHome: () => ({ id: 'default', path: path.join(process.env.HOME, '.codex') }),
    ...overrides,
  };
}

async function run() {
  const fixture = path.join(__dirname, 'fixtures', 'fake-acp-agent.mjs');
  const runtime = new AcpRuntime({
    resolveLaunch: () => ({ command: process.execPath, args: [fixture], version: 'test' }),
  });
  const manager = new AgentManager(config(), { acpRuntime: runtime });
  let nativeMetadataUpdateCount = 0;
  manager.engineBridge.getEngine('native').updateSessionMetadata = async () => {
    nativeMetadataUpdateCount += 1;
  };
  try {
    const agentId = await new Promise(resolve => {
      manager.startAgent('codex', process.cwd(), (id, error) => {
        assert.ifError(error);
        resolve(id);
      }, {
        agentRuntimeMode: 'acp',
        codexRuntimeMode: 'cli',
        codexApprovalMode: 'full',
      });
    });
    assert(agentId);
    const live = manager.agents.get(agentId);
    assert.strictEqual(live.agentRuntimeMode, 'acp');
    assert.strictEqual(live.engineStarted, false);
    assert.strictEqual(live.providerSessionId, 'acp-new-session');
    assert.strictEqual(live.providerSessionSource, 'acp-new');
    const binding = runtime.bindings.get(agentId);
    assert.strictEqual(binding.env.INITIAL_AGENT_MODE, 'agent-full-access');
    assert.deepStrictEqual(JSON.parse(binding.env.CODEX_CONFIG), {
      model: 'gpt-5.5',
      model_reasoning_effort: 'xhigh',
      service_tier: 'priority',
    });
    const elicitationPromise = runtime.requestElicitation(binding, {
      sessionId: binding.sessionId,
      mode: 'form',
      message: 'Confirm from manager state',
      requestedSchema: {
        type: 'object',
        properties: { confirmed: { type: 'boolean' } },
        required: ['confirmed'],
      },
    });
    const waitingAgent = manager.getState().agents.find(agent => agent.id === agentId);
    assert.strictEqual(waitingAgent.acpState, 'waiting-for-input');
    assert.strictEqual(waitingAgent.acpPendingElicitation.message, 'Confirm from manager state');
    assert.strictEqual(waitingAgent.acpPendingElicitations.length, 1);
    manager.respondToAcpElicitation(
      agentId,
      waitingAgent.acpPendingElicitation.requestId,
      'accept',
      { confirmed: true },
    );
    assert.deepStrictEqual(await elicitationPromise, { action: 'accept', content: { confirmed: true } });
    assert.strictEqual(manager.getState().agents.find(agent => agent.id === agentId).acpPendingElicitations.length, 0);

    const result = await manager.sendComposerMessage(agentId, 'manager prompt');
    assert.strictEqual(result.kind, 'acp');
    assert.strictEqual(result.stopReason, 'end_turn');
    const session = manager.getAcpSession(agentId);
    assert.strictEqual(session.entries.find(item => item.role === 'assistant').content[0].text, 'ACP reply');
    await manager.sendComposerMessage(agentId, [
      { type: 'text', text: 'inspect image' },
      { type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' },
    ]);
    const imagePrompt = manager.getAcpSession(agentId).entries
      .filter(item => item.role === 'user')
      .at(-1);
    assert.strictEqual(imagePrompt.content[0].text, 'inspect image');
    assert.strictEqual(imagePrompt.content[1].type, 'image');
    const listed = await manager.listAcpSessions(agentId);
    assert(listed.sessions.some(item => item.sessionId === 'acp-new-session'));
    const rawTranscript = manager.getAcpTranscript(agentId);
    assert.strictEqual('turns' in rawTranscript, false, 'ACP Turn/Item projection belongs to the frontend');
    assert.strictEqual(
      rawTranscript.entries.find(item => item.role === 'assistant').content[0].text,
      'ACP reply',
    );
    assert.strictEqual((await manager.forkAcpSession(agentId)).sessionId, 'acp-fork-session');
    assert.strictEqual((await manager.setAcpSessionMode(agentId, 'plan')).modeId, 'plan');
    const subagentResult = await manager.sendComposerMessage(agentId, 'subagent preview');
    assert.strictEqual(subagentResult.stopReason, 'end_turn');
    const subagentDetail = manager.getAcpToolDetail(agentId, 'subagent-tool');
    assert.strictEqual(subagentDetail.subagentSession.sessionId, 'acp-child-session');
    assert.strictEqual('turns' in subagentDetail.subagentSession, false);
    assert.strictEqual(
      subagentDetail.subagentSession.entries.filter(item => item.role === 'assistant').at(-1).content[0].text,
      'The parser is consistent.',
    );
    assert.strictEqual(nativeMetadataUpdateCount, 0, 'ACP sessions must not update native PTY metadata');
  } finally {
    await manager.dispose();
  }

  const openCodeRuntime = new AcpRuntime({
    resolveLaunch: () => ({ command: process.execPath, args: [fixture], version: 'test' }),
  });
  const openCodeManager = new AgentManager(config(), {
    acpRuntime: openCodeRuntime,
    skipExecutablePreflight: true,
  });
  try {
    const openCodeAgentId = await new Promise(resolve => {
      openCodeManager.startAgent('opencode', process.cwd(), (id, error) => {
        assert.ifError(error);
        resolve(id);
      }, {
        agentRuntimeMode: 'acp',
        providerHomeId: 'default',
      });
    });
    assert(openCodeAgentId);
    const openCodeAgent = openCodeManager.agents.get(openCodeAgentId);
    assert.strictEqual(openCodeAgent.agentRuntimeMode, 'acp');
    assert.strictEqual(openCodeAgent.providerSessionProvider, 'opencode');
    assert.strictEqual(openCodeAgent.providerSessionId, 'acp-new-session');
    assert.strictEqual(openCodeAgent.providerSessionSource, 'acp-new');
    assert(openCodeRuntime.bindings.has(openCodeAgentId));
    assert.strictEqual(openCodeAgent.engineStarted, false);
  } finally {
    await openCodeManager.dispose();
  }

  const providerRuntime = new AcpRuntime({
    resolveLaunch: () => ({ command: process.execPath, args: [fixture], version: 'test' }),
  });
  const providerManager = new AgentManager(config(), {
    acpRuntime: providerRuntime,
    skipExecutablePreflight: true,
  });
  try {
    for (const { provider, command } of [
      { provider: 'codex', command: 'codex' },
      { provider: 'claude', command: 'claude' },
      { provider: 'opencode', command: 'opencode' },
      { provider: 'qoder', command: 'qoder' },
    ]) {
      const providerAgentId = await new Promise(resolve => {
        providerManager.startAgent(command, process.cwd(), (id, error) => {
          assert.ifError(error);
          resolve(id);
        }, {
          agentRuntimeMode: 'acp',
          codexServiceTier: 'default',
        });
      });
      assert(providerAgentId, `${provider} ACP should start`);
      const providerAgent = providerManager.agents.get(providerAgentId);
      assert.strictEqual(providerAgent.providerSessionProvider, provider);
      assert.strictEqual(providerAgent.agentRuntimeMode, 'acp');
      assert.strictEqual(
        providerAgent.providerSessionSource,
        'acp-new',
        `${provider} fresh ACP Chat should create a provider session instead of loading a generated CLI id`,
      );
      const providerSession = providerManager.getAcpSession(providerAgentId);
      assert.deepStrictEqual(
        providerSession.configOptions.map(option => option.id),
        ['model', 'reasoning', 'fast-mode'],
        `${provider} ACP should expose the provider-advertised profile controls`,
      );
      await providerManager.setAcpSessionConfigOption(providerAgentId, 'fast-mode', true);
      assert.strictEqual(
        providerManager.getAcpSession(providerAgentId).configOptions
          .find(option => option.id === 'fast-mode')?.currentValue,
        true,
        `${provider} ACP Fast should update through the shared runtime path`,
      );
    }
  } finally {
    await providerManager.dispose();
  }

  const recoveryRuntime = new AcpRuntime({
    resolveLaunch: () => ({ command: process.execPath, args: [fixture], version: 'test' }),
  });
  const recoveryManager = new AgentManager(config({
    listAgentSessionRecords: () => [{
      id: 'fsess-recovered',
      runtimeAgentId: 'agent-acp-recovered',
      agentRuntimeMode: 'acp',
      providerSessionProvider: 'codex',
      providerSessionId: 'existing-session',
      cwd: process.cwd(),
      status: 'running',
    }],
  }), { acpRuntime: recoveryRuntime });
  try {
    await recoveryManager.recoverAcpSessions();
    const recoveredBinding = recoveryRuntime.bindings.get('agent-acp-recovered');
    assert(recoveredBinding);
    assert.strictEqual(recoveredBinding.env.INITIAL_AGENT_MODE, 'agent-full-access');
    assert.strictEqual(
      recoveredBinding.env.CODEX_CONFIG,
      undefined,
      'ACP recovery must let Codex resolve its Home config instead of applying Farming launch defaults',
    );
  } finally {
    await recoveryManager.dispose();
  }

  let recoveredQoderExecutable = '';
  const qoderRecoveryRuntime = new AcpRuntime({
    resolveLaunch: (_provider, options) => {
      recoveredQoderExecutable = options.executable;
      return { command: process.execPath, args: [fixture], version: 'test' };
    },
  });
  const qoderRecoveryManager = new AgentManager(config({
    listAgentSessionRecords: () => [{
      id: 'fsess-qoder-recovered',
      runtimeAgentId: 'agent-qoder-recovered',
      agentRuntimeMode: 'acp',
      providerSessionProvider: 'qoder',
      providerSessionId: 'existing-session',
      cwd: process.cwd(),
      status: 'running',
    }],
  }), { acpRuntime: qoderRecoveryRuntime });
  try {
    await qoderRecoveryManager.recoverAcpSessions();
    assert.strictEqual(path.basename(recoveredQoderExecutable), 'qodercli');
    assert.strictEqual(qoderRecoveryManager.agents.get('agent-qoder-recovered').agentRuntimeMode, 'acp');
  } finally {
    await qoderRecoveryManager.dispose();
  }

  const authoritativeRecord = {
    id: 'fsess-acp-over-stale-pty',
    runtimeAgentId: 'agent-acp-over-stale-pty',
    agentRuntimeMode: 'acp',
    providerSessionProvider: 'codex',
    providerSessionId: 'existing-session',
    command: 'codex resume existing-session',
    cwd: process.cwd(),
    category: 'coding',
    status: 'running',
  };
  const recoveryWrites = [];
  const stalePtyRuntime = new AcpRuntime({
    resolveLaunch: () => ({ command: process.execPath, args: [fixture], version: 'test' }),
  });
  const stalePtyManager = new AgentManager(config({
    listAgentSessionRecords: () => [{ ...authoritativeRecord }],
    ensureAgentSessionRecord: agent => {
      recoveryWrites.push(agent.agentRuntimeMode);
      Object.assign(authoritativeRecord, {
        runtimeAgentId: agent.id,
        agentRuntimeMode: agent.agentRuntimeMode,
        acpState: agent.acpState,
      });
      return authoritativeRecord.id;
    },
  }), { acpRuntime: stalePtyRuntime });
  await stalePtyManager.engineBridge.dispose();
  const killedRecoveredSessions = [];
  stalePtyManager.engineBridge = {
    async recoverSessions() {
      return [{
        engineName: 'native',
        agentId: authoritativeRecord.runtimeAgentId,
        metadata: {
          agentId: authoritativeRecord.runtimeAgentId,
          command: authoritativeRecord.command,
          cwd: authoritativeRecord.cwd,
          category: 'coding',
          agentRuntimeMode: 'terminal',
        },
        state: { status: 'running', startedAt: Date.now() - 1_000 },
      }];
    },
    async killSession(engineName, sessionId) {
      killedRecoveredSessions.push({ engineName, sessionId });
    },
    getEngine() {
      return null;
    },
    dispose() {},
  };
  try {
    await stalePtyManager.recoverEngineSessions();
    assert.deepStrictEqual(killedRecoveredSessions, [{
      engineName: 'native',
      sessionId: 'agent-acp-over-stale-pty',
    }]);
    assert.strictEqual(stalePtyManager.agents.get('agent-acp-over-stale-pty').agentRuntimeMode, 'acp');
    assert(stalePtyRuntime.bindings.has('agent-acp-over-stale-pty'));
    assert(!recoveryWrites.includes('terminal'), 'stale PTY recovery must not overwrite the persisted ACP mode');
  } finally {
    await stalePtyManager.dispose();
  }
  console.log('agent manager ACP tests passed');
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
