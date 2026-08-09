import type {
  AgentStateBroadcastSchedulerMutation,
} from '../websocket-agent-state-broadcast-scheduler.cjs';

const assert = require('assert');
const {
  createWebSocketAgentStateBroadcastScheduler,
} = require('../websocket-agent-state-broadcast-scheduler.cjs') as typeof import('../websocket-agent-state-broadcast-scheduler.cjs');

interface Agent {
  id: string;
  readAt: number;
}

interface Timer {
  callback: () => void;
  cancelled: boolean;
  delayMs: number;
}

interface Delivery {
  context: { label: string } | null;
  mutation: AgentStateBroadcastSchedulerMutation<Agent>;
}

const INTERVAL_MS = 120;

function harness(options: {
  deliver?: (
    mutation: AgentStateBroadcastSchedulerMutation<Agent>,
    context: { label: string } | null,
  ) => void;
  missingAgentIds?: string[];
} = {}) {
  const deliveries: Delivery[] = [];
  const timers: Timer[] = [];
  const missing = new Set(options.missingAgentIds || []);
  let now = 1_000;
  let metadataReads = 0;
  const scheduler = createWebSocketAgentStateBroadcastScheduler<Agent, { label: string }, Timer>({
    clearTimer: timer => { timer.cancelled = true; },
    deliver: (mutation, context) => {
      deliveries.push({ context, mutation });
      options.deliver?.(mutation, context);
    },
    intervalMs: INTERVAL_MS,
    now: () => now,
    projectAgent: (agentId, readAt) => (missing.has(agentId) ? null : { id: agentId, readAt }),
    setTimer: (callback, delayMs) => {
      const timer: Timer = { callback, cancelled: false, delayMs };
      timers.push(timer);
      return timer;
    },
    stateMetadata: () => {
      metadataReads += 1;
      return { mainAgentId: 'main-agent', taskHistory: [{ id: 'task-1' }] };
    },
  });
  return {
    advance: (deltaMs: number) => { now += deltaMs; },
    deliveries,
    fire: (index: number) => { timers[index].callback(); },
    metadataReads: () => metadataReads,
    scheduler,
    timers,
  };
}

