const assert = require('assert');
const {
  CHAT_MODE,
  chatCapabilitiesForProvider,
  chatRuntimeForProvider,
  isChatMode,
} = require('../chat-runtime');

assert.strictEqual(CHAT_MODE, 'chat');
assert.strictEqual(isChatMode('chat'), true);
assert.strictEqual(isChatMode('acp'), false);
assert.strictEqual(chatRuntimeForProvider('codex'), 'acp');
assert.strictEqual(chatRuntimeForProvider('claude'), 'acp');
assert.deepStrictEqual(chatCapabilitiesForProvider('codex'), {
  chatRuntime: 'acp',
  supportsChat: true,
  supportsSteer: false,
});
assert.deepStrictEqual(chatCapabilitiesForProvider('opencode'), {
  chatRuntime: 'acp',
  supportsChat: true,
  supportsSteer: false,
});

console.log('chat runtime routing tests passed');
