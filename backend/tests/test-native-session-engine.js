const assert = require('assert');
const EventEmitter = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const LocalSessionEngine = require('../local-session-engine');
const NativePtyHost = require('../native-pty-host');
const NativePtyHostClient = require('../native-pty-host-client');
const NativeSessionEngine = require('../native-session-engine');
const { nativePtyHostSocketPath } = require('../native-pty-host-path');
const {
  nativePtyHostRuntimeIdentity,
  nativePtyHostRuntimeIdentityMatches,
  normalizeNativePtyHostRuntimeIdentity,
} = require('../native-pty-host-identity');
const { deserializeTerminalState } = require('../terminal-state-serialization');

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitFor(fn, label) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const result = await fn();
    if (result) return result;
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function listenUnixSocket(socketPath) {
  const net = require('net');
  const server = net.createServer(socket => socket.end());
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  return server;
}

async function closeServer(server) {
  await new Promise(resolve => server.close(() => resolve()));
}

async function shutdownNativeHost(configDir, socketPath) {
  const client = new NativePtyHostClient({ configDir, socketPath });
  try {
    await client.request('shutdownHost', {}, { timeoutMs: 5000 });
  } catch (error) {
    if (!error || !['ENOENT', 'ECONNREFUSED', 'ECONNRESET', 'EPIPE'].includes(error.code)) {
      throw error;
    }
  } finally {
    client.disconnect();
  }
}

async function withKeepAlive(promise) {
  const timer = setInterval(() => {}, 20);
  try {
    return await promise;
  } finally {
    clearInterval(timer);
  }
}

function makeFlakyRequestClient(mode, result) {
  const client = new NativePtyHostClient({ configDir: fs.mkdtempSync(path.join(os.tmpdir(), 'farming-native-client-')) });
  let writes = 0;
  let ensureCalls = 0;
  let destroys = 0;
  let hostDisconnects = 0;
  client.on('host-disconnect', () => {
    hostDisconnects += 1;
  });
  client.ensureConnected = async () => {
    ensureCalls += 1;
    client.socket = {
      destroyed: false,
      destroy() {
        if (!this.destroyed) destroys += 1;
        this.destroyed = true;
      },
      write(payload, callback) {
        writes += 1;
        if (writes === 1) {
          if (mode === 'write-error') {
            const error = new Error('simulated broken native pty socket');
            error.code = 'EPIPE';
            callback(error);
            return;
          }
          if (mode === 'disconnect-after-write') {
            callback();
            setImmediate(() => client.handleDisconnect(client.socket));
            return;
          }
          if (mode === 'timeout') {
            callback();
            return;
          }
          throw new Error(`Unknown flaky native pty test mode: ${mode}`);
        }
        setImmediate(() => {
          callback();
          const request = JSON.parse(payload);
          client.handleMessage(JSON.stringify({
            id: request.id,
            ok: true,
            result,
          }));
        });
      },
    };
  };
  return {
    client,
    stats: () => ({ writes, ensureCalls, destroys, hostDisconnects }),
    cleanup: () => {
      const configDir = client.configDir;
      client.disconnect();
      fs.rmSync(configDir, { recursive: true, force: true });
    },
  };
}

