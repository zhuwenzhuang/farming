const assert = require('assert');
const path = require('path');

const { AgentManager } = require('../agent-manager.cjs');
const { AcpRuntime } = require('../acp-runtime.cjs');

const fixture = path.join(__dirname, 'fixtures', 'fake-acp-agent.mts');
const TEST_PROCESS_IDENTITY = {
  describeAcpProcessGroup: async pid => ({
    pid,
    processGroupId: pid,
    startedAt: `test-process-${pid}`,
  }),
};

function clone(value) {
  return value === undefined ? value : JSON.parse(JSON.stringify(value));
}

function persistentConfig(seedRecords = []) {
  const records = new Map(seedRecords.map(record => [record.providerSessionKey, clone(record)]));
  let mainPageSessionKeys = seedRecords.map(record => record.providerSessionKey).filter(Boolean);
  return {
    records,
    getWorkspace: () => process.cwd(),
    getHeartbeatInterval: () => 60_000,
    getTaskHistory: () => [],
    getDangerouslySkipAgentPermissionsByDefault: () => false,
    getAgentLaunchProfiles: () => ({}),
    getCodexApprovalMode: () => 'approve',
    getCodexModel: () => 'config',
    getCodexReasoningEffort: () => 'config',
    getCodexServiceTier: () => 'config',
    getCodexRuntimeMode: () => 'cli',
    getAgentHome: () => ({ id: 'default', path: path.join(process.env.HOME, '.codex') }),
    getAgentLaunchProfileForHome: () => ({
      approvalMode: 'approve',
      model: 'config',
      reasoningEffort: 'config',
      serviceTier: 'config',
      modelPreset: 'config',
    }),
    getMainPageSessionKeys: () => [...mainPageSessionKeys],
    setMainPageSessionKeys(keys) {
      mainPageSessionKeys = [...keys];
      return [...mainPageSessionKeys];
    },
    rememberMainPageSessionKey(key) {
      mainPageSessionKeys = [key, ...mainPageSessionKeys.filter(candidate => candidate !== key)];
      return [...mainPageSessionKeys];
    },
    removeMainPageSessionKey(key) {
      mainPageSessionKeys = mainPageSessionKeys.filter(candidate => candidate !== key);
      return true;
    },
    getAgentSessionRecordForProviderSessionKey(key) {
      return records.has(key) ? clone(records.get(key)) : null;
    },
    listAgentSessionRecords() {
      return [...records.values()].map(clone);
    },
    ensureAgentSessionRecord(agent, patch = {}) {
      const key = String(agent.providerSessionKey || '');
      const id = String(agent.agentRecordId || agent.persistentSessionId || 'agent_fast_config_recovery');
      if (!key) return id;
      const previous = records.get(key) || {};
      records.set(key, {
        ...previous,
        id,
        kind: 'agent',
        runtimeAgentId: agent.id,
        command: agent.command,
        cwd: agent.cwd,
        projectWorkspace: agent.projectWorkspace,
        providerSessionProvider: agent.providerSessionProvider,
        providerSessionId: agent.providerSessionId,
        providerSessionKey: key,
        providerSessionTemporary: false,
        providerHomeId: agent.providerHomeId || 'default',
        acpRuntimeMode: agent.acpRuntimeMode === 'custom' ? 'custom' : 'managed',
        acpRuntimeExecutable: agent.acpRuntimeExecutable || '',
        agentRuntimeMode: agent.runtimeBinding?.kind || 'acp',
        runtimeBinding: clone(agent.runtimeBinding),
        archived: false,
        visibleOnMainPage: true,
        ...clone(patch),
      });
      return id;
    },
  };
}

function runtime() {
  return new AcpRuntime({
    ...TEST_PROCESS_IDENTITY,
    resolveLaunch: () => ({
      command: process.execPath,
      args: ['--import', require.resolve('tsx'), fixture],
      version: 'test',
    }),
  });
}

