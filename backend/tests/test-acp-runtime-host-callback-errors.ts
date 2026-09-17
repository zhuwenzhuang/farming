const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

import type { Socket } from 'node:net';

const { AcpRuntimeHostClient } = require('../acp-runtime-host-client.cts');
const { AcpRuntimeHostProcess } = require('../acp-runtime-host-process.cts');

type UnknownRecord = Record<string, unknown>;
type WriteCallback = (error?: Error | null) => void;

interface WriteInstrumentation {
  chunks: string[];
  syncError: Error | null;
  asyncError: Error | null;
  /**
   * Method whose frames are recorded and never handed to the transport, which
   * is the only deterministic way to lose one specific reply.
   */
  dropMethod: string | null;
  dropped: UnknownRecord[];
  restore(): void;
}

function frameMethod(text: string): string {
  try {
    return String((JSON.parse(text) as UnknownRecord).method || '');
  } catch {
    return '';
  }
}

class FakeRuntime extends EventEmitter {
  sessions: Map<string, UnknownRecord> = new Map();

  bindingEpoch(agentId: string): string {
    return String(this.sessions.get(agentId)?.bindingEpoch || '');
  }

  getSession(agentId: string): UnknownRecord {
    return { ...(this.sessions.get(agentId) || {}) };
  }

  async prepareAgent(options: UnknownRecord): Promise<UnknownRecord> {
    const session = {
      agentId: String(options.agentId || ''),
      bindingEpoch: String(options.capabilityRuntimeEpoch || ''),
      sessionId: String(options.sessionId || ''),
      state: 'idle',
      revision: 1,
    };
    this.sessions.set(session.agentId, session);
    this.emit('agent-runtime', session);
    return { sessionId: session.sessionId, historyMode: 'load' };
  }

  async dispose(): Promise<void> {}
}

/**
 * Narrow write instrumentation for the Controller socket. It records the exact
 * bytes the client handed to the transport and can inject a synchronous throw
 * or an asynchronous write error, which a healthy local socket cannot produce.
 */
function instrumentSocketWrite(socket: Socket): WriteInstrumentation {
  const original = socket.write.bind(socket) as (chunk: string, callback?: WriteCallback) => boolean;
  const instrumentation: WriteInstrumentation = {
    chunks: [],
    syncError: null,
    asyncError: null,
    dropMethod: null,
    dropped: [],
    restore() {
      (socket as unknown as { write: unknown }).write = original;
    },
  };
  (socket as unknown as { write: unknown }).write = (
    chunk: unknown,
    encodingOrCallback?: unknown,
    maybeCallback?: unknown,
  ): boolean => {
    const text = typeof chunk === 'string' ? chunk : String(chunk);
    instrumentation.chunks.push(text);
    if (instrumentation.dropMethod && frameMethod(text) === instrumentation.dropMethod) {
      instrumentation.dropped.push(JSON.parse(text) as UnknownRecord);
      return true;
    }
    const callback: WriteCallback | undefined = typeof encodingOrCallback === 'function'
      ? encodingOrCallback as WriteCallback
      : (typeof maybeCallback === 'function' ? maybeCallback as WriteCallback : undefined);
    if (instrumentation.syncError) throw instrumentation.syncError;
    if (instrumentation.asyncError) {
      const error = instrumentation.asyncError;
      setImmediate(() => callback?.(error));
      return true;
    }
    return callback ? original(text, callback) : original(text);
  };
  return instrumentation;
}

