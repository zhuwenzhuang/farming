import type { SessionStream } from '../websocket-session-stream-broadcasts.cjs';

const assert = require('assert');
const {
  createWebSocketSessionStreamBroadcasts,
} = require('../websocket-session-stream-broadcasts.cjs') as typeof import('../websocket-session-stream-broadcasts.cjs');

interface Timer {
  callback: () => void;
  delayMs: number;
  unrefCalls: number;
}

function harness() {
  let now = 1_000;
  const delivered: SessionStream[] = [];
  const timers: Timer[] = [];
  const broadcasts = createWebSocketSessionStreamBroadcasts({
    intervalMs: 33,
    now: () => now,
    deliver: stream => delivered.push(stream),
    setTimer: (callback, delayMs) => {
      const timer: Timer = { callback, delayMs, unrefCalls: 0 };
      timers.push(timer);
      return { unref: () => { timer.unrefCalls += 1; } };
    },
  });
  return {
    broadcasts,
    delivered,
    timers,
    setNow(value: number) { now = value; },
    flush(index = 0) { timers[index].callback(); },
  };
}

function stream(agentId: string, data: string, sessionSource = 'terminal') {
  return {
    agentId,
    data,
    sessionSource,
    runtimeEpoch: 'epoch-1',
    outputSeq: data.length,
    stateRevision: data.length,
  };
}

function run(): void {
  {
    const test = harness();
    test.broadcasts.schedule(stream('agent-a', 'one'));

    assert.deepStrictEqual(test.delivered.map(value => value.data), ['one']);
    assert.strictEqual(test.timers.length, 0, 'the first stream should bypass the trailing delay');
  }

  {
    const test = harness();
    test.broadcasts.schedule(stream('agent-a', 'one'));
    test.setNow(1_010);
    test.broadcasts.schedule(stream('agent-a', 'two'));
    test.broadcasts.schedule(stream('agent-a', 'three'));

    assert.strictEqual(test.timers.length, 1);
    assert.strictEqual(test.timers[0].delayMs, 33);
    assert.strictEqual(test.timers[0].unrefCalls, 1);
    assert.deepStrictEqual(test.delivered.map(value => value.data), ['one']);
    test.flush();
    assert.deepStrictEqual(test.delivered.map(value => value.data), ['one', 'twothree']);
  }

  {
    const test = harness();
    test.broadcasts.schedule(stream('agent-a', 'one'));
    test.setNow(1_010);
    test.broadcasts.schedule(stream('agent-b', 'two', 'acp'));
    test.broadcasts.schedule(stream('agent-a', 'three'));
    test.broadcasts.schedule(stream('agent-c', 'four'));
    test.flush();

    assert.deepStrictEqual(
      test.delivered.map(value => [value.agentId, value.sessionSource, value.data]),
      [
        ['agent-a', 'terminal', 'one'],
        ['agent-b', 'acp', 'two'],
        ['agent-a', 'terminal', 'three'],
        ['agent-c', 'terminal', 'four'],
      ],
      'the pending map must retain first-insertion order while coalescing only its own identity',
    );
  }

  {
    const test = harness();
    test.broadcasts.schedule({ agentId: '', data: 'ignored' });
    test.broadcasts.schedule({ data: 'ignored' });
    assert.strictEqual(test.delivered.length, 0);
    assert.strictEqual(test.timers.length, 0);
  }

  {
    let now = 1_000;
    const delivered: string[] = [];
    const timers: Array<() => void> = [];
    let broadcasts!: ReturnType<typeof createWebSocketSessionStreamBroadcasts>;
    broadcasts = createWebSocketSessionStreamBroadcasts({
      intervalMs: 33,
      now: () => now,
      deliver: value => {
        delivered.push(value.data);
        if (value.data === 'one') broadcasts.schedule(stream('agent-a', 'two'));
      },
      setTimer: callback => {
        timers.push(callback);
        return {};
      },
    });
    broadcasts.schedule(stream('agent-a', 'one'));
    assert.deepStrictEqual(delivered, ['one']);
    assert.strictEqual(timers.length, 1, 'reentrant delivery must start a new trailing window');
    now = 1_033;
    timers[0]();
    assert.deepStrictEqual(delivered, ['one', 'two']);
  }

  {
    let now = 1_000;
    const timers: Array<() => void> = [];
    const delivered: string[] = [];
    let throwOnSecond = false;
    const broadcasts = createWebSocketSessionStreamBroadcasts({
      intervalMs: 33,
      now: () => now,
      deliver: value => {
        delivered.push(value.data);
        if (throwOnSecond) throw new Error('delivery failure');
      },
      setTimer: callback => {
        timers.push(callback);
        return {};
      },
    });
    broadcasts.schedule(stream('agent-a', 'one'));
    now = 1_010;
    broadcasts.schedule(stream('agent-b', 'two'));
    broadcasts.schedule(stream('agent-c', 'three'));
    throwOnSecond = true;
    assert.throws(() => timers[0](), /delivery failure/);
    assert.deepStrictEqual(delivered, ['one', 'two'], 'a synchronous delivery failure must preserve forEach stop semantics');
    throwOnSecond = false;
    now = 1_020;
    broadcasts.schedule(stream('agent-d', 'four'));
    assert.strictEqual(timers.length, 2, 'the failed flush must release its timer before delivery');
    timers[1]();
    assert.deepStrictEqual(delivered, ['one', 'two', 'four']);
  }

  console.log('websocket session stream broadcast tests passed');
}

run();
