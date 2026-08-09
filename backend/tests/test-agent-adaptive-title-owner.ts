const assert = require('assert');
const {
  AgentAdaptiveTitlePersistenceCoordinator,
} = require('../agent-adaptive-title-persistence.cjs');

function gate() {
  let release: () => void = () => {};
  const opened = new Promise<void>(resolve => {
    release = resolve;
  });
  let observe: () => void = () => {};
  const started = new Promise<void>(resolve => {
    observe = resolve;
  });
  return { opened, release, started, observe };
}

function agentRecord(id, overrides = {}) {
  return {
    id,
    adaptiveTitle: '',
    agentRecordId: `agent_record_${id}`,
    persistentSessionId: `agent_record_${id}`,
    runtimeEpoch: `epoch-${id}`,
    ...overrides,
  };
}

interface AdaptiveTitleResult {
  adaptiveTitle?: string;
  agentId?: string;
  cancelled?: boolean;
  error?: string;
  retryable?: boolean;
}

type AdaptiveTitleAgent = Record<string, unknown>;

interface AdaptiveTitleOwner {
  activeDrain(): Promise<void> | null;
  clearPending(): void;
  pendingResult(agentId: string): Promise<AdaptiveTitleResult> | undefined;
  schedule(
    agentId: string,
    agent: AdaptiveTitleAgent,
    adaptiveTitle: string,
    previousTitle: string,
  ): Promise<AdaptiveTitleResult>;
}

type PersistHook = (agent: AdaptiveTitleAgent, title: string) => Promise<string> | string;

function createOwner() {
  const agents = new Map<string, AdaptiveTitleAgent>();
  const writes: Array<{ id: unknown; adaptiveTitle: string; agent: AdaptiveTitleAgent }> = [];
  const patches: Array<{ agentId: string; patch: Record<string, unknown> }> = [];
  const metadataUpdates: AdaptiveTitleAgent[] = [];
  let persist: PersistHook | null = null;
  const owner: AdaptiveTitleOwner = new AgentAdaptiveTitlePersistenceCoordinator({
    getAgent: (agentId: string) => agents.get(agentId),
    async persistAdaptiveTitle(agent: AdaptiveTitleAgent, adaptiveTitle: string) {
      writes.push({ id: agent.id, adaptiveTitle, agent });
      if (persist) return persist(agent, adaptiveTitle);
      return String(agent.agentRecordId || '');
    },
    publishAgentPatch(agentId: string, patch: Record<string, unknown>) {
      patches.push({ agentId, patch });
    },
    setRecordId(agent: AdaptiveTitleAgent, agentRecordId: unknown) {
      if (!agent || typeof agentRecordId !== 'string' || !agentRecordId) return;
      agent.agentRecordId = agentRecordId;
      agent.persistentSessionId = agentRecordId;
    },
    updateProviderMetadata(agent: AdaptiveTitleAgent) {
      metadataUpdates.push(agent);
    },
  });
  return {
    agents,
    metadataUpdates,
    owner,
    patches,
    writes,
    setPersist(next: PersistHook) {
      persist = next;
    },
  };
}

async function withSilencedFailureLog<T>(run: () => Promise<T>): Promise<T> {
  const reported = [];
  const originalError = console.error;
  console.error = (...args) => reported.push(args);
  try {
    const result = await run();
    assert(reported.length > 0, 'a failed durable title write must be reported');
    return result;
  } finally {
    console.error = originalError;
  }
}

async function testCoalescedFifoDrain() {
  const { owner, agents, writes } = createOwner();
  const first = agentRecord('agent-first');
  const second = agentRecord('agent-second');
  agents.set(first.id, first);
  agents.set(second.id, second);

  first.adaptiveTitle = 'Draft first';
  const queued = owner.schedule(first.id, first, 'Draft first', '');
  first.adaptiveTitle = 'Final first';
  const coalesced = owner.schedule(first.id, first, 'Final first', 'Draft first');
  second.adaptiveTitle = 'Only second';
  const secondQueued = owner.schedule(second.id, second, 'Only second', '');

  assert.strictEqual(queued, coalesced, 'one Agent must expose one joined durability result');
  assert.strictEqual(owner.pendingResult(first.id), queued);
  assert.strictEqual(writes.length, 0, 'the queue must leave the request stack before writing');
  assert(owner.activeDrain(), 'a queued title must expose its active drain');

  const results = await Promise.all([queued, secondQueued]);
  assert.deepStrictEqual(results, [
    { agentId: first.id, adaptiveTitle: 'Final first' },
    { agentId: second.id, adaptiveTitle: 'Only second' },
  ]);
  assert.deepStrictEqual(
    writes.map(write => [write.id, write.adaptiveTitle]),
    [[first.id, 'Final first'], [second.id, 'Only second']],
    'entries drain one at a time in queue order and persist only their latest value',
  );
  assert.strictEqual(owner.pendingResult(first.id), undefined);

  console.log('✓ adaptive title entries coalesce per Agent and drain FIFO across Agents');
}

