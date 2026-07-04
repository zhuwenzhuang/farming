const assert = require('assert');
const { resolveInputTargetAgentId } = require('../input-routing');

function run() {
  assert.strictEqual(
    resolveInputTargetAgentId(
      { agentId: 'agent-started', focusedAgentId: 'agent-focused' },
      { agentId: 'agent-explicit', input: 'abc' }
    ),
    'agent-explicit'
  );

  assert.strictEqual(
    resolveInputTargetAgentId(
      { agentId: 'agent-started', focusedAgentId: 'agent-focused' },
      { input: 'abc' }
    ),
    'agent-focused'
  );

  assert.strictEqual(
    resolveInputTargetAgentId(
      { agentId: 'agent-started' },
      { input: 'abc' }
    ),
    'agent-started'
  );

  assert.strictEqual(
    resolveInputTargetAgentId(
      {},
      { input: 'abc' }
    ),
    null
  );

  console.log('test-server-input-routing passed');
}

run();
