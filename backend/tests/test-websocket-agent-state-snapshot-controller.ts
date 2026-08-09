const assert = require('assert');
const {
  createWebSocketAgentStateSnapshotController,
} = require('../websocket-agent-state-snapshot-controller.cjs');

const OPEN = 1;

interface FakeTimer {
  callback: () => void;
  delayMs: number;
  cancelled: boolean;
  unrefs: number;
  unref(): void;
}

function setup(options: Record<string, unknown> = {}) {
  const sent: Record<string, unknown>[] = [];
  const calls: string[] = [];
  const failures: unknown[] = [];
  const timers: FakeTimer[] = [];
  const previewHydrations: (() => void)[] = [];
  let sequence = Number(options.sequence ?? 7);
  let agents = (options.agents as Record<string, unknown>[] | undefined)
    ?? [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  let summaries: unknown[] | null = 'summaries' in options
    ? (options.summaries as unknown[] | null)
    : [];
  const client: Record<string, unknown> = {
    bufferedAmount: 0,
    readyState: OPEN,
    send(message: string) { sent.push(JSON.parse(message)); },
    ...(options.client as Record<string, unknown> | undefined),
  };
  const controller = createWebSocketAgentStateSnapshotController({
    backpressureRetryMs: 25,
    broadcastCheckpoint() { calls.push('checkpoint'); },
    cancelPreviewHydration() { calls.push('cancel-preview'); },
    clearTimer(timer: FakeTimer) { timer.cancelled = true; },
    initialFollowupDelayMs: 200,
    initialPageSize: Number(options.initialPageSize ?? 2),
    maxBufferedAmount: 100,
    onDeliveryFailure(failedClient: object, error: unknown) {
      calls.push('delivery-failure');
      failures.push({ client: failedClient, error });
      if (options.failureThrows === true) throw new Error('failure port threw');
    },
    openState: OPEN,
    pageSize: Number(options.pageSize ?? 2),
    previewHydrationWindowMs: 100,
    projectSummaries: () => summaries,
    queuePreviewHydration(_client: object, delayMs: number, callback: () => void) {
      calls.push(`queue-preview:${delayMs}`);
      previewHydrations.push(callback);
    },
    recoverAcpSessionRevision() { calls.push('recover-acp'); },
    recoverAgentActivity() { calls.push('recover-activity'); },
    scopeDeclarationWindowMs: 100,
    sendPreviewHydration() { calls.push('send-preview'); },
    serverEpoch: 42,
    snapshotForScope: (stateScope: string, focusedAgentId: string | null) => {
      calls.push(`snapshot:${stateScope}:${focusedAgentId ?? ''}`);
      return summaries === null ? null : { mainAgentId: '', agents };
    },
    snapshotSequence: () => sequence,
    setTimer(callback: () => void, delayMs: number) {
      const timer: FakeTimer = {
        callback,
        delayMs,
        cancelled: false,
        unrefs: 0,
        unref() { this.unrefs += 1; },
      };
      timers.push(timer);
      return timer;
    },
  });
  const runTimers = (limit = 50) => {
    for (let index = 0; index < limit; index += 1) {
      const timer = timers.find(candidate => !candidate.cancelled && candidate.callback);
      if (!timer) return;
      timer.cancelled = true;
      timer.callback();
    }
  };
  return {
    calls,
    client,
    controller,
    createClient(overrides: Record<string, unknown> = {}) {
      return {
        bufferedAmount: 0,
        readyState: OPEN,
        send(message: string) { sent.push(JSON.parse(message)); },
        ...overrides,
      } as Record<string, unknown>;
    },
    failures,
    previewHydrations,
    runTimers,
    sent,
    setAgents(next: Record<string, unknown>[]) { agents = next; },
    setSequence(next: number) { sequence = next; },
    setSummaries(next: unknown[] | null) { summaries = next; },
    timers,
  };
}

// Scope declaration window: the initial snapshot waits, is idempotent, and is
// skipped when the client already received an authoritative snapshot.
{
  const test = setup();
  test.controller.queueInitialSnapshot(test.client);
  test.controller.queueInitialSnapshot(test.client);
  assert.strictEqual(test.timers.length, 1);
  assert.strictEqual(test.timers[0].delayMs, 100);
  assert.strictEqual(test.timers[0].unrefs, 1);
  assert.deepStrictEqual(test.sent, []);
  test.timers[0].cancelled = true;
  test.timers[0].callback();
  assert.strictEqual(test.client.initialStateSnapshotTimer, null);
  assert.strictEqual(test.client.initialStateSnapshotSent, true);
  assert.deepStrictEqual(test.calls.slice(0, 3), ['cancel-preview', 'checkpoint', 'snapshot:all:']);
  assert.strictEqual(test.sent.length, 1);

  const already = setup({ client: { initialStateSnapshotSent: true } });
  already.controller.queueInitialSnapshot(already.client);
  assert.strictEqual(already.timers.length, 0);
}

// Paged delivery: exact wire frames, ordering, delays, and the completion
// barrier that releases Activity, ACP, and Preview recovery.
{
  const test = setup({ agents: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] });
  test.controller.sendState(test.client);
  assert.strictEqual(test.client.stateSnapshotInProgress, true);
  assert.deepStrictEqual(test.sent, [{
    type: 'state',
    generation: 42,
    sequence: 7,
    snapshot: { complete: false, id: '42:7:1', offset: 0, total: 3 },
    state: { mainAgentId: '', projectAgentSummaries: [], agents: [{ id: 'a' }, { id: 'b' }] },
  }]);
  assert.strictEqual(test.timers[0].delayMs, 200);
  assert.deepStrictEqual(test.calls, ['cancel-preview', 'checkpoint', 'snapshot:all:']);
  test.runTimers();
  assert.strictEqual(test.sent.length, 2);
  assert.deepStrictEqual(test.sent[1].snapshot, { complete: true, id: '42:7:1', offset: 2, total: 3 });
  assert.strictEqual(test.client.stateSnapshotInProgress, false);
  assert.strictEqual(test.client.stateSnapshotRetryTimer, null);
  assert.deepStrictEqual(test.calls.slice(3), [
    'recover-activity',
    'recover-acp',
    'queue-preview:100',
  ]);
}