async function testReentrantQueueDuringDrain() {
  const { owner, agents, writes, setPersist } = createOwner();
  const busy = agentRecord('agent-busy');
  const queuedDuringWrite = agentRecord('agent-queued-during-write');
  agents.set(busy.id, busy);
  agents.set(queuedDuringWrite.id, queuedDuringWrite);

  const firstWrite = gate();
  setPersist(async (agent, adaptiveTitle) => {
    if (agent.id === busy.id && adaptiveTitle === 'Busy first') {
      firstWrite.observe();
      await firstWrite.opened;
    }
    return String(agent.agentRecordId || '');
  });

  busy.adaptiveTitle = 'Busy first';
  const firstBusy = owner.schedule(busy.id, busy, 'Busy first', '');
  queuedDuringWrite.adaptiveTitle = 'Queued draft';
  const queuedResult = owner.schedule(queuedDuringWrite.id, queuedDuringWrite, 'Queued draft', '');
  await firstWrite.started;

  busy.adaptiveTitle = 'Busy again';
  const secondBusy = owner.schedule(busy.id, busy, 'Busy again', 'Busy first');
  assert.notStrictEqual(secondBusy, firstBusy, 'a title admitted after its write starts needs its own result');
  queuedDuringWrite.adaptiveTitle = 'Queued latest';
  assert.strictEqual(
    owner.schedule(queuedDuringWrite.id, queuedDuringWrite, 'Queued latest', 'Queued draft'),
    queuedResult,
    'a still-queued Agent must keep joining one durability result',
  );
  firstWrite.release();

  const [first, queued, second] = await Promise.all([firstBusy, queuedResult, secondBusy]);
  assert.deepStrictEqual(first, { agentId: busy.id, adaptiveTitle: 'Busy first' });
  assert.deepStrictEqual(queued, {
    agentId: queuedDuringWrite.id,
    adaptiveTitle: 'Queued latest',
  });
  assert.deepStrictEqual(second, { agentId: busy.id, adaptiveTitle: 'Busy again' });
  assert.deepStrictEqual(
    writes.map(write => [write.id, write.adaptiveTitle]),
    [
      [busy.id, 'Busy first'],
      [queuedDuringWrite.id, 'Queued latest'],
      [busy.id, 'Busy again'],
    ],
    'reentrant admissions append behind the queue instead of starting a second drain',
  );
  await owner.activeDrain();
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.strictEqual(owner.activeDrain(), null, 'a fully drained queue must not retain a drain');

  console.log('✓ titles admitted during a drain queue behind it without a second drain');
}

async function testStaleOwnerDropBeforeWrite() {
  const { owner, agents, writes, patches } = createOwner();
  const original = agentRecord('agent-aba');
  agents.set(original.id, original);

  original.adaptiveTitle = 'Queued for the original record';
  const dropped = owner.schedule(
    original.id,
    original,
    'Queued for the original record',
    '',
  );
  const replacement = agentRecord('agent-aba', {
    adaptiveTitle: 'Queued for the original record',
  });
  agents.set(replacement.id, replacement);

  const result = await dropped;
  assert.match(result.error, /Agent runtime changed before persistence/);
  assert.strictEqual(result.retryable, true);
  assert.strictEqual(writes.length, 0, 'an entry for a replaced record must not be written');
  assert.deepStrictEqual(patches, [], 'a dropped entry must not roll back the replacement record');
  assert.strictEqual(replacement.adaptiveTitle, 'Queued for the original record');

  const rotated = agentRecord('agent-epoch-rotated');
  agents.set(rotated.id, rotated);
  rotated.adaptiveTitle = 'Queued before the epoch rotated';
  const staleEpoch = owner.schedule(
    rotated.id,
    rotated,
    'Queued before the epoch rotated',
    'Durable title',
  );
  rotated.runtimeEpoch = 'epoch-rotated-in-place';

  const staleEpochResult = await staleEpoch;
  assert.match(staleEpochResult.error, /Agent runtime changed before persistence/);
  assert.strictEqual(staleEpochResult.retryable, true);
  assert.strictEqual(
    writes.length,
    0,
    'an in-place runtime epoch rotation must drop the entry before any write',
  );
  assert.deepStrictEqual(patches, [], 'a rotated runtime epoch must not be rolled back');
  assert.strictEqual(rotated.adaptiveTitle, 'Queued before the epoch rotated');

  console.log('✓ an entry whose record was replaced or whose epoch rotated is dropped before the write');
}

