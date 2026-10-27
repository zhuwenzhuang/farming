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

const codexSanitizedSteerState = new AcpSessionState({ provider: 'codex', sessionId: 'steer-codex-sanitized' });
codexSanitizedSteerState.beginPrompt([{ type: 'text', text: 'Show indented snippet.' }]);
codexSanitizedSteerState.apply({
  sessionId: codexSanitizedSteerState.sessionId,
  update: {
    sessionUpdate: 'agent_message_chunk',
    messageId: 'codex-indented',
    content: {
      type: 'text',
      text: '<system-reminder>a</system-reminder><system-reminder>b</system-reminder>\nLead line:\n\n',
    },
    _meta: { codex: { phase: 'commentary' } },
  },
});
codexSanitizedSteerState.recordAcceptedSteer([{ type: 'text', text: 'Keep indentation' }], { messageId: 'steer-indented' });
codexSanitizedSteerState.apply({
  sessionId: codexSanitizedSteerState.sessionId,
  update: {
    sessionUpdate: 'agent_message_chunk',
    messageId: 'codex-indented',
    content: {
      type: 'text',
      text: '<environment_context>ctx</environment_context>\n    const preserved = true;\n\n<oai-mem-citation>',
    },
    _meta: { codex: { phase: 'commentary' } },
  },
});
codexSanitizedSteerState.apply({
  sessionId: codexSanitizedSteerState.sessionId,
  update: {
    sessionUpdate: 'agent_message_chunk',
    messageId: 'codex-indented',
    content: {
      type: 'text',
      text: 'MEMORY.md:1-2</oai-mem-citation>',
    },
    _meta: { codex: { phase: 'commentary' } },
  },
});
const codexProjected = projectAcpTranscript({ ...codexSanitizedSteerState.snapshot(), state: 'working' });
assert.equal(codexProjected.turns[0]!.processItems[0]!.detail, 'Lead line:\n\n    const preserved = true;');

function projectSteerSanitizerParts(parts: string[], withSteer: boolean): string | undefined {
  const state = new AcpSessionState({ provider: 'codex', sessionId: 'sanitizer-fragment-parity' });
  state.beginPrompt([{ type: 'text', text: 'Explain the result.' }]);
  parts.forEach((text, index) => {
    if (index && withSteer) {
      state.recordAcceptedSteer([{ type: 'text', text: 'Continue.' }], { messageId: `steer-${index}` });
    }
    state.apply({
      sessionId: state.sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        messageId: 'same-native-message',
        content: { type: 'text', text },
        _meta: { codex: { phase: 'commentary' } },
      },
    });
  });
  return projectAcpTranscript({ ...state.snapshot(), state: 'working' }).turns[0]!.processItems[0]!.detail;
}

for (const item of [
  { name: 'plain whitespace control', parts: ['Hello ', 'world'], expected: 'Hello world' },
  { name: 'trailing citation envelope', parts: ['Hello <oai-mem-citation>ref</oai-mem-citation>', 'world'], expected: 'Hello world' },
  { name: 'trailing paragraph envelope', parts: ['First paragraph\n\n<system-reminder>hidden</system-reminder>', 'Second paragraph'], expected: 'First paragraph\n\nSecond paragraph' },
  { name: 'internal block split across Steer', parts: ['Start <system-reminder>hidden', '</system-reminder>end'], expected: 'Start end' },
]) {
  const unsplit = projectSteerSanitizerParts(item.parts, false);
  const withSteer = projectSteerSanitizerParts(item.parts, true);
  assert.equal(unsplit, item.expected, `${item.name}: unsplit matches expected`);
  assert.equal(withSteer, unsplit, `${item.name}: Steer boundary preserves exact sanitizer output`);
}

// Regression: fenced code preserves meaningful trailing spaces and blank lines
const fencedState = new AcpSessionState({ provider: 'codex', sessionId: 'fenced-whitespace' });
fencedState.beginPrompt([{ type: 'text', text: 'Show python snippet.' }]);
const fencedInput = '```python\ns = """first  \nsecond\n\n\nthird"""\n```';
fencedState.apply({
  sessionId: fencedState.sessionId,
  update: {
    sessionUpdate: 'agent_message_chunk',
    messageId: 'fenced-msg',
    content: { type: 'text', text: fencedInput },
    _meta: { codex: { phase: 'commentary' } },
  },
});
const fencedDetail = projectAcpTranscript({ ...fencedState.snapshot(), state: 'working' })
  .turns[0]!.processItems.find(item => item.type !== 'user-steer')?.detail;
