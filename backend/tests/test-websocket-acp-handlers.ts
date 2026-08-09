import type {
  AcpPermissionResponseMessage,
  ComposerInputMessage,
} from '../../shared/browser-protocol.js';
import type {
  WebSocketAcpClient,
  WebSocketAcpPorts,
} from '../websocket-acp-handlers.cjs';

const assert = require('assert');
const {
  createWebSocketAcpHandlers,
} = require('../websocket-acp-handlers.cjs') as typeof import('../websocket-acp-handlers.cjs');

interface TestClient extends WebSocketAcpClient {
  sent: string[];
}

interface TestAttachment {
  kind: 'audio' | 'image';
  path: string;
  type: string;
}

type TestComposerMessage = ComposerInputMessage & { attachments?: TestAttachment[] };

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

function composer(fields: Partial<TestComposerMessage> = {}): TestComposerMessage {
  return {
    type: 'composer-input',
    agentId: 'agent-1',
    message: 'hello',
    requestId: 'request-1',
    ...fields,
  };
}

function permission(
  fields: Partial<AcpPermissionResponseMessage> = {},
): AcpPermissionResponseMessage {
  return {
    type: 'acp-permission-response',
    agentId: 'agent-1',
    requestId: 'permission-1',
    optionId: 'allow',
    ...fields,
  };
}

function flush(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
}