async function testCanonicalRebindAndEpochFence() {
  const { owner, agents, writes, metadataUpdates, setPersist } = createOwner();
  const rebound = agentRecord('agent-rebound');
  agents.set(rebound.id, rebound);
  setPersist(() => 'agent_record_canonical');

  rebound.adaptiveTitle = 'Rebound title';
  const result = await owner.schedule(rebound.id, rebound, 'Rebound title', '');
  assert.deepStrictEqual(result, { agentId: rebound.id, adaptiveTitle: 'Rebound title' });
  assert.strictEqual(rebound.agentRecordId, 'agent_record_canonical');
  assert.strictEqual(rebound.persistentSessionId, 'agent_record_canonical');
  assert.deepStrictEqual(metadataUpdates, [rebound]);
  assert.strictEqual(
    writes.at(-1).agent.agentRecordId,
    'agent_record_canonical',
    'the staged copy carries the canonical record id, not the live runtime record',
  );

  const rotatedWrite = gate();
  setPersist(async () => {
    rotatedWrite.observe();
    await rotatedWrite.opened;
    return 'agent_record_rotated';
  });
  rebound.adaptiveTitle = 'Accepted before rotation';
  const rotated = owner.schedule(rebound.id, rebound, 'Accepted before rotation', 'Rebound title');
  await rotatedWrite.started;
  rebound.runtimeEpoch = 'epoch-replacement';
  rotatedWrite.release();
  assert.deepStrictEqual(await rotated, {
    agentId: rebound.id,
    adaptiveTitle: 'Accepted before rotation',
  });
  assert.strictEqual(
    rebound.agentRecordId,
    'agent_record_canonical',
    'a rotated runtime epoch must not accept the completed write as its own identity',
  );
  assert.strictEqual(metadataUpdates.length, 1);

  const unavailable = agentRecord('agent-unbound');
  agents.set(unavailable.id, unavailable);
  setPersist(() => '');
  unavailable.adaptiveTitle = 'No owned record';
  const unavailableResult = await withSilencedFailureLog(
    () => owner.schedule(unavailable.id, unavailable, 'No owned record', ''),
  );
  assert.match(unavailableResult.error, /no longer owned by this runtime/);
  assert.strictEqual(unavailable.adaptiveTitle, '', 'a lost record must roll the title back');

  console.log('✓ a committed title rebinds only the exact record that still owns its runtime epoch');
}