assert.equal(fencedDetail, fencedInput, 'fenced code block must preserve trailing spaces and triple newlines');

// Regression: 256-entry window rollover does not duplicate consolidated text
const rolloverState = new AcpSessionState({ provider: 'codex', sessionId: 'rollover-window' });
rolloverState.beginPrompt([{ type: 'text', text: 'Count fragments.' }]);
const rolloverResponse = (sinceRevision?: number) => {
  const page = rolloverState.transcriptSlice({ maxTurns: 5, entryPatches: true, sinceRevision });
  return projectAcpTranscriptResponse({
    version: 1,
    agentId: 'agent',
    sessionId: rolloverState.sessionId,
    runtimeEpoch: 'epoch',
    fromRevision: sinceRevision ?? null,
    toRevision: page.revision,
    replace: !page.delta,
    settled: true,
    hasMoreBefore: page.hasMoreBefore,
    transcript: {
      ...page,
      sessionId: rolloverState.sessionId,
      provider: 'codex',
      state: 'working',
      entries: acpTranscriptEntries(page.entries),
    },
  }, 'agent');
};
let rolloverCurrent = rolloverResponse();
for (let index = 0; index <= 128; index += 1) {
  const revision = rolloverState.revision;
  if (index) {
    rolloverState.recordAcceptedSteer([{ type: 'text', text: 'Continue.' }], { messageId: `steer-${index}` });
  }
  rolloverState.apply({
    sessionId: rolloverState.sessionId,
    update: {
      sessionUpdate: 'agent_message_chunk',
      messageId: 'rollover-msg',
      content: { type: 'text', text: `[${index}]` },
      _meta: { codex: { phase: 'commentary' } },
    },
  });
  const merged = mergeAcpTranscript(rolloverCurrent, rolloverResponse(revision));
  assert.equal(merged.accepted, true);
  assert.equal(merged.needsCheckpoint, false);
  rolloverCurrent = merged.transcript!;
  const actual = rolloverCurrent.turns[0]!.processItems.find(item => item.type !== 'user-steer')?.detail;
  const expected = Array.from({ length: index + 1 }, (_, item) => `[${item}]`).join('');
  assert.equal(actual, expected, `256-entry window rollover preserves exact text at fragment ${index}`);
}

// Regression: bounded page has internal block context across both start and end boundaries (latest + Load older merge)
const crossPageState = new AcpSessionState({ provider: 'codex', sessionId: 'cross-page-boundary' });
crossPageState.beginPrompt([{ type: 'text', text: 'Check boundary.' }]);
crossPageState.apply({
  sessionId: crossPageState.sessionId,
  update: {
    sessionUpdate: 'agent_message_chunk',
    messageId: 'cross-page-msg',
    content: { type: 'text', text: 'PUBLIC<system-reminder>PRIVATE' },
    _meta: { codex: { phase: 'commentary' } },
  },
});
for (let index = 0; index < 128; index += 1) {
  crossPageState.recordAcceptedSteer([{ type: 'text', text: 'Continue.' }], { messageId: `steer-${index}` });
}
crossPageState.apply({
  sessionId: crossPageState.sessionId,
  update: {
    sessionUpdate: 'agent_message_chunk',
    messageId: 'cross-page-msg',
    content: { type: 'text', text: 'SECRET</system-reminder>END' },
    _meta: { codex: { phase: 'commentary' } },
  },
});
for (let index = 128; index < 256; index += 1) {
  crossPageState.recordAcceptedSteer([{ type: 'text', text: 'Continue.' }], { messageId: `steer-${index}` });
}
const crossPageResponse = (cursor?: string | null) => {
  const page = crossPageState.transcriptSlice({ maxTurns: 5, entryPatches: true, cursor: cursor || undefined });
  return projectAcpTranscriptResponse({
    version: 1,
    agentId: 'agent',
    sessionId: crossPageState.sessionId,
    runtimeEpoch: 'epoch',
    fromRevision: null,
    toRevision: page.revision,
    replace: true,
    settled: true,
    hasMoreBefore: page.hasMoreBefore,
    transcript: {
      ...page,
      sessionId: crossPageState.sessionId,
      provider: 'codex',
      state: 'working',
      entries: acpTranscriptEntries(page.entries),
    },
  }, 'agent');
};
const crossPageLatest = crossPageResponse();
const crossPageOlder = crossPageResponse(crossPageLatest.nextCursor);
const crossPageMerged = mergeAcpTranscript(crossPageLatest, crossPageOlder);
assert.equal(crossPageMerged.accepted, true);
const crossPageFull = projectAcpTranscript({ ...crossPageState.snapshot(), state: 'working' })
  .turns.flatMap(turn => turn.processItems).filter(item => item.type !== 'user-steer').map(item => item.detail).join('');
