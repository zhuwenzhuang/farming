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
  assert.deepStrictEqual(providerCapabilities('codex'), {
    supportedRuntimes: ['terminal', 'acp', 'json', 'app-server'],
    runtimeSwitch: true,
    terminalProfile: true,
    goals: true,
    chatRuntime: 'app-server',
    supportsChat: true,
    supportsSteer: true,
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
