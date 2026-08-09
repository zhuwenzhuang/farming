import type { SessionPreview } from '../websocket-session-preview-broadcasts.cjs';

const assert = require('assert');
const {
  createWebSocketSessionPreviewBroadcasts,
} = require('../websocket-session-preview-broadcasts.cjs') as typeof import('../websocket-session-preview-broadcasts.cjs');

interface Timer {
  callback: () => void;
  delayMs: number;
  cleared: boolean;
  handle: object;
}

function preview(agentId: string, value: string): SessionPreview {
  return { agentId, value };
}

function harness() {
  let now = 1_000;
  const delivered: SessionPreview[] = [];
  const timers: Timer[] = [];
  const broadcasts = createWebSocketSessionPreviewBroadcasts({
    intervalMs: 500,
    now: () => now,
    deliver: value => delivered.push(value),
    setTimer: (callback, delayMs) => {
      const timer: Timer = {
        callback,
        delayMs,
        cleared: false,
        handle: {},
      };
      timers.push(timer);
      return timer.handle;
    },
    clearTimer: handle => {
      const timer = timers.find(candidate => candidate.handle === handle);
      if (!timer) throw new Error('the controller must only clear its own timers');
      timer.cleared = true;
    },
  });
  return {
    broadcasts,
    delivered,
    timers,
    setNow(value: number) { now = value; },
    fire(index = 0) { timers[index].callback(); },
  };
}

function values(delivered: SessionPreview[]): string[] {
  return delivered.map(value => String(value.value));
}

function run(): void {
  {
    const test = harness();
    test.broadcasts.schedule({ value: 'unscoped' });
    test.broadcasts.schedule({ agentId: '', value: 'empty-agent' });
    assert.deepStrictEqual(values(test.delivered), ['unscoped', 'empty-agent']);
    assert.strictEqual(test.timers.length, 0);
  }

  {
    const test = harness();
    test.broadcasts.schedule(preview('agent-a', 'one'));
    test.setNow(1_100);
    test.broadcasts.schedule(preview('agent-a', 'two'));
    test.broadcasts.schedule(preview('agent-a', 'three'));

    assert.deepStrictEqual(values(test.delivered), ['one']);
    assert.strictEqual(test.timers.length, 1);
    assert.strictEqual(test.timers[0].delayMs, 400);
    test.fire();
    assert.deepStrictEqual(values(test.delivered), ['one', 'three']);
  }

  {
    const test = harness();
    test.broadcasts.schedule(preview('agent-a', 'one'));
    test.setNow(1_100);
    test.broadcasts.schedule(preview('agent-a', 'two'));
    test.setNow(1_500);
    test.broadcasts.schedule(preview('agent-a', 'three'));

    assert.strictEqual(test.timers[0].cleared, true, 'elapsed-window delivery must cancel the stale timer');
    assert.deepStrictEqual(values(test.delivered), ['one', 'three']);
  }

  {
    const test = harness();
    test.broadcasts.schedule(preview('agent-a', 'one'));
    test.broadcasts.schedule(preview('agent-b', 'two'));
    test.setNow(1_100);
    test.broadcasts.schedule(preview('agent-a', 'three'));
    test.broadcasts.schedule(preview('agent-b', 'four'));
    assert.deepStrictEqual(values(test.delivered), ['one', 'two']);
    assert.strictEqual(test.timers.length, 2, 'each agent has its own throttle window');
    test.fire(1);
    test.fire(0);
    assert.deepStrictEqual(values(test.delivered), ['one', 'two', 'four', 'three']);
  }

  {
    let now = 1_000;
    const timers: Array<() => void> = [];
    const delivered: string[] = [];
    let broadcasts!: ReturnType<typeof createWebSocketSessionPreviewBroadcasts>;
    broadcasts = createWebSocketSessionPreviewBroadcasts({
      intervalMs: 500,
      now: () => now,
      deliver: value => {
        delivered.push(String(value.value));
        if (value.value === 'one') broadcasts.schedule(preview('agent-a', 'two'));
      },
      setTimer: callback => {
        timers.push(callback);
        return {};
      },
      clearTimer: () => {},
    });
    broadcasts.schedule(preview('agent-a', 'one'));
    assert.strictEqual(timers.length, 1, 'leading delivery must commit state before reentrant scheduling');
    now = 1_500;
    timers[0]();
    assert.deepStrictEqual(delivered, ['one', 'two']);
  }

  {
    let now = 1_000;
    const timers: Array<() => void> = [];
    const delivered: string[] = [];
    let throwOnTrailingDelivery = false;
    const broadcasts = createWebSocketSessionPreviewBroadcasts({
      intervalMs: 500,
      now: () => now,
      deliver: value => {
        delivered.push(String(value.value));
        if (throwOnTrailingDelivery) throw new Error('delivery failure');
      },
      setTimer: callback => {
        timers.push(callback);
        return {};
      },
      clearTimer: () => {},
    });
    broadcasts.schedule(preview('agent-a', 'one'));
    now = 1_100;
    broadcasts.schedule(preview('agent-a', 'two'));
    throwOnTrailingDelivery = true;
    assert.throws(() => timers[0](), /delivery failure/);
    throwOnTrailingDelivery = false;
    now = 1_200;
    broadcasts.schedule(preview('agent-a', 'three'));
    assert.strictEqual(timers.length, 2, 'a failed timer flush must release the timer before delivery');
    timers[1]();
    assert.deepStrictEqual(delivered, ['one', 'two', 'three']);
  }

  console.log('websocket session preview broadcast tests passed');
}

run();
