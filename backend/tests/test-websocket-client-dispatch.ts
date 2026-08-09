import type { ClientMessage } from '../../shared/browser-protocol.js';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  createClientMessageRegistration,
  defineClientMessageDispatchTable,
  dispatchClientMessage,
} = require('../websocket-client-dispatch.cjs') as typeof import('../websocket-client-dispatch.cjs');
const { reportWebSocketAdmissionFailure } = require('../websocket-admission-errors.cjs') as typeof import('../websocket-admission-errors.cjs');

type ClientMessageByType = {
  [Type in ClientMessage['type']]: Extract<ClientMessage, { type: Type }>;
};

interface DispatchContext {
  asyncGate: Promise<void>;
  calls: string[];
  expectedIdentity: DispatchContext | null;
  interruptAdmission: Promise<void>;
  readyState: number;
  sent: string[];
  send(message: string): void;
  throwOnRestart: boolean;
}

const validClientMessages = {
  'protocol-hello': { type: 'protocol-hello', protocolVersion: 10 },
  'business-health-probe': { type: 'business-health-probe', requestId: 'health-1' },
  'terminal-checkpoint-request': {
    type: 'terminal-checkpoint-request',
    requestId: 'checkpoint-1',
    agentId: 'agent-1',
  },
  'start-agent': { type: 'start-agent', command: 'codex' },
  input: { type: 'input', agentId: 'agent-1', input: 'hello' },
  'composer-input': { type: 'composer-input', agentId: 'agent-1', message: 'hello' },
  'acp-permission-response': {
    type: 'acp-permission-response',
    agentId: 'agent-1',
    requestId: 'permission-1',
    optionId: 'allow',
  },
  'interrupt-agent': { type: 'interrupt-agent', agentId: 'agent-1' },
  'focus-agent': { type: 'focus-agent', agentId: 'agent-1' },
  'resize-agent': { type: 'resize-agent', agentId: 'agent-1', cols: 80, rows: 24 },
  'clear-terminal': { type: 'clear-terminal', agentId: 'agent-1' },
  'watch-workspace-files': { type: 'watch-workspace-files', agentId: 'agent-1' },
  'unwatch-workspace-files': { type: 'unwatch-workspace-files', agentId: 'agent-1' },
  'archive-agent': { type: 'archive-agent', agentId: 'agent-1' },
  'restart-main-agent': { type: 'restart-main-agent', command: 'codex' },
  'state-resync': { type: 'state-resync' },
} satisfies ClientMessageByType;