async function startHostPair(prefix: string, clientOptions: UnknownRecord = {}): Promise<{
  configDir: string;
  host: InstanceType<typeof AcpRuntimeHostProcess>;
  controller: InstanceType<typeof AcpRuntimeHostClient>;
  hostLines: string[];
  dispose(): Promise<void>;
}> {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const socketPath = path.join(configDir, 'host.sock');
  const host = new AcpRuntimeHostProcess({
    configDir,
    socketPath,
    runtime: new FakeRuntime(),
    exitOnShutdown: false,
  });
  let controller: InstanceType<typeof AcpRuntimeHostClient> | null = null;
  const hostLines: string[] = [];
  try {
    await host.start();
    controller = new AcpRuntimeHostClient({
      configDir,
      socketPath,
      connectRetries: 20,
      connectRetryMs: 10,
      ...clientOptions,
    });
    await controller.ensureConnected();
    const rawSocket = controller.socket as Socket;
    let rawBuffer = '';
    rawSocket.on('data', (chunk: Buffer) => {
      rawBuffer += chunk.toString('utf8');
      let newline = rawBuffer.indexOf('\n');
      while (newline >= 0) {
        hostLines.push(rawBuffer.slice(0, newline));
        rawBuffer = rawBuffer.slice(newline + 1);
        newline = rawBuffer.indexOf('\n');
      }
    });
  } catch (error) {
    controller?.disconnect();
    await host.dispose();
    fs.rmSync(configDir, { recursive: true, force: true });
    throw error;
  }
  const connected = controller;
  return {
    configDir,
    host,
    controller: connected,
    hostLines,
    async dispose() {
      connected.disconnect();
      await host.dispose();
      fs.rmSync(configDir, { recursive: true, force: true });
    },
  };
}

function circularParams(): UnknownRecord {
  const params: UnknownRecord = { agentId: 'agent-callback-error' };
  params.self = params;
  return params;
}

async function delay(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms));
}

interface TrackedPromise {
  settled: boolean;
  ok: boolean;
  value: unknown;
  message: string;
  uncertain: unknown;
}

/** Observes a promise without changing its outcome; every rejection is handled. */
function track(promise: Promise<unknown>): TrackedPromise {
  const state: TrackedPromise = { settled: false, ok: false, value: undefined, message: '', uncertain: undefined };
  void promise.then(
    value => {
      state.settled = true;
      state.ok = true;
      state.value = value;
    },
    (error: Error & UnknownRecord) => {
      state.settled = true;
      state.message = String(error?.message || error);
      state.uncertain = error?.uncertain;
    },
  );
  return state;
}

interface SectionFailure {
  name: string;
  error: unknown;
}

const failures: SectionFailure[] = [];

