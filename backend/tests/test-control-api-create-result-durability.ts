const assert = require('assert');
const { createControlRouter } = require('../control-api.cjs');

async function run() {
  const agentId = 'agent-undurable-create-result';
  let composerCalls = 0;
  const manager = {
    getState() {
      return {
        agents: [{
          id: agentId,
          command: 'codex',
          cwd: '/repo',
          status: 'running',
          startedAt: 1,
          runtimeBinding: { kind: 'acp', state: 'idle' },
        }],
      };
    },
    startAgent(_command, _workspace, callback) {
      callback(agentId);
    },
    async sendComposerMessage() {
      composerCalls += 1;
    },
    recordCreateRequestResult() {
      return { error: 'simulated Create result disk failure' };
    },
  };
  const router = createControlRouter(manager);
  const createLayer = router.stack.find(layer => (
    layer.route?.path === '/agents'
    && layer.route.methods.post === true
  ));
  assert(createLayer, 'Control Create route must exist');

  let resolveResponse;
  const responsePromise = new Promise<{
    code: string;
    initialInputDelivered: boolean;
    createResultDurable: boolean;
  }>(resolve => {
    resolveResponse = resolve;
  });
  let statusCode = 200;
  const response = {
    status(value) {
      statusCode = value;
      return this;
    },
    json(value) {
      resolveResponse(value);
      return this;
    },
  };
  createLayer.route.stack[0].handle({
    body: {
      command: 'codex',
      workspace: '/repo',
      task: 'deliver exactly once',
      requestId: 'undurable-create-result',
    },
    get() {
      return '';
    },
  }, response);

  const body = await responsePromise;
  assert.strictEqual(statusCode, 409);
  assert.strictEqual(body.code, 'create-result-not-durable');
  assert.strictEqual(body.initialInputDelivered, true);
  assert.strictEqual(body.createResultDurable, false);
  assert.strictEqual(composerCalls, 1);
  console.log('Control Create preserves known delivery outcome when result persistence fails');
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
