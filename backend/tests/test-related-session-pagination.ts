import assert from 'node:assert/strict';
import { AcpSessionState } from '../acp-session-state.cts';
import { relatedSessionCounts, relatedSessionStatusLabel, relatedSessionIndicator } from '../../src/components/code/related-session-status';
import { codeCopyForLanguage } from '../../src/components/code/copy';

const state = new AcpSessionState({ provider: 'codex', sessionId: 'child' });
function append(index: number) {
  state.apply({ sessionId: 'child', update: { sessionUpdate: 'user_message_chunk', messageId: `user-${index}`, content: { type: 'text', text: `Question ${index}` } } });
  state.apply({ sessionId: 'child', update: { sessionUpdate: 'agent_message_chunk', messageId: `answer-${index}`, content: { type: 'text', text: `Answer ${index}` } } });
}
for (let i = 0; i < 260; i++) append(i);
const seen = new Set<string>();
let cursor = '';
let pages = 0;
do {
  const page = state.transcriptSlice({ maxTurns: 24, cursor });
  const questions = page.entries.filter(entry => entry.role === 'user');
  assert(questions.length <= 24);
  for (const question of questions) {
    assert(!seen.has(String(question.id)), 'pages must not repeat turns');
    seen.add(String(question.id));
  }
  cursor = page.nextCursor || '';
  if (++pages === 1) append(260); // New live output must not move an older-page boundary.
} while (cursor);
assert.equal(seen.size, 260);
assert(seen.has('user-0'));
assert.throws(() => state.transcriptSlice({ cursor: 'missing', maxTurns: 24 }), /cursor/);
assert.equal(state.transcriptSlice({ maxTurns: 1 }).entries[0]?.id, 'user-260');
assert.deepEqual(relatedSessionCounts(['running', 'completed', 'idle', 'failed', 'unknown', 'waiting-for-permission']), { running: 1, attention: 3, finished: 2 });
for (const language of ['en', 'zh'] as const) {
  const copy = codeCopyForLanguage(language);
  assert.equal(relatedSessionStatusLabel('idle', copy), relatedSessionStatusLabel('completed', copy));
  assert.notEqual(relatedSessionStatusLabel('unknown', copy), '');
  assert.notEqual(relatedSessionStatusLabel('idle', copy, 'cancelled'), relatedSessionStatusLabel('idle', copy));
}
console.log('related session paging and status tests passed');

const copy = codeCopyForLanguage('en');
assert.equal(relatedSessionIndicator('child', 'running', copy).turnActive, true);
assert.equal(relatedSessionIndicator('child', 'running', copy).lifecycleStatus, 'running');
assert.equal(relatedSessionIndicator('child', 'completed', copy).statusIndicatorVisible, false);
assert.equal(relatedSessionIndicator('child', 'waiting-for-input', copy).lifecycleStatus, 'pending');
assert.equal(relatedSessionIndicator('child', 'failed', copy).failureMessage, 'Failed');
assert.equal(relatedSessionIndicator('child', 'unknown', copy).statusIndicatorVisible, true);
