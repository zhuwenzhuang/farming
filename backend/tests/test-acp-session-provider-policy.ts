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

const { acpSessionProviderPolicy } = require('../acp-session-provider-policy.cjs');
const codexPolicy = acpSessionProviderPolicy('codex');
const airMeta = value => ({ jetbrains: { air: { version: 1, ...value } } });
assert.strictEqual(codexPolicy.messagePhase({ _meta: airMeta({ phase: 'commentary' }) }), 'commentary');
assert.strictEqual(codexPolicy.messagePhase({ _meta: airMeta({ phase: 'final_answer' }) }), 'final_answer');
assert.strictEqual(codexPolicy.messagePhase({ _meta: { codex: { phase: 'final_answer' } } }), 'final_answer');
assert.strictEqual(codexPolicy.messagePhase({ _meta: { jetbrains: { air: { version: 2, phase: 'commentary' } } } }), '');
assert.strictEqual(acpSessionProviderPolicy('claude').messagePhase({ _meta: airMeta({ phase: 'commentary' }) }), '');
const airGoal = { objective: 'Verify AIR', status: 'active', tokensUsed: 10 };
for (const provider of ['codex', 'claude']) {
  const state = new AcpSessionState({ provider, sessionId: `${provider}-air`, cwd: '/tmp' });
  const notification = { sessionId: state.sessionId, update: { sessionUpdate: 'session_info_update', _meta: airMeta({ goal: airGoal }) } };
  state.apply(notification);
  assert.strictEqual(state.goal.objective, 'Verify AIR');
  assert.strictEqual(Object.hasOwn(notification.update._meta, 'goal'), false, 'boundary normalization must not mutate the input');
  state.apply({ sessionId: state.sessionId, update: { sessionUpdate: 'session_info_update', _meta: airMeta({ goal: { objective: 3 } }) } });
  assert.strictEqual(state.goal.objective, 'Verify AIR', 'invalid AIR goal must preserve authoritative state');
  state.apply({ sessionId: state.sessionId, update: { sessionUpdate: 'session_info_update', _meta: airMeta({ goal: null }) } });
  assert.strictEqual(state.goal, null, 'explicit AIR goal clear must remain authoritative');
  state.apply({ sessionId: state.sessionId, update: { sessionUpdate: 'agent_message_chunk', messageId: 'compact', content: { type: 'text', text: 'Summary' }, _meta: airMeta({ contextCompaction: { version: 1 } }) } });
  assert.strictEqual(state.snapshot().entries[0].type, 'compaction');
}
console.log('AIR v1 metadata boundary tests passed');

const phasedState = new AcpSessionState({ provider: 'codex', sessionId: 'codex-phases', cwd: '/tmp' });
for (const phase of ['commentary', 'final_answer']) {
  applyMessage(phasedState, 'codex-phases', 'assistant', 'A repeated answer', { _meta: airMeta({ phase }) });
}
assert.deepStrictEqual(phasedState.snapshot().entries.map(entry => entry._meta.codex.phase), ['commentary', 'final_answer'],
  'the boundary must preserve phase separation and the shared UI metadata contract');
