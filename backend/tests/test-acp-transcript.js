const assert = require('assert');
const { projectAcpTranscript: acpSessionTranscript } = require('../../src/components/code/acp/acp-entry-projection.ts');
const { acpToolChanges, acpToolReviewChanges, acpTranscriptToolEntry } = require('../acp-transcript');

const transcript = acpSessionTranscript({
  sessionId: 'session-1',
  updatedAt: '2026-07-12T12:00:00.000Z',
  state: 'idle',
  entries: [
    { id: 'user-1', type: 'message', role: 'user', content: [{ type: 'text', text: 'Fix it' }] },
    { id: 'progress-1', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'Inspecting files' }] },
    { id: 'thought-1', type: 'thought', role: 'assistant', content: [{ type: 'text', text: 'Inspecting' }] },
    {
      id: 'tool-1',
      type: 'tool',
      kind: 'execute',
      title: 'Run tests',
      status: 'completed',
      rawInput: { command: 'npm test' },
      content: [
        { type: 'content', content: { type: 'text', text: 'running' } },
        { type: 'diff', path: '/tmp/a.js', oldText: 'old', newText: 'new' },
        { type: 'terminal', terminalId: 'terminal-1' },
      ],
      rawOutput: 'ok',
      locations: [{ path: '/tmp/a.js', line: 3 }],
    },
    {
      id: 'plan-1',
      type: 'plan',
      plan: { type: 'items', entries: [{ content: 'Run tests', status: 'completed' }] },
    },
    { id: 'answer-1', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'Done' }] },
  ],
});

assert.strictEqual(transcript.version, 2);
assert.strictEqual(transcript.available, true);
assert.strictEqual(transcript.source, 'acp');
assert.strictEqual(transcript.turns.length, 1);
assert.strictEqual(transcript.turns[0].userMessage, 'Fix it');
assert.strictEqual(transcript.turns[0].finalMessage, 'Done');
assert.deepStrictEqual(transcript.turns[0].processItems.map(entry => entry.title), [
  'Progress update', 'Reasoning', 'Run tests', 'Plan',
]);
assert.strictEqual(transcript.turns[0].processItems[2].type, 'patch');
assert.deepStrictEqual(transcript.turns[0].processItems[2].changes, [{
  added: 1,
  kind: 'updated',
  path: '/tmp/a.js',
  removed: 1,
}]);
assert.strictEqual(transcript.turns[0].processItems[3].completedSteps, 1);
assert.strictEqual(transcript.turns[0].processItems[3].totalSteps, 1);
assert.strictEqual(transcript.turns[0].processItems[3].currentStep, '');
assert.match(transcript.turns[0].processItems[2].detail, /^Updated \/tmp\/a\.js/);
assert.match(transcript.turns[0].processItems[2].detail, /Input\n[\s\S]*npm test/);
assert.match(transcript.turns[0].processItems[2].detail, /File: \/tmp\/a\.js/);
assert.match(transcript.turns[0].processItems[2].detail, /-old/);
assert.match(transcript.turns[0].processItems[2].detail, /\+new/);
assert.deepStrictEqual(transcript.turns[0].processItems[2].terminalIds, ['terminal-1']);
assert.doesNotMatch(transcript.turns[0].processItems[2].detail, /Terminal: terminal-1/);
assert.match(transcript.turns[0].processItems[2].detail, /Output\nok/);
assert.match(transcript.turns[0].processItems[2].detail, /Locations\n\/tmp\/a\.js:3/);

