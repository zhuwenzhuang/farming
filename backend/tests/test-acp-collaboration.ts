const assert = require('assert');
const { AcpSessionState } = require('../acp-session-state.cjs');
const { acpTranscriptToolEntry, acpCollaborationMessage } = require('../acp-transcript.cjs');
const { projectAcpTranscript } = require('../../src/components/code/acp/acp-entry-projection.ts');
const {
  acpCollaborationAgents,
  acpCollaborationAgentsForTurn,
  acpCollaborationEvents,
  acpOutgoingSummary,
  outgoingMessagePreview,
  acpCollaborationActivityFeed,
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

const sharedPrefixThreadIds = [
  '01a06578-0ef2-7380-adf7-b10aab1b995a',
  '01a06578-3408-7312-a7ec-692779aef497',
  '01a06578-645e-7ab1-8d44-5cdf556c0c7d',
];
const compactSpawn = acpTranscriptToolEntry({
  id: 'spawn-mobile-review',
  type: 'tool',
  kind: 'other',
  title: 'Agent spawnAgent',
  status: 'completed',
  rawInput: {
    prompt: '  Audit the mobile responsive WIP\nwithout changing files.  ',
    receiverThreadIds: sharedPrefixThreadIds,
    agentsStates: Object.fromEntries(sharedPrefixThreadIds.map(threadId => [
      threadId,
      { status: 'pendingInit' },
    ])),
  },
  _meta: {
    codex: {
      collaboration: {
        tool: 'spawnAgent',
        receiverThreadIds: sharedPrefixThreadIds,
      },
    },
  },
});
assert.strictEqual(
  compactSpawn._meta.codex.collaboration.task,
  'Audit the mobile responsive WIP without changing files.',
  'spawnAgent keeps one bounded display task in the compact transcript',
);

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
assert.deepStrictEqual(
  acpCollaborationAgents(transcript.turns[0].processItems).map(agent => [agent.threadId, agent.status]),
  [['thread-review', 'completed']],
  'a historical wait result supplies the latest known Agent lifecycle state when no live snapshot is available',
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

const sharedPrefixAgents = acpCollaborationAgents(projectAcpTranscript({
  sessionId: 'same-prefix-parent',
  state: 'idle',
  entries: [compactSpawn],
}).turns[0].processItems);
assert.deepStrictEqual(
  sharedPrefixAgents.map(agent => [agent.name, agent.task, agent.status]),
  [
    ['Agent 1b995a', 'Audit the mobile responsive WIP without changing files.', 'unknown'],
    ['Agent aef497', 'Audit the mobile responsive WIP without changing files.', 'unknown'],
    ['Agent 6c0c7d', 'Audit the mobile responsive WIP without changing files.', 'unknown'],
  ],
  'same-prefix UUIDv7 Agents stay distinguishable and a completed spawn snapshot is not presented as live pending state',
);
assert.deepStrictEqual(
  acpCollaborationAgents(projectAcpTranscript({
    sessionId: 'same-prefix-parent-live',
    state: 'idle',
    entries: [compactSpawn],
  }).turns[0].processItems, [{ threadId: sharedPrefixThreadIds[0], status: 'pendingInit' }])
    .find(agent => agent.threadId === sharedPrefixThreadIds[0])?.status,
  'pending',
  'an authoritative live snapshot still exposes pending initialization',
);
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
assert.strictEqual(
  acpCollaborationAgents(transcript.turns[0].processItems, [{
    threadId: 'thread-review',
    status: 'running',
  }])[0].status,
  'running',
  'a live lifecycle snapshot overrides older status evidence recorded in the transcript',
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

const turnScopedStates = [
  { threadId: 'thread-turn-a', name: 'Goodall', status: 'completed' },
  {
    threadId: 'thread-turn-a-child',
    name: 'Carver',
    parentThreadId: 'thread-turn-a',
    status: 'completed',
  },
  { threadId: 'thread-turn-b', name: 'Feynman', status: 'running' },
];
const turnAAgents = acpCollaborationAgentsForTurn([
  {
    id: 'turn-a-start',
    type: 'collaboration',
    title: 'Start subagent review_refresh',
    status: 'completed',
    collaboration: {
      kind: 'activity',
      threadId: 'thread-turn-a',
      agentPath: '/root/review_refresh',
      activity: 'started',
    },
  },
], turnScopedStates);
assert.deepStrictEqual(
  turnAAgents.map(agent => [
    agent.threadId,
    agent.task || null,
    agent.name,
    agent.parentThreadId || null,
  ]),
  [
    ['thread-turn-a', 'Review refresh', 'Goodall', null],
  ],
  'a Turn includes its named task and authoritative identity without pulling future descendants backward',
);
const turnBAgents = acpCollaborationAgentsForTurn([
  {
    id: 'turn-b-update',
    type: 'collaboration',
    title: 'Interact with subagent browser_guards',
    status: 'completed',
    collaboration: {
      kind: 'activity',
      threadId: 'thread-turn-b',
      agentPath: '/root/browser_guards',
      activity: 'interacted',
    },
  },
], turnScopedStates);
assert.deepStrictEqual(
  turnBAgents.map(agent => [agent.threadId, agent.task, agent.name]),
  [['thread-turn-b', 'Browser guards', 'Feynman']],
  'unrelated subagent snapshots never leak into another Turn',
);
assert.strictEqual(
  turnAAgents.some(agent => agent.threadId === 'thread-turn-a-child'),
  false,
  'a child first observed in a later Turn must not appear in the earlier parent-start Turn',
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


const activity = (id, threadId, action = 'interacted') => ({ id, type: 'collaboration', status: 'completed', title: 'Progress',
  collaboration: { kind: 'activity', threadId, agentPath: threadId, activity: action } });
const orderedFeed = acpCollaborationActivityFeed([
  activity('a1', 'alpha'), activity('a2', 'alpha'), activity('b1', 'beta'), activity('a3', 'alpha'),
]);
assert.deepStrictEqual(orderedFeed.map(event => [event.threadId, event.count]), [['alpha', 2], ['beta', 1], ['alpha', 1]],
  'only adjacent updates coalesce; interleaved Agent activity keeps chronological order');
assert.deepStrictEqual(orderedFeed[0].processItemIds, ['a1', 'a2']);
assert.deepStrictEqual(acpCollaborationActivityFeed([]), [], 'inventory changes cannot create Chat events');

// Codex ACP 2.2.x exposes collaboration as structured tool input without
// the legacy _meta.codex extension. Exercise the real compact transport path.
const nativeMessage = {
  toolCallId: 'peer-send-1', sessionUpdate: 'tool_call', title: 'sendInput', kind: 'other', status: 'in_progress',
  rawInput: { senderThreadId: 'session-sender', receiverThreadIds: ['session-peer'], prompt: 'Keep the shared transport unchanged.\nI will own storage.', agentsStates: { 'session-peer': { status: 'running' } } },
};
const nativeState = new AcpSessionState({ provider: 'codex', sessionId: 'session-sender' });
nativeState.apply({ sessionId: 'session-sender', update: nativeMessage });
nativeState.apply({ sessionId: 'session-sender', update: { sessionUpdate: 'tool_call_update', toolCallId: 'peer-send-1', status: 'completed' } });
const nativeEntry = acpTranscriptToolEntry(nativeState.sanitizedEntries()[0]);
assert.strictEqual(nativeEntry._meta.codex.collaboration.message, nativeMessage.rawInput.prompt);
assert.strictEqual(nativeEntry._meta.codex.collaboration.senderThreadId, 'session-sender');
const nativeItems = projectAcpTranscript({ sessionId: 'session-sender', state: 'idle', entries: [nativeEntry] }).turns[0].processItems;
assert.strictEqual(acpCollaborationEvents(nativeItems)[0].message, nativeMessage.rawInput.prompt);
assert.strictEqual(acpCollaborationEvents(nativeItems)[0].threadId, 'session-peer');
assert.strictEqual(acpCollaborationEvents(nativeItems)[0].outgoingMessage, true);
assert.strictEqual(acpCollaborationEvents(nativeItems)[0].timestamp, nativeState.sanitizedEntries()[0].lastActivityAt);
assert.strictEqual(acpCollaborationEvents([{ ...nativeItems[0], lastActivityAt: undefined }])[0].timestamp, undefined,
  'restored records without an observed time must not invent a timestamp');
assert.strictEqual(acpCollaborationMessage(nativeState.sanitizedEntries()[0]), nativeMessage.rawInput.prompt);
const longPrompt = 'A full coordination message.\n'.repeat(300) + 'FINAL_BODY_MARKER';
const longEntry = { ...nativeState.sanitizedEntries()[0],
  rawInput: { ...nativeMessage.rawInput, prompt: longPrompt } };
const compactLongEntry = acpTranscriptToolEntry(longEntry);
assert.strictEqual(compactLongEntry._meta.codex.collaboration.message.length, 4000);
assert.strictEqual(compactLongEntry._meta.codex.collaboration.messageTruncated, true);
assert.strictEqual(acpCollaborationMessage(longEntry), longPrompt, 'detail reads retain the exact body beyond the preview budget');
const longItems = projectAcpTranscript({ sessionId: 'session-sender', state: 'idle', entries: [compactLongEntry] }).turns[0].processItems;
assert.strictEqual(acpCollaborationEvents(longItems)[0].messageTruncated, true);
for (const [status, action] of [['pending', 'sending'], ['in_progress', 'sending'], ['failed', 'failed'], ['cancelled', 'cancelled'], ['completed', 'updated']]) {
  const event = acpCollaborationEvents([{ ...nativeItems[0], status }])[0];
  assert.strictEqual(event.action, action, `${status} must never imply a different delivery result`);
}
assert.strictEqual(acpCollaborationEvents([{ ...nativeItems[0],
  collaboration: { ...nativeItems[0].collaboration, tool: 'wait' } }])[0].outgoingMessage, false,
  'a child result body is not an outgoing message');
const repeatedNativeItems = [...nativeItems, { ...nativeItems[0], id: 'peer-send-2' }];
assert.strictEqual(acpCollaborationActivityFeed(repeatedNativeItems).length, 2, 'separate sends with identical text remain separately inspectable');
const legacyCheckpoint = nativeState.exportCheckpoint();
delete legacyCheckpoint.entries[0]._meta;
const restoredNativeState = AcpSessionState.fromCheckpoint(legacyCheckpoint);
assert.deepStrictEqual(acpTranscriptToolEntry(restoredNativeState.sanitizedEntries()[0])._meta, nativeEntry._meta,
  'stored structured events acquire the same normalized metadata without rewriting stored history');
assert.strictEqual(legacyCheckpoint.entries[0]._meta, undefined);
const unrelatedState = new AcpSessionState({ provider: 'claude', sessionId: 'unrelated' });
unrelatedState.apply({ sessionId: 'unrelated', update: nativeMessage });
assert.strictEqual(acpTranscriptToolEntry(unrelatedState.sanitizedEntries()[0])._meta, undefined,
  'provider-specific recognition stays inside the Codex boundary');

for (const [status, expected] of [['pending', 'sending'], ['in_progress', 'sending'], ['failed', 'failed'], ['completed', 'updated'], ['cancelled', 'cancelled'], ['future-status', 'recorded']]) {
  const items = projectAcpTranscript({ sessionId: 'session-sender', state: 'idle', entries: [{ ...nativeEntry, status }] }).turns[0].processItems;
  assert.strictEqual(acpCollaborationEvents(items)[0].action, expected);
  assert.strictEqual(acpCollaborationEvents(items)[0].id, acpCollaborationEvents(nativeItems)[0].id,
    'a send keeps its disclosure identity through pending, success, failure and cancellation');
}
assert.strictEqual(acpCollaborationAgents(repeatedNativeItems)[0].activities.length, 2);
const nativeSubagent = new AcpSessionState({ provider: 'codex', sessionId: 'session-sender' });
nativeSubagent.apply({ sessionId: 'session-sender', update: { sessionUpdate: 'tool_call', toolCallId: 'native-activity', title: 'Interact with subagent checks', kind: 'other', status: 'completed', rawInput: { agentThreadId: 'session-checks', agentPath: '/root/checks', activityKind: 'interacted' } } });
assert.strictEqual(acpTranscriptToolEntry(nativeSubagent.sanitizedEntries()[0])._meta.codex.subagent.threadId, 'session-checks');
const queryCommands = [
  'farming list --json',
  '"$FARMING_CLI_BIN_DIR/farming" list --json',
  '"${FARMING_CLI_BIN_DIR}/farming" list --json | python3 -c "print()"',
];
for (const provider of ['codex', 'claude', 'qwen', 'pi']) {
  for (const command of queryCommands) {
    for (const status of ['completed', 'failed', 'cancelled']) {
      const state = new AcpSessionState({ provider, sessionId: 'query-session' });
      const assertOrdinaryQuery = (entries, expectedStatus) => {
        const items = projectAcpTranscript({ sessionId: 'query-session', entries }).turns[0].processItems;
        assert.strictEqual(items.length, 1);
        assert.strictEqual(items[0].type, 'tool');
        assert.strictEqual(items[0].kind, 'execute');
        assert.strictEqual(items[0].status, expectedStatus);
        assert.strictEqual(items[0].title, command);
        assert.strictEqual(items[0].collaboration, undefined);
        assert.deepStrictEqual(acpCollaborationEvents(items), []);
        assert.deepStrictEqual(acpCollaborationAgents(items), []);
        if (expectedStatus !== 'in_progress') assert(items[0].detail.includes('query output'));
      };
      state.apply({ sessionId: 'query-session', update: { sessionUpdate: 'tool_call', toolCallId: 'lookup', title: command, kind: 'execute', status: 'in_progress', rawInput: { command } } });
      assertOrdinaryQuery(state.sanitizedEntries().map(acpTranscriptToolEntry), 'in_progress');
      state.apply({ sessionId: 'query-session', update: { sessionUpdate: 'tool_call_update', toolCallId: 'lookup', status,
        content: [{ type: 'content', content: { type: 'text', text: 'query output' } }] } });
      assertOrdinaryQuery(state.sanitizedEntries().map(acpTranscriptToolEntry), status);
      const checkpoint = AcpSessionState.fromCheckpoint(state.exportCheckpoint());
      const restoredEntries = checkpoint.sanitizedEntries().map(acpTranscriptToolEntry);
      assertOrdinaryQuery(restoredEntries, status);
      // Older compact history may retain the retired discovery marker.
      const legacyEntries = restoredEntries.map(entry => ({ ...entry, _meta: { farming: { agentDiscovery: true } } }));
      assertOrdinaryQuery(legacyEntries, status);
      const legacyCheckpointEntries = checkpoint.sanitizedEntries().map(entry => ({ ...entry, _meta: { farming: { agentDiscovery: true } } }));
      assertOrdinaryQuery(legacyCheckpointEntries.map(acpTranscriptToolEntry), status);
    }
  }
}
const { communicationPeer, communicationAgentPeer } = require('../../src/components/code/related-session-navigation.ts');
const { encodeProviderSessionKey } = require('../../shared/provider-session-identity.ts');
const peers = [
  { id: 'sender', providerSessionKey: encodeProviderSessionKey('codex', 'sender-session', 'home-a') },
  { id: 'peer', providerSessionKey: encodeProviderSessionKey('codex', 'peer-session', 'home-a') },
  { id: 'other-home', providerSessionKey: encodeProviderSessionKey('codex', 'peer-session', 'home-b') },
  { id: 'other-provider', providerSessionKey: encodeProviderSessionKey('claude', 'peer-session', 'home-a') },
];
assert.strictEqual(communicationPeer(peers, 'sender', 'peer-session').id, 'peer');
assert.strictEqual(communicationPeer(peers, 'sender', 'sender-session'), null);
assert.strictEqual(communicationPeer(peers, 'missing', 'peer-session'), null);
assert.strictEqual(communicationPeer([...peers, { ...peers[1], id: 'duplicate' }], 'sender', 'peer-session'), null);
assert.strictEqual(communicationPeer(peers.filter(peer => peer.id !== 'peer'), 'sender', 'peer-session'), null);
console.log('ACP collaboration projection tests passed');

assert.strictEqual(communicationAgentPeer(peers, 'other-provider', peers[3].providerSessionKey)?.id, 'other-provider');
assert.strictEqual(communicationAgentPeer(peers, 'other-provider', peers[1].providerSessionKey), null);
assert.strictEqual(communicationAgentPeer(peers, 'missing', peers[1].providerSessionKey), null);
assert.strictEqual(communicationAgentPeer(peers, 'peer', 'invalid'), null);
assert.strictEqual(communicationAgentPeer([...peers, peers[1]], 'peer', peers[1].providerSessionKey), null);

const summaryEvents = acpCollaborationEvents(nativeItems);
const summary = acpOutgoingSummary([
  ...summaryEvents,
  { ...summaryEvents[0], id: 'second', message: 'First line\nHidden body' },
  { ...summaryEvents[0], id: 'failure', action: 'failed' },
  { ...summaryEvents[0], id: 'unknown', action: 'recorded' },
  { ...summaryEvents[0], id: 'pending', action: 'sending' },
  { ...summaryEvents[0], id: 'cancelled', action: 'cancelled' },
  { ...summaryEvents[0], id: 'result', outgoingMessage: false },
]);
assert.strictEqual(summary.count, 6);
assert.strictEqual(summary.previews.length, 2);
assert.strictEqual(summary.previews[1].preview, 'First line');
assert.strictEqual(summary.remaining, 4);
assert.deepStrictEqual(summary.states, [
  { action: 'failed', count: 1 }, { action: 'cancelled', count: 1 },
  { action: 'recorded', count: 1 }, { action: 'sending', count: 1 },
]);
assert.strictEqual(acpOutgoingSummary([]).count, 0);
assert.strictEqual(acpOutgoingSummary([{ ...summaryEvents[0], message: 'x'.repeat(1000) }]).previews[0].preview.length, 141);

for (const [source, expected] of [
  ['保持 **共享传输配置** 不变。', '保持 共享传输配置 不变。'],
  ['I own `storage_path` and **review**.', 'I own storage_path and review.'],
  ['[Review](https://example.com) &amp; **verify**', 'Review & verify'],
  ['# Heading\n\nBody', 'Heading'],
  ['> - ~~old~~ **new**', 'old new'],
  ['```sh\necho "**literal**"\n```', 'echo "**literal**"'],
  ['![diagram](https://example.com/image.png)', 'diagram'],
  ['[review][ref]\n\n[ref]: https://example.com', 'review'],
  ['\\*literal\\* file_name', '*literal* file_name'],
  ['---\n\nReadable body', 'Readable body'],
  ['', ''],
]) assert.strictEqual(outgoingMessagePreview(source), expected);
