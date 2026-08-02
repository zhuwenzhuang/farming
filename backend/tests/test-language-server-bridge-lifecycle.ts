import assert from 'node:assert';

const {
  DEFAULT_DEADLINE_MS,
  STALLED_CODE,
  createRequestLifecycle,
} = require('../../extensions/language-server/vscode-bridge/request-lifecycle.js');

interface Deferred<T> {
  promise: Promise<T>;
  reject(error: unknown): void;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let reject!: (error: unknown) => void;
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, reject, resolve };
}

function fakeScheduler() {
  let nextId = 0;
  const callbacks = new Map<number, () => void>();
  return {
    cancel(id: number) {
      callbacks.delete(id);
    },
    fire(id: number) {
      const callback = callbacks.get(id);
      assert.ok(callback, `timer ${id} should still be pending`);
      callbacks.delete(id);
      callback();
    },
    ids() {
      return [...callbacks.keys()];
    },
    schedule(callback: () => void) {
      nextId += 1;
      callbacks.set(nextId, callback);
      return nextId;
    },
  };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

async function run() {
  assert.ok(DEFAULT_DEADLINE_MS < 10_000, 'Bridge deadline must precede the backend request timeout');

  const concurrentScheduler = fakeScheduler();
  const concurrentLifecycle = createRequestLifecycle({
    schedule: concurrentScheduler.schedule,
    cancel: concurrentScheduler.cancel,
  });
  const firstHealthy = deferred<string>();
  const secondHealthy = deferred<string>();
  let healthyCalls = 0;
  const firstHealthyResult = concurrentLifecycle.run(() => {
    healthyCalls += 1;
    return firstHealthy.promise;
  });
  const secondHealthyResult = concurrentLifecycle.run(() => {
    healthyCalls += 1;
    return secondHealthy.promise;
  });
  assert.strictEqual(healthyCalls, 2, 'healthy requests must not be forced through a global mutex');
  assert.strictEqual(concurrentScheduler.ids().length, 2);
  secondHealthy.resolve('second');
  firstHealthy.resolve('first');
  assert.deepStrictEqual(await Promise.all([firstHealthyResult, secondHealthyResult]), ['first', 'second']);
  assert.deepStrictEqual(concurrentLifecycle.state(), {
    requestState: 'ready',
    stalledGenerations: [],
    inFlightGenerations: [],
  });
  assert.deepStrictEqual(concurrentScheduler.ids(), [], 'completed requests must cancel their deadlines');

  const stalledScheduler = fakeScheduler();
  const stalledLifecycle = createRequestLifecycle({
    schedule: stalledScheduler.schedule,
    cancel: stalledScheduler.cancel,
  });
  const slowProvider = deferred<string>();
  let providerCalls = 0;
  let responseCount = 0;
  const slowResult = stalledLifecycle.run(() => {
    providerCalls += 1;
    return slowProvider.promise;
  });
  const observedSlowResult = slowResult.then(value => {
    responseCount += 1;
    return value;
  }, error => {
    responseCount += 1;
    throw error;
  });
  stalledScheduler.fire(stalledScheduler.ids()[0]);
  await assert.rejects(observedSlowResult, (error: Error & { code?: string; status?: number }) => {
    assert.strictEqual(error.code, STALLED_CODE);
    assert.strictEqual(error.status, 504);
    assert.match(error.message, /Reload the VS Code window/);
    return true;
  });
  assert.strictEqual(responseCount, 1, 'the deadline must settle the HTTP-facing result exactly once');
  assert.deepStrictEqual(stalledLifecycle.state(), {
    requestState: 'stalled',
    stalledGenerations: [1],
    inFlightGenerations: [],
  });
  await assert.rejects(stalledLifecycle.run(() => {
    providerCalls += 1;
    return Promise.resolve('must not run');
  }), (error: Error & { code?: string; status?: number }) => {
    assert.strictEqual(error.code, STALLED_CODE);
    assert.strictEqual(error.status, 503);
    return true;
  });
  assert.strictEqual(providerCalls, 1, 'the stalled fence must reject before invoking another provider');
  slowProvider.resolve('late result');
  await flushPromises();
  assert.strictEqual(responseCount, 1, 'a late provider result must not send a second response');
  assert.strictEqual(stalledLifecycle.state().requestState, 'ready');
  assert.strictEqual(await stalledLifecycle.run(() => Promise.resolve('recovered')), 'recovered');

  const generationsScheduler = fakeScheduler();
  const generationsLifecycle = createRequestLifecycle({
    schedule: generationsScheduler.schedule,
    cancel: generationsScheduler.cancel,
  });
  const oldProvider = deferred<string>();
  const newerProvider = deferred<string>();
  const oldResult = generationsLifecycle.run(() => oldProvider.promise);
  const newerResult = generationsLifecycle.run(() => newerProvider.promise);
  const [oldTimer, newerTimer] = generationsScheduler.ids();
  const oldRejection = assert.rejects(oldResult, (error: Error & { status?: number }) => error.status === 504);
  generationsScheduler.fire(oldTimer);
  await oldRejection;
  const newerRejection = assert.rejects(newerResult, (error: Error & { status?: number }) => error.status === 504);
  generationsScheduler.fire(newerTimer);
  await newerRejection;
  assert.deepStrictEqual(generationsLifecycle.state().stalledGenerations, [1, 2]);
  oldProvider.resolve('old late result');
  await flushPromises();
  assert.deepStrictEqual(
    generationsLifecycle.state().stalledGenerations,
    [2],
    'an old generation settling must not clear a newer stalled request',
  );
  let fencedProviderCalls = 0;
  await assert.rejects(generationsLifecycle.run(() => {
    fencedProviderCalls += 1;
    return Promise.resolve('must not run');
  }), (error: Error & { status?: number }) => error.status === 503);
  assert.strictEqual(fencedProviderCalls, 0);
  newerProvider.reject(new Error('provider eventually failed'));
  await flushPromises();
  assert.strictEqual(generationsLifecycle.state().requestState, 'ready');

  const cleanupScheduler = fakeScheduler();
  const cleanupLifecycle = createRequestLifecycle({
    schedule: cleanupScheduler.schedule,
    cancel: cleanupScheduler.cancel,
  });
  const pendingProvider = deferred<string>();
  const pendingResult = cleanupLifecycle.run(() => pendingProvider.promise);
  assert.strictEqual(cleanupScheduler.ids().length, 1);
  cleanupLifecycle.dispose();
  await assert.rejects(pendingResult, (error: Error & { status?: number }) => error.status === 503);
  assert.deepStrictEqual(cleanupScheduler.ids(), [], 'deactivation must cancel every owned deadline');
  assert.deepStrictEqual(cleanupLifecycle.state().inFlightGenerations, []);
  assert.deepStrictEqual(cleanupLifecycle.state().stalledGenerations, []);
  let disposedProviderCalls = 0;
  await assert.rejects(cleanupLifecycle.run(() => {
    disposedProviderCalls += 1;
    return Promise.resolve('must not run');
  }), (error: Error & { status?: number }) => error.status === 503);
  assert.strictEqual(disposedProviderCalls, 0);
  pendingProvider.resolve('ignored after cleanup');
  await flushPromises();

  console.log('Language Server Bridge request lifecycle regression test passed.');
}

run().catch(error => {
  console.error(error);
  process.exit(1);
});