function run(): void {
  {
    const test = harness({ missingAgentIds: ['agent-gone'] });
    test.scheduler.queueChange({ agentIds: ['agent-a'] });
    assert.strictEqual(test.deliveries.length, 1, 'the first queue outside the window delivers immediately');
    assert.strictEqual(test.timers.length, 0);

    test.scheduler.queueChange({ agentIds: ['agent-a'], mainAgentIdChanged: true });
    test.scheduler.queueChange({ removedAgentIds: ['agent-gone'] });
    test.scheduler.queueMetadata({ projectWorkspaces: ['/one'] });
    test.scheduler.queueMetadata({ projectWorkspaces: ['/two'], pinned: [] });
    test.scheduler.queueChange({ agentIds: ['agent-b'], taskHistoryChanged: true });
    assert.strictEqual(test.timers.length, 1, 'coalesced intent shares one trailing timer');
    assert.strictEqual(test.timers[0].delayMs, INTERVAL_MS, 'the trailing delay closes the throttle window');
    assert.strictEqual(test.deliveries.length, 1, 'nothing is delivered inside the window');

    test.advance(40);
    test.fire(0);
    assert.strictEqual(test.deliveries.length, 2);
    const mutation = test.deliveries[1].mutation;
    assert.deepStrictEqual(
      mutation.upserts,
      [{ id: 'agent-a', readAt: 1_040 }, { id: 'agent-b', readAt: 1_040 }],
      'pending ids resolve once against the authoritative projection at flush time',
    );
    assert.deepStrictEqual(mutation.removedAgentIds, ['agent-gone']);
    assert.deepStrictEqual(mutation.state, {
      projectWorkspaces: ['/two'],
      pinned: [],
      mainAgentId: 'main-agent',
      taskHistory: [{ id: 'task-1' }],
    }, 'the latest metadata patch wins and authoritative metadata fills declared intent');
    assert.strictEqual(test.deliveries[1].context, null, 'the timer flush carries no host context');

    test.advance(INTERVAL_MS);
    test.scheduler.queueChange({ agentIds: ['agent-a'] });
    assert.strictEqual(test.deliveries.length, 3, 'a queue after the window delivers immediately again');
    assert.deepStrictEqual(test.deliveries[2].mutation.state, undefined, 'drained metadata does not repeat');
  }

  {
    const test = harness();
    test.scheduler.queueChange({ agentIds: ['agent-a'] });
    test.advance(30);
    test.scheduler.queueChange({ agentIds: ['agent-b'] });
    test.advance(30);
    test.scheduler.queueChange({ agentIds: ['agent-c'] });
    assert.strictEqual(test.timers.length, 1, 'an armed timer is kept rather than replaced');
    assert.strictEqual(test.timers[0].delayMs, INTERVAL_MS - 30);

    test.scheduler.flush({ label: 'recovery' });
    assert.strictEqual(test.timers[0].cancelled, true, 'a host flush cancels the armed timer');
    assert.strictEqual(test.deliveries.length, 2);
    assert.deepStrictEqual(test.deliveries[1].context, { label: 'recovery' });
    assert.deepStrictEqual(
      test.deliveries[1].mutation.upserts.map(agent => agent.id),
      ['agent-b', 'agent-c'],
      'the host flush drains everything the cancelled timer would have carried',
    );

    test.scheduler.queueChange({ agentIds: ['agent-d'] });
    assert.strictEqual(test.timers.length, 2, 'the host flush restarts the coalescing window');
    assert.strictEqual(test.deliveries.length, 2);
  }

  {
    const order: string[] = [];
    let reentered = false;
    let queueFollowUp: (() => void) | null = null;
    const test = harness({
      deliver: (mutation) => {
        order.push(mutation.upserts.map(agent => agent.id).join(','));
        if (reentered) return;
        reentered = true;
        queueFollowUp?.();
      },
    });
    queueFollowUp = () => test.scheduler.queueChange({ agentIds: ['agent-follow-up'] });

    test.scheduler.queueChange({ agentIds: ['agent-first'] });
    assert.deepStrictEqual(order, ['agent-first'], 'the reentrant queue must not extend the in-flight payload');
    assert.strictEqual(test.timers.length, 1, 'the follow-up starts a fresh pending generation');
    assert.strictEqual(test.timers[0].cancelled, false, 'the in-flight delivery must not cancel its own follow-up');

    test.advance(INTERVAL_MS);
    test.fire(0);
    assert.deepStrictEqual(order, ['agent-first', 'agent-follow-up'], 'follow-up intent is delivered serially, after the first payload');
  }

  {
    const test = harness({
      deliver: () => { throw new Error('state delivery failure'); },
    });
    assert.throws(
      () => test.scheduler.queueChange({ agentIds: ['agent-a'] }),
      /state delivery failure/,
      'synchronous delivery failures escape the queue call instead of being swallowed',
    );

    test.scheduler.queueChange({ agentIds: ['agent-b'] });
    assert.strictEqual(test.timers.length, 1, 'a failed delivery still closes its throttle window');
    test.advance(30);
    assert.throws(
      () => test.fire(0),
      /state delivery failure/,
      'synchronous delivery failures escape the timer callback',
    );
    assert.strictEqual(test.deliveries.length, 2);

    test.scheduler.queueChange({ agentIds: ['agent-c'] });
    assert.strictEqual(test.timers.length, 2, 'a failed delivery still leaves a bounded path forward');
    test.advance(INTERVAL_MS);
    assert.throws(() => test.fire(1), /state delivery failure/);
    assert.deepStrictEqual(
      test.deliveries[2].mutation.upserts.map(agent => agent.id),
      ['agent-c'],
      'the failed payload is drained and never replayed',
    );
    assert.strictEqual(test.metadataReads(), 3, 'each flush performs exactly one authoritative metadata read');
  }

  console.log('websocket agent state broadcast scheduler tests passed');
}

run();
