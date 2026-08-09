import type { AgentActivity } from '../websocket-agent-activity-broadcasts.cjs';

const assert = require('assert');
const {
  createWebSocketAgentActivityBroadcasts,
} = require('../websocket-agent-activity-broadcasts.cjs') as typeof import('../websocket-agent-activity-broadcasts.cjs');

interface Timer {
  callback: () => void;
  delayMs: number;
  unrefCalls: number;
}

function activity(agentId: string, sequence: number): AgentActivity {
  return { agentId, sequence };
}

function harness() {
  const delivered: AgentActivity[] = [];
  const timers: Timer[] = [];
  const broadcasts = createWebSocketAgentActivityBroadcasts({
    delayMs: 25,
    deliver: value => delivered.push(value),
    setTimer: (callback, delayMs) => {
      const timer: Timer = { callback, delayMs, unrefCalls: 0 };
      timers.push(timer);
      return { unref: () => { timer.unrefCalls += 1; } };
    },
  });
  return { broadcasts, delivered, timers };
}

function run(): void {
  {
    const test = harness();
    test.broadcasts.schedule(undefined);
    test.broadcasts.schedule({ agentId: '' });
    test.broadcasts.schedule({ agentId: 1 });
    test.broadcasts.schedule([]);

    assert.deepStrictEqual(test.delivered, []);
    assert.deepStrictEqual(test.timers, []);
  }

  {
    const test = harness();
    test.broadcasts.schedule(activity('agent-a', 1));
    test.broadcasts.schedule(activity('agent-a', 2));

    assert.strictEqual(test.timers.length, 1, 'one agent must retain one trailing timer');
    assert.strictEqual(test.timers[0].delayMs, 25);
    assert.strictEqual(test.timers[0].unrefCalls, 1);
    test.timers[0].callback();
    assert.deepStrictEqual(test.delivered, [activity('agent-a', 2)], 'the latest activity must win');
  }

  {
    const test = harness();
    test.broadcasts.schedule(activity('agent-a', 1));
    test.broadcasts.schedule(activity('agent-b', 2));

    assert.strictEqual(test.timers.length, 2, 'agents must receive independent trailing timers');
    test.timers[1].callback();
    test.timers[0].callback();
    assert.deepStrictEqual(test.delivered, [activity('agent-b', 2), activity('agent-a', 1)]);
  }

  {
    const timers: Timer[] = [];
    const delivered: AgentActivity[] = [];
    let broadcasts!: ReturnType<typeof createWebSocketAgentActivityBroadcasts>;
    broadcasts = createWebSocketAgentActivityBroadcasts({
      delayMs: 25,
      deliver: value => {
        delivered.push(value);
        if (value.sequence === 1) broadcasts.schedule(activity('agent-a', 2));
      },
      setTimer: (callback, delayMs) => {
        const timer: Timer = { callback, delayMs, unrefCalls: 0 };
        timers.push(timer);
        return { unref: () => { timer.unrefCalls += 1; } };
      },
    });

    broadcasts.schedule(activity('agent-a', 1));
    timers[0].callback();
    assert.strictEqual(timers.length, 2, 'delete-before-deliver must allow a reentrant trailing entry');
    timers[1].callback();
    assert.deepStrictEqual(delivered, [activity('agent-a', 1), activity('agent-a', 2)]);
  }

  {
    const timers: Array<() => void> = [];
    const broadcasts = createWebSocketAgentActivityBroadcasts({
      delayMs: 25,
      deliver: () => { throw new Error('delivery failure'); },
      setTimer: callback => {
        timers.push(callback);
        return {};
      },
    });

    broadcasts.schedule(activity('agent-a', 1));
    assert.throws(() => timers[0](), /delivery failure/, 'synchronous delivery failures must escape the timer callback');
  }

  console.log('websocket agent activity broadcast tests passed');
}

run();