function shellEnv(fastDefault, extra = {}) {
  return () => ({
    ...process.env,
    FARMING_TEST_ACP_FAST_DEFAULT: fastDefault ? '1' : '0',
    ...extra,
  });
}

function configValue(manager, agentId, configId) {
  return manager.getAcpSession(agentId).configOptions
    .find(option => option.id === configId)?.currentValue;
}

function fastValue(manager, agentId) {
  return configValue(manager, agentId, 'fast-mode');
}

async function startResumedAgent(manager, sessionId) {
  return new Promise(resolve => {
    manager.startAgent(`codex resume ${sessionId}`, process.cwd(), (agentId, error) => {
      assert.ifError(error);
      resolve(agentId);
    }, {
      agentRuntimeMode: 'chat',
      wantsMain: false,
      providerHomeId: 'default',
    });
  });
}

function coldRecord(record, runtimeAgentId) {
  return {
    ...clone(record),
    runtimeAgentId,
    agentRuntimeMode: 'acp',
    runtimeBinding: {
      kind: 'acp',
      state: 'idle',
      error: '',
      stopReason: '',
      supportsSteer: false,
      supportsFork: false,
      pendingPermission: null,
      pendingPermissions: [],
      pendingElicitation: null,
      pendingElicitations: [],
      activeElicitations: [],
      sessionRevision: 0,
      sessionUpdatedAt: '',
    },
    structuredRuntimeProcess: null,
    legacyAcpProcessExitAcknowledgedAt: Date.now(),
    archived: false,
    visibleOnMainPage: true,
  };
}