const mirroredCommandOutput = acpSessionTranscript({
  state: 'idle',
  entries: [
    { id: 'mirrored-user', type: 'message', role: 'user', content: [{ type: 'text', text: 'Count' }] },
    {
      id: 'mirrored-tool',
      type: 'tool',
      kind: 'execute',
      title: 'printf',
      status: 'completed',
      rawInput: { command: 'printf "1\\n2\\n"' },
      rawOutput: { stdout: '1\n2\n', stderr: '', interrupted: false },
      content: [{
        type: 'content',
        content: {
          type: 'text',
          text: JSON.stringify({ stdout: '1\n2\n', stderr: '', interrupted: false }, null, 2),
        },
      }],
    },
    { id: 'mirrored-answer', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'Done' }] },
  ],
});
const mirroredDetail = mirroredCommandOutput.turns[0].processItems[0].detail;
assert.match(mirroredDetail, /Input\n[\s\S]*printf/);
assert.match(mirroredDetail, /Output\n1\n2/);
assert.strictEqual((mirroredDetail.match(/"stdout"/g) || []).length, 0);
assert.strictEqual((mirroredDetail.match(/Output\n/g) || []).length, 1);
const exactChanges = acpToolChanges({
  content: [{ type: 'diff', path: '/tmp/a.js', oldText: 'old', newText: 'new' }],
});
assert.deepStrictEqual(exactChanges.map(({ diff: _diff, ...change }) => change), [{
  added: 1,
  kind: 'updated',
  path: '/tmp/a.js',
  removed: 1,
}]);
assert.match(exactChanges[0].diff, /-old/);
assert.match(exactChanges[0].diff, /\+new/);
assert.deepStrictEqual(acpToolReviewChanges({
  content: [{ type: 'diff', path: '/tmp/a.js', oldText: 'old', newText: 'new', _meta: { kind: 'update' } }],
}), [{
  kind: 'updated',
  newText: 'new',
  oldText: 'old',
  path: '/tmp/a.js',
}]);

const compactTool = acpTranscriptToolEntry({
  id: 'large-tool',
  type: 'tool',
  kind: 'execute',
  title: 'Large command',
  status: 'completed',
  rawInput: { command: 'generate output' },
  rawOutput: { stdout: 'x'.repeat(128 * 1024) },
  content: [{ type: 'diff', path: '/tmp/large.js', oldText: 'old', newText: 'new' }],
});
assert.strictEqual(compactTool.transcriptDetailTruncated, true);
assert.strictEqual(compactTool.transcriptChanges[0].path, '/tmp/large.js');
assert(JSON.stringify(compactTool).length < 8 * 1024, 'the transcript envelope must not carry full tool output');
assert.strictEqual(Object.prototype.hasOwnProperty.call(compactTool, 'rawOutput'), false);

const orderedProgressTranscript = acpSessionTranscript({
  state: 'working',
  entries: [
    { id: 'ordered-user', type: 'message', role: 'user', content: [{ type: 'text', text: 'Fix it' }] },
    { id: 'ordered-progress-1', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'First finding' }] },
    { id: 'ordered-tool-1', type: 'tool', kind: 'read', title: 'Read source', status: 'completed' },
    { id: 'ordered-progress-2', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'Second finding' }] },
    { id: 'ordered-tool-2', type: 'tool', kind: 'execute', title: 'Run tests', status: 'pending' },
  ],
});
assert.strictEqual(orderedProgressTranscript.turns[0].finalMessage, '');
assert.deepStrictEqual(
  orderedProgressTranscript.turns[0].processItems.map(entry => [entry.type, entry.detail || entry.title]),
  [
    ['progress', 'First finding'],
    ['tool', 'Read source'],
    ['progress', 'Second finding'],
    ['tool', 'Run tests'],
  ],
  'ACP commentary and actions must retain their protocol order',
);

const completedOrderedProgressTranscript = acpSessionTranscript({
  entries: [
    { id: 'completed-user', type: 'message', role: 'user', content: [{ type: 'text', text: 'Fix it' }] },
    { id: 'completed-progress', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'Found the cause' }] },
    { id: 'completed-tool', type: 'tool', kind: 'edit', title: 'Edit source', status: 'completed' },
    { id: 'completed-answer', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'Done' }] },
  ],
});
assert.strictEqual(completedOrderedProgressTranscript.turns[0].finalMessage, 'Done');
assert.deepStrictEqual(
  completedOrderedProgressTranscript.turns[0].processItems.map(entry => entry.title),
  ['Progress update', 'Edit source'],
);