const crossPageActual = crossPageMerged.transcript!
  .turns.flatMap(turn => turn.processItems).filter(item => item.type !== 'user-steer').map(item => item.detail).join('');
assert.equal(crossPageActual, 'PUBLICEND');
assert.equal(crossPageActual, crossPageFull, 'Load older merge must match full snapshot without reintroducing internal block');

// Regression: private app directives and code fences split across Steer sanitize identically to unsplit
function projectPartsWithOptionalSteer(parts: string[], withSteer: boolean): string {
  const partState = new AcpSessionState({ provider: 'codex', sessionId: 'directive-boundary' });
  partState.beginPrompt([{ type: 'text', text: 'Explain the result.' }]);
  parts.forEach((part, index) => {
    if (index && withSteer) {
      partState.recordAcceptedSteer([{ type: 'text', text: 'Continue.' }], { messageId: `steer-${index}` });
    }
    partState.apply({
      sessionId: partState.sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        messageId: 'same-native-message',
        content: { type: 'text', text: part },
        _meta: { codex: { phase: 'commentary' } },
      },
    });
  });
  return projectAcpTranscript({ ...partState.snapshot(), state: 'working' })
    .turns.flatMap(turn => turn.processItems)
    .filter(item => item.type !== 'user-steer')
    .map(item => item.detail)
    .join('');
}

const directiveParts = ['Hello ::created-', 'thread{threadId="private"} world'];
assert.equal(
  projectPartsWithOptionalSteer(directiveParts, true),
  projectPartsWithOptionalSteer(directiveParts, false),
  'Private app directives split across Steer must sanitize identically',
);

const fencedVisParts = ['```text\n', '::codex-inline-vis{file="/example/a.html"}\n```'];
assert.equal(
  projectPartsWithOptionalSteer(fencedVisParts, true),
  projectPartsWithOptionalSteer(fencedVisParts, false),
  'Literal visualization directive inside code fence split across Steer must retain fence',
);

// Regression: late directive completion across >256 Steers invalidates pre-window sanitized fragments
const splitDirectiveDeltaState = new AcpSessionState({ provider: 'codex', sessionId: 'split-directive-delta' });
splitDirectiveDeltaState.beginPrompt([{ type: 'text', text: 'Explain the result.' }]);
const appendSplitDirectiveChunk = (text: string) => {
  splitDirectiveDeltaState.apply({
    sessionId: splitDirectiveDeltaState.sessionId,
    update: {
      sessionUpdate: 'agent_message_chunk',
      messageId: 'same-native-message',
      content: { type: 'text', text },
      _meta: { codex: { phase: 'commentary' } },
    },
  });
};
const steerSplitDirective = (messageId: string) => {
  splitDirectiveDeltaState.recordAcceptedSteer([{ type: 'text', text: 'Continue.' }], { messageId });
};
const splitDirectiveResponse = (sinceRevision?: number) => {
  const page = splitDirectiveDeltaState.transcriptSlice({ maxTurns: 5, entryPatches: true, sinceRevision });
  return projectAcpTranscriptResponse({
    version: 1,
    agentId: 'agent',
    sessionId: splitDirectiveDeltaState.sessionId,
    runtimeEpoch: 'epoch',
    fromRevision: page.delta ? sinceRevision : null,
    toRevision: page.revision,
    replace: !page.delta,
    settled: true,
    hasMoreBefore: page.hasMoreBefore,
    transcript: {
      ...page,
      sessionId: splitDirectiveDeltaState.sessionId,
      provider: 'codex',
      state: 'working',
      entries: acpTranscriptEntries(page.entries),
    },
  }, 'agent');
};
let splitDirectiveCurrent = splitDirectiveResponse();
const stepSplitDirective = (mutate: () => void) => {
  const revision = splitDirectiveDeltaState.revision;
  mutate();
  const next = splitDirectiveResponse(revision);
  const merged = mergeAcpTranscript(splitDirectiveCurrent, next);
  assert.equal(merged.accepted, true);
  assert.equal(merged.needsCheckpoint, false);
  splitDirectiveCurrent = merged.transcript!;
};
stepSplitDirective(() => appendSplitDirectiveChunk('Hello :'));
stepSplitDirective(() => steerSplitDirective('split-prefix'));
stepSplitDirective(() => appendSplitDirectiveChunk(':created-thread{threadId="private"'));
for (let index = 0; index < 256; index += 1) {
  stepSplitDirective(() => steerSplitDirective(`steer-${index}`));
}
stepSplitDirective(() => appendSplitDirectiveChunk('} world'));
const splitDirectiveExpected = projectAcpTranscript({ ...splitDirectiveDeltaState.snapshot(), state: 'working' })
  .turns.flatMap(turn => turn.processItems).filter(item => item.type !== 'user-steer').map(item => item.detail).join('');