async function run() {
  const expectedRuntimeIdentity = nativePtyHostRuntimeIdentity();
  assert.strictEqual(expectedRuntimeIdentity.protocolVersion, 8);
  assert.match(expectedRuntimeIdentity.buildId, /^[a-f0-9]{64}$/);
  assert.strictEqual(
    nativePtyHostRuntimeIdentityMatches(expectedRuntimeIdentity, {
      ...expectedRuntimeIdentity,
      buildId: expectedRuntimeIdentity.buildId.toUpperCase(),
    }),
    true,
    'native PTY runtime identities should normalize equivalent hashes'
  );
  assert.strictEqual(
    normalizeNativePtyHostRuntimeIdentity({ protocolVersion: 2, buildId: 'invalid' }),
    null,
    'malformed native PTY runtime identities must fail closed'
  );

  const rotatingClient = new NativePtyHostClient({
    configDir: fs.mkdtempSync(path.join(os.tmpdir(), 'farming-native-runtime-identity-')),
    expectedRuntimeIdentity,
    connectRetries: 4,
    connectRetryMs: 1,
  });
  const mismatchedRuntimeIdentity = {
    ...expectedRuntimeIdentity,
    buildId: expectedRuntimeIdentity.buildId.replace(/^./, expectedRuntimeIdentity.buildId[0] === '0' ? '1' : '0'),
    version: 'older-test-runtime',
  };
  let connectAttempts = 0;
  let rotations = 0;
  rotatingClient.connectOnce = async () => {
    connectAttempts += 1;
    if (connectAttempts === 2) {
      const error = new Error('new native PTY host socket is not ready yet');
      error.code = 'ENOENT';
      throw error;
    }
    rotatingClient.socket = {
      destroyed: false,
      destroy() {
        this.destroyed = true;
      },
    };
  };
  rotatingClient.request = async (method) => {
    assert.strictEqual(method, 'ping');
    return {
      ok: true,
      pid: 12345,
      runtimeIdentity: connectAttempts === 1
        ? mismatchedRuntimeIdentity
      : expectedRuntimeIdentity,
    };
  };
  rotatingClient.requestOnce = async (method, params) => {
    assert.strictEqual(method, 'registerController');
    assert.strictEqual(params.identity.id, rotatingClient.controllerIdentity.id);
    return { registered: true, controllerId: params.identity.id };
  };
  rotatingClient.rotateMismatchedHost = async (hostInfo) => {
    rotations += 1;
    assert.strictEqual(hostInfo.runtimeIdentity, mismatchedRuntimeIdentity);
    rotatingClient.socket = null;
    return '{"version":1,"state":[]}';
  };
  try {
    await rotatingClient.connectWithRetries({ startHost: false });
    assert.strictEqual(rotations, 1, 'an incompatible native PTY host should rotate exactly once');
    assert.strictEqual(connectAttempts, 3, 'recovery must wait for the replacement host socket');
    assert.deepStrictEqual(rotatingClient.connectedHostInfo.runtimeIdentity, expectedRuntimeIdentity);
    const runtimeRotation = rotatingClient.consumeRuntimeRotation();
    assert.strictEqual(typeof runtimeRotation.rotatedAt, 'number');
    assert.deepStrictEqual(runtimeRotation, {
      rotatedAt: runtimeRotation.rotatedAt,
      previous: mismatchedRuntimeIdentity,
      current: expectedRuntimeIdentity,
      previousPid: 12345,
      serializedTerminalState: '{"version":1,"state":[]}',
    });
    assert.strictEqual(rotatingClient.consumeRuntimeRotation(), null, 'runtime rotation is a one-shot recovery signal');
  } finally {
    const configDir = rotatingClient.configDir;
    rotatingClient.disconnect();
    fs.rmSync(configDir, { recursive: true, force: true });
  }

  for (const [label, EngineClass] of [
    ['native PTY host', NativePtyHost],
    ['local session engine', LocalSessionEngine],
  ]) {
    const engine = Object.create(EngineClass.prototype);
    engine.sessions = new Map();
    let resolveScreenState;
    const session = {
      id: `atomic-cut-${label}`,
      command: 'bash',
      cwd: process.cwd(),
      status: 'running',
      output: 'screen at sequence 7',
      outputSeq: 7,
      stateRevision: 7,
      runtimeEpoch: `epoch-${label}`,
      stateProofAvailable: true,
      renderOutput: '',
      previewText: '',
      previewSnapshot: null,
      previewCols: 80,
      previewRows: 24,
      title: '',
      terminalBusy: false,
      screenWorker: {
        getState: () => new Promise(resolve => {
          resolveScreenState = resolve;
        }),
      },
    };
    engine.sessions.set(session.id, session);

    const snapshotPromise = engine.getSessionState(session.id);
    session.output = 'screen at sequence 7 plus unseen sequence 8';
    session.outputSeq = 8;
    resolveScreenState({
      runtimeEpoch: `epoch-${label}`,
      outputSeq: 7,
      stateRevision: 7,
      renderOutput: 'screen at sequence 7',
      previewText: 'screen at sequence 7',
      previewSnapshot: null,
      cols: 80,
      rows: 24,
      title: '',
    });
    const snapshot = await snapshotPromise;
    assert.strictEqual(snapshot.outputSeq, 7, `${label} snapshot sequence must be captured before awaiting the screen worker`);
    assert.strictEqual(snapshot.stateRevision, 7, `${label} checkpoint revision must match the captured reducer cut`);
    assert.strictEqual(snapshot.output, 'screen at sequence 7', `${label} raw output must use the same sequence cut`);
    assert.strictEqual(snapshot.renderOutput, 'screen at sequence 7', `${label} render output must match the captured sequence cut`);

    for (const mismatch of [
      { runtimeEpoch: 'wrong-epoch', outputSeq: 7, stateRevision: 7 },
      { runtimeEpoch: `epoch-${label}`, outputSeq: 7, stateRevision: 6 },
    ]) {
      session.output = 'raw fail-closed state';
      session.outputSeq = 8;
      session.stateRevision = 8;
      session.screenWorker.getState = async () => ({
        ...mismatch,
        renderOutput: 'unproven worker state',
        previewText: 'unproven preview',
        previewSnapshot: { cells: [] },
        cols: 120,
        rows: 40,
        title: 'unproven title',
      });
      const rejectedCheckpoint = await engine.getSessionState(session.id);
      assert.strictEqual(rejectedCheckpoint.outputSeq, null, `${label} must reject a checkpoint with a mismatched cut`);
      assert.strictEqual(rejectedCheckpoint.stateRevision, null, `${label} must not publish a revision for an unproven checkpoint`);
      assert.strictEqual(rejectedCheckpoint.renderOutput, 'raw fail-closed state');
      assert.notStrictEqual(rejectedCheckpoint.previewText, 'unproven preview');
      assert.notStrictEqual(rejectedCheckpoint.title, 'unproven title');
    }

    session.screenWorker.getState = async () => ({
      runtimeEpoch: `epoch-${label}`,
      outputSeq: 6,
      stateRevision: 7,
      renderOutput: 'older exact worker cut',
      previewText: 'older exact preview',
      previewSnapshot: null,
      cols: 80,
      rows: 24,
      title: '',
    });
    const olderCheckpoint = await engine.getSessionState(session.id);
    assert.strictEqual(olderCheckpoint.outputSeq, 6, `${label} must accept an exact committed cut behind the raw head`);
    assert.strictEqual(olderCheckpoint.stateRevision, 7);
    assert.strictEqual(olderCheckpoint.renderOutput, 'older exact worker cut');

    session.screenWorker.getState = async () => {
      throw new Error('simulated reducer snapshot failure');
    };
    const failedCheckpoint = await engine.getSessionState(session.id);
    assert.strictEqual(failedCheckpoint.outputSeq, null);
    assert.strictEqual(failedCheckpoint.stateRevision, null);
    assert.strictEqual(failedCheckpoint.renderOutput, 'raw fail-closed state');
  }

  const staleCloseClient = new NativePtyHostClient({ configDir: fs.mkdtempSync(path.join(os.tmpdir(), 'farming-native-stale-client-')) });
  try {
    let hostDisconnects = 0;
    let pendingRejected = false;
    staleCloseClient.on('host-disconnect', () => {
      hostDisconnects += 1;
    });
    const oldSocket = { destroyed: false, destroy() { this.destroyed = true; } };
    const newSocket = { destroyed: false, destroy() { this.destroyed = true; } };
    const timer = setTimeout(() => {}, 1000);
    if (typeof timer.unref === 'function') timer.unref();
    staleCloseClient.socket = newSocket;
    staleCloseClient.buffer = 'new socket partial frame';
    staleCloseClient.pending.set(1, {
      resolve: () => {},
      reject: () => { pendingRejected = true; },
      timer,
    });

    staleCloseClient.handleDisconnect(oldSocket);

    assert.strictEqual(staleCloseClient.socket, newSocket, 'a stale socket close must not clear the current native pty connection');
    assert.strictEqual(staleCloseClient.buffer, 'new socket partial frame', 'a stale socket close must not clear the current socket read buffer');
    assert.strictEqual(staleCloseClient.pending.size, 1, 'a stale socket close must not reject requests that belong to the current socket');
    assert.strictEqual(pendingRejected, false, 'a stale socket close must not reject current pending requests');
    assert.strictEqual(hostDisconnects, 0, 'a stale socket close must not emit a user-visible host disconnect');
    clearTimeout(timer);
    staleCloseClient.pending.clear();
  } finally {
    const configDir = staleCloseClient.configDir;
    staleCloseClient.disconnect();
    fs.rmSync(configDir, { recursive: true, force: true });
  }

  const retrying = makeFlakyRequestClient('write-error', { status: 'running' });
  try {
    const result = await retrying.client.request('getSessionState', { sessionId: 'retry-session' });
    assert.deepStrictEqual(result, { status: 'running' });
    assert.deepStrictEqual(
      retrying.stats(),
      { writes: 2, ensureCalls: 2, destroys: 1, hostDisconnects: 0 },
      'native pty control requests should reconnect and retry once after a write-side socket failure'
    );
    retrying.client.handleDisconnect(retrying.client.socket);
    assert.deepStrictEqual(
      retrying.stats(),
      { writes: 2, ensureCalls: 2, destroys: 1, hostDisconnects: 1 },
      'a later real socket close should not be swallowed by stale suppression from an earlier client-side reset'
    );
  } finally {
    retrying.cleanup();
  }

  const pendingRetrying = makeFlakyRequestClient('disconnect-after-write', { status: 'running-after-close' });
  try {
    const result = await pendingRetrying.client.request('getSessionState', { sessionId: 'pending-retry-session' });
    assert.deepStrictEqual(result, { status: 'running-after-close' });
    assert.deepStrictEqual(
      pendingRetrying.stats(),
      { writes: 2, ensureCalls: 2, destroys: 0, hostDisconnects: 1 },
      'native pty control requests should reconnect and retry once when the host disconnects before replying'
    );
  } finally {
    pendingRetrying.cleanup();
  }

  const timeoutRetrying = makeFlakyRequestClient('timeout', { status: 'running-after-timeout' });
  try {
    const result = await withKeepAlive(
      timeoutRetrying.client.request(
        'getSessionState',
        { sessionId: 'timeout-retry-session' },
        { timeoutMs: 5 }
      )
    );
    assert.deepStrictEqual(result, { status: 'running-after-timeout' });
    assert.deepStrictEqual(
      timeoutRetrying.stats(),
      { writes: 2, ensureCalls: 2, destroys: 1, hostDisconnects: 0 },
      'native pty control requests should reset the socket and retry once after timing out'
    );
  } finally {
    timeoutRetrying.cleanup();
  }

  const nonRetryingInput = makeFlakyRequestClient('write-error', { sent: true });
  try {
    await assert.rejects(
      () => nonRetryingInput.client.request('sendInput', { sessionId: 'retry-session', input: 'danger\n' }),
      error => error && error.code === 'EPIPE',
      'native pty input requests must not retry after an ambiguous socket failure'
    );
    assert.deepStrictEqual(
      nonRetryingInput.stats(),
      { writes: 1, ensureCalls: 1, destroys: 1, hostDisconnects: 0 },
      'sendInput should not be replayed because duplicate terminal input is worse than a visible failure'
    );
  } finally {
    nonRetryingInput.cleanup();
  }

  const pendingNonRetryingInput = makeFlakyRequestClient('disconnect-after-write', { sent: true });
  try {
    await assert.rejects(
      () => pendingNonRetryingInput.client.request('sendInput', { sessionId: 'pending-retry-session', input: 'danger\n' }),
      error => error && error.code === 'ECONNRESET',
      'native pty input requests must not retry when the host disconnects before replying'
    );
    assert.deepStrictEqual(
      pendingNonRetryingInput.stats(),
      { writes: 1, ensureCalls: 1, destroys: 0, hostDisconnects: 1 },
      'pending sendInput should not be replayed after host disconnect because the PTY may already have received it'
    );
  } finally {
    pendingNonRetryingInput.cleanup();
  }

  const timeoutNonRetryingInput = makeFlakyRequestClient('timeout', { sent: true });
  try {
    await assert.rejects(
      () => withKeepAlive(
        timeoutNonRetryingInput.client.request(
          'sendInput',
          { sessionId: 'timeout-retry-session', input: 'danger\n' },
          { timeoutMs: 5 }
        )
      ),
      error => error && error.code === 'ETIMEDOUT',
      'native pty input requests must not retry after timing out'
    );
    assert.deepStrictEqual(
      timeoutNonRetryingInput.stats(),
      { writes: 1, ensureCalls: 1, destroys: 1, hostDisconnects: 0 },
      'timed out sendInput should reset the socket but not replay the input'
    );
  } finally {
    timeoutNonRetryingInput.cleanup();
  }

  const recoveredClient = new EventEmitter();
  let recoveredRequestCount = 0;
  let recoveredStartHost = null;
  recoveredClient.canConnectWithoutStartingHost = () => true;
  recoveredClient.request = async (method, _params, options = {}) => {
    if (method !== 'recoverSessions') return null;
    recoveredRequestCount += 1;
    recoveredStartHost = options.startHost;
    return [{ agentId: 'recoverable-session', metadata: { agentId: 'recoverable-session' }, state: { status: 'running' } }];
  };
  recoveredClient.disconnect = () => {};
  const recoveredEngine = new NativeSessionEngine({ client: recoveredClient });
  const recoveredErrors = [];
  recoveredEngine.on('session-error', event => recoveredErrors.push(event));
  recoveredClient.emit('session-started', { sessionId: 'recoverable-session' });
  recoveredClient.emit('host-disconnect');
  await waitFor(() => recoveredRequestCount > 0, 'recoverable host disconnect reconciliation');
  assert.strictEqual(recoveredStartHost, true, 'host disconnect reconciliation should be allowed to restart the native host');
  assert.deepStrictEqual(
    recoveredErrors,
    [],
    'native engine should not mark sessions dead when a host disconnect can be reconciled'
  );
  recoveredEngine.dispose();

  const lostClient = new EventEmitter();
  lostClient.canConnectWithoutStartingHost = () => true;
  let lostStartHost = null;
  lostClient.request = async (method, _params, options = {}) => {
    if (method !== 'recoverSessions') return null;
    lostStartHost = options.startHost;
    return [];
  };
  lostClient.disconnect = () => {};
  const lostEngine = new NativeSessionEngine({ client: lostClient });
  const lostErrors = [];
  lostEngine.on('session-error', event => lostErrors.push(event));
  lostClient.emit('session-started', { sessionId: 'lost-session' });
  lostClient.emit('host-disconnect');
  await waitFor(() => lostErrors.length === 1, 'lost host disconnect session error');
  assert.strictEqual(lostStartHost, true, 'lost host disconnect reconciliation should still try to restart the native host');
  assert.strictEqual(lostErrors[0].sessionId, 'lost-session');
  assert.strictEqual(lostErrors[0].fatal, true);
  assert.ok(lostErrors[0].error.includes('no longer recoverable'));
  lostEngine.dispose();

  const exitedClient = new EventEmitter();
  exitedClient.disconnect = () => {};
  const exitedEngine = new NativeSessionEngine({ client: exitedClient });
  const exitedErrors = [];
  exitedEngine.on('session-error', event => exitedErrors.push(event));
  exitedClient.emit('session-started', { sessionId: 'exited-session' });
  exitedClient.emit('host-exit', { code: 42, signal: null });
  assert.strictEqual(exitedErrors.length, 1, 'native engine should fail sessions when the host process exits');
  assert.strictEqual(exitedErrors[0].sessionId, 'exited-session');
  assert.strictEqual(exitedErrors[0].fatal, true);
  assert.ok(exitedErrors[0].error.includes('code 42'));
  exitedEngine.dispose();

  const missingConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-native-missing-'));
  const missingEngine = new NativeSessionEngine({ configDir: missingConfigDir });
  try {
    assert.deepStrictEqual(
      await missingEngine.recoverSessions(),
      [],
      'recover should not start a missing pty host'
    );
  } finally {
    missingEngine.dispose();
    fs.rmSync(missingConfigDir, { recursive: true, force: true });
  }

  const timeoutRecoverClient = new EventEmitter();
  timeoutRecoverClient.canConnectWithoutStartingHost = () => true;
  timeoutRecoverClient.request = async (method) => {
    assert.strictEqual(method, 'recoverSessions');
    const error = new Error('native recover timed out');
    error.code = 'ETIMEDOUT';
    throw error;
  };
  timeoutRecoverClient.disconnect = () => {};
  const timeoutRecoverEngine = new NativeSessionEngine({ client: timeoutRecoverClient });
  try {
    assert.deepStrictEqual(
      await timeoutRecoverEngine.recoverSessions(),
      [],
      'recover should treat a timed out native host like a missing transient host'
    );
  } finally {
    timeoutRecoverEngine.dispose();
  }

  if (process.platform !== 'win32') {
    const activeSocketConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-native-active-socket-'));
    const activeSocketPath = nativePtyHostSocketPath(activeSocketConfigDir);
    fs.mkdirSync(path.dirname(activeSocketPath), { recursive: true });
    const activeServer = await listenUnixSocket(activeSocketPath);
    const competingHost = new NativePtyHost({ configDir: activeSocketConfigDir, socketPath: activeSocketPath });
    try {
      await assert.rejects(
        () => competingHost.start(),
        error => error && error.code === 'EADDRINUSE' && error.socketPath === activeSocketPath,
        'native pty host startup should not unlink an active socket owned by another host'
      );
      assert(fs.existsSync(activeSocketPath), 'active native pty socket should remain after failed competing startup');
    } finally {
      await closeServer(activeServer);
      await competingHost.dispose().catch(() => {});
      fs.rmSync(activeSocketConfigDir, { recursive: true, force: true });
    }
  }

  const spawnedConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-native-spawned-'));
  const spawnedSocketPath = nativePtyHostSocketPath(spawnedConfigDir);
  const spawnedEngine = new NativeSessionEngine({ configDir: spawnedConfigDir, socketPath: spawnedSocketPath });
  try {
    await spawnedEngine.createSession({
      agentId: 'spawned-native-smoke',
      command: 'bash',
      args: [],
      cwd: process.cwd(),
      env: process.env,
      category: 'other',
      metadata: { command: 'bash', cwd: process.cwd() },
    });
    await waitFor(() => fs.existsSync(spawnedSocketPath), 'spawned native pty socket');
    const hostLogPath = path.join(spawnedConfigDir, 'native-pty-host.log');
    const hostLog = await waitFor(() => {
      if (!fs.existsSync(hostLogPath)) return null;
      const text = fs.readFileSync(hostLogPath, 'utf8');
      return text.includes('Starting native PTY host') && text.includes(spawnedSocketPath) ? text : null;
    }, 'spawned native pty host log');
    assert(hostLog.includes('Native PTY host listening'), hostLog);
    spawnedEngine.dispose();
    await waitFor(() => !fs.existsSync(spawnedSocketPath), 'spawned native pty host shutdown');
  } finally {
    spawnedEngine.dispose();
    fs.rmSync(spawnedConfigDir, { recursive: true, force: true });
  }

  const persistentConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-native-persistent-'));
  const persistentSocketPath = nativePtyHostSocketPath(persistentConfigDir);
  const previousIdleExitMs = process.env.FARMING_NATIVE_PTY_HOST_IDLE_EXIT_MS;
  process.env.FARMING_NATIVE_PTY_HOST_IDLE_EXIT_MS = '120';
  const persistentEngine = new NativeSessionEngine({
    configDir: persistentConfigDir,
    socketPath: persistentSocketPath,
    preserveHostOnDispose: true,
  });
  try {
    await persistentEngine.createSession({
      agentId: 'persistent-native-smoke',
      command: 'bash',
      args: [],
      cwd: process.cwd(),
      env: process.env,
      category: 'other',
      metadata: { command: 'bash', cwd: process.cwd() },
    });
    await waitFor(() => fs.existsSync(persistentSocketPath), 'persistent native pty socket');
    await persistentEngine.sendInput('persistent-native-smoke', "printf 'persistent-host-alive\\n'\n");
    await waitFor(async () => {
      const current = await persistentEngine.getSessionState('persistent-native-smoke');
      return current && current.output.includes('persistent-host-alive') ? current : null;
    }, 'persistent native pty output');

    persistentEngine.dispose();
    await waitFor(() => fs.existsSync(persistentSocketPath), 'persistent native pty socket after engine dispose');

    const reconnectedPersistentEngine = new NativeSessionEngine({
      configDir: persistentConfigDir,
      socketPath: persistentSocketPath,
    });
    try {
      const recovered = await reconnectedPersistentEngine.recoverSessions();
      assert(
        recovered.some(session => session.agentId === 'persistent-native-smoke'),
        'persistent native host should keep sessions recoverable after server-side engine dispose'
      );
      await reconnectedPersistentEngine.killSession('persistent-native-smoke');
    } finally {
      reconnectedPersistentEngine.dispose();
    }
    await waitFor(() => !fs.existsSync(persistentSocketPath), 'idle persistent native pty host shutdown');
  } finally {
    persistentEngine.dispose();
    await shutdownNativeHost(persistentConfigDir, persistentSocketPath).catch(() => {});
    await waitFor(() => !fs.existsSync(persistentSocketPath), 'persistent native pty host shutdown').catch(() => {});
    if (previousIdleExitMs == null) {
      delete process.env.FARMING_NATIVE_PTY_HOST_IDLE_EXIT_MS;
    } else {
      process.env.FARMING_NATIVE_PTY_HOST_IDLE_EXIT_MS = previousIdleExitMs;
    }
    fs.rmSync(persistentConfigDir, { recursive: true, force: true });
  }

  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-native-engine-'));
  const socketPath = nativePtyHostSocketPath(configDir);
  const host = new NativePtyHost({ configDir, socketPath });
  await host.start();

  const engine = new NativeSessionEngine({ configDir, socketPath });
  try {
    await engine.createSession({
      agentId: 'native-smoke',
      command: 'bash',
      args: [],
      cwd: process.cwd(),
      env: { ...process.env, NO_COLOR: '1', TERM: 'dumb' },
      category: 'other',
      cols: 80,
      rows: 24,
      metadata: { command: 'bash', cwd: process.cwd() },
    });

    await delay(300);
    await engine.sendInput(
      'native-smoke',
      "printf 'TERM=%s COLORTERM=%s NO_COLOR=%s\\n' \"$TERM\" \"$COLORTERM\" \"${NO_COLOR-unset}\"\nprintf '\\033[31mred\\033[0m\\n'\n"
    );

    const state = await waitFor(async () => {
      const current = await engine.getSessionState('native-smoke');
      return current
        && current.output.includes('\u001b[31mred\u001b[0m')
        && current.outputSeq !== null
        && current.stateRevision !== null
        ? current
        : null;
    }, 'native pty output');

    assert(state.output.includes('TERM=xterm-256color'), state.output);
    assert(state.output.includes('COLORTERM=truecolor'), state.output);
    assert(state.output.includes('NO_COLOR=unset'), state.output);
    assert(state.output.includes('\u001b[31mred\u001b[0m'), JSON.stringify(state.output));
    assert(state.outputSeq > 0, `expected outputSeq to advance, got ${state.outputSeq}`);
    assert.strictEqual(state.terminalStatus.kind, 'shell');
    assert.strictEqual(state.terminalStatus.cwd, process.cwd());
    assert.strictEqual(typeof state.terminalStatus.busy, 'boolean');

    const clearResult = await engine.clearBuffer('native-smoke');
    assert.strictEqual(clearResult.cleared, true, 'native session clear should report success');
    const clearedState = await waitFor(async () => {
      const current = await engine.getSessionState('native-smoke');
      return current
        && current.stateRevision !== null
        && current.stateRevision > state.stateRevision
        ? current
        : null;
    }, 'native pty clear');
    assert.strictEqual(clearedState.outputSeq, state.outputSeq, 'clear changes terminal state but is not PTY output');
    assert.strictEqual(clearedState.output.includes('TERM=xterm-256color'), false, clearedState.output);
    assert.strictEqual(clearedState.renderOutput.includes('TERM=xterm-256color'), false, clearedState.renderOutput);

    await engine.sendInput('native-smoke', "printf 'AFTER_CLEAR\\n'\n");
    const afterClearState = await waitFor(async () => {
      const current = await engine.getSessionState('native-smoke');
      return current && current.output.includes('AFTER_CLEAR') ? current : null;
    }, 'native pty output after clear');
    assert(afterClearState.output.includes('AFTER_CLEAR'), afterClearState.output);
    assert.strictEqual(afterClearState.output.includes('TERM=xterm-256color'), false, afterClearState.output);

    const {
      preparationToken,
      serializedTerminalState,
    } = await host.serializeTerminalState();
    assert(preparationToken, 'controlled rotation should return a preparation token');
    const reviveStates = deserializeTerminalState(serializedTerminalState);
    const reviveState = reviveStates.find(entry => entry.id === 'native-smoke');
    assert(reviveState, 'native PTY host should serialize every live terminal before controlled rotation');
    assert(reviveState.replayEvent.events[0].data.includes('AFTER_CLEAR'));
    assert.strictEqual(
      reviveState.replayEvent.events[0].data.includes('TERM=xterm-256color'),
      false,
      'serialized replay must respect the authoritative clear-buffer state'
    );
    await assert.rejects(
      () => engine.sendInput('native-smoke', "printf 'MUST_NOT_RUN_DURING_ROTATION\\n'\n"),
      /frozen for runtime rotation/,
      'input must be rejected after the exact serialization cut'
    );
    await assert.rejects(
      () => engine.resizeSession('native-smoke', 90, 30, {}),
      /frozen for runtime rotation/,
      'resize must be rejected after the exact serialization cut'
    );
    await assert.rejects(
      () => engine.clearBuffer('native-smoke'),
      /frozen for runtime rotation/,
      'clear must be rejected after the exact serialization cut'
    );

    const previousRuntimeEpoch = afterClearState.runtimeEpoch;
    assert.deepStrictEqual(
      host.resumeTerminalState(null, preparationToken),
      { resumed: 1 },
      'aborting a prepared rotation should unfreeze the original PTY'
    );
    await engine.killSession('native-smoke');
    await waitFor(async () => {
      const current = await host.getSessionState('native-smoke');
      return current && current.status === 'exited' ? current : null;
    }, 'old native pty exit before revive');

    let revivedSync = null;
    const onRevivedSync = payload => {
      if (payload?.sessionId === 'native-smoke' && payload.revived === true) {
        revivedSync = payload;
      }
    };
    engine.on('session-sync', onRevivedSync);
    await engine.createSession({
      agentId: 'native-smoke',
      command: 'bash',
      args: [],
      cwd: process.cwd(),
      env: process.env,
      category: 'other',
      metadata: { command: 'bash', cwd: process.cwd() },
      reviveState,
    });
    engine.off('session-sync', onRevivedSync);

    const revivedState = await waitFor(async () => {
      const current = await engine.getSessionState('native-smoke');
      return current
        && current.runtimeEpoch !== previousRuntimeEpoch
        && current.renderOutput.includes('History restored')
        ? current
        : null;
    }, 'revived native pty history');
    assert(revivedSync, 'revive should publish one authoritative replacement checkpoint');
    assert.strictEqual(revivedSync.runtimeEpoch, revivedState.runtimeEpoch);
    assert.strictEqual(revivedSync.outputSeq, 1, 'revived history starts a new runtime output sequence');
    assert.strictEqual(revivedSync.stateRevision, 1, 'revived history starts a new runtime state revision');
    assert(revivedState.renderOutput.includes('AFTER_CLEAR'), revivedState.renderOutput);
    assert.strictEqual(revivedState.renderOutput.includes('TERM=xterm-256color'), false);

    await engine.sendInput('native-smoke', "printf 'REVIVED_SHELL_LIVE\\n'\n");
    await waitFor(async () => {
      const current = await engine.getSessionState('native-smoke');
      return current && current.output.includes('REVIVED_SHELL_LIVE') ? current : null;
    }, 'revived native pty input');

    engine.dispose();

    const reconnected = new NativeSessionEngine({ configDir, socketPath });
    try {
      const recovered = await reconnected.recoverSessions();
      assert(
        recovered.some(session => session.agentId === 'native-smoke'),
        'native session should recover through the pty host'
      );
      await reconnected.killSession('native-smoke');
    } finally {
      reconnected.dispose();
    }

    await waitFor(async () => {
      const current = await host.getSessionState('native-smoke');
      return current && current.status === 'exited' ? current : null;
    }, 'native pty exit');

    console.log('✓ Native session engine hosts and recovers xterm-compatible PTYs');
  } finally {
    engine.dispose();
    await host.killSession('native-smoke').catch(() => {});
    await host.dispose().catch(() => {});
    fs.rmSync(configDir, { recursive: true, force: true });
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
