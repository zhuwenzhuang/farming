const assert = require('assert');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

import type { Socket } from 'node:net';
import type { AcpRuntimeHostProcess as AcpRuntimeHostProcessType } from '../acp-runtime-host-process.cts';

const { AcpRuntimeHostProcess } = require('../acp-runtime-host-process.cts');

type UnknownRecord = Record<string, unknown>;
type RuntimeHost = AcpRuntimeHostProcessType;
type HostControllerClient = NonNullable<RuntimeHost['activeControllerClient']>;

/** One newline-delimited frame the Host writes to a Controller socket. */
interface HostWireMessage {
  error?: { message?: string; uncertain?: boolean };
  event?: string;
  id?: number;
  ok?: boolean;
  payload?: ControllerCallbackPayload;
  result?: UnknownRecord;
}

interface ControllerCallbackPayload {
  agentId: string;
  args: UnknownRecord[];
  bindingEpoch: string;
  callbackId: string;
  callbackToken: string;
  controllerGeneration: number;
  hostEpoch: string;
  name: string;
}

type SocketWrite = (chunk: string, callback?: (error?: Error | null) => void) => boolean;

/**
 * Transport-level backpressure regression for the ACP Runtime Host.
 *
 * Every case drives the real `AcpRuntimeHostProcess` over a real Unix domain
 * socket. Backpressure is produced only by a paused peer, so the kernel and the
 * Node stream buffer fill on their own and `socket.write()` returns `false`
 * because the operating system says so. Host writes pass through a delegating
 * observer that records the real return value and never changes it.
 */

const TRANSPORT_LIMIT_BYTES = 8 * 1024 * 1024;
const LARGE_ARG_BYTES = 512 * 1024;
const FAST_DEADLINE_MS = 10000;
/** The production callback deadline is asserted here, never edited. */
const CALLBACK_TIMEOUT_MS = 30000;
const TIMEOUT_DEADLINE_MS = CALLBACK_TIMEOUT_MS + 10000;

class FakeRuntime extends EventEmitter {
  forkReservations = 0;

  bindingCheckpoint(binding: UnknownRecord) {
    return { exportCheckpoint: () => ({ sessionId: String(binding.sessionId || '') }) };
  }

  /** Mirrors the product fork contract: the operation owns the reservation window. */
  runWithForkReservation(
    agentId: string,
    _options: UnknownRecord,
    operation: (binding: UnknownRecord) => Promise<unknown>,
  ): Promise<unknown> {
    this.forkReservations += 1;
    return operation({
      agentId,
      provider: 'fake-provider',
      sessionId: `session-fork-${this.forkReservations}`,
      cwd: '/workspace/demo',
      bindingEpoch: `epoch-fork-${this.forkReservations}`,
    });
  }

  async dispose() {}
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean, message: string, deadlineMs = FAST_DEADLINE_MS) {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(10);
  }
  throw new Error(`timed out after ${deadlineMs}ms waiting for: ${message}`);
}

function trackSettled(promise: Promise<unknown>) {
  const state: {
    settled: boolean;
    ok: boolean;
    value: unknown;
    message: string;
    uncertain: unknown;
  } = { settled: false, ok: false, value: undefined, message: '', uncertain: undefined };
  promise.then(
    value => {
      state.settled = true;
      state.ok = true;
      state.value = value;
    },
    (error: Error & { uncertain?: unknown }) => {
      state.settled = true;
      state.message = String(error?.message || error);
      state.uncertain = error?.uncertain;
    },
  );
  return state;
}

class Peer {
  socket: Socket;
  buffer = '';
  messages: HostWireMessage[] = [];
  errors: string[] = [];
  receivedBytes = 0;
  closed = false;
  private nextId = 1;
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();

  constructor(socket: Socket) {
    this.socket = socket;
    socket.on('data', (chunk: Buffer) => this.onData(chunk));
    socket.on('error', (error: Error & { code?: string }) => {
      this.errors.push(String(error?.code || error?.message || error));
    });
    socket.on('close', () => {
      this.closed = true;
      for (const [, request] of this.pending) request.reject(new Error('peer socket closed'));
      this.pending.clear();
    });
  }