const phaseAwareTranscript = acpSessionTranscript({
  state: 'idle',
  entries: [
    { id: 'phase-user', type: 'message', role: 'user', content: [{ type: 'text', text: 'Explain it' }] },
    {
      id: 'phase-commentary', type: 'message', role: 'assistant',
      _meta: { codex: { phase: 'commentary' } },
      content: [{ type: 'text', text: 'Checking the protocol evidence.' }],
    },
    {
      id: 'phase-final', type: 'message', role: 'assistant',
      _meta: { codex: { phase: 'final_answer' } },
      content: [{ type: 'text', text: 'Visible rich final answer.' }],
    },
    { id: 'phase-trailing-thought', type: 'thought', role: 'assistant', content: [{ type: 'text', text: 'Trailing replay thought' }] },
  ],
});
assert.strictEqual(phaseAwareTranscript.turns[0].finalMessage, 'Visible rich final answer.');
assert.deepStrictEqual(
  phaseAwareTranscript.turns[0].processItems.map(entry => [entry.type, entry.detail]),
  [
    ['progress', 'Checking the protocol evidence.'],
    ['thought', 'Trailing replay thought'],
  ],
  'an explicit final answer must remain visible even when replay emits a later thought entry',
);

const interruptedCommentaryTranscript = acpSessionTranscript({
  state: 'idle',
  entries: [
    { id: 'interrupted-user-1', type: 'message', role: 'user', content: [{ type: 'text', text: 'Start investigating' }] },
    {
      id: 'interrupted-commentary', type: 'message', role: 'assistant',
      _meta: { codex: { phase: 'commentary' } },
      content: [{ type: 'text', text: 'I will inspect the failing path first.' }],
    },
    { id: 'interrupted-user-2', type: 'message', role: 'user', content: [{ type: 'text', text: 'One more symptom' }] },
    {
      id: 'interrupted-final', type: 'message', role: 'assistant',
      _meta: { codex: { phase: 'final_answer' } },
      content: [{ type: 'text', text: 'Fixed both symptoms.' }],
    },
  ],
});
assert.strictEqual(interruptedCommentaryTranscript.turns[0].finalMessage, '');
assert.deepStrictEqual(
  interruptedCommentaryTranscript.turns[0].processItems.map(entry => entry.detail),
  ['I will inspect the failing path first.'],
  'explicit Codex commentary must stay under Worked when the turn is interrupted before a final answer',
);
assert.strictEqual(interruptedCommentaryTranscript.turns[1].finalMessage, 'Fixed both symptoms.');

const liveTailProgressTranscript = acpSessionTranscript({
  state: 'working',
  entries: [
    { id: 'live-tail-user', type: 'message', role: 'user', content: [{ type: 'text', text: 'Investigate' }] },
    { id: 'live-tail-assistant', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'I found the first cause' }] },
  ],
});
assert.strictEqual(liveTailProgressTranscript.turns[0].finalMessage, '');
assert.strictEqual(liveTailProgressTranscript.turns[0].processItems[0].detail, 'I found the first cause');