const splitDirectiveActual = splitDirectiveCurrent
  .turns.flatMap(turn => turn.processItems).filter(item => item.type !== 'user-steer').map(item => item.detail).join('');
assert.equal(splitDirectiveExpected, 'Hello  world');
assert.equal(splitDirectiveActual, splitDirectiveExpected, 'late directive completion must invalidate pre-window fragments');

// Regression: mutable assistant entry updates after Steer must re-emit earlier fragments in the same group
const mutableDeltaState = new AcpSessionState({ provider: 'codex', sessionId: 'mutable-entry-delta' });
mutableDeltaState.beginPrompt([{ type: 'text', text: 'Explain the result.' }]);
const appendMutableChunk = (text: string) => {
  mutableDeltaState.apply({
    sessionId: mutableDeltaState.sessionId,
    update: {
      sessionUpdate: 'agent_message_chunk',
      messageId: 'same-native-message',
      content: { type: 'text', text },
      _meta: { codex: { phase: 'commentary' } },
    },
  });
};
const mutableResponse = (sinceRevision?: number) => {
  const page = mutableDeltaState.transcriptSlice({ maxTurns: 5, entryPatches: true, sinceRevision });
  return projectAcpTranscriptResponse({
    version: 1,
    agentId: 'agent',
    sessionId: mutableDeltaState.sessionId,
    runtimeEpoch: 'epoch',
    fromRevision: page.delta ? sinceRevision : null,
    toRevision: page.revision,
    replace: !page.delta,
    settled: true,
    hasMoreBefore: page.hasMoreBefore,
    transcript: {
      ...page,
      sessionId: mutableDeltaState.sessionId,
      provider: 'codex',
      state: 'working',
      entries: acpTranscriptEntries(page.entries),
    },
  }, 'agent');
};
let mutableCurrent = mutableResponse();
const stepMutable = (mutate: () => void) => {
  const revision = mutableDeltaState.revision;
  mutate();
  const next = mutableResponse(revision);
  const merged = mergeAcpTranscript(mutableCurrent, next);
  assert.equal(merged.accepted, true);
  assert.equal(merged.needsCheckpoint, false);
  mutableCurrent = merged.transcript!;
};
stepMutable(() => appendMutableChunk('Hello '));
stepMutable(() => mutableDeltaState.recordAcceptedSteer([{ type: 'text', text: 'Continue.' }], { messageId: 'steer' }));
stepMutable(() => appendMutableChunk('<system-reminder>hidden</system-reminder>'));
stepMutable(() => appendMutableChunk('world'));
const mutableExpected = projectAcpTranscript({ ...mutableDeltaState.snapshot(), state: 'working' })
  .turns.flatMap(turn => turn.processItems).filter(item => item.type !== 'user-steer').map(item => item.detail).join('');
const mutableActual = mutableCurrent
  .turns.flatMap(turn => turn.processItems).filter(item => item.type !== 'user-steer').map(item => item.detail).join('');
assert.equal(mutableExpected, 'Hello world');
assert.equal(mutableActual, mutableExpected, 'mutable assistant updates must re-emit earlier fragments in the same group');

console.log('test-acp-steer-markdown passed');
