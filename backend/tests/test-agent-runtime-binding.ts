const assert = require('assert');
const {
  isAgentRuntimeModeRequest,
  installRuntimeBinding,
  publicRuntimeBinding,
  runtimeKind,
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
    supportsRealtime: false,
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