async function section(name: string, body: () => Promise<void>): Promise<void> {
  try {
    await body();
    console.log(`ok - ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.error(`FAIL - ${name}`);
    console.error(error instanceof Error ? (error.stack || error.message) : String(error));
  }
}

async function main(): Promise<void> {
  // ---------------------------------------------------------------------------
  // 1) Host -> Controller callback serialization failure must not leave a
  //    pending callback registration or its 30s timer behind.
  // ---------------------------------------------------------------------------
  await section('a circular callback argument releases its registration', async () => {
    const pair = await startHostPair('acp-cb-circ-');
    try {
      const { host, hostLines } = pair;
      const linesBefore = hostLines.length;
      await assert.rejects(
        host.invokeControllerCallback('token-cb', 'agent-cb', 'binding-cb', 'onProcessStarted', [circularParams()]),
        /circular structure/i,
        'a circular callback argument must reject the callback promise',
      );
      assert.strictEqual(
        host.controllerCallbacks.size,
        0,
        'a callback that never reached the transport must not stay registered',
      );
      assert.strictEqual(
        hostLines.length,
        linesBefore,
        'a callback that failed serialization must not write partial wire data',
      );
    } finally {
      await pair.dispose();
    }
  });

  await section('a BigInt callback argument releases its registration', async () => {
    const pair = await startHostPair('acp-cb-big-');
    try {
      const { host, hostLines } = pair;
      const linesBefore = hostLines.length;
      await assert.rejects(
        host.invokeControllerCallback('token-cb', 'agent-cb', 'binding-cb', 'onProcessStarted', [{ pid: 1n }]),
        /BigInt/i,
        'a BigInt callback argument must reject the callback promise',
      );
      assert.strictEqual(
        host.controllerCallbacks.size,
        0,
        'a BigInt callback that never reached the transport must not stay registered',
      );
      assert.strictEqual(hostLines.length, linesBefore, 'a BigInt callback must not write partial wire data');
    } finally {
      await pair.dispose();
    }
  });

  await section('a healthy Controller still serves the next callback', async () => {
    const pair = await startHostPair('acp-cb-next-');
    try {
      const { host, controller, hostLines } = pair;
      let handlerCalls = 0;
      controller.registerCallbackHandlers({
        onProcessStarted: () => {
          handlerCalls += 1;
          return { started: true };
        },
      }, 'token-cb', 'agent-cb');

      await assert.rejects(
        host.invokeControllerCallback('token-cb', 'agent-cb', 'binding-cb', 'onProcessStarted', [circularParams()]),
        /circular structure/i,
      );

      const settled = {
        done: false,
        ok: false,
        value: undefined as unknown,
        message: '',
      };
      const delivered = host.invokeControllerCallback(
        'token-cb',
        'agent-cb',
        'binding-cb',
        'onProcessStarted',
        [{ pid: 4242 }],
      ) as Promise<unknown>;
      void delivered.then(
        value => {
          settled.done = true;
          settled.ok = true;
          settled.value = value;
        },
        (error: Error) => {
          settled.done = true;
          settled.message = String(error?.message || error);
        },
      );
      await waitFor(
        () => settled.done,
        `the next valid callback must settle, observed message=${settled.message}`,
      );
      assert.strictEqual(settled.ok, true, `the next valid callback must resolve: ${settled.message}`);
      assert.deepStrictEqual(settled.value, { started: true });
      assert.strictEqual(handlerCalls, 1, 'the healthy Controller handler must run exactly once');
      const callbackLines = hostLines.filter(line => line.includes('"controller-callback"'));
      assert.strictEqual(
        callbackLines.length,
        1,
        'the failed callback must not be delivered or replayed later',
      );
      const deliveredId = String(
        (JSON.parse(callbackLines[0] || '{}') as { payload?: { callbackId?: string } }).payload?.callbackId || '',
      );
      assert.ok(deliveredId, 'the delivered callback must carry its identity');
      assert.strictEqual(
        host.controllerCallbacks.has(deliveredId),
        false,
        'a resolved callback must release its own registration',
      );
    } finally {
      await pair.dispose();
    }
  });

  // ---------------------------------------------------------------------------
  // 2) Controller -> Host request serialization failure must not leak pending
  //    state, must not write to the wire, and must not poison the connection
  //    later through the timer of a request that was never sent.
  // ---------------------------------------------------------------------------
  await section('request serialization failure cleans pending without wire data', async () => {
    const pair = await startHostPair('acp-req-ser-');
    try {
      const { controller } = pair;
      const socket = controller.socket as Socket;
      const writes = instrumentSocketWrite(socket);
      try {
        // timeoutMs: 0 means the pending entry has no timer at all, so a leaked
        // registration never resolves on its own.
        const writesBefore = writes.chunks.length;
        await assert.rejects(
          controller.request('ping', circularParams(), { timeoutMs: 0 }),
          /circular structure/i,
          'a circular request payload must reject immediately',
        );
        assert.strictEqual(
          controller.pending.size,
          0,
          'a request that failed serialization must not stay pending',
        );
        assert.strictEqual(
          writes.chunks.length,
          writesBefore,
          'a request that failed serialization must not write partial wire data',
        );
        assert.strictEqual(controller.poisonedError, null, 'an unsent request must not poison the client');
        assert.strictEqual(socket.destroyed, false, 'an unsent request must not destroy the connection');

        const healthy = await controller.request('ping', {}, { timeoutMs: 5_000 }) as UnknownRecord;
        assert.strictEqual(typeof healthy.hostEpoch, 'string', 'the connection must stay usable');
      } finally {
        writes.restore();
      }
    } finally {
      await pair.dispose();
    }
  });

  await section('an unsent mutation must not poison the connection later', async () => {
    const pair = await startHostPair('acp-mut-ser-');
    try {
      const { controller } = pair;
      const socket = controller.socket as Socket;
      const writes = instrumentSocketWrite(socket);
      try {
        // A mutation request carries a timeout; its leaked timer must not poison
        // or destroy a connection that never carried the request.
        const writesBefore = writes.chunks.length;
        await assert.rejects(
          controller.request('prepareAgent', {
            ...circularParams(),
            options: { agentId: 'agent-callback-error', sessionId: 'session-callback-error' },
          }, { timeoutMs: 150 }),
          /circular structure/i,
          'a circular mutation payload must reject immediately',
        );
        assert.strictEqual(controller.poisonedError, null, 'an unsent mutation must not poison the client');
        assert.strictEqual(writes.chunks.length, writesBefore, 'an unsent mutation must not write wire data');

        await delay(300);
        assert.strictEqual(controller.poisonedError, null, 'a leaked timer must not poison the client later');
        assert.strictEqual(socket.destroyed, false, 'a leaked timer must not destroy a healthy connection');
        const afterDelay = await controller.request('ping', {}, { timeoutMs: 5_000 }) as UnknownRecord;
        assert.strictEqual(typeof afterDelay.hostEpoch, 'string', 'the connection must stay usable afterwards');
      } finally {
        writes.restore();
      }
    } finally {
      await pair.dispose();
    }
  });

  await section('synchronous write failure cleans pending state', async () => {
    const pair = await startHostPair('acp-sync-w-');
    try {
      const { controller } = pair;
      const socket = controller.socket as Socket;
      const writes = instrumentSocketWrite(socket);
      try {
        writes.syncError = new Error('injected synchronous write failure');
        await assert.rejects(
          controller.request('ping', { agentId: 'agent-callback-error' }, { timeoutMs: 5_000 }),
          /injected synchronous write failure/,
          'a synchronous transport throw must reject the request',
        );
        assert.strictEqual(
          controller.pending.size,
          0,
          'a request whose write threw synchronously must not stay pending',
        );
        assert.strictEqual(controller.poisonedError, null, 'a read-only request must not poison the client');
        writes.syncError = null;
        const healthy = await controller.request('ping', {}, { timeoutMs: 5_000 }) as UnknownRecord;
        assert.strictEqual(typeof healthy.hostEpoch, 'string', 'the connection must stay usable');
      } finally {
        writes.restore();
      }
    } finally {
      await pair.dispose();
    }
  });

  await section('asynchronous write error cleans pending state without replay', async () => {
    const pair = await startHostPair('acp-async-w-');
    try {
      const { controller } = pair;
      const socket = controller.socket as Socket;
      const writes = instrumentSocketWrite(socket);
      try {
        // Read-only request: the write error surfaces, the connection survives.
        writes.asyncError = Object.assign(new Error('injected asynchronous write failure'), { code: 'EPIPE' });
        const writesBefore = writes.chunks.length;
        await assert.rejects(
          controller.request('ping', { agentId: 'agent-callback-error' }, { timeoutMs: 5_000 }),
          /injected asynchronous write failure/,
          'an asynchronous transport error must reject the request',
        );
        assert.strictEqual(controller.pending.size, 0, 'an asynchronous write error must clean pending state');
        assert.strictEqual(
          writes.chunks.length - writesBefore,
          1,
          'a failed request must be written exactly once and never replayed',
        );
        assert.strictEqual(controller.poisonedError, null, 'a read-only request must not poison the client');
        assert.strictEqual(socket.destroyed, false, 'a read-only write error must not destroy the connection');
        writes.asyncError = null;

        // Mutation request: the outcome stays uncertain, is written once, and the
        // transport is torn down deliberately. No automatic replay.
        writes.asyncError = Object.assign(new Error('injected mutation write failure'), { code: 'EPIPE' });
        const mutationWritesBefore = writes.chunks.length;
        const mutationError = await controller.request('prepareAgent', {
          agentId: 'agent-callback-error',
          operationId: 'operation-callback-error',
          options: { agentId: 'agent-callback-error', sessionId: 'session-callback-error' },
        }, { timeoutMs: 5_000 }).then(
          () => null,
          (error: Error & UnknownRecord) => error,
        );
        assert.ok(mutationError, 'an asynchronous mutation write error must reject');
        assert.match(String(mutationError?.message), /injected mutation write failure/);
        assert.strictEqual(mutationError?.uncertain, true, 'a mutation write failure keeps an uncertain outcome');
        assert.strictEqual(
          mutationError?.operationId,
          'operation-callback-error',
          'an uncertain mutation must keep its operation identity',
        );
        assert.strictEqual(controller.pending.size, 0, 'a failed mutation must not stay pending');
        assert.strictEqual(
          writes.chunks.length - mutationWritesBefore,
          1,
          'a failed mutation must be written exactly once and never replayed automatically',
        );
        await waitFor(() => socket.destroyed, 'a mutation write failure must tear down the transport');
      } finally {
        writes.restore();
      }
    } finally {
      await pair.dispose();
    }
  });

  // ---------------------------------------------------------------------------
  // 3) Controller callback handling: the handler invocation and its result
  //    acknowledgment must not share one failure path.
  // ---------------------------------------------------------------------------
  const callbackPayload = (overrides: UnknownRecord = {}): UnknownRecord => ({
    hostEpoch: 'host-callback-error',
    controllerGeneration: 7,
    agentId: 'agent-callback-error',
    bindingEpoch: '',
    callbackId: 'callback-1',
    callbackToken: 'token-callback-error',
    name: 'onProcessStarted',
    args: [{ pid: 4242 }],
    ...overrides,
  });

  const newCallbackClient = (): InstanceType<typeof AcpRuntimeHostClient> => {
    const client = new AcpRuntimeHostClient({ configDir: os.tmpdir(), socketPath: '/unused' });
    client.hostEpoch = 'host-callback-error';
    client.controllerGeneration = 7;
    return client;
  };

  await section('an accepted handler result is submitted exactly once', async () => {
    const client = newCallbackClient();
    let handlerCalls = 0;
    client.registerCallbackHandlers({
      onProcessStarted: () => {
        handlerCalls += 1;
        return { started: true };
      },
    }, 'token-callback-error', 'agent-callback-error');
    const acks: UnknownRecord[] = [];
    client.request = async (_method: string, params: UnknownRecord) => {
      acks.push(params);
      if (params.ok === true) throw new Error('injected acknowledgment failure');
      return {};
    };

    await client.handleControllerCallback(callbackPayload());

    assert.strictEqual(handlerCalls, 1, 'the handler must run exactly once');
    assert.strictEqual(
      acks.length,
      1,
      'a failed acknowledgment of an accepted result must not submit a second, contradictory result',
    );
    assert.strictEqual(acks[0]?.ok, true, 'the single submitted result must be the handler result');
    assert.deepStrictEqual(acks[0]?.result, { started: true });
  });

  await section('an acknowledgment timeout neither poisons the client nor resends the reply', async () => {
    const pair = await startHostPair('acp-ack-to-', { requestTimeoutMs: 300 });
    try {
      const { host, controller } = pair;
      const socket = controller.socket as Socket;
      const writes = instrumentSocketWrite(socket);
      try {
        let handlerCalls = 0;
        controller.registerCallbackHandlers({
          onProcessStarted: () => {
            handlerCalls += 1;
            return { started: true };
          },
        }, 'token-cb', 'agent-cb');
        // Losing only the acknowledgment is the failure the Controller cannot
        // produce deterministically on a healthy local socket.
        writes.dropMethod = 'resolveControllerCallback';

        const tracked = track(host.invokeControllerCallback(
          'token-cb',
          'agent-cb',
          'binding-cb',
          'onProcessStarted',
          [{ pid: 4242 }],
        ) as Promise<unknown>);
        await waitFor(() => writes.dropped.length >= 1, 'the handler result must be submitted once');
        await waitFor(() => controller.pending.size === 0, 'the lost acknowledgment must time out');

        assert.strictEqual(handlerCalls, 1, 'a lost acknowledgment must not rerun the handler');
        assert.strictEqual(
          writes.dropped.length,
          1,
          'a timed-out acknowledgment must not be resubmitted as a second reply',
        );
        assert.strictEqual(
          writes.dropped.filter(frame => (frame.params as UnknownRecord)?.ok === true).length,
          1,
          'the single submitted reply must carry the handler result, never a contradictory failure',
        );
        assert.strictEqual(controller.poisonedError, null, 'a reply-class timeout must not poison the client');
        assert.strictEqual(socket.destroyed, false, 'a reply-class timeout must not destroy the transport');
        assert.strictEqual(controller.pending.size, 0, 'a timed-out acknowledgment must not stay pending');

        const unrelated = await controller.request('ping', {}, { timeoutMs: 5_000 }) as UnknownRecord;
        assert.strictEqual(typeof unrelated.hostEpoch, 'string', 'an unrelated RPC must still succeed');
        assert.strictEqual(tracked.settled, false, 'the Controller must not settle the Host-side callback itself');
        assert.strictEqual(
          host.controllerCallbacks.size,
          1,
          'the Host keeps its own bounded deadline for the unanswered callback',
        );

        // Sensitivity control: the identical lost-reply mechanism on a mutation
        // request still poisons, so the assertions above are not vacuous.
        writes.dropMethod = 'prepareAgent';
        const mutation = await controller.request('prepareAgent', {
          agentId: 'agent-cb',
          operationId: 'operation-ack-timeout',
          options: { agentId: 'agent-cb', sessionId: 'session-ack-timeout' },
        }, { timeoutMs: 300 }).then(() => null, (error: Error & UnknownRecord) => error);
        assert.ok(mutation, 'a lost mutation reply must time out');
        assert.strictEqual(mutation?.uncertain, true, 'a lost mutation reply keeps an uncertain outcome');
        assert.strictEqual(mutation?.operationId, 'operation-ack-timeout');
        assert.strictEqual(controller.poisonedError, mutation, 'a mutation timeout must poison the client');
        await waitFor(() => socket.destroyed, 'a mutation timeout must tear down the transport');
      } finally {
        writes.restore();
      }
    } finally {
      await pair.dispose();
    }
  });

  await section('a deliberate handler failure submits one error result', async () => {
    const client = newCallbackClient();
    let handlerCalls = 0;
    client.registerCallbackHandlers({
      onProcessStarted: () => {
        handlerCalls += 1;
        const error = new Error('handler exploded') as Error & UnknownRecord;
        error.uncertain = true;
        throw error;
      },
    }, 'token-callback-error', 'agent-callback-error');
    const acks: UnknownRecord[] = [];
    client.request = async (_method: string, params: UnknownRecord) => {
      acks.push(params);
      return {};
    };

    await client.handleControllerCallback(callbackPayload());

    assert.strictEqual(handlerCalls, 1, 'the handler must run exactly once');
    assert.strictEqual(acks.length, 1, 'a handler failure must submit exactly one error result');
    assert.strictEqual(acks[0]?.ok, false);
    assert.strictEqual(acks[0]?.error, 'handler exploded');
    assert.strictEqual(acks[0]?.uncertain, true);

    // A failing error-result acknowledgment must not resend or throw.
    const retryClient = newCallbackClient();
    let retryHandlerCalls = 0;
    retryClient.registerCallbackHandlers({
      onProcessStarted: () => {
        retryHandlerCalls += 1;
        throw new Error('handler exploded again');
      },
    }, 'token-callback-error', 'agent-callback-error');
    const retryAcks: UnknownRecord[] = [];
    retryClient.request = async (_method: string, params: UnknownRecord) => {
      retryAcks.push(params);
      throw new Error('injected acknowledgment failure');
    };
    await retryClient.handleControllerCallback(callbackPayload({ callbackId: 'callback-2' }));
    assert.strictEqual(retryHandlerCalls, 1);
    assert.strictEqual(retryAcks.length, 1, 'a failed error acknowledgment must not be resent');
    assert.strictEqual(retryAcks[0]?.ok, false);
  });

  interface StaleCase {
    label: string;
    payload: UnknownRecord;
    prepare?(client: InstanceType<typeof AcpRuntimeHostClient>): void;
  }

  const runStaleCase = async (testCase: StaleCase): Promise<{ handlerCalls: number; acks: UnknownRecord[] }> => {
    const client = newCallbackClient();
    let handlerCalls = 0;
    client.registerCallbackHandlers({
      onProcessStarted: () => {
        handlerCalls += 1;
        return { started: true };
      },
    }, 'token-callback-error', 'agent-callback-error');
    testCase.prepare?.(client);
    const acks: UnknownRecord[] = [];
    client.request = async (_method: string, params: UnknownRecord) => {
      acks.push(params);
      return {};
    };
    await client.handleControllerCallback(testCase.payload);
    return { handlerCalls, acks };
  };

  await section('stale transport identities are dropped without a reply', async () => {
    const staleCases: StaleCase[] = [
      { label: 'stale host epoch', payload: callbackPayload({ hostEpoch: 'host-previous' }) },
      { label: 'stale controller generation', payload: callbackPayload({ controllerGeneration: 6 }) },
    ];
    for (const testCase of staleCases) {
      const { handlerCalls, acks } = await runStaleCase(testCase);
      assert.strictEqual(handlerCalls, 0, `${testCase.label} must not invoke the handler`);
      assert.strictEqual(acks.length, 0, `${testCase.label} must not submit a callback result`);
    }

    const unavailable = await runStaleCase({
      label: 'unavailable callback name',
      payload: callbackPayload({ name: 'onProcessStopped', args: [] }),
    });
    assert.strictEqual(unavailable.handlerCalls, 0, 'an unavailable callback must not invoke a different handler');
    assert.strictEqual(unavailable.acks.length, 1, 'an unavailable callback must report exactly one error result');
    assert.strictEqual(unavailable.acks[0]?.ok, false);
    assert.match(String(unavailable.acks[0]?.error), /unavailable Controller callback/);
  });

  await section('a valid generation with a stale binding replies uncertain without a handler call', async () => {
    const staleCases: StaleCase[] = [
      { label: 'foreign agent', payload: callbackPayload({ agentId: 'agent-other' }) },
      {
        label: 'stale binding epoch',
        payload: callbackPayload({ bindingEpoch: 'binding-old' }),
        prepare(client: InstanceType<typeof AcpRuntimeHostClient>) {
          client.bindings.set('agent-callback-error', { agentId: 'agent-callback-error', bindingEpoch: 'binding-new' });
        },
      },
    ];
    for (const testCase of staleCases) {
      const { handlerCalls, acks } = await runStaleCase(testCase);
      assert.strictEqual(handlerCalls, 0, `${testCase.label} must not invoke the handler`);
      assert.strictEqual(
        acks.length,
        1,
        `${testCase.label} must answer once so the Host does not wait for its own deadline`,
      );
      assert.strictEqual(acks[0]?.ok, false, `${testCase.label} must not report success`);
      assert.strictEqual(acks[0]?.uncertain, true, `${testCase.label} must stay uncertain`);
      assert.match(String(acks[0]?.error), /binding is stale/);
      assert.strictEqual(acks[0]?.callbackId, 'callback-1', 'the reply must identify the rejected callback');
    }

    // Positive control: a matching binding epoch still runs the handler.
    const current = await runStaleCase({
      label: 'current binding epoch',
      payload: callbackPayload({ bindingEpoch: 'binding-new' }),
      prepare(client: InstanceType<typeof AcpRuntimeHostClient>) {
        client.bindings.set('agent-callback-error', { agentId: 'agent-callback-error', bindingEpoch: 'binding-new' });
      },
    });
    assert.strictEqual(current.handlerCalls, 1, 'the current binding epoch must invoke the handler');
    assert.strictEqual(current.acks.length, 1);
    assert.strictEqual(current.acks[0]?.ok, true);
    assert.deepStrictEqual(current.acks[0]?.result, { started: true });
  });

  if (failures.length > 0) {
    console.error(`\n${failures.length} suspected-defect section(s) failed:`);
    for (const failure of failures) {
      console.error(` - ${failure.name}: ${failure.error instanceof Error ? failure.error.message : String(failure.error)}`);
    }
    process.exitCode = 1;
    return;
  }
  console.log('ACP runtime host callback error tests passed');
}

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(10);
  }
  throw new Error(message);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
