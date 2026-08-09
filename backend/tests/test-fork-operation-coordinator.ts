import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

import {
  ForkOperationCoordinator,
  forkRequestSignature,
  type ForkOperationChild,
  type ForkOperationPorts,
} from '../fork-operation-coordinator.cts';
import {
  beginLifecycleOperation,
  setLifecycleOperationResult,
  transitionLifecycleOperation,
} from '../agent-lifecycle-journal.cts';
import type {
  ForkAgentOptions,
  LifecycleJournal,
  LifecycleOperationRequest,
} from '../agent-manager-lifecycle-types.js';
import type { AgentForkResult } from '../agent-manager-provider-types.js';

interface TestSource {
  agentRecordId: string;
  id: string;
  lifecycleJournal?: LifecycleJournal;
  persistentSessionId: string;
  runtimeBinding?: { kind: string };
}

function deferred<Result>() {
  let resolve!: (result: Result) => void;
  const promise = new Promise<Result>(settle => {
    resolve = settle;
  });
  return { promise, resolve };
}

class ForkHarness {
  readonly source: TestSource = {
    agentRecordId: 'record-source',
    id: 'agent-source',
    persistentSessionId: 'record-source',
    runtimeBinding: { kind: 'terminal' },
  };
  readonly children: ForkOperationChild[] = [];
  readonly inFlight = new Map<string, { key: string; promise: Promise<AgentForkResult> }>();
  executeCount = 0;
  stabilizeCount = 0;
  lastExecuteOptions: ForkAgentOptions | null = null;
  checkpointError: Error | null = null;
  execute = async (_context?: {
    onWorktreeCreated(identity: { sourceWorkspace: string; workspace: string }): Promise<void> | void;
  }): Promise<AgentForkResult> => ({
    agentId: `agent-child-${this.executeCount}`,
    mode: 'same-worktree',
    workspace: '/repo',
  });
  failComplete = false;
  rollbackResult: {
    error?: string;
    retainedWorkspace?: string;
    rolledBack: boolean;
    uncertain?: boolean;
  } = { rolledBack: true };
  stabilize = async (): Promise<{ error?: string }> => ({});

  readonly ports: ForkOperationPorts = {
    begin: (source, requestKey, request) => {
      const admission = beginLifecycleOperation(source, 'fork', requestKey, request);
      if (admission.conflict) return { accepted: false, error: 'conflicting lifecycle operation' };
      return { accepted: true, operation: admission.operation };
    },
    complete: (source, operationId, result) => {
      if (this.failComplete) throw new Error('simulated result commit failure');
      const staged = structuredClone(source) as TestSource;
      assert.ok(setLifecycleOperationResult(staged, operationId, result));
      assert.ok(transitionLifecycleOperation(staged, operationId, 'succeeded'));
      Object.assign(source, staged);
    },
    checkpointWorktree: (source, operationId, identity) => {
      if (this.checkpointError) throw this.checkpointError;
      const operation = source.lifecycleJournal?.entries.find(entry => entry.id === operationId);
      assert.ok(operation);
      operation.request = { ...operation.request, forkWorktreeIdentity: identity };
    },
    execute: async (agentId, mode, options, context) => {
      assert.equal(agentId, this.source.id);
      assert.equal(options.requestId, '');
      assert.equal(typeof options.lifecycleToken, 'symbol');
      this.lastExecuteOptions = options;
      this.executeCount += 1;
      const result = await this.execute(context);
      return { ...result, mode };
    },
    getSource: agentId => agentId === this.source.id ? this.source : null,
    listChildren: () => this.children,
    rollbackWorktree: async () => this.rollbackResult,
    runExclusive: (agentId, key, operation) => this.runExclusive(agentId, key, operation),
    stabilizeSourceIdentity: async () => {
      this.stabilizeCount += 1;
      return this.stabilize();
    },
    transitionBlocked: (source, operationId, error, requestPatch) => {
      const operation = source.lifecycleJournal?.entries.find(entry => entry.id === operationId);
      assert.ok(operation);
      operation.request = { ...operation.request, ...(requestPatch || {}) };
      assert.ok(transitionLifecycleOperation(source, operationId, 'blocked', error));
    },
    transitionFailed: (source, operationId, error) => {
      assert.ok(transitionLifecycleOperation(source, operationId, 'failed', error));
    },
    waitForRecovery: async () => {},
  };