async function testLateFailureRollbackScope() {
  const { owner, agents, patches, setPersist } = createOwner();
  const rolledBack = agentRecord('agent-rollback', { adaptiveTitle: 'Durable title' });
  agents.set(rolledBack.id, rolledBack);

  const failingWrite = gate();
  setPersist(async () => {
    failingWrite.observe();
    await failingWrite.opened;
    throw new Error('simulated late title failure');
  });

  rolledBack.adaptiveTitle = 'Draft rollback';
  const coalesced = owner.schedule(rolledBack.id, rolledBack, 'Draft rollback', 'Durable title');
  rolledBack.adaptiveTitle = 'Latest rollback';
  owner.schedule(rolledBack.id, rolledBack, 'Latest rollback', 'Draft rollback');
  const failed = await withSilencedFailureLog(async () => {
    await failingWrite.started;
    failingWrite.release();
    return coalesced;
  });
  assert.match(failed.error, /Failed to update Agent title: simulated late title failure/);
  assert.strictEqual(failed.retryable, true);
  assert.strictEqual(
    rolledBack.adaptiveTitle,
    'Durable title',
    'a coalesced failure rolls back to the title held before the first admission',
  );
  assert.deepStrictEqual(patches, [
    { agentId: rolledBack.id, patch: { adaptiveTitle: 'Durable title' } },
  ]);

  const overwritten = agentRecord('agent-overwritten', { adaptiveTitle: 'Durable title' });
  agents.set(overwritten.id, overwritten);
  const overwrittenWrite = gate();
  setPersist(async () => {
    overwrittenWrite.observe();
    await overwrittenWrite.opened;
    throw new Error('simulated overwritten title failure');
  });
  overwritten.adaptiveTitle = 'Failing title';
  const overwrittenResult = await withSilencedFailureLog(async () => {
    const pending = owner.schedule(overwritten.id, overwritten, 'Failing title', 'Durable title');
    await overwrittenWrite.started;
    overwritten.adaptiveTitle = 'Newer visible title';
    overwrittenWrite.release();
    return pending;
  });
  assert.match(overwrittenResult.error, /simulated overwritten title failure/);
  assert.strictEqual(
    overwritten.adaptiveTitle,
    'Newer visible title',
    'a late failure must not overwrite a newer visible title',
  );

  const replaced = agentRecord('agent-replaced', { adaptiveTitle: 'Durable title' });
  agents.set(replaced.id, replaced);
  const replacedWrite = gate();
  setPersist(async () => {
    replacedWrite.observe();
    await replacedWrite.opened;
    throw new Error('simulated replaced title failure');
  });
  replaced.adaptiveTitle = 'Failing replaced title';
  const replacedResult = await withSilencedFailureLog(async () => {
    const pending = owner.schedule(
      replaced.id,
      replaced,
      'Failing replaced title',
      'Durable title',
    );
    await replacedWrite.started;
    agents.set(replaced.id, agentRecord('agent-replaced', { adaptiveTitle: 'Replacement title' }));
    replacedWrite.release();
    return pending;
  });
  assert.match(replacedResult.error, /simulated replaced title failure/);
  assert.strictEqual(
    agents.get(replaced.id).adaptiveTitle,
    'Replacement title',
    'a late failure must not roll a replacement record back to a title it never held',
  );

  const rotated = agentRecord('agent-rotated-failure', { adaptiveTitle: 'Durable title' });
  agents.set(rotated.id, rotated);
  const rotatedWrite = gate();
  setPersist(async () => {
    rotatedWrite.observe();
    await rotatedWrite.opened;
    throw new Error('simulated rotated title failure');
  });
  rotated.adaptiveTitle = 'Failing rotated title';
  const rotatedResult = await withSilencedFailureLog(async () => {
    const pending = owner.schedule(
      rotated.id,
      rotated,
      'Failing rotated title',
      'Durable title',
    );
    await rotatedWrite.started;
    rotated.runtimeEpoch = 'epoch-rotated-during-failure';
    rotatedWrite.release();
    return pending;
  });
  assert.match(rotatedResult.error, /simulated rotated title failure/);
  assert.strictEqual(rotatedResult.retryable, true);
  assert.strictEqual(
    rotated.adaptiveTitle,
    'Failing rotated title',
    'a runtime epoch that rotated during the failing write must not be rolled back',
  );
  assert.deepStrictEqual(
    patches.map(entry => entry.agentId),
    [rolledBack.id],
    'rollback stays scoped to the exact record, epoch, and value that failed',
  );

  console.log('✓ a late durable failure rolls back only its own record, epoch, and value');
}

async function testClearPendingSettlesQueue() {
  const { owner, agents, writes } = createOwner();
  const cleared = agentRecord('agent-cleared');
  agents.set(cleared.id, cleared);
  cleared.adaptiveTitle = 'Never written';
  const pending = owner.schedule(cleared.id, cleared, 'Never written', '');
  owner.clearPending();
  assert.strictEqual(owner.pendingResult(cleared.id), undefined);

  const cancelled = await pending;
  assert.strictEqual(cancelled.cancelled, true, 'a cleared entry must settle its waiting caller');
  assert.match(cancelled.error, /shutting down/);
  assert.strictEqual(cancelled.retryable, true);
  await owner.activeDrain();
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepStrictEqual(writes, [], 'a cleared queue must not persist after shutdown');
  assert.strictEqual(owner.activeDrain(), null);

  const restarted = agentRecord('agent-restarted');
  agents.set(restarted.id, restarted);
  restarted.adaptiveTitle = 'Scheduled after the clear';
  const resumed = owner.schedule(restarted.id, restarted, 'Scheduled after the clear', '');
  assert(owner.activeDrain(), 'a title scheduled after a clear must start a new drain');
  assert.deepStrictEqual(await resumed, {
    agentId: restarted.id,
    adaptiveTitle: 'Scheduled after the clear',
  });
  assert.deepStrictEqual(
    writes.map(write => [write.id, write.adaptiveTitle]),
    [[restarted.id, 'Scheduled after the clear']],
    'only the title admitted after the clear reaches the store',
  );

  console.log('✓ clearing the queue cancels waiting callers and still allows a later title');
}

async function run() {
  await testCoalescedFifoDrain();
  await testReentrantQueueDuringDrain();
  await testStaleOwnerDropBeforeWrite();
  await testCanonicalRebindAndEpochFence();
  await testLateFailureRollbackScope();
  await testClearPendingSettlesQueue();
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