  static async connect(socketPath: string): Promise<Peer> {
    const socket = net.createConnection(socketPath);
    await new Promise((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });
    return new Peer(socket);
  }

  private onData(chunk: Buffer) {
    this.receivedBytes += chunk.length;
    this.buffer += chunk.toString('utf8');
    for (;;) {
      const newline = this.buffer.indexOf('\n');
      if (newline < 0) return;
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line) as HostWireMessage;
      this.messages.push(message);
      const request = message.id ? this.pending.get(Number(message.id)) : undefined;
      if (!request) continue;
      this.pending.delete(Number(message.id));
      if (message.ok) {
        request.resolve(message.result);
        continue;
      }
      const error = new Error(String(message.error?.message || 'host request failed')) as Error & { uncertain?: unknown };
      if (message.error?.uncertain === true) error.uncertain = true;
      request.reject(error);
    }
  }

  callbackEvents(): HostWireMessage[] {
    return this.messages.filter(message => message.event === 'controller-callback');
  }

  /** Bounded request: every peer request fails instead of hanging forever. */
  request(method: string, params: Record<string, unknown> = {}, deadlineMs = FAST_DEADLINE_MS) {
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        reject(new Error(`peer request ${method} exceeded ${deadlineMs}ms`));
      }, deadlineMs);
      this.pending.set(id, {
        resolve: value => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: error => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.socket.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }

  register(generation: number, id = 'server-backpressure'): Promise<unknown> {
    return this.request('registerController', { identity: { id, generation } });
  }

  resolve(callbackId: string, payload: UnknownRecord): Promise<unknown> {
    return this.request('resolveControllerCallback', { callbackId, ...payload });
  }

  destroy() {
    if (!this.socket.destroyed) this.socket.destroy();
  }
}

interface HostWrite {
  index: number;
  bytes: number;
  accepted: boolean;
  writableLength: number;
}

function createHarness(label: string) {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), `farming-acp-bp-${label}-`));
  const socketPath = path.join(configDir, 'host.sock');
  const host: RuntimeHost = new AcpRuntimeHostProcess({
    configDir,
    socketPath,
    runtime: new FakeRuntime(),
    exitOnShutdown: false,
    idleExitMs: 0,
    maxBufferedBytes: TRANSPORT_LIMIT_BYTES,
    maxResponseBytes: TRANSPORT_LIMIT_BYTES,
  });
  const writes: HostWrite[] = [];
  const peers: Peer[] = [];
  const connectController = host.handleConnection.bind(host);
  // Delegating observer only: the real return value is recorded and passed
  // through unchanged so the Host sees genuine OS backpressure.
  host.handleConnection = (socket: Socket): void => {
    const write = socket.write.bind(socket) as SocketWrite;
    const observed: SocketWrite = (chunk, callback) => {
      const accepted = callback ? write(chunk, callback) : write(chunk);
      writes.push({
        index: writes.length,
        bytes: Buffer.byteLength(String(chunk)),
        accepted,
        writableLength: socket.writableLength,
      });
      return accepted;
    };
    (socket as unknown as { write: unknown }).write = observed;
    connectController(socket);
  };
  let started: Promise<void> | null = null;
  return {
    host,
    writes,
    configDir,
    socketPath,
    start() {
      if (!started) started = host.start();
      return started;
    },
    async peer(): Promise<Peer> {
      await this.start();
      const peer = await Peer.connect(socketPath);
      peers.push(peer);
      return peer;
    },
    invoke(name: string, args: unknown[], agentId = 'agent-backpressure') {
      return trackSettled(host.invokeControllerCallback(
        'token-backpressure',
        agentId,
        'binding-backpressure',
        name,
        args,
      ));
    },
    async dispose() {
      for (const peer of peers.splice(0)) peer.destroy();
      await host.dispose();
      fs.rmSync(configDir, { recursive: true, force: true });
    },
  };
}

