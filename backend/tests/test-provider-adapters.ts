const assert = require('assert');
const path = require('path');
const {
  assertProviderCatalogIntegrity,
  getProviderAdapter,
  isFreshAcpSessionSource,
  listProviderAdapters,
  listProviderDescriptors,
  normalizeProviderAcpExtensionNotification,
  providerAcpMcpServersError,
  providerAcpSessionSourceError,
  providerArgsContinueSession,
  providerCapabilities,
  providerConversationForkCapability,
  providerForProgram,
  providerAcpRuntimeProfile,
  providerLaunchCommandOptions,
  providerLaunchPermissionMode,
  providerPermissionRestartPolicy,
  providerRequiresStableTerminalSessionAfterInput,
  providerSessionResumeOptions,
  providerSessionIdentityScope,
  providerSessionLaunchProfile,
  providerRequestedLaunchProfile,
  providerSessionIdentityRollbackArgs,
  providerSupportsSharedAcpRuntime,
  providerSupportsRuntime,
  providerTerminalStartupPolicy,
  providerTerminalNotificationRequiresIdle,
  providerTreatsLegacyAcpRequestAsChat,
} = require('../provider-adapters.cjs');

function run() {
  const adapters = listProviderAdapters();
  assert.deepStrictEqual(adapters.map(adapter => adapter.id), ['codex', 'claude', 'opencode', 'qoder', 'qwen', 'pi']);
  const descriptors = listProviderDescriptors();
  assert.deepStrictEqual(descriptors, [
    {
      commands: ['codex'],
      defaultHomeDirectory: '.codex',
      displayName: 'Codex',
      executable: 'codex',
      id: 'codex',
      supportedRuntimes: ['terminal', 'acp'],
    },
    {
      commands: ['claude'],
      defaultHomeDirectory: '.claude',
      displayName: 'Claude Code',
      executable: 'claude',
      id: 'claude',
      supportedRuntimes: ['terminal', 'acp'],
    },
    {
      commands: ['opencode'],
      defaultHomeDirectory: '.opencode',
      displayName: 'OpenCode',
      executable: 'opencode',
      id: 'opencode',
      supportedRuntimes: ['terminal', 'acp'],
    },
    {
      commands: ['qoder', 'qodercli'],
      defaultHomeDirectory: '.qoder',
      displayName: 'Qoder',
      executable: 'qodercli',
      id: 'qoder',
      supportedRuntimes: ['terminal', 'acp'],
    },
    {
      commands: ['qwen'],
      defaultHomeDirectory: '.qwen',
      displayName: 'Qwen Code',
      executable: 'qwen',
      id: 'qwen',
      supportedRuntimes: ['terminal', 'acp'],
    },
    {
      commands: ['pi'],
      defaultHomeDirectory: '.pi/agent',
      displayName: 'Pi',
      executable: 'pi',
      id: 'pi',
      supportedRuntimes: ['terminal', 'acp'],
    },
  ]);
  assert(Object.isFrozen(descriptors), 'the Provider descriptor catalog must be immutable');
  for (const descriptor of descriptors) {
    assert.deepStrictEqual(
      Object.keys(descriptor).sort(),
      ['commands', 'defaultHomeDirectory', 'displayName', 'executable', 'id', 'supportedRuntimes'],
      `${descriptor.id} must expose only the public descriptor whitelist`,
    );
    assert(Object.isFrozen(descriptor), `${descriptor.id} descriptor must be immutable`);
    assert(Object.isFrozen(descriptor.commands), `${descriptor.id} command aliases must be immutable`);
    assert(Object.isFrozen(descriptor.supportedRuntimes), `${descriptor.id} runtimes must be immutable`);
    for (const value of Object.values(descriptor).flat()) {
      assert.notStrictEqual(typeof value, 'function', `${descriptor.id} must not expose Adapter behavior`);
      if (typeof value === 'string') {
        assert.strictEqual(path.isAbsolute(value), false, `${descriptor.id} must not expose absolute paths`);
      }
    }
  }
  assert.doesNotThrow(() => JSON.stringify(descriptors), 'Provider descriptors must be serializable');
  assert.throws(
    () => descriptors.push(descriptors[0]),
    TypeError,
    'the Provider descriptor catalog must reject mutation',
  );
  assert.throws(
    () => descriptors[0].commands.push('replacement'),
    TypeError,
    'Provider command aliases must reject mutation',
  );
  assert.doesNotThrow(() => assertProviderCatalogIntegrity(adapters));
  assert.strictEqual(
    new Set(adapters.map(adapter => adapter.id)).size,
    adapters.length,
    'Provider ids must be globally unique',
  );
  const commandAliases = adapters.flatMap(adapter => adapter.commands);
  assert.strictEqual(
    new Set(commandAliases).size,
    commandAliases.length,
    'Provider command aliases must be globally unique',
  );
  for (const adapter of adapters) {
    assert(
      adapter.commands.includes(adapter.executable),
      `${adapter.id} commands must include its executable`,
    );
  }
  assert.throws(
    () => assertProviderCatalogIntegrity([
      { id: 'alpha', executable: 'alpha', commands: ['alpha'] },
      { id: 'alpha', executable: 'alpha-next', commands: ['alpha-next'] },
    ]),
    /Duplicate Provider id "alpha"/,
  );
  assert.throws(
    () => assertProviderCatalogIntegrity([
      { id: 'alpha', executable: 'alpha', commands: ['alpha', 'shared'] },
      { id: 'beta', executable: 'beta', commands: ['beta', 'shared'] },
    ]),
    /Provider command alias "shared" is declared by both "alpha" and "beta"/,
  );
  assert.throws(
    () => assertProviderCatalogIntegrity([
      { id: 'alpha', executable: 'alpha-cli', commands: ['alpha'] },
    ]),
    /Provider "alpha" commands do not include executable "alpha-cli"/,
  );
  assert.strictEqual(providerForProgram('/usr/local/bin/qodercli'), 'qoder');
  assert.strictEqual(providerForProgram('/opt/homebrew/bin/qwen'), 'qwen');
  assert.strictEqual(providerForProgram('/usr/local/bin/pi'), 'pi');
  assert.strictEqual(providerForProgram('unknown'), '');
  assert.strictEqual(providerArgsContinueSession('codex', ['resume', '--last']), true);
  assert.strictEqual(providerArgsContinueSession('codex', ['--model', 'gpt-5.5']), false);
  assert.strictEqual(providerArgsContinueSession('claude', ['--resume=session-1']), true);
  assert.strictEqual(providerArgsContinueSession('claude', ['--continue']), true);
  assert.strictEqual(providerArgsContinueSession('opencode', ['--continue']), false);
  assert.deepStrictEqual(
    providerSessionIdentityRollbackArgs('codex', 'codex-session-1'),
    ['delete', '--force', 'codex-session-1'],
  );
  assert.deepStrictEqual(
    providerSessionIdentityRollbackArgs('opencode', 'ses_opencode_1'),
    ['session', 'delete', 'ses_opencode_1'],
  );
  assert.strictEqual(providerSessionIdentityRollbackArgs('claude', 'session-1'), null);
  assert.strictEqual(providerSessionIdentityScope('opencode'), 'provider');
  for (const provider of ['codex', 'claude', 'qoder', 'qwen', 'pi', 'unknown']) {
    assert.strictEqual(providerSessionIdentityScope(provider), 'provider-home');
  }
  assert.deepStrictEqual(
    providerSessionResumeOptions('codex', {
      permissionMode: 'full',
      preserveProfile: true,
      requiredCliVersion: '0.100.0',
    }),
    {
      codexApprovalMode: 'full',
      preserveProviderSessionProfile: true,
      requiredCliVersion: '0.100.0',
    },
  );
  assert.deepStrictEqual(
    providerSessionResumeOptions('claude', {
      permissionMode: 'plan',
      preserveProfile: true,
      requiredCliVersion: 'ignored',
    }),
    { claudePermissionMode: 'plan' },
  );
  assert.deepStrictEqual(providerSessionResumeOptions('opencode', { permissionMode: 'full' }), {});
  assert.deepStrictEqual(
    providerSessionLaunchProfile(
      'codex',
      { model: 'gpt-5.5', modelPreset: 'fast', reasoningEffort: 'high', serviceTier: 'priority' },
      true,
    ),
    { model: 'config', modelPreset: 'config', reasoningEffort: 'config', serviceTier: 'config' },
  );
  assert.deepStrictEqual(
    providerSessionLaunchProfile('claude', { model: 'opus', effort: 'high' }, true),
    { model: 'config', effort: 'config' },
  );
  assert.deepStrictEqual(
    providerSessionLaunchProfile('claude', { model: 'opus', effort: 'high' }, false),
    { model: 'opus', effort: 'high' },
  );
  assert.strictEqual(providerLaunchPermissionMode('codex', { approvalMode: 'full' }), 'full');
  assert.strictEqual(providerLaunchPermissionMode('claude', { permissionMode: 'plan' }), 'plan');
  assert.strictEqual(providerLaunchPermissionMode('opencode', { permissionMode: 'full' }), '');
  assert.deepStrictEqual(
    providerAcpRuntimeProfile('codex', {
      model: 'gpt-5.5',
      reasoningEffort: 'high',
      serviceTier: 'priority',
    }),
    { model: 'gpt-5.5', reasoningEffort: 'high', serviceTier: 'priority' },
  );
  assert.deepStrictEqual(
    providerAcpRuntimeProfile('claude', { model: 'opus', effort: 'high' }),
    { model: 'opus', reasoningEffort: 'high', serviceTier: '' },
  );
  assert.strictEqual(providerTreatsLegacyAcpRequestAsChat('codex'), true);
  assert.strictEqual(providerTreatsLegacyAcpRequestAsChat('claude'), false);
  assert.deepStrictEqual(
    providerRequestedLaunchProfile(
      'codex',
      { model: 'home-model', reasoningEffort: 'medium' },
      { codexModel: 'requested-model', codexServiceTier: 'priority' },
    ),
    { model: 'requested-model', reasoningEffort: 'medium', serviceTier: 'priority' },
  );
  assert.deepStrictEqual(
    providerRequestedLaunchProfile(
      'claude',
      { model: 'claude-home-model', effort: 'high' },
      { codexModel: 'must-not-leak' },
    ),
    { model: 'claude-home-model', effort: 'high' },
  );
  assert.deepStrictEqual(
    providerLaunchCommandOptions('codex', {}, { approvalMode: 'full' }, false),
    { codexApprovalMode: 'full' },
  );
  assert.deepStrictEqual(
    providerLaunchCommandOptions('codex', { codexApprovalMode: 'ask' }, { approvalMode: 'full' }, false),
    { codexApprovalMode: 'ask' },
  );
  assert.deepStrictEqual(
    providerLaunchCommandOptions('codex', {}, { approvalMode: 'full' }, true),
    {},
  );
  assert.deepStrictEqual(
    providerLaunchCommandOptions('claude', { claudePermissionMode: 'plan' }, { permissionMode: 'default' }, false),
    { claudePermissionMode: 'plan' },
  );
  assert.deepStrictEqual(
    providerLaunchCommandOptions('claude', {}, { permissionMode: 'plan' }, false),
    {},
  );
  assert.deepStrictEqual(providerPermissionRestartPolicy('codex', 'approve'), {
    displayName: 'Codex',
    freshCommand: 'codex',
    mode: 'approve',
  });
  assert.deepStrictEqual(providerPermissionRestartPolicy('claude', 'plan'), {
    displayName: 'Claude',
    freshCommand: '',
    mode: 'plan',
  });
  assert.strictEqual(providerPermissionRestartPolicy('claude', 'full').mode, '');
  assert.strictEqual(providerPermissionRestartPolicy('opencode', 'full'), null);
  assert.strictEqual(providerRequiresStableTerminalSessionAfterInput('codex'), true);
  assert.strictEqual(providerRequiresStableTerminalSessionAfterInput('claude'), false);
  assert.strictEqual(providerTerminalNotificationRequiresIdle('qwen'), true);
  assert.strictEqual(providerTerminalNotificationRequiresIdle('codex'), false);

  for (const adapter of adapters) {
    assert.strictEqual(getProviderAdapter(adapter.id), adapter);
    assert(adapter.commands.length > 0);
    assert(adapter.executable);
    assert(adapter.homeEnvKey);
    assert(adapter.supportedRuntimes.includes('terminal'));
    assert.strictEqual(typeof adapter.planSession, 'function');
    assert(adapter.acp, `${adapter.id} must declare its ACP launch contract`);
    assert(adapter.acp.version);
    assert(['managed', 'system'].includes(adapter.acp.executablePolicy));
    assert(adapter.usage, `${adapter.id} must declare its usage collection contract`);
    assert(adapter.usage.defaultHomeDirectory.startsWith('.'));
    assert(adapter.usage.source);
  }
  assert.deepStrictEqual(
    Object.fromEntries(adapters.map(adapter => [adapter.id, adapter.usage.collection])),
    {
      codex: {
        kind: 'local-history',
        rootDirectories: ['sessions', 'archived_sessions'],
      },
      claude: {
        kind: 'local-history',
        rootDirectories: ['projects'],
      },
      opencode: {
        collector: 'opencode-session-export',
        kind: 'session-export',
      },
      qoder: { kind: 'unavailable' },
      qwen: { kind: 'unavailable' },
      pi: { kind: 'unavailable' },
    },
  );
  assert.deepStrictEqual(
    Object.fromEntries(adapters.map(adapter => [adapter.id, adapter.usage.liveCollector || null])),
    {
      codex: 'codex-cli',
      claude: 'claude-cli',
      opencode: null,
      qoder: null,
      qwen: null,
      pi: null,
    },
  );
  assert.strictEqual(getProviderAdapter('claude').usage.coverageName, 'Claude');
  assert.strictEqual(getProviderAdapter('codex').acp.executablePolicy, 'managed');
  assert.strictEqual(getProviderAdapter('claude').acp.executablePolicy, 'managed');
  assert.strictEqual(getProviderAdapter('opencode').acp.executablePolicy, 'system');
  assert.deepStrictEqual(providerTerminalStartupPolicy('codex'), {
    serialization: 'provider-home',
    readiness: { kind: 'output-includes', value: '\u001b' },
  });
  for (const provider of ['claude', 'opencode', 'qoder', 'qwen', 'pi', 'unknown']) {
    assert.strictEqual(
      providerTerminalStartupPolicy(provider),
      null,
      `${provider} must not inherit Codex Terminal startup constraints`,
    );
  }
  for (const provider of ['codex', 'claude', 'opencode', 'qoder', 'qwen']) {
    assert.strictEqual(providerSupportsSharedAcpRuntime(provider), true);
  }
  assert.strictEqual(
    providerSupportsSharedAcpRuntime('pi'),
    false,
    'Pi ACP must use one adapter process per Farming Agent because pi-acp has one active Pi child',
  );

  assert.deepStrictEqual(
    normalizeProviderAcpExtensionNotification(
      'qwen',
      'qwen/notify/session/prompt-suggestion',
      {
        v: 1,
        sessionId: 'qwen-session',
        suggestion: 'Run the focused regression tests',
        promptId: 'qwen-session########3',
      },
    ),
    {
      kind: 'prompt-suggestion',
      sessionId: 'qwen-session',
      text: 'Run the focused regression tests',
      promptId: 'qwen-session########3',
    },
  );
  assert.strictEqual(
    normalizeProviderAcpExtensionNotification(
      'qwen',
      'qwen/notify/session/prompt-suggestion',
      { v: 2, sessionId: 'qwen-session', suggestion: 'future', promptId: 'future' },
    ),
    null,
    'unknown Qwen extension versions must be rejected',
  );
  assert.strictEqual(
    normalizeProviderAcpExtensionNotification(
      'qwen',
      'qwen/notify/session/prompt-suggestion',
      { v: 1, sessionId: 'qwen-session', suggestion: 'x'.repeat(501), promptId: 'large' },
    ),
    null,
    'oversized Qwen suggestions must be rejected at the adapter boundary',
  );
  assert.strictEqual(
    normalizeProviderAcpExtensionNotification(
      'codex',
      'qwen/notify/session/prompt-suggestion',
      { v: 1, sessionId: 'codex-session', suggestion: 'wrong provider', promptId: 'wrong' },
    ),
    null,
    'provider extensions must not leak across adapters',
  );

  assert.deepStrictEqual(
    getProviderAdapter('opencode').acp.launch({
      executable: '/bin/opencode',
      cwd: '/tmp/worktree',
      projectWorkspace: '/tmp/project',
    }),
    { command: '/bin/opencode', args: ['acp', '--cwd', '/tmp/project'] },
  );
  const codexFresh = getProviderAdapter('codex').planSession([], ['--model', 'gpt-5.5']);
  assert.strictEqual(codexFresh.precreate, undefined);
  assert.strictEqual(codexFresh.temporary, true);
  assert.match(codexFresh.id, /^tmp_uuid/);
  assert.deepStrictEqual(
    getProviderAdapter('codex').terminalResumeArgs(['--model', 'gpt-5.5'], 'codex-session-1'),
    ['resume', 'codex-session-1', '--model', 'gpt-5.5'],
  );
  const codexPromptArgs = [
    '--add-dir', '../shared',
    '--enable', 'experimental',
    '--disable', 'legacy-mode',
    '-i', 'screen.png',
    'inspect this screenshot',
  ];
  const codexPromptPlan = getProviderAdapter('codex').planSession(codexPromptArgs, codexPromptArgs);
  assert.strictEqual(codexPromptPlan.temporary, true);
  assert.deepStrictEqual(
    getProviderAdapter('codex').terminalResumeArgs(
      codexPromptArgs,
      '019f1234-5678-7abc-8def-0123456789aa',
      codexPromptPlan,
    ),
    [
      'resume', '019f1234-5678-7abc-8def-0123456789aa',
      '--add-dir', '../shared',
      '--enable', 'experimental',
      '--disable', 'legacy-mode',
      '-i', 'screen.png',
      'inspect this screenshot',
    ],
    'Codex resume identity must be inserted before an initial prompt',
  );
  assert.strictEqual(
    getProviderAdapter('codex').planSession(['exec', 'echo hello'], ['exec', 'echo hello']),
    null,
    'Codex non-interactive subcommands must not be rewritten as Terminal sessions',
  );
  assert.strictEqual(
    getProviderAdapter('codex').planSession(['--local-provider', 'ollama'], ['--local-provider', 'ollama']).temporary,
    true,
  );
  const profilePlan = getProviderAdapter('codex').planSession(['-p', 'work'], ['-p', 'work']);
  assert.deepStrictEqual(
    getProviderAdapter('codex').terminalResumeArgs(
      ['-p', 'work'],
      '019f1234-5678-7abc-8def-0123456789ab',
      profilePlan,
    ),
    ['resume', '019f1234-5678-7abc-8def-0123456789ab', '-p', 'work'],
  );
  const multiImagePlan = getProviderAdapter('codex').planSession(
    ['--image', 'a.png', 'b.png'],
    ['--image', 'a.png', 'b.png'],
  );
  assert.deepStrictEqual(
    getProviderAdapter('codex').terminalResumeArgs(
      ['--image', 'a.png', 'b.png'],
      '019f1234-5678-7abc-8def-0123456789ac',
      multiImagePlan,
    ),
    ['resume', '019f1234-5678-7abc-8def-0123456789ac', '--image', 'a.png', 'b.png'],
  );
  const delimiterPlan = getProviderAdapter('codex').planSession(['--', 'hello'], ['--', 'hello']);
  assert.deepStrictEqual(
    getProviderAdapter('codex').terminalResumeArgs(
      ['--', 'hello'],
      '019f1234-5678-7abc-8def-0123456789ad',
      delimiterPlan,
    ),
    ['resume', '019f1234-5678-7abc-8def-0123456789ad', '--', 'hello'],
  );
  assert.strictEqual(
    getProviderAdapter('codex').planSession(['--', 'exec'], ['--', 'exec']).temporary,
    true,
    'a Codex prompt after -- must not be classified as a subcommand',
  );
  assert.strictEqual(
    getProviderAdapter('codex').planSession(
      ['--', 'resume', '019f1234-5678-7abc-8def-0123456789ae'],
      [],
    ).temporary,
    true,
    'Codex words after -- must retain prompt semantics',
  );
  assert.deepStrictEqual(
    getProviderAdapter('codex').planSession(
      ['resume', '--', '019f1234-5678-7abc-8def-0123456789ae'],
      [],
    ),
    {
      id: '019f1234-5678-7abc-8def-0123456789ae',
      temporary: false,
      source: 'resume',
    },
    'a Codex resume session id remains positional after the option delimiter',
  );
  assert.strictEqual(
    getProviderAdapter('codex').planSession(
      ['fork', '--', '019f1234-5678-7abc-8def-0123456789af'],
      [],
    ).forkedFromProviderSessionId,
    '019f1234-5678-7abc-8def-0123456789af',
    'a Codex fork source id remains positional after the option delimiter',
  );
  assert.strictEqual(
    getProviderAdapter('codex').planSession(
      ['resume', 'two words', '019f1234-5678-7abc-8def-0123456789b0'],
      [],
    ),
    null,
    'a UUID-shaped prompt must not replace an earlier Codex session name',
  );
  assert.strictEqual(
    getProviderAdapter('codex').planSession(['resume', 'my-thread'], []),
    null,
    'a safe-character Codex session name must not be persisted as the rollout UUID',
  );
  assert.strictEqual(
    getProviderAdapter('codex').planSession(
      ['resume', '--last', '019f1234-5678-7abc-8def-0123456789b3'],
      [],
    ),
    null,
    'a UUID-shaped --last prompt must not be persisted as the resumed session id',
  );
  assert.strictEqual(
    getProviderAdapter('codex').planSession(
      ['resume', '--image', 'a.png', '019f1234-5678-7abc-8def-0123456789b5'],
      [],
    ),
    null,
    'a UUID-shaped value consumed by multi-image must not be persisted as a session id',
  );
  assert.strictEqual(
    getProviderAdapter('codex').planSession(
      ['resume', '019f1234-5678-7abc-8def-0123456789b6', '--image', 'a.png', 'b.png'],
      [],
    ).id,
    '019f1234-5678-7abc-8def-0123456789b6',
    'an explicit resume id before multi-image remains authoritative',
  );
  assert.strictEqual(
    getProviderAdapter('codex').planSession(
      ['resume', '019F1234-5678-7ABC-8DEF-0123456789B7'],
      [],
    ).id,
    '019f1234-5678-7abc-8def-0123456789b7',
    'a Codex resume UUID is canonicalized before history correlation',
  );
  assert.strictEqual(
    getProviderAdapter('codex').planSession(
      ['fork', '019F1234-5678-7ABC-8DEF-0123456789B8'],
      [],
    ).forkedFromProviderSessionId,
    '019f1234-5678-7abc-8def-0123456789b8',
    'a Codex fork UUID is canonicalized before history correlation',
  );
  assert.strictEqual(
    getProviderAdapter('codex').planSession(
      ['fork', '--last', '019f1234-5678-7abc-8def-0123456789b4'],
      [],
    ).forkedFromProviderSessionId,
    '',
    'a UUID-shaped --last fork prompt must not be persisted as the source session id',
  );
  assert.strictEqual(
    getProviderAdapter('codex').planSession(
      ['resume', '--', '-starts-with-dash', '019f1234-5678-7abc-8def-0123456789b1'],
      [],
    ),
    null,
    'a UUID-shaped prompt must not replace a delimiter-protected Codex session name',
  );
  assert.strictEqual(
    getProviderAdapter('codex').planSession(
      ['fork', 'two words', '019f1234-5678-7abc-8def-0123456789b2'],
      [],
    ).forkedFromProviderSessionId,
    '',
    'a UUID-shaped fork prompt must not replace an earlier Codex session name',
  );
  assert.strictEqual(
    getProviderAdapter('codex').planSession(['--', '--remote'], []).temporary,
    true,
    'a Codex --remote prompt after the delimiter must not select remote mode',
  );
  assert.strictEqual(
    getProviderAdapter('codex').planSession(['--', '--cd', '/tmp'], []).temporary,
    true,
    'a Codex --cd prompt after the delimiter must retain prompt semantics',
  );
  assert.match(
    getProviderAdapter('codex').planSession(['--remote', 'ws://127.0.0.1:9000'], []).error,
    /cannot be correlated with a local resumable session id/,
  );
  const openCodeFresh = getProviderAdapter('opencode').planSession([], ['--auto']);
  assert.strictEqual(openCodeFresh.precreate, true);
  assert.strictEqual(openCodeFresh.temporary, false);
  assert.strictEqual(
    getProviderAdapter('opencode').planSession(['--model', 'openai/gpt-5.5'], ['--model', 'openai/gpt-5.5']).precreate,
    true,
    'OpenCode option values must not be mistaken for a project/subcommand positional',
  );
  assert.deepStrictEqual(
    getProviderAdapter('opencode').terminalResumeArgs(['--auto'], 'ses_opencode_1'),
    ['--auto', '--session', 'ses_opencode_1'],
  );
  assert.deepStrictEqual(
    getProviderAdapter('opencode').terminalResumeArgs(['--', '/tmp'], 'ses_opencode_2'),
    ['--session', 'ses_opencode_2', '--', '/tmp'],
  );
  assert.strictEqual(
    getProviderAdapter('opencode').planSession(['--', 'run'], ['--', 'run']).precreate,
    true,
    'an OpenCode project after -- must not be classified as a subcommand',
  );
  assert.strictEqual(
    getProviderAdapter('opencode').planSession(
      ['--', '--session', 'ses_prompt_value'],
      ['--', '--session', 'ses_prompt_value'],
    ).precreate,
    true,
    'an OpenCode --session value after the delimiter must retain prompt semantics',
  );
  assert.strictEqual(
    getProviderAdapter('opencode').planSession(['--', '--continue'], ['--', '--continue']).precreate,
    true,
    'an OpenCode --continue prompt after the delimiter must not bypass precreation',
  );
  const openCodeProjectPlan = getProviderAdapter('opencode').planSession(
    ['./packages/app', '--model', 'openai/gpt-5.5'],
    ['./packages/app', '--model', 'openai/gpt-5.5'],
  );
  assert.strictEqual(openCodeProjectPlan.precreate, true);
  assert.strictEqual(openCodeProjectPlan.identityWorkspace, './packages/app');
  assert.strictEqual(
    getProviderAdapter('opencode').planSession(['--cors', 'https://a.test', 'https://b.test'], []).precreate,
    true,
    'OpenCode array option values must not be mistaken for subcommands',
  );
  assert.strictEqual(
    getProviderAdapter('opencode').planSession(['run', 'hello'], ['run', 'hello']),
    null,
    'OpenCode subcommands must retain their own lifecycle',
  );
  assert.strictEqual(
    getProviderAdapter('opencode').planSession(['--continue'], ['--continue']),
    null,
    'OpenCode --continue must keep provider-owned continuation semantics',
  );
  assert.deepStrictEqual(providerCapabilities('codex'), {
    supportedRuntimes: ['terminal', 'acp'],
    runtimeSwitch: true,
    contextWindow: true,
    terminalProfile: true,
    terminalComposerInput: 'bracketed-paste',
    slashCommandDiscovery: true,
    goals: false,
    goalSubmission: { terminal: { kind: 'prompt' }, acp: { kind: 'prompt' } },
    conversationFork: {
      terminal: {
        supported: true,
        strategy: 'target-process',
        worktreeModes: ['same-worktree', 'new-worktree'],
        requiresRuntimeCapability: false,
      },
      acp: {
        supported: true,
        strategy: 'source-session',
        worktreeModes: ['same-worktree'],
        requiresRuntimeCapability: true,
      },
    },
    terminalSessionFork: true,
    sessionFork: true,
    chatRuntime: 'acp',
    supportsChat: true,
    supportsSteer: false,
  });
  assert.deepStrictEqual(
    providerCapabilities('claude'),
    {
      supportedRuntimes: ['terminal', 'acp'],
      runtimeSwitch: true,
      contextWindow: false,
      terminalProfile: false,
      terminalComposerInput: 'bracketed-paste',
      slashCommandDiscovery: true,
      goals: false,
      goalSubmission: { terminal: { kind: 'command', prefix: '/goal' }, acp: { kind: 'prompt' } },
      conversationFork: {
        terminal: {
          supported: true,
          strategy: 'target-process',
          worktreeModes: ['same-worktree', 'new-worktree'],
          requiresRuntimeCapability: false,
        },
        acp: {
          supported: true,
          strategy: 'target-process',
          worktreeModes: ['same-worktree'],
          requiresRuntimeCapability: true,
        },
      },
      terminalSessionFork: true,
      sessionFork: true,
      chatRuntime: 'acp',
      supportsChat: true,
      supportsSteer: false,
    },
  );
  assert.deepStrictEqual(
    providerCapabilities('unknown'),
    {
      supportedRuntimes: ['terminal'],
      runtimeSwitch: false,
      contextWindow: false,
      terminalProfile: false,
      terminalComposerInput: 'bracketed-paste',
      slashCommandDiscovery: false,
      goals: false,
      goalSubmission: null,
      conversationFork: {
        terminal: {
          supported: false,
          strategy: null,
          worktreeModes: [],
          requiresRuntimeCapability: false,
        },
        acp: {
          supported: false,
          strategy: null,
          worktreeModes: [],
          requiresRuntimeCapability: false,
        },
      },
      terminalSessionFork: false,
      sessionFork: false,
      chatRuntime: '',
      supportsChat: false,
      supportsSteer: false,
    },
  );
  assert.deepStrictEqual(providerCapabilities('opencode').goalSubmission, {
    terminal: { kind: 'prompt' },
    acp: { kind: 'prompt' },
  });
  assert.deepStrictEqual(providerCapabilities('qoder').goalSubmission, {
    terminal: { kind: 'command', prefix: '/goal set' },
    acp: { kind: 'prompt' },
  });
  assert.strictEqual(providerSupportsRuntime('opencode', 'json'), false);
  assert.strictEqual(providerSupportsRuntime('claude', 'json'), false);
  assert.deepStrictEqual(providerConversationForkCapability('claude', 'acp'), {
    supported: true,
    strategy: 'target-process',
    worktreeModes: ['same-worktree'],
    requiresRuntimeCapability: true,
  });
  assert.deepStrictEqual(providerConversationForkCapability('codex', 'acp'), {
    supported: true,
    strategy: 'source-session',
    worktreeModes: ['same-worktree'],
    requiresRuntimeCapability: true,
  });
  assert.strictEqual(isFreshAcpSessionSource('qoder', 'qoder-session-id'), true);
  assert.deepStrictEqual(
    getProviderAdapter('qoder').acp.launch({ executable: '/bin/qodercli' }),
    { command: '/bin/qodercli', args: ['--acp'] },
  );
  const qwenFresh = getProviderAdapter('qwen').planSession([], []);
  assert.strictEqual(qwenFresh.temporary, false);
  assert.strictEqual(qwenFresh.source, 'qwen-session-id');
  assert.deepStrictEqual(qwenFresh.args.slice(0, 1), ['--session-id']);
  assert.strictEqual(isFreshAcpSessionSource('qwen', 'qwen-session-id'), true);
  assert.deepStrictEqual(
    getProviderAdapter('qwen').terminalResumeArgs(
      ['--approval-mode', 'auto-edit', '--', 'initial prompt'],
      '11111111-1111-4111-8111-111111111111',
    ),
    [
      '--approval-mode', 'auto-edit',
      '--resume', '11111111-1111-4111-8111-111111111111',
      '--', 'initial prompt',
    ],
  );
  assert.deepStrictEqual(
    getProviderAdapter('qwen').acp.launch({
      executable: '/bin/qwen',
      farmingSystemPrompt: 'Farming bootstrap',
    }),
    {
      command: '/bin/qwen',
      args: ['--append-system-prompt', 'Farming bootstrap', '--acp'],
    },
  );
  assert.strictEqual(providerCapabilities('qwen').terminalSessionFork, false);
  assert.strictEqual(providerCapabilities('qwen').sessionFork, true);
  assert.deepStrictEqual(providerCapabilities('qwen').conversationFork, {
    terminal: {
      supported: false,
      strategy: null,
      worktreeModes: [],
      requiresRuntimeCapability: false,
    },
    acp: {
      supported: true,
      strategy: 'source-session',
      worktreeModes: ['same-worktree'],
      requiresRuntimeCapability: true,
    },
  });
  assert.deepStrictEqual(providerCapabilities('qwen').goalSubmission, {
    terminal: { kind: 'prompt' },
    acp: { kind: 'prompt' },
  });
  const piAdapter = getProviderAdapter('pi');
  assert.strictEqual(piAdapter.acp.executablePolicy, 'system');
  assert.strictEqual(piAdapter.acp.packageName, 'pi-acp');
  assert.strictEqual(piAdapter.acp.version, '0.0.33');
  assert.strictEqual(piAdapter.acp.sharedRuntime, false);
  assert.strictEqual(providerArgsContinueSession('pi', ['--session', 'pi-session-1']), true);
  assert.strictEqual(providerArgsContinueSession('pi', ['--fork=pi-session-1']), true);
  assert.strictEqual(providerArgsContinueSession('pi', ['--continue']), true);
  assert.strictEqual(providerArgsContinueSession('pi', ['--model', 'openai/gpt-5.5']), false);

  const piFresh = piAdapter.planSession([], ['--model', 'openai/gpt-5.5']);
  assert.strictEqual(piFresh.temporary, false);
  assert.strictEqual(piFresh.source, 'pi-session-id');
  assert.deepStrictEqual(piFresh.args, ['--session-id', piFresh.id, '--model', 'openai/gpt-5.5']);
  assert.strictEqual(isFreshAcpSessionSource('pi', 'pi-session-id'), true);
  assert.deepStrictEqual(
    piAdapter.planSession(['--session-id', 'pi-session-1'], ['--session-id', 'pi-session-1']),
    {
      id: 'pi-session-1',
      temporary: false,
      source: 'pi-explicit-session-id',
      forkedFromProviderSessionId: '',
    },
  );
  assert.match(
    providerAcpSessionSourceError('pi', 'pi-explicit-session-id'),
    /use --session <id>/,
  );
  assert.strictEqual(providerAcpSessionSourceError('pi', 'resume'), '');
  assert.match(providerAcpSessionSourceError('pi', 'untracked-command'), /cannot preserve/);
  assert.match(
    providerAcpMcpServersError('pi', [{ name: 'docs' }]),
    /does not support ACP MCP servers/,
  );
  assert.strictEqual(providerAcpMcpServersError('pi', []), '');
  assert.strictEqual(providerAcpMcpServersError('claude', [{ name: 'docs' }]), '');
  assert.deepStrictEqual(
    piAdapter.planSession(['--session=pi-session-1'], ['--session=pi-session-1']),
    { id: 'pi-session-1', temporary: false, source: 'resume' },
  );
  const piFork = piAdapter.planSession(['--fork', 'pi-session-1'], ['--fork', 'pi-session-1']);
  assert.strictEqual(piFork.temporary, false);
  assert.strictEqual(piFork.source, 'pi-fork-session-id');
  assert.strictEqual(piFork.forkedFromProviderSessionId, 'pi-session-1');
  assert.deepStrictEqual(piFork.args, ['--session-id', piFork.id, '--fork', 'pi-session-1']);
  assert.match(
    providerAcpSessionSourceError('pi', 'pi-fork-session-id'),
    /does not support the Pi CLI --fork flow/,
  );
  assert.strictEqual(piAdapter.planSession(['--session', '/tmp/session.jsonl'], []), null);
  assert.strictEqual(piAdapter.planSession(['--mode', 'rpc'], []), null);
  assert.strictEqual(piAdapter.planSession(['install', 'some-package'], []), null);
  assert.deepStrictEqual(
    piAdapter.terminalResumeArgs(
      ['--model', 'openai/gpt-5.5', '--', 'initial prompt'],
      'pi-session-1',
    ),
    ['--model', 'openai/gpt-5.5', '--session', 'pi-session-1', '--', 'initial prompt'],
  );

  const piAcpArgs = piAdapter.acp.launchArgs({
    executable: '/opt/bin/pi',
    providerHomePath: '/tmp/pi-agent-home',
    agentId: 'agent/pi 1',
    configDir: '/tmp/farming-config-a',
    farmingSystemPrompt: 'Farming bootstrap',
  });
  assert.deepStrictEqual(piAcpArgs.slice(0, 2), ['--farming-pi-command', '/opt/bin/pi']);
  assert.strictEqual(piAcpArgs.at(-2), '--farming-append-system-prompt');
  assert.strictEqual(piAcpArgs.at(-1), 'Farming bootstrap');
  const stateDir = piAcpArgs[piAcpArgs.indexOf('--farming-pi-acp-state-dir') + 1];
  assert.strictEqual(path.dirname(path.dirname(stateDir)), path.join('/tmp/pi-agent-home', '.farming'));
  const secondPiAcpArgs = piAdapter.acp.launchArgs({
    executable: '/opt/bin/pi',
    providerHomePath: '/tmp/pi-agent-home',
    agentId: 'agent_pi 1',
    configDir: '/tmp/farming-config-a',
  });
  assert.notStrictEqual(
    secondPiAcpArgs[secondPiAcpArgs.indexOf('--farming-pi-acp-state-dir') + 1],
    stateDir,
    'distinct Farming Agent identities must not collide after filesystem-safe Pi ACP projection',
  );
  const secondConfigPiAcpArgs = piAdapter.acp.launchArgs({
    executable: '/opt/bin/pi',
    providerHomePath: '/tmp/pi-agent-home',
    agentId: 'agent/pi 1',
    configDir: '/tmp/farming-config-b',
  });
  assert.notStrictEqual(
    secondConfigPiAcpArgs[secondConfigPiAcpArgs.indexOf('--farming-pi-acp-state-dir') + 1],
    stateDir,
    'the same Agent identity in two Farming Config instances must not share Pi ACP state',
  );
  assert.deepStrictEqual(providerCapabilities('pi'), {
    supportedRuntimes: ['terminal', 'acp'],
    runtimeSwitch: true,
    contextWindow: false,
    terminalProfile: false,
    terminalComposerInput: 'bracketed-paste',
    slashCommandDiscovery: false,
    goals: false,
    goalSubmission: { terminal: { kind: 'prompt' }, acp: { kind: 'prompt' } },
    conversationFork: {
      terminal: {
        supported: true,
        strategy: 'target-process',
        worktreeModes: ['same-worktree', 'new-worktree'],
        requiresRuntimeCapability: false,
      },
      acp: {
        supported: false,
        strategy: null,
        worktreeModes: [],
        requiresRuntimeCapability: false,
      },
    },
    terminalSessionFork: true,
    sessionFork: false,
    chatRuntime: 'acp',
    supportsChat: true,
    supportsSteer: false,
  });
  console.log('provider adapter contract tests passed');
}

run();
