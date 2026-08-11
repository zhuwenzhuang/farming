const assert = require('assert');
const { AcpSessionState } = require('../acp-session-state.cjs');

function applyMessage(state, sessionId, role, text, options = {}) {
  state.apply({
    sessionId,
    update: {
      sessionUpdate: role === 'user' ? 'user_message_chunk' : 'agent_message_chunk',
      content: { type: 'text', text },
      ...options,
    },
  });
}

const codexState = new AcpSessionState({
  provider: 'codex',
  sessionId: 'codex-policy',
  cwd: '/tmp',
});
applyMessage(
  codexState,
  'codex-policy',
  'user',
  '<farming-agent-context>private routing state</farming-agent-context>',
);
applyMessage(
  codexState,
  'codex-policy',
  'assistant',
  '## Handoff Summary\n\nInternal replay state',
);
const codexEntries = codexState.snapshot().entries;
assert.strictEqual(codexEntries[0].internal, true);
assert.strictEqual(codexEntries[0].content[0].text, '');
assert.strictEqual(codexEntries[1].type, 'compaction');

const genericState = new AcpSessionState({
  provider: 'claude',
  sessionId: 'generic-policy',
  cwd: '/tmp',
});
applyMessage(
  genericState,
  'generic-policy',
  'user',
  '<farming-agent-context>provider-owned visible text</farming-agent-context>',
);
applyMessage(
  genericState,
  'generic-policy',
  'assistant',
  '## Handoff Summary\n\nProvider-owned visible response',
  { _meta: { codex: { phase: 'final_answer' } } },
);
applyMessage(
  genericState,
  'generic-policy',
  'assistant',
  '## Handoff Summary\n\nProvider-owned visible response',
  {
    messageId: 'generic-message-id',
    _meta: { codex: { phase: 'final_answer' } },
  },
);
const genericEntries = genericState.snapshot().entries;
assert.strictEqual(genericEntries[0].internal, undefined);
assert.strictEqual(
  genericEntries[0].content[0].text,
  '<farming-agent-context>provider-owned visible text</farming-agent-context>',
);
assert.strictEqual(genericEntries[1].type, 'message');
assert.strictEqual(
  genericEntries[1].content.map(item => item.text || '').join(''),
  '## Handoff Summary\n\nProvider-owned visible response'
    + '## Handoff Summary\n\nProvider-owned visible response',
  'Codex mirror de-duplication must not apply to another Provider',
);

console.log('ACP session provider policy tests passed');
