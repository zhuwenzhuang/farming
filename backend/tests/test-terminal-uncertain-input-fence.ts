const assert = require('assert');
const { AgentManager } = require('../agent-manager.cjs');
const { createTestAgentManager } = require('./helpers/test-acp-runtime.ts');

function deferred() {
  let resolve;
  const promise = new Promise(resolvePromise => { resolve = resolvePromise; });
  return { promise, resolve };
}

function createManager() {
  const manager = createTestAgentManager(AgentManager, {
    getWorkspace() {
      return '/tmp';
    },
    getHeartbeatInterval() {
      return 1000;
    },
  });
  manager.heartbeatScheduler?.stop?.();
  return manager;
}

function terminalAgent(id, runtimeEpoch) {
  return {
    id,
    command: 'codex',
    cwd: '/tmp',
    engineName: 'local',
    status: 'running',
    agentRuntimeMode: 'terminal',
    runtimeEpoch,
    providerSessionProvider: 'codex',
  };
}

function timeoutError() {
  const error = new Error('Native pty host request timed out: sendInput') as Error & {
    code?: string;
    terminalMutationUncertain?: boolean;
  };
  error.code = 'ETIMEDOUT';
  // Explicit provider-neutral uncertainty signal: the mutation was dispatched
  // and never answered. Classification never keys off error text.
  error.terminalMutationUncertain = true;
  return error;
}

function definitiveHostRejectionError() {
  // A host-answered rejection before the PTY write: proven zero-write, no
  // uncertainty marker.
  return new Error('Terminal session is frozen for native PTY host rotation');
}

const CODEX_COMPOSER_PREVIEW = '• Service tier set to default\n\n› Ask Codex\n\ngpt-5.5 xhigh · /tmp';

function engineWithWrites(writes, options: {
  failFirst?: boolean;
  manager?: { agents: Map<string, { runtimeEpoch?: string }> };
  onFirstStart?: () => void;
} = {}) {
  const { failFirst, onFirstStart } = options;
  let firstAttempted = false;
  return {
    async sendInput(agentId, input, inputOptions: { expectedRuntimeEpoch?: string } = {}) {
      const agent = options.manager?.agents.get(agentId);
      if (
        typeof inputOptions.expectedRuntimeEpoch === 'string'
        && inputOptions.expectedRuntimeEpoch
        && agent
        && inputOptions.expectedRuntimeEpoch !== agent.runtimeEpoch
      ) {
        return { status: 'input-rejected', reason: 'runtime-epoch-mismatch' };
      }
      if (failFirst && !firstAttempted) {
        firstAttempted = true;
        onFirstStart?.();
        throw timeoutError();
      }
      writes.push({ agentId, input });
      return { sent: true };
    },
    async getSessionState() {
      return {
        status: 'running',
        previewText: CODEX_COMPOSER_PREVIEW,
        output: CODEX_COMPOSER_PREVIEW,
        renderOutput: CODEX_COMPOSER_PREVIEW,
      };
    },
  };
}