const internalTranscript = acpSessionTranscript({
  sessionId: 'session-internal',
  entries: [
    { id: 'internal-user', type: 'message', role: 'user', internal: true, content: [{ type: 'text', text: '' }] },
    { id: 'internal-tool', type: 'tool', internal: true, title: 'Check CI', status: 'completed' },
    { id: 'internal-progress', type: 'message', role: 'assistant', internal: true, content: [{ type: 'text', text: 'Checking' }] },
    { id: 'notify', type: 'message', role: 'assistant', internal: true, content: [{ type: 'text', text: 'CI is green' }] },
    { id: 'human-user', type: 'message', role: 'user', internal: false, content: [{ type: 'text', text: 'Status?' }] },
    { id: 'human-tool', type: 'tool', internal: false, title: 'Read status', status: 'completed' },
    { id: 'human-answer', type: 'message', role: 'assistant', internal: false, content: [{ type: 'text', text: 'Done' }] },
  ],
});
assert.strictEqual(internalTranscript.turns.length, 2);
assert.strictEqual(internalTranscript.turns[0].userMessage, '');
assert.strictEqual(internalTranscript.turns[0].finalMessage, 'CI is green');
assert.strictEqual(internalTranscript.turns[0].processItems.length, 0);
assert.strictEqual(internalTranscript.turns[1].userMessage, 'Status?');
assert.strictEqual(internalTranscript.turns[1].processItems.length, 1);

const paged = acpSessionTranscript({
  sessionId: 'session-paged',
  entries: Array.from({ length: 25 }, (_, index) => ([
    { id: `user-${index}`, type: 'message', role: 'user', content: [{ type: 'text', text: `question ${index}` }] },
    { id: `answer-${index}`, type: 'message', role: 'assistant', content: [{ type: 'text', text: `answer ${index}` }] },
  ])).flat(),
}, { maxTurns: 20 });
assert.strictEqual(paged.turns.length, 20);
assert.strictEqual(paged.turns[0].userMessage, 'question 5');
assert.strictEqual(paged.hasMoreBefore, true);

const largeOldText = `${'same\n'.repeat(20_000)}old\n${'tail\n'.repeat(20_000)}`;
const largeNewText = largeOldText.replace('\nold\n', '\nnew\n');
const compactDiffTranscript = acpSessionTranscript({
  entries: [
    { id: 'user-large', type: 'message', role: 'user', content: [{ type: 'text', text: 'Change one line' }] },
    {
      id: 'tool-large',
      type: 'tool',
      title: 'Editing files',
      status: 'completed',
      content: [{ type: 'diff', path: '/tmp/large.txt', oldText: largeOldText, newText: largeNewText }],
    },
    { id: 'answer-large', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'Done' }] },
  ],
});
assert.strictEqual(compactDiffTranscript.turns[0].processItems[0].type, 'patch');
assert(compactDiffTranscript.turns[0].processItems[0].detail.length < 10_000, 'a small edit must not resend both full files');

const activePlanTranscript = acpSessionTranscript({
  state: 'working',
  entries: [
    { id: 'user-plan', type: 'message', role: 'user', content: [{ type: 'text', text: 'Implement it' }] },
    {
      id: 'plan-active',
      type: 'plan',
      plan: { entries: [
        { content: 'Inspect code', status: 'completed' },
        { content: 'Update parser', status: 'in_progress' },
        { content: 'Run tests', status: 'pending' },
      ] },
    },
  ],
});
assert.strictEqual(activePlanTranscript.turns[0].processItems[0].completedSteps, 1);
assert.strictEqual(activePlanTranscript.turns[0].processItems[0].totalSteps, 3);
assert.strictEqual(activePlanTranscript.turns[0].processItems[0].currentStep, 'Update parser');

const largeToolTranscript = acpSessionTranscript({
  revision: 7,
  delta: true,
  hasMoreBefore: true,
  entries: [
    { id: 'user-large-tool', type: 'message', role: 'user', content: [{ type: 'text', text: 'Inspect output' }] },
    { id: 'tool-large-output', type: 'tool', title: 'Run command', status: 'completed', rawOutput: 'x'.repeat(100_000) },
  ],
});
assert.strictEqual(largeToolTranscript.revision, 7);
assert.strictEqual(largeToolTranscript.delta, true);
assert.strictEqual(largeToolTranscript.replaceFromTurnId, 'acp-turn-user-large-tool');
assert.strictEqual(largeToolTranscript.hasMoreBefore, true);
assert.strictEqual(largeToolTranscript.turns[0].processItems[0].detailTruncated, true);
assert(largeToolTranscript.turns[0].processItems[0].detail.length < 5_000);

