const assert = require('assert');
const { readOnlyClientMessageAllowed } = require('../read-only-access.cjs');

function run() {
  for (const type of [
    'business-health-probe',
    'focus-agent',
    'protocol-hello',
    'state-resync',
    'unwatch-workspace-files',
    'watch-workspace-files',
  ]) {
    assert.strictEqual(readOnlyClientMessageAllowed(type), true, `${type} should remain view-only`);
  }

  for (const type of [
    'start-agent',
    'input',
    'composer-input',
    'acp-permission-response',
    'interrupt-agent',
    'resize-agent',
    'clear-terminal',
    'archive-agent',
    'restart-main-agent',
  ]) {
    assert.strictEqual(readOnlyClientMessageAllowed(type), false, `${type} must be rejected`);
  }

  console.log('read-only access assertions passed');
}

run();
