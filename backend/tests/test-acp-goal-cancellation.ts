import assert from 'node:assert/strict';
import { AcpSessionState } from '../acp-session-state.cjs';
import { projectAcpTranscript } from '../../src/components/code/acp/acp-entry-projection';

for (const provider of ['codex', 'claude', 'qwen']) {
  const state = new AcpSessionState({ provider, sessionId: 'session' });
  const update = (value: Record<string, unknown>) => state.apply({ sessionId: 'session', update: value });
  const goal = { objective: 'Verify service recovery', status: 'active', tokensUsed: 0, tokenBudget: 5000 };
  update({ sessionUpdate: 'session_info_update', _meta: { goal } });
  const revision = state.revision;
  update({ sessionUpdate: 'session_info_update', title: 'Session title' });
  update({ sessionUpdate: 'session_info_update', _meta: { goal: { objective: 3 } } });
  assert.deepEqual(state.goal, goal);
  assert.deepEqual(projectAcpTranscript(state.transcriptSlice({ sinceRevision: revision })).goal, goal);
  assert.deepEqual(AcpSessionState.fromCheckpoint(state.exportCheckpoint())?.goal, goal);
  update({ sessionUpdate: 'session_info_update', _meta: { goal: { ...goal, status: 'paused', tokensUsed: 30 } } });
  assert.equal(state.goal?.status, 'paused');
  assert.equal(state.goal?.tokensUsed, 30);
  update({ sessionUpdate: 'session_info_update', _meta: { goal: null } });
  assert.equal(projectAcpTranscript(state.transcriptSlice()).goal, null);
  assert.equal(AcpSessionState.fromCheckpoint(state.exportCheckpoint())?.goal, null);

  state.beginPrompt('Inspect the workspace');
  update({ sessionUpdate: 'tool_call', toolCallId: 'finished', status: 'completed' });
  update({ sessionUpdate: 'tool_call', toolCallId: 'pending', status: 'pending' });
  update({ sessionUpdate: 'tool_call', toolCallId: 'running', status: 'in_progress' });
  update({ sessionUpdate: 'tool_call', toolCallId: 'compact', status: 'in_progress', _meta: { contextCompaction: true } });
  update({ sessionUpdate: 'context_compaction', compactionId: 'compaction', status: 'in_progress' });
  state.completePrompt('cancelled');
  const afterCancel = state.transcriptSlice();
  const cancelledCheckpoint = AcpSessionState.fromCheckpoint(state.exportCheckpoint())!;
  assert.equal(projectAcpTranscript(cancelledCheckpoint.snapshot()).turns[0].stopReason, 'cancelled');
  assert.equal(afterCancel.entries.find(entry => entry.id === 'finished')?.status, 'completed');
  for (const id of ['pending', 'running', 'compact', 'compaction']) {
    assert.equal(afterCancel.entries.find(entry => entry.id === id)?.status, 'cancelled');
  }
  state.beginPrompt('Explain the results');
  update({ sessionUpdate: 'tool_call_update', toolCallId: 'running', status: 'in_progress' });
  update({ sessionUpdate: 'tool_call', toolCallId: 'new-tool', status: 'in_progress' });
  let projected = projectAcpTranscript({ ...state.snapshot(), state: 'working' });
  assert.equal(projected.turns[0].status, 'interrupted');
  assert.equal(projected.turns[0].stopReason, 'cancelled');
  assert.equal(projected.turns[0].processItems.find(item => item.id === 'running')?.status, 'cancelled');
  assert.equal(projected.turns[1].status, 'inProgress');
  assert.equal(projected.turns[1].processItems[0].status, 'in_progress');
  update({ sessionUpdate: 'tool_call_update', toolCallId: 'new-tool', status: 'completed' });
  update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Here are the results.' } });
  state.completePrompt();
  const restored = AcpSessionState.fromCheckpoint(state.exportCheckpoint())!;
  projected = projectAcpTranscript({ ...restored.snapshot(), state: 'idle', stopReason: 'end_turn' });
  assert.equal(projected.turns[0].status, 'interrupted');
  assert.equal(projected.turns[0].processItems.find(item => item.id === 'compact')?.status, 'cancelled');
  assert.equal(projected.turns[1].status, 'completed');
  // Provider-initiated Turns need the same terminal ownership even without a
  // locally submitted prompt/timestamp (for example autonomous Goal work).
  update({ sessionUpdate: 'user_message_chunk', messageId: 'native-user', content: { type: 'text', text: 'Continue the goal' } });
  update({ sessionUpdate: 'tool_call', toolCallId: 'native-tool', status: 'in_progress' });
  state.completePrompt('cancelled');
  state.beginPrompt('New follow-up');
  projected = projectAcpTranscript({ ...state.snapshot(), state: 'working' });
  assert.equal(projected.turns[1].stopReason, 'end_turn');
  assert.equal(projected.turns[2].stopReason, 'cancelled');
  assert.equal(projected.turns[2].status, 'interrupted');
  assert.equal(projected.turns[3].status, 'inProgress');
}
const nativeState = new AcpSessionState({ provider: 'codex', sessionId: 'native-parent' });
const nativeUpdate = (value: Record<string, unknown>) => nativeState.apply({ sessionId: 'native-parent', update: value });
nativeState.beginPrompt('Start a background child');
nativeUpdate({
  sessionUpdate: 'tool_call',
  toolCallId: 'native-subagent:child',
  status: 'in_progress',
  _meta: { farming: { nativeSubagent: true, state: 'running' } },
});
nativeState.completePrompt('cancelled');
assert.equal(nativeState.entries.find(entry => entry.id === 'native-subagent:child')?.status, 'in_progress');
nativeUpdate({
  sessionUpdate: 'tool_call_update',
  toolCallId: 'native-subagent:child',
  status: 'completed',
  _meta: { farming: { nativeSubagent: true, state: 'completed' } },
});
assert.equal(nativeState.entries.find(entry => entry.id === 'native-subagent:child')?.status, 'completed');
console.log('test-acp-goal-cancellation passed');
