const assert = require('assert');

const {
  crtRuntimeView,
  canSwitchCrtAgentRuntime,
  isCrtRuntimeSwitchShortcut,
  structuredComposerAction,
  structuredTranscriptTurns,
  formatCrtCompactTotalValue,
} = require('../../frontend/skins/crt/app.js');

assert.strictEqual(formatCrtCompactTotalValue(2_467_206_586), '2.47B');
assert.strictEqual(formatCrtCompactTotalValue(10_000), '10K');

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
assert.strictEqual(canSwitchCrtAgentRuntime({
  providerSessionProvider: 'codex',
  providerSessionId: 'tmp_uuid_aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
  providerSessionTemporary: true,
  providerSessionSource: 'codex-temporary',
  agentRuntimeMode: 'terminal',
  terminalInputReceived: false,
}), true);
assert.strictEqual(canSwitchCrtAgentRuntime({
  providerSessionProvider: 'codex',
  providerSessionId: 'tmp_uuid_aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
  providerSessionTemporary: true,
  providerSessionSource: 'codex-temporary',
  agentRuntimeMode: 'terminal',
  terminalInputReceived: true,
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

assert.deepStrictEqual(structuredTranscriptTurns({
  protocol: 'acp',
  entries: [
    { type: 'message', role: 'user', content: [{ type: 'text', text: 'First request' }] },
    { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'Working' }] },
    { type: 'tool', title: 'Inspect files', status: 'completed' },
    { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'First answer' }] },
    { type: 'message', role: 'user', content: [{ type: 'text', text: 'Second request' }] },
    { type: 'message', role: 'assistant', internal: true, content: [{ type: 'text', text: 'hidden' }] },
    { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'Second answer' }] },
  ],
}), [{
  userMessage: 'First request',
  finalMessage: 'First answer',
}, {
  userMessage: 'Second request',
  finalMessage: 'Second answer',
}]);

assert.deepStrictEqual(structuredTranscriptTurns({
  turns: [{ userMessage: 'Legacy request', finalMessage: 'Legacy answer' }],
}), [{ userMessage: 'Legacy request', finalMessage: 'Legacy answer' }]);

console.log('CRT runtime switch helper tests passed');
