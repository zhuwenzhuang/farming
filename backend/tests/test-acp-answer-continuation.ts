import assert from 'node:assert/strict';
import { AcpSessionState } from '../acp-session-state.cts';
import { acpTranscriptEntries } from '../acp-transcript.cts';
import { projectAcpTranscriptResponse, mergeAcpTranscript } from '../../src/components/code/acp/acp-transcript-envelope';
import { acpProgressFlowEntries } from '../../src/components/code/acp/acp-progress-timeline';
import { projectAcpTranscript } from '../../src/components/code/acp/acp-entry-projection';

for (const provider of ['codex', 'claude', 'qwen']) {
  const state = new AcpSessionState({ provider, sessionId: 'answer-continuation' });
  let active = true;
  const project = (page: ReturnType<typeof state.transcriptSlice>, fromRevision: number | null) => projectAcpTranscriptResponse({
    version: 1, agentId: 'answer-agent', sessionId: state.sessionId, runtimeEpoch: 'answer-epoch',
    fromRevision, toRevision: page.revision, replace: !page.delta, settled: true,
    transcript: { ...page, sessionId: state.sessionId, provider, state: active ? 'working' : 'idle', entries: acpTranscriptEntries(page.entries) },
  }, 'answer-agent');
  const checkpoint = () => project(state.transcriptSlice({ maxTurns: 5, entryPatches: true }), null);
  state.beginPrompt([{ type: 'text', text: 'Investigate the issue' }]);
  let current = checkpoint();
  const step = (mutation: () => void) => {
    const revision = state.revision;
    mutation();
    const merged = mergeAcpTranscript(current, project(state.transcriptSlice({ maxTurns: 5, entryPatches: true, sinceRevision: revision }), revision));
    assert.equal(merged.accepted, true);
    assert.equal(merged.needsCheckpoint, false);
    current = merged.transcript!;
    assert.deepEqual(current.turns, checkpoint().turns, 'each streamed delta must match independent checkpoint projection');
    return current.turns[0]!;
  };
  const message = (messageId: string, phase: string, content: Record<string, unknown>) => state.apply({
    sessionId: state.sessionId, update: { sessionUpdate: 'agent_message_chunk', messageId, content, _meta: { codex: { phase } } },
  });
  step(() => message('comment-before', 'commentary', { type: 'text', text: 'Inspecting the source.' }));
  step(() => state.recordAcceptedSteer([{ type: 'text', text: 'Also check ordering.' }], { messageId: 'steer-before-answer' }));
  step(() => message('first-answer', 'final_answer', { type: 'text', text: '**First finding**' }));
  const first = step(() => message('first-answer', 'final_answer', { type: 'image', mimeType: 'image/png', data: 'aW1hZ2U=' }));
  assert.equal(first.finalMessage, '**First finding**');
  assert.equal(first.resultImages?.length, 1);
  const continued = step(() => message('comment-after', 'commentary', { type: 'text', text: 'Checking the next detail.' }));
  assert.equal(continued.finalMessage, '', 'a continued answer must not stay below newer commentary');
  assert.deepEqual(continued.processItems.map(item => item.type), ['progress', 'user-steer', 'answer', 'progress']);
  const earlier = continued.processItems[2]!;
  assert.equal(earlier.id, 'acp-answer-first-answer');
  assert.equal(earlier.detail, '**First finding**');
  assert.equal(earlier.images?.length, 1, 'media stays with its original answer boundary');
  step(() => state.apply({ sessionId: state.sessionId, update: { sessionUpdate: 'tool_call', toolCallId: 'check-tool', title: 'Check ordering', kind: 'execute', status: 'in_progress' } }));
  const secondPrefix = step(() => message('second-answer', 'final_answer', { type: 'text', text: 'Final' }));
  assert.equal(secondPrefix.finalMessage, 'Final', 'a tail answer streams directly before settlement');
  const second = step(() => message('second-answer', 'final_answer', { type: 'text', text: ' result.' }));
  assert.equal(second.finalMessage, 'Final result.');
  assert.equal(second.processItems.find(item => item.id === earlier.id)?.images?.length, 1);
  const flow = acpProgressFlowEntries(second.processItems);
  assert.deepEqual(flow.map(entry => entry.kind === 'item' ? entry.item.id : entry.items.map(item => item.id)),
    ['acp-progress-comment-before', 'acp-steer-steer-before-answer', 'acp-answer-first-answer', 'acp-progress-comment-after', ['check-tool']]);
  const late = step(() => state.apply({ sessionId: state.sessionId, update: { sessionUpdate: 'agent_thought_chunk', messageId: 'late-thought', content: { type: 'text', text: 'Finishing the bookkeeping.' } } }));
  assert.equal(late.finalMessage, '');
  assert.equal(late.processItems.at(-2)?.detail, 'Final result.');
  const settled = step(() => { active = false; state.completePrompt(); });
  assert.equal(settled.status, 'completed');
  assert.equal(settled.finalMessage, 'Final result.', 'settlement keeps the newest answer in the current direct presentation');
  assert.equal(settled.processItems.find(item => item.id === earlier.id)?.detail, '**First finding**');
  assert.equal(settled.processItems.at(-1)?.type, 'thought');
  const restored = AcpSessionState.fromCheckpoint(state.exportCheckpoint())!;
  const reloaded = projectAcpTranscriptResponse({
    version: 1, agentId: 'answer-agent', sessionId: state.sessionId, runtimeEpoch: 'answer-epoch',
    fromRevision: null, toRevision: restored.revision, replace: true, settled: true,
    transcript: { ...restored.transcriptSlice({ maxTurns: 5, entryPatches: true }), sessionId: state.sessionId, provider, state: 'idle' },
  }, 'answer-agent');
  assert.deepEqual(reloaded.turns, current.turns, 'settled checkpoint reload retains all ordered text and media');
  const interrupted = projectAcpTranscript({ ...state.snapshot(), state: 'idle', stopReason: 'cancelled' }).turns[0]!;
  assert.equal(interrupted.status, 'interrupted');
  assert.equal(interrupted.finalMessage, 'Final result.');
  assert.equal(interrupted.processItems.find(item => item.id === earlier.id)?.images?.length, 1);
}
const anonymous = projectAcpTranscript({ state: 'working', entries: [
  { id: 'user', type: 'message', role: 'user', content: [{ type: 'text', text: 'Anonymous adapter replay' }] },
  { type: 'message', role: 'assistant', _meta: { codex: { phase: 'final_answer' } }, content: [{ type: 'text', text: 'First' }] },
  { type: 'message', role: 'assistant', _meta: { codex: { phase: 'final_answer' } }, content: [{ type: 'text', text: 'Second' }] },
  { id: 'tail', type: 'thought', content: [{ type: 'text', text: 'Continued' }] },
] }).turns[0]!;
assert.equal(new Set(anonymous.processItems.map(item => item.id)).size, anonymous.processItems.length);
assert.deepEqual(anonymous.processItems.filter(item => item.type === 'answer').map(item => item.detail), ['First', 'Second']);
console.log('test-acp-answer-continuation passed');
