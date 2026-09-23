const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AcpRuntime } = require('../acp-runtime.cts');

async function bounded(promise, label) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), 5000);
    })]);
  } finally { clearTimeout(timer); }
}

async function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-background-child-'));
  const runtime = new AcpRuntime();
  const gate = path.join(root, 'complete-child');
  const log = path.join(root, 'requests.jsonl');
  try {
    const session = await runtime.prepareAgent({
      agentId: 'background-parent', provider: 'codex', cwd: root, projectWorkspace: root,
      providerHomeId: 'background-test', providerHomePath: root,
      env: { ...process.env, CODEX_HOME: root,
        CODEX_PATH: path.join(__dirname, 'fixtures/fake-codex-app-server.ts'),
        FARMING_TEST_BACKGROUND_CHILD: '1', FARMING_TEST_CHILD_COMPLETION_GATE: gate,
        FARMING_TEST_REQUEST_LOG_FILE: log,
      },
    });
    const childId = `${session.sessionId}-child`;
    const inventory = await runtime.listSubagents('background-parent');
    assert.equal(inventory.children[0].sessionId, childId, 'fresh inventory discovers children without retained events');
    assert.equal(inventory.children[0].title, 'Background reviewer');
    const prompt = text => bounded(runtime.submitMessage('background-parent', [{ type: 'text', text }], { delivery: 'prompt' }), text);
    await prompt('Start background review');
    assert.equal(runtime.getSession('background-parent').state, 'idle');
    assert.equal(runtime.getSession('background-parent').canSteer, false);
    assert.equal(runtime.getSubagentTranscriptSession('background-parent', childId).state, 'working', 'parent completion must not terminate children');
    await prompt('Continue parent work while child is running');
    assert.equal(runtime.getSession('background-parent').state, 'idle');
    const child = runtime.getSubagentTranscriptSession('background-parent', childId);
    assert.equal(child.state, 'working');
    assert(JSON.stringify(child).includes('Child update during turn-parent-2.'), 'child routing survives replacement parent prompt subscription');
    assert.equal((await prompt('Cancel parent only')).stopReason, 'cancelled');
    assert.equal(runtime.getSubagentTranscriptSession('background-parent', childId).state, 'working',
      'parent cancellation must not synthesize a terminal child event');
    fs.writeFileSync(gate, 'complete');
    assert.equal((await runtime.listSubagents('background-parent')).children[0].state, 'completed');
    await bounded((async () => {
      while (runtime.getSubagentTranscriptSession('background-parent', childId).state !== 'idle') {
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    })(), 'child completion after parent prompt');
    assert(JSON.stringify(runtime.getSubagentTranscriptSession('background-parent', childId)).includes('Child finished after parent prompt returned.'));
    assert.equal(runtime.getSession('background-parent').state, 'idle', 'child completion must not change the parent turn');
    const requests = fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
    assert(requests.filter(request => request.method === 'thread/list' && request.params.ancestorThreadId)
      .every(request => request.params.sourceKinds.includes('subAgent')));
    assert(requests.filter(request => request.method === 'thread/turns/list' && request.params.threadId === childId)
      .every(request => request.params.limit === 1), 'inventory reads only the latest child turn');
    assert.equal(requests.filter(request => request.method === 'turn/start' && request.params.threadId === session.sessionId).length, 3, 'each user prompt is dispatched exactly once');
    assert(!requests.some(request => request.method === 'thread/resume' || request.method === 'turn/interrupt'));
    const connection = runtime.bindings.get('background-parent').connection;
    const originalExtMethod = connection.extMethod;
    try {
      connection.extMethod = async () => ({ sessionId: 'another-parent', children: [] });
      await assert.rejects(runtime.listSubagents('background-parent'), /Invalid or stale/);
      connection.extMethod = async () => { throw new Error('Provider inventory unavailable'); };
      await assert.rejects(runtime.listSubagents('background-parent'), /Provider inventory unavailable/,
        'fresh read failure must not silently return the retained inventory');
    } finally { connection.extMethod = originalExtMethod; }
  } finally {
    await runtime.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
  console.log('ACP independent parent/child lifecycle tests passed');
}
run().catch(error => { console.error(error); process.exitCode = 1; });
