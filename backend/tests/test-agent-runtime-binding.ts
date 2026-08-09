const assert = require('assert');
const {
  isAgentRuntimeModeRequest,
  installRuntimeBinding,
  legacyRuntimeMetadata,
  publicRuntimeBinding,
  runtimeBindingOf,
  runtimeKind,
  runtimeState,
} = require('../agent-runtime-binding.cjs');

function run() {
  assert.strictEqual(isAgentRuntimeModeRequest('terminal'), true);
  assert.strictEqual(isAgentRuntimeModeRequest('acp'), true);
  assert.strictEqual(isAgentRuntimeModeRequest('chat'), true);
  assert.strictEqual(isAgentRuntimeModeRequest('json'), false);
  assert.strictEqual(isAgentRuntimeModeRequest({ mode: 'chat' }), false);

  assert.deepStrictEqual(publicRuntimeBinding({ agentRuntimeMode: 'terminal' }), { kind: 'terminal' });
  assert.deepStrictEqual(publicRuntimeBinding({
    agentRuntimeMode: 'acp',
    acpState: 'working',
    acpError: '',
    acpPendingPermissions: [{ requestId: 'permission-1' }],
  }), {
    kind: 'acp',
    state: 'working',
    error: '',
    stopReason: '',
    supportsSteer: false,
    supportsFork: false,
    pendingPermission: null,
    pendingPermissions: [{ requestId: 'permission-1' }],
    pendingElicitation: null,
    pendingElicitations: [],
    activeElicitations: [],
    sessionUpdatedAt: '',
    sessionRevision: 0,
  });
  assert.strictEqual(runtimeKind({ runtimeBinding: { kind: 'json', state: 'idle' } }), 'terminal');
  assert.deepStrictEqual(
    publicRuntimeBinding({ runtimeBinding: { kind: 'json', state: 'idle', error: '', transcriptUpdatedAt: '' } }),
    { kind: 'terminal' },
  );

  // The JSON-stream runtime is gone: legacy markers resolve to terminal, never a revived json runtime.
  const legacyJsonAgent = {
    agentRuntimeMode: 'json',
    jsonCliState: 'working',
    jsonCliError: 'boom',
    jsonCliEvents: [{ type: 'message' }],
    jsonCliTranscriptUpdatedAt: '2026-08-10T00:00:00.000Z',
  };
  assert.strictEqual(runtimeKind(legacyJsonAgent), 'terminal');
  assert.strictEqual(runtimeState(legacyJsonAgent), '');
  assert.strictEqual(runtimeBindingOf(legacyJsonAgent, 'acp'), null);
  assert.deepStrictEqual(runtimeBindingOf(legacyJsonAgent, 'terminal'), { kind: 'terminal' });
  assert.deepStrictEqual(legacyRuntimeMetadata(legacyJsonAgent), { agentRuntimeMode: 'terminal' });
  const installedJsonAgent = installRuntimeBinding(legacyJsonAgent);
  assert.deepStrictEqual(installedJsonAgent.runtimeBinding, { kind: 'terminal' });
  for (const field of ['agentRuntimeMode', 'jsonCliState', 'jsonCliError', 'jsonCliEvents', 'jsonCliTranscriptUpdatedAt']) {
    assert.strictEqual(field in installedJsonAgent, false);
  }

  const acpAgent = installRuntimeBinding({
    agentRuntimeMode: 'acp',
    acpState: 'working',
    acpPendingPermissions: [{ requestId: 'permission-2' }],
  });
  assert.strictEqual(acpAgent.runtimeBinding.kind, 'acp');
  assert.strictEqual(acpAgent.runtimeBinding.state, 'working');
  assert.strictEqual(Object.keys(acpAgent).includes('acpState'), false);
  assert.strictEqual('acpState' in acpAgent, false);
  acpAgent.runtimeBinding.state = 'idle';
  assert.strictEqual(acpAgent.runtimeBinding.state, 'idle');

  console.log('test-agent-runtime-binding passed');
}

run();
