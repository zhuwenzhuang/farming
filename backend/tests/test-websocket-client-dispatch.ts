import type { ClientMessage } from '../../shared/browser-protocol.js';

const assert = require('assert');
const {
  createClientMessageRegistration,
  defineClientMessageDispatchTable,
  dispatchClientMessage,
} = require('../websocket-client-dispatch.cjs') as typeof import('../websocket-client-dispatch.cjs');

type ClientMessageByType = {
  [Type in ClientMessage['type']]: Extract<ClientMessage, { type: Type }>;
};

interface DispatchContext {
  asyncGate: Promise<void>;
  calls: string[];
  expectedIdentity: DispatchContext | null;
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
    'interrupt-agent': register('interrupt-agent', record),
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