const limitedTranscript = acpSessionTranscript({
  title: 'Limited run',
  state: 'error',
  error: 'Input exceeds the context window',
  errorKind: 'context',
  stopReason: 'max_tokens',
  entries: [
    { id: 'user-limited', type: 'message', role: 'user', content: [{ type: 'text', text: 'Long task' }] },
    { id: 'answer-limited', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'Partial answer' }] },
  ],
});
assert.strictEqual(limitedTranscript.stopReason, 'max_tokens');
assert.strictEqual(limitedTranscript.title, 'Limited run');
assert.strictEqual(limitedTranscript.state, 'error');
assert.strictEqual(limitedTranscript.error, 'Input exceeds the context window');
assert.strictEqual(limitedTranscript.errorKind, 'context');
assert.strictEqual(limitedTranscript.turns[0].status, 'interrupted');

const authenticationErrorTranscript = acpSessionTranscript({
  state: 'error',
  error: '401 Unauthorized: sign in required',
  errorKind: 'authentication',
  stopReason: 'error',
  entries: [
    { id: 'user-auth', type: 'message', role: 'user', content: [{ type: 'text', text: 'Continue' }] },
    { id: 'error-auth', type: 'error', kind: 'authentication', message: '401 Unauthorized: sign in required', status: 'failed' },
  ],
});
assert.strictEqual(authenticationErrorTranscript.turns[0].status, 'interrupted');
assert.deepStrictEqual(authenticationErrorTranscript.turns[0].processItems[0], {
  id: 'error-auth',
  type: 'error',
  kind: 'authentication',
  title: 'Authentication required',
  detail: '401 Unauthorized: sign in required',
  status: 'failed',
});

const structuredTranscript = acpSessionTranscript({
  entries: [
    {
      id: 'user-structured',
      type: 'message',
      role: 'user',
      turnStartedAt: 1783990800000,
      turnCompletedAt: 1783990803250,
      turnDurationMs: 3250,
      content: [{ type: 'text', text: 'Delegate it' }],
    },
    { id: 'compaction-structured', type: 'compaction', status: 'completed' },
    {
      id: 'subagent-structured',
      type: 'tool',
      title: 'Review implementation',
      status: 'completed',
      _meta: { subagent_session_info: { session_id: 'child-session' } },
    },
  ],
});
assert.strictEqual(structuredTranscript.turns[0].startedAt, 1783990800000);
assert.strictEqual(structuredTranscript.turns[0].completedAt, 1783990803250);
assert.strictEqual(structuredTranscript.turns[0].durationMs, 3250);
assert.deepStrictEqual(structuredTranscript.turns[0].processItems.map(item => item.type), ['compaction', 'subagent']);
assert.match(structuredTranscript.turns[0].processItems[1].detail, /child-session/);
assert.strictEqual(structuredTranscript.turns[0].processItems[1].subagentSessionId, 'child-session');