// 1. Pre-timeout queued input is rejected, and a later authoritative
// reconciliation only admits input that is admitted AFTER it. The generic
// attach checkpoint read must NOT clear the fence.
async function preTimeoutQueuedInputNeverPasses() {
  const manager = createManager();
  const writes = [];
  const firstStarted = deferred();
  const releaseFirst = deferred();
  let failFirst = true;
  manager.engineBridge.getEngine = () => ({
    async sendInput(agentId, input) {
      if (failFirst) {
        failFirst = false;
        firstStarted.resolve();
        await releaseFirst.promise;
        throw timeoutError();
      }
      writes.push({ agentId, input });
      return { sent: true };
    },
  });
  manager.agents.set('agent-fence', terminalAgent('agent-fence', 'epoch-1'));

  const first = manager.sendInput('agent-fence', [{ type: 'paste', text: 'uncertain' }, '\r']);
  await firstStarted.promise;
  const second = manager.sendInput('agent-fence', [{ type: 'paste', text: 'queued' }, '\r']);
  releaseFirst.resolve();
  await first;
  assert.deepStrictEqual(
    await second,
    { status: 'input-rejected', reason: 'uncertain-input-fence' },
    'input queued before an uncertain write must be rejected',
  );
  assert.strictEqual(writes.length, 0);

  // Admission during an active fence is rejected at the boundary with an
  // explicit zero-write result (never a silent undefined).
  assert.deepStrictEqual(
    await manager.sendInput('agent-fence', 'late'),
    { status: 'input-rejected', reason: 'uncertain-input-fence' },
  );

  // A generic attach checkpoint read is NOT an explicit reconciliation and
  // must not clear the fence.
  manager.engineBridge.getSessionAttachCheckpoint = async () => ({
    runtimeEpoch: 'epoch-1',
    outputSeq: 1,
    stateRevision: 1,
  });
  assert.ok(await manager.getAgentSessionAttachCheckpoint('agent-fence'));
  assert.strictEqual(manager.terminalInputFences.get('agent-fence')?.active, true,
    'a background attach checkpoint must not clear the fence');

  // The explicit checkpoint path reconciles with exact epoch evidence.
  assert.strictEqual(manager.releaseTerminalInputFence('agent-fence', { runtimeEpoch: 'epoch-1' }), true);
  assert.strictEqual(manager.terminalInputFences.get('agent-fence')?.active, false);

  // Input admitted before the uncertain write still cannot pass.
  assert.deepStrictEqual(
    await manager.sendInputNow('agent-fence', 'stale', { admissionPhase: 0, expectedRuntimeEpoch: 'epoch-1' }),
    { status: 'input-rejected', reason: 'uncertain-input-fence' },
    'reconciliation must not admit input admitted before the uncertain write',
  );
  // Newly admitted input after the reconciliation passes.
  assert.deepStrictEqual(await manager.sendInput('agent-fence', 'after reconcile'), { sent: true });
  assert.strictEqual(writes.length, 1);
}

// 2. Only exact authoritative evidence reconciles; background reads cannot.
async function onlyExactAuthoritativeCheckpointReconciles() {
  const manager = createManager();
  manager.engineBridge.getEngine = () => ({
    async sendInput() {
      throw timeoutError();
    },
  });
  manager.engineBridge.getSessionAttachCheckpoint = async () => ({
    runtimeEpoch: 'epoch-1',
    outputSeq: 1,
    stateRevision: 1,
  });
  manager.agents.set('agent-reconcile', terminalAgent('agent-reconcile', 'epoch-1'));
  await manager.sendInput('agent-reconcile', 'x');
  assert.strictEqual(manager.terminalInputFences.get('agent-reconcile')?.active, true);

  // Background attach reads never reconcile.
  assert.ok(await manager.getAgentSessionAttachCheckpoint('agent-reconcile'));
  assert.strictEqual(manager.terminalInputFences.get('agent-reconcile')?.active, true);

  // Missing / mismatched / wrong-Agent evidence is not a reconciliation.
  assert.strictEqual(manager.releaseTerminalInputFence('agent-reconcile', {}), false);
  assert.strictEqual(manager.releaseTerminalInputFence('agent-reconcile', { runtimeEpoch: 'epoch-other' }), false);
  assert.strictEqual(manager.releaseTerminalInputFence('missing-agent', { runtimeEpoch: 'epoch-1' }), false);
  assert.strictEqual(manager.terminalInputFences.get('agent-reconcile')?.active, true);

  // Exact live epoch evidence reconciles.
  assert.strictEqual(manager.releaseTerminalInputFence('agent-reconcile', { runtimeEpoch: 'epoch-1' }), true);
  assert.strictEqual(manager.terminalInputFences.get('agent-reconcile')?.active, false);
}

