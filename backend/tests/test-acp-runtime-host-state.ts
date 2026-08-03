const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { AcpRuntimeHostState } = require('../acp-runtime-host-state.cts');
const { allocateAcpRuntimeHostControllerGeneration } = require('../acp-runtime-host-controller.cts');
const { acpRuntimeHostSocketPath } = require('../acp-runtime-host-path.cts');

async function main() {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-acp-runtime-host-state-'));
  try {
    fs.mkdirSync(path.join(configDir, '.acp-runtime-host-controller-generation.lock.candidate.dead'));
    const generations = await Promise.all([
      allocateAcpRuntimeHostControllerGeneration(configDir),
      allocateAcpRuntimeHostControllerGeneration(configDir),
    ]);
    assert.deepStrictEqual(generations.sort((left, right) => left - right), [1, 2]);
    assert.notStrictEqual(
      acpRuntimeHostSocketPath(configDir),
      acpRuntimeHostSocketPath(`${configDir}-other`),
      'config instances must not share an ACP runtime host socket',
    );
  } finally {
    fs.rmSync(configDir, { recursive: true, force: true });
  }

  const lockedConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-acp-runtime-live-lock-'));
  try {
    const lockDir = path.join(lockedConfigDir, '.acp-runtime-host-controller-generation.lock');
    fs.mkdirSync(lockDir);
    fs.writeFileSync(
      path.join(lockDir, 'owner.json'),
      JSON.stringify({ nonce: 'live-owner', pid: process.pid, createdAt: 1 }),
    );
    const old = new Date(Date.now() - 60000);
    fs.utimesSync(lockDir, old, old);
    await assert.rejects(
      allocateAcpRuntimeHostControllerGeneration(lockedConfigDir, {
        staleLockMs: 1,
        lockTimeoutMs: 30,
      }),
      /Timed out/,
      'an old lock owned by a live process must never be reclaimed',
    );
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(lockDir, 'owner.json'))).nonce, 'live-owner');
  } finally {
    fs.rmSync(lockedConfigDir, { recursive: true, force: true });
  }

  const ownerlessConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-acp-runtime-ownerless-lock-'));
  try {
    const ownerlessLock = path.join(ownerlessConfigDir, '.acp-runtime-host-controller-generation.lock');
    fs.mkdirSync(ownerlessLock);
    const old = new Date(Date.now() - 60000);
    fs.utimesSync(ownerlessLock, old, old);
    assert.strictEqual(await allocateAcpRuntimeHostControllerGeneration(ownerlessConfigDir, {
      staleLockMs: 1,
      lockTimeoutMs: 1000,
    }), 1);
  } finally {
    fs.rmSync(ownerlessConfigDir, { recursive: true, force: true });
  }

  const host = new AcpRuntimeHostState({ hostEpoch: 'host-1', maxEvents: 4 });
  const firstController = { id: 'server-a', generation: 1 };
  const secondController = { id: 'server-b', generation: 2 };

  await host.registerController(firstController);
  host.upsertBinding({
    agentId: 'agent-1',
    bindingEpoch: 'binding-1',
    sessionId: 'session-1',
    state: 'idle',
  });

  let promptCalls = 0;
  let finishPrompt;
  const providerPrompt = new Promise(resolve => {
    finishPrompt = resolve;
  });
  const firstPrompt = host.submitPrompt(firstController, {
    agentId: 'agent-1',
    bindingEpoch: 'binding-1',
    clientPromptId: 'prompt-1',
    contentHash: 'hash-1',
  }, (onTurnAdmitted, onSubmitted) => {
    promptCalls += 1;
    onTurnAdmitted({ previousState: 'idle' });
    onSubmitted();
    return providerPrompt;
  });

  await new Promise(resolve => setImmediate(resolve));
  const active = host.promptOperation('agent-1', 'prompt-1');
  assert.strictEqual(active.status, 'provider-owned');
  assert.strictEqual(active.turnHandle, 'binding-1:1');
  assert.strictEqual(host.binding('agent-1').state, 'working');

  host.disconnectController(firstController);
  await assert.rejects(
    host.registerController(firstController),
    /Stale ACP runtime host controller/,
    'a disconnected controller generation must not regain mutation authority',
  );
  await host.registerController(secondController);
  const joinedPrompt = host.submitPrompt(secondController, {
    agentId: 'agent-1',
    bindingEpoch: 'binding-1',
    clientPromptId: 'prompt-1',
    contentHash: 'hash-1',
  }, (_turnHandle, onSubmitted) => {
    promptCalls += 1;
    onSubmitted();
    return { stopReason: 'replayed' };
  });
  finishPrompt({ stopReason: 'end_turn' });
  const [firstResult, joinedResult] = await Promise.all([firstPrompt, joinedPrompt]);
  assert.strictEqual(firstResult.stopReason, 'end_turn');
  assert.strictEqual(joinedResult.stopReason, 'end_turn');
  assert.strictEqual(promptCalls, 1);
  assert.strictEqual(host.binding('agent-1').state, 'idle');

  host.upsertBinding({ agentId: 'agent-retry', bindingEpoch: 'retry-1', state: 'idle' });
  await assert.rejects(
    host.submitPrompt(secondController, {
      agentId: 'agent-retry',
      bindingEpoch: 'retry-1',
      clientPromptId: 'retry-prompt',
      contentHash: 'retry-hash',
    }, () => {
      throw new Error('definite pre-admission failure');
    }),
    /definite pre-admission failure/,
  );
  host.upsertBinding({ agentId: 'agent-retry', bindingEpoch: 'retry-2', state: 'idle' });
  let definitiveRetryCalls = 0;
  const definitiveRetry = await host.submitPrompt(secondController, {
    agentId: 'agent-retry',
    bindingEpoch: 'retry-2',
    clientPromptId: 'retry-prompt',
    contentHash: 'retry-hash',
    retryDefinitiveFailure: true,
  }, (_turnHandle, onSubmitted) => {
    definitiveRetryCalls += 1;
    onSubmitted();
    return { stopReason: 'end_turn' };
  });
  assert.strictEqual(definitiveRetry.stopReason, 'end_turn');
  assert.strictEqual(definitiveRetryCalls, 1);

  host.upsertBinding({ agentId: 'agent-unknown', bindingEpoch: 'unknown-1', state: 'idle' });
  const uncertainError = Object.assign(new Error('uncertain pre-admission failure'), { uncertain: true });
  await assert.rejects(
    host.submitPrompt(secondController, {
      agentId: 'agent-unknown',
      bindingEpoch: 'unknown-1',
      clientPromptId: 'unknown-prompt',
      contentHash: 'unknown-hash',
    }, () => { throw uncertainError; }),
    /uncertain pre-admission failure/,
  );
  host.upsertBinding({ agentId: 'agent-unknown', bindingEpoch: 'unknown-2', state: 'idle' });
  let uncertainRetryCalls = 0;
  await assert.rejects(
    host.submitPrompt(secondController, {
      agentId: 'agent-unknown',
      bindingEpoch: 'unknown-2',
      clientPromptId: 'unknown-prompt',
      contentHash: 'unknown-hash',
      retryDefinitiveFailure: true,
    }, () => {
      uncertainRetryCalls += 1;
      return { stopReason: 'wrong' };
    }),
    /binding epoch changed|uncertain pre-admission failure/,
  );
  assert.strictEqual(uncertainRetryCalls, 0, 'uncertain prompt evidence must never replay');

  const boundedHost = new AcpRuntimeHostState({
    hostEpoch: 'host-bounded',
    maxSettledOperationsPerAgent: 8,
    maxSettledOperations: 64,
  });
  await boundedHost.registerController(firstController);
  for (let index = 0; index < 100; index += 1) {
    const agentId = `bounded-agent-${index}`;
    const bindingEpoch = `bounded-binding-${index}`;
    boundedHost.upsertBinding({ agentId, bindingEpoch, state: 'idle' });
    await boundedHost.submitPrompt(firstController, {
      agentId,
      bindingEpoch,
      clientPromptId: `bounded-prompt-${index}`,
      contentHash: `bounded-hash-${index}`,
    }, (_turnHandle, onSubmitted) => {
      onSubmitted();
      return { stopReason: 'end_turn' };
    });
  }
  assert.strictEqual(boundedHost.promptOperations.size, 64);
  assert.strictEqual(boundedHost.recover().promptOperations.length, 64);

  const recovered = host.recover();
  assert.strictEqual(recovered.hostEpoch, 'host-1');
  assert.strictEqual(recovered.replace, true);
  assert.strictEqual(recovered.bindings[0].state, 'idle');
  assert.strictEqual(recovered.promptOperations[0].status, 'settled');

  const duplicate = await host.submitPrompt(secondController, {
    agentId: 'agent-1',
    bindingEpoch: 'binding-1',
    clientPromptId: 'prompt-1',
    contentHash: 'hash-1',
  }, () => {
    promptCalls += 1;
    return { stopReason: 'duplicate' };
  });
  assert.strictEqual(duplicate.stopReason, 'end_turn');
  assert.strictEqual(promptCalls, 1, 'a recovered prompt must never be replayed');

  host.upsertBinding({
    agentId: 'agent-1',
    bindingEpoch: 'binding-new',
    sessionId: 'session-new',
    state: 'idle',
  });
  await assert.rejects(
    host.submitPrompt(secondController, {
      agentId: 'agent-1',
      bindingEpoch: 'binding-new',
      clientPromptId: 'prompt-1',
      contentHash: 'hash-1',
    }, () => ({ stopReason: 'wrong-binding' })),
    /binding epoch changed/,
    'a prompt identity from an old binding must not be reused',
  );
  host.upsertBinding({
    agentId: 'agent-1',
    bindingEpoch: 'binding-1',
    sessionId: 'session-1',
    state: 'idle',
  });

  await assert.rejects(
    host.submitPrompt(secondController, {
      agentId: 'agent-1',
      bindingEpoch: 'binding-1',
      clientPromptId: 'prompt-1',
      contentHash: 'different-hash',
    }, () => ({ stopReason: 'wrong' })),
    /different content/,
  );

  await assert.rejects(
    host.submitPrompt(firstController, {
      agentId: 'agent-1',
      bindingEpoch: 'binding-1',
      clientPromptId: 'stale-controller',
      contentHash: 'hash-2',
    }, () => ({ stopReason: 'wrong' })),
    /Stale ACP runtime host controller/,
  );

  let cancelCalls = 0;
  let finishSecondPrompt;
  const secondProviderPrompt = new Promise(resolve => {
    finishSecondPrompt = resolve;
  });
  const secondPrompt = host.submitPrompt(secondController, {
    agentId: 'agent-1',
    bindingEpoch: 'binding-1',
    clientPromptId: 'prompt-2',
    contentHash: 'hash-2',
  }, (_turnHandle, onSubmitted) => {
    onSubmitted();
    return secondProviderPrompt;
  });
  await new Promise(resolve => setImmediate(resolve));
  const secondTurn = host.promptOperation('agent-1', 'prompt-2').turnHandle;
  const cancelled = await host.cancelTurn(secondController, {
    agentId: 'agent-1',
    bindingEpoch: 'binding-1',
    operationId: 'cancel-1',
    turnHandle: secondTurn,
  }, () => {
    cancelCalls += 1;
    return { cancelled: true };
  });
  assert.deepStrictEqual(cancelled, { cancelled: true });
  await host.cancelTurn(secondController, {
    agentId: 'agent-1',
    bindingEpoch: 'binding-1',
    operationId: 'cancel-1',
    turnHandle: secondTurn,
  }, () => {
    cancelCalls += 1;
    return { cancelled: false };
  });
  assert.strictEqual(cancelCalls, 1, 'cancel retries must join the admitted mutation');
  finishSecondPrompt({ stopReason: 'cancelled' });
  await secondPrompt;
  await host.cancelTurn(secondController, {
    agentId: 'agent-1',
    bindingEpoch: 'binding-1',
    operationId: 'cancel-1',
    turnHandle: secondTurn,
  }, () => {
    cancelCalls += 1;
    return { cancelled: false };
  });
  assert.strictEqual(cancelCalls, 1, 'a settled cancel result must survive later Turn settlement');

  let admitPrompt;
  let finishAdmissionPrompt;
  const admissionPrompt = host.submitPrompt(secondController, {
    agentId: 'agent-1',
    bindingEpoch: 'binding-1',
    clientPromptId: 'prompt-admitting',
    contentHash: 'hash-admitting',
  }, (onTurnAdmitted, onSubmitted) => new Promise(resolve => {
    onTurnAdmitted({ previousState: 'idle' });
    admitPrompt = onSubmitted;
    finishAdmissionPrompt = resolve;
  }));
  await new Promise(resolve => setImmediate(resolve));
  assert.strictEqual(host.promptOperation('agent-1', 'prompt-admitting').status, 'admitting');
  assert.strictEqual(host.promptOperation('agent-1', 'prompt-admitting').kind, 'turn');
  assert.strictEqual(host.binding('agent-1').state, 'working');
  const joinedAdmission = host.submitPrompt(secondController, {
    agentId: 'agent-1',
    bindingEpoch: 'binding-1',
    clientPromptId: 'prompt-admitting',
    contentHash: 'hash-admitting',
  }, () => {
    throw new Error('duplicate admission was executed');
  });
  admitPrompt();
  assert.strictEqual(host.promptOperation('agent-1', 'prompt-admitting').status, 'provider-owned');
  finishAdmissionPrompt({ stopReason: 'end_turn' });
  await Promise.all([admissionPrompt, joinedAdmission]);

  host.upsertBinding({
    agentId: 'agent-admission-failure',
    bindingEpoch: 'binding-admission-failure',
    state: 'error',
  });
  await assert.rejects(
    host.submitPrompt(secondController, {
      agentId: 'agent-admission-failure',
      bindingEpoch: 'binding-admission-failure',
      clientPromptId: 'admission-failure',
      contentHash: 'admission-failure-hash',
    }, onTurnAdmitted => {
      onTurnAdmitted({ previousState: 'error' });
      return Promise.reject(new Error('checkpoint admission failed'));
    }),
    /checkpoint admission failed/,
  );
  const failedAdmissionBinding = host.binding('agent-admission-failure');
  assert.strictEqual(failedAdmissionBinding.state, 'error');
  assert.strictEqual(failedAdmissionBinding.turnHandle, undefined);
  assert.strictEqual(failedAdmissionBinding.lastSettledTurnHandle, undefined);

  host.upsertBinding({
    agentId: 'agent-provider-failure',
    bindingEpoch: 'binding-provider-failure',
    state: 'idle',
  });
  await assert.rejects(
    host.submitPrompt(secondController, {
      agentId: 'agent-provider-failure',
      bindingEpoch: 'binding-provider-failure',
      clientPromptId: 'provider-failure',
      contentHash: 'provider-failure-hash',
    }, (onTurnAdmitted, onSubmitted) => {
      onTurnAdmitted({ previousState: 'idle' });
      onSubmitted({ steered: false });
      return Promise.reject(new Error('provider prompt failed'));
    }),
    /provider prompt failed/,
  );
  const providerFailureBinding = host.binding('agent-provider-failure');
  assert.strictEqual(providerFailureBinding.state, 'error');
  assert.strictEqual(providerFailureBinding.lastSettledTurnHandle, 'binding-provider-failure:1');

  for (let index = 0; index < 70; index += 1) {
    await host.submitPrompt(secondController, {
      agentId: 'agent-1',
      bindingEpoch: 'binding-1',
      clientPromptId: `tombstone-${index}`,
      contentHash: `hash-${index}`,
    }, (_turnHandle, onSubmitted) => {
      onSubmitted();
      return { stopReason: 'end_turn' };
    });
  }
  assert(
    [...host.promptOperations.values()].filter(operation => operation.agentId === 'agent-1').length <= 32,
    'settled Host evidence must stay within the per-binding window',
  );
  let replayedRecentPrompt = false;
  await host.submitPrompt(secondController, {
    agentId: 'agent-1',
    bindingEpoch: 'binding-1',
    clientPromptId: 'tombstone-69',
    contentHash: 'hash-69',
  }, () => {
    replayedRecentPrompt = true;
    return { stopReason: 'replayed' };
  });
  assert.strictEqual(replayedRecentPrompt, false, 'recent settled mutation identities must remain joinable');

  let finishOldBindingPrompt;
  const oldBindingPrompt = host.submitPrompt(secondController, {
    agentId: 'agent-1',
    bindingEpoch: 'binding-1',
    clientPromptId: 'old-binding-completion',
    contentHash: 'old-binding-hash',
  }, (_turnHandle, onSubmitted) => {
    onSubmitted();
    return new Promise(resolve => {
      finishOldBindingPrompt = resolve;
    });
  });
  host.upsertBinding({
    agentId: 'agent-1',
    bindingEpoch: 'binding-after-old-turn',
    sessionId: 'session-after-old-turn',
    state: 'idle',
  });
  finishOldBindingPrompt({ stopReason: 'end_turn' });
  await oldBindingPrompt;
  assert.strictEqual(host.binding('agent-1').bindingEpoch, 'binding-after-old-turn');
  assert.strictEqual(host.binding('agent-1').state, 'idle');

  host.upsertBinding({
    agentId: 'agent-cancel-admission',
    bindingEpoch: 'binding-cancel-admission',
    state: 'idle',
  });
  let rejectCancelledAdmission;
  const cancelledAdmission = host.submitPrompt(secondController, {
    agentId: 'agent-cancel-admission',
    bindingEpoch: 'binding-cancel-admission',
    clientPromptId: 'cancelled-admission',
    contentHash: 'cancelled-admission-hash',
  }, onTurnAdmitted => new Promise((_resolve, reject) => {
    onTurnAdmitted({ previousState: 'idle' });
    rejectCancelledAdmission = reject;
  }));
  await new Promise(resolve => setImmediate(resolve));
  const cancelledAdmissionHandle = host.promptOperation(
    'agent-cancel-admission',
    'cancelled-admission',
  ).turnHandle;
  await host.cancelTurn(secondController, {
    agentId: 'agent-cancel-admission',
    bindingEpoch: 'binding-cancel-admission',
    operationId: 'cancel-admission',
    turnHandle: cancelledAdmissionHandle,
  }, () => ({ cancelled: true }));
  assert.strictEqual(
    host.binding('agent-cancel-admission').state,
    'idle',
    'successful pre-provider cancellation must release the admission slot',
  );
  assert.strictEqual(host.binding('agent-cancel-admission').turnHandle, undefined);

  host.disconnectController(secondController);
  const thirdController = { id: 'server-c', generation: 3 };
  await host.registerController(thirdController);
  let duplicateAdmissionCalls = 0;
  const joinedCancelledAdmission = host.submitPrompt(thirdController, {
    agentId: 'agent-cancel-admission',
    bindingEpoch: 'binding-cancel-admission',
    clientPromptId: 'cancelled-admission',
    contentHash: 'cancelled-admission-hash',
  }, () => {
    duplicateAdmissionCalls += 1;
    return { stopReason: 'replayed' };
  });
  let finishSuccessor;
  const successor = host.submitPrompt(thirdController, {
    agentId: 'agent-cancel-admission',
    bindingEpoch: 'binding-cancel-admission',
    clientPromptId: 'successor-after-cancel',
    contentHash: 'successor-after-cancel-hash',
  }, (onTurnAdmitted, onSubmitted) => {
    onTurnAdmitted({ previousState: 'idle' });
    onSubmitted();
    return new Promise(resolve => {
      finishSuccessor = resolve;
    });
  });
  await new Promise(resolve => setImmediate(resolve));
  const successorHandle = host.promptOperation(
    'agent-cancel-admission',
    'successor-after-cancel',
  ).turnHandle;
  rejectCancelledAdmission(new Error('cancelled before provider ownership'));
  await assert.rejects(cancelledAdmission, /cancelled before provider ownership/);
  await assert.rejects(joinedCancelledAdmission, /cancelled before provider ownership/);
  assert.strictEqual(duplicateAdmissionCalls, 0, 'replacement Controller must join the cancelled request without replaying it');
  assert.strictEqual(
    host.binding('agent-cancel-admission').turnHandle,
    successorHandle,
    'late rejection from the cancelled admission must not clear its successor',
  );
  finishSuccessor({ stopReason: 'end_turn' });
  await successor;

  host.upsertBinding({
    agentId: 'agent-2',
    bindingEpoch: 'binding-2',
    sessionId: 'session-2',
    state: 'idle',
  });
  host.upsertBinding({
    agentId: 'agent-3',
    bindingEpoch: 'binding-3',
    sessionId: 'session-3',
    state: 'idle',
  });
  const latest = host.recover(host.eventSeq - 1);
  assert.strictEqual(latest.replace, false);
  assert.strictEqual(latest.events.length, 1);
  const stale = host.recover(0);
  assert.strictEqual(stale.replace, true, 'an event gap must force a full replacement');

  console.log('ACP runtime host state tests passed');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