const richContentTranscript = acpSessionTranscript({
  entries: [
    {
      id: 'user-rich',
      type: 'message',
      role: 'user',
      content: [
        { type: 'text', text: 'Inspect these resources' },
        { type: 'resource_link', name: 'Guide', uri: 'file:///tmp/guide.md' },
        { type: 'audio', mimeType: 'audio/wav', data: 'UklGRg==' },
      ],
    },
    {
      id: 'tool-rich',
      type: 'tool',
      title: 'Open resources',
      status: 'completed',
      content: [
        { type: 'content', content: { type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' } },
        { type: 'content', content: { type: 'audio', mimeType: 'audio/mpeg', data: 'SUQz' } },
        { type: 'content', content: { type: 'resource', resource: { name: 'Result', uri: 'file:///tmp/result.txt', text: 'result text' } } },
      ],
    },
  ],
});
assert.strictEqual(richContentTranscript.turns[0].userFiles[0].name, 'Guide');
assert.strictEqual(richContentTranscript.turns[0].userFiles[0].resourceKind, 'link');
assert.match(richContentTranscript.turns[0].userAudios[0].url, /^data:audio\/wav;base64,/);
assert.match(richContentTranscript.turns[0].processItems[0].images[0].url, /^data:image\/png;base64,/);
assert.match(richContentTranscript.turns[0].processItems[0].audios[0].url, /^data:audio\/mpeg;base64,/);
assert.strictEqual(richContentTranscript.turns[0].processItems[0].files[0].content, 'result text');

const rawMcpMediaTranscript = acpSessionTranscript({
  entries: [
    { id: 'user-mcp-media', type: 'message', role: 'user', content: [{ type: 'text', text: 'Inspect the browser' }] },
    {
      id: 'tool-mcp-media',
      type: 'tool',
      kind: 'execute',
      title: 'mcp.computer-use.get_app_state',
      status: 'completed',
      rawInput: { server: 'computer-use', tool: 'get_app_state' },
      rawOutput: {
        result: {
          content: [
            {
              type: 'text',
              text: '<app_specific_instructions>internal browser instructions</app_specific_instructions>\n<app_state>Visible browser state</app_state>',
            },
            { type: 'image', mimeType: 'image/jpeg', data: 'aGVsbG8=' },
          ],
        },
        error: null,
      },
    },
  ],
});
const rawMcpMediaItem = rawMcpMediaTranscript.turns[0].processItems[0];
assert.match(rawMcpMediaItem.images[0].url, /^data:image\/jpeg;base64,/);
assert.match(rawMcpMediaItem.detail, /Visible browser state/);
assert.doesNotMatch(rawMcpMediaItem.detail, /internal browser instructions/);
assert.doesNotMatch(rawMcpMediaItem.detail, /aGVsbG8=/);

const generatedMediaTranscript = acpSessionTranscript({
  entries: [
    { id: 'user-generate', type: 'message', role: 'user', content: [{ type: 'text', text: 'Draw it' }] },
    {
      id: 'ig_generated-result',
      type: 'tool',
      title: 'Image generation',
      status: 'in_progress',
      content: [
        { type: 'content', content: { type: 'text', text: 'Revised prompt' } },
        { type: 'content', content: { type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' } },
      ],
      rawOutput: {
        status: 'generating',
        revisedPrompt: 'Revised prompt',
        result: 'aGVsbG8=',
        savedPath: '/tmp/generated_images/ig_generated-result.png',
      },
    },
  ],
});
assert.match(generatedMediaTranscript.turns[0].resultImages[0].url, /^data:image\/png;base64,/);
assert.strictEqual(generatedMediaTranscript.turns[0].processItems[0].images, undefined);
assert.strictEqual(generatedMediaTranscript.turns[0].finalMessage, '');

const compactedTranscript = acpSessionTranscript({
  entries: [
    { id: 'user-compacted', type: 'message', role: 'user', content: [{ type: 'text', text: 'Continue' }] },
    {
      id: 'answer-compacted',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: "*Context compacted to fit the model's context window.*\n\nActual answer" }],
    },
  ],
});
assert.strictEqual(compactedTranscript.turns[0].finalMessage, 'Actual answer');

const replayedCompactionTranscript = acpSessionTranscript({
  entries: [
    { id: 'user-replayed-compaction', type: 'message', role: 'user', content: [{ type: 'text', text: 'Reply' }] },
    {
      id: 'answer-replayed-compaction',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'Actual answerContext compacted.' }],
    },
  ],
});
assert.strictEqual(replayedCompactionTranscript.turns[0].finalMessage, 'Actual answer');

console.log('ACP transcript tests passed');