// 3. A runtime replacement supersedes the fence; input admitted under the old
// epoch is rejected by its captured admission epoch instead.
async function epochAdvanceRejectsStaleQueuedInput() {
  const manager = createManager();
  const writes = [];
  const firstStarted = deferred();
  const releaseFirst = deferred();
  let holdFirst = true;
  manager.engineBridge.getEngine = () => ({
    async sendInput(agentId, input) {
      if (holdFirst) {
        holdFirst = false;
        firstStarted.resolve();
        await releaseFirst.promise;
      }
      writes.push({ agentId, input });
      return { sent: true };
    },
  });
  manager.agents.set('agent-epoch', terminalAgent('agent-epoch', 'epoch-1'));

  const first = manager.sendInput('agent-epoch', 'one');
  await firstStarted.promise;
  const queued = manager.sendInput('agent-epoch', 'two');
  manager.agents.get('agent-epoch').runtimeEpoch = 'epoch-2';
  releaseFirst.resolve();
  await first;
  assert.deepStrictEqual(
    await queued,
    { status: 'input-rejected', reason: 'runtime-epoch-mismatch' },
    'queued input must not cross a runtime replacement boundary',
  );
  assert.strictEqual(writes.length, 1, 'only the in-flight write may reach the old runtime');
  assert.deepStrictEqual(await manager.sendInput('agent-epoch', 'three'), { sent: true });
  assert.strictEqual(writes.length, 2);
}

// 4. A proven session loss marks the Agent dead and never fences it.
async function provenSessionLossDoesNotFence() {
  const manager = createManager();
  manager.engineBridge.getEngine = () => ({
    async sendInput() {
      throw new Error('Session not available');
    },
  });
  manager.agents.set('agent-loss', terminalAgent('agent-loss', 'epoch-1'));
  assert.deepStrictEqual(
    await manager.sendInput('agent-loss', 'x'),
    { status: 'input-rejected', reason: 'terminal-write-rejected' },
    'session loss is a definitive zero-write rejection, not uncertainty',
  );
  assert.strictEqual(manager.agents.get('agent-loss').status, 'dead');
  assert.strictEqual(manager.terminalInputFences.has('agent-loss'), false);
}

// 5. Interrupt is fenced like input: rejected while a fence is active, fences
// the queue when its own outcome is uncertain, and captures the admission
// epoch so a runtime replacement is proven zero-effect.
async function interruptHonorsAndSetsTheFence() {
  const manager = createManager();
  const writes = [];
  let failNext = false;
  manager.engineBridge.getEngine = () => ({
    async sendInput(agentId, input, inputOptions: { expectedRuntimeEpoch?: string } = {}) {
      const agent = manager.agents.get(agentId);
      if (
        typeof inputOptions.expectedRuntimeEpoch === 'string'
        && inputOptions.expectedRuntimeEpoch
        && agent
        && inputOptions.expectedRuntimeEpoch !== agent.runtimeEpoch
      ) {
        return { status: 'input-rejected', reason: 'runtime-epoch-mismatch' };
      }
      if (failNext) {
        failNext = false;
        throw timeoutError();
      }
      writes.push({ agentId, input });
      return { sent: true };
    },
  });
  manager.agents.set('agent-int', terminalAgent('agent-int', 'epoch-1'));

  // An uncertain interrupt fences the queue.
  failNext = true;
  await assert.rejects(
    manager.interruptAgent('agent-int'),
    error => error.code === 'TERMINAL_INPUT_UNCONFIRMED' && error.uncertain === true,
    'an uncertain interrupt must surface a visible uncertain failure',
  );
  assert.strictEqual(manager.terminalInputFences.get('agent-int')?.active, true,
    'an uncertain interrupt must fence the queue');

  // While fenced, another interrupt is rejected explicitly, not sent blindly.
  await assert.rejects(
    manager.interruptAgent('agent-int'),
    error => (
      error.code === 'TERMINAL_INPUT_UNCERTAIN_FENCE'
      && /uncertain outcome until the terminal checkpoint recovers/.test(error.message)
    ),
    'a fenced interrupt must surface a visible typed rejection',
  );
  // And queued input stays rejected.
  assert.deepStrictEqual(
    await manager.sendInput('agent-int', 'x'),
    { status: 'input-rejected', reason: 'uncertain-input-fence' },
  );
  assert.strictEqual(writes.length, 0);

  // After an explicit reconciliation the interrupt is admitted again.
  assert.strictEqual(manager.releaseTerminalInputFence('agent-int', { runtimeEpoch: 'epoch-1' }), true);
  assert.deepStrictEqual(await manager.interruptAgent('agent-int'), { sent: true });
  assert.strictEqual(writes.length, 1);

  // The interrupt carries its admission epoch to the engine, so a runtime
  // replacement is a proven zero-effect rejection.
  manager.agents.get('agent-int').runtimeEpoch = 'epoch-2';
  await assert.rejects(
    manager.interruptAgent('agent-int', { expectedRuntimeEpoch: 'epoch-1' }),
    error => error.code === 'TERMINAL_INPUT_EPOCH_REJECTED',
  );
  assert.strictEqual(writes.length, 1);
  // Without an explicit epoch the interrupt captures the current epoch at
  // admission and reaches the new runtime.
  assert.deepStrictEqual(await manager.interruptAgent('agent-int'), { sent: true });
  assert.strictEqual(writes.length, 2);
}

