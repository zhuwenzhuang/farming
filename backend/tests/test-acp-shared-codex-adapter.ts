const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { AcpRuntime } = require('../acp-runtime.cts');

function readRequests(requestLog) {
  if (!fs.existsSync(requestLog)) return [];
  return fs.readFileSync(requestLog, 'utf8')
    .split('\n')
    .filter(Boolean)
    .flatMap(line => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
}

async function waitFor(predicate, message, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${message}`);
}

async function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-shared-codex-adapter-'));
  const codexHome = path.join(root, 'codex-home');
  const requestLog = path.join(root, 'app-server-requests.jsonl');
  const providerResumeGatePrefix = path.join(root, 'provider-resume');
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
      projectWorkspace: root,
      env: {
        ...process.env,
        CODEX_HOME: codexHome,
        CODEX_PATH: fakeCodex,
        FARMING_TEST_MULTI_SESSION: '1',
        FARMING_TEST_REQUEST_LOG_FILE: requestLog,
        FARMING_TEST_PROVIDER_RESUME_GATE_PREFIX: providerResumeGatePrefix,
        FARMING_TEST_EMIT_SUBAGENT_AFTER_RESUME: '1',
        FARMING_AGENT_ID: agentId,
        FARMING_PROJECT_WORKSPACE: root,
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

    const requests = readRequests(requestLog);
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
      assert.strictEqual(environment.FARMING_PROJECT_WORKSPACE, root);
    }

    const firstProviderUpdate = firstBinding.connection.request('providers/set', {
      providerId: 'openai',
      apiType: 'openai',
      baseUrl: 'https://provider-one.invalid/v1',
      headers: {},
    });
    const firstBlockedResume = await waitFor(
      () => readRequests(requestLog).find(request => request.method === 'thread/resume'),
      'replacement app-server thread/resume',
    );
    const forkRequestCount = readRequests(requestLog)
      .filter(request => request.method === 'thread/fork').length;
    const forkPromise = runtime.forkSession('shared-codex-a', { sessionId: first.sessionId });
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.strictEqual(
      readRequests(requestLog).filter(request => request.method === 'thread/fork').length,
      forkRequestCount,
      'session/fork must not reach app-server before the provider update settles',
    );
    fs.writeFileSync(`${providerResumeGatePrefix}.${firstBlockedResume.pid}`, 'resume');
    await firstProviderUpdate;
    const forked = await forkPromise;
    assert.notStrictEqual(forked.sessionId, first.sessionId);

    const firstResume = readRequests(requestLog).find(request => (
      request.method === 'thread/resume' && request.params.threadId === first.sessionId
    ));
    assert(firstResume, 'provider restart must resume the first exact Session');
    const firstResumeEnvironment = firstResume.params.config.shell_environment_policy.set;
    assert.strictEqual(firstResumeEnvironment.FARMING_AGENT_ID, 'shared-codex-a');
    assert.strictEqual(firstResumeEnvironment.FARMING_PROJECT_WORKSPACE, root);
    await waitFor(
      () => firstBinding.sessionState.transcriptSlice().codexSubagents?.agents?.some(agent => (
        agent.threadId === `${first.sessionId}-child`
        && agent.parentThreadId === first.sessionId
      )),
      'replacement app-server subagent transport notification',
    );

    const priorResumePids = new Set(
      readRequests(requestLog)
        .filter(request => request.method === 'thread/resume')
        .map(request => request.pid),
    );
    const secondProviderUpdate = firstBinding.connection.request('providers/disable', {
      providerId: 'openai',
    });
    const secondResume = await waitFor(
      () => readRequests(requestLog).find(request => (
        request.method === 'thread/resume' && !priorResumePids.has(request.pid)
      )),
      'second replacement app-server thread/resume',
    );
    const deleteRequestCount = readRequests(requestLog)
      .filter(request => request.method === 'thread/delete').length;
    const deletePromise = runtime.deleteSession('shared-codex-a', first.sessionId);
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.strictEqual(
      readRequests(requestLog).filter(request => request.method === 'thread/delete').length,
      deleteRequestCount,
      'session/delete must not reach app-server before the provider update settles',
    );
    fs.writeFileSync(`${providerResumeGatePrefix}.${secondResume.pid}`, 'resume');
    await secondProviderUpdate;
    await deletePromise;

    const afterDelete = readRequests(requestLog);
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
