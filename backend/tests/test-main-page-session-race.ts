const assert = require('assert');
const fs = require('fs');
const path = require('path');

const workspaceSource = fs.readFileSync(path.join(__dirname, '../../src/components/CodeWorkspace.tsx'), 'utf8');
const controllerSource = fs.readFileSync(path.join(__dirname, '../../src/components/code/useMainPageSessionMembershipController.ts'), 'utf8');

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
    captureMainPageSessionKeysInitialGuard,
    createMainPageSessionMembershipState,
    enqueueMainPageSessionKeyMutation,
    MainPageSessionMembershipController,
    observeMainPageSessionKeys,
    receiveInitialMainPageSessionKeys,
    receiveMainPageSessionKeysBaseline,
    settleMainPageSessionKeyMutation,
  } = imported;
  assert(
    controllerSource.includes('const MAIN_PAGE_SESSION_MUTATION_TIMEOUT_MS = 15_000')
      && controllerSource.includes("appPath('/api/main-page-agent-sessions')")
      && controllerSource.includes("appPath('/api/settings')"),
    'main-page mutation and authoritative reconciliation requests must both have a bounded wait',
  );

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
    [remote, one],
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
  assert(!cappedPendingState.projectedKeys.includes(one), 'a pending add must not exceed the 50-key UI cap');
  const cappedObservedState = observeMainPageSessionKeys(cappedPendingState, [two]);
  assert.strictEqual(cappedObservedState.projectedKeys.length, 50);
  assert(!cappedObservedState.projectedKeys.includes(two), 'an observed session must not exceed the 50-key UI cap');

  state = receiveMainPageSessionKeysBaseline(state, [one, remote]);
  assert.deepStrictEqual(
    state.projectedKeys,
    [remote],
    'a WebSocket baseline must replay the pending remove in local command order',
  );

  let initialState = createMainPageSessionMembershipState([]);
  const acceptedInitialGuard = captureMainPageSessionKeysInitialGuard(initialState);
  initialState = receiveInitialMainPageSessionKeys(initialState, [remote], acceptedInitialGuard);
  assert.deepStrictEqual(
    initialState.projectedKeys,
    [remote],
    'the initial settings snapshot should be accepted before any newer remote or local event',
  );
  const initialGuard = captureMainPageSessionKeysInitialGuard(initialState);
  initialState = enqueueMainPageSessionKeyMutation(initialState, 'add', [one]).state;
  assert.strictEqual(
    receiveInitialMainPageSessionKeys(initialState, [fallback], initialGuard),
    initialState,
    'an initial settings response must not replace a newer local mutation',
  );
  const remoteGuard = captureMainPageSessionKeysInitialGuard(initialState);
  initialState = receiveMainPageSessionKeysBaseline(initialState, [remote]);
  assert.strictEqual(
    receiveInitialMainPageSessionKeys(initialState, [fallback], remoteGuard),
    initialState,
    'an initial settings response must not replace a newer WebSocket baseline',
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

  assert(
    workspaceSource.includes('useMainPageSessionMembershipController')
      && !workspaceSource.includes('mainPageSessionKeysPendingMutationsRef')
      && !workspaceSource.includes('mainPageSessionKeysAuthoritativeRevisionRef'),
    'CodeWorkspace must consume the controller instead of retaining a second membership owner',
  );

  console.log('✓ Main-page membership reducer and controller preserve ordered authoritative reconciliation');
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