function backpressureEvidence(writes: HostWrite[]) {
  const refused = writes.filter(write => !write.accepted);
  return refused.map(write => (
    `write#${write.index} bytes=${write.bytes} writableLength=${write.writableLength}`
  )).join('; ');
}

function hostSocketOf(host: RuntimeHost): Socket | null {
  const client: HostControllerClient | null = host.activeControllerClient;
  return client?.socket ?? null;
}

/**
 * Case 1: a paused Controller creates genuine kernel/stream backpressure. The
 * Host must treat an accepted-but-full write as delivered, keep the callbacks
 * pending, and hand every message over exactly once and in order on resume.
 */
async function realBackpressureDeliversExactlyOnceInOrder(): Promise<string> {
  const harness = createHarness('delivery');
  try {
    const peer = await harness.peer();
    await peer.register(1);
    peer.socket.pause();
    const queuedAt = peer.messages.length;
    const first = harness.invoke('onProcessStarted', [{ pid: 1, blob: 'a'.repeat(LARGE_ARG_BYTES) }]);
    const second = harness.invoke('onForkSessionCreated', ['session-2', 'b'.repeat(LARGE_ARG_BYTES)]);
    const ping = trackSettled(peer.request('ping', {}, FAST_DEADLINE_MS));

    await waitFor(
      () => harness.writes.some(write => !write.accepted),
      `no real write() returned false: ${JSON.stringify(harness.writes)}`,
    );
    const evidence = backpressureEvidence(harness.writes);
    assert.strictEqual(first.settled, false, 'a backpressured callback must stay pending');
    assert.strictEqual(second.settled, false, 'a backpressured callback must stay pending');
    assert.strictEqual(ping.settled, false, 'the queued ping reply must stay pending');
    assert.strictEqual(harness.host.controllerCallbacks.size, 2, 'both callbacks must stay registered');
    assert.strictEqual(hostSocketOf(harness.host)?.destroyed, false, 'backpressure must not tear down the transport');
    assert(
      harness.writes.every(write => write.bytes < TRANSPORT_LIMIT_BYTES),
      'the fixture payloads must stay below the Host transport limit',
    );
    await sleep(150);
    assert.strictEqual(first.settled, false, 'a pending callback must not settle while the peer is paused');
    assert.strictEqual(harness.host.controllerCallbacks.size, 2);

    const sentBytes = harness.writes.reduce((total, write) => total + write.bytes, 0);
    peer.socket.resume();
    await waitFor(() => ping.settled, 'the queued ping reply must arrive after resume');
    const queued = () => peer.messages.slice(queuedAt);
    await waitFor(() => queued().length >= 3, 'all queued messages must arrive after resume');

    assert.strictEqual(peer.receivedBytes, sentBytes, 'every accepted byte must arrive exactly once');
    assert.strictEqual(queued().filter(message => message.event === 'controller-callback').length, 2);
    assert.strictEqual(queued()[0].payload.name, 'onProcessStarted');
    assert.strictEqual(queued()[0].payload.args[0].pid, 1);
    assert.strictEqual(queued()[1].payload.name, 'onForkSessionCreated');
    assert.strictEqual(queued()[1].payload.args[0], 'session-2');
    assert.strictEqual(queued()[2].ok, true, 'the ping reply must keep its order behind the callbacks');
    assert.strictEqual(queued()[2].result.pid, process.pid);

    const [firstId, secondId] = peer.callbackEvents().map(message => message.payload.callbackId);
    assert.strictEqual(new Set([firstId, secondId]).size, 2, 'each callback must carry a unique id');
    assert.strictEqual(pendingIds(harness.host).length, 2);

    // Out-of-order completion under real backpressure: only the matching reply settles.
    await peer.resolve(secondId, { ok: true, result: { fork: 'session-2' } });
    await waitFor(() => second.settled, 'the matching reply must settle its own callback');
    assert.strictEqual(second.ok, true);
    assert.deepStrictEqual(second.value, { fork: 'session-2' });
    assert.strictEqual(first.settled, false, 'a reply must not settle another callback');
    await sleep(50);
    assert.strictEqual(first.settled, false);
    assert.deepStrictEqual(pendingIds(harness.host), [firstId]);

    await peer.resolve(firstId, { ok: true, result: { started: true } });
    await waitFor(() => first.settled, 'the remaining callback must settle on its own reply');
    assert.strictEqual(first.ok, true);
    assert.deepStrictEqual(first.value, { started: true });
    assert.strictEqual(harness.host.controllerCallbacks.size, 0);
    return `real write()===false observed (${evidence})`;
  } finally {
    await harness.dispose();
  }
}

