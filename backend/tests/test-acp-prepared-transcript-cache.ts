const assert = require('assert');
const { AcpPreparedTranscriptCache } = require('../acp-prepared-transcript-cache.cjs');

function manualScheduler() {
  let nextId = 0;
  const timers = new Map<number, () => void>();
  const deferred: Array<() => void> = [];
  return {
    schedule(callback: () => void) {
      const id = ++nextId;
      timers.set(id, callback);
      return id;
    },
    cancel(id: number) {
      timers.delete(id);
    },
    defer(callback: () => void) {
      deferred.push(callback);
    },
    flushTimers() {
      const callbacks = [...timers.values()];
      timers.clear();
      callbacks.forEach(callback => callback());
    },
    flushDeferred() {
      const callbacks = deferred.splice(0);
      callbacks.forEach(callback => callback());
    },
  };
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

async function run() {
  {
    const scheduler = manualScheduler();
    const prepared: number[] = [];
    const current = { sessionId: 'session-burst', revision: 3 };
    const cache = new AcpPreparedTranscriptCache({
      quietMs: 10,
      schedule: scheduler.schedule,
      cancel: scheduler.cancel,
      defer: scheduler.defer,
      prepare: ({ revision }: { revision: number }) => {
        prepared.push(revision);
        return { revision, entries: [{ id: `revision-${revision}` }] };
      },
      validate: ({ sessionId, revision }: { sessionId: string; revision: number }) => (
        sessionId === current.sessionId && revision === current.revision
      ),
    });
    for (const revision of [1, 2, 3]) {
      cache.observe({ agentId: 'burst', sessionId: current.sessionId, revision, eligible: true });
    }
    scheduler.flushTimers();
    scheduler.flushDeferred();
    await flushMicrotasks();
    assert.deepStrictEqual(prepared, [3], 'burst updates should prepare only the quiet latest revision');
    assert.strictEqual(cache.get({ agentId: 'burst', ...current })?.revision, 3);
    cache.dispose();
  }

  {
    const scheduler = manualScheduler();
    const resolvers = new Map<number, (value: Record<string, unknown>) => void>();
    const current = { sessionId: 'session-cas', revision: 1 };
    const cache = new AcpPreparedTranscriptCache({
      quietMs: 0,
      maxConcurrent: 2,
      schedule: scheduler.schedule,
      cancel: scheduler.cancel,
      defer: scheduler.defer,
      prepare: ({ revision }: { revision: number }) => new Promise(resolve => resolvers.set(revision, resolve)),
      validate: ({ sessionId, revision }: { sessionId: string; revision: number }) => (
        sessionId === current.sessionId && revision === current.revision
      ),
    });
    cache.observe({ agentId: 'cas', ...current, eligible: true });
    scheduler.flushTimers();
    scheduler.flushDeferred();
    current.revision = 2;
    cache.observe({ agentId: 'cas', ...current, eligible: true });
    scheduler.flushTimers();
    assert.strictEqual(cache.stats().active, 1, 'one Agent must keep a single prepare in flight');
    resolvers.get(1)?.({ revision: 1, entries: [] });
    await flushMicrotasks();
    assert.strictEqual(cache.get({ agentId: 'cas', sessionId: current.sessionId, revision: 1 }), null);
    scheduler.flushDeferred();
    resolvers.get(2)?.({ revision: 2, entries: [] });
    await flushMicrotasks();
    assert.strictEqual(cache.get({ agentId: 'cas', ...current })?.revision, 2);
    cache.dispose();
  }

  {
    const scheduler = manualScheduler();
    const pending: Array<() => void> = [];
    const revisions = new Map<string, number>();
    const cache = new AcpPreparedTranscriptCache({
      quietMs: 0,
      maxConcurrent: 2,
      maxQueued: 32,
      maxBytes: 1_000,
      maxEntryBytes: 600,
      schedule: scheduler.schedule,
      cancel: scheduler.cancel,
      defer: scheduler.defer,
      prepare: ({ agentId, revision }: { agentId: string; revision: number }) => new Promise(resolve => {
        pending.push(() => resolve({ revision, payload: agentId.repeat(80) }));
      }),
      validate: ({ agentId, revision }: { agentId: string; revision: number }) => (
        revisions.get(agentId) === revision
      ),
    });
    for (let index = 0; index < 128; index += 1) {
      const agentId = `agent-${index}`;
      revisions.set(agentId, 1);
      cache.observe({ agentId, sessionId: `session-${index}`, revision: 1, eligible: true });
    }
    scheduler.flushTimers();
    assert.strictEqual(cache.stats().active, 2);
    assert(cache.stats().queued <= 32, 'completion fan-out queue must stay bounded');
    for (let iteration = 0; iteration < 40; iteration += 1) {
      scheduler.flushDeferred();
      pending.splice(0).forEach(resolve => resolve());
      await flushMicrotasks();
      if (cache.stats().active === 0 && cache.stats().queued === 0) break;
    }
    assert(cache.stats().bytes <= 1_000, 'prepared transcript cache must obey its total byte budget');
    assert(cache.stats().entries < 128, 'prepared transcript cache must not grow with Agent inventory');
    cache.dispose();
  }

  {
    const scheduler = manualScheduler();
    const identity = { agentId: 'on-demand', sessionId: 'session-on-demand', revision: 7 };
    const cache = new AcpPreparedTranscriptCache({
      schedule: scheduler.schedule,
      cancel: scheduler.cancel,
      defer: scheduler.defer,
      prepare: () => ({ entries: [] }),
      validate: candidate => candidate.sessionId === identity.sessionId && candidate.revision === identity.revision,
    });
    assert.strictEqual(cache.get(identity), null, 'restart/eviction starts with no derived cache');
    assert.strictEqual(cache.publishOnDemand(identity, { revision: 7, entries: [] }), true);
    assert.strictEqual(cache.get(identity)?.revision, 7);
    cache.dispose();
    assert.strictEqual(cache.get(identity), null, 'dispose must evict every derived snapshot');
  }

  console.log('test-acp-prepared-transcript-cache passed');
}

run().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