// Reentrant latest cut: a snapshot requested mid-delivery marks pending, then
// discards the deferred queue and restarts from the newest authoritative state.
{
  const test = setup();
  test.controller.sendState(test.client);
  const discarded: string[] = [];
  (test.client.stateSnapshotMessages as { message: string; onDiscard(): void }[]).push({
    message: 'delta',
    onDiscard() { discarded.push('delta'); },
  });
  test.client.stateSnapshotMessageBytes = 5;
  test.controller.sendState(test.client);
  assert.strictEqual(test.client.stateSnapshotPending, true);
  assert.strictEqual(test.sent.length, 1);
  test.setAgents([{ id: 'z' }]);
  test.setSequence(9);
  test.runTimers();
  assert.deepStrictEqual(discarded, ['delta']);
  assert.strictEqual(test.client.stateSnapshotPending, false);
  assert.deepStrictEqual(test.sent[1].snapshot, { complete: true, id: '42:9:2', offset: 0, total: 1 });
  assert.deepStrictEqual(test.client.stateSnapshotMessages, []);
  assert.strictEqual(test.client.stateSnapshotMessageBytes, 0);
}

// Stale serial: every cut takes a fresh monotonic serial, so a restarted
// snapshot can never reuse a superseded snapshot identity.
{
  const test = setup({ agents: [{ id: 'a' }] });
  test.controller.sendState(test.client);
  test.controller.sendState(test.client);
  test.controller.sendState(test.client);
  assert.deepStrictEqual(test.sent.map(frame => (frame.snapshot as { id: string }).id), [
    '42:7:1',
    '42:7:2',
    '42:7:3',
  ]);
}

