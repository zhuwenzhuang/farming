const assert = require('assert');
const { publicRuntimeBinding, runtimeKind, runtimeState } = require('../agent-runtime-binding');

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
  console.log('test-agent-runtime-binding passed');
}

run();
