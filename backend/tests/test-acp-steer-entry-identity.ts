import assert from 'node:assert/strict';
import { AcpSessionState } from '../acp-session-state.cjs';
import { projectAcpTranscriptResponse, mergeAcpTranscript } from '../../src/components/code/acp/acp-transcript-envelope';

for (const provider of ['codex', 'claude', 'qwen']) {
  const state = new AcpSessionState({ provider, sessionId: 'session' });
  const thought = (text: string) => state.apply({ sessionId: 'session', update: {
    sessionUpdate: 'agent_thought_chunk', messageId: 'reasoning-1', content: { type: 'text', text },
  } });
  state.beginPrompt([{ type: 'text', text: 'Implement the change' }]);
  thought('Inspecting');
  state.recordAcceptedSteer([{ type: 'text', text: 'Use the simpler design' }], { messageId: 'steer-1' });
  thought('Continuing');
  thought(' the implementation');
  const page = state.transcriptSlice({ maxTurns: 5, entryPatches: true });
  assert.equal(new Set(page.entryPatch?.order).size, page.entries.length);
  const thoughts = page.entries.filter(entry => entry.type === 'thought');
  assert.equal(thoughts.length, 2);
  assert.equal(thoughts[0].messageId, thoughts[1].messageId);
  assert.notEqual(thoughts[0].id, thoughts[1].id);
  const envelope = {
    version: 1, agentId: 'agent', sessionId: 'session', runtimeEpoch: 'epoch',
    fromRevision: null, toRevision: page.revision, replace: true, settled: true,
    transcript: { ...page, sessionId: 'session', provider, version: 2 },
  };
  const projected = projectAcpTranscriptResponse(envelope, 'agent', { maxTurns: 5 });
  assert.equal(mergeAcpTranscript(null, projected).needsCheckpoint, false);
  // Restore the previously shipped duplicate shape, preserving both texts.
  const checkpoint = state.exportCheckpoint();
  const segments = checkpoint.entries.filter(entry => entry.type === 'thought');
  segments[1].id = segments[0].id;
  const restored = AcpSessionState.fromCheckpoint(checkpoint)!;
  const recovered = restored.transcriptSlice({ maxTurns: 5, entryPatches: true, sinceRevision: checkpoint.revision });
  assert.equal(recovered.delta, false);
  assert.equal(new Set(recovered.entryPatch?.order).size, recovered.entries.length);
  assert.equal(recovered.entries.filter(entry => entry.type === 'thought').length, 2);
  assert.deepEqual(recovered.entries.filter(entry => entry.type === 'thought').map(entry => entry.content), thoughts.map(entry => entry.content));
  const again = AcpSessionState.fromCheckpoint(restored.exportCheckpoint())!;
  assert.deepEqual(again.transcriptSlice({ maxTurns: 5, entryPatches: true }).entryPatch?.order, recovered.entryPatch?.order);
}
console.log('test-acp-steer-entry-identity passed');