  coordinator(): ForkOperationCoordinator {
    return new ForkOperationCoordinator(this.ports);
  }

  private runExclusive(
    agentId: string,
    key: string,
    operation: (lifecycleToken: symbol) => Promise<AgentForkResult>,
  ): Promise<AgentForkResult> {
    const current = this.inFlight.get(agentId);
    if (current?.key === key) return current.promise;
    if (current) {
      return current.promise.then(
        () => this.runExclusive(agentId, key, operation),
        () => this.runExclusive(agentId, key, operation),
      );
    }
    const promise = Promise.resolve().then(() => operation(Symbol(key)));
    const entry = { key, promise };
    this.inFlight.set(agentId, entry);
    void promise.finally(() => {
      if (this.inFlight.get(agentId) === entry) this.inFlight.delete(agentId);
    }).catch(() => {});
    return promise;
  }
}

function beginPendingFork(
  harness: ForkHarness,
  requestId: string,
  options: ForkAgentOptions = {},
  mode: 'same-worktree' | 'new-worktree' = 'same-worktree',
  requestPatch: LifecycleOperationRequest = {},
): void {
  const signature = forkRequestSignature(harness.source, mode, options);
  const admission = beginLifecycleOperation(
    harness.source,
    'fork',
    `fork-request:${requestId}`,
    {
      signature,
      mode,
      sourceRuntimeKind: harness.source.runtimeBinding?.kind || '',
      targetRuntime: options.targetRuntime || '',
      expectedRevision: Number.isSafeInteger(options.expectedRevision)
        ? options.expectedRevision
        : null,
      ...requestPatch,
    } satisfies LifecycleOperationRequest,
  );
  assert.equal(admission.joined, false);
}

function exactChildSignature(
  harness: ForkHarness,
  options: ForkAgentOptions = {},
): string {
  return forkRequestSignature(harness.source, 'same-worktree', options);
}

function legacyForkSignature(harness: ForkHarness): string {
  return crypto.createHash('sha256').update(JSON.stringify({
    agentRecordId: harness.source.agentRecordId,
    expectedRevision: null,
    mode: 'same-worktree',
    targetRuntime: '',
  })).digest('hex');
}

