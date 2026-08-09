import type { ClientMessage } from '../../shared/browser-protocol.js';
import type {
  WebSocketAgentLifecycleClient,
  WebSocketAgentLifecyclePorts,
} from '../websocket-agent-lifecycle-handlers.cjs';

const assert = require('assert');
const {
  createWebSocketAgentLifecycleHandlers,
} = require('../websocket-agent-lifecycle-handlers.cjs') as typeof import('../websocket-agent-lifecycle-handlers.cjs');

type StartMessage = Extract<ClientMessage, { type: 'start-agent' }>;

interface TestClient extends WebSocketAgentLifecycleClient {
  sent: string[];
}

function client(overrides: Partial<TestClient> = {}): TestClient {
  const value: TestClient = {
    readyState: 1,
    sent: [],
    send(data) {
      value.sent.push(data);
    },
    ...overrides,
  };
  return value;
}

function messages(ws: TestClient): Array<Record<string, unknown>> {
  return ws.sent.map(value => JSON.parse(value));
}

function startMessage(fields: Partial<StartMessage> = {}): StartMessage {
  return { type: 'start-agent', command: 'codex', ...fields };
}

function flush(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
}

function testPorts(overrides: Partial<WebSocketAgentLifecyclePorts> = {}) {
  const calls: string[] = [];
  const ports: WebSocketAgentLifecyclePorts = {
    openState: 1,
    async canonicalProjectWorkspace(workspace) {
      calls.push(`canonical:${workspace || ''}`);
      return workspace ? `/canonical${workspace}` : '';
    },
    async startAgent(_command, _workspace, _callback, _options) {},
    mountProjectWorkspace(workspace) {
      calls.push(`mount:${workspace}`);
    },
    async archiveAgent(agentId) {
      calls.push(`archive:${agentId}`);
      return {};
    },
    async interruptAgent(agentId) {
      calls.push(`interrupt:${agentId}`);
    },
    getAgentState() {
      return { agents: [], mainAgentId: null };
    },
    async killAgent(agentId) {
      calls.push(`kill:${agentId}`);
      return {};
    },
    publishAgentState() {
      calls.push('publish');
    },
    revealAgentState() {
      calls.push('reveal');
    },
    warnStartCompletionFailure(agentId) {
      calls.push(`warn:${agentId}`);
    },
    ...overrides,
  };
  return { calls, ports };
}

