const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { AgentManager } = require('../agent-manager.cjs');
const { AcpRuntime } = require('../acp-runtime.cjs');
const {
  ensureFarmingAgentBootstrapFile,
  renderFarmingAgentBootstrap,
} = require('../farming-agent-bootstrap.cjs');

const TEST_PROCESS_IDENTITY = {
  describeAcpProcessGroup: async pid => ({
    pid,
    processGroupId: pid,
    startedAt: `test-process-${pid}`,
  }),
};

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
  delete process.env.CODEX_CONFIG;
  const farmingSystemPrompt = renderFarmingAgentBootstrap();
  const fixture = path.join(__dirname, 'fixtures', 'fake-acp-agent.mts');
  const runtime = new AcpRuntime({
    ...TEST_PROCESS_IDENTITY,
    resolveLaunch: () => ({ command: process.execPath, args: ['--import', require.resolve('tsx'), fixture], version: 'test' }),
  });
  const manager = new AgentManager(config(), {
    acpRuntime: runtime,
    skipExecutablePreflight: true,
    cliBinDir: '/opt/farming/bin',
    controlUrl: 'http://127.0.0.1:6694/farming',
    tokenFile: '/tmp/farming-test-token',
  });
  let nativeMetadataUpdateCount = 0;
  manager.engineBridge.getEngine('native').updateSessionMetadata = async () => {
    nativeMetadataUpdateCount += 1;
  };
  try {
    const agentId = await new Promise(resolve => {
      manager.startAgent('claude', process.cwd(), (id, error) => {
        assert.ifError(error);
        resolve(id);
      }, {
        agentRuntimeMode: 'chat',
        wantsMain: false,
        additionalDirectories: [path.join(process.cwd(), 'docs')],
        mcpServers: [{ name: 'docs', command: '/bin/docs-mcp', args: [], env: [] }, {
          name: 'farming-browser',
          command: '/opt/farming/bin/farming',
          args: ['browser', 'mcp'],
          _meta: { 'farming.dev/extension': 'browser' },
        }],
      });
    });
    assert(agentId);
    const live = manager.agents.get(agentId);
    assert.strictEqual(live.runtimeBinding.kind, 'acp');
    assert.strictEqual(live.engineStarted, false);
    assert.strictEqual(live.providerSessionId, 'acp-new-session');
    assert.strictEqual(live.providerSessionSource, 'acp-new');
    assert.strictEqual(live.providerSessionMaterialized, false);
    let genericUpdateCount = 0;
    const sessionRevisions = [];
    manager.onUpdate(() => {
      genericUpdateCount += 1;
    });
    manager.on('acp-session-revision', session => {
      sessionRevisions.push(session);
    });
    const scopedAgentUpdates = [];
    manager.on('agent-update', update => {
      scopedAgentUpdates.push(update);
    });
    const nextSessionRevision = live.runtimeBinding.sessionRevision + 1;
    runtime.emit('session', { agentId, revision: nextSessionRevision });
    assert.strictEqual(
      genericUpdateCount,
      0,
      'an ACP transcript revision must not request a full workspace-state broadcast',
    );
    assert.deepStrictEqual(
      sessionRevisions.map(({ agentId: updatedAgentId, revision }) => ({ agentId: updatedAgentId, revision })),
      [{ agentId, revision: nextSessionRevision }],
      'an ACP transcript revision should use its dedicated per-Agent channel',
    );
    const binding = runtime.bindings.get(agentId);
    const initialCapabilityRuntimeEpoch = runtime.bindingEpoch(agentId);
    assert.strictEqual(binding.capabilityRuntimeEpoch, initialCapabilityRuntimeEpoch);
    assert.strictEqual(binding.env.FARMING_AGENT_TITLE_TOKEN, undefined);
    assert.match(binding.agentContext, new RegExp(`当前 Farming Agent 名字是 ${agentId}`));
    assert.strictEqual(binding.env.FARMING_CLI_BIN_DIR, '/opt/farming/bin');
    binding.sessionState.revision = nextSessionRevision;
    binding.sessionState.apply({
      sessionId: binding.sessionId,
      update: {
        sessionUpdate: 'session_info_update',
        title: 'Investigate phase-aware Mermaid',
      },
    });
    assert.strictEqual(
      binding.sessionState.revision,
      nextSessionRevision + 1,
      'ACP session metadata should advance the revision consumed by the Agent list',
    );
    runtime.emitSession(binding);
    assert.strictEqual(
      live.sessionTitle,
      'Investigate phase-aware Mermaid',
      'an ACP session title should update the Agent name source',
    );
    assert.strictEqual(
      genericUpdateCount,
      0,
      'an ACP title change must not request a full workspace-state broadcast',
    );
    assert.deepStrictEqual(
      scopedAgentUpdates.at(-1),
      { agentId, patch: { sessionTitle: 'Investigate phase-aware Mermaid' } },
      'an ACP title change should publish one Agent-scoped title patch',
    );
    binding.sessionState.apply({
      sessionId: binding.sessionId,
      update: {
        sessionUpdate: 'session_info_update',
        title: '<farming-agent-context> 当前 Farming Agent 名字是 agent-title-source',
      },
    });
    runtime.emitSession(binding);
    assert.strictEqual(
      live.sessionTitle,
      'Investigate phase-aware Mermaid',
      'internal Farming session context must never replace the Agent title',
    );
    runtime.emit('session', {
      agentId,
      revision: binding.sessionState.revision,
      title: 'Stale title must not win',
    });
    assert.strictEqual(
      live.sessionTitle,
      'Investigate phase-aware Mermaid',
      'a stale ACP revision must not replace the current Agent title',
    );
    live.sessionTitle = '';
    runtime.emit('session', {
      agentId,
      revision: binding.sessionState.revision,
      title: 'Investigate phase-aware Mermaid',
    });
    assert.strictEqual(
      live.sessionTitle,
      'Investigate phase-aware Mermaid',
      'an authoritative same-revision ACP snapshot should restore a missing Agent title',
    );
    assert.deepStrictEqual(binding.sessionRequestOptions.additionalDirectories, [path.join(process.cwd(), 'docs')]);
    assert.deepStrictEqual(binding.sessionRequestOptions.mcpServers, [
      { name: 'docs', command: '/bin/docs-mcp', args: [], env: [] },
    ], 'Farming must preserve provider MCP configuration without adding capability MCP');
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
    assert.strictEqual(waitingAgent.runtimeBinding.state, 'waiting-for-input');
    assert.strictEqual(waitingAgent.runtimeBinding.pendingElicitation.message, 'Confirm from manager state');
    assert.strictEqual(waitingAgent.runtimeBinding.pendingElicitations.length, 1);
    manager.respondToAcpElicitation(
      agentId,
      waitingAgent.runtimeBinding.pendingElicitation.requestId,
      'accept',
      { confirmed: true },
    );
    assert.deepStrictEqual(await elicitationPromise, { action: 'accept', content: { confirmed: true } });
    assert.strictEqual(manager.getState().agents.find(agent => agent.id === agentId).runtimeBinding.pendingElicitations.length, 0);
    assert.strictEqual(live.attentionSeq, 0, 'an ACP elicitation returning to idle is not a completed prompt turn');

    let resolveProviderTitle;
    const providerTitleUpdated = new Promise(resolve => {
      resolveProviderTitle = resolve;
    });
    manager.providerSessionService.findAgentSession = async (provider, sessionId) => {
      assert.strictEqual(provider, 'claude');
      assert.strictEqual(sessionId, 'acp-new-session');
      return { title: 'Review phase-aware Mermaid rendering' };
    };
    manager.once('provider-session-updated', resolveProviderTitle);
    live.customTitle = 'Manual Mermaid review';
    const result = await manager.sendComposerMessage(agentId, 'phase-aware mermaid');
    assert.strictEqual(result.kind, 'acp');
    assert.strictEqual(result.stopReason, 'end_turn');
    assert.strictEqual(live.providerSessionMaterialized, true);
    assert.strictEqual(live.attentionSeq, 1, 'an ACP end_turn response should create one attention event');
    assert.strictEqual(live.attentionReason, 'turn-complete');
    assert.match(live.attentionSummary, /^Phase-aware rich answer\./);
    assert.strictEqual(live.unread, true);
    runtime.emit('agent-runtime', { agentId, state: 'working', stopReason: '' });
    runtime.emit('agent-runtime', { agentId, state: 'idle', stopReason: 'cancelled' });
    assert.strictEqual(live.attentionSeq, 1, 'an ACP cancelled response should not report completed work');
    await Promise.race([
      providerTitleUpdated,
      new Promise((_, reject) => setTimeout(
        () => reject(new Error('ACP turn completion did not refresh the provider title')),
        2_000,
      )),
    ]);
    assert.strictEqual(
      live.providerSessionTitle,
      'Review phase-aware Mermaid rendering',
      'a completed ACP turn should refresh the provider history title',
    );
    assert.strictEqual(
      live.customTitle,
      'Manual Mermaid review',
      'a provider title refresh must not replace a manual Agent name',
    );
    const session = manager.getAcpSession(agentId);
    assert.strictEqual(session.entries.find(item => item.role === 'assistant').content[0].text, 'Checking the final-answer phase.');
    await manager.sendComposerMessage(agentId, [
      { type: 'text', text: 'phase-aware mermaid image' },
      { type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' },
    ]);
    const imagePrompt = manager.getAcpSession(agentId).entries
      .filter(item => item.role === 'user')
      .at(-1);
    assert.strictEqual(imagePrompt.content[0].text, 'phase-aware mermaid image');
    assert.strictEqual(imagePrompt.content[1].type, 'image');
    const listed = await manager.listAcpSessions(agentId);
    assert(listed.sessions.some(item => item.sessionId === 'acp-new-session'));
    const rawTranscript = await manager.getAcpTranscript(agentId);
    assert.strictEqual('turns' in rawTranscript, false, 'ACP Turn/Item projection belongs to the frontend');
    assert.strictEqual(rawTranscript.version, 1);
    assert.strictEqual(rawTranscript.agentId, agentId);
    assert.strictEqual(rawTranscript.sessionId, 'acp-new-session');
    assert.strictEqual(rawTranscript.runtimeEpoch, binding.capabilityRuntimeEpoch);
    assert.strictEqual(rawTranscript.replace, true);
    assert.strictEqual(rawTranscript.fromRevision, null);
    assert.strictEqual(rawTranscript.settled, true);
    assert.strictEqual(
      rawTranscript.transcript.entries.find(item => item.role === 'assistant').content[0].text,
      'Checking the final-answer phase.',
    );
    const emptyDelta = await manager.getAcpTranscript(agentId, { sinceRevision: rawTranscript.toRevision });
    assert.strictEqual(emptyDelta.replace, false);
    assert.strictEqual(emptyDelta.fromRevision, rawTranscript.toRevision);
    assert.strictEqual(emptyDelta.toRevision, rawTranscript.toRevision);
    assert.deepStrictEqual(emptyDelta.transcript.entries, []);
    const gapReplacement = await manager.getAcpTranscript(agentId, { sinceRevision: rawTranscript.toRevision + 1 });
    assert.strictEqual(gapReplacement.replace, true);
    assert.strictEqual(gapReplacement.fromRevision, null);
    assert.strictEqual((await manager.forkAcpSession(agentId)).sessionId, 'acp-fork-session');
    binding.modes = {
      currentModeId: 'default',
      availableModes: [
        { id: 'default', name: 'Default' },
        { id: 'plan', name: 'Plan' },
      ],
    };
    assert.strictEqual((await manager.setAcpSessionMode(agentId, 'plan')).modeId, 'plan');
    const subagentResult = await manager.sendComposerMessage(agentId, 'subagent preview');
    assert.strictEqual(subagentResult.stopReason, 'end_turn');
    const subagentDetail = await manager.getAcpToolDetail(agentId, 'subagent-tool');
    assert.strictEqual(subagentDetail.subagentSession.sessionId, 'acp-child-session');
    assert.strictEqual('turns' in subagentDetail.subagentSession, false);
    assert.strictEqual(
      subagentDetail.subagentSession.entries.filter(item => item.role === 'assistant').at(-1).content[0].text,
      'The parser is consistent.',
    );
    assert.strictEqual(nativeMetadataUpdateCount, 0, 'ACP sessions must not update native PTY metadata');
    assert.deepStrictEqual(await manager.logoutAcpAgent(agentId), { loggedOut: true });
    await runtime.restartAgentConnection(agentId);
    const restartedCapabilityRuntimeEpoch = runtime.bindingEpoch(agentId);
    assert.notStrictEqual(
      restartedCapabilityRuntimeEpoch,
      initialCapabilityRuntimeEpoch,
      'an ACP connection replacement must install a fresh capability runtime epoch',
    );
    assert.deepStrictEqual(
      runtime.getSessionRequestOptions(agentId).mcpServers,
      [{ name: 'docs', command: '/bin/docs-mcp', args: [], env: [] }],
      'a replacement runtime must keep provider MCPs without adding Farming MCPs',
    );
    manager.acpPreparedTranscriptCache.deleteAgent(agentId);
    runtime.unregisterAgent(agentId);
    manager.agents.delete(agentId);
    const resumedAgentId = await new Promise(resolve => {
      manager.startAgent('claude --resume acp-new-session', process.cwd(), (id, error) => {
        assert.ifError(error);
        resolve(id);
      }, {
        agentRuntimeMode: 'chat',
        wantsMain: false,
      });
    });
    assert(resumedAgentId);
    const resumedOptions = runtime.getSessionRequestOptions(resumedAgentId);
    assert.strictEqual(resumedOptions.cwd, process.cwd());
    assert.deepStrictEqual(resumedOptions.additionalDirectories, [path.join(process.cwd(), 'docs')]);
    assert.deepStrictEqual(resumedOptions.mcpServers[0], {
      name: 'docs',
      command: '/bin/docs-mcp',
      args: [],
      env: [],
    });
    assert.strictEqual(resumedOptions.mcpServers.length, 1);
  } finally {
    await manager.dispose();
  }

  let customLaunchExecutable = '';
  let persistedCustomAgent = null;
  const customRuntime = new AcpRuntime({
    ...TEST_PROCESS_IDENTITY,
    resolveLaunch: (_provider, options) => {
      customLaunchExecutable = options.executable;
      return { command: process.execPath, args: ['--import', require.resolve('tsx'), fixture], version: 'test' };
    },
  });
  const customManager = new AgentManager(config({
    getAgentHome: () => ({
      id: 'default',
      path: path.join(process.env.HOME, '.codex'),
      acpRuntime: { mode: 'custom', executable: process.execPath },
    }),
    ensureAgentSessionRecord: agent => {
      persistedCustomAgent = { ...agent };
      return 'fsess-custom-runtime';
    },
  }), {
    acpRuntime: customRuntime,
    skipExecutablePreflight: true,
  });
  try {
    const customAgentId = await new Promise(resolve => {
      customManager.startAgent('codex', process.cwd(), (id, error) => {
        assert.ifError(error);
        resolve(id);
      }, { agentRuntimeMode: 'chat', wantsMain: false });
    });
    const customAgent = customManager.agents.get(customAgentId);
    assert.strictEqual(customLaunchExecutable, process.execPath);
    assert.strictEqual(customAgent.acpRuntimeMode, 'custom');
    assert.strictEqual(customAgent.acpRuntimeExecutable, process.execPath);
    assert.strictEqual(persistedCustomAgent.acpRuntimeMode, 'custom');
    assert.strictEqual(persistedCustomAgent.acpRuntimeExecutable, process.execPath);
  } finally {
    await customManager.dispose();
  }

  const sharedProofRuntime = new AcpRuntime();
  sharedProofRuntime.unregisterAgentAndWait = async () => false;
  const persistedStopAttempts = [];
  const sharedProofManager = new AgentManager(config(), {
    acpRuntime: sharedProofRuntime,
    stopPersistedAcpProcessGroup: async identity => {
      persistedStopAttempts.push(identity);
      return { stopped: true };
    },
  });
  const sharedProcessIdentity = {
    kind: 'acp-process-group',
    pid: 42_001,
    processGroupId: 42_001,
    startedAt: 'shared-process-start',
  };
  const sharedAgentRecord = id => ({
    id,
    command: 'codex',
    cwd: process.cwd(),
    projectWorkspace: process.cwd(),
    status: 'running',
    engineStatus: 'running',
    archived: false,
    runtimeBinding: {
      kind: 'acp',
      state: 'idle',
      error: '',
      stopReason: '',
      pendingPermission: null,
      pendingPermissions: [],
      pendingElicitation: null,
      pendingElicitations: [],
      activeElicitations: [],
      sessionRevision: 0,
      sessionUpdatedAt: '',
      supportsFork: false,
      supportsSteer: false,
    },
    structuredRuntimeProcess: { ...sharedProcessIdentity },
  });
  try {
    sharedProofManager.agents.set('shared-target', sharedAgentRecord('shared-target'));
    sharedProofManager.agents.set('shared-peer', sharedAgentRecord('shared-peer'));
    sharedProofRuntime.bindings.set('shared-peer', {});
    const deleted = await sharedProofManager.killAgent('shared-target', {
      persistDeleteOperation: false,
      recordHistory: false,
    });
    assert.strictEqual(deleted.killed, true);
    assert.strictEqual(sharedProofManager.agents.has('shared-target'), false);
    assert.strictEqual(sharedProofManager.agents.has('shared-peer'), true);
    assert.deepStrictEqual(
      persistedStopAttempts,
      [],
      'deleting one Agent must not signal a persisted process still owned by a live shared-runtime peer',
    );
  } finally {
    sharedProofRuntime.bindings.clear();
    await sharedProofManager.dispose();
  }

  const claudeProfileRuntime = new AcpRuntime({
    ...TEST_PROCESS_IDENTITY,
    resolveLaunch: () => ({ command: process.execPath, args: ['--import', require.resolve('tsx'), fixture], version: 'test' }),
  });
  const claudeProfileManager = new AgentManager(config({
    getAgentHome(provider, homeId) {
      assert.strictEqual(provider, 'claude');
      assert.strictEqual(homeId, 'work');
      return {
        id: 'work',
        path: path.join(os.homedir(), '.claude-work'),
        order: 1,
        newAgentDefaults: { model: 'claude-opus-test', reasoning: 'max', fast: 'inherit' },
      };
    },
    getAgentLaunchProfileForHome(provider, homeId) {
      assert.strictEqual(provider, 'claude');
      assert.strictEqual(homeId, 'work');
      return {
        permissionMode: 'default',
        model: 'claude-opus-test',
        effort: 'max',
      };
    },
  }), { acpRuntime: claudeProfileRuntime, skipExecutablePreflight: true });
  try {
    const freshAgentId = await new Promise(resolve => {
      claudeProfileManager.startAgent('claude', process.cwd(), (id, error) => {
        assert.ifError(error);
        resolve(id);
      }, { agentRuntimeMode: 'chat', wantsMain: false, providerHomeId: 'work' });
    });
    const freshBinding = claudeProfileRuntime.bindings.get(freshAgentId);
    assert.strictEqual(freshBinding.env.CLAUDE_CONFIG_DIR, path.join(os.homedir(), '.claude-work'));
    assert.strictEqual(freshBinding.restartOptions.reasoningEffort, 'max');
    assert.strictEqual(
      freshBinding.configOptions.find(option => option.id === 'model')?.currentValue,
      'claude-opus-test',
      'a fresh Claude Chat should apply the selected Home model before its first Prompt',
    );
    assert.strictEqual(
      freshBinding.configOptions.find(option => option.id === 'reasoning')?.currentValue,
      'max',
      'a fresh Claude Chat should apply the selected Home reasoning before its first Prompt',
    );

    const resumedAgentId = await new Promise(resolve => {
      claudeProfileManager.startAgent('claude --resume existing-session', process.cwd(), (id, error) => {
        assert.ifError(error);
        resolve(id);
      }, { agentRuntimeMode: 'chat', wantsMain: false, providerHomeId: 'work' });
    });
    const resumedBinding = claudeProfileRuntime.bindings.get(resumedAgentId);
    assert.strictEqual(
      resumedBinding.configOptions.find(option => option.id === 'model')?.currentValue,
      'gpt-5.5',
      'a resumed Claude Chat must preserve the provider session model',
    );
    assert.strictEqual(
      resumedBinding.configOptions.find(option => option.id === 'reasoning')?.currentValue,
      'high',
      'a resumed Claude Chat must preserve the provider session reasoning',
    );
  } finally {
    await claudeProfileManager.dispose();
  }

  const codexRuntime = new AcpRuntime({
    ...TEST_PROCESS_IDENTITY,
    resolveLaunch: () => ({ command: process.execPath, args: ['--import', require.resolve('tsx'), fixture], version: 'test' }),
  });
  const codexManager = new AgentManager(config({
    getAgentHome(provider, homeId) {
      assert.strictEqual(provider, 'codex');
      assert.strictEqual(homeId, 'work');
      return {
        id: 'work',
        path: path.join(os.homedir(), '.codex-work'),
        order: 1,
        newAgentDefaults: { model: 'gpt-5.6-sol', reasoning: 'high', fast: 'on' },
      };
    },
    getAgentLaunchProfileForHome(provider, homeId) {
      assert.strictEqual(provider, 'codex');
      assert.strictEqual(homeId, 'work');
      return {
        approvalMode: 'approve',
        model: 'gpt-5.6-sol',
        reasoningEffort: 'high',
        serviceTier: 'priority',
        modelPreset: 'gpt-5.6-sol:high',
      };
    },
  }), {
    acpRuntime: codexRuntime,
    agentShellEnvProvider: () => {
      const env = { ...process.env };
      delete env.CODEX_CONFIG;
      return env;
    },
    skipExecutablePreflight: true,
  });
  try {
    const codexAgentId = await new Promise(resolve => {
      codexManager.startAgent('codex', process.cwd(), (id, error) => {
        assert.ifError(error);
        resolve(id);
      }, { agentRuntimeMode: 'chat', wantsMain: false, providerHomeId: 'work' });
    });
    const codexAgent = codexManager.getState().agents.find(agent => agent.id === codexAgentId);
    assert.deepStrictEqual(JSON.parse(codexRuntime.bindings.get(codexAgentId).env.CODEX_CONFIG), {
      model: 'gpt-5.6-sol',
      model_reasoning_effort: 'high',
      service_tier: 'priority',
      developer_instructions: farmingSystemPrompt,
    });
    assert.strictEqual(codexAgent.providerCapabilities.supportsSteer, true);
    assert.strictEqual(codexAgent.runtimeBinding.supportsSteer, true);

    const firstTurn = codexManager.sendComposerMessage(codexAgentId, 'hold for steer');
    while (!codexRuntime.canSteer(codexAgentId)) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    let queuedPromptSettled = false;
    const queuedPrompt = codexManager.sendComposerMessage(
      codexAgentId,
      'phase-aware mermaid after the active turn',
      { delivery: 'prompt' },
    ).then(result => {
      queuedPromptSettled = true;
      return result;
    });
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.strictEqual(
      queuedPromptSettled,
      false,
      'prompt delivery must wait for the active turn instead of becoming a steer',
    );
    const steerResult = await codexManager.sendComposerMessage(codexAgentId, [
      { type: 'text', text: 'inspect the attached image instead' },
      { type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' },
    ], { delivery: 'steer' });
    assert.strictEqual(steerResult.steered, true);
    assert.strictEqual(steerResult.turnId, 'fake-active-turn');
    await firstTurn;
    assert.strictEqual((await queuedPrompt).stopReason, 'end_turn');
    const codexAfterCompletedPrompts = codexManager.agents.get(codexAgentId);
    assert(
      codexAfterCompletedPrompts.attentionSeq >= 2,
      'Codex ACP should create attention for each standard completed Prompt',
    );
    assert.strictEqual(codexAfterCompletedPrompts.attentionReason, 'turn-complete');
    const steeredEntries = codexManager.getAcpSession(codexAgentId).entries;
    const steeredUser = steeredEntries.find(entry => entry.role === 'user' && entry._meta?.codex?.steer === true);
    assert(steeredUser, 'accepted steer should appear once in the ordered ACP transcript');
    assert.strictEqual(steeredUser.content[0].text, 'inspect the attached image instead');
    assert.strictEqual(steeredUser.content[1].type, 'image');
    assert.strictEqual(steeredEntries.filter(entry => entry._meta?.codex?.steer === true).length, 1);

    const orderedTurn = codexManager.sendComposerMessage(codexAgentId, 'hold for two steers');
    while (!codexRuntime.canSteer(codexAgentId)) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const orderedSteers = await Promise.all([
      codexManager.sendComposerMessage(codexAgentId, 'first rapid steer', { delivery: 'steer' }),
      codexManager.sendComposerMessage(codexAgentId, 'second rapid steer', { delivery: 'steer' }),
    ]);
    assert(orderedSteers.every(result => result.steered === true));
    await orderedTurn;
    const orderedUserSteers = codexManager.getAcpSession(codexAgentId).entries
      .filter(entry => entry.role === 'user' && entry._meta?.codex?.steer === true)
      .slice(-2)
      .map(entry => entry.content[0].text);
    assert.deepStrictEqual(orderedUserSteers, ['first rapid steer', 'second rapid steer']);

    const originalSteer = codexRuntime.steer.bind(codexRuntime);
    const raceTurn = codexManager.sendComposerMessage(codexAgentId, 'hold for steer');
    while (!codexRuntime.canSteer(codexAgentId)) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    codexRuntime.steer = async agentId => {
      await originalSteer(agentId, 'release turn before fallback');
      const error = Object.assign(new Error('Invalid request'), {
        data: { details: 'expected active turn id old but found new' },
      });
      throw error;
    };
    const raceFallbackPromise = codexManager.sendComposerMessage(
      codexAgentId,
      'phase-aware mermaid after steer race',
    );
    const raceFollowerPromise = codexManager.sendComposerMessage(
      codexAgentId,
      'phase-aware mermaid after ordered fallback',
    );
    const [raceFallback, raceFollower] = await Promise.all([raceFallbackPromise, raceFollowerPromise]);
    assert.strictEqual(raceFallback.steered, undefined);
    assert.strictEqual(raceFallback.stopReason, 'end_turn');
    assert.strictEqual(raceFollower.stopReason, 'end_turn');
    await raceTurn;
    assert.deepStrictEqual(
      codexManager.getAcpSession(codexAgentId).entries
        .filter(entry => entry.role === 'user' && entry._meta?.codex?.steer !== true)
        .slice(-2)
        .map(entry => entry.content[0].text),
      ['phase-aware mermaid after steer race', 'phase-aware mermaid after ordered fallback'],
      'a steer fallback must retain its original Composer admission order',
    );

    const ambiguousTurn = codexManager.sendComposerMessage(codexAgentId, 'hold for steer');
    while (!codexRuntime.canSteer(codexAgentId)) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const entriesBeforeAmbiguousFailure = codexManager.getAcpSession(codexAgentId).entries.length;
    codexRuntime.steer = async () => {
      throw new Error('ACP request timed out');
    };
    await assert.rejects(
      codexManager.sendComposerMessage(codexAgentId, 'do not replay this ambiguous steer'),
      /timed out/,
    );
    assert.strictEqual(
      codexManager.getAcpSession(codexAgentId).entries.length,
      entriesBeforeAmbiguousFailure,
      'an ambiguous steer failure must not replay as a new prompt',
    );
    codexRuntime.steer = originalSteer;
    await originalSteer(codexAgentId, 'release turn after ambiguous failure');
    await ambiguousTurn;

    const interruptedTurn = codexManager.sendComposerMessage(codexAgentId, 'mobile interrupt');
    while (!codexRuntime.canSteer(codexAgentId)) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const queuedAfterInterrupt = codexManager.sendComposerMessage(
      codexAgentId,
      'phase-aware mermaid after interrupt',
    );
    await new Promise(resolve => setImmediate(resolve));
    await codexManager.interruptAgent(codexAgentId);
    assert.strictEqual((await interruptedTurn).stopReason, 'cancelled');
    assert.strictEqual((await queuedAfterInterrupt).stopReason, 'end_turn');
    assert.deepStrictEqual(
      codexManager.getAcpSession(codexAgentId).entries
        .filter(entry => entry.role === 'user' && entry._meta?.codex?.steer !== true)
        .slice(-2)
        .map(entry => entry.content[0].text),
      ['mobile interrupt', 'phase-aware mermaid after interrupt'],
      'a message admitted during cancellation must wait for the old Turn and start exactly once afterward',
    );
  } finally {
    await codexManager.dispose();
  }

  const openCodeRuntime = new AcpRuntime({
    ...TEST_PROCESS_IDENTITY,
    resolveLaunch: () => ({ command: process.execPath, args: ['--import', require.resolve('tsx'), fixture], version: 'test' }),
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
    assert.strictEqual(openCodeAgent.runtimeBinding.kind, 'acp');
    assert.strictEqual(openCodeAgent.providerSessionProvider, 'opencode');
    assert.strictEqual(openCodeAgent.providerSessionId, 'acp-new-session');
    assert.strictEqual(openCodeAgent.providerSessionSource, 'acp-new');
    assert(openCodeRuntime.bindings.has(openCodeAgentId));
    assert.strictEqual(openCodeAgent.engineStarted, false);
  } finally {
    await openCodeManager.dispose();
  }

  const providerFarmingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-provider-bootstrap-'));
  const providerStartupPromptFile = ensureFarmingAgentBootstrapFile(providerFarmingDir);
  const providerRuntime = new AcpRuntime({
    ...TEST_PROCESS_IDENTITY,
    resolveLaunch: () => ({ command: process.execPath, args: ['--import', require.resolve('tsx'), fixture], version: 'test' }),
  });
  const providerManager = new AgentManager(config({ farmingDir: providerFarmingDir }), {
    acpRuntime: providerRuntime,
    skipExecutablePreflight: true,
  });
  providerManager.providerSessionService.observe = () => {};
  try {
    for (const { provider, command } of [
      { provider: 'claude', command: 'claude' },
      { provider: 'opencode', command: 'opencode' },
      { provider: 'qoder', command: 'qoder' },
      { provider: 'qwen', command: 'qwen' },
    ]) {
      const providerAgentId = await new Promise(resolve => {
        providerManager.startAgent(command, process.cwd(), (id, error) => {
          assert.ifError(error);
          resolve(id);
        }, {
          agentRuntimeMode: 'chat',
          codexServiceTier: 'default',
          wantsMain: false,
        });
      });
      assert(providerAgentId, `${provider} ACP should start`);
      const providerAgent = providerManager.agents.get(providerAgentId);
      assert.strictEqual(providerAgent.providerSessionProvider, provider);
      assert.strictEqual(providerAgent.runtimeBinding.kind, 'acp');
      const providerBinding = providerRuntime.bindings.get(providerAgentId);
      assert.strictEqual(providerBinding.env.FARMING_AGENT_TITLE_TOKEN, undefined);
      assert.match(
        providerBinding.agentContext,
        new RegExp(`当前 Farming Agent 名字是 ${providerAgentId}`),
        `${provider} ACP must receive its Agent name as Session context`,
      );
      assert.strictEqual(
        providerBinding.env.FARMING_CLI_BIN_DIR,
        path.join(__dirname, '..', '..', 'bin'),
        `${provider} ACP must receive the exact Farming CLI directory`,
      );
      assert.strictEqual(
        providerBinding.restartOptions.farmingSystemPrompt,
        farmingSystemPrompt,
        `${provider} ACP must retain the Farming bootstrap across connection recovery`,
      );
      if (provider === 'claude') {
        assert.strictEqual(
          providerBinding.sessionRequestOptions._meta?.systemPrompt?.append,
          farmingSystemPrompt,
          'Claude ACP must receive the Farming bootstrap as appended system context',
        );
      }
      if (provider === 'opencode') {
        assert.deepStrictEqual(
          JSON.parse(providerBinding.env.OPENCODE_CONFIG_CONTENT).instructions,
          [providerStartupPromptFile],
          'OpenCode ACP must receive the Farming bootstrap through process-local instructions',
        );
      }
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
      const attentionSeqBeforePrompt = providerAgent.attentionSeq || 0;
      const promptResult = await providerManager.sendComposerMessage(
        providerAgentId,
        `phase-aware mermaid ${provider} completion notification matrix`,
      );
      assert.strictEqual(promptResult.stopReason, 'end_turn');
      assert.strictEqual(
        providerAgent.attentionSeq,
        attentionSeqBeforePrompt + 1,
        `${provider} ACP end_turn should create one completion attention event`,
      );
      assert.strictEqual(providerAgent.attentionReason, 'turn-complete');
      assert.match(providerAgent.attentionSummary, /^Phase-aware rich answer\./);
    }
  } finally {
    await providerManager.dispose();
    fs.rmSync(providerFarmingDir, { recursive: true, force: true });
  }

  const unavailableHostSessionKey = 'agent-session:codex:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const unavailableHostRuntime = {
    bindings: new Map(),
    initialize: async () => {
      throw new Error('host socket missing');
    },
    on: () => {},
    dispose: async () => {},
  };
  const unavailableHostManager = new AgentManager(config({
    getMainPageSessionKeys: () => [unavailableHostSessionKey],
    listAgentSessionRecords: () => [{
      id: 'fsess-unavailable-host',
      runtimeAgentId: 'agent-unavailable-host',
      agentRuntimeMode: 'acp',
      providerSessionProvider: 'codex',
      providerSessionId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      providerSessionKey: unavailableHostSessionKey,
      cwd: process.cwd(),
      archived: false,
    }],
    ensureAgentSessionRecord: () => 'fsess-unavailable-host',
  }), {
    acpRuntime: unavailableHostRuntime,
    skipExecutablePreflight: true,
  });
  try {
    await unavailableHostManager.recoverAcpSessions();
    const unavailableAgent = unavailableHostManager.agents.get('agent-unavailable-host');
    assert(unavailableAgent, 'ACP Host failure should retain the affected Chat row');
    assert.strictEqual(unavailableAgent.runtimeBinding.state, 'error');
    assert.match(unavailableAgent.runtimeBinding.error, /host socket missing/);
    await unavailableHostManager.whenRecovered();
  } finally {
    await unavailableHostManager.dispose();
  }

  const blockedRecoverySessionKey = 'agent-session:codex:11111111-2222-4333-8444-555555555555';
  const blockedRecoveryRuntime = new AcpRuntime();
  const blockedRecoveryManager = new AgentManager(config({
    getMainPageSessionKeys: () => [blockedRecoverySessionKey],
    listAgentSessionRecords: () => [{
      id: 'fsess-blocked-legacy-acp',
      runtimeAgentId: 'agent-blocked-legacy-acp',
      agentRuntimeMode: 'acp',
      providerSessionProvider: 'codex',
      providerSessionId: '11111111-2222-4333-8444-555555555555',
      providerSessionKey: blockedRecoverySessionKey,
      cwd: process.cwd(),
      status: 'running',
    }],
  }), {
    acpRuntime: blockedRecoveryRuntime,
    allowUnprovenLegacyAcpRecovery: false,
    skipExecutablePreflight: true,
  });
  try {
    await blockedRecoveryManager.recoverAcpSessions();
    const blockedAgent = blockedRecoveryManager.agents.get('agent-blocked-legacy-acp');
    assert(blockedAgent, 'fail-closed legacy ACP recovery must keep the Agent visible');
    assert.strictEqual(blockedRecoveryRuntime.hasBinding(blockedAgent.id), false);
    assert.strictEqual(blockedAgent.runtimeBinding.state, 'error');
    assert.match(blockedAgent.runtimeBinding.error, /Legacy ACP process exit cannot be proven/);
    assert.strictEqual(blockedAgent.requiresProcessExitAcknowledgement, true);
    assert.throws(
      () => blockedRecoveryManager.getAcpSession(blockedAgent.id),
      error => (
        error?.code === 'ACP_RUNTIME_UNAVAILABLE'
        && /Legacy ACP process exit cannot be proven/.test(error.message)
      ),
      'session reads must expose the authoritative recovery error instead of a missing binding detail',
    );
    await assert.rejects(
      blockedRecoveryManager.sendComposerMessage(blockedAgent.id, 'must not reach a missing binding'),
      error => (
        error?.code === 'ACP_RUNTIME_UNAVAILABLE'
        && /Legacy ACP process exit cannot be proven/.test(error.message)
      ),
      'composer input must fail with the authoritative recovery error',
    );
  } finally {
    await blockedRecoveryManager.dispose();
  }

  const recoveryRuntime = new AcpRuntime({
    ...TEST_PROCESS_IDENTITY,
    resolveLaunch: () => ({ command: process.execPath, args: ['--import', require.resolve('tsx'), fixture], version: 'test' }),
  });
  const recoverySessionKey = 'agent-session:codex:existing-session';
  const recoveryManager = new AgentManager(config({
    getMainPageSessionKeys: () => [recoverySessionKey],
    listAgentSessionRecords: () => [
      {
        id: 'fsess-recovered',
        runtimeAgentId: 'agent-acp-recovered',
        agentRuntimeMode: 'acp',
        providerSessionProvider: 'codex',
        providerSessionId: 'existing-session',
        providerSessionKey: recoverySessionKey,
        cwd: process.cwd(),
        status: 'running',
      },
      {
        id: 'fsess-hidden-claude',
        runtimeAgentId: 'agent-acp-hidden-claude',
        agentRuntimeMode: 'acp',
        providerSessionProvider: 'claude',
        providerSessionId: 'closed-session',
        providerSessionKey: 'agent-session:claude:closed-session',
        visibleOnMainPage: false,
        cwd: process.cwd(),
        status: 'running',
      },
    ],
  }), {
    acpRuntime: recoveryRuntime,
  });
  try {
    await recoveryManager.recoverAcpSessions();
    const recoveredBinding = recoveryRuntime.bindings.get('agent-acp-recovered');
    assert(recoveredBinding);
    assert.strictEqual(recoveredBinding.env.INITIAL_AGENT_MODE, 'agent-full-access');
    assert.deepStrictEqual(
      Object.keys(JSON.parse(recoveredBinding.env.CODEX_CONFIG)),
      ['developer_instructions'],
      'ACP recovery may restore the Farming bootstrap but must let Codex resolve model settings from its Home',
    );
    assert.strictEqual(
      JSON.parse(recoveredBinding.env.CODEX_CONFIG).developer_instructions,
      farmingSystemPrompt,
      'Codex ACP recovery must restore the same Farming bootstrap',
    );
    assert.strictEqual(
      recoveryManager.agents.has('agent-acp-hidden-claude'),
      false,
      'ACP recovery must not restart a History-only Claude session',
    );
  } finally {
    await recoveryManager.dispose();
  }

  let recoveredQoderExecutable = '';
  const qoderRecoveryRuntime = new AcpRuntime({
    ...TEST_PROCESS_IDENTITY,
    resolveLaunch: (_provider, options) => {
      recoveredQoderExecutable = options.executable;
      return { command: process.execPath, args: ['--import', require.resolve('tsx'), fixture], version: 'test' };
    },
  });
  const qoderRecoverySessionKey = 'agent-session:qoder:existing-session';
  const qoderRecoveryManager = new AgentManager(config({
    getMainPageSessionKeys: () => [qoderRecoverySessionKey],
    listAgentSessionRecords: () => [{
      id: 'fsess-qoder-recovered',
      runtimeAgentId: 'agent-qoder-recovered',
      agentRuntimeMode: 'acp',
      providerSessionProvider: 'qoder',
      providerSessionId: 'existing-session',
      providerSessionKey: qoderRecoverySessionKey,
      cwd: process.cwd(),
      status: 'running',
    }],
  }), {
    acpRuntime: qoderRecoveryRuntime,
  });
  try {
    await qoderRecoveryManager.recoverAcpSessions();
    assert.strictEqual(path.basename(recoveredQoderExecutable), 'qodercli');
    assert.strictEqual(qoderRecoveryManager.agents.get('agent-qoder-recovered').runtimeBinding.kind, 'acp');
  } finally {
    await qoderRecoveryManager.dispose();
  }

  const authoritativeRecord = {
    id: 'fsess-acp-over-stale-pty',
    runtimeAgentId: 'agent-acp-over-stale-pty',
    agentRuntimeMode: 'acp',
    providerSessionProvider: 'codex',
    providerSessionId: 'existing-session',
    providerSessionKey: 'agent-session:codex:existing-session',
    command: 'codex resume existing-session',
    cwd: process.cwd(),
    category: 'coding',
    status: 'running',
  };
  const recoveryWrites = [];
  const stalePtyRuntime = new AcpRuntime({
    ...TEST_PROCESS_IDENTITY,
    resolveLaunch: () => ({ command: process.execPath, args: ['--import', require.resolve('tsx'), fixture], version: 'test' }),
  });
  const stalePtyManager = new AgentManager(config({
    getMainPageSessionKeys: () => [authoritativeRecord.providerSessionKey],
    listAgentSessionRecords: () => [{ ...authoritativeRecord }],
    ensureAgentSessionRecord: agent => {
      recoveryWrites.push(agent.runtimeBinding.kind);
      Object.assign(authoritativeRecord, {
        runtimeAgentId: agent.id,
        agentRuntimeMode: agent.runtimeBinding.kind,
        acpState: agent.runtimeBinding.state,
      });
      return authoritativeRecord.id;
    },
  }), {
    acpRuntime: stalePtyRuntime,
  });
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
    assert.strictEqual(stalePtyManager.agents.get('agent-acp-over-stale-pty').runtimeBinding.kind, 'acp');
    assert(stalePtyRuntime.bindings.has('agent-acp-over-stale-pty'));
    assert(!recoveryWrites.includes('terminal'), 'stale PTY recovery must not overwrite the persisted ACP mode');
  } finally {
    await stalePtyManager.dispose();
  }

  const registrationRuntime = new AcpRuntime({
    ...TEST_PROCESS_IDENTITY,
    resolveLaunch: () => ({ command: process.execPath, args: ['--import', require.resolve('tsx'), fixture], version: 'test' }),
  });
  const prepareAgent = registrationRuntime.prepareAgent.bind(registrationRuntime);
  let releasePrepareAgent;
  const prepareAgentGate = new Promise(resolve => {
    releasePrepareAgent = resolve;
  });
  registrationRuntime.prepareAgent = async (...args) => {
    await prepareAgentGate;
    return prepareAgent(...args);
  };
  let registeredBeforeShellEnvironment = false;
  let shellEnvironmentReads = 0;
  const registrationManager = new AgentManager(config(), {
    acpRuntime: registrationRuntime,
    skipExecutablePreflight: true,
    agentShellEnvProvider: () => {
      shellEnvironmentReads += 1;
      assert(
        registeredBeforeShellEnvironment,
        'Farming-owned ACP launch must publish the connecting Agent before reading the user shell environment',
      );
      return process.env;
    },
  });
  try {
    let registeredAgentId = null;
    let registrationCount = 0;
    let completedAgentId = null;
    let resolveRegisteredAgent;
    const registered = new Promise(resolve => {
      resolveRegisteredAgent = resolve;
    });
    const start = registrationManager.startAgent(
      'claude',
      process.cwd(),
      (agentId, error) => {
        assert.ifError(error);
        completedAgentId = agentId;
      },
      {
        agentRuntimeMode: 'chat',
        wantsMain: false,
        createRequestId: 'registration-before-initialize',
        onAgentRegistered: agentId => {
          registrationCount += 1;
          registeredAgentId = agentId;
          registeredBeforeShellEnvironment = true;
          resolveRegisteredAgent();
        },
      },
    );
    await Promise.race([
      registered,
      new Promise((_, reject) => setTimeout(
        () => reject(new Error('ACP Agent was not registered before initialization')),
        2_000,
      )),
    ]);
    const registeredAgent = registrationManager.agents.get(registeredAgentId);
    assert(registeredAgent);
    assert.strictEqual(registeredAgent.runtimeBinding.kind, 'acp');
    assert.strictEqual(registeredAgent.runtimeBinding.state, 'connecting');
    assert.strictEqual(completedAgentId, null, 'the final start callback must wait for ACP initialization');
    assert.strictEqual(registrationCount, 1, 'a Create request must publish one connecting Agent');
    assert.strictEqual(shellEnvironmentReads, 1, 'ACP environment construction should reuse one post-registration shell read');

    let duplicateCompletedAgentId = null;
    let duplicateRegistrationCount = 0;
    const duplicateStart = registrationManager.startAgent(
      'claude',
      process.cwd(),
      (agentId, error) => {
        assert.ifError(error);
        duplicateCompletedAgentId = agentId;
      },
      {
        agentRuntimeMode: 'chat',
        wantsMain: false,
        createRequestId: 'registration-before-initialize',
        onAgentRegistered: () => {
          duplicateRegistrationCount += 1;
        },
      },
    );
    assert.strictEqual(
      duplicateRegistrationCount,
      0,
      'a concurrent duplicate Create request must join without publishing another Agent',
    );

    releasePrepareAgent();
    assert.strictEqual(await start, registeredAgentId);
    assert.strictEqual(await duplicateStart, registeredAgentId);
    assert.strictEqual(completedAgentId, registeredAgentId);
    assert.strictEqual(duplicateCompletedAgentId, registeredAgentId);
    assert.strictEqual(registrationCount, 1);
    assert.strictEqual(duplicateRegistrationCount, 0);

    const originalConsoleWarn = console.warn;
    const registrationWarnings: unknown[][] = [];
    console.warn = (...args: unknown[]) => {
      registrationWarnings.push(args);
    };
    try {
      const faultedRegistrationAgentId = await registrationManager.startAgent(
        'claude',
        process.cwd(),
        (agentId, error) => assert.ifError(error),
        {
          agentRuntimeMode: 'chat',
          wantsMain: false,
          onAgentRegistered: () => {
            throw new Error('registration observer failed');
          },
        },
      );
      assert(faultedRegistrationAgentId, 'a failed registration observer must not stop ACP startup');
      assert(registrationWarnings.some(args => String(args[0]).includes('Failed to publish registered Agent:')));
    } finally {
      console.warn = originalConsoleWarn;
    }
  } finally {
    releasePrepareAgent?.();
    await registrationManager.dispose();
  }
  console.log('agent manager ACP tests passed');
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
