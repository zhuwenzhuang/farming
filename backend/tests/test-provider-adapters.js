const assert = require('assert');
const {
  getProviderAdapter,
  isFreshAcpSessionSource,
  listProviderAdapters,
  providerCapabilities,
  providerForProgram,
  providerSupportsRuntime,
} = require('../provider-adapters');

function run() {
  const adapters = listProviderAdapters();
  assert.deepStrictEqual(adapters.map(adapter => adapter.id), ['codex', 'claude', 'opencode', 'qoder']);
  assert.strictEqual(providerForProgram('/usr/local/bin/qodercli'), 'qoder');
  assert.strictEqual(providerForProgram('unknown'), '');

  for (const adapter of adapters) {
    assert.strictEqual(getProviderAdapter(adapter.id), adapter);
    assert(adapter.commands.length > 0);
    assert(adapter.executable);
    assert(adapter.homeEnvKey);
    assert(adapter.supportedRuntimes.includes('terminal'));
    assert.strictEqual(typeof adapter.planSession, 'function');
    assert(adapter.acp, `${adapter.id} must declare its ACP launch contract`);
    assert(adapter.acp.version);
  }

  assert.deepStrictEqual(
    getProviderAdapter('opencode').acp.launch({ executable: '/bin/opencode', cwd: '/tmp/project' }),
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
    supportedRuntimes: ['terminal', 'acp', 'json'],
    runtimeSwitch: true,
    terminalProfile: true,
    goals: false,
    chatRuntime: 'acp',
    supportsChat: true,
    supportsSteer: false,
  });
  assert.deepStrictEqual(
    providerCapabilities('claude'),
    {
      supportedRuntimes: ['terminal', 'acp'],
      runtimeSwitch: true,
      terminalProfile: false,
      goals: false,
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
      terminalProfile: false,
      goals: false,
      chatRuntime: '',
      supportsChat: false,
      supportsSteer: false,
    },
  );
  assert.strictEqual(providerSupportsRuntime('opencode', 'json'), true);
  assert.strictEqual(providerSupportsRuntime('claude', 'json'), false);
  assert.strictEqual(isFreshAcpSessionSource('qoder', 'qoder-session-id'), true);
  assert.deepStrictEqual(
    getProviderAdapter('qoder').acp.launch({ executable: '/bin/qodercli' }),
    { command: '/bin/qodercli', args: ['--acp'] },
  );
  console.log('provider adapter contract tests passed');
}

run();
