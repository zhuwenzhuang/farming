const assert = require('assert');

const {
  crtRuntimeView,
  canSwitchCrtAgentRuntime,
  isCrtRuntimeSwitchShortcut,
} = require('../../frontend/skins/crt/app.js');

assert.strictEqual(crtRuntimeView({ agentRuntimeMode: 'acp' }), 'chat');
assert.strictEqual(crtRuntimeView({ agentRuntimeMode: 'json' }), 'chat');
assert.strictEqual(crtRuntimeView({ agentRuntimeMode: 'terminal' }), 'terminal');

assert.strictEqual(canSwitchCrtAgentRuntime({
  providerSessionProvider: 'codex',
  providerSessionId: 'session-1',
  agentRuntimeMode: 'terminal',
}), true);
assert.strictEqual(canSwitchCrtAgentRuntime({
  providerSessionProvider: 'bash',
  providerSessionId: 'session-1',
}), false);
assert.strictEqual(canSwitchCrtAgentRuntime({
  providerSessionProvider: 'qoder',
  providerSessionId: 'session-1',
  providerSessionTemporary: true,
}), false);
assert.strictEqual(canSwitchCrtAgentRuntime({ providerSessionProvider: 'opencode' }), false);

assert.strictEqual(isCrtRuntimeSwitchShortcut({
  key: 'M',
  ctrlKey: true,
  shiftKey: true,
  metaKey: false,
  altKey: false,
}), true);
assert.strictEqual(isCrtRuntimeSwitchShortcut({
  key: 'm',
  ctrlKey: false,
  shiftKey: true,
  metaKey: true,
  altKey: false,
}), false);
assert.strictEqual(isCrtRuntimeSwitchShortcut({
  key: 'm',
  ctrlKey: true,
  shiftKey: false,
  metaKey: false,
  altKey: false,
}), false);

console.log('CRT runtime switch helper tests passed');
