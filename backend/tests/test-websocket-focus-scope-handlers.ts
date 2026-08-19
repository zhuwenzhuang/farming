const assert = require('assert');
const { createWebSocketFocusScopeHandlers } = require('../websocket-focus-scope-handlers.cjs');

function setup(client = {}) {
  const calls: string[] = [];
  let declareResult = false;
  const handlers = createWebSocketFocusScopeHandlers({
    declarePreviewScope(target: Record<string, unknown>) { calls.push('declare-preview'); target.previewScopeDeclared = true; return declareResult; },
    prioritizeTranscript(agentId: string) { calls.push(`prioritize:${agentId}`); },
    sendAcpRevision(_client: object, agentId: string) { calls.push(`acp:${agentId}`); },
    sendFocusedActivity(_client: object, agentId: string) { calls.push(`activity:${agentId}`); },
    sendState() { calls.push('state'); },
    sendAllActivitySnapshot() { calls.push('all-activity'); },
    sendPreviewHydration() { calls.push('preview'); },
  });
  return { calls, client: client as Record<string, unknown>, handlers, setDeclareResult: (value: boolean) => { declareResult = value; } };
}

{
  const test = setup({
    focusedAgentId: 'a',
    stateScope: 'focused',
    activityScope: 'focused',
    previewScope: 'focused',
    acpRevisionCheckpointPending: new Set(['a', 'b']),
    acpRevisionSentCursor: new Map([['a', { revision: 3 }], ['b', { revision: 4 }]]),
  });
  test.handlers.focusAgent(test.client, { agentId: 'b', stateScope: 'focused', activityScope: 'focused' });
  assert.deepStrictEqual(test.calls, ['prioritize:b', 'acp:b', 'activity:b', 'state']);
  assert.strictEqual(test.client.focusedAgentId, 'b');
  assert.strictEqual((test.client.acpRevisionSentCursor as Map<string, unknown>).size, 0);
  assert.strictEqual((test.client.acpRevisionCheckpointPending as Set<string>).size, 0);
}

{
  const test = setup({
    focusedAgentId: 'a',
    acpRevisionInterest: new Set(['a']),
    acpRevisionSentCursor: new Map([['a', { revision: 3 }]]),
  });
  test.handlers.focusAgent(test.client, { agentId: 'b' });
  assert.strictEqual((test.client.acpRevisionSentCursor as Map<string, unknown>).has('a'), true);
}

{
  const test = setup({ focusedAgentId: 'a', stateScope: 'focused' });
  test.handlers.focusAgent(test.client, { agentId: null, stateScope: 'all' });
  assert.deepStrictEqual(test.calls, ['state']);
  assert.strictEqual(test.client.stateScope, 'all');
}

{
  const test = setup({ activityScope: 'focused', agentActivityCheckpointPending: true });
  test.handlers.focusAgent(test.client, { agentId: 'a', activityScope: 'all' });
  assert.strictEqual(test.client.agentActivityCheckpointPending, false);
  assert.strictEqual(test.client.agentActivityResyncPending, true);
  assert.deepStrictEqual(test.calls, ['prioritize:a', 'acp:a', 'all-activity']);
}

{
  const test = setup({ focusedAgentId: 'a', previewScope: 'none' });
  test.setDeclareResult(true);
  test.handlers.focusAgent(test.client, { agentId: 'a', previewScope: 'focused' });
  assert.deepStrictEqual(test.calls, ['declare-preview', 'prioritize:a', 'acp:a', 'preview']);
  const duringSnapshot = setup({ focusedAgentId: 'a', previewScope: 'none', stateSnapshotInProgress: true });
  duringSnapshot.setDeclareResult(true);
  duringSnapshot.handlers.focusAgent(duringSnapshot.client, { agentId: 'a', previewScope: 'focused' });
  assert.deepStrictEqual(duringSnapshot.calls, ['declare-preview', 'prioritize:a', 'acp:a']);
}

{
  const test = setup({ focusedAgentId: 'a', streamScope: 'all' });
  test.handlers.focusAgent(test.client, { agentId: 'a', streamScope: 'focused' });
  assert.strictEqual(test.client.streamScope, 'focused');
  assert.deepStrictEqual(test.calls, ['prioritize:a', 'acp:a']);
}

{
  const test = setup({ focusedAgentId: 'a', stateScope: 'focused' });
  test.handlers.focusAgent(test.client, { agentId: 'a', stateScope: 'focused', refreshState: true });
  assert.deepStrictEqual(test.calls, ['prioritize:a', 'acp:a', 'state']);
  test.calls.length = 0;
  test.handlers.stateResync(test.client);
  assert.deepStrictEqual(test.calls, ['state']);
}

{
  const expected = new Error('send failed');
  const handlers = createWebSocketFocusScopeHandlers({
    declarePreviewScope() { return false; }, prioritizeTranscript() {}, sendAcpRevision() {}, sendFocusedActivity() {},
    sendState() { throw expected; }, sendAllActivitySnapshot() {}, sendPreviewHydration() {},
  });
  assert.throws(() => handlers.stateResync({}), expected);

  const focusError = new Error('prioritize failed');
  const focusHandlers = createWebSocketFocusScopeHandlers({
    declarePreviewScope() { return false; }, prioritizeTranscript() { throw focusError; }, sendAcpRevision() {}, sendFocusedActivity() {},
    sendState() {}, sendAllActivitySnapshot() {}, sendPreviewHydration() {},
  });
  assert.throws(() => focusHandlers.focusAgent({}, { agentId: 'agent-a' }), focusError);
}

console.log('WebSocket focus scope handler tests passed');