function deferred<T>() {
  let reject!: (error: unknown) => void;
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function testPorts(overrides: Partial<WebSocketAcpPorts> = {}) {
  const composerCalls: Array<{ agentId: string; content: unknown[]; options: unknown }> = [];
  const permissionCalls: unknown[][] = [];
  const readPaths: string[] = [];
  const ports: WebSocketAcpPorts = {
    openState: 1,
    attachmentsRoot: '/attachments',
    async readAttachment(filePath) {
      readPaths.push(filePath);
      return Buffer.from(filePath);
    },
    agentRuntimeKind() {
      return 'acp';
    },
    async sendComposerMessage(agentId, content, options) {
      composerCalls.push({ agentId, content, options });
    },
    respondToAcpPermission(...args) {
      permissionCalls.push(args);
      return {};
    },
    ...overrides,
  };
  return { composerCalls, permissionCalls, ports, readPaths };
}

async function run(): Promise<void> {
  {
    const harness = testPorts();
    const handlers = createWebSocketAcpHandlers<TestClient>(harness.ports);
    const ws = client({ agentId: 'connection-agent', focusedAgentId: 'focused-agent' });

    handlers.composerInput(ws, composer({
      agentId: 'explicit-agent',
      requestId: '  request-explicit  ',
      delivery: 'steer',
    }));
    await flush();

    assert.deepStrictEqual(harness.composerCalls, [{
      agentId: 'explicit-agent',
      content: [{ type: 'text', text: 'hello' }],
      options: { requestId: 'request-explicit', delivery: 'steer' },
    }]);
    assert.deepStrictEqual(messages(ws), [{
      type: 'composer-input-result',
      requestId: 'request-explicit',
      agentId: 'explicit-agent',
      accepted: true,
    }]);

    handlers.composerInput(ws, composer({ agentId: undefined, requestId: 'focused-request' }));
    await flush();
    assert.strictEqual(harness.composerCalls[1].agentId, 'focused-agent');
    assert.deepStrictEqual(harness.composerCalls[1].options, {
      requestId: 'focused-request',
      delivery: 'auto',
    });

    ws.focusedAgentId = null;
    handlers.composerInput(ws, composer({ agentId: undefined, requestId: 'connection-request' }));
    await flush();
    assert.strictEqual(harness.composerCalls[2].agentId, 'connection-agent');
  }

  {
    const harness = testPorts({
      async readAttachment(filePath) {
        harness.readPaths.push(filePath);
        if (filePath.endsWith('/empty.png')) return Buffer.alloc(0);
        if (filePath.endsWith('/large.png')) return Buffer.alloc(12 * 1024 * 1024 + 1);
        if (filePath.endsWith('/missing.png')) throw new Error('missing');
        return Buffer.from(filePath.endsWith('.mp3') ? 'audio' : 'image');
      },
    });
    const ws = client();
    createWebSocketAcpHandlers<TestClient>(harness.ports).composerInput(ws, composer({
      message: 'inspect media',
      attachments: [
        { kind: 'image', path: '/attachments/..foo/image.jpg', type: 'IMAGE/JPG' },
        { kind: 'audio', path: '/attachments/voice.mp3', type: 'audio/mpeg' },
        { kind: 'image', path: '/outside/image.png', type: 'image/png' },
        { kind: 'image', path: '/attachments/invalid.bmp', type: 'image/bmp' },
        { kind: 'image', path: '/attachments/empty.png', type: 'image/png' },
        { kind: 'image', path: '/attachments/large.png', type: 'image/png' },
        { kind: 'image', path: '/attachments/missing.png', type: 'image/png' },
        { kind: 'audio', path: '/attachments/invalid.aiff', type: 'audio/aiff' },
        { kind: 'image', path: '/attachments/ninth.png', type: 'image/png' },
      ],
    }));
    await flush();

    assert.deepStrictEqual(harness.readPaths, [
      '/attachments/..foo/image.jpg',
      '/attachments/voice.mp3',
      '/attachments/empty.png',
      '/attachments/large.png',
      '/attachments/missing.png',
    ]);
    assert.deepStrictEqual(harness.composerCalls[0].content, [
      { type: 'text', text: 'inspect media' },
      {
        type: 'image',
        data: Buffer.from('image').toString('base64'),
        mimeType: 'image/jpg',
        path: '/attachments/..foo/image.jpg',
        uri: 'file:///attachments/..foo/image.jpg',
      },
      {
        type: 'audio',
        data: Buffer.from('audio').toString('base64'),
        mimeType: 'audio/mpeg',
        path: '/attachments/voice.mp3',
        uri: 'file:///attachments/voice.mp3',
      },
    ]);
    assert.deepStrictEqual(messages(ws), [{
      type: 'composer-input-result',
      requestId: 'request-1',
      agentId: 'agent-1',
      accepted: true,
    }]);
  }

  {
    const invalidRequest = testPorts();
    const invalidWs = client();
    createWebSocketAcpHandlers<TestClient>(invalidRequest.ports).composerInput(
      invalidWs,
      composer({ requestId: 'bad request' }),
    );
    await flush();
    assert.strictEqual(invalidRequest.composerCalls.length, 0);
    assert.deepStrictEqual(messages(invalidWs), [{
      type: 'composer-input-result',
      requestId: 'bad request',
      agentId: 'agent-1',
      accepted: false,
      message: 'Structured Composer input requires a valid requestId',
    }]);

    const missingRequest = testPorts();
    const missingRequestWs = client();
    createWebSocketAcpHandlers<TestClient>(missingRequest.ports).composerInput(
      missingRequestWs,
      composer({ requestId: undefined }),
    );
    await flush();
    assert.strictEqual(missingRequest.composerCalls.length, 0);
    assert.deepStrictEqual(messages(missingRequestWs), [{
      type: 'composer-input-result',
      requestId: 'invalid-request',
      agentId: 'agent-1',
      accepted: false,
      message: 'Structured Composer input requires a valid requestId',
    }]);

    const empty = testPorts();
    const emptyWs = client();
    createWebSocketAcpHandlers<TestClient>(empty.ports).composerInput(
      emptyWs,
      composer({ message: '   ' }),
    );
    await flush();
    assert.strictEqual(empty.composerCalls.length, 0);
    assert.deepStrictEqual(messages(emptyWs), [{
      type: 'composer-input-result',
      requestId: 'request-1',
      agentId: 'agent-1',
      accepted: false,
      message: 'Composer message is empty',
    }]);

    const malformed = testPorts();
    const malformedWs = client();
    const malformedMessage = {
      type: 'composer-input',
      agentId: 'agent-1',
      requestId: 'malformed-request',
      attachments: [
        { kind: 'image', path: '/attachments', type: 'image/png' },
        { kind: 'image', path: '/attachments-sibling/image.png', type: 'image/png' },
        { kind: 'document', path: '/attachments/file.pdf', type: 'application/pdf' },
        { kind: 'image', path: 42, type: 'image/png' },
        { kind: 'audio', path: '/attachments/file.mp3', type: 42 },
      ],
    } as unknown as TestComposerMessage;
    createWebSocketAcpHandlers<TestClient>(malformed.ports).composerInput(
      malformedWs,
      malformedMessage,
    );
    await flush();
    assert.deepStrictEqual(malformed.readPaths, [], 'sibling-prefix and malformed attachments stay outside file I/O');
    assert.strictEqual(malformed.composerCalls.length, 0);
    assert.deepStrictEqual(messages(malformedWs), [{
      type: 'composer-input-result',
      requestId: 'malformed-request',
      agentId: 'agent-1',
      accepted: false,
      message: 'Composer message is empty',
    }]);

    const terminal = testPorts({ agentRuntimeKind: () => 'terminal' });
    const terminalWs = client();
    createWebSocketAcpHandlers<TestClient>(terminal.ports).composerInput(terminalWs, composer());
    await flush();
    assert.strictEqual(terminal.composerCalls.length, 0);
    assert.deepStrictEqual(messages(terminalWs), [{
      type: 'composer-input-result',
      requestId: 'request-1',
      agentId: 'agent-1',
      accepted: false,
      message: 'Terminal Composer input requires the active terminal owner',
    }]);

    const noTarget = testPorts();
    const noTargetWs = client();
    createWebSocketAcpHandlers<TestClient>(noTarget.ports).composerInput(
      noTargetWs,
      composer({ agentId: undefined }),
    );
    await flush();
    assert.strictEqual(noTarget.composerCalls.length, 0);
    assert.deepStrictEqual(messages(noTargetWs), []);
  }

  {
    const definitive = testPorts({
      async sendComposerMessage() {
        throw new Error('definitive failure');
      },
    });
    const definitiveWs = client();
    createWebSocketAcpHandlers<TestClient>(definitive.ports).composerInput(definitiveWs, composer());
    await flush();
    assert.deepStrictEqual(messages(definitiveWs), [{
      type: 'composer-input-result',
      requestId: 'request-1',
      agentId: 'agent-1',
      accepted: false,
      message: 'definitive failure',
    }]);

    let attempts = 0;
    const uncertainError = Object.assign(new Error('outcome unknown'), { uncertain: true });
    const uncertain = testPorts({
      async sendComposerMessage() {
        attempts += 1;
        throw uncertainError;
      },
    });
    const uncertainWs = client();
    createWebSocketAcpHandlers<TestClient>(uncertain.ports).composerInput(uncertainWs, composer());
    await flush();
    assert.strictEqual(attempts, 1, 'an uncertain Composer outcome must never be replayed');
    assert.deepStrictEqual(messages(uncertainWs), [{
      type: 'composer-input-result',
      requestId: 'request-1',
      agentId: 'agent-1',
      accepted: false,
      message: 'outcome unknown',
      uncertain: true,
    }]);
  }

  {
    const first = deferred<void>();
    const second = deferred<void>();
    const harness = testPorts({
      sendComposerMessage(agentId) {
        return agentId === 'first-agent' ? first.promise : second.promise;
      },
    });
    const handlers = createWebSocketAcpHandlers<TestClient>(harness.ports);
    const firstWs = client();
    const secondWs = client();
    handlers.composerInput(firstWs, composer({ agentId: 'first-agent', requestId: 'first-request' }));
    handlers.composerInput(secondWs, composer({ agentId: 'second-agent', requestId: 'second-request' }));
    second.resolve();
    await flush();
    first.resolve();
    await flush();
    assert.deepStrictEqual(messages(firstWs), [{
      type: 'composer-input-result',
      requestId: 'first-request',
      agentId: 'first-agent',
      accepted: true,
    }]);
    assert.deepStrictEqual(messages(secondWs), [{
      type: 'composer-input-result',
      requestId: 'second-request',
      agentId: 'second-agent',
      accepted: true,
    }]);
  }

  {
    const attachmentRead = deferred<Buffer>();
    const harness = testPorts({ readAttachment: () => attachmentRead.promise });
    const ws = client({ focusedAgentId: 'focused-at-admission' });
    createWebSocketAcpHandlers<TestClient>(harness.ports).composerInput(ws, composer({
      agentId: undefined,
      message: '',
      requestId: 'focus-fence',
      attachments: [{ kind: 'image', path: '/attachments/image.png', type: 'image/png' }],
    }));
    ws.focusedAgentId = 'focused-after-admission';
    attachmentRead.resolve(Buffer.from('image'));
    await flush();
    assert.strictEqual(
      harness.composerCalls[0].agentId,
      'focused-at-admission',
      'connection-local focus is captured before attachment I/O and cannot retarget an admitted mutation',
    );
    assert.deepStrictEqual(messages(ws), [{
      type: 'composer-input-result',
      requestId: 'focus-fence',
      agentId: 'focused-at-admission',
      accepted: true,
    }]);
  }

  {
    const unhandled: unknown[] = [];
    const onUnhandled = (error: unknown) => unhandled.push(error);
    process.on('unhandledRejection', onUnhandled);
    try {
      const pending = deferred<void>();
      const harness = testPorts({ sendComposerMessage: () => pending.promise });
      const closedWs = client();
      createWebSocketAcpHandlers<TestClient>(harness.ports).composerInput(closedWs, composer());
      closedWs.readyState = 3;
      pending.resolve();
      await flush();
      assert.deepStrictEqual(messages(closedWs), []);

      const racing = testPorts();
      const racingWs = client({ send: () => { throw new Error('closed during ack'); } });
      createWebSocketAcpHandlers<TestClient>(racing.ports).composerInput(racingWs, composer());
      await flush();
      assert.deepStrictEqual(unhandled, []);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  }

  {
    const harness = testPorts();
    const ws = client();
    createWebSocketAcpHandlers<TestClient>(harness.ports).acpPermissionResponse(
      ws,
      permission({ cancelled: true }),
    );
    await flush();
    assert.deepStrictEqual(harness.permissionCalls, [[
      'agent-1',
      'permission-1',
      'allow',
      true,
    ]]);
    assert.deepStrictEqual(messages(ws), [], 'successful permission responses have no WebSocket ack');
  }

  {
    const unhandled: unknown[] = [];
    const onUnhandled = (error: unknown) => unhandled.push(error);
    process.on('unhandledRejection', onUnhandled);
    try {
      const synchronous = testPorts({
        respondToAcpPermission() {
          throw new Error('permission rejected synchronously');
        },
      });
      const synchronousWs = client();
      createWebSocketAcpHandlers<TestClient>(synchronous.ports).acpPermissionResponse(
        synchronousWs,
        permission(),
      );
      assert.deepStrictEqual(messages(synchronousWs), [{
        type: 'error',
        message: 'permission rejected synchronously',
      }]);

      const asynchronous = testPorts({
        respondToAcpPermission() {
          return Promise.reject(new Error('permission rejected asynchronously'));
        },
      });
      const asynchronousWs = client();
      createWebSocketAcpHandlers<TestClient>(asynchronous.ports).acpPermissionResponse(
        asynchronousWs,
        permission(),
      );
      await flush();
      assert.deepStrictEqual(messages(asynchronousWs), [{
        type: 'error',
        message: 'permission rejected asynchronously',
      }]);

      const racingWs = client({ send: () => { throw new Error('closed during permission error'); } });
      createWebSocketAcpHandlers<TestClient>(asynchronous.ports).acpPermissionResponse(
        racingWs,
        permission(),
      );
      await flush();
      assert.deepStrictEqual(unhandled, []);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  }

  console.log('WebSocket ACP handlers passed');
}

run().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