// 6. Composer delivery fails explicitly with a proven zero-write error while
// fenced, on both the confirmed and non-persistent paths.
async function composerDeliveryIsExplicitlyRejectedWhileFenced() {
  const manager = createManager();
  manager.engineBridge.getEngine = () => ({
    async sendInput() {
      throw timeoutError();
    },
  });
  const agent = terminalAgent('agent-composer', 'epoch-1');
  manager.agents.set('agent-composer', agent);
  await manager.sendInput('agent-composer', 'x');

  await assert.rejects(
    manager.sendComposerMessageNow('agent-composer', 'queued composer', {
      expectedTerminalAgent: agent,
      expectedTerminalRuntimeEpoch: 'epoch-1',
      requireConfirmedTerminalDelivery: true,
    }),
    error => (
      error.code === 'TERMINAL_INPUT_UNCERTAIN_FENCE'
      && error.composerZeroEffect === true
      && /fenced after an uncertain write/.test(error.message)
    ),
    'fenced confirmed Composer delivery must fail with an explicit zero-write error',
  );

  await assert.rejects(
    manager.sendComposerMessage('agent-composer', 'plain composer'),
    error => (
      error.code === 'TERMINAL_INPUT_UNCERTAIN_FENCE'
      && /fenced after an uncertain write/.test(error.message)
    ),
    'fenced non-persistent Composer delivery must fail explicitly',
  );
}

// 7. System control traffic (identity probe, Codex profile) never crosses the
// fence; the profile admission is captured at the outer request boundary.
async function systemControlTrafficDoesNotCrossTheFence() {
  const manager = createManager();
  const writes = [];
  let failNext = true;
  manager.engineBridge.getEngine = () => ({
    async sendInput(agentId, input) {
      if (failNext) {
        failNext = false;
        throw timeoutError();
      }
      writes.push({ agentId, input });
      return { sent: true };
    },
    async getSessionState() {
      return {
        status: 'running',
        previewText: CODEX_COMPOSER_PREVIEW,
        output: CODEX_COMPOSER_PREVIEW,
        renderOutput: CODEX_COMPOSER_PREVIEW,
      };
    },
  });
  const agent = {
    ...terminalAgent('agent-control', 'epoch-1'),
    providerSessionTemporary: true,
  };
  manager.agents.set('agent-control', agent);

  await manager.sendInput('agent-control', 'x');
  assert.strictEqual(manager.terminalInputFences.get('agent-control')?.active, true);

  // The identity probe aborts without writing provider control traffic.
  const resolved = await manager.resolveProviderTerminalIdentityFromPreview('agent-control', CODEX_COMPOSER_PREVIEW);
  assert.strictEqual(resolved, false, 'a fenced identity probe must abort');
  assert.strictEqual(writes.length, 0);

  // The outer profile request is rejected at its admission boundary.
  await assert.rejects(
    manager.setCodexTerminalProfile('agent-control', { model: 'gpt-5.6-sol', effort: 'xhigh' }),
    error => (
      error.code === 'TERMINAL_INPUT_UNCERTAIN_FENCE'
      && /fenced after an uncertain write/.test(error.message)
    ),
    'a fenced Codex profile request must fail explicitly at admission',
  );
  assert.strictEqual(writes.length, 0);
}

