import type { WebSocketResourceBroadcastClient } from '../websocket-resource-broadcasts.cjs';

const assert = require('assert');
const { createWebSocketResourceBroadcastController } = require('../websocket-resource-broadcasts.cjs') as typeof import('../websocket-resource-broadcasts.cjs');

interface TestClient extends WebSocketResourceBroadcastClient {
  sent: string[];
}

function client(overrides: Partial<TestClient> = {}): TestClient {
  const value: TestClient = {
    bufferedAmount: 0,
    protocolVersion: 1,
    readyState: 1,
    sent: [],
    send(data) { value.sent.push(data); },
    ...overrides,
  };
  return value;
}

function resource(id: string, collectionRevision: number, revision = collectionRevision): Record<string, unknown> {
  return { id, collectionRevision, revision };
}

function deletion(id: string, collectionRevision: number): Record<string, unknown> {
  return { id, collectionRevision };
}

function run(): void {
  {
    const ws = client();
    let flush: (() => void) | null = null;
    let timerCalls = 0;
    let timerDelay: number | null = null;
    const controller = createWebSocketResourceBroadcastController({
      clients: () => [ws], intervalMs: 5, maxBufferedAmount: 100, openState: 1, protocolVersion: 1,
      sendResourceSnapshots: () => assert.fail('normal delta must not send a snapshot'),
      setTimer: (callback, delay) => {
        flush = callback;
        timerCalls += 1;
        timerDelay = delay;
        return callback;
      },
    });
    controller.scheduleUpdate('browser', resource('browser-1', 1));
    controller.scheduleUpdate('browser', resource('browser-1', 3));
    controller.scheduleUpdate('browser', resource('browser-1', 2));
    controller.scheduleUpdate('computer', resource('computer-1', 2));
    controller.scheduleDeletion('computer', deletion('computer-1', 2));
    assert.strictEqual(timerCalls, 1, 'one pending window must own exactly one timer');
    assert.strictEqual(timerDelay, 5);
    flush?.();
    assert.deepStrictEqual(ws.sent.map(message => JSON.parse(message)), [
      { type: 'browser-resource-updated', resource: resource('browser-1', 3) },
      { type: 'computer-resource-deleted', deletion: deletion('computer-1', 2) },
    ], 'the flush timer must coalesce revisions and preserve browser/computer update/delete events');
  }
  {
    const slow = client({ bufferedAmount: 101 });
    const snapshots: TestClient[] = [];
    let flush: (() => void) | null = null;
    const controller = createWebSocketResourceBroadcastController({
      clients: () => [slow], intervalMs: 5, maxBufferedAmount: 100, openState: 1, protocolVersion: 1,
      sendResourceSnapshots: client => { snapshots.push(client); client.resourceSnapshotPending = false; },
      setTimer: callback => { flush = callback; return callback; },
    });
    controller.scheduleUpdate('browser', resource('slow-browser', 1));
    flush?.();
    assert.strictEqual(slow.resourceSnapshotPending, true, 'backpressure must retain a snapshot recovery obligation');
    assert.strictEqual(slow.sent.length, 0, 'backpressured clients must not receive deltas');
    slow.bufferedAmount = 0;
    controller.recoverSnapshotIfReady(slow);
    assert.deepStrictEqual(snapshots, [slow], 'a drained client must receive one authoritative snapshot');
  }
  {
    const pending = client({ resourceSnapshotPending: true });
    const closed = client({ readyState: 3 });
    const unnegotiated = client({ protocolVersion: undefined });
    const snapshots: TestClient[] = [];
    let flush: (() => void) | null = null;
    const controller = createWebSocketResourceBroadcastController({
      clients: () => [pending, closed, unnegotiated], intervalMs: 5, maxBufferedAmount: 100, openState: 1, protocolVersion: 1,
      sendResourceSnapshots: client => { snapshots.push(client); client.resourceSnapshotPending = false; },
      setTimer: callback => { flush = callback; return callback; },
    });
    controller.scheduleDeletion('computer', deletion('computer-2', 4));
    flush?.();
    assert.deepStrictEqual(snapshots, [pending], 'only negotiated open clients may recover through snapshots');
    assert.strictEqual(closed.sent.length, 0);
    assert.strictEqual(unnegotiated.sent.length, 0);
  }
  console.log('websocket resource broadcast tests passed');
}

run();