async function run() {
  const firstConfig = persistentConfig();
  const firstRuntime = runtime();
  const firstManager = new AgentManager(firstConfig, {
    acpRuntime: firstRuntime,
    agentShellEnvProvider: shellEnv(false),
    skipExecutablePreflight: true,
  });
  let persistedFastOn;
  try {
    const agentId = await startResumedAgent(firstManager, 'fast-recovery-session');
    assert.strictEqual(
      fastValue(firstManager, agentId),
      false,
      'a Session without an explicit override must keep the provider/Agent Home default',
    );
    const sessionKey = firstManager.agents.get(agentId).providerSessionKey;
    assert.deepStrictEqual(
      firstConfig.records.get(sessionKey).acpConfigOverrides,
      [],
      'merely observing the provider default must not create a Session override',
    );

    await firstManager.setAcpSessionConfigOption(agentId, 'fast-mode', true);
    assert.strictEqual(fastValue(firstManager, agentId), true);
    assert.deepStrictEqual(firstConfig.records.get(sessionKey).acpConfigOverrides, [
      { configId: 'fast-mode', value: true },
    ]);

    const binding = firstRuntime.bindings.get(agentId);
    binding.activeTurn = { id: 1 };
    await firstManager.setAcpSessionConfigOption(agentId, 'fast-mode', false);
    assert.deepStrictEqual(
      firstConfig.records.get(sessionKey).acpConfigOverrides,
      [{ configId: 'fast-mode', value: true }],
      'a deferred user intent must not replace the durable override before provider confirmation',
    );
    binding.activeTurn = null;
    await firstRuntime.flushDeferredSessionChanges(binding);
    while (binding.deferredConfigFlush) await binding.deferredConfigFlush;
    assert.deepStrictEqual(
      firstConfig.records.get(sessionKey).acpConfigOverrides,
      [{ configId: 'fast-mode', value: false }],
      'a deferred config change becomes durable only after the provider confirms the flush',
    );
    await firstManager.setAcpSessionConfigOption(agentId, 'fast-mode', true);

    await firstRuntime.restartAgentConnection(agentId);
    assert.strictEqual(
      fastValue(firstManager, agentId),
      true,
      'a live ACP process restart must replay the explicit Fast override after session/load',
    );
    persistedFastOn = coldRecord(firstConfig.records.get(sessionKey), 'agent-fast-cold-on');
  } finally {
    await firstManager.dispose();
  }

  const coldOnConfig = persistentConfig([persistedFastOn]);
  const coldOnRuntime = runtime();
  const coldOnManager = new AgentManager(coldOnConfig, {
    acpRuntime: coldOnRuntime,
    agentShellEnvProvider: shellEnv(false),
    skipExecutablePreflight: true,
  });
  let persistedFastOff;
  try {
    await coldOnManager.recoverAcpSessions();
    assert.strictEqual(
      fastValue(coldOnManager, 'agent-fast-cold-on'),
      true,
      'SIGKILL-style cold recovery must replay the private Session Fast override',
    );
    await coldOnManager.setAcpSessionConfigOption('agent-fast-cold-on', 'fast-mode', false);
    const recovered = coldOnManager.agents.get('agent-fast-cold-on');
    persistedFastOff = coldRecord(
      coldOnConfig.records.get(recovered.providerSessionKey),
      'agent-fast-cold-off',
    );
    assert.deepStrictEqual(persistedFastOff.acpConfigOverrides, [
      { configId: 'fast-mode', value: false },
    ]);
  } finally {
    await coldOnManager.dispose();
  }

  const coldOffConfig = persistentConfig([persistedFastOff]);
  const coldOffManager = new AgentManager(coldOffConfig, {
    acpRuntime: runtime(),
    agentShellEnvProvider: shellEnv(true),
    skipExecutablePreflight: true,
  });
  try {
    await coldOffManager.recoverAcpSessions();
    assert.strictEqual(
      fastValue(coldOffManager, 'agent-fast-cold-off'),
      false,
      'an explicit Fast=false override must win over a later true Agent Home default',
    );
  } finally {
    await coldOffManager.dispose();
  }

  const defaultConfig = persistentConfig();
  const defaultManager = new AgentManager(defaultConfig, {
    acpRuntime: runtime(),
    agentShellEnvProvider: shellEnv(true, {
      FARMING_TEST_ACP_MODEL_DEFAULT: 'gpt-5.6-luna',
      FARMING_TEST_ACP_REASONING_DEFAULT: 'ultra',
    }),
    skipExecutablePreflight: true,
  });
  try {
    const agentId = await startResumedAgent(defaultManager, 'home-default-session');
    assert.strictEqual(
      fastValue(defaultManager, agentId),
      true,
      'a different Session without an override must continue to read the current Agent Home default',
    );
    assert.strictEqual(configValue(defaultManager, agentId, 'model'), 'gpt-5.6-luna');
    assert.strictEqual(configValue(defaultManager, agentId, 'reasoning'), 'ultra');
  } finally {
    await defaultManager.dispose();
  }

  const savedModel = { configId: 'model', value: 'gpt-6-astra' };
  const missingModelRecord = coldRecord({
    ...persistedFastOn,
    acpConfigOverrides: [savedModel],
  }, 'agent-missing-model');
  const missingModelConfig = persistentConfig([missingModelRecord]);
  const missingModelRuntime = runtime();
  const missingModelManager = new AgentManager(missingModelConfig, {
    acpRuntime: missingModelRuntime,
    agentShellEnvProvider: shellEnv(false, {
      FARMING_TEST_ACP_MODEL_MATRIX: '1',
      FARMING_TEST_ACP_MODEL_DEFAULT: 'gpt-5.6-sol',
      FARMING_TEST_ACP_OMIT_MODEL: 'gpt-6-astra',
    }),
    skipExecutablePreflight: true,
  });
  try {
    const agentId = 'agent-missing-model';
    await missingModelManager.recoverAcpSessions();
    const sessionKey = missingModelManager.agents.get(agentId).providerSessionKey;
    const assertBlocked = async () => {
      const binding = missingModelRuntime.bindings.get(agentId);
      const entriesBefore = binding.sessionState.entries.length;
      await assert.rejects(
        missingModelRuntime.prompt(agentId, [{ type: 'text', text: 'must not run on Sol' }]),
        /Saved ACP model "gpt-6-astra" has not been restored/,
      );
      assert.strictEqual(binding.activeTurn, null, 'rejected admission must release its Turn');
      assert.strictEqual(binding.state, 'error', 'model restoration failure must remain visible');
      assert.strictEqual(missingModelManager.getAcpSession(agentId).retryableReconnect, true);
      assert.strictEqual(binding.sessionState.entries.length, entriesBefore, 'rejected input must not enter the transcript');
      assert.deepStrictEqual(missingModelConfig.records.get(sessionKey).acpConfigOverrides, [savedModel]);
    };
    assert.strictEqual(configValue(missingModelManager, agentId, 'model'), 'gpt-5.6-sol');
    assert.match(missingModelManager.getAcpSession(agentId).configOverrideWarnings[0].message, /selection is preserved/);
    await assertBlocked();
    assert.strictEqual((await missingModelRuntime.reconnectAgent(agentId)).reconnected, true);
    await assertBlocked();

    // Even a provider that omits the complete model option cannot authorize a fallback prompt.
    let binding = missingModelRuntime.bindings.get(agentId);
    binding.configOptions = binding.configOptions.filter(option => option.id !== 'model');
    await assertBlocked();

    // A successful new catalog allows reconnect to reapply the durable selection.
    binding.restartOptions.env = { ...binding.restartOptions.env, FARMING_TEST_ACP_OMIT_MODEL: '' };
    assert.strictEqual((await missingModelRuntime.reconnectAgent(agentId)).reconnected, true);
    assert.strictEqual(configValue(missingModelManager, agentId, 'model'), 'gpt-6-astra');
    assert.deepStrictEqual(missingModelManager.getAcpSession(agentId).configOverrideWarnings, []);
    assert.strictEqual((await missingModelRuntime.prompt(agentId, [{ type: 'text', text: 'config recovery probe' }])).stopReason, 'end_turn');
    assert.match(JSON.stringify(missingModelRuntime.bindings.get(agentId).sessionState.entries), /Using model gpt-6-astra/);

    // Simulate a later provider model change; Steer must not bypass the same invariant.
    binding = missingModelRuntime.bindings.get(agentId);
    binding.configOptions.find(option => option.id === 'model').currentValue = 'gpt-5.6-sol';
    const turn = missingModelRuntime.beginTurn(binding);
    turn.phase = 'running';
    try {
      await assert.rejects(missingModelRuntime.steer(agentId, [{ type: 'text', text: 'must not steer Sol' }]), /has not been restored/);
    } finally {
      missingModelRuntime.finishTurn(binding, turn, { status: 'test-finished' });
      binding.state = 'idle';
    }

    // User confirmation may replace the saved choice, including while Prompt waits on that mutation.
    binding.env = { ...binding.env, FARMING_TEST_ACP_OMIT_MODEL: 'gpt-6-astra' };
    await missingModelRuntime.restartAgentConnection(agentId);
    const selected = missingModelRuntime.setSessionConfigOption(agentId, 'model', 'gpt-5.6-sol');
    const sent = missingModelRuntime.prompt(agentId, [{ type: 'text', text: 'config recovery probe' }]);
    await selected;
    assert.strictEqual((await sent).stopReason, 'end_turn');
    assert.deepStrictEqual(missingModelConfig.records.get(sessionKey).acpConfigOverrides, [
      { configId: 'model', value: 'gpt-5.6-sol' },
    ]);
    assert.deepStrictEqual(missingModelManager.getAcpSession(agentId).configOverrideWarnings, []);
  } finally {
    await missingModelManager.dispose();
  }

  // Advertised models can still fail restoration. Keep the guard provider-neutral.
  for (const provider of ['codex', 'opencode']) {
    const rejectedModelRuntime = runtime();
    try {
      const agentId = `agent-rejected-model-${provider}`;
      await rejectedModelRuntime.prepareAgent({
        agentId,
        provider,
        cwd: process.cwd(),
        env: shellEnv(false, {
          FARMING_TEST_ACP_MODEL_MATRIX: '1',
          FARMING_TEST_ACP_REJECT_CONFIG_ID: 'model',
        })(),
        configOverrides: [savedModel],
      });
      await assert.rejects(rejectedModelRuntime.prompt(agentId, [{ type: 'text', text: 'rejected model' }]), /has not been restored/);
      assert.deepStrictEqual(rejectedModelRuntime.bindings.get(agentId).restartOptions.configOverrides, [savedModel]);
    } finally {
      await rejectedModelRuntime.dispose();
    }
  }

  const staleOverrideRecord = coldRecord({
    ...persistedFastOn,
    acpConfigOverrides: [
      { configId: 'model', value: 'gpt-5.6-luna' },
      { configId: 'reasoning', value: 'ultra' },
      { configId: 'fast-mode', value: true },
    ],
  }, 'agent-stale-config');
  const staleConfig = persistentConfig([staleOverrideRecord]);
  const staleManager = new AgentManager(staleConfig, {
    acpRuntime: runtime(),
    agentShellEnvProvider: shellEnv(false, {
      FARMING_TEST_ACP_REASONING_DEFAULT: 'ultra',
      FARMING_TEST_ACP_OMIT_FAST: '1',
    }),
    skipExecutablePreflight: true,
  });
  try {
    await staleManager.recoverAcpSessions();
    assert.strictEqual(
      configValue(staleManager, 'agent-stale-config', 'model'),
      'gpt-5.6-luna',
      'recovery must apply a still-supported model override before validating dependent settings',
    );
    assert.strictEqual(
      configValue(staleManager, 'agent-stale-config', 'reasoning'),
      'max',
      'a model capability refresh must retain the provider-selected supported reasoning fallback',
    );
    assert.strictEqual(
      fastValue(staleManager, 'agent-stale-config'),
      undefined,
      'a removed Fast capability must not prevent Session recovery',
    );
    const recovered = staleManager.agents.get('agent-stale-config');
    assert.deepStrictEqual(
      staleConfig.records.get(recovered.providerSessionKey).acpConfigOverrides,
      [{ configId: 'model', value: 'gpt-5.6-luna' }],
      'deterministically incompatible overrides must be removed from private persistence',
    );
    assert.deepStrictEqual(
      staleManager.getAcpSession('agent-stale-config').configOverrideWarnings.map(warning => warning.configId),
      ['reasoning', 'fast-mode'],
      'the usable recovered Session must expose exact warnings for each dropped override',
    );
  } finally {
    await staleManager.dispose();
  }

  const rejectedOverrideRecord = coldRecord(persistedFastOn, 'agent-rejected-config');
  const rejectedConfig = persistentConfig([rejectedOverrideRecord]);
  const rejectedManager = new AgentManager(rejectedConfig, {
    acpRuntime: runtime(),
    agentShellEnvProvider: shellEnv(false, {
      FARMING_TEST_ACP_REJECT_CONFIG_ID: 'fast-mode',
    }),
    skipExecutablePreflight: true,
  });
  try {
    await rejectedManager.recoverAcpSessions();
    assert.strictEqual(
      fastValue(rejectedManager, 'agent-rejected-config'),
      false,
      'an override mutation failure must leave the live provider value authoritative',
    );
    const recovered = rejectedManager.agents.get('agent-rejected-config');
    assert.deepStrictEqual(
      rejectedConfig.records.get(recovered.providerSessionKey).acpConfigOverrides,
      [{ configId: 'fast-mode', value: true }],
      'a provider or transport failure is not proof that the saved override is permanently incompatible',
    );
    assert.deepStrictEqual(
      rejectedManager.getAcpSession('agent-rejected-config').configOverrideWarnings.map(warning => warning.configId),
      ['fast-mode'],
    );
  } finally {
    await rejectedManager.dispose();
  }

  console.log('ACP Session config recovery tests passed');
}

run().catch(error => {
  console.error(error);
  process.exit(1);
});
