const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { AcpRuntime } = require('../acp-runtime.cts');
const { AgentManager } = require('../agent-manager.cts');
const { ConfigManager } = require('../config-manager.cts');

interface ComposerTestAgent {
  acpFinalizedTurnHandle?: string;
  attentionAutoReadNext?: boolean;
  attentionSummary?: string;
  attentionSeq?: number;
  composerCommands?: Array<Record<string, unknown>>;
  id: string;
  command: string;
  forkCommand: string;
  cwd: string;
  projectWorkspace: string;
  status: string;
  engineName: string;
  category: string;
  source: string;
  providerSessionProvider: string;
  providerHomeId: string;
  providerSessionId: string;
  providerSessionKey: string;
  providerSessionTemporary: boolean;
  runtimeBinding: { kind: string; state: string };
  persistentSessionId?: string;
  agentRecordId?: string;
}

async function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-composer-admission-'));
  const configManager = new ConfigManager({ configDir: root });
  configManager.init();
  const runtime = new AcpRuntime();
  (runtime as { turnCompletionEvents: boolean }).turnCompletionEvents = true;
  runtime.hasBinding = () => true;
  let submitCount = 0;
  let releaseTurn = () => {};
  let releaseSubmission = () => {};
  let holdSubmission = false;
  let rejectBeforeSubmission = false;
  let rejectUncertainBeforeSubmission = false;
  const submittedPromptIds: string[] = [];
  let reconnectRequired = false;
  let reconnectCount = 0;
  runtime.reconnectAgent = async () => {
    if (!reconnectRequired) return { reconnected: false };
    reconnectRequired = false;
    reconnectCount += 1;
    return { reconnected: true };
  };
  runtime.submitMessage = async (
    _agentId,
    _prompt,
    options: { clientPromptId?: string; onSubmitted?: () => void } = {},
  ) => {
    submitCount += 1;
    submittedPromptIds.push(String(options.clientPromptId || ''));
    if (rejectUncertainBeforeSubmission) {
      const error = new Error('simulated ACP Host transport loss') as Error & { uncertain?: boolean };
      error.uncertain = true;
      throw error;
    }
    if (rejectBeforeSubmission) {
      reconnectRequired = true;
      throw new Error('simulated ACP connection closed before admission');
    }
    if (holdSubmission) {
      await new Promise<void>(resolve => {
        releaseSubmission = resolve;
      });
    }
    options.onSubmitted?.();
    await new Promise<void>(resolve => {
      releaseTurn = resolve;
    });
    return { stopReason: 'end_turn' };
  };
  runtime.getTranscriptSessionForRead = async () => ({
    sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    entries: [{ type: 'message', role: 'assistant', content: [{ type: 'text', text: 'Recovered final answer' }] }],
  });
  const manager = new AgentManager(configManager, {
    acpRuntime: runtime,
  });
  try {
    await manager.whenRecovered();
    const agent: ComposerTestAgent = {
      id: 'agent-composer-admission',
      command: 'claude',
      forkCommand: 'claude',
      cwd: root,
      projectWorkspace: root,
      status: 'running',
      engineName: 'native',
      category: 'coding',
      source: 'ui',
      providerSessionProvider: 'claude',
      providerHomeId: 'default',
      providerSessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      providerSessionKey: 'agent-session:claude:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      providerSessionTemporary: false,
      runtimeBinding: { kind: 'acp', state: 'idle' },
    };
    agent.persistentSessionId = configManager.ensureAgentSessionRecord(agent, { archived: false });
    agent.agentRecordId = agent.persistentSessionId;
    manager.agents.set(agent.id, agent);

    const accepted = await manager.sendComposerMessage(agent.id, 'persist this once', {
      requestId: 'composer-request-1',
    });
    assert.strictEqual(accepted.accepted, true);
    assert.strictEqual(submitCount, 1);
    const persistedAccepted = configManager.sessionStore.readRecord(agent.persistentSessionId)
      .composerCommands.find(command => command.requestId === 'composer-request-1');
    assert.strictEqual(persistedAccepted.state, 'accepted');
    const replayed = await manager.sendComposerMessage(agent.id, 'persist this once', {
      requestId: 'composer-request-1',
    });
    assert.strictEqual(replayed.deduplicated, true);
    assert.strictEqual(submitCount, 1, 'a lost response retry must not submit a second ACP prompt');
    await assert.rejects(
      () => manager.sendComposerMessage(agent.id, 'different content', { requestId: 'composer-request-1' }),
      /different content/,
    );
    releaseTurn();

    holdSubmission = true;
    const concurrentOne = manager.sendComposerMessage(agent.id, 'join concurrent delivery', {
      requestId: 'composer-request-concurrent',
    });
    await new Promise(resolve => setImmediate(resolve));
    const concurrentTwo = manager.sendComposerMessage(agent.id, 'join concurrent delivery', {
      requestId: 'composer-request-concurrent',
    });
    releaseSubmission();
    const [concurrentAcceptedOne, concurrentAcceptedTwo] = await Promise.all([concurrentOne, concurrentTwo]);
    assert.strictEqual(concurrentAcceptedOne.accepted, true);
    assert.strictEqual(concurrentAcceptedTwo.accepted, true);
    assert.strictEqual(submitCount, 2, 'concurrent delivery of one Composer request must join one provider submission');
    holdSubmission = false;
    releaseTurn();

    const ensureAgentSessionRecord = configManager.ensureAgentSessionRecord.bind(configManager);
    configManager.ensureAgentSessionRecord = (candidate, patch) => {
      const command = candidate.composerCommands?.find(item => item.requestId === 'composer-request-2');
      if (command?.state === 'accepted') {
        throw new Error('simulated accepted admission write failure');
      }
      return ensureAgentSessionRecord(candidate, patch);
    };
    await assert.rejects(
      () => manager.sendComposerMessage(agent.id, 'uncertain admission', { requestId: 'composer-request-2' }),
      error => error?.uncertain === true && /accepted admission write failure/.test(error.message),
    );
    assert.strictEqual(submitCount, 3);
    configManager.ensureAgentSessionRecord = ensureAgentSessionRecord;
    await assert.rejects(
      () => manager.sendComposerMessage(agent.id, 'uncertain admission', { requestId: 'composer-request-2' }),
      error => error?.uncertain === true && /admission could not be saved/.test(error.message),
    );
    assert.strictEqual(submitCount, 3, 'UNKNOWN admission must never replay automatically');
    const persistedIntent = configManager.sessionStore.readRecord(agent.persistentSessionId)
      .composerCommands.find(command => command.requestId === 'composer-request-2');
    assert.strictEqual(persistedIntent.state, 'intent', 'the crash-safe disk state remains conservative when accepted persistence fails');
    releaseTurn();

    rejectUncertainBeforeSubmission = true;
    await assert.rejects(
      () => manager.sendComposerMessage(agent.id, 'host crash admission window', {
        requestId: 'composer-request-host-crash',
      }),
      error => error?.uncertain === true,
    );
    assert.strictEqual(submittedPromptIds.at(-1), 'composer-request-host-crash');
    const hostCrashUnknown = configManager.sessionStore.readRecord(agent.persistentSessionId)
      .composerCommands.find(command => command.requestId === 'composer-request-host-crash');
    assert.strictEqual(hostCrashUnknown.state, 'unknown');
    const submitCountAfterHostCrash = submitCount;
    await assert.rejects(
      () => manager.sendComposerMessage(agent.id, 'host crash admission window', {
        requestId: 'composer-request-host-crash',
      }),
      error => error?.uncertain === true,
    );
    assert.strictEqual(submitCount, submitCountAfterHostCrash, 'Host transport UNKNOWN must never replay the ACP prompt');
    rejectUncertainBeforeSubmission = false;

    rejectBeforeSubmission = true;
    await assert.rejects(
      () => manager.sendComposerMessage(agent.id, 'retry after reconnect', {
        requestId: 'composer-request-reconnect',
      }),
      /connection closed before admission/,
    );
    const persistedFailure = configManager.sessionStore.readRecord(agent.persistentSessionId)
      .composerCommands.find(command => command.requestId === 'composer-request-reconnect');
    assert.strictEqual(persistedFailure.state, 'failed');
    rejectBeforeSubmission = false;
    const retriedAfterReconnect = await manager.sendComposerMessage(agent.id, 'retry after reconnect', {
      requestId: 'composer-request-reconnect',
    });
    assert.strictEqual(retriedAfterReconnect.accepted, true);
    assert.strictEqual(reconnectCount, 1, 'a definitive failed retry must reconnect before provider admission');
    assert.strictEqual(submitCount, 6, 'the failed attempt and explicit retry should each submit at most once');
    releaseTurn();

    const originalBindingEpoch = runtime.bindingEpoch.bind(runtime);
    const fakeReconnectAgent = runtime.reconnectAgent;
    let hostBindingEpoch = 'host-binding-1';
    runtime.bindingEpoch = () => hostBindingEpoch;
    runtime.reconnectAgent = async () => {
      hostBindingEpoch = 'host-binding-2';
      agent.runtimeBinding = { ...agent.runtimeBinding };
      return { reconnected: true };
    };
    const acceptedAfterHostRecovery = await manager.sendComposerMessage(agent.id, 'accept after Host recovery', {
      requestId: 'composer-request-host-recovery',
    });
    assert.strictEqual(acceptedAfterHostRecovery.accepted, true);
    assert.strictEqual(
      configManager.sessionStore.readRecord(agent.persistentSessionId)
        .composerCommands.find(command => command.requestId === 'composer-request-host-recovery').state,
      'accepted',
      'Host recovery on the exact Agent record must not be judged a cross-runtime ownership change',
    );
    runtime.bindingEpoch = originalBindingEpoch;
    runtime.reconnectAgent = fakeReconnectAgent;
    releaseTurn();

    await Promise.all([...manager.acpTurnFinalizationTails.values()]);
    const attentionBeforeRapidTurns = Number(agent.attentionSeq || 0);
    const finalizedHandleBeforeRapidTurns = agent.acpFinalizedTurnHandle || '';
    const productionStateWriter = configManager.sessionStore.writeJsonAsync.bind(configManager.sessionStore);
    let releaseFinalizationWrite: () => void = () => {};
    const finalizationWriteGate = new Promise<void>(resolve => {
      releaseFinalizationWrite = resolve;
    });
    let observeFinalizationWrite: () => void = () => {};
    const finalizationWriteStarted = new Promise<void>(resolve => {
      observeFinalizationWrite = resolve;
    });
    let gateFinalizationWrite = true;
    let postCommitInjectionStep = 0;
    let finalizationStateWriteCount = 0;
    const finalizationStateFileSuffix = `${path.sep}${agent.persistentSessionId}.state.json`;
    configManager.sessionStore.writeJsonAsync = async (file, value, options) => {
      if (!String(file).endsWith(finalizationStateFileSuffix)) {
        return productionStateWriter(file, value, options);
      }
      finalizationStateWriteCount += 1;
      if (gateFinalizationWrite) {
        gateFinalizationWrite = false;
        observeFinalizationWrite();
        await finalizationWriteGate;
      }
      const committed = await productionStateWriter(file, value, options);
      if (committed && postCommitInjectionStep === 0) {
        postCommitInjectionStep = 1;
        agent.composerCommands = [
          ...(agent.composerCommands || []),
          {
            contentHash: 'post-commit-race',
            createdAt: 1,
            error: '',
            requestId: 'post-commit-race',
            result: null,
            state: 'accepted',
            updatedAt: 1,
          },
        ];
        configManager.sessionStore.ensureRecordForAgent(agent);
      } else if (committed && postCommitInjectionStep === 1) {
        postCommitInjectionStep = 2;
        agent.attentionAutoReadNext = true;
      }
      return committed;
    };
    runtime.emit('agent-runtime', {
      agentId: agent.id,
      sessionId: agent.providerSessionId,
      state: 'working',
      stopReason: 'end_turn',
      lastSettledTurnHandle: 'binding-1:1',
      lastSettledTurnSummary: 'First exact summary',
    });
    await finalizationWriteStarted;
    let finalizationDrainResolved = false;
    const finalizationDrain = manager.drainAcceptedAgentOperations().then(() => {
      finalizationDrainResolved = true;
    });
    await new Promise(resolve => setImmediate(resolve));
    assert.strictEqual(
      finalizationDrainResolved,
      false,
      'shutdown drain must wait for an accepted Turn finalization state commit',
    );
    releaseFinalizationWrite();
    assert.strictEqual(
      agent.acpFinalizedTurnHandle || '',
      finalizedHandleBeforeRapidTurns,
      'an in-flight durable Turn must not expose its finalized handle early',
    );
    assert.strictEqual(
      Number(agent.attentionSeq || 0),
      attentionBeforeRapidTurns,
      'an in-flight durable Turn must not expose unread attention early',
    );
    await finalizationDrain;
    runtime.emit('agent-runtime', {
      agentId: agent.id,
      sessionId: agent.providerSessionId,
      state: 'idle',
      stopReason: 'end_turn',
      lastSettledTurnHandle: 'binding-1:2',
      lastSettledTurnSummary: 'Second exact summary',
    });
    await new Promise(resolve => setImmediate(resolve));
    assert.strictEqual(manager.acpFinalizedTurns.get(agent.id), 'binding-1:2');
    await Promise.allSettled([...manager.acpTurnFinalizationTails.values()]);
    assert.strictEqual(agent.acpFinalizedTurnHandle, 'binding-1:2');
    assert.strictEqual(agent.attentionSummary, 'Second exact summary');
    assert.strictEqual(agent.attentionSeq, attentionBeforeRapidTurns + 2);
    assert.strictEqual(
      finalizationStateWriteCount,
      4,
      'post-rename disk and live mutations must each force the first Turn to re-stage before the next Turn commits',
    );
    assert.strictEqual(agent.attentionAutoReadNext, false, 'the re-staged Turn must consume the newer auto-read intent');
    const finalizedAttentionSeq = agent.attentionSeq;
    const finalizedRecord = configManager.sessionStore.readRecord(agent.persistentSessionId);
    assert.strictEqual(finalizedRecord.acpFinalizedTurnHandle, 'binding-1:2');
    assert.strictEqual(finalizedRecord.acpStopReason, 'end_turn');
    assert(
      finalizedRecord.composerCommands.some(command => command.requestId === 'post-commit-race'),
      'a full state write after rename must survive the retried scoped finalization patch',
    );
    configManager.sessionStore.writeJsonAsync = productionStateWriter;
    runtime.emit('agent-runtime', {
      agentId: agent.id,
      sessionId: agent.providerSessionId,
      state: 'idle',
      stopReason: 'max_tokens',
      lastSettledTurnHandle: 'binding-1:1',
      lastSettledTurnSummary: 'Stale first summary',
    });
    runtime.emit('agent-runtime', {
      agentId: agent.id,
      sessionId: agent.providerSessionId,
      state: 'idle',
      stopReason: 'end_turn',
      lastSettledTurnHandle: 'binding-1:2',
      lastSettledTurnSummary: 'Second exact summary',
    });
    await Promise.allSettled([...manager.acpTurnFinalizationTails.values()]);
    assert.strictEqual(agent.acpFinalizedTurnHandle, 'binding-1:2');
    assert.strictEqual(agent.attentionSummary, 'Second exact summary');
    assert.strictEqual(agent.attentionSeq, finalizedAttentionSeq, 'stale or duplicate settled Turns must not increment attention');

    const originalConflictPersist = configManager.persistAgentStatePatch.bind(configManager);
    const originalConflictEnsure = configManager.ensureAgentSessionRecord.bind(configManager);
    let postCommitLiveConflicts = 0;
    let boundedConflictFallbacks = 0;
    configManager.persistAgentStatePatch = async (candidate, patch, options) => {
      const result = await originalConflictPersist(candidate, patch, options);
      if (patch.acpFinalizedTurnHandle === 'binding-1:3' && result.status === 'committed') {
        postCommitLiveConflicts += 1;
        agent.attentionAutoReadNext = agent.attentionAutoReadNext !== true;
      }
      return result;
    };
    configManager.ensureAgentSessionRecord = (candidate, patch) => {
      if (candidate.acpFinalizedTurnHandle === 'binding-1:3') boundedConflictFallbacks += 1;
      return originalConflictEnsure(candidate, patch);
    };
    runtime.emit('agent-runtime', {
      agentId: agent.id,
      sessionId: agent.providerSessionId,
      state: 'idle',
      stopReason: 'end_turn',
      lastSettledTurnHandle: 'binding-1:3',
      lastSettledTurnSummary: 'Conflict fallback summary',
    });
    await Promise.allSettled([...manager.acpTurnFinalizationTails.values()]);
    assert.strictEqual(postCommitLiveConflicts, 8);
    assert.strictEqual(boundedConflictFallbacks, 1);
    assert.strictEqual(agent.acpFinalizedTurnHandle, 'binding-1:3');
    assert.strictEqual(agent.attentionSummary, 'Conflict fallback summary');
    assert.strictEqual(agent.attentionSeq, finalizedAttentionSeq + 1);
    assert.strictEqual(
      configManager.sessionStore.readRecord(agent.persistentSessionId).acpFinalizedTurnHandle,
      'binding-1:3',
      'retry exhaustion must converge disk and live state through the bounded synchronous fallback',
    );
    configManager.persistAgentStatePatch = originalConflictPersist;
    configManager.ensureAgentSessionRecord = originalConflictEnsure;
    const attentionAfterConflictFallback = agent.attentionSeq;

    const originalPersistFinalization = configManager.persistAgentStatePatch.bind(configManager);
    const originalEnsureFinalization = configManager.ensureAgentSessionRecord.bind(configManager);
    let unexpectedCompatibilityFallbacks = 0;
    configManager.ensureAgentSessionRecord = (candidate, patch) => {
      unexpectedCompatibilityFallbacks += 1;
      return originalEnsureFinalization(candidate, patch);
    };
    let failFinalizationPersistence = true;
    configManager.persistAgentStatePatch = async (candidate, patch, options) => {
      if (failFinalizationPersistence && patch.acpFinalizedTurnHandle === 'binding-1:4') {
        return { status: 'record-missing' } as const;
      }
      return originalPersistFinalization(candidate, patch, options);
    };
    runtime.emit('agent-runtime', {
      agentId: agent.id,
      sessionId: agent.providerSessionId,
      state: 'idle',
      stopReason: 'end_turn',
      lastSettledTurnHandle: 'binding-1:4',
      lastSettledTurnSummary: 'Fourth exact summary',
    });
    await Promise.allSettled([...manager.acpTurnFinalizationTails.values()]);
    assert.strictEqual(agent.acpFinalizedTurnHandle, 'binding-1:3');
    assert.strictEqual(agent.attentionSummary, 'Conflict fallback summary');
    assert.strictEqual(agent.attentionSeq, attentionAfterConflictFallback);
    assert.strictEqual(
      configManager.sessionStore.readRecord(agent.persistentSessionId).acpFinalizedTurnHandle,
      'binding-1:3',
    );
    assert.strictEqual(
      unexpectedCompatibilityFallbacks,
      0,
      'a missing indexed record must fail instead of falling back to a full synchronous rewrite',
    );
    failFinalizationPersistence = false;
    runtime.emit('agent-runtime', {
      agentId: agent.id,
      sessionId: agent.providerSessionId,
      state: 'idle',
      stopReason: 'end_turn',
      lastSettledTurnHandle: 'binding-1:4',
      lastSettledTurnSummary: 'Fourth exact summary',
    });
    await Promise.allSettled([...manager.acpTurnFinalizationTails.values()]);
    assert.strictEqual(agent.acpFinalizedTurnHandle, 'binding-1:4');
    assert.strictEqual(agent.attentionSummary, 'Fourth exact summary');
    assert.strictEqual(agent.attentionSeq, attentionAfterConflictFallback + 1);
    assert.strictEqual(
      configManager.sessionStore.readRecord(agent.persistentSessionId).acpFinalizedTurnHandle,
      'binding-1:4',
    );
    configManager.persistAgentStatePatch = originalPersistFinalization;
    configManager.ensureAgentSessionRecord = originalEnsureFinalization;
    manager.acpFinalizedTurns.clear();
    runtime.emit('agent-runtime', {
      agentId: agent.id,
      sessionId: agent.providerSessionId,
      state: 'idle',
      stopReason: 'end_turn',
      lastSettledTurnHandle: 'binding-1:4',
      lastSettledTurnSummary: 'Fourth exact summary',
    });
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.strictEqual(
      agent.attentionSeq,
      attentionAfterConflictFallback + 1,
      'persisted finalized handle must fence restart replay',
    );

    console.log('test-composer-admission-idempotency passed');
  } finally {
    releaseTurn();
    releaseSubmission();
    await manager.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
