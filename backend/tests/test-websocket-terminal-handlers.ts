import type {
  InputMessage,
  ResizeAgentMessage,
  TerminalCheckpointRequestMessage,
} from '../../shared/browser-protocol.js';
import type {
  WebSocketTerminalClient,
} from '../websocket-terminal-handlers.cjs';

const assert = require('assert');
const { PROTOCOL_VERSION } = require('../../shared/browser-protocol.js') as typeof import('../../shared/browser-protocol.js');
const { createWebSocketTerminalHandlers } = require('../websocket-terminal-handlers.cjs') as typeof import('../websocket-terminal-handlers.cjs');

interface TestClient extends WebSocketTerminalClient {
  sent: string[];
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

function sent(client: TestClient): Record<string, unknown> {
  assert.strictEqual(client.sent.length, 1);
  return JSON.parse(client.sent[0]);
}

function checkpoint(requestId = 'request-1', agentId = 'agent-1'): TerminalCheckpointRequestMessage {
  return { type: 'terminal-checkpoint-request', requestId, agentId };
}

function input(fields: Partial<InputMessage> = {}): InputMessage {
  return { type: 'input', input: 'hello', ...fields };
}

function resize(fields: Partial<ResizeAgentMessage> = {}): ResizeAgentMessage {
  return { type: 'resize-agent', agentId: 'agent-1', cols: 80, rows: 24, ...fields };
}

async function run(): Promise<void> {
  {
    const handlers = createWebSocketTerminalHandlers({
      openState: 1,
      getAgentSessionView: async () => null,
      sendInput: async () => {},
      requestResize: () => {},
      clearBuffer: async () => {},
      checkpointErrorMessage: () => 'checkpoint failed',
    });
    const ws = client();

    handlers.terminalCheckpointRequest(ws, checkpoint('before-hello', 'agent-before'));

    assert.deepStrictEqual(sent(ws), {
      type: 'protocol-error',
      protocolVersion: PROTOCOL_VERSION,
      requestId: 'before-hello',
      message: 'Terminal checkpoint requires a negotiated Farming protocol',
    });
  }

  {
    const session = { agentId: 'agent-1', outputSeq: 3 };
    const pending = deferred<typeof session>();
    const handlers = createWebSocketTerminalHandlers({
      openState: 1,
      getAgentSessionView: () => pending.promise,
      sendInput: async () => {},
      requestResize: () => {},
      clearBuffer: async () => {},
      checkpointErrorMessage: () => 'checkpoint failed',
    });
    const ws = client({ protocolVersion: PROTOCOL_VERSION });

    handlers.terminalCheckpointRequest(ws, checkpoint('checkpoint-1', 'agent-1'));
    assert.strictEqual(ws.sent.length, 0, 'checkpoint handlers must not await session reads');
    pending.resolve(session);
    await Promise.resolve();

    assert.deepStrictEqual(sent(ws), {
      type: 'terminal-checkpoint-result',
      requestId: 'checkpoint-1',
      agentId: 'agent-1',
      ok: true,
      session,
    });
  }

  {
    const handlers = createWebSocketTerminalHandlers({
      openState: 1,
      getAgentSessionView: async () => null,
      sendInput: async () => {},
      requestResize: () => {},
      clearBuffer: async () => {},
      checkpointErrorMessage: () => 'checkpoint failed',
    });
    const ws = client({ protocolVersion: PROTOCOL_VERSION });

    handlers.terminalCheckpointRequest(ws, checkpoint());
    await Promise.resolve();

    assert.deepStrictEqual(sent(ws), {
      type: 'terminal-checkpoint-result',
      requestId: 'request-1',
      agentId: 'agent-1',
      ok: false,
      error: 'Agent not found',
    });
  }

  {
    const handlers = createWebSocketTerminalHandlers({
      openState: 1,
      getAgentSessionView: async () => {
        throw new Error('private checkpoint failure');
      },
      sendInput: async () => {},
      requestResize: () => {},
      clearBuffer: async () => {},
      checkpointErrorMessage: error => (
        error instanceof Error ? `public: ${error.message}` : 'public checkpoint failure'
      ),
    });
    const ws = client({ protocolVersion: PROTOCOL_VERSION });

    handlers.terminalCheckpointRequest(ws, checkpoint('failed-request', 'failed-agent'));
    await Promise.resolve();

    assert.deepStrictEqual(sent(ws), {
      type: 'terminal-checkpoint-result',
      requestId: 'failed-request',
      agentId: 'failed-agent',
      ok: false,
      error: 'public: private checkpoint failure',
    });
  }

  {
    const pending = deferred<unknown>();
    const handlers = createWebSocketTerminalHandlers({
      openState: 1,
      getAgentSessionView: () => pending.promise,
      sendInput: async () => {},
      requestResize: () => {},
      clearBuffer: async () => {},
      checkpointErrorMessage: () => 'checkpoint failed',
    });
    const ws = client({ protocolVersion: PROTOCOL_VERSION });

    handlers.terminalCheckpointRequest(ws, checkpoint());
    ws.readyState = 3;
    pending.resolve({ agentId: 'agent-1' });
    await Promise.resolve();

    assert.strictEqual(ws.sent.length, 0, 'closed clients must suppress successful checkpoints');
  }

  {
    const pending = deferred<unknown>();
    const handlers = createWebSocketTerminalHandlers({
      openState: 1,
      getAgentSessionView: () => pending.promise,
      sendInput: async () => {},
      requestResize: () => {},
      clearBuffer: async () => {},
      checkpointErrorMessage: () => 'checkpoint failed',
    });
    const ws = client({ protocolVersion: PROTOCOL_VERSION });

    handlers.terminalCheckpointRequest(ws, checkpoint());
    ws.readyState = 3;
    pending.reject(new Error('unavailable'));
    await Promise.resolve();

    assert.strictEqual(ws.sent.length, 0, 'closed clients must suppress failed checkpoints');
  }

  {
    const inputCalls: Array<{ agentId: string; parts: ReturnType<typeof import('../input-parts.cjs').inputPartsFromMessage> }> = [];
    const pendingInput = deferred<void>();
    const handlers = createWebSocketTerminalHandlers({
      openState: 1,
      getAgentSessionView: async () => null,
      sendInput(agentId, parts) {
        inputCalls.push({ agentId, parts });
        return pendingInput.promise;
      },
      requestResize: () => {},
      clearBuffer: async () => {},
      checkpointErrorMessage: () => 'checkpoint failed',
    });
    const ws = client({ agentId: 'started-agent', focusedAgentId: 'focused-agent' });

    handlers.input(ws, input({ agentId: 'explicit-agent', inputParts: ['raw', { type: 'paste', text: 'paste' }] }));
    handlers.input(ws, input());
    ws.focusedAgentId = null;
    handlers.input(ws, input());
    handlers.input(ws, input({ input: undefined }));

    assert.deepStrictEqual(inputCalls, [
      { agentId: 'explicit-agent', parts: ['raw', { type: 'paste', text: 'paste' }] },
      { agentId: 'focused-agent', parts: ['hello'] },
      { agentId: 'started-agent', parts: ['hello'] },
    ]);
    pendingInput.resolve();
    await Promise.resolve();
    assert.strictEqual(inputCalls.length, 3, 'input must not replay after an async send settles');
  }

  {
    const resizeCalls: Array<[string, number, number]> = [];
    const clearCalls: string[] = [];
    const handlers = createWebSocketTerminalHandlers({
      openState: 1,
      getAgentSessionView: async () => null,
      sendInput: async () => {},
      requestResize(agentId, cols, rows) {
        resizeCalls.push([agentId, cols, rows]);
      },
      clearBuffer(agentId) {
        clearCalls.push(agentId);
        return Promise.resolve();
      },
      checkpointErrorMessage: () => 'checkpoint failed',
    });
    const ws = client();

    handlers.resizeAgent(ws, resize({ cols: Number.NaN }));
    handlers.resizeAgent(ws, resize());
    handlers.clearTerminal(ws, { type: 'clear-terminal', agentId: '' });
    handlers.clearTerminal(ws, { type: 'clear-terminal', agentId: 'agent-1' });

    assert.deepStrictEqual(resizeCalls, [['agent-1', 80, 24]]);
    assert.deepStrictEqual(clearCalls, ['agent-1']);
  }

  {
    const handlers = createWebSocketTerminalHandlers({
      openState: 1,
      getAgentSessionView: async () => null,
      sendInput: async () => {},
      requestResize: () => { throw new Error('resize failed'); },
      clearBuffer: () => { throw new Error('clear failed'); },
      checkpointErrorMessage: () => 'checkpoint failed',
    });
    const ws = client();

    assert.throws(() => handlers.resizeAgent(ws, resize()), /resize failed/);
    assert.throws(() => handlers.clearTerminal(ws, { type: 'clear-terminal', agentId: 'agent-1' }), /clear failed/);
  }

  console.log('WebSocket terminal handlers passed');
}

run().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
