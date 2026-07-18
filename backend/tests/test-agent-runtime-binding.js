const assert = require('assert');
const {
  installRuntimeBinding,
  publicRuntimeBinding,
  RuntimeAgentMap,
  runtimeKind,
  runtimeState,
} = require('../agent-runtime-binding');

function run() {
  assert.deepStrictEqual(publicRuntimeBinding({ agentRuntimeMode: 'terminal' }), { kind: 'terminal' });
  assert.deepStrictEqual(publicRuntimeBinding({
    agentRuntimeMode: 'acp',
    acpState: 'working',
    acpError: '',
    acpPendingPermissions: [{ requestId: 'permission-1' }],
    codexAppServerState: 'idle',
  }), {
    kind: 'acp',
    state: 'working',
    error: '',
    stopReason: '',
    pendingPermission: null,
    pendingPermissions: [{ requestId: 'permission-1' }],
    pendingElicitation: null,
    pendingElicitations: [],
    activeElicitations: [],
    sessionUpdatedAt: '',
    sessionRevision: 0,
  });
  assert.strictEqual(runtimeKind({ runtimeBinding: { kind: 'json', state: 'idle' } }), 'json');
  assert.strictEqual(runtimeState({ runtimeBinding: { kind: 'app-server', state: 'working' } }), 'working');
  assert.deepStrictEqual(
    publicRuntimeBinding({ runtimeBinding: { kind: 'json', state: 'idle', error: '', transcriptUpdatedAt: '' } }),
    { kind: 'json', state: 'idle', error: '', transcriptUpdatedAt: '' },
  );
  const acpAgent = installRuntimeBinding({
    agentRuntimeMode: 'acp',
    acpState: 'working',
    acpPendingPermissions: [{ requestId: 'permission-2' }],
  });
  assert.strictEqual(acpAgent.runtimeBinding.kind, 'acp');
  assert.strictEqual(acpAgent.runtimeBinding.state, 'working');
  assert.strictEqual(Object.keys(acpAgent).includes('acpState'), false);
  acpAgent.acpState = 'idle';
  assert.strictEqual(acpAgent.runtimeBinding.state, 'idle');
  acpAgent.runtimeBinding.state = 'waiting-for-input';
  assert.strictEqual(acpAgent.acpState, 'waiting-for-input');

  const agents = new RuntimeAgentMap();
  agents.set('app', {
    codexRuntimeMode: 'app-server',
    agentRuntimeMode: 'terminal',
    codexAppServerState: 'idle',
    codexAppServerHomePath: '/tmp/runtime-home',
  });
  const appAgent = agents.get('app');
  assert.strictEqual(appAgent.runtimeBinding.kind, 'app-server');
  assert.strictEqual(appAgent.runtimeBinding.homePath, '/tmp/runtime-home');
  assert.strictEqual(publicRuntimeBinding(appAgent).homePath, undefined);
  appAgent.codexRuntimeMode = 'cli';
  assert.deepStrictEqual(appAgent.runtimeBinding, { kind: 'terminal' });
  console.log('test-agent-runtime-binding passed');
}

run();