function pendingIds(host: RuntimeHost): string[] {
  return [...host.controllerCallbacks.keys()];
}

/**
 * Case 2: several concurrent callbacks complete out of order, and a Controller
 * error reply rejects exactly its own callback while the others stay pending.
 */
async function concurrentCallbacksOutOfOrderAndErrorReply(): Promise<string> {
  const harness = createHarness('concurrent');
  try {
    const peer = await harness.peer();
    await peer.register(1);
    const names = ['onProcessStarted', 'onForkSessionCreated', 'refreshMcpServersForRuntime', 'onProcessStopped'];
    const tracked = names.map((name, index) => ({
      name,
      state: harness.invoke(name, [{ index, blob: 'z'.repeat(4096) }]),
    }));
    await waitFor(() => peer.callbackEvents().length === names.length, 'all callbacks must be delivered');
    assert.strictEqual(harness.host.controllerCallbacks.size, names.length);
    const ids = peer.callbackEvents().map(message => message.payload.callbackId);
    assert.strictEqual(new Set(ids).size, names.length);
    assert.deepStrictEqual(
      peer.callbackEvents().map(message => message.payload.name),
      names,
      'callbacks must be delivered in invocation order',
    );

    /** Names whose callback settled, in declaration order (not completion order). */
    const settledNames = () => tracked.filter(entry => entry.state.settled).map(entry => entry.name);
    await peer.resolve(ids[3], { ok: true, result: { stopped: true } });
    await waitFor(() => tracked[3].state.settled, 'the last callback must settle first');
    assert.deepStrictEqual(settledNames(), ['onProcessStopped'], 'only the matching callback may settle');
    assert.deepStrictEqual(tracked[3].state.value, { stopped: true });

    await peer.resolve(ids[1], { ok: false, error: 'Controller refused the fork', uncertain: true });
    await waitFor(() => tracked[1].state.settled, 'an error reply must settle its own callback');
    assert.strictEqual(tracked[1].state.ok, false);
    assert.strictEqual(tracked[1].state.message, 'Controller refused the fork');
    assert.strictEqual(tracked[1].state.uncertain, true, 'an uncertain Controller error must stay uncertain');
    assert.deepStrictEqual(settledNames(), ['onForkSessionCreated', 'onProcessStopped']);
    assert.strictEqual(harness.host.controllerCallbacks.size, 2);

    await peer.resolve(ids[2], { ok: true, result: { mcp: 'refreshed' } });
    await peer.resolve(ids[0], { ok: true, result: { pid: 4242 } });
    await waitFor(() => tracked.every(entry => entry.state.settled), 'every callback must settle on its reply');
    assert.deepStrictEqual(tracked[2].state.value, { mcp: 'refreshed' });
    assert.deepStrictEqual(tracked[0].state.value, { pid: 4242 });
    assert.strictEqual(harness.host.controllerCallbacks.size, 0);
    assert.strictEqual(peer.socket.destroyed, false, 'concurrent callbacks must not disturb the transport');
    return `${names.length} concurrent callbacks settled out of order with one Controller error reply`;
  } finally {
    await harness.dispose();
  }
}

/**
 * Case 3: duplicate, unknown, and non-Controller callback results are rejected,
 * and an already-settled callback keeps its first outcome.
 */
