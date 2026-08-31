const assert = require('assert');
import { InteractionPerformanceRecorder, performanceRequestKind } from '../../shared/interaction-performance';
const {
  createWebSocketWorkspaceRequestHandlers,
} = require('../websocket-workspace-request-handlers.cjs') as typeof import('../websocket-workspace-request-handlers.cjs');

interface Deferred<Value> {
  promise: Promise<Value>;
  resolve(value: Value): void;
}

interface TestClient {
  accessMode: 'owner' | 'read-only';
  bufferedAmount: number;
  messages: Array<Record<string, unknown>>;
  previewScopeId: string;
  readyState: number;
  send(body: string): void;
}

const OPEN = 1;

function deferred<Value>(): Deferred<Value> {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((done) => { resolve = done; });
  return { promise, resolve };
}

function client(options: { accessMode?: 'owner' | 'read-only'; previewScopeId?: string } = {}): TestClient {
  return {
    accessMode: options.accessMode || 'owner',
    bufferedAmount: 0,
    messages: [],
    previewScopeId: options.previewScopeId || 'owner-preview-scope',
    readyState: OPEN,
    send(body) { this.messages.push(JSON.parse(body)); },
  };
}

async function flush(): Promise<void> {
  await new Promise(resolve => setImmediate(resolve));
}