async function run(): Promise<void> {
  let releaseAsyncGate!: () => void;
  const asyncGate = new Promise<void>(resolve => {
    releaseAsyncGate = resolve;
  });
  const context: DispatchContext = {
    asyncGate,
    calls: [],
    expectedIdentity: null,
    interruptAdmission: Promise.resolve(),
    readyState: 1,
    sent: [],
    send(message) { this.sent.push(message); },
    throwOnRestart: false,
  };
  context.expectedIdentity = context;
  const register = createClientMessageRegistration<DispatchContext>();
  const record = (dispatchContext: DispatchContext, message: ClientMessage) => {
    assert.strictEqual(dispatchContext, dispatchContext.expectedIdentity);
    dispatchContext.calls.push(message.type);
  };
  const table = defineClientMessageDispatchTable<DispatchContext>({
    'protocol-hello': register('protocol-hello', record),
    'business-health-probe': register('business-health-probe', (dispatchContext, message) => {
      record(dispatchContext, message);
      void dispatchContext.asyncGate.then(() => dispatchContext.calls.push('health-finished'));
    }),
    'terminal-checkpoint-request': register('terminal-checkpoint-request', record),
    'start-agent': register('start-agent', record),
    input: register('input', record),
    'composer-input': register('composer-input', record),
    'acp-permission-response': register('acp-permission-response', record),
    'interrupt-agent': register('interrupt-agent', (dispatchContext, message) => {
      record(dispatchContext, message);
      void dispatchContext.interruptAdmission.catch(error => {
        reportWebSocketAdmissionFailure(dispatchContext, error, {
          openState: 1,
          fallbackMessage: 'Failed to interrupt Agent',
        });
      });
    }),
    'focus-agent': register('focus-agent', record),
    'resize-agent': register('resize-agent', record),
    'clear-terminal': register('clear-terminal', record),
    'watch-workspace-files': register('watch-workspace-files', record),
    'unwatch-workspace-files': register('unwatch-workspace-files', record),
    'archive-agent': register('archive-agent', record),
    'restart-main-agent': register('restart-main-agent', (dispatchContext, message) => {
      record(dispatchContext, message);
      if (dispatchContext.throwOnRestart) throw new Error('restart failed synchronously');
    }),
    'state-resync': register('state-resync', record),
  });

  for (const message of Object.values(validClientMessages)) {
    const before = context.calls.length;
    dispatchClientMessage(table, context, message);
    assert.strictEqual(
      context.calls.length,
      before + 1,
      `${message.type} must synchronously hit exactly one same-type handler`,
    );
    assert.strictEqual(context.calls.at(-1), message.type);
  }
  assert.deepStrictEqual(
    context.calls.slice(0, Object.keys(validClientMessages).length),
    Object.keys(validClientMessages),
    'dispatch must preserve caller arrival order',
  );
  assert(!context.calls.includes('health-finished'), 'dispatch must not wait for handler-started async work');
  releaseAsyncGate();
  await asyncGate;
  await Promise.resolve();
  assert.strictEqual(context.calls.at(-1), 'health-finished');

  const unhandled: unknown[] = [];
  const onUnhandled = (error: unknown) => { unhandled.push(error); };
  process.on('unhandledRejection', onUnhandled);
  try {
    context.interruptAdmission = Promise.reject(new Error('interrupt admission rejected'));
    dispatchClientMessage(table, context, validClientMessages['interrupt-agent']);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepStrictEqual(context.sent.map(message => JSON.parse(message)), [{
      type: 'error',
      message: 'interrupt admission rejected',
    }]);
    assert.deepStrictEqual(unhandled, [], 'rejected interrupt admission must be terminally observed');

    context.readyState = 3;
    context.interruptAdmission = Promise.reject(new Error('closed client rejection'));
    dispatchClientMessage(table, context, validClientMessages['interrupt-agent']);
    await new Promise(resolve => setImmediate(resolve));
    assert.strictEqual(context.sent.length, 1, 'closed clients must not receive admission errors');
    assert.deepStrictEqual(unhandled, []);

    context.readyState = 1;
    const originalSend = context.send;
    context.send = () => { throw new Error('socket closed during send'); };
    context.interruptAdmission = Promise.reject(new Error('racing close rejection'));
    dispatchClientMessage(table, context, validClientMessages['interrupt-agent']);
    await new Promise(resolve => setImmediate(resolve));
    context.send = originalSend;
    assert.deepStrictEqual(unhandled, [], 'a send race must not turn a handled admission into another rejection');
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }

  const serverSource = fs.readFileSync(path.join(__dirname, '..', 'server.cts'), 'utf8');
  assert(
    serverSource.includes("import { reportWebSocketAdmissionFailure } from './websocket-admission-errors.cjs'")
      && serverSource.includes('void agentManager.interruptAgent(data.agentId).catch((error: unknown) => {')
      && serverSource.includes('reportWebSocketAdmissionFailure(ws, error, {')
      && serverSource.includes("fallbackMessage: 'Failed to interrupt Agent'"),
    'the production interrupt dispatch must terminally observe rejected admission and report it through the guarded socket helper',
  );

  context.throwOnRestart = true;
  assert.throws(
    () => dispatchClientMessage(table, context, validClientMessages['restart-main-agent']),
    /restart failed synchronously/,
    'synchronous handler errors must propagate to the existing ingress catch',
  );

  const earlyReturnRegistration = register('input', (dispatchContext, message) => {
    dispatchContext.calls.push(`input-start:${message.input}`);
    if (message.input === 'stop') return;
    dispatchContext.calls.push('input-after-return-guard');
  });
  const beforeEarlyReturn = context.calls.length;
  earlyReturnRegistration.dispatch(context, { type: 'input', input: 'stop' });
  assert.deepStrictEqual(
    context.calls.slice(beforeEarlyReturn),
    ['input-start:stop'],
    'registration must add no post-handler behavior after an early return',
  );
  assert.throws(
    () => earlyReturnRegistration.dispatch(context, validClientMessages['focus-agent']),
    /registration mismatch/,
    'a corrupted table entry must fail synchronously instead of calling the wrong handler',
  );

  console.log('typed WebSocket client dispatch passed');
}

run().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