// Backpressure: follow-up pages and deferred deltas wait for the client to
// drain, including a per-message buffered-amount ceiling.
{
  const test = setup();
  test.controller.sendState(test.client);
  test.client.bufferedAmount = 500;
  test.runTimers(1);
  assert.strictEqual(test.sent.length, 1);
  assert.strictEqual(test.timers[1].delayMs, 25);
  test.client.bufferedAmount = 0;
  test.runTimers();
  assert.strictEqual(test.sent.length, 2);

  const deferred = setup();
  deferred.controller.sendState(deferred.client);
  const queue = deferred.client.stateSnapshotMessages as {
    message: string;
    maxBufferedAmount?: number;
  }[];
  queue.push({ message: JSON.stringify({ type: 'state-delta' }), maxBufferedAmount: 10 });
  deferred.client.stateSnapshotMessageBytes = Buffer.byteLength(queue[0].message);
  deferred.client.bufferedAmount = 50;
  deferred.runTimers(2);
  assert.strictEqual(deferred.sent.length, 2);
  assert.strictEqual(deferred.client.stateSnapshotInProgress, true);
  deferred.client.bufferedAmount = 5;
  deferred.runTimers();
  assert.strictEqual(deferred.sent.length, 3);
  assert.strictEqual(deferred.sent[2].type, 'state-delta');
  assert.strictEqual(deferred.client.stateSnapshotMessageBytes, 0);
  assert.strictEqual(deferred.client.stateSnapshotInProgress, false);
}

// Overflow fallback: an overflowed client receives one complete frame and
// releases the barrier synchronously.
{
  const test = setup({ client: { stateSnapshotOverflowed: true } });
  test.controller.sendState(test.client);
  assert.strictEqual(test.client.stateSnapshotOverflowed, false);
  assert.strictEqual(test.sent.length, 1);
  assert.deepStrictEqual(test.sent[0].snapshot, { complete: true, id: '42:7:1', offset: 0, total: 3 });
  assert.strictEqual(test.client.stateSnapshotInProgress, false);
  assert.deepStrictEqual(test.calls.slice(3), [
    'recover-activity',
    'recover-acp',
    'queue-preview:100',
  ]);
}

// Unavailable snapshot: the client is told Farming will retry and recovery
// resends once the authoritative state exists again.
{
  const test = setup({ summaries: null });
  test.controller.sendState(test.client);
  assert.deepStrictEqual(test.sent, [{
    type: 'error',
    message: 'Agent state snapshot is temporarily unavailable; Farming will retry',
  }]);
  assert.strictEqual(test.client.stateSnapshotPending, true);
  assert.strictEqual(test.client.stateSnapshotInProgress, undefined);
  test.client.bufferedAmount = 500;
  test.controller.recoverSnapshotIfReady(test.client);
  assert.strictEqual(test.sent.length, 1);
  test.client.bufferedAmount = 0;
  test.setSummaries([]);
  test.controller.recoverSnapshotIfReady(test.client);
  assert.strictEqual(test.sent[1].type, 'state');
  test.controller.recoverSnapshotIfReady(test.client);
  assert.strictEqual(test.sent.length, 2);
}

// Activity scope fencing: a covered snapshot clears pending Activity
// checkpoints, and an uncovered resync keeps the scoped checkpoint pending.
{
  const covered = setup({
    client: {
      activityScope: 'focused',
      focusedAgentId: 'a',
      agentActivityAllCheckpointPending: true,
      agentActivityCheckpointPending: true,
      agentActivityResyncPending: true,
      stateScope: 'focused',
    },
  });
  covered.controller.sendState(covered.client);
  assert.strictEqual(covered.client.agentActivityAllCheckpointPending, false);
  assert.strictEqual(covered.client.agentActivityCheckpointPending, false);
  assert.strictEqual(covered.client.agentActivityResyncPending, false);

  const uncovered = setup({
    client: {
      activityScope: 'all',
      stateScope: 'focused',
      agentActivityResyncPending: true,
    },
  });
  uncovered.controller.sendState(uncovered.client);
  assert.strictEqual(uncovered.client.agentActivityAllCheckpointPending, true);
  assert.strictEqual(uncovered.client.agentActivityResyncPending, true);
}