test('same-signature concurrent Fork requests join one effect', async () => {
  const harness = new ForkHarness();
  const execution = deferred<AgentForkResult>();
  harness.execute = () => execution.promise;
  const coordinator = harness.coordinator();

  const first = coordinator.request({
    agentId: harness.source.id,
    options: { requestId: 'request-same' },
  });
  const second = coordinator.request({
    agentId: harness.source.id,
    options: { requestId: 'request-same' },
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(harness.executeCount, 1);
  execution.resolve({ agentId: 'agent-child', workspace: '/repo', mode: 'same-worktree' });

  assert.deepEqual(await first, await second);
  assert.equal(harness.executeCount, 1);
});

test('same requestId with concurrent different signatures never starts a second child', async () => {
  const harness = new ForkHarness();
  const execution = deferred<AgentForkResult>();
  harness.execute = () => execution.promise;
  const coordinator = harness.coordinator();

  const first = coordinator.request({
    agentId: harness.source.id,
    mode: 'same-worktree',
    options: { requestId: 'request-conflict' },
  });
  const conflicting = coordinator.request({
    agentId: harness.source.id,
    mode: 'new-worktree',
    options: { requestId: 'request-conflict' },
  });
  await new Promise(resolve => setImmediate(resolve));
  execution.resolve({ agentId: 'agent-child', workspace: '/repo', mode: 'same-worktree' });

  assert.equal((await first).agentId, 'agent-child');
  assert.match((await conflicting).error || '', /different parameters/);
  assert.equal(harness.executeCount, 1);
});

test('restart with a pending intent and no exact child becomes unknown without replay', async () => {
  const harness = new ForkHarness();
  beginPendingFork(harness, 'request-restart');
  harness.children.push({
    parentAgentId: harness.source.id,
    forkRequestId: 'request-restart',
    runtimeAgentId: 'legacy-unfenced-child',
  });

  const result = await harness.coordinator().request({
    agentId: harness.source.id,
    options: { requestId: 'request-restart' },
  });

  assert.equal(result.uncertain, true);
  assert.match(result.error || '', /will not be replayed automatically/);
  assert.equal(harness.executeCount, 0);
  assert.equal(harness.source.lifecycleJournal?.entries[0].state, 'blocked');
});

test('a completed replay does not deadlock behind an unrelated lifecycle owner', async () => {
  const harness = new ForkHarness();
  const admission = beginLifecycleOperation(
    harness.source,
    'fork',
    'fork-request:request-completed',
    {
      signature: legacyForkSignature(harness),
      mode: 'same-worktree',
      targetRuntime: '',
      expectedRevision: null,
    },
  );
  assert.equal(admission.joined, false);
  const operation = harness.source.lifecycleJournal?.entries[0];
  assert.ok(operation);
  assert.ok(setLifecycleOperationResult(harness.source, operation.id, {
    agentId: 'agent-completed-child',
    workspace: '/repo',
    mode: 'same-worktree',
    requestId: 'request-completed',
  }));
  assert.ok(transitionLifecycleOperation(harness.source, operation.id, 'succeeded'));

  const archive = deferred<AgentForkResult>();
  harness.inFlight.set(harness.source.id, { key: 'archive', promise: archive.promise });
  const replay = harness.coordinator().request({
    agentId: harness.source.id,
    options: { requestId: 'request-completed' },
  });
  const beforeArchive = await Promise.race([
    replay.then(() => 'settled'),
    new Promise<'waiting'>(resolve => setImmediate(() => resolve('waiting'))),
  ]);
  assert.equal(beforeArchive, 'settled');
  harness.inFlight.delete(harness.source.id);
  archive.resolve({ agentId: 'archive-complete' });

  const result = await replay;
  assert.equal(result.agentId, 'agent-completed-child');
  assert.equal(result.deduplicated, true);
  assert.equal(harness.executeCount, 0);

});

test('a legacy completed Fork signed before Codex identity promotion still replays', async () => {
  const harness = new ForkHarness();
  harness.source.agentRecordId = 'record-temporary';
  harness.source.persistentSessionId = 'record-temporary';
  const admission = beginLifecycleOperation(
    harness.source,
    'fork',
    'fork-request:request-legacy-promotion',
    {
      signature: forkRequestSignature(harness.source, 'same-worktree', {}),
      mode: 'same-worktree',
      targetRuntime: '',
      expectedRevision: null,
    },
  );
  assert.ok(admission.operation);
  assert.ok(setLifecycleOperationResult(harness.source, admission.operation.id, {
    agentId: 'agent-legacy-promoted-child',
    workspace: '/repo',
    requestId: 'request-legacy-promotion',
  }));
  assert.ok(transitionLifecycleOperation(harness.source, admission.operation.id, 'succeeded'));
  harness.source.agentRecordId = 'record-stable';
  harness.source.persistentSessionId = 'record-stable';

  const result = await harness.coordinator().request({
    agentId: harness.source.id,
    options: { requestId: 'request-legacy-promotion' },
  });
  assert.equal(result.agentId, 'agent-legacy-promoted-child');
  assert.equal(result.deduplicated, true);
  assert.equal(harness.executeCount, 0);
});

async function assertLegacyPendingPromotionBlocks(
  includeLegacyChild: boolean,
  supersedingType: 'archive' | 'delete',
): Promise<void> {
  const harness = new ForkHarness();
  harness.source.agentRecordId = 'record-legacy-temporary';
  harness.source.persistentSessionId = 'record-legacy-temporary';
  const requestId = includeLegacyChild
    ? 'request-legacy-pending-child'
    : 'request-legacy-pending-empty';
  const admission = beginLifecycleOperation(
    harness.source,
    'fork',
    `fork-request:${requestId}`,
    {
      signature: forkRequestSignature(harness.source, 'same-worktree', {}),
      mode: 'same-worktree',
      targetRuntime: '',
      expectedRevision: null,
    },
  );
  assert.ok(admission.operation);
  if (includeLegacyChild) {
    harness.children.push({
      parentAgentId: harness.source.id,
      forkRequestId: requestId,
      runtimeAgentId: 'agent-unfenced-legacy-child',
    });
  }
  harness.source.agentRecordId = 'record-legacy-stable';
  harness.source.persistentSessionId = 'record-legacy-stable';

  const result = await harness.coordinator().request({
    agentId: harness.source.id,
    options: { requestId },
  });
  assert.equal(result.uncertain, true);
  assert.match(result.error || '', /legacy identity outcome/);
  assert.equal(harness.executeCount, 0);
  assert.equal(harness.source.lifecycleJournal?.entries[0].state, 'blocked');
  const superseding = beginLifecycleOperation(
    harness.source,
    supersedingType,
    supersedingType,
    {},
  );
  assert.equal(superseding.conflict, undefined);
}

test('legacy pending Codex promotion with no child becomes blocked and allows archive', async () => {
  await assertLegacyPendingPromotionBlocks(false, 'archive');
});

test('legacy pending Codex promotion never claims an unfenced child and allows delete', async () => {
  await assertLegacyPendingPromotionBlocks(true, 'delete');
});

test('a legacy completed journal without a signature still returns its durable result', async () => {
  const harness = new ForkHarness();
  const admission = beginLifecycleOperation(
    harness.source,
    'fork',
    'fork-request:request-legacy-result',
    { mode: 'same-worktree', targetRuntime: '', expectedRevision: null },
  );
  assert.ok(admission.operation);
  assert.ok(setLifecycleOperationResult(harness.source, admission.operation.id, {
    agentId: 'agent-legacy-child',
    workspace: '/repo',
    requestId: 'request-legacy-result',
  }));
  assert.ok(transitionLifecycleOperation(harness.source, admission.operation.id, 'succeeded'));

  const result = await harness.coordinator().request({
    agentId: harness.source.id,
    options: { requestId: 'request-legacy-result' },
  });
  assert.equal(result.agentId, 'agent-legacy-child');
  assert.equal(result.deduplicated, true);
  assert.equal(harness.executeCount, 0);
  for (const changed of [
    { mode: 'new-worktree' as const, options: { requestId: 'request-legacy-result' } },
    { mode: 'same-worktree' as const, options: { requestId: 'request-legacy-result', targetRuntime: 'chat' as const } },
    { mode: 'same-worktree' as const, options: { requestId: 'request-legacy-result', expectedRevision: 1 } },
  ]) {
    const conflict = await harness.coordinator().request({
      agentId: harness.source.id,
      ...changed,
    });
    assert.match(conflict.error || '', /different parameters/);
  }
});

test('a queued Fork rejects a source runtime switch before any effect', async () => {
  const harness = new ForkHarness();
  const blocker = deferred<AgentForkResult>();
  harness.inFlight.set(harness.source.id, { key: 'archive', promise: blocker.promise });
  const request = harness.coordinator().request({
    agentId: harness.source.id,
    options: { requestId: 'request-runtime-switch' },
  });
  await new Promise(resolve => setImmediate(resolve));
  harness.source.runtimeBinding = { kind: 'acp' };
  harness.inFlight.delete(harness.source.id);
  blocker.resolve({ agentId: 'archive-complete' });

  const result = await request;
  assert.match(result.error || '', /changed identity/);
  assert.equal(result.uncertain, true);
  assert.equal(harness.executeCount, 0);
});

test('a completed Fork result remains immutable after the source runtime kind changes', async () => {
  const harness = new ForkHarness();
  const coordinator = harness.coordinator();
  const first = await coordinator.request({
    agentId: harness.source.id,
    options: { requestId: 'request-completed-runtime' },
  });
  assert.ok(first.agentId);
  harness.source.runtimeBinding = { kind: 'acp' };

  const replay = await coordinator.request({
    agentId: harness.source.id,
    options: { requestId: 'request-completed-runtime' },
  });
  assert.equal(replay.agentId, first.agentId);
  assert.equal(replay.deduplicated, true);
  assert.equal(harness.executeCount, 1);
});

test('a pending Fork never claims an exact child after the source runtime kind changes', async () => {
  const harness = new ForkHarness();
  beginPendingFork(harness, 'request-pending-runtime');
  harness.children.push({
    parentAgentId: harness.source.id,
    forkRequestId: 'request-pending-runtime',
    forkRequestSignature: exactChildSignature(harness),
    runtimeAgentId: 'agent-terminal-child',
  });
  harness.source.runtimeBinding = { kind: 'acp' };

  const result = await harness.coordinator().request({
    agentId: harness.source.id,
    options: { requestId: 'request-pending-runtime' },
  });
  assert.match(result.error || '', /different parameters/);
  assert.equal(harness.executeCount, 0);
  assert.equal(harness.source.lifecycleJournal?.entries[0].state, 'pending');
});

test('transport timeout leaves durable intent for unknown reconciliation and no replay', async () => {
  const harness = new ForkHarness();
  beginPendingFork(harness, 'request-timeout');

  const result = await harness.coordinator().request({
    agentId: harness.source.id,
    options: { requestId: 'request-timeout' },
  });

  assert.equal(result.uncertain, true);
  assert.equal(harness.executeCount, 0);
});

test('restart rolls back an exact checkpoint before failing without replay', async () => {
  const harness = new ForkHarness();
  const identity = { sourceWorkspace: '/repo', workspace: '/repo-farming-fork-checkpoint' };
  beginPendingFork(
    harness,
    'request-checkpoint-clean',
    {},
    'new-worktree',
    { forkWorktreeIdentity: identity },
  );

  const result = await harness.coordinator().request({
    agentId: harness.source.id,
    mode: 'new-worktree',
    options: { requestId: 'request-checkpoint-clean' },
  });

  assert.equal(result.uncertain, undefined);
  assert.match(result.error || '', /rolled back/);
  assert.equal(harness.source.lifecycleJournal?.entries[0].state, 'failed');
  assert.equal(harness.executeCount, 0);
});

for (const rollbackResult of [
  {
    rolledBack: false,
    error: 'Temporary Fork worktree contains uncommitted changes',
    retainedWorkspace: '/repo-farming-fork-checkpoint',
  },
  {
    rolledBack: false,
    error: 'Temporary Fork worktree rollback could not be proven',
    retainedWorkspace: '/repo-farming-fork-checkpoint',
    uncertain: true,
  },
]) {
  test(`restart blocks and retains a checkpoint when rollback cannot complete: ${rollbackResult.error}`, async () => {
    const harness = new ForkHarness();
    const identity = {
      sourceWorkspace: '/repo',
      workspace: '/repo-farming-fork-checkpoint',
    };
    harness.rollbackResult = rollbackResult;
    beginPendingFork(
      harness,
      'request-checkpoint-retained',
      {},
      'new-worktree',
      { forkWorktreeIdentity: identity },
    );

    const result = await harness.coordinator().request({
      agentId: harness.source.id,
      mode: 'new-worktree',
      options: { requestId: 'request-checkpoint-retained' },
    });

    assert.equal(result.uncertain, true);
    assert.equal(result.retainedWorkspace, identity.workspace);
    assert.match(result.error || '', new RegExp(identity.workspace));
    assert.equal(harness.source.lifecycleJournal?.entries[0].state, 'blocked');
    assert.equal(harness.executeCount, 0);
  });
}

test('a thrown rollback port settles restart as blocked without replay', async () => {
  const harness = new ForkHarness();
  const identity = { sourceWorkspace: '/repo', workspace: '/repo-farming-fork-throw' };
  harness.ports.rollbackWorktree = async () => {
    throw new Error('simulated delete port throw');
  };
  beginPendingFork(
    harness,
    'request-checkpoint-throw',
    {},
    'new-worktree',
    { forkWorktreeIdentity: identity },
  );

  const result = await harness.coordinator().request({
    agentId: harness.source.id,
    mode: 'new-worktree',
    options: { requestId: 'request-checkpoint-throw' },
  });

  assert.equal(result.uncertain, true);
  assert.equal(result.retainedWorkspace, identity.workspace);
  assert.match(result.error || '', /simulated delete port throw/);
  assert.equal(harness.source.lifecycleJournal?.entries[0].state, 'blocked');
  assert.equal(harness.executeCount, 0);
});

test('checkpoint persistence failure atomically retains identity with blocked outcome', async () => {
  const harness = new ForkHarness();
  const identity = { sourceWorkspace: '/repo', workspace: '/repo-farming-fork-uncommitted' };
  harness.checkpointError = new Error('simulated checkpoint persistence failure');
  harness.execute = async context => {
    assert.ok(context);
    try {
      await context.onWorktreeCreated(identity);
    } catch {
      return {
        error: `Failed to persist checkpoint; temporary worktree retained at ${identity.workspace}`,
        retainedWorkspace: identity.workspace,
        workspace: identity.workspace,
        uncertain: true,
      };
    }
    assert.fail('checkpoint should fail');
  };

  const result = await harness.coordinator().request({
    agentId: harness.source.id,
    mode: 'new-worktree',
    options: { requestId: 'request-checkpoint-persist-failure' },
  });

  assert.equal(result.uncertain, true);
  const operation = harness.source.lifecycleJournal?.entries[0];
  assert.equal(operation?.state, 'blocked');
  assert.deepEqual(operation?.request.forkWorktreeIdentity, identity);
  assert.match(operation?.error || '', new RegExp(identity.workspace));
});

test('an execute throw before any checkpoint settles as blocked instead of leaving pending intent', async () => {
  const harness = new ForkHarness();
  harness.execute = async () => {
    throw new Error('simulated execute throw');
  };

  const result = await harness.coordinator().request({
    agentId: harness.source.id,
    options: { requestId: 'request-execute-throw' },
  });

  assert.equal(result.uncertain, true);
  assert.match(result.error || '', /simulated execute throw/);
  assert.equal(harness.source.lifecycleJournal?.entries[0].state, 'blocked');
});

test('an execute throw after checkpoint atomically retains identity and blocks replay', async () => {
  const harness = new ForkHarness();
  const identity = { sourceWorkspace: '/repo', workspace: '/repo-farming-fork-execute-throw' };
  harness.execute = async context => {
    assert.ok(context);
    await context.onWorktreeCreated(identity);
    throw new Error('simulated post-checkpoint execute throw');
  };

  const result = await harness.coordinator().request({
    agentId: harness.source.id,
    mode: 'new-worktree',
    options: { requestId: 'request-post-checkpoint-throw' },
  });

  assert.equal(result.uncertain, true);
  assert.equal(result.retainedWorkspace, identity.workspace);
  const operation = harness.source.lifecycleJournal?.entries[0];
  assert.equal(operation?.state, 'blocked');
  assert.deepEqual(operation?.request.forkWorktreeIdentity, identity);
  assert.match(operation?.error || '', new RegExp(identity.workspace));
});

test('a proven pre-effect failure is terminal and does not block later lifecycle work', async () => {
  const harness = new ForkHarness();
  harness.execute = async () => ({ error: 'ACP Agent is not ready for Conversation Fork (working)' });

  const result = await harness.coordinator().request({
    agentId: harness.source.id,
    options: { requestId: 'request-proven-failure' },
  });

  assert.equal(result.uncertain, undefined);
  assert.equal(harness.source.lifecycleJournal?.entries[0].state, 'failed');
  harness.execute = async () => ({ agentId: 'agent-retry-child', workspace: '/repo' });
  const retry = await harness.coordinator().request({
    agentId: harness.source.id,
    options: { requestId: 'request-proven-failure-retry' },
  });
  assert.equal(retry.agentId, 'agent-retry-child');
  const archive = beginLifecycleOperation(harness.source, 'archive', 'archive', {});
  assert.equal(archive.conflict, undefined);
});

test('an uncertain effect stays blocked for no-replay but does not block archive admission', async () => {
  const harness = new ForkHarness();
  harness.execute = async () => ({ error: 'Agent start outcome is uncertain', uncertain: true });
  const coordinator = harness.coordinator();

  const result = await coordinator.request({
    agentId: harness.source.id,
    options: { requestId: 'request-unknown-effect' },
  });
  assert.equal(result.uncertain, true);
  assert.equal(harness.source.lifecycleJournal?.entries[0].state, 'blocked');
  assert.equal(harness.executeCount, 1);

  const replay = await coordinator.request({
    agentId: harness.source.id,
    options: { requestId: 'request-unknown-effect' },
  });
  assert.equal(replay.uncertain, true);
  assert.equal(harness.executeCount, 1);
  const differentRequest = await coordinator.request({
    agentId: harness.source.id,
    options: { requestId: 'request-unknown-effect-retry' },
  });
  assert.match(differentRequest.error || '', /conflict/i);
  assert.equal(harness.executeCount, 1);
  const update = beginLifecycleOperation(harness.source, 'update', 'update', {});
  assert.ok(update.conflict);
  const archive = beginLifecycleOperation(harness.source, 'archive', 'archive', {});
  assert.equal(archive.conflict, undefined);
  assert.ok(transitionLifecycleOperation(harness.source, archive.operation.id, 'succeeded'));
  const deletion = beginLifecycleOperation(harness.source, 'delete', 'delete', {});
  assert.equal(deletion.conflict, undefined);
});

test('restart reconciles only one exact live child identity', async () => {
  const harness = new ForkHarness();
  beginPendingFork(harness, 'request-child');
  harness.children.push(
    {
      parentAgentId: 'other-source',
      forkRequestId: 'request-child',
      forkRequestSignature: exactChildSignature(harness),
      runtimeAgentId: 'wrong-parent',
    },
    {
      parentAgentId: harness.source.id,
      forkRequestId: 'request-child',
      forkRequestSignature: exactChildSignature(harness),
      runtimeAgentId: '',
    },
    {
      parentAgentId: harness.source.id,
      forkRequestId: 'request-child',
      forkRequestSignature: exactChildSignature(harness),
      reconciliationState: 'ready',
      runtimeAgentId: 'agent-exact-child',
      projectWorkspace: '/repo/exact',
      providerSessionId: 'session-exact',
    },
  );

  const result = await harness.coordinator().request({
    agentId: harness.source.id,
    options: { requestId: 'request-child' },
  });

  assert.equal(result.agentId, 'agent-exact-child');
  assert.equal(result.workspace, '/repo/exact');
  assert.equal(result.reconciled, true);
  assert.equal(result.deduplicated, true);
  assert.equal(harness.executeCount, 0);
});

test('a reused runtime Agent id never claims a child from an older source record', async () => {
  const harness = new ForkHarness();
  const oldSignature = forkRequestSignature(
    harness.source,
    'same-worktree',
    { requestId: 'request-reused-source' },
  );
  harness.children.push({
    parentAgentId: harness.source.id,
    forkRequestId: 'request-reused-source',
    forkRequestSignature: oldSignature,
    runtimeAgentId: 'agent-old-child',
    projectWorkspace: '/repo/old',
  });
  harness.source.agentRecordId = 'record-replacement';
  harness.source.persistentSessionId = 'record-replacement';

  const result = await harness.coordinator().request({
    agentId: harness.source.id,
    options: { requestId: 'request-reused-source' },
  });

  assert.notEqual(result.agentId, 'agent-old-child');
  assert.equal(harness.executeCount, 1);
  assert.equal(
    harness.lastExecuteOptions?.forkRequestId,
    'request-reused-source',
  );
  assert.equal(
    harness.lastExecuteOptions?.forkRequestSignature,
    exactChildSignature(harness),
  );
});

test('an exact retained error child stays blocked and is never reported as a successful replay', async () => {
  const harness = new ForkHarness();
  beginPendingFork(harness, 'request-retained-child');
  harness.children.push({
    parentAgentId: harness.source.id,
    forkRequestId: 'request-retained-child',
    forkRequestSignature: exactChildSignature(harness),
    reconciliationState: 'retained',
    runtimeAgentId: 'agent-retained-child',
    projectWorkspace: '/repo',
  });

  const first = await harness.coordinator().request({
    agentId: harness.source.id,
    options: { requestId: 'request-retained-child' },
  });
  const replay = await harness.coordinator().request({
    agentId: harness.source.id,
    options: { requestId: 'request-retained-child' },
  });

  for (const result of [first, replay]) {
    assert.equal(result.agentId, undefined);
    assert.equal(result.retainedAgentId, 'agent-retained-child');
    assert.equal(result.uncertain, true);
  }
  assert.equal(harness.executeCount, 0);
  assert.equal(harness.source.lifecycleJournal?.entries[0].state, 'blocked');
});

test('lost result commit reconciles the persisted child without replay', async () => {
  const harness = new ForkHarness();
  harness.failComplete = true;
  harness.execute = async () => {
    harness.children.push({
      parentAgentId: harness.source.id,
      forkRequestId: 'request-lost-result',
      forkRequestSignature: exactChildSignature(harness),
      reconciliationState: 'ready',
      runtimeAgentId: 'agent-created-child',
      projectWorkspace: '/repo',
    });
    return { agentId: 'agent-created-child', workspace: '/repo', mode: 'same-worktree' };
  };
  const coordinator = harness.coordinator();

  const uncertain = await coordinator.request({
    agentId: harness.source.id,
    options: { requestId: 'request-lost-result' },
  });
  assert.equal(uncertain.retryable, true);
  assert.equal(harness.executeCount, 1);

  harness.failComplete = false;
  const reconciled = await coordinator.request({
    agentId: harness.source.id,
    options: { requestId: 'request-lost-result' },
  });
  assert.equal(reconciled.agentId, 'agent-created-child');
  assert.equal(reconciled.reconciled, true);
  assert.equal(harness.executeCount, 1);
});

test('temporary Codex source promotion happens before signing and survives a lost result commit', async () => {
  const harness = new ForkHarness();
  harness.source.agentRecordId = 'record-temporary-codex';
  harness.source.persistentSessionId = 'record-temporary-codex';
  harness.stabilize = async () => {
    if (harness.source.agentRecordId === 'record-temporary-codex') {
      harness.source.agentRecordId = 'record-stable-codex';
      harness.source.persistentSessionId = 'record-stable-codex';
    }
    return {};
  };
  harness.failComplete = true;
  harness.execute = async () => {
    harness.children.push({
      parentAgentId: harness.source.id,
      forkRequestId: 'request-codex-promotion',
      forkRequestSignature: exactChildSignature(harness),
      reconciliationState: 'ready',
      runtimeAgentId: 'agent-promoted-child',
      projectWorkspace: '/repo',
    });
    return { agentId: 'agent-promoted-child', workspace: '/repo', mode: 'same-worktree' };
  };
  const coordinator = harness.coordinator();

  const uncertain = await coordinator.request({
    agentId: harness.source.id,
    options: { requestId: 'request-codex-promotion' },
  });
  assert.equal(uncertain.retryable, true);
  assert.equal(harness.executeCount, 1);
  assert.equal(harness.source.agentRecordId, 'record-stable-codex');

  harness.failComplete = false;
  const replay = await coordinator.request({
    agentId: harness.source.id,
    options: { requestId: 'request-codex-promotion' },
  });
  assert.equal(replay.agentId, 'agent-promoted-child');
  assert.equal(replay.reconciled, true);
  assert.equal(harness.executeCount, 1);
  assert.equal(harness.stabilizeCount, 2);
});