// 8. Queued-profile / timeout / checkpoint race: admission is captured at the
// outer request, so a fence advance (uncertain write then explicit
// reconciliation) between queueing and execution still rejects the profile.
async function queuedProfileRaceUsesAdmissionPhase() {
  const manager = createManager();
  const writes = [];
  manager.engineBridge.getEngine = () => engineWithWrites(writes, { manager });
  manager.agents.set('agent-race', terminalAgent('agent-race', 'epoch-1'));

  // Admit the profile now (phase 0), then advance the fence behind it.
  const admission = manager.captureTerminalInputAdmission('agent-race');
  assert.strictEqual(admission.admissionPhase, 0);
  manager.terminalInputFences.set('agent-race', { phase: 1, active: true, runtimeEpoch: 'epoch-1' });
  manager.releaseTerminalInputFence('agent-race', { runtimeEpoch: 'epoch-1' });
  assert.strictEqual(manager.terminalInputFences.get('agent-race')?.active, false);
  assert.strictEqual(manager.terminalInputFences.get('agent-race')?.phase, 2);

  // A profile admitted at phase 0 must be rejected now that the fence phase
  // advanced to 2, even though the fence is no longer active.
  await assert.rejects(
    manager.setCodexTerminalProfileNow('agent-race', { model: 'gpt-5.6-sol', effort: 'xhigh' }, {
      admission,
      timeoutMs: 250,
    }),
    error => error.code === 'TERMINAL_INPUT_UNCERTAIN_FENCE',
    'a profile admitted before the fence advance must stay rejected',
  );
  assert.strictEqual(writes.length, 0, 'a stale-admission profile must not write');

  // A profile admitted after the reconciliation passes.
  const freshAdmission = manager.captureTerminalInputAdmission('agent-race');
  assert.strictEqual(freshAdmission.admissionPhase, 2);
}

// 9. Reconciliation is idempotent while inactive: repeated explicit
// checkpoints do not invalidate input admitted after the reconciliation.
async function repeatedReconciliationIsIdempotent() {
  const manager = createManager();
  const writes = [];
  manager.engineBridge.getEngine = () => engineWithWrites(writes, { manager });
  manager.agents.set('agent-clean', terminalAgent('agent-clean', 'epoch-1'));

  await manager.sendInput('agent-clean', 'x');
  assert.strictEqual(writes.length, 1);

  // No fence record: reconciliation is a no-op.
  assert.strictEqual(manager.releaseTerminalInputFence('agent-clean', { runtimeEpoch: 'epoch-1' }), false);

  // Establish then clear a fence; repeated reconciliation is idempotent.
  manager.terminalInputFences.set('agent-clean', { phase: 1, active: true, runtimeEpoch: 'epoch-1' });
  assert.strictEqual(manager.releaseTerminalInputFence('agent-clean', { runtimeEpoch: 'epoch-1' }), true);
  const phase = manager.terminalInputFences.get('agent-clean')?.phase;
  manager.releaseTerminalInputFence('agent-clean', { runtimeEpoch: 'epoch-1' });
  assert.strictEqual(manager.terminalInputFences.get('agent-clean')?.phase, phase,
    'repeated reconciliation must not advance the phase while the fence is inactive');
  assert.strictEqual(manager.terminalInputFences.get('agent-clean')?.phase, phase);

  // Input admitted after reconciliation keeps passing.
  assert.deepStrictEqual(await manager.sendInput('agent-clean', 'after'), { sent: true });
  assert.strictEqual(writes.length, 2);
}