async function run(): Promise<void> {
  const pending = new Map<string, Deferred<unknown>>();
  const started: string[] = [];
  const aborted: string[] = [];
  const performanceRecorder = new InteractionPerformanceRecorder({ source: 'server', prefix: 'test', now: () => performance.now(), wallNow: Date.now });
  const handlers = createWebSocketWorkspaceRequestHandlers<TestClient>({
    observeRequest: (operation, requestId, kind) => performanceRecorder.begin(operation, { requestId, requestKind: performanceRequestKind(kind) }),
    openState: OPEN,
    maxMessageBytes: 1024,
    async executeWorkspace(request, accessMode, signal, previewScopeId) {
      assert.strictEqual(accessMode, 'owner');
      assert.strictEqual(previewScopeId, 'owner-preview-scope');
      const key = `${request.operation}:${'rootId' in request ? request.rootId : request.previewId}`;
      started.push(key);
      signal.addEventListener('abort', () => aborted.push(key), { once: true });
      const gate = pending.get(key);
      return gate ? gate.promise : { key };
    },
    async executeLanguageServer(request) {
      return { result: { operation: request.operation }, supported: true };
    },
    error(error) {
      return { code: 'TEST', message: error instanceof Error ? error.message : 'failed' };
    },
  });

  {
    const forwardedScopes: Array<[string | undefined, string | undefined]> = [];
    const previewHandlers = createWebSocketWorkspaceRequestHandlers<TestClient>({
      openState: OPEN,
      maxMessageBytes: 1024,
      async executeWorkspace(_request, accessMode, _signal, previewScopeId) {
        forwardedScopes.push([accessMode, previewScopeId]);
        return { previewScopeId };
      },
      async executeLanguageServer() { return { result: null }; },
      error(error) { return { code: 'TEST', message: error instanceof Error ? error.message : 'failed' }; },
    });
    const viewerA = client({ accessMode: 'read-only', previewScopeId: 'token-scope-a' });
    const viewerB = client({ accessMode: 'read-only', previewScopeId: 'token-scope-b' });
    previewHandlers.workspaceRequest(viewerA, {
      type: 'workspace-request',
      requestId: 'preview-a',
      request: { operation: 'create-preview', rootId: 'root-a', path: 'index.html' },
    });
    previewHandlers.workspaceRequest(viewerB, {
      type: 'workspace-request',
      requestId: 'preview-b',
      request: { operation: 'delete-preview', previewId: 'preview-a' },
    });
    await flush();
    assert.deepStrictEqual(forwardedScopes, [
      ['read-only', 'token-scope-a'],
      ['read-only', 'token-scope-b'],
    ]);
    assert.strictEqual(
      (viewerA.messages.at(-1)?.result as { previewScopeId?: string }).previewScopeId,
      'token-scope-a',
    );
    assert.strictEqual(
      (viewerB.messages.at(-1)?.result as { previewScopeId?: string }).previewScopeId,
      'token-scope-b',
    );
    previewHandlers.close(viewerA);
    previewHandlers.close(viewerB);
  }

  {
    const socket = client();
    handlers.workspaceRequest(socket, {
      type: 'workspace-request',
      requestId: 'read-1',
      request: { operation: 'read-file', rootId: 'root-a', path: 'a.ts' },
    });
    await flush();
    assert.deepStrictEqual(socket.messages, [{
      type: 'workspace-result', requestId: 'read-1', ok: true, result: { key: 'read-file:root-a' },
    }]);
  }

  {
    const socket = client();
    const gate = deferred<unknown>();
    pending.set('read-file:root-duplicate', gate);
    const message = {
      type: 'workspace-request' as const,
      requestId: 'same-id',
      request: { operation: 'read-file' as const, rootId: 'root-duplicate', path: 'a.ts' },
    };
    handlers.workspaceRequest(socket, message);
    handlers.workspaceRequest(socket, message);
    assert.deepStrictEqual(socket.messages.at(-1), {
      type: 'workspace-result', requestId: 'same-id', ok: false,
      error: { code: 'CONFLICT', message: 'Workspace request ID is already in use', status: 409 },
    });
    handlers.cancel(socket, { type: 'workspace-cancel', requestId: 'same-id' });
    gate.resolve({ ignored: true });
    await flush();
    assert(aborted.includes('read-file:root-duplicate'));
    assert.strictEqual(socket.messages.length, 1, 'cancelled work must not publish a late result');
    pending.delete('read-file:root-duplicate');
  }

  {
    const socket = client();
    const gates = Array.from({ length: 5 }, (_, index) => {
      const gate = deferred<unknown>();
      pending.set(`read-file:limit-${index}`, gate);
      handlers.workspaceRequest(socket, {
        type: 'workspace-request',
        requestId: `limit-${index}`,
        request: { operation: 'read-file', rootId: `limit-${index}`, path: 'a.ts' },
      });
      return gate;
    });
    assert.strictEqual(started.filter(key => key.startsWith('read-file:limit-')).length, 4);
    gates[0].resolve({ index: 0 });
    await flush();
    assert.strictEqual(started.filter(key => key.startsWith('read-file:limit-')).length, 5);
    gates.slice(1).forEach((gate, index) => gate.resolve({ index: index + 1 }));
    await flush();
    handlers.close(socket);
    for (let index = 0; index < 5; index += 1) pending.delete(`read-file:limit-${index}`);
  }

  {
    const socket = client();
    socket.bufferedAmount = 512 * 1024;
    handlers.workspaceRequest(socket, {
      type: 'workspace-request',
      requestId: 'backpressure',
      request: { operation: 'search', rootId: 'root-a', query: 'needle' },
    });
    assert.deepStrictEqual(socket.messages.at(-1), {
      type: 'workspace-result', requestId: 'backpressure', ok: false,
      error: { code: 'BUSY', message: 'Workspace request queue is busy', status: 503 },
    });
  }

  {
    const socket = client();
    const backgroundGates = [deferred<unknown>(), deferred<unknown>()];
    const backgroundStarted: string[] = [];
    const priorityHandlers = createWebSocketWorkspaceRequestHandlers<TestClient>({
      openState: OPEN,
      maxMessageBytes: 1024,
      async executeWorkspace(request) { return { operation: request.operation }; },
      async executeLanguageServer(request) {
        const key = String(request.filePath || request.method);
        backgroundStarted.push(key);
        const index = key === 'background-a.ts' ? 0 : key === 'background-b.ts' ? 1 : -1;
        return { result: index >= 0 ? await backgroundGates[index]!.promise : null };
      },
      error(error) { return { code: 'TEST', message: error instanceof Error ? error.message : 'failed' }; },
    });
    for (const filePath of ['background-a.ts', 'background-b.ts']) {
      priorityHandlers.languageServerRequest(socket, {
        type: 'language-server-request',
        requestId: `language-${filePath}`,
        request: {
          operation: 'request', rootId: 'root-a', filePath, method: 'semanticTokens', priority: 'background',
        },
      });
    }
    assert.deepStrictEqual(backgroundStarted, ['background-a.ts', 'background-b.ts']);
    priorityHandlers.workspaceRequest(socket, {
      type: 'workspace-request',
      requestId: 'foreground-read',
      request: { operation: 'read-file', rootId: 'root-a', path: 'foreground.ts' },
    });
    await flush();
    assert.deepStrictEqual(socket.messages.at(-1), {
      type: 'workspace-result', requestId: 'foreground-read', ok: true, result: { operation: 'read-file' },
    });
    backgroundGates.forEach(gate => gate.resolve(null));
    await flush();
    priorityHandlers.close(socket);
  }

  {
    const socket = client();
    const decorationGates = [deferred<unknown>(), deferred<unknown>()];
    const decorationStarted: string[] = [];
    const priorityHandlers = createWebSocketWorkspaceRequestHandlers<TestClient>({
      openState: OPEN,
      maxMessageBytes: 1024,
      async executeWorkspace(request) {
        if (request.operation !== 'tree-decorations') return { operation: request.operation };
        const index = request.rootId === 'decorations-a' ? 0 : 1;
        decorationStarted.push(request.rootId);
        return decorationGates[index]!.promise;
      },
      async executeLanguageServer() { return { result: null }; },
      error(error) { return { code: 'TEST', message: error instanceof Error ? error.message : 'failed' }; },
    });
    for (const rootId of ['decorations-a', 'decorations-b']) {
      priorityHandlers.workspaceRequest(socket, {
        type: 'workspace-request',
        requestId: rootId,
        request: { operation: 'tree-decorations', rootId, entryPaths: ['src/App.tsx'] },
      });
    }
    assert.deepStrictEqual(decorationStarted, ['decorations-a', 'decorations-b']);
    priorityHandlers.workspaceRequest(socket, {
      type: 'workspace-request',
      requestId: 'foreground-tree',
      request: { operation: 'tree', rootId: 'foreground-tree' },
    });
    await flush();
    assert.deepStrictEqual(socket.messages.at(-1), {
      type: 'workspace-result', requestId: 'foreground-tree', ok: true, result: { operation: 'tree' },
    });
    decorationGates.forEach(gate => gate.resolve({ items: [] }));
    await flush();
    priorityHandlers.close(socket);
  }

  {
    const socket = client();
    handlers.languageServerRequest(socket, {
      type: 'language-server-request',
      requestId: 'language-1',
      request: { operation: 'capability', rootId: 'root-a' },
    });
    await flush();
    assert.deepStrictEqual(socket.messages.at(-1), {
      type: 'language-server-result', requestId: 'language-1', ok: true,
      result: { operation: 'capability' }, supported: true,
    });
  }

  {
    const oversizedHandlers = createWebSocketWorkspaceRequestHandlers<TestClient>({
      openState: OPEN,
      maxMessageBytes: 180,
      async executeWorkspace() { return { content: 'x'.repeat(300) }; },
      async executeLanguageServer() { return { result: null }; },
      error() { return { code: 'TEST', message: 'failed' }; },
    });
    const socket = client();
    oversizedHandlers.workspaceRequest(socket, {
      type: 'workspace-request',
      requestId: 'large',
      request: { operation: 'read-file', rootId: 'root-a', path: 'large.txt' },
    });
    await flush();
    assert.strictEqual(socket.messages.at(-1)?.ok, false);
    assert.deepStrictEqual(socket.messages.at(-1)?.error, {
      code: 'TOO_LARGE', message: 'Workspace result exceeds the inline WebSocket limit', status: 413,
    });
  }

  const observations = performanceRecorder.snapshot().records;
  assert(observations.some(record => record.outcome === 'cancelled'));
  assert(observations.some(record => record.outcome === 'failed'));
  const completed = observations.filter(record => record.outcome === 'completed');
  assert(completed.length > 0);
  for (const record of completed) {
    assert(record.stages.dispatch! <= record.stages.service!);
    assert(record.stages.service! <= record.stages.sent!);
  }
  console.log('WebSocket workspace request handlers passed');
}

run().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
