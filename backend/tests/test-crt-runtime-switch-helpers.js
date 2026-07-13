const assert = require('assert');

const {
  crtRuntimeView,
  canSwitchCrtAgentRuntime,
  isCrtRuntimeSwitchShortcut,
  structuredComposerAction,
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
  key: 'µ',
  code: 'KeyM',
  ctrlKey: false,
  shiftKey: false,
  metaKey: false,
  altKey: true,
}), true);
assert.strictEqual(isCrtRuntimeSwitchShortcut({
  key: 'm',
  code: 'KeyM',
  ctrlKey: false,
  shiftKey: false,
  metaKey: false,
  altKey: true,
}), true);
assert.strictEqual(isCrtRuntimeSwitchShortcut({
  key: 'm',
  code: 'KeyM',
  ctrlKey: true,
  shiftKey: false,
  metaKey: false,
  altKey: true,
}), false);

assert.strictEqual(structuredComposerAction({
  status: 'running',
  agentRuntimeMode: 'acp',
  acpState: 'working',
}, 'queued follow-up'), 'send');
assert.strictEqual(structuredComposerAction({
  status: 'running',
  agentRuntimeMode: 'acp',
  acpState: 'working',
}, ''), 'interrupt');

console.log('CRT runtime switch helper tests passed');