// Close and dispose: a closed client abandons delivery and dispose clears every
// per-client timer, queue, and flag.
{
  const test = setup();
  test.controller.sendState(test.client);
  test.client.readyState = 3;
  test.runTimers(1);
  assert.strictEqual(test.sent.length, 1);
  assert.strictEqual(test.client.stateSnapshotInProgress, false);

  const disposed = setup();
  disposed.controller.queueInitialSnapshot(disposed.client);
  disposed.controller.sendState(disposed.client);
  disposed.client.stateSnapshotOverflowed = true;
  disposed.client.stateSnapshotMessageBytes = 12;
  disposed.controller.dispose(disposed.client);
  assert.strictEqual(disposed.client.initialStateSnapshotTimer, null);
  assert.strictEqual(disposed.client.stateSnapshotRetryTimer, null);
  assert.strictEqual(disposed.client.stateSnapshotInProgress, false);
  assert.strictEqual(disposed.client.stateSnapshotOverflowed, false);
  assert.strictEqual(disposed.client.stateSnapshotMessageBytes, 0);
  assert.deepStrictEqual(disposed.client.stateSnapshotMessages, []);
  assert.ok(disposed.timers.every(timer => timer.cancelled));
}

// Post-completion recovery: Preview hydration only runs while the client is
// open after the completed cut.
{
  const test = setup({ agents: [{ id: 'a' }] });
  test.controller.sendState(test.client);
  assert.deepStrictEqual(test.calls.slice(3), ['recover-activity', 'recover-acp', 'queue-preview:100']);
  assert.strictEqual(test.previewHydrations.length, 1);
  test.previewHydrations[0]();
  assert.strictEqual(test.calls[test.calls.length - 1], 'send-preview');

  const closed = setup({ agents: [{ id: 'a' }] });
  closed.controller.sendState(closed.client);
  closed.client.readyState = 3;
  closed.previewHydrations[0]();
  assert.ok(!closed.calls.includes('send-preview'));
}

// Send-effect boundary: a synchronous client.send throw on the first page
// atomically terminates that exact cut and reports it once, without replay.
{
  const test = setup({
    client: {
      send() { throw new Error('socket closed'); },
    },
  });
  test.controller.sendState(test.client);
  assert.strictEqual(test.failures.length, 1);
  assert.strictEqual((test.failures[0] as { client: object }).client, test.client);
  assert.strictEqual(
    ((test.failures[0] as { error: Error }).error).message,
    'socket closed',
  );
  assert.strictEqual(test.client.stateSnapshotInProgress, false);
  assert.strictEqual(test.client.stateSnapshotPending, false);
  assert.strictEqual(test.client.stateSnapshotOverflowed, false);
  assert.strictEqual(test.client.stateSnapshotRetryTimer, null);
  assert.strictEqual(test.client.stateSnapshotMessageBytes, 0);
  assert.deepStrictEqual(test.client.stateSnapshotMessages, []);
  assert.ok(!test.calls.includes('recover-activity'));
  assert.ok(!test.calls.includes('queue-preview:100'));
  // Stale timers and preview callbacks cannot resurrect the terminated cut.
  test.runTimers();
  assert.strictEqual(test.failures.length, 1);
  assert.strictEqual(test.previewHydrations.length, 0);
  assert.strictEqual(test.client.stateSnapshotInProgress, false);
  test.controller.recoverSnapshotIfReady(test.client);
  assert.strictEqual(test.failures.length, 1);
}

// The unavailable-snapshot notice shares the boundary: its throw is contained
// and leaves no pending retry claim behind.
{
  const test = setup({
    summaries: null,
    client: {
      send() { throw new Error('unavailable send failed'); },
    },
  });
  test.controller.sendState(test.client);
  assert.strictEqual(test.failures.length, 1);
  assert.strictEqual(test.client.stateSnapshotPending, false);
  test.controller.recoverSnapshotIfReady(test.client);
  assert.strictEqual(test.failures.length, 1);
}

// Timer callbacks never throw: the initial scope-declaration timer contains a
// throwing send.
{
  const test = setup({
    client: {
      send() { throw new Error('scope timer send failed'); },
    },
  });
  test.controller.queueInitialSnapshot(test.client);
  test.timers[0].cancelled = true;
  test.timers[0].callback();
  assert.strictEqual(test.failures.length, 1);
  assert.strictEqual(test.client.stateSnapshotInProgress, false);
}