async function run(): Promise<void> {
  {
    let callback: Parameters<WebSocketAgentLifecyclePorts['startAgent']>[2] | null = null;
    let received: Parameters<WebSocketAgentLifecyclePorts['startAgent']> | null = null;
    const { calls, ports } = testPorts({
      startAgent(...args) {
        received = args;
        callback = args[2];
        return Promise.resolve();
      },
    });
    const handlers = createWebSocketAgentLifecycleHandlers<TestClient>(ports);
    const ws = client();

    handlers.startAgent(ws, startMessage({
      workspace: '/repo',
      projectWorkspace: '/project',
      requestId: 'create-1',
      task: 'task',
      workflowTemplate: 'workflow',
      customTitle: 'title',
      codexApprovalMode: 'full-auto',
      providerHomeId: 'home-1',
      acpHistoryMode: 'resume',
      additionalDirectories: ['/extra'],
      mcpServers: [{ name: 'mcp' }],
      dangerouslySkipPermissions: true,
    }));
    await flush();

    assert(received);
    assert.strictEqual(received[0], 'codex');
    assert.strictEqual(received[1], '/repo');
    assert.deepStrictEqual(received[3], {
      wantsMain: false,
      projectWorkspace: '/canonical/project',
      task: 'task',
      workflowTemplate: 'workflow',
      customTitle: 'title',
      createRequestId: 'create-1',
      codexApprovalMode: 'full-auto',
      agentRuntimeMode: 'terminal',
      acpHistoryMode: 'resume',
      providerHomeId: 'home-1',
      additionalDirectories: ['/extra'],
      mcpServers: [{ name: 'mcp' }],
      dangerouslySkipPermissions: true,
    });
    assert.deepStrictEqual(calls, ['canonical:/project']);

    assert(callback);
    callback('agent-1');
    await flush();
    assert.strictEqual(ws.agentId, 'agent-1');
    assert.deepStrictEqual(calls, ['canonical:/project', 'mount:/canonical/project', 'publish']);
    assert.deepStrictEqual(messages(ws), [{ type: 'agent-started', agentId: 'agent-1' }]);
  }

  {
    let canonicalCalls = 0;
    let options: Parameters<WebSocketAgentLifecyclePorts['startAgent']>[3] | null = null;
    const { ports } = testPorts({
      async canonicalProjectWorkspace() {
        canonicalCalls += 1;
        return '/unexpected';
      },
      startAgent(_command, _workspace, callback, receivedOptions) {
        options = receivedOptions;
        callback('main-1');
        return Promise.resolve();
      },
    });
    const ws = client();
    createWebSocketAgentLifecycleHandlers<TestClient>(ports).startAgent(
      ws,
      startMessage({ asMain: true, workspace: '/ignored' }),
    );
    await flush();
    assert.strictEqual(canonicalCalls, 0, 'Main starts must not canonicalize a Project workspace');
    assert.strictEqual(options?.projectWorkspace, '');
  }

  {
    let complete: Parameters<WebSocketAgentLifecyclePorts['startAgent']>[2] | null = null;
    const { calls, ports } = testPorts({
      startAgent(_command, _workspace, callback, options) {
        complete = callback;
        options.onAgentRegistered?.('chat-1');
        return Promise.resolve();
      },
    });
    const ws = client();
    createWebSocketAgentLifecycleHandlers<TestClient>(ports).startAgent(
      ws,
      startMessage({ agentRuntimeMode: 'chat', workspace: '/repo' }),
    );
    await flush();
    assert.strictEqual(ws.agentId, 'chat-1');
    assert.deepStrictEqual(calls, ['canonical:/repo', 'reveal']);
    assert.deepStrictEqual(messages(ws), [{ type: 'agent-started', agentId: 'chat-1' }]);

    complete?.('chat-1');
    await flush();
    assert.deepStrictEqual(calls, ['canonical:/repo', 'reveal', 'mount:/canonical/repo', 'publish']);
    assert.strictEqual(messages(ws).length, 2, 'Chat registration reveal and completed start remain distinct transitions');
  }

  {
    const unhandled: unknown[] = [];
    const onUnhandled = (error: unknown) => unhandled.push(error);
    process.on('unhandledRejection', onUnhandled);
    try {
      const { ports } = testPorts({
        startAgent() {
          return Promise.reject(new Error('start admission rejected'));
        },
      });
      const ws = client();
      createWebSocketAgentLifecycleHandlers<TestClient>(ports).startAgent(ws, startMessage());
      await flush();
      assert.deepStrictEqual(messages(ws), [{ type: 'error', message: 'start admission rejected' }]);

      const callbackFailure = testPorts({
        startAgent(_command, _workspace, callback) {
          callback(null, 'callback failure');
          return Promise.reject(new Error('same rejected admission'));
        },
      });
      const callbackWs = client();
      createWebSocketAgentLifecycleHandlers<TestClient>(callbackFailure.ports).startAgent(
        callbackWs,
        startMessage(),
      );
      await flush();
      assert.deepStrictEqual(messages(callbackWs), [{ type: 'error', message: 'callback failure' }]);
      assert.deepStrictEqual(unhandled, []);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  }

  {
    const { ports } = testPorts({
      async canonicalProjectWorkspace() {
        throw new Error('canonical failed');
      },
    });
    const ws = client();
    createWebSocketAgentLifecycleHandlers<TestClient>(ports).startAgent(ws, startMessage());
    await flush();
    assert.deepStrictEqual(messages(ws), [{ type: 'error', message: 'canonical failed' }]);
  }

  {
    let rollbackOptions: Record<string, unknown> | undefined;
    const { calls, ports } = testPorts({
      startAgent(_command, _workspace, callback) {
        callback('rollback-agent');
        return Promise.resolve();
      },
      mountProjectWorkspace() {
        throw new Error('mount failed');
      },
      async archiveAgent(agentId, options) {
        calls.push(`archive:${agentId}`);
        rollbackOptions = options;
        return { error: 'engine retained' };
      },
    });
    const ws = client();
    createWebSocketAgentLifecycleHandlers<TestClient>(ports).startAgent(
      ws,
      startMessage({ workspace: '/repo' }),
    );
    await flush();
    assert.deepStrictEqual(rollbackOptions, {
      reason: 'project-mount-failed',
      recordHistory: false,
      requireEngineExit: true,
      scheduleProviderArchive: false,
    });
    assert.deepStrictEqual(calls, ['canonical:/repo', 'archive:rollback-agent', 'publish']);
    assert.deepStrictEqual(messages(ws), [{
      type: 'error',
      message: 'mount failed. Rollback failed: engine retained',
    }]);
    assert.strictEqual(ws.agentId, undefined, 'a failed Project mount must not commit socket ownership');
  }

  {
    const callbacks: Array<Parameters<WebSocketAgentLifecyclePorts['startAgent']>[2]> = [];
    const { ports } = testPorts({
      startAgent(_command, _workspace, callback) {
        callbacks.push(callback);
        return Promise.resolve();
      },
    });
    const handlers = createWebSocketAgentLifecycleHandlers<TestClient>(ports);
    const first = client();
    const second = client();
    handlers.startAgent(first, startMessage({ workspace: '/first' }));
    handlers.startAgent(second, startMessage({ workspace: '/second' }));
    await flush();
    callbacks[1]('second-agent');
    await flush();
    callbacks[0]('first-agent');
    await flush();
    assert.strictEqual(first.agentId, 'first-agent');
    assert.strictEqual(second.agentId, 'second-agent');
  }

  {
    const unhandled: unknown[] = [];
    const onUnhandled = (error: unknown) => unhandled.push(error);
    process.on('unhandledRejection', onUnhandled);
    try {
      const { ports } = testPorts({
        async interruptAgent() {
          throw new Error('interrupt rejected');
        },
      });
      const ws = client();
      createWebSocketAgentLifecycleHandlers<TestClient>(ports).interruptAgent(
        ws,
        { type: 'interrupt-agent', agentId: 'agent-1' },
      );
      await flush();
      assert.deepStrictEqual(messages(ws), [{ type: 'error', message: 'interrupt rejected' }]);

      const synchronous = testPorts({
        interruptAgent() {
          throw new Error('interrupt threw synchronously');
        },
      });
      const synchronousWs = client();
      createWebSocketAgentLifecycleHandlers<TestClient>(synchronous.ports).interruptAgent(
        synchronousWs,
        { type: 'interrupt-agent', agentId: 'agent-sync' },
      );
      assert.deepStrictEqual(messages(synchronousWs), [{
        type: 'error',
        message: 'interrupt threw synchronously',
      }]);

      const racing = client({ send: () => { throw new Error('closed during send'); } });
      createWebSocketAgentLifecycleHandlers<TestClient>(ports).interruptAgent(
        racing,
        { type: 'interrupt-agent', agentId: 'agent-2' },
      );
      await flush();
      assert.deepStrictEqual(unhandled, []);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  }

  {
    const archiveFailure = testPorts({
      async archiveAgent() {
        return { error: 'cannot archive' };
      },
    });
    const ws = client();
    createWebSocketAgentLifecycleHandlers<TestClient>(archiveFailure.ports).archiveAgent(
      ws,
      { type: 'archive-agent', agentId: 'agent-1' },
    );
    await flush();
    assert.deepStrictEqual(messages(ws), [{ type: 'error', message: 'cannot archive' }]);
    assert.deepStrictEqual(archiveFailure.calls, ['publish']);

    const archiveThrow = testPorts({
      async archiveAgent() {
        throw new Error('archive threw');
      },
    });
    const throwWs = client();
    createWebSocketAgentLifecycleHandlers<TestClient>(archiveThrow.ports).archiveAgent(
      throwWs,
      { type: 'archive-agent', agentId: 'agent-2' },
    );
    await flush();
    assert.deepStrictEqual(messages(throwWs), [{ type: 'error', message: 'archive threw' }]);
    assert.deepStrictEqual(archiveThrow.calls, ['publish']);
  }

  {
    const invalid = testPorts();
    const invalidWs = client();
    createWebSocketAgentLifecycleHandlers<TestClient>(invalid.ports).restartMainAgent(
      invalidWs,
      { type: 'restart-main-agent', command: 'rm -rf' },
    );
    assert.deepStrictEqual(messages(invalidWs), [{
      type: 'error',
      message: 'Unsupported Main Agent restart command',
    }]);

    let startCommand = '';
    const restart = testPorts({
      getAgentState() {
        return {
          agents: [{ id: 'other' }, { id: 'main-by-flag', isMain: true }],
          mainAgentId: 'missing-main-id',
        };
      },
      startAgent(command, _workspace, callback) {
        startCommand = command;
        callback('new-main');
        return Promise.resolve();
      },
    });
    const restartWs = client();
    createWebSocketAgentLifecycleHandlers<TestClient>(restart.ports).restartMainAgent(
      restartWs,
      { type: 'restart-main-agent', command: ' qoder ' },
    );
    await flush();
    assert.strictEqual(startCommand, 'qoder');
    assert.strictEqual(restartWs.agentId, 'new-main');
    assert.deepStrictEqual(restart.calls, ['kill:main-by-flag', 'publish']);
    assert.deepStrictEqual(messages(restartWs), [{ type: 'agent-started', agentId: 'new-main' }]);

    let started = false;
    const killFailure = testPorts({
      getAgentState() {
        return { agents: [{ id: 'main' }], mainAgentId: 'main' };
      },
      async killAgent() {
        return { error: 'kill failed' };
      },
      async startAgent() {
        started = true;
      },
    });
    const killFailureWs = client();
    createWebSocketAgentLifecycleHandlers<TestClient>(killFailure.ports).restartMainAgent(
      killFailureWs,
      { type: 'restart-main-agent', command: 'codex' },
    );
    await flush();
    assert.strictEqual(started, false);
    assert.deepStrictEqual(messages(killFailureWs), [{ type: 'error', message: 'kill failed' }]);

    const startFailure = testPorts({
      startAgent() {
        return Promise.reject(new Error('restart start rejected'));
      },
    });
    const startFailureWs = client();
    createWebSocketAgentLifecycleHandlers<TestClient>(startFailure.ports).restartMainAgent(
      startFailureWs,
      { type: 'restart-main-agent', command: 'claude' },
    );
    await flush();
    assert.deepStrictEqual(messages(startFailureWs), [{
      type: 'error',
      message: 'restart start rejected',
    }]);
    assert.deepStrictEqual(startFailure.calls, ['publish']);

    const callbackThenReject = testPorts({
      startAgent(_command, _workspace, callback) {
        callback(null, 'restart callback failure');
        return Promise.reject(new Error('restart rethrow'));
      },
    });
    const callbackThenRejectWs = client();
    createWebSocketAgentLifecycleHandlers<TestClient>(callbackThenReject.ports).restartMainAgent(
      callbackThenRejectWs,
      { type: 'restart-main-agent', command: 'qwen' },
    );
    await flush();
    assert.deepStrictEqual(messages(callbackThenRejectWs), [{
      type: 'error',
      message: 'restart callback failure',
    }]);
    assert.deepStrictEqual(
      callbackThenReject.calls,
      [],
      'a callback-reported restart rejection must not publish or report a second failure',
    );

    const successThenReject = testPorts({
      startAgent(_command, _workspace, callback) {
        callback('new-main-before-rethrow');
        return Promise.reject(new Error('restart success rethrow'));
      },
    });
    const successThenRejectWs = client();
    createWebSocketAgentLifecycleHandlers<TestClient>(successThenReject.ports).restartMainAgent(
      successThenRejectWs,
      { type: 'restart-main-agent', command: 'zsh' },
    );
    await flush();
    assert.deepStrictEqual(messages(successThenRejectWs), [{
      type: 'agent-started',
      agentId: 'new-main-before-rethrow',
    }]);
    assert.deepStrictEqual(
      successThenReject.calls,
      ['publish'],
      'a successful callback followed by a rejected Promise must retain one committed publish',
    );
  }

  {
    const { ports } = testPorts({
      startAgent(_command, _workspace, callback) {
        callback('closed-agent');
        return Promise.resolve();
      },
    });
    const ws = client({ readyState: 3, send: () => { throw new Error('must not send'); } });
    createWebSocketAgentLifecycleHandlers<TestClient>(ports).startAgent(ws, startMessage());
    await flush();
    assert.strictEqual(ws.agentId, 'closed-agent', 'the backend start result remains authoritative after disconnect');
  }

  console.log('WebSocket Agent lifecycle handlers passed');
}

run().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