async function staleDuplicateAndForeignCallbackResultsRejected(): Promise<string> {
  const harness = createHarness('stale');
  try {
    const peer = await harness.peer();
    await peer.register(1);
    const tracked = harness.invoke('onProcessStarted', [{ pid: 7 }]);
    await waitFor(() => peer.callbackEvents().length === 1, 'the callback must be delivered');
    const callbackId = peer.callbackEvents()[0].payload.callbackId;

    const first = await peer.resolve(callbackId, { ok: true, result: { started: true } });
    assert.deepStrictEqual(first, { resolved: true });
    await waitFor(() => tracked.settled, 'the callback must settle');
    assert.deepStrictEqual(tracked.value, { started: true });
    assert.strictEqual(harness.host.controllerCallbacks.size, 0);

    const duplicate = trackSettled(peer.resolve(callbackId, { ok: true, result: { started: 'again' } }));
    await waitFor(() => duplicate.settled, 'a duplicate result must be rejected');
    assert.strictEqual(duplicate.ok, false);
    assert.match(duplicate.message, /no longer active/);
    assert.strictEqual(tracked.ok, true, 'a duplicate result must not overwrite the first outcome');
    assert.deepStrictEqual(tracked.value, { started: true });

    const unknown = trackSettled(peer.resolve('missing-callback-id', { ok: true, result: {} }));
    await waitFor(() => unknown.settled, 'an unknown callback id must be rejected');
    assert.match(unknown.message, /no longer active/);

    const outsider = await harness.peer();
    const unregistered = trackSettled(outsider.resolve(callbackId, { ok: true, result: {} }));
    await waitFor(() => unregistered.settled, 'a non-Controller socket must not resolve callbacks');
    assert.strictEqual(unregistered.ok, false);
    assert.match(unregistered.message, /controller is not registered/);
    assert.strictEqual(harness.host.controllerCallbacks.size, 0);
    assert.strictEqual(peer.socket.destroyed, false, 'a rejected stale result must not tear down the Controller');
    return 'duplicate/unknown/non-Controller callback results rejected without touching the settled outcome';
  } finally {
    await harness.dispose();
  }
}

/**
 * Case 4: callbacks accepted while the peer is paused and then lost. An abrupt
 * peer loss (write-after-close / socket error) must reject them as uncertain,
 * clear the registry, drop the Controller, and allow a fresh Controller to work.
 */
async function disconnectAfterAcceptedEnqueue(): Promise<string> {
  const harness = createHarness('disconnect');
  try {
    const peer = await harness.peer();
    await peer.register(1);

    const small = harness.invoke('onProcessStarted', [{ pid: 11 }]);
    await waitFor(() => peer.callbackEvents().length === 1, 'the first callback must be delivered');
    assert.strictEqual(small.settled, false);

    peer.socket.pause();
    const buffered = harness.invoke('onForkSessionCreated', ['session-buffered', 'c'.repeat(LARGE_ARG_BYTES)]);
    await waitFor(
      () => harness.writes.some(write => !write.accepted),
      'the paused peer must produce a real write()===false',
    );
    const evidence = backpressureEvidence(harness.writes);
    assert.strictEqual(harness.host.controllerCallbacks.size, 2);

    peer.destroy();
    await waitFor(() => small.settled && buffered.settled, 'both accepted callbacks must settle on disconnect');
    for (const state of [small, buffered]) {
      assert.strictEqual(state.ok, false);
      assert.strictEqual(state.uncertain, true, 'a lost callback outcome must stay uncertain');
      assert.match(state.message, /uncertain|could not be delivered/);
    }
    assert.strictEqual(harness.host.controllerCallbacks.size, 0, 'a disconnected client must leave no callbacks');
    assert.strictEqual(harness.host.activeControllerClient, null, 'the Controller must be dropped');
    assert.ok(peer.errors.length > 0 || peer.closed, 'the peer socket must report its loss');

    const afterLoss = harness.invoke('onProcessStarted', [{ pid: 12 }]);
    await waitFor(() => afterLoss.settled, 'a callback without a Controller must fail fast');
    assert.strictEqual(afterLoss.ok, false);
    assert.strictEqual(afterLoss.uncertain, true);
    assert.match(afterLoss.message, /no active Controller/);

    const recovered = await harness.peer();
    await recovered.register(2);
    const tracked = harness.invoke('onProcessStarted', [{ pid: 13 }]);
    await waitFor(() => recovered.callbackEvents().length === 1, 'the recovered Controller must receive callbacks');
    await recovered.resolve(recovered.callbackEvents()[0].payload.callbackId, { ok: true, result: { pid: 13 } });
    await waitFor(() => tracked.settled, 'the recovered callback must settle');
    assert.strictEqual(tracked.ok, true);
    assert.deepStrictEqual(tracked.value, { pid: 13 });
    return `accepted callbacks rejected as uncertain after abrupt loss (${evidence}); recovered on a new Controller`;
  } finally {
    await harness.dispose();
  }
}