// Deferred delivery: a throwing delta send discards the in-flight queued
// message exactly once and abandons the cut.
{
  const test = setup();
  test.controller.sendState(test.client);
  const discarded: string[] = [];
  const delta = JSON.stringify({ type: 'state-delta' });
  const queue = test.client.stateSnapshotMessages as {
    message: string;
    onDiscard(): void;
  }[];
  queue.push({ message: delta, onDiscard() { discarded.push('delta'); } });
  test.client.stateSnapshotMessageBytes = Buffer.byteLength(delta);
  test.client.send = (message: string) => {
    if (message === delta) throw new Error('delta send failed');
    test.sent.push(JSON.parse(message));
  };
  test.runTimers();
  assert.deepStrictEqual(discarded, ['delta']);
  assert.strictEqual(test.failures.length, 1);
  assert.strictEqual(test.sent.length, 2);
  assert.strictEqual(test.client.stateSnapshotInProgress, false);
  assert.strictEqual(test.client.stateSnapshotMessageBytes, 0);
  assert.deepStrictEqual(test.client.stateSnapshotMessages, []);
  assert.ok(!test.calls.includes('recover-activity'));
}

// Shared controller, two clients: one client's send failure and terminated cut
// leave the other client's delivery on the same serial owner untouched.
{
  const test = setup({ agents: [{ id: 'a' }] });
  const failing = test.createClient({ send() { throw new Error('socket closed'); } });
  const healthy = test.createClient();
  test.controller.sendState(failing);
  assert.strictEqual(test.failures.length, 1);
  assert.strictEqual((test.failures[0] as { client: object }).client, failing);
  assert.strictEqual(failing.stateSnapshotInProgress, false);
  assert.strictEqual(failing.stateSnapshotCutId, null);

  test.controller.sendState(healthy);
  assert.deepStrictEqual(test.failures.length, 1);
  assert.strictEqual(test.sent.length, 1);
  // The failed cut consumed serial 1; the healthy client takes the next serial.
  assert.deepStrictEqual(test.sent[0].snapshot, { complete: true, id: '42:7:2', offset: 0, total: 1 });
  assert.strictEqual(healthy.stateSnapshotInProgress, false);
  assert.deepStrictEqual(test.calls.slice(-3), [
    'recover-activity',
    'recover-acp',
    'queue-preview:100',
  ]);
}

// Throwing onDiscard: cleanup is claimed exact-once, every remaining queued
// entry still gets one attempt, and the send failure stays the primary failure.
{
  const test = setup();
  test.controller.sendState(test.client);
  const discards: string[] = [];
  const delta = JSON.stringify({ type: 'state-delta' });
  const queue = test.client.stateSnapshotMessages as {
    message: string;
    onDiscard(): void;
  }[];
  queue.push({
    message: delta,
    onDiscard() { discards.push('inflight'); throw new Error('discard threw'); },
  });
  queue.push({ message: 'tail-a', onDiscard() { discards.push('tail-a'); throw new Error('nope'); } });
  queue.push({ message: 'tail-b', onDiscard() { discards.push('tail-b'); } });
  test.client.stateSnapshotMessageBytes = Buffer.byteLength(delta);
  test.client.send = (message: string) => {
    if (message === delta) throw new Error('delta send failed');
    test.sent.push(JSON.parse(message));
  };
  test.runTimers();
  assert.deepStrictEqual(discards, ['inflight', 'tail-a', 'tail-b']);
  assert.strictEqual(test.failures.length, 1);
  assert.strictEqual((test.failures[0] as { error: Error }).error.message, 'delta send failed');
  assert.strictEqual(test.client.stateSnapshotInProgress, false);
  assert.strictEqual(test.client.stateSnapshotMessageBytes, 0);
  assert.deepStrictEqual(test.client.stateSnapshotMessages, []);
}

// A throwing onDiscard cannot block the atomic cut cleanup of a pending
// restart: the newest authoritative cut is still delivered.
{
  const test = setup();
  test.controller.sendState(test.client);
  const discards: string[] = [];
  (test.client.stateSnapshotMessages as { message: string; onDiscard(): void }[]).push(
    { message: 'a', onDiscard() { discards.push('a'); throw new Error('discard threw'); } },
    { message: 'b', onDiscard() { discards.push('b'); } },
  );
  test.client.stateSnapshotMessageBytes = 2;
  test.controller.sendState(test.client);
  test.setAgents([{ id: 'z' }]);
  test.runTimers();
  assert.deepStrictEqual(discards, ['a', 'b']);
  assert.strictEqual(test.client.stateSnapshotPending, false);
  assert.strictEqual(test.client.stateSnapshotMessageBytes, 0);
  assert.deepStrictEqual(test.client.stateSnapshotMessages, []);
  assert.deepStrictEqual(test.sent[1].snapshot, { complete: true, id: '42:7:2', offset: 0, total: 1 });
  assert.deepStrictEqual(test.failures, []);
}