// 10. Persistent Composer admission is captured synchronously at request
// time: a request admitted before an uncertain write keeps its immutable
// context even if a checkpoint reconciles the fence before the queued
// delivery runs, and fails with a proven zero-write rejection.
async function persistentComposerAdmissionIsCapturedAtRequestTime() {
  const manager = createManager();
  const writes = [];
  const heldStarted = deferred();
  const releaseHeld = deferred();
  let holdNext = true;
  const engineStub = {
    async sendInput(agentId, input) {
      if (holdNext) {
        holdNext = false;
        heldStarted.resolve();
        await releaseHeld.promise;
        throw timeoutError();
      }
      writes.push({ agentId, input });
      return { sent: true };
    },
  };
  manager.engineBridge.getEngine = () => engineStub;
  const agent = terminalAgent('agent-pc', 'epoch-1');
  manager.agents.set('agent-pc', agent);

  // Hold the queue, then admit a persistent Composer request behind it
  // (admission phase 0 captured synchronously at request time).
  const held = manager.sendInput('agent-pc', 'held');
  await heldStarted.promise;
  const requestPromise = manager.sendPersistentComposerMessage('agent-pc', 'composer text', 'req-1');
  await Promise.resolve();

  // The held write fails uncertain; the fence becomes active before the
  // queued Composer delivery runs.
  releaseHeld.resolve();
  await requestPromise.then(
    () => {
      throw new Error('a pre-timeout Composer request must not be delivered');
    },
    error => {
      assert.ok(
        /fenced after an uncertain write/.test(String(error.message)),
        `expected an explicit fence rejection, got: ${error.message}`,
      );
    },
  );
  await held;
  assert.strictEqual(writes.length, 0, 'a pre-timeout Composer request must be zero-write');

  // Boundary variant: after an explicit reconciliation, a delivery carrying
  // the stale request-time admission is still rejected explicitly.
  assert.strictEqual(manager.releaseTerminalInputFence('agent-pc', { runtimeEpoch: 'epoch-1' }), true);
  await assert.rejects(
    manager.sendComposerMessageNow('agent-pc', 'late delivery', {
      expectedTerminalAgent: agent,
      expectedTerminalRuntimeEpoch: 'epoch-1',
      expectedTerminalAdmissionPhase: 0,
      requireConfirmedTerminalDelivery: true,
    }),
    error => error.code === 'TERMINAL_INPUT_UNCERTAIN_FENCE' && error.composerZeroEffect === true,
    'a stale-admission delivery after reconciliation must fail zero-write',
  );
  assert.strictEqual(writes.length, 0);
}

// 11. A runtime replacement supersedes the old uncertainty: when the old
// write or interrupt times out after the replacement, the fence must not be
// installed on the new runtime.
async function runtimeReplacementIsNotFencedByStaleTimeout() {
  const manager = createManager();
  const writes = [];
  const writeStarted = deferred();
  const releaseWrite = deferred();
  const interruptStarted = deferred();
  const releaseInterrupt = deferred();
  let holdWrite = true;
  let holdInterrupt = false;
  const engineStub = {
    async sendInput(agentId, input, inputOptions: { expectedRuntimeEpoch?: string } = {}) {
      const agent = manager.agents.get(agentId);
      if (
        typeof inputOptions.expectedRuntimeEpoch === 'string'
        && inputOptions.expectedRuntimeEpoch
        && agent
        && inputOptions.expectedRuntimeEpoch !== agent.runtimeEpoch
      ) {
        return { status: 'input-rejected', reason: 'runtime-epoch-mismatch' };
      }
      if (holdWrite) {
        holdWrite = false;
        writeStarted.resolve();
        await releaseWrite.promise;
        throw timeoutError();
      }
      if (holdInterrupt) {
        holdInterrupt = false;
        interruptStarted.resolve();
        await releaseInterrupt.promise;
        throw timeoutError();
      }
      writes.push({ agentId, input });
      return { sent: true };
    },
  };
  manager.engineBridge.getEngine = () => engineStub;
  manager.agents.set('agent-replace', terminalAgent('agent-replace', 'epoch-1'));

  // The write is in flight under epoch-1; the runtime is replaced; the old
  // write then times out. The replacement must stay unfenced.
  const first = manager.sendInput('agent-replace', 'one');
  await writeStarted.promise;
  manager.agents.get('agent-replace').runtimeEpoch = 'epoch-2';
  releaseWrite.resolve();
  await first;
  assert.strictEqual(
    manager.terminalInputFences.has('agent-replace'),
    false,
    'a stale write timeout must not fence the replacement runtime',
  );
  assert.deepStrictEqual(await manager.sendInput('agent-replace', 'two'), { sent: true });
  assert.strictEqual(writes.length, 1);

  // Same contract for interrupts: an in-flight interrupt that times out
  // after the replacement does not fence the replacement.
  holdInterrupt = true;
  const interrupt = manager.interruptAgent('agent-replace');
  await interruptStarted.promise;
  manager.agents.get('agent-replace').runtimeEpoch = 'epoch-3';
  releaseInterrupt.resolve();
  // The uncertain outcome stays visible through the thrown failure, but the
  // replacement runtime must not be fenced.
  await assert.rejects(
    interrupt,
    error => error.code === 'TERMINAL_INPUT_UNCONFIRMED' && error.uncertain === true,
  );
  assert.strictEqual(
    manager.terminalInputFences.has('agent-replace'),
    false,
    'a stale interrupt timeout must not fence the replacement runtime',
  );
  assert.deepStrictEqual(await manager.interruptAgent('agent-replace'), { sent: true });
  assert.strictEqual(writes.length, 2);
}