/**
 * Case 5: a new Controller replaces the old one while callbacks are pending.
 * Old callbacks must die with the old transport, and a stale id from the
 * previous generation must stay unresolvable.
 */
async function controllerReplacementWhileCallbacksPending(): Promise<string> {
  const harness = createHarness('replacement');
  try {
    const old = await harness.peer();
    await old.register(1);
    const first = harness.invoke('onProcessStarted', [{ pid: 21 }]);
    const second = harness.invoke('onProcessStopped', []);
    await waitFor(() => old.callbackEvents().length === 2, 'both callbacks must reach the old Controller');
    const staleIds = old.callbackEvents().map(message => message.payload.callbackId);
    assert.strictEqual(harness.host.controllerCallbacks.size, 2);

    const next = await harness.peer();
    await next.register(2);
    await waitFor(() => old.closed, 'the replaced Controller transport must be closed');
    await waitFor(() => first.settled && second.settled, 'pending callbacks must settle on replacement');
    for (const state of [first, second]) {
      assert.strictEqual(state.ok, false);
      assert.strictEqual(state.uncertain, true);
      assert.match(state.message, /uncertain|could not be delivered/);
    }
    assert.strictEqual(harness.host.controllerCallbacks.size, 0, 'no callback may survive its Controller');

    const stale = trackSettled(next.resolve(staleIds[0], { ok: true, result: { pid: 21 } }));
    await waitFor(() => stale.settled, 'a stale callback id must be rejected');
    assert.strictEqual(stale.ok, false);
    assert.match(stale.message, /no longer active/);
    assert.strictEqual(first.settled, true);
    assert.strictEqual(first.ok, false, 'a stale result must not resurrect a rejected callback');

    const fresh = harness.invoke('onProcessStarted', [{ pid: 22 }]);
    await waitFor(() => next.callbackEvents().length === 1, 'the new Controller must receive its own callbacks');
    const freshEvent = next.callbackEvents()[0];
    assert.strictEqual(freshEvent.payload.controllerGeneration, 2, 'the new callback must carry the new generation');
    await next.resolve(freshEvent.payload.callbackId, { ok: true, result: { pid: 22 } });
    await waitFor(() => fresh.settled, 'the new Controller callback must settle');
    assert.strictEqual(fresh.ok, true);
    assert.deepStrictEqual(fresh.value, { pid: 22 });
    return 'pending callbacks died with the replaced Controller; stale ids rejected; new generation works';
  } finally {
    await harness.dispose();
  }
}

/**
 * Case 7: a Controller generation change on the *same* socket. The transport
 * stays alive, so nothing may keep waiting on the previous generation: pending
 * callbacks and fork reservations of the old generation must be released, and
 * the new generation must work on the same socket.
 */
