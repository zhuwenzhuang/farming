const assert = require('assert');
const { acpTranscriptToolEntry } = require('../acp-transcript');
const { projectAcpTranscript } = require('../../src/components/code/acp/acp-entry-projection.ts');
const { acpCollaborationEvents } = require('../../src/components/code/acp/acp-collaboration.ts');

const compactActivity = acpTranscriptToolEntry({
  id: 'activity-review',
  type: 'tool',
  kind: 'other',
  title: 'Interact with subagent review_refresh',
  status: 'completed',
  rawInput: {
    agentThreadId: 'thread-review',
    agentPath: 'review_refresh',
    activityKind: 'interacted',
  },
  _meta: {
    codex: {
      subagent: {
        threadId: 'thread-review',
        path: 'review_refresh',
        activity: 'interacted',
      },
    },
  },
});
assert.deepStrictEqual(compactActivity._meta.codex.subagent, {
  threadId: 'thread-review',
  path: 'review_refresh',
  activity: 'interacted',
});

const oversizedStates = Object.fromEntries(Array.from({ length: 20 }, (_, index) => [
  `thread-${index}`,
  { status: index === 0 ? 'completed' : 'running', message: 'x'.repeat(700) },
]));
const compactWait = acpTranscriptToolEntry({
  id: 'wait-browser',
  type: 'tool',
  kind: 'other',
  title: 'Wait for agents',
  status: 'completed',
  rawInput: {
    senderThreadId: 'thread-parent',
    receiverThreadIds: Object.keys(oversizedStates),
    agentsStates: oversizedStates,
  },
  _meta: {
    codex: {
      collaboration: {
        tool: 'wait',
        senderThreadId: 'thread-parent',
        receiverThreadIds: Object.keys(oversizedStates),
      },
    },
  },
});
assert.strictEqual(compactWait._meta.codex.collaboration.receiverThreadIds.length, 16);
assert.strictEqual(Object.keys(compactWait._meta.codex.collaboration.agentsStates).length, 16);
assert.strictEqual(compactWait._meta.codex.collaboration.agentsStates['thread-0'].message.length, 160);
assert(!JSON.stringify(compactWait._meta).includes('x'.repeat(700)), 'collaboration metadata must remain bounded');
assert(JSON.stringify(compactWait).length < 12 * 1024, 'the collaboration transcript envelope must remain compact');

const transcript = projectAcpTranscript({
  sessionId: 'parent-session',
  state: 'idle',
  entries: [
    { id: 'user', type: 'message', role: 'user', content: [{ type: 'text', text: 'Coordinate the checks' }] },
    compactActivity,
    {
      ...compactWait,
      _meta: {
        codex: {
          collaboration: {
            tool: 'wait',
            senderThreadId: 'thread-parent',
            receiverThreadIds: ['thread-review'],
            agentsStates: {
              'thread-review': { status: 'completed', message: 'Review passed' },
            },
          },
        },
      },
    },
    { id: 'answer', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'Done' }] },
  ],
});
assert.deepStrictEqual(transcript.turns[0].processItems.map(item => item.type), ['collaboration', 'collaboration']);
assert.deepStrictEqual(
  acpCollaborationEvents(transcript.turns[0].processItems).map(event => [event.name, event.action, event.processItemId]),
  [
    ['Review refresh', 'updated', 'activity-review'],
    ['Review refresh', 'finished', 'wait-browser'],
  ],
);

const fallbackEvents = acpCollaborationEvents([{
  id: 'spawn-fallback',
  type: 'collaboration',
  title: 'spawnAgent',
  status: 'completed',
  collaboration: {
    kind: 'tool',
    tool: 'spawnAgent',
    receiverThreadIds: ['thread-new-agent'],
  },
}]);
assert.strictEqual(fallbackEvents[0].action, 'started');
assert.strictEqual(fallbackEvents[0].name, 'Agent thread');

console.log('ACP collaboration projection tests passed');