// 12. Definitive host rejections (no uncertainty marker) are proven
// zero-write: they never fence, never report uncertainty, and stay visible
// as explicit rejections on every direct PTY write path.
async function definitiveRejectionsStayZeroWrite() {
  const manager = createManager();
  const writes = [];
  let failNextDefinitive = false;
  const engineStub = {
    async sendInput(agentId, input) {
      if (failNextDefinitive) {
        failNextDefinitive = false;
        throw definitiveHostRejectionError();
      }
      writes.push({ agentId, input });
      return { sent: true };
    },
  };
  manager.engineBridge.getEngine = () => engineStub;
  const agent = terminalAgent('agent-definitive', 'epoch-1');
  manager.agents.set('agent-definitive', agent);

  // Raw input: definitive rejection result, no fence, next input passes.
  failNextDefinitive = true;
  assert.deepStrictEqual(
    await manager.sendInput('agent-definitive', 'x'),
    { status: 'input-rejected', reason: 'terminal-write-rejected' },
  );
  assert.strictEqual(manager.terminalInputFences.has('agent-definitive'), false,
    'a definitive rejection must not fence');
  assert.deepStrictEqual(await manager.sendInput('agent-definitive', 'y'), { sent: true });
  assert.strictEqual(writes.length, 1);

  // Interrupt: visible typed zero-write rejection, no fence.
  failNextDefinitive = true;
  await assert.rejects(
    manager.interruptAgent('agent-definitive'),
    error => error.code === 'TERMINAL_INPUT_WRITE_REJECTED' && /not sent/.test(error.message),
    'a definitive interrupt rejection must be visibly typed',
  );
  assert.strictEqual(manager.terminalInputFences.has('agent-definitive'), false);
  assert.strictEqual(writes.length, 1);

  // Persistent Composer: definitive zero-effect failure, not uncertain.
  failNextDefinitive = true;
  await assert.rejects(
    manager.sendComposerMessageNow('agent-definitive', 'composer', {
      expectedTerminalAgent: agent,
      expectedTerminalRuntimeEpoch: 'epoch-1',
      requireConfirmedTerminalDelivery: true,
    }),
    error => (
      error.code === 'TERMINAL_INPUT_WRITE_REJECTED'
      && error.composerZeroEffect === true
      && /not sent/.test(error.message)
    ),
    'a definitive rejection must be a proven zero-effect Composer failure',
  );
  assert.strictEqual(writes.length, 1);
}

async function run() {
  await preTimeoutQueuedInputNeverPasses();
  await onlyExactAuthoritativeCheckpointReconciles();
  await epochAdvanceRejectsStaleQueuedInput();
  await provenSessionLossDoesNotFence();
  await interruptHonorsAndSetsTheFence();
  await composerDeliveryIsExplicitlyRejectedWhileFenced();
  await systemControlTrafficDoesNotCrossTheFence();
  await queuedProfileRaceUsesAdmissionPhase();
  await repeatedReconciliationIsIdempotent();
  await persistentComposerAdmissionIsCapturedAtRequestTime();
  await runtimeReplacementIsNotFencedByStaleTimeout();
  await definitiveRejectionsStayZeroWrite();
}

run().then(() => {
  console.log('terminal uncertain-input fence tests passed');
  process.exit(0);
}).catch(error => {
  console.error(error);
  process.exit(1);
});
