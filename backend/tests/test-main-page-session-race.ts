const assert = require('assert');

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function run() {
  const imported = await import('../../src/lib/main-page-session-mutations.ts');
  const {
    beginMainPageSessionKeysSettingsRequest,
    createMainPageSessionMembershipState,
    enqueueMainPageSessionKeyMutation,
    MainPageSessionMembershipController,
    observeMainPageSessionKeys,
    receiveInitialMainPageSessionKeys,
    receiveMainPageSessionKeysBaseline,
    settleMainPageSessionKeyMutation,
  } = imported;
  const one = 'agent-session:codex:one';
  const two = 'agent-session:codex:two';
  const remote = 'agent-session:codex:remote';
  const fallback = 'agent-session:codex:fallback';

  let state = createMainPageSessionMembershipState([]);
  const add = enqueueMainPageSessionKeyMutation(state, 'add', [one]);
  state = add.state;
  const remove = enqueueMainPageSessionKeyMutation(state, 'remove', [one]);
  state = remove.state;
  assert.deepStrictEqual(state.projectedKeys, [], 'add followed by remove should project the latest local intent');

  state = settleMainPageSessionKeyMutation(state, {
    version: add.mutation.version,
    authoritativeKeys: [one],
    authoritativeRevisionAtStart: state.authoritativeRevision,
  });
  assert.deepStrictEqual(
    state.projectedKeys,
    [],
    'an old add response must not undo the newer pending remove',
  );
  assert.deepStrictEqual(
    state.pendingMutations.map((mutation: { version: number }) => mutation.version),
    [remove.mutation.version],
    'settlement must remove only the exact mutation',
  );

  const duplicateSettlement = settleMainPageSessionKeyMutation(state, {
    version: add.mutation.version,
    authoritativeKeys: [fallback],
    authoritativeRevisionAtStart: state.authoritativeRevision,
  });
  assert.strictEqual(duplicateSettlement, state, 'duplicate or unknown settlements must be ignored exactly');

  let observedState = observeMainPageSessionKeys(
    createMainPageSessionMembershipState([remote]),
    [one],
  );
  assert.deepStrictEqual(
    observedState.projectedKeys,
    [one, remote],
    'a newly active session should project locally without issuing another membership mutation',
  );
  observedState = receiveMainPageSessionKeysBaseline(observedState, [two]);
  assert.deepStrictEqual(
    observedState.projectedKeys,
    [two],
    'the next authoritative baseline should settle the temporary active-session projection',
  );

  const cappedBaseline = Array.from(
    { length: 50 },
    (_, index) => `agent-session:codex:capped-${index}`,
  );
  const cappedPendingState = enqueueMainPageSessionKeyMutation(
    createMainPageSessionMembershipState(cappedBaseline),
    'add',
    [one],
  ).state;
  assert.strictEqual(cappedPendingState.projectedKeys.length, 50);
  assert.deepStrictEqual(
    cappedPendingState.projectedKeys,
    [one, ...cappedBaseline.slice(0, 49)],
    'an optimistic add must match the server owner by prepending the new key before applying the 50-key cap',
  );
  const cappedBatchState = enqueueMainPageSessionKeyMutation(
    createMainPageSessionMembershipState(cappedBaseline.slice(0, 49)),
    'add',
    [one, two],
  ).state;
  assert.deepStrictEqual(
    cappedBatchState.projectedKeys,
    [one, two, ...cappedBaseline.slice(0, 48)],
    'a batch add must preserve request order while evicting the oldest tail keys',
  );
  const cappedObservedState = observeMainPageSessionKeys(cappedPendingState, [two]);
  assert.deepStrictEqual(
    cappedObservedState.projectedKeys,
    [one, two, ...cappedBaseline.slice(0, 48)],
    'a newly observed live session must survive the cap while pending mutations retain command order',
  );
  const fullObservedState = observeMainPageSessionKeys(
    createMainPageSessionMembershipState(cappedBaseline),
    [one],
  );
  assert.deepStrictEqual(
    fullObservedState.projectedKeys,
    [one, ...cappedBaseline.slice(0, 49)],
    'a live observation must prepend like the authoritative backend owner at the 50-key boundary',
  );

  state = receiveMainPageSessionKeysBaseline(state, [one, remote]);
  assert.deepStrictEqual(
    state.projectedKeys,
    [remote],
    'a WebSocket baseline must replay the pending remove in local command order',
  );

  let initialState = createMainPageSessionMembershipState([]);
  let settingsRequest = beginMainPageSessionKeysSettingsRequest(initialState);
  initialState = settingsRequest.state;
  initialState = receiveInitialMainPageSessionKeys(initialState, [remote], settingsRequest.guard);
  assert.deepStrictEqual(
    initialState.projectedKeys,
    [remote],
    'the initial settings snapshot should be accepted before any newer remote or local event',
  );
  settingsRequest = beginMainPageSessionKeysSettingsRequest(initialState);
  initialState = settingsRequest.state;
  initialState = enqueueMainPageSessionKeyMutation(initialState, 'add', [one]).state;
  assert.strictEqual(
    receiveInitialMainPageSessionKeys(initialState, [fallback], settingsRequest.guard),
    initialState,
    'an initial settings response must not replace a newer local mutation',
  );
  settingsRequest = beginMainPageSessionKeysSettingsRequest(initialState);
  initialState = settingsRequest.state;
  initialState = receiveMainPageSessionKeysBaseline(initialState, [remote]);
  assert.strictEqual(
    receiveInitialMainPageSessionKeys(initialState, [fallback], settingsRequest.guard),
    initialState,
    'an initial settings response must not replace a newer WebSocket baseline',
  );

  let observedDuringSettings = createMainPageSessionMembershipState([]);
  settingsRequest = beginMainPageSessionKeysSettingsRequest(observedDuringSettings);
  observedDuringSettings = settingsRequest.state;
  observedDuringSettings = observeMainPageSessionKeys(observedDuringSettings, [one]);
  assert.strictEqual(
    receiveInitialMainPageSessionKeys(observedDuringSettings, [fallback], settingsRequest.guard),
    observedDuringSettings,
    'a settings response captured before an active-session observation must not delete that overlay',
  );

  let concurrentSettings = createMainPageSessionMembershipState([]);
  const olderSettingsRequest = beginMainPageSessionKeysSettingsRequest(concurrentSettings);
  concurrentSettings = olderSettingsRequest.state;
  const newerSettingsRequest = beginMainPageSessionKeysSettingsRequest(concurrentSettings);
  concurrentSettings = newerSettingsRequest.state;
  concurrentSettings = receiveInitialMainPageSessionKeys(
    concurrentSettings,
    [fallback],
    olderSettingsRequest.guard,
  );
  assert.deepStrictEqual(
    concurrentSettings.projectedKeys,
    [fallback],
    'an older successful response may provide liveness while a newer request is pending or cancelled',
  );
  concurrentSettings = receiveInitialMainPageSessionKeys(
    concurrentSettings,
    [remote],
    newerSettingsRequest.guard,
  );
  assert.deepStrictEqual(
    concurrentSettings.projectedKeys,
    [remote],
    'a newer successful response must supersede an older accepted response in the same membership epoch',
  );
  const afterNewerSettings = concurrentSettings;
  assert.strictEqual(
    receiveInitialMainPageSessionKeys(
      concurrentSettings,
      [fallback],
      olderSettingsRequest.guard,
    ),
    afterNewerSettings,
    'an older response must not roll back a newer accepted settings response',
  );

  const settingsController = new MainPageSessionMembershipController([], {
    mutateMainPageSessionKeys: async () => [],
    loadMainPageSessionKeys: async () => [],
  });
  const olderControllerGuard = settingsController.captureInitialSettingsGuard();
  const newerControllerGuard = settingsController.captureInitialSettingsGuard();
  settingsController.receiveInitialSettings([fallback], olderControllerGuard);
  assert.deepStrictEqual(settingsController.getSnapshot().projectedKeys, [fallback]);
  settingsController.receiveInitialSettings([remote], newerControllerGuard);
  assert.deepStrictEqual(
    settingsController.getSnapshot().projectedKeys,
    [remote],
    'the controller must publish request generations before admitting settings responses',
  );

  let settledDuringSettings = createMainPageSessionMembershipState([]);
  const settlementMutation = enqueueMainPageSessionKeyMutation(settledDuringSettings, 'add', [one]);
  settledDuringSettings = settlementMutation.state;
  settingsRequest = beginMainPageSessionKeysSettingsRequest(settledDuringSettings);
  settledDuringSettings = settingsRequest.state;
  settledDuringSettings = settleMainPageSessionKeyMutation(settledDuringSettings, {
    version: settlementMutation.mutation.version,
    authoritativeKeys: [one],
    authoritativeRevisionAtStart: settledDuringSettings.authoritativeRevision,
  });
  assert.strictEqual(
    receiveInitialMainPageSessionKeys(settledDuringSettings, [], settingsRequest.guard),
    settledDuringSettings,
    'a settings snapshot captured before mutation settlement must not roll back the settled result',
  );

  let failedReconciliation = observeMainPageSessionKeys(
    createMainPageSessionMembershipState([remote]),
    [one],
  );
  const failedReconciliationMutation = enqueueMainPageSessionKeyMutation(
    failedReconciliation,
    'add',
    [two],
  );
  failedReconciliation = settleMainPageSessionKeyMutation(failedReconciliationMutation.state, {
    version: failedReconciliationMutation.mutation.version,
    authoritativeKeys: null,
    authoritativeRevisionAtStart: failedReconciliationMutation.state.authoritativeRevision,
  });
  assert.deepStrictEqual(
    failedReconciliation.projectedKeys,
    [one, remote],
    'a mutation and fallback double failure has no authority to clear unrelated active-session observations',
  );
  let overlappingObservation = createMainPageSessionMembershipState([]);
  const overlappingMutation = enqueueMainPageSessionKeyMutation(
    overlappingObservation,
    'add',
    [one],
  );
  overlappingObservation = observeMainPageSessionKeys(overlappingMutation.state, [one]);
  overlappingObservation = settleMainPageSessionKeyMutation(overlappingObservation, {
    version: overlappingMutation.mutation.version,
    authoritativeKeys: null,
    authoritativeRevisionAtStart: overlappingMutation.state.authoritativeRevision,
  });
  assert.deepStrictEqual(
    overlappingObservation.projectedKeys,
    [one],
    'an observation already visible through a pending add remains independent evidence after double failure',
  );

  let authoritativeObservation = createMainPageSessionMembershipState([one]);
  settingsRequest = beginMainPageSessionKeysSettingsRequest(authoritativeObservation);
  authoritativeObservation = settingsRequest.state;
  authoritativeObservation = observeMainPageSessionKeys(authoritativeObservation, [one]);
  assert.strictEqual(
    receiveInitialMainPageSessionKeys(authoritativeObservation, [], settingsRequest.guard),
    authoritativeObservation,
    'observing an already-authoritative live session must still invalidate an older settings snapshot',
  );

  const mutationRequest = deferred<string[]>();
  const fallbackRequest = deferred<string[]>();
  const fallbackStarted = deferred<void>();
  const supersededController = new MainPageSessionMembershipController([], {
    mutateMainPageSessionKeys: () => mutationRequest.promise,
    loadMainPageSessionKeys: () => {
      fallbackStarted.resolve(undefined);
      return fallbackRequest.promise;
    },
  });
  const supersededMutation = supersededController.mutate('add', [one]);
  mutationRequest.reject(new Error('mutation failed'));
  await fallbackStarted.promise;
  supersededController.receiveRemoteBaseline([remote]);
  fallbackRequest.resolve([fallback]);
  await supersededMutation;
  assert.deepStrictEqual(
    supersededController.getSnapshot().projectedKeys,
    [remote],
    'a fallback response superseded by a WebSocket baseline must be discarded',
  );

  const calls: string[] = [];
  let mutationCall = 0;
  const queuedController = new MainPageSessionMembershipController([], {
    mutateMainPageSessionKeys: async (_operation: string, sessionKeys: string[]) => {
      mutationCall += 1;
      calls.push(`mutate:${sessionKeys[0]}`);
      if (mutationCall === 1) throw new Error('first mutation failed');
      return [two];
    },
    loadMainPageSessionKeys: async () => {
      calls.push('fallback');
      throw new Error('fallback failed');
    },
  });
  const failedMutation = queuedController.mutate('add', [one]);
  const followingMutation = queuedController.mutate('add', [two]);
  await Promise.all([failedMutation, followingMutation]);
  assert.deepStrictEqual(
    calls,
    [`mutate:${one}`, 'fallback', `mutate:${two}`],
    'a failed mutation and reconciliation must not stall the serial queue',
  );
  assert.deepStrictEqual(queuedController.getSnapshot().projectedKeys, [two]);

  const failedController = new MainPageSessionMembershipController([], {
    mutateMainPageSessionKeys: async () => {
      throw new Error('mutation failed');
    },
    loadMainPageSessionKeys: async () => {
      throw new Error('fallback failed');
    },
  });
  failedController.observeSessionKeys([one]);
  await failedController.mutate('add', [two]);
  assert.deepStrictEqual(
    failedController.getSnapshot().projectedKeys,
    [one],
    'the controller must preserve active-session observation after mutation and reconciliation both fail',
  );

  console.log('✓ Main-page membership reducer and controller preserve ordered authoritative reconciliation');
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
