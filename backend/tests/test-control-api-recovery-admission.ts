const assert = require('assert');
const { createControlRouter } = require('../control-api.cjs');

async function run() {
  const router = createControlRouter({
    async requestKillAgent() {
      throw new Error('simulated Agent lifecycle recovery failure');
    },
  });
  const deleteLayer = router.stack.find(layer => (
    layer.route?.path === '/agents/:agentId'
    && layer.route.methods.delete === true
  ));
  assert(deleteLayer, 'Control Delete route must exist');

  let statusCode = 200;
  let body = null;
  const response = {
    status(value) {
      statusCode = value;
      return this;
    },
    json(value) {
      body = value;
      return this;
    },
  };
  await deleteLayer.route.stack[0].handle(
    { params: { agentId: 'agent-recovery-failed' } },
    response,
  );

  assert.strictEqual(statusCode, 503);
  assert.strictEqual(body.retryable, true);
  assert.match(body.error, /recovery failure/);
  console.log('Control Delete surfaces Agent recovery failure as retryable 503');
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
