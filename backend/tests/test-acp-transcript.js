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
  'Progress updates', 'Reasoning', 'Run tests', 'Plan',
]);
assert.strictEqual(transcript.turns[0].processItems[2].type, 'patch');
assert.match(transcript.turns[0].processItems[2].detail, /^Updated \/tmp\/a\.js/);
assert.match(transcript.turns[0].processItems[2].detail, /Input\n[\s\S]*npm test/);
assert.match(transcript.turns[0].processItems[2].detail, /File: \/tmp\/a\.js/);
assert.match(transcript.turns[0].processItems[2].detail, /-old/);
assert.match(transcript.turns[0].processItems[2].detail, /\+new/);
assert.match(transcript.turns[0].processItems[2].detail, /Terminal: terminal-1/);
assert.match(transcript.turns[0].processItems[2].detail, /Output\nok/);
assert.match(transcript.turns[0].processItems[2].detail, /Locations\n\/tmp\/a\.js:3/);

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

console.log('ACP transcript tests passed');
