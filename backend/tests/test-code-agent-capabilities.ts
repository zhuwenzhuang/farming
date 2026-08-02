const assert = require('assert');
const { importTsModule } = require('./helpers/import-ts-module');

const {
  canForkAgentConversation,
  capabilitiesForAgent,
} = importTsModule('src/components/code/capabilities.ts');

function agent(provider, goalSubmission, overrides = {}) {
  const providerManaged = provider !== 'shell';
  return {
    id: `agent-${provider}`,
    runtimeBinding: { kind: 'terminal' },
    runtimeObservation: { kind: provider === 'shell' ? 'shell' : 'process', phase: 'idle' },
    providerSessionProvider: providerManaged ? provider : '',
    providerSessionId: providerManaged ? '11111111-2222-4333-8444-555555555555' : '',
    providerSessionTemporary: false,
    providerCapabilities: {
      goalSubmission,
      runtimeSwitch: providerManaged,
      terminalProfile: provider === 'codex',
      terminalSessionFork: providerManaged && provider !== 'qwen',
      sessionFork: providerManaged,
      supportsChat: providerManaged,
      supportsSteer: false,
    },
    isMain: false,
    canForkNewWorktree: true,
    ...overrides,
  };
}

function run() {
  const codexTerminalCapabilities = capabilitiesForAgent(agent('codex', null)).composer;
  assert.strictEqual(codexTerminalCapabilities.modelPicker, true);
  assert.strictEqual(codexTerminalCapabilities.reasoningEffort, true);
  assert.strictEqual(codexTerminalCapabilities.serviceTier, true);

  for (const provider of ['opencode', 'qoder']) {
    const capabilities = capabilitiesForAgent(agent(provider, {
      terminal: { kind: 'prompt' },
      acp: { kind: 'prompt' },
    })).composer;
    assert.strictEqual(capabilities.goalMode, true, `${provider} should expose Goal mode`);
    assert.strictEqual(capabilities.plusMenu, false, `${provider} should not inherit unrelated provider controls`);
  }

  assert.strictEqual(
    capabilitiesForAgent(agent('shell', null)).composer.goalMode,
    false,
    'plain shells should not expose coding-agent Goal mode'
  );

  const qwenActions = capabilitiesForAgent(agent('qwen', {
    terminal: { kind: 'prompt' },
    acp: { kind: 'prompt' },
  })).actions;
  assert.strictEqual(qwenActions.forkSameWorktree, false);
  assert.strictEqual(qwenActions.forkNewWorktree, false);

  const qoderActions = capabilitiesForAgent(agent('qoder', {
    terminal: { kind: 'command', prefix: '/goal set' },
    acp: { kind: 'prompt' },
  })).actions;
  assert.strictEqual(qoderActions.forkSameWorktree, true);
  assert.strictEqual(qoderActions.forkNewWorktree, true);

  const shellActions = capabilitiesForAgent(agent('shell', null)).actions;
  assert.strictEqual(shellActions.forkSameWorktree, true);
  assert.strictEqual(shellActions.forkNewWorktree, true);

  assert.strictEqual(canForkAgentConversation(agent('qwen', null, {
    runtimeBinding: { kind: 'acp', supportsFork: false },
  })), false);
  assert.strictEqual(canForkAgentConversation(agent('qwen', null, {
    runtimeBinding: { kind: 'acp', supportsFork: true },
  })), true);
  assert.strictEqual(canForkAgentConversation(agent('qoder', null, {
    runtimeBinding: { kind: 'acp', supportsFork: true },
  })), true);

  const chatActions = capabilitiesForAgent(agent('codex', null, {
    runtimeBinding: { kind: 'acp', supportsFork: true },
  })).actions;
  assert.strictEqual(chatActions.forkSameWorktree, true);
  assert.strictEqual(chatActions.forkNewWorktree, false);

  const undeclaredCodex = capabilitiesForAgent(agent('codex', null, {
    providerCapabilities: {
      goalSubmission: null,
      runtimeSwitch: true,
      terminalProfile: false,
      terminalSessionFork: true,
      sessionFork: true,
      supportsChat: true,
      supportsSteer: false,
    },
  })).composer;
  assert.strictEqual(undeclaredCodex.goalMode, false);
  assert.strictEqual(undeclaredCodex.modelPicker, false);
  assert.strictEqual(undeclaredCodex.reasoningEffort, false);
  assert.strictEqual(undeclaredCodex.serviceTier, false);

  console.log('test-code-agent-capabilities passed');
}

run();
