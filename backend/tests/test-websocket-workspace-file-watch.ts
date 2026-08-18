const assert = require('assert');
const { WorkspaceFileError } = require('../workspace-file-service.cjs');
const {
  createWorkspaceFileWatchController,
} = require('../websocket-workspace-file-watch.cjs') as typeof import('../websocket-workspace-file-watch.cjs');

interface Deferred<Value> {
  promise: Promise<Value>;
  reject(error: unknown): void;
  resolve(value: Value): void;
}

interface TestClient {
  messages: Array<Record<string, unknown>>;
  readyState: number;
  send(data: string): void;
}

interface SubscriptionAttempt {
  deferred: Deferred<{
    update(paths: readonly string[]): Promise<void>;
    close(): void | Promise<void>;
  }>;
  events: (event: Record<string, unknown>) => void;
  paths: readonly string[];
  root: string;
  updates: string[][];
}

const OPEN = 1;
const CLOSED = 3;

function deferred<Value>(): Deferred<Value> {
  let resolve!: (value: Value) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function client(): TestClient {
  return {
    messages: [],
    readyState: OPEN,
    send(data) {
      this.messages.push(JSON.parse(data));
    },
  };
}

function createHarness() {
  const attempts: SubscriptionAttempt[] = [];
  const cleanupErrors: unknown[] = [];
  const controller = createWorkspaceFileWatchController<TestClient>({
    openState: OPEN,
    resolveRoot(rootId) {
      if (!rootId) throw new WorkspaceFileError('rootId is required', 400);
      if (rootId === 'known-error') throw new WorkspaceFileError('workspace not found', 404);
      if (rootId === 'generic-error') throw new Error('sensitive root failure');
      return `/workspace/${rootId}`;
    },
    subscribe(root, paths, events) {
      const attempt: SubscriptionAttempt = {
        deferred: deferred(),
        events,
        paths,
        root,
        updates: [],
      };
      attempts.push(attempt);
      return attempt.deferred.promise;
    },
    logCleanupError(error) {
      cleanupErrors.push(error);
    },
    watchErrorMessage(error) {
      return error instanceof Error && error instanceof WorkspaceFileError
        ? error.message
        : null;
    },
  });
  return { attempts, cleanupErrors, controller };
}

function resolveAttempt(
  attempt: SubscriptionAttempt,
  close: () => void | Promise<void> = () => {},
  update: (paths: readonly string[]) => Promise<void> = async paths => {
    attempt.updates.push([...paths]);
  },
) {
  attempt.deferred.resolve({
    update,
    close,
  });
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

async function run(): Promise<void> {
  {
    const { attempts, controller } = createHarness();
    const socket = client();
    const initial = controller.watch(socket, 'agent-initial-update', ['a.ts']);
    const changed = controller.watch(socket, 'agent-initial-update', ['b.ts']);
    resolveAttempt(attempts[0]);
    await Promise.all([initial, changed]);
    assert.deepStrictEqual(attempts[0].updates, [['b.ts']]);
    assert.deepStrictEqual(
      socket.messages.filter(message => message.type === 'workspace-file-watch'),
      [{ type: 'workspace-file-watch', rootId: 'agent-initial-update', paths: ['b.ts'], watching: true }],
      'an initial subscription must not acknowledge a newer desired path before the update applies',
    );
    controller.close(socket);
  }

  {
    const { attempts, controller } = createHarness();
    const socket = client();
    const initial = controller.watch(socket, 'agent-update-retry', ['a.ts']);
    let updateCalls = 0;
    resolveAttempt(attempts[0], () => {}, async paths => {
      attempts[0].updates.push([...paths]);
      updateCalls += 1;
      if (updateCalls === 1) throw new WorkspaceFileError('update failed', 503);
    });
    await initial;
    await controller.watch(socket, 'agent-update-retry', ['b.ts']);
    assert(!socket.messages.some(message => (
      message.type === 'workspace-file-watch' && JSON.stringify(message.paths) === JSON.stringify(['b.ts'])
    )), 'failed path updates must not be acknowledged');
    await controller.watch(socket, 'agent-update-retry', ['b.ts']);
    assert.deepStrictEqual(attempts[0].updates, [['b.ts'], ['b.ts']]);
    assert.deepStrictEqual(socket.messages.at(-1), {
      type: 'workspace-file-watch',
      rootId: 'agent-update-retry',
      paths: ['b.ts'],
      watching: true,
    });
    controller.close(socket);
  }

  {
    const { attempts, controller } = createHarness();
    const socket = client();
    let unsubscribeCalls = 0;
    const watching = controller.watch(socket, 'agent-a', ['src/index.ts']);
    assert.strictEqual(attempts.length, 1);
    assert.strictEqual(attempts[0].root, '/workspace/agent-a');
    assert.deepStrictEqual(attempts[0].paths, ['src/index.ts']);
    resolveAttempt(attempts[0], async () => {
      unsubscribeCalls += 1;
    });
    await watching;
    assert.deepStrictEqual(socket.messages, [{
      type: 'workspace-file-watch',
      rootId: 'agent-a',
      paths: ['src/index.ts'],
      watching: true,
    }]);

    attempts[0].events({ type: 'change', path: 'src/index.ts' });
    assert.deepStrictEqual(socket.messages.at(-1), {
      type: 'workspace-file-event',
      event: { rootId: 'agent-a', type: 'change', path: 'src/index.ts' },
    });

    controller.unwatch(socket, 'agent-a');
    await flushPromises();
    assert.strictEqual(unsubscribeCalls, 1, 'unwatch must release the exact active subscription once');
    const messageCount = socket.messages.length;
    attempts[0].events({ type: 'change', path: 'ignored.ts' });
    controller.unwatch(socket, 'agent-a');
    controller.close(socket);
    assert.strictEqual(socket.messages.length, messageCount, 'released leases must stop forwarding events');
    assert.strictEqual(unsubscribeCalls, 1, 'repeated cleanup must be idempotent');
  }

  {
    const { attempts, controller } = createHarness();
    const socket = client();
    let unsubscribeCalls = 0;
    const first = controller.watch(socket, 'agent-duplicate', ['same.ts']);
    const second = controller.watch(socket, 'agent-duplicate', ['same.ts']);
    assert.strictEqual(attempts.length, 1, 'duplicate watch requests must share one subscription attempt');
    resolveAttempt(attempts[0], () => {
      unsubscribeCalls += 1;
    });
    await Promise.all([first, second]);
    assert.strictEqual(
      socket.messages.filter(message => message.type === 'workspace-file-watch').length,
      2,
      'each duplicate request must retain the existing acknowledgement behavior',
    );
    const replacement = controller.watch(socket, 'agent-duplicate', ['new.ts']);
    assert.strictEqual(attempts.length, 1, 'a changed path set must update the active subscription');
    await replacement;
    await flushPromises();
    assert.strictEqual(unsubscribeCalls, 0, 'updating paths must keep the shared subscription alive');
    assert.deepStrictEqual(attempts[0].updates, [['new.ts']]);
    controller.close(socket);
    await flushPromises();
    assert.strictEqual(unsubscribeCalls, 1);
  }

  {
    const { attempts, controller } = createHarness();
    const socket = client();
    let staleUnsubscribeCalls = 0;
    let currentUnsubscribeCalls = 0;
    const staleWatch = controller.watch(socket, 'agent-replaced', ['stale.ts']);
    controller.unwatch(socket, 'agent-replaced');
    const currentWatch = controller.watch(socket, 'agent-replaced', ['current.ts']);
    assert.strictEqual(attempts.length, 2, 'watch after unwatch must create a fresh lease');

    resolveAttempt(attempts[0], () => {
      staleUnsubscribeCalls += 1;
    });
    resolveAttempt(attempts[1], () => {
      currentUnsubscribeCalls += 1;
    });
    await Promise.all([staleWatch, currentWatch]);
    await flushPromises();
    assert.strictEqual(staleUnsubscribeCalls, 1, 'a late stale subscription must release only itself');
    assert.strictEqual(currentUnsubscribeCalls, 0, 'stale completion must not release its replacement');
    assert.strictEqual(
      socket.messages.filter(message => message.type === 'workspace-file-watch').length,
      1,
      'only the current lease may acknowledge readiness',
    );

    const beforeEvents = socket.messages.length;
    attempts[0].events({ type: 'change', path: 'stale.ts' });
    assert.strictEqual(socket.messages.length, beforeEvents);
    attempts[1].events({ type: 'change', path: 'current.ts' });
    assert.strictEqual(socket.messages.length, beforeEvents + 1, 'replacement lease must remain live');
    controller.close(socket);
    await flushPromises();
    assert.strictEqual(currentUnsubscribeCalls, 1);
  }

  {
    const { attempts, controller } = createHarness();
    const firstClient = client();
    const secondClient = client();
    let firstUnsubscribeCalls = 0;
    let secondUnsubscribeCalls = 0;
    const firstWatch = controller.watch(firstClient, 'shared-agent', ['first.ts']);
    const secondWatch = controller.watch(secondClient, 'shared-agent', ['second.ts']);
    assert.strictEqual(attempts.length, 2, 'leases must be isolated by exact connection identity');
    resolveAttempt(attempts[0], () => {
      firstUnsubscribeCalls += 1;
    });
    resolveAttempt(attempts[1], () => {
      secondUnsubscribeCalls += 1;
    });
    await Promise.all([firstWatch, secondWatch]);
    controller.close(firstClient);
    await flushPromises();
    assert.strictEqual(firstUnsubscribeCalls, 1);
    assert.strictEqual(secondUnsubscribeCalls, 0);
    const secondMessageCount = secondClient.messages.length;
    attempts[1].events({ type: 'add', path: 'still-live.ts' });
    assert.strictEqual(secondClient.messages.length, secondMessageCount + 1);
    controller.close(secondClient);
    await flushPromises();
    assert.strictEqual(secondUnsubscribeCalls, 1);
  }

  {
    const { attempts, cleanupErrors, controller } = createHarness();
    const socket = client();
    const first = controller.watch(socket, 'agent-one', ['one.ts']);
    const second = controller.watch(socket, 'agent-two', ['two.ts']);
    let firstUnsubscribeCalls = 0;
    let secondUnsubscribeCalls = 0;
    resolveAttempt(attempts[0], () => {
      firstUnsubscribeCalls += 1;
      return Promise.reject(new Error('first cleanup failed'));
    });
    resolveAttempt(attempts[1], () => {
      secondUnsubscribeCalls += 1;
    });
    await Promise.all([first, second]);
    controller.unwatch(socket);
    await flushPromises();
    assert.strictEqual(firstUnsubscribeCalls, 1);
    assert.strictEqual(secondUnsubscribeCalls, 1, 'clear-all must release every exact lease');
    assert.strictEqual(cleanupErrors.length, 1, 'async cleanup failure must be observed exactly once');
  }

  {
    const { attempts, controller } = createHarness();
    const socket = client();
    const first = controller.watch(socket, 'agent-reject', ['reject.ts']);
    const duplicate = controller.watch(socket, 'agent-reject', ['reject.ts']);
    attempts[0].deferred.reject(new WorkspaceFileError('watch unavailable', 503));
    await Promise.all([first, duplicate]);
    assert.deepStrictEqual(
      socket.messages,
      [
        { type: 'error', message: 'watch unavailable' },
        { type: 'error', message: 'watch unavailable' },
      ],
      'each duplicate request must retain the existing failure response',
    );
    const retry = controller.watch(socket, 'agent-reject', ['retry.ts']);
    assert.strictEqual(attempts.length, 2, 'failed subscriptions must leave a live retry path');
    resolveAttempt(attempts[1]);
    await retry;
    assert.strictEqual(socket.messages.at(-1)?.type, 'workspace-file-watch');
    controller.close(socket);
  }

  {
    const { controller } = createHarness();
    const socket = client();
    await controller.watch(socket, 'known-error', ['known.ts']);
    await controller.watch(socket, 'generic-error', ['generic.ts']);
    await controller.watch(socket, '', ['missing-agent.ts']);
    await controller.watch(socket, 'missing-paths', []);
    assert.deepStrictEqual(socket.messages, [
      { type: 'error', message: 'workspace not found' },
      { type: 'error', message: 'failed to watch workspace files' },
      { type: 'error', message: 'rootId is required' },
      { type: 'error', message: 'at least one file path is required' },
    ]);
    socket.readyState = CLOSED;
    await controller.watch(socket, 'known-error', ['known.ts']);
    assert.strictEqual(socket.messages.length, 4, 'closed clients must not receive watch errors');
  }

  {
    const { attempts, controller } = createHarness();
    const socket = client();
    let unsubscribeCalls = 0;
    const pending = controller.watch(socket, 'agent-closing', ['closing.ts']);
    controller.close(socket);
    resolveAttempt(attempts[0], () => {
      unsubscribeCalls += 1;
    });
    await pending;
    await flushPromises();
    assert.strictEqual(unsubscribeCalls, 1, 'close during subscribe must clean up a late-ready lease');
    assert.deepStrictEqual(socket.messages, [], 'close during subscribe must suppress readiness');
  }

  console.log('WebSocket workspace file watch controller passed');
}

run().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