async function sameSocketGenerationChangeReleasesOldRequests(): Promise<string> {
  const harness = createHarness('same-socket');
  try {
    const peer = await harness.peer();
    await peer.register(1);
    const first = harness.invoke('onProcessStarted', [{ pid: 41 }]);
    const second = harness.invoke('onForkSessionCreated', ['session-41']);
    await waitFor(() => peer.callbackEvents().length === 2, 'both callbacks must reach generation 1');
    const staleIds = peer.callbackEvents().map(message => message.payload.callbackId);

    const reservation = await peer.request('beginForkReservation', {
      agentId: 'agent-backpressure',
      options: { agentId: 'agent-backpressure', sessionId: 'session-fork-reservation' },
    }) as { token?: string; binding?: UnknownRecord };
    assert.ok(reservation.token, 'the fork reservation must be established');
    assert.strictEqual(harness.host.controllerCallbacks.size, 2);
    assert.strictEqual(harness.host.forkReservations.size, 1, 'the reservation must be registered');

    await peer.register(2);
    assert.strictEqual(peer.socket.destroyed, false, 'a same-socket re-registration must keep the transport');
    assert.strictEqual(peer.closed, false);
    assert.ok(harness.host.activeControllerClient, 'the same socket must stay the registered Controller');
    assert.strictEqual(
      hostSocketOf(harness.host)?.destroyed,
      false,
      'a same-socket re-registration must not destroy the Controller transport',
    );

    await waitFor(() => first.settled && second.settled, 'old-generation callbacks must be released');
    for (const state of [first, second]) {
      assert.strictEqual(state.ok, false);
      assert.strictEqual(state.uncertain, true, 'a released callback outcome must stay uncertain');
      assert.match(state.message, /uncertain|could not be delivered/);
    }
    assert.strictEqual(harness.host.controllerCallbacks.size, 0, 'no callback may survive its generation');
    await waitFor(() => harness.host.forkReservations.size === 0, 'the old-generation reservation must be released');

    const stale = trackSettled(peer.resolve(staleIds[0], { ok: true, result: { pid: 41 } }));
    await waitFor(() => stale.settled, 'a stale callback id must be rejected');
    assert.strictEqual(stale.ok, false);
    assert.match(stale.message, /no longer active/);
    assert.strictEqual(first.ok, false, 'a stale result must not resurrect a released callback');

    const fresh = harness.invoke('onProcessStarted', [{ pid: 42 }]);
    await waitFor(() => peer.callbackEvents().length === 3, 'generation 2 must receive callbacks on the same socket');
    const freshEvent = peer.callbackEvents()[2];
    assert.strictEqual(freshEvent.payload.controllerGeneration, 2, 'the callback must carry the new generation');
    await peer.resolve(freshEvent.payload.callbackId, { ok: true, result: { pid: 42 } });
    await waitFor(() => fresh.settled, 'the new-generation callback must settle');
    assert.strictEqual(fresh.ok, true);
    assert.deepStrictEqual(fresh.value, { pid: 42 });

    const next = await peer.request('beginForkReservation', {
      agentId: 'agent-backpressure',
      options: { agentId: 'agent-backpressure', sessionId: 'session-fork-next' },
    }) as { token?: string };
    assert.ok(next.token, 'generation 2 must be able to reserve a fork');
    const ended = await peer.request('endForkReservation', { token: next.token }) as UnknownRecord;
    assert.deepStrictEqual(ended, { released: true });
    assert.strictEqual(harness.host.forkReservations.size, 0);
    return 'same-socket generation change released pending callbacks and the fork reservation; generation 2 works';
  } finally {
    await harness.dispose();
  }
}

/**
 * Case 6: the genuine 30-second callback deadline. A reply that arrives after
 * the timeout must be rejected and must not resurrect the settled rejection.
 */
