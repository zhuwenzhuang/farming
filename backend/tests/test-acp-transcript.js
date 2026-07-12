const assert = require('assert');
const { acpSessionTranscript } = require('../acp-transcript');

const transcript = acpSessionTranscript({
  sessionId: 'session-1',
  updatedAt: '2026-07-12T12:00:00.000Z',
  state: 'working',
  entries: [
    { id: 'user-1', type: 'message', role: 'user', content: [{ type: 'text', text: 'Fix it' }] },
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
assert.strictEqual(transcript.state, 'working');
assert.deepStrictEqual(transcript.entries.map(entry => entry.type), [
  'message', 'thought', 'tool', 'plan', 'message',
]);
assert.strictEqual(transcript.entries[0].text, 'Fix it');
assert.strictEqual(transcript.entries[4].text, 'Done');
assert.strictEqual(transcript.entries[1].detail, 'Inspecting');
assert.strictEqual(transcript.entries[3].detail, 'completed: Run tests');
assert.match(transcript.entries[2].detail, /Input\n[\s\S]*npm test/);
assert.match(transcript.entries[2].detail, /running/);
assert.match(transcript.entries[2].detail, /File: \/tmp\/a\.js/);
assert.match(transcript.entries[2].detail, /Terminal: terminal-1/);
assert.match(transcript.entries[2].detail, /Output\nok/);
assert.match(transcript.entries[2].detail, /Locations\n\/tmp\/a\.js:3/);

const internalTranscript = acpSessionTranscript({
  sessionId: 'session-internal',
  entries: [
    { id: 'internal-user', type: 'message', role: 'user', internal: true, content: [{ type: 'text', text: '' }] },
    { id: 'internal-tool', type: 'tool', internal: true, title: 'Check CI', status: 'completed' },
    { id: 'internal-thought', type: 'thought', internal: true, content: [{ type: 'text', text: 'hidden' }] },
    { id: 'notify', type: 'message', role: 'assistant', internal: true, content: [{ type: 'text', text: 'CI is green' }] },
    { id: 'human-user', type: 'message', role: 'user', internal: false, content: [{ type: 'text', text: 'Status?' }] },
    { id: 'human-tool', type: 'tool', internal: false, title: 'Read status', status: 'completed' },
    { id: 'human-answer', type: 'message', role: 'assistant', internal: false, content: [{ type: 'text', text: 'Done' }] },
  ],
});
assert.deepStrictEqual(internalTranscript.entries.map(entry => entry.id), [
  'notify', 'human-user', 'human-tool', 'human-answer',
]);
assert.strictEqual(internalTranscript.entries[0].internal, true);

const paged = acpSessionTranscript({
  sessionId: 'session-paged',
  entries: Array.from({ length: 105 }, (_, index) => ({
    id: `message-${index}`,
    type: 'message',
    role: index % 2 ? 'assistant' : 'user',
    content: [{ type: 'text', text: `message ${index}` }],
  })),
}, { maxEntries: 100 });
assert.strictEqual(paged.entries.length, 100);
assert.strictEqual(paged.entries[0].id, 'message-5');
assert.strictEqual(paged.hasMoreBefore, true);

console.log('ACP transcript tests passed');
