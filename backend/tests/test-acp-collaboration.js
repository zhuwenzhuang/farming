const assert = require('assert');
const { AcpSessionState } = require('../acp-session-state');
const { acpTranscriptToolEntry } = require('../acp-transcript');
const { projectAcpTranscript } = require('../../src/components/code/acp/acp-entry-projection.ts');
const {
  acpCollaborationAgents,
  acpCollaborationEvents,
} = require('../../src/components/code/acp/acp-collaboration.ts');

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
    ['Review refresh', 'recorded', 'wait-browser'],
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
const stableIconAgents = acpCollaborationAgents([
  {
    id: 'icon-a-start',
    type: 'collaboration',
    title: 'Start A',
    status: 'completed',
    collaboration: {
      kind: 'activity',
      threadId: 'thread-review-refresh',
      agentPath: 'review_refresh',
      activity: 'started',
    },
  },
  {
    id: 'icon-a-update',
    type: 'collaboration',
    title: 'Update A',
    status: 'completed',
    collaboration: {
      kind: 'activity',
      threadId: 'thread-review-refresh',
      agentPath: 'review_refresh',
      activity: 'interacted',
    },
  },
  {
    id: 'icon-b-start',
    type: 'collaboration',
    title: 'Start B',
    status: 'completed',
    collaboration: {
      kind: 'activity',
      threadId: 'thread-browser-guards',
      agentPath: 'browser_guards',
      activity: 'started',
    },
  },
  {
    id: 'icon-c-start',
    type: 'collaboration',
    title: 'Start C',
    status: 'completed',
    collaboration: {
      kind: 'activity',
      threadId: 'thread-crt-races',
      agentPath: 'crt_races',
      activity: 'started',
    },
  },
  ...[
    ['thread-icon-9', 'icon-d-start'],
    ['thread-icon-36', 'icon-e-start'],
    ['thread-icon-10', 'icon-f-start'],
  ].map(([threadId, id]) => ({
    id,
    type: 'collaboration',
    title: `Start ${id}`,
    status: 'completed',
    collaboration: {
      kind: 'activity',
      threadId,
      agentPath: id,
      activity: 'started',
    },
  })),
]);
assert(stableIconAgents.every(agent => agent.status === 'unknown'));
assert.deepStrictEqual(
  stableIconAgents.map(agent => agent.icon),
  [4, 3, 5, 0, 1, 2],
  'the child thread identities cover all six stable base Agent icons',
);

const realSessionStates = [
  { threadId: 'thread-review-refresh', status: 'completed' },
  { threadId: 'thread-browser-guards', status: 'interrupted' },
  { threadId: 'thread-crt-races', parentThreadId: 'thread-review-refresh', status: 'running' },
];
const realSessionAgents = acpCollaborationAgents([
  {
    id: 'review-interrupt-request',
    type: 'collaboration',
    title: 'Interrupt subagent review_refresh',
    status: 'completed',
    collaboration: {
      kind: 'activity',
      threadId: 'thread-review-refresh',
      agentPath: '/root/review_refresh',
      activity: 'interrupted',
    },
  },
  {
    id: 'browser-started',
    type: 'collaboration',
    title: 'Start subagent browser_guards',
    status: 'completed',
    collaboration: {
      kind: 'activity',
      threadId: 'thread-browser-guards',
      agentPath: '/root/browser_guards',
      activity: 'started',
    },
  },
  {
    id: 'nested-started',
    type: 'collaboration',
    title: 'Start subagent crt_races',
    status: 'completed',
    collaboration: {
      kind: 'activity',
      threadId: 'thread-crt-races',
      agentPath: '/root/review_refresh/crt_races',
      activity: 'started',
    },
  },
], realSessionStates);
assert.deepStrictEqual(
  realSessionAgents.map(agent => [agent.threadId, agent.status, agent.parentThreadId || null]),
  [
    ['thread-review-refresh', 'completed', null],
    ['thread-browser-guards', 'paused', null],
    ['thread-crt-races', 'running', 'thread-review-refresh'],
  ],
  'activity verbs never overwrite the authoritative child lifecycle snapshot',
);
const stateOnlyAncestors = acpCollaborationAgents([
  {
    id: 'child-follow-up',
    type: 'collaboration',
    title: 'Interact with subagent child',
    status: 'completed',
    collaboration: {
      kind: 'activity',
      threadId: 'thread-child',
      agentPath: '/root/parent/child',
      activity: 'interacted',
    },
  },
], [
  { threadId: 'thread-parent', name: 'Parent reviewer', status: 'completed' },
  {
    threadId: 'thread-child',
    name: 'Child verifier',
    parentThreadId: 'thread-parent',
    status: 'completed',
  },
]);
assert.deepStrictEqual(
  stateOnlyAncestors.map(agent => [
    agent.threadId,
    agent.name,
    agent.parentThreadId || null,
    agent.events.length,
  ]),
  [
    ['thread-child', 'Child verifier', 'thread-parent', 1],
    ['thread-parent', 'Parent reviewer', null, 0],
  ],
  'authoritative state supplies a missing ancestor so cross-turn child activity cannot escape to the top level',
);