async function genuineCallbackTimeoutThenLateReply(): Promise<string> {
  const harness = createHarness('timeout');
  try {
    const peer = await harness.peer();
    await peer.register(1);
    const tracked = harness.invoke('onProcessStarted', [{ pid: 31 }]);
    await waitFor(() => peer.callbackEvents().length === 1, 'the callback must be delivered');
    const callbackId = peer.callbackEvents()[0].payload.callbackId;
    const startedAt = Date.now();

    await waitFor(() => tracked.settled, 'the callback must time out', TIMEOUT_DEADLINE_MS);
    const elapsed = Date.now() - startedAt;
    assert.strictEqual(tracked.ok, false);
    assert.match(tracked.message, /timed out/);
    assert.strictEqual(tracked.uncertain, true, 'a timeout outcome must stay uncertain');
    assert.ok(
      elapsed >= CALLBACK_TIMEOUT_MS - 500,
      `the callback settled after ${elapsed}ms, earlier than the ${CALLBACK_TIMEOUT_MS}ms production deadline`,
    );
    assert.strictEqual(harness.host.controllerCallbacks.size, 0, 'a timed-out callback must be unregistered');
    assert.strictEqual(peer.socket.destroyed, false, 'a timeout must not tear down the Controller transport');

    const late = trackSettled(peer.resolve(callbackId, { ok: true, result: { pid: 31 } }));
    await waitFor(() => late.settled, 'a late result must be rejected');
    assert.strictEqual(late.ok, false);
    assert.match(late.message, /no longer active/);
    assert.strictEqual(tracked.ok, false, 'a late result must not resolve a timed-out callback');
    assert.deepStrictEqual(tracked.value, undefined);

    const recovered = harness.invoke('onProcessStarted', [{ pid: 32 }]);
    await waitFor(() => peer.callbackEvents().length === 2, 'the Controller must keep working after a timeout');
    await peer.resolve(peer.callbackEvents()[1].payload.callbackId, { ok: true, result: { pid: 32 } });
    await waitFor(() => recovered.settled, 'the callback after the timeout must settle');
    assert.strictEqual(recovered.ok, true);
    assert.deepStrictEqual(recovered.value, { pid: 32 });
    return `genuine ${CALLBACK_TIMEOUT_MS}ms timeout observed after ${elapsed}ms; late reply rejected; Controller recovered`;
  } finally {
    await harness.dispose();
  }
}

async function main() {
  // The timeout case owns the 30-second production deadline, so it runs
  // alongside the fast cases instead of adding to them.
  const timeoutCase = genuineCallbackTimeoutThenLateReply().then(
    detail => ({ detail, error: null as Error | null }),
    error => ({ detail: '', error: error as Error }),
  );
  const results: string[] = [];
  const failures: { scenario: string; error: Error }[] = [];
  const scenarios: [string, () => Promise<string>][] = [
    ['realBackpressureDeliversExactlyOnceInOrder', realBackpressureDeliversExactlyOnceInOrder],
    ['concurrentCallbacksOutOfOrderAndErrorReply', concurrentCallbacksOutOfOrderAndErrorReply],
    ['staleDuplicateAndForeignCallbackResultsRejected', staleDuplicateAndForeignCallbackResultsRejected],
    ['disconnectAfterAcceptedEnqueue', disconnectAfterAcceptedEnqueue],
    ['controllerReplacementWhileCallbacksPending', controllerReplacementWhileCallbacksPending],
    ['sameSocketGenerationChangeReleasesOldRequests', sameSocketGenerationChangeReleasesOldRequests],
  ];
  for (const [name, scenario] of scenarios) {
    try {
      results.push(`${name}: ${await scenario()}`);
    } catch (error) {
      failures.push({ scenario: name, error: error as Error });
    }
  }
  const timeout = await timeoutCase;
  if (timeout.error) failures.push({ scenario: 'genuineCallbackTimeoutThenLateReply', error: timeout.error });
  else results.push(`genuineCallbackTimeoutThenLateReply: ${timeout.detail}`);

  for (const line of results) console.log(`ok - ${line}`);
  for (const failure of failures) {
    console.error(`FAIL - ${failure.scenario}: ${failure.error?.stack || failure.error}`);
  }
  if (failures.length > 0) {
    process.exitCode = 1;
    return;
  }
  console.log('ACP runtime host backpressure tests passed');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
