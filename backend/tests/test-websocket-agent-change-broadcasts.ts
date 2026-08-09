const assert = require('assert');
const { createWebSocketAgentChangeBroadcasts } = require('../websocket-agent-change-broadcasts.cjs');

interface TestClient {
  focusedAgentId?: string;
  readyState: number;
  scope: string;
  send(message: string): void;
  sent: unknown[];
  snapshot?: boolean;
}

function setup(clients: TestClient[] = []) {
  const timers: Array<() => void> = [];
  const deferred: Array<{ message: string; isRelevant: () => boolean; client: TestClient }> = [];
  const broadcasts = createWebSocketAgentChangeBroadcasts({
    clients: () => clients,
    openState: 1,
    updateDelayMs: 33,
    scopeIncludesAgent(client: TestClient, agentId: string) {
      return client.scope !== 'focused' || client.focusedAgentId === agentId;
    },
    deferUntilSnapshot(client: TestClient, message: string, isRelevant: () => boolean) {
      if (!client.snapshot) return false;
      deferred.push({ client, message, isRelevant });
      return true;
    },
    setTimer(callback: () => void) {
      timers.push(callback);
      return { unref() {} };
    },
  });
  return { broadcasts, clients, deferred, timers };
}

function client(fields: Partial<TestClient> = {}): TestClient {
  const sent: unknown[] = [];
  return { readyState: 1, scope: 'all', send(message: string) { sent.push(JSON.parse(message)); }, sent, ...fields };
}

{
  const first = client();
  const test = setup([first]);
  test.broadcasts.scheduleAgentUpdate({ agentId: 'a', patch: { adaptiveTitle: 'first' } });
  test.broadcasts.scheduleAgentUpdate({ agentId: 'a', patch: { sessionTitle: 'second' } });
  assert.strictEqual(test.timers.length, 1);
  test.timers.shift()!();
  assert.deepStrictEqual(first.sent, [{ type: 'agent-update', update: { agentId: 'a', patch: { adaptiveTitle: 'first', sessionTitle: 'second' } } }]);
}

{
  const first = client();
  const test = setup([first]);
  test.broadcasts.scheduleAgentUpdate({ agentId: 'a', patch: { adaptiveTitle: 'a' } });
  test.broadcasts.scheduleAgentUpdate({ agentId: 'b', patch: { adaptiveTitle: 'b' } });
  assert.strictEqual(test.timers.length, 2);
  test.timers.shift()!();
  test.timers.shift()!();
  assert.deepStrictEqual(
    first.sent.map((message: unknown) => (message as { update: { agentId: string } }).update.agentId),
    ['a', 'b'],
  );
}

{
  const first = client();
  const test = setup([first]);
  test.broadcasts.broadcastAgentRead({ agentId: 'a', readOutputSeq: 4 });
  assert.strictEqual(test.timers.length, 0);
  assert.deepStrictEqual(first.sent, [{ type: 'agent-read', read: { agentId: 'a', readOutputSeq: 4 } }]);
}

{
  const first = client({ scope: 'focused', focusedAgentId: 'a' });
  const test = setup([first]);
  test.broadcasts.broadcastAgentRead({ agentId: 'b' });
  first.focusedAgentId = 'b';
  test.broadcasts.broadcastAgentRead({ agentId: 'b' });
  assert.strictEqual(first.sent.length, 1);
}

{
  const first = client({ snapshot: true, scope: 'focused', focusedAgentId: 'a' });
  const test = setup([first]);
  test.broadcasts.scheduleAgentUpdate({ agentId: 'a', patch: { adaptiveTitle: 'a' } });
  test.timers.shift()!();
  assert.strictEqual(first.sent.length, 0);
  assert.strictEqual(test.deferred.length, 1);
  first.focusedAgentId = 'b';
  assert.strictEqual(test.deferred[0].isRelevant(), false);
  if (test.deferred[0].isRelevant()) first.send(test.deferred[0].message);
  assert.strictEqual(first.sent.length, 0);
}

{
  const closed = client({ readyState: 3 });
  const test = setup([closed]);
  test.broadcasts.broadcastAgentRead({ agentId: 'a' });
  test.broadcasts.scheduleAgentUpdate({ agentId: 'a', patch: { adaptiveTitle: 'a' } });
  test.timers.shift()!();
  assert.strictEqual(closed.sent.length, 0);
  test.broadcasts.scheduleAgentUpdate({ agentId: '', patch: { adaptiveTitle: 'ignored' } });
  test.broadcasts.scheduleAgentUpdate({ agentId: 'a', patch: { unknown: true } });
  assert.strictEqual(test.timers.length, 0);
}

{
  const expected = new Error('send failed');
  const test = setup([client({ send() { throw expected; } })]);
  assert.throws(() => test.broadcasts.broadcastAgentRead({ agentId: 'a' }), expected);
}

console.log('WebSocket Agent change broadcast tests passed');