const reducer = new AcpSessionState({
  provider: 'codex',
  sessionId: 'parent-session',
  cwd: '/tmp',
});
reducer.apply({
  sessionId: 'parent-session',
  update: {
    sessionUpdate: 'session_info_update',
    _meta: {
      codex: {
        subagents: {
          version: 1,
          rootThreadId: 'parent-session',
          revision: 4,
          kind: 'snapshot',
          agents: realSessionStates,
        },
      },
    },
  },
});
const snapshotRevision = reducer.revision;
reducer.apply({
  sessionId: 'parent-session',
  update: {
    sessionUpdate: 'session_info_update',
    _meta: {
      codex: {
        subagents: {
          version: 1,
          rootThreadId: 'parent-session',
          revision: 5,
          kind: 'delta',
          agents: [{ threadId: 'thread-crt-races', parentThreadId: 'thread-review-refresh', status: 'completed' }],
        },
      },
    },
  },
});
assert.strictEqual(reducer.revision, snapshotRevision + 1);
assert.deepStrictEqual(
  reducer.transcriptSlice({ sinceRevision: snapshotRevision }).codexSubagents.agents,
  [
    { threadId: 'thread-review-refresh', parentThreadId: null, status: 'completed' },
    { threadId: 'thread-browser-guards', parentThreadId: null, status: 'interrupted' },
    { threadId: 'thread-crt-races', parentThreadId: 'thread-review-refresh', status: 'completed' },
  ],
  'a state-only delta advances the transcript revision and merges without inventing an ACP entry',
);
assert.strictEqual(
  acpCollaborationAgents(stableIconAgents[0].events.map(event => ({
    id: event.processItemId,
    type: 'collaboration',
    title: event.title,
    status: 'completed',
    collaboration: {
      kind: 'activity',
      threadId: event.threadId,
      agentPath: 'review_refresh',
      activity: event.action === 'updated' ? 'interacted' : event.action,
    },
  })))[0].icon,
  stableIconAgents[0].icon,
  'an Agent icon stays stable as more events arrive for the same thread',
);

const unknownEvents = acpCollaborationEvents([
  {
    id: 'unknown-activity',
    type: 'collaboration',
    title: 'Provider-specific child activity',
    status: 'completed',
    collaboration: {
      kind: 'activity',
      threadId: 'thread-unknown',
      agentPath: 'unknown_worker',
      activity: 'provider_future_action',
    },
  },
  {
    id: 'unknown-tool',
    type: 'collaboration',
    title: 'Provider-specific child tool',
    status: 'mystery',
    collaboration: {
      kind: 'tool',
      tool: 'providerFutureTool',
      receiverThreadIds: ['thread-unknown'],
    },
  },
]);
assert.deepStrictEqual(
  unknownEvents.map(event => [event.name, event.action, event.processItemId]),
  [
    ['Unknown worker', 'recorded', 'unknown-activity'],
    ['Unknown worker', 'recorded', 'unknown-tool'],
  ],
  'an attributed child record must stay in its child thread even when its lifecycle action is unknown',
);
assert.deepStrictEqual(
  acpCollaborationAgents([
    ...Array.from({ length: 30 }, (_, index) => ({
      id: `unknown-${index}`,
      type: 'collaboration',
      title: `Provider child activity ${index}`,
      status: 'completed',
      collaboration: {
        kind: 'activity',
        threadId: 'thread-many-activities',
        agentPath: 'many_activities',
        activity: `provider_action_${index}`,
      },
    })),
  ])[0].activities.length,
  30,
  'distinct child activities remain available for the bounded UI activity window',
);

console.log('ACP collaboration projection tests passed');
