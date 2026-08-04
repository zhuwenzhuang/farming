const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { AcpRuntime } = require('../acp-runtime.cts');

async function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-shared-codex-adapter-'));
  const codexHome = path.join(root, 'codex-home');
  const requestLog = path.join(root, 'app-server-requests.jsonl');
  const fakeCodex = path.join(__dirname, 'fixtures', 'fake-codex-app-server.ts');
  fs.mkdirSync(codexHome, { recursive: true });
  const runtime = new AcpRuntime();
  try {
    const prepare = agentId => runtime.prepareAgent({
      agentId,
      provider: 'codex',
      providerHomeId: 'shared-test',
      providerHomePath: codexHome,
      cwd: root,
      env: {
        ...process.env,
        CODEX_HOME: codexHome,
        CODEX_PATH: fakeCodex,
        FARMING_TEST_MULTI_SESSION: '1',
        FARMING_TEST_REQUEST_LOG_FILE: requestLog,
        FARMING_AGENT_ID: agentId,
        FARMING_PROJECT_WORKSPACE: root,
        FARMING_CAPABILITY_RUNTIME_EPOCH: `epoch-${agentId}`,
      },
    });
    const [first, second] = await Promise.all([
      prepare('shared-codex-a'),
      prepare('shared-codex-b'),
    ]);

    const firstBinding = runtime.bindings.get('shared-codex-a');
    const secondBinding = runtime.bindings.get('shared-codex-b');
    assert.strictEqual(firstBinding.child.pid, secondBinding.child.pid);
    assert.notStrictEqual(first.sessionId, second.sessionId);

    const requests = fs.readFileSync(requestLog, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line));
    const starts = requests.filter(request => request.method === 'thread/start');
    assert.strictEqual(starts.length, 2);
    assert.deepStrictEqual(
      new Set(starts.map(request => (
        request.params.config.shell_environment_policy.set.FARMING_AGENT_ID
      ))),
      new Set(['shared-codex-a', 'shared-codex-b']),
    );
    for (const request of starts) {
      const environment = request.params.config.shell_environment_policy.set;
      assert.strictEqual(
        environment.FARMING_CAPABILITY_RUNTIME_EPOCH,
        `epoch-${environment.FARMING_AGENT_ID}`,
      );
      assert.strictEqual(environment.FARMING_PROJECT_WORKSPACE, root);
    }

    await runtime.deleteSession('shared-codex-a', first.sessionId);
    const afterDelete = fs.readFileSync(requestLog, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line));
    assert(
      afterDelete.some(request => (
        request.method === 'thread/delete'
        && request.params.threadId === first.sessionId
      )),
      'ACP session/delete must delete the exact app-server thread',
    );
    assert.strictEqual(secondBinding.child.exitCode, null);
  } finally {
    await runtime.dispose().catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  }
  console.log('shared Codex ACP adapter tests passed');
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
