import assert from 'node:assert/strict';
import { AcpSessionState } from '../acp-session-state.cts';
import { acpTranscriptEntries } from '../acp-transcript.cts';
import { projectAcpTranscript } from '../../src/components/code/acp/acp-entry-projection';
import { mergeAcpTranscript, projectAcpTranscriptResponse } from '../../src/components/code/acp/acp-transcript-envelope';

const chunks = [
  '**Plan limit**: see [Settings.java](/workspace/demo/src/Set',
  'tings.java:26).\n\n```sql\nselect ',
  '780 * 30;\n```\n\n| Limit | Value |\n| --- | --- |\n| instances | 23',
  '400 |\n',
];

for (const provider of ['codex', 'claude', 'qwen']) {
  for (const kind of ['agent_message_chunk', 'agent_thought_chunk']) {
    const state = new AcpSessionState({ provider, sessionId: 'steer-markdown' });
    state.beginPrompt([{ type: 'text', text: 'Explain the plan limit.' }]);
    const project = (sinceRevision?: number) => {
      const page = state.transcriptSlice({ maxTurns: 5, entryPatches: true, sinceRevision });
      return projectAcpTranscriptResponse({
        version: 1, agentId: 'agent', sessionId: state.sessionId, runtimeEpoch: 'epoch',
        fromRevision: sinceRevision ?? null, toRevision: page.revision, replace: !page.delta, settled: true,
        transcript: { ...page, sessionId: state.sessionId, provider, state: 'working', entries: acpTranscriptEntries(page.entries) },
      }, 'agent');
    };
    let current = project();
    const step = (mutation: () => void) => {
      const revision = state.revision;
      mutation();
      const merged = mergeAcpTranscript(current, project(revision));
      assert.equal(merged.needsCheckpoint, false);
      assert.equal(merged.accepted, true);
      current = merged.transcript!;
      assert.deepEqual(current.turns, project().turns, 'delta and checkpoint presentations agree');
    };
    chunks.forEach((text, index) => {
      if (index) step(() => { state.recordAcceptedSteer([{ type: 'text', text: `Follow-up ${index}` }], { messageId: `steer-${index}` }); });
      step(() => { state.apply({ sessionId: state.sessionId, update: {
        sessionUpdate: kind, messageId: 'explanation', content: { type: 'text', text },
        _meta: { codex: { phase: 'commentary' } },
      } }); });
      const items = current.turns[0]!.processItems;
      assert.equal(items[0]!.detail, chunks.slice(0, index + 1).join('').trim());
      assert.equal(items.length, index + 1);
      assert(items.slice(1).every(item => item.type === 'user-steer'));
    });
    const checkpoint = state.exportCheckpoint();
    const original = JSON.stringify(checkpoint);
    const restored = AcpSessionState.fromCheckpoint(checkpoint)!;
    assert.deepEqual(projectAcpTranscript({ ...restored.snapshot(), state: 'working' }).turns, current.turns);
    assert.equal(JSON.stringify(checkpoint), original, 'projection must not mutate stored content or ordering');
    assert.equal(checkpoint.entries.filter(entry => entry.messageId === 'explanation').length, chunks.length);
    step(() => { state.completePrompt('cancelled'); });
    assert.equal(current.turns[0]!.processItems[0]!.detail, chunks.join('').trim());
  }
}

const prompt = { id: 'user', type: 'message', role: 'user', content: [{ type: 'text', text: 'Question' }] };
const message = { id: 'first', type: 'message', role: 'assistant', messageId: 'native', content: [{ type: 'text', text: 'first' }] };
const steer = { id: 'steer', type: 'message', role: 'user', _meta: { farming: { steer: true } }, content: [{ type: 'text', text: 'follow-up' }] };
const continuation = { ...message, id: 'continuation', content: [{ type: 'text', text: ' second' }] };
const projectItems = (entries: unknown[]) => projectAcpTranscript({ state: 'working', entries: [prompt, ...entries] }).turns.flatMap(turn => turn.processItems);
for (const boundary of [
  { id: 'tool', type: 'tool', title: 'Read source', kind: 'read', status: 'completed' },
  { ...message, id: 'other', messageId: 'other' },
  { ...prompt, id: 'new-turn' },
]) {
  const items = projectItems([message, steer, boundary, continuation]);
  assert(items.some(item => item.detail === 'first'));
  assert(items.some(item => item.detail === 'second'), 'joining must not cross another activity or Turn');
}
for (const changed of [
  { messageId: 'different' }, { messageId: '' }, { type: 'thought' }, { internalScope: 'entry' },
  { _meta: { codex: { phase: 'final_answer' } } }, { sessionMessage: true },
]) {
  const items = projectItems([message, steer, { ...continuation, ...changed }]);
  assert.equal(items[0]!.detail, 'first', 'identity, kind, phase and message scope are boundaries');
}
assert.equal(projectItems([{ ...message, messageId: '' }, steer, { ...continuation, messageId: '' }]).length, 3);
const media = { type: 'image', mimeType: 'image/png', data: 'aW1hZ2U=' };
const mediaItems = projectItems([{ ...message, content: [...message.content, media] }, steer, continuation]);
assert.equal(mediaItems[0]!.images?.length, 1, 'media remains attached to the joined message');
assert.equal(mediaItems[1]!.type, 'user-steer');
console.log('test-acp-steer-markdown passed');