// A throwing onDeliveryFailure port is contained: it never escapes the timer or
// message callback and never replaces the original send failure.
{
  const test = setup({
    agents: [{ id: 'a' }],
    failureThrows: true,
    client: { send() { throw new Error('socket closed'); } },
  });
  test.controller.queueInitialSnapshot(test.client);
  test.timers[0].cancelled = true;
  test.timers[0].callback();
  assert.strictEqual(test.failures.length, 1);
  assert.strictEqual((test.failures[0] as { error: Error }).error.message, 'socket closed');
  assert.strictEqual(test.client.stateSnapshotInProgress, false);
  assert.strictEqual(test.client.stateSnapshotPending, false);
  assert.strictEqual(test.client.stateSnapshotCutId, null);
}

// ABA: an old abandoned cut's timer callback fires after a new cut took the
// barrier. It must not clear the new cut's timer, send a stale page, or release
// recovery for the new cut.
{
  const test = setup();
  test.controller.sendState(test.client);
  const staleCallback = test.timers[0].callback;
  test.controller.dispose(test.client);
  test.setAgents([{ id: 'z1' }, { id: 'z2' }, { id: 'z3' }]);
  test.controller.sendState(test.client);
  const newCutId = test.client.stateSnapshotCutId;
  const newCutTimer = test.client.stateSnapshotRetryTimer;
  const sentBefore = test.sent.length;
  const callsBefore = test.calls.length;
  staleCallback();
  assert.strictEqual(test.sent.length, sentBefore);
  assert.strictEqual(test.client.stateSnapshotRetryTimer, newCutTimer);
  assert.strictEqual(test.client.stateSnapshotCutId, newCutId);
  assert.strictEqual(test.client.stateSnapshotInProgress, true);
  assert.deepStrictEqual(test.calls.slice(callsBefore), []);
  assert.deepStrictEqual(test.failures, []);
  test.runTimers();
  assert.strictEqual(test.sent.length, sentBefore + 1);
  assert.deepStrictEqual(test.sent[test.sent.length - 1].snapshot, {
    complete: true,
    id: '42:7:2',
    offset: 2,
    total: 3,
  });
  assert.strictEqual(test.client.stateSnapshotInProgress, false);
}

// An irrelevant dequeued delta whose onDiscard throws is claimed exactly once:
// the cut terminates on that discard error, the rest of the queue is discarded
// once, and no recovery or preview runs.
{
  const test = setup();
  test.controller.sendState(test.client);
  const discards: string[] = [];
  const queue = test.client.stateSnapshotMessages as {
    message: string;
    isRelevant(): boolean;
    onDiscard(): void;
  }[];
  queue.push({
    message: 'stale',
    isRelevant() { return false; },
    onDiscard() { discards.push('stale'); throw new Error('discard threw'); },
  });
  queue.push({
    message: 'tail',
    isRelevant() { return true; },
    onDiscard() { discards.push('tail'); },
  });
  test.client.stateSnapshotMessageBytes = Buffer.byteLength('staletail');
  test.runTimers();
  assert.deepStrictEqual(discards, ['stale', 'tail']);
  assert.strictEqual(test.failures.length, 1);
  assert.strictEqual((test.failures[0] as { error: Error }).error.message, 'discard threw');
  assert.strictEqual(test.client.stateSnapshotInProgress, false);
  assert.strictEqual(test.client.stateSnapshotPending, false);
  assert.strictEqual(test.client.stateSnapshotCutId, null);
  assert.strictEqual(test.client.stateSnapshotMessageBytes, 0);
  assert.deepStrictEqual(test.client.stateSnapshotMessages, []);
  assert.ok(!test.calls.includes('recover-activity'));
  assert.strictEqual(test.previewHydrations.length, 0);
  test.runTimers();
  assert.strictEqual(test.failures.length, 1);
  assert.deepStrictEqual(discards, ['stale', 'tail']);
}

console.log('websocket agent-state snapshot controller tests passed');
