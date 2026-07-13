const assert = require('assert');
const { acpSessionTranscript } = require('../acp-transcript');

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
assert.strictEqual(transcript.turns[0].processItems[3].completedSteps, 1);
assert.strictEqual(transcript.turns[0].processItems[3].totalSteps, 1);
assert.strictEqual(transcript.turns[0].processItems[3].currentStep, '');
assert.match(transcript.turns[0].processItems[2].detail, /^Updated \/tmp\/a\.js/);
assert.match(transcript.turns[0].processItems[2].detail, /Input\n[\s\S]*npm test/);
assert.match(transcript.turns[0].processItems[2].detail, /File: \/tmp\/a\.js/);
assert.match(transcript.turns[0].processItems[2].detail, /-old/);
assert.match(transcript.turns[0].processItems[2].detail, /\+new/);
assert.match(transcript.turns[0].processItems[2].detail, /Terminal: terminal-1/);
assert.match(transcript.turns[0].processItems[2].detail, /Output\nok/);
assert.match(transcript.turns[0].processItems[2].detail, /Locations\n\/tmp\/a\.js:3/);

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
  stopReason: 'max_tokens',
  entries: [
    { id: 'user-limited', type: 'message', role: 'user', content: [{ type: 'text', text: 'Long task' }] },
    { id: 'answer-limited', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'Partial answer' }] },
  ],
});
assert.strictEqual(limitedTranscript.stopReason, 'max_tokens');
assert.strictEqual(limitedTranscript.turns[0].status, 'interrupted');

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
