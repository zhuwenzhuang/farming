const assert = require('assert');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const WebSocket = require('ws');
const { WebSocketServer } = WebSocket;
const { CdpClient } = require('../../extensions/browser/backend/cdp-client');
const {
  CdpBrowserRuntime,
  browserLaunchArguments,
  resolveExternalCdpWebSocketUrl,
} = require('../../extensions/browser/backend/cdp-browser-runtime');
const {
  discoverBrowserExecutable,
  normalizeExternalCdpUrl,
} = require('../../extensions/browser/backend/executable-discovery');
const {
  applyBrowserResource,
  applyBrowserResourceDeletion,
  applyBrowserResourceSnapshot,
  mergeBrowserResource,
} = require('../../extensions/browser/frontend/browser-resource-state.ts');
const {
  BrowserResourceManager,
  normalizeUrl,
} = require('../../extensions/browser/backend/browser-resource-manager');

class FakeBrowserRuntime extends EventEmitter {
  constructor(options) {
    super();
    this.id = options.id;
    this.generation = options.generation;
    this.externalCdpUrl = options.externalCdpUrl || '';
    this.startedUrl = '';
    this.closed = false;
    this.closeFailures = 0;
    this.latestFrame = null;
    this.viewers = new Set();
    this.resizeCalls = 0;
  }

  async start(url) {
    this.startedUrl = url;
    this.emit('process-identity', {
      pid: 41_001 + this.generation,
      processGroupId: 41_001 + this.generation,
      startedAt: `generation-${this.generation}`,
      format: 'test-v1',
    });
    return { url, title: 'Fake Browser' };
  }

  async close() {
    if (this.closeFailures > 0) {
      this.closeFailures -= 1;
      throw new Error('close not proven');
    }
    this.closed = true;
  }

  async navigate(url) {
    this.startedUrl = url;
    return { url, title: 'Navigated' };
  }

  async goBack() {
    return { url: 'https://back.example/', title: 'Back' };
  }

  async goForward() {
    return { url: 'https://forward.example/', title: 'Forward' };
  }

  async reload() {
    return { url: this.startedUrl, title: 'Reloaded' };
  }

  async snapshot() {
    return { url: this.startedUrl, title: 'Fake Browser', elements: [{ ref: 'e1', role: 'button' }] };
  }

  async screenshot() {
    return { mimeType: 'image/png', data: 'cG5n' };
  }

  async click() {
    return { ok: true };
  }

  async type() {
    return { ok: true };
  }

  async press() {
    return { ok: true };
  }

  async wheel() {}
  async pointer() {}
  async resize() {
    this.resizeCalls += 1;
  }
  async insertText() {}
}

class FakeViewer extends EventEmitter {
  constructor() {
    super();
    this.readyState = 1;
    this.messages = [];
  }

  send(message) {
    this.messages.push(JSON.parse(message));
  }
}

async function testCdpClient() {
  const server = new WebSocketServer({ port: 0 });
  await new Promise(resolve => server.once('listening', resolve));
  const port = server.address().port;
  server.on('connection', socket => {
    socket.on('message', raw => {
      const message = JSON.parse(raw.toString());
      socket.send(JSON.stringify({
        id: message.id,
        sessionId: message.sessionId,
        result: { echoed: message.method },
      }));
      socket.send(JSON.stringify({
        method: 'Page.testEvent',
        sessionId: message.sessionId,
        params: { value: 42 },
      }));
    });
  });
  const client = new CdpClient({ timeoutMs: 1_000 });
  try {
    await client.connect(`ws://127.0.0.1:${port}`);
    const event = client.waitFor('Page.testEvent', { sessionId: 'session-1' });
    assert.deepStrictEqual(await client.send('Page.enable', {}, 'session-1'), { echoed: 'Page.enable' });
    assert.deepStrictEqual(await event, { value: 42 });
  } finally {
    client.close();
    await new Promise(resolve => server.close(resolve));
  }
}

async function testCdpClientConnectTimeout() {
  const sockets = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const client = new CdpClient({ timeoutMs: 50 });
  try {
    await assert.rejects(
      client.connect(`ws://127.0.0.1:${server.address().port}`),
      /connection timed out/,
    );
  } finally {
    client.close();
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  }
}

function testExternalCdpDiscoveryConfiguration() {
  assert.strictEqual(
    normalizeExternalCdpUrl('http://127.0.0.1:9222'),
    'http://127.0.0.1:9222/',
  );
  assert.strictEqual(
    normalizeExternalCdpUrl('ws://localhost:9222/devtools/browser/example'),
    'ws://localhost:9222/devtools/browser/example',
  );
  assert.strictEqual(normalizeExternalCdpUrl('http://10.0.0.8:9222'), '');
  assert.strictEqual(normalizeExternalCdpUrl('http://user:pass@127.0.0.1:9222'), '');
  assert.strictEqual(normalizeExternalCdpUrl('http://127.0.0.1:9222?token=secret'), '');
  assert.deepStrictEqual(
    discoverBrowserExecutable({
      env: { FARMING_BROWSER_CDP_URL: 'http://127.0.0.1:9222' },
      platform: 'linux',
    }),
    {
      kind: 'external-cdp',
      path: '',
      cdpUrl: 'http://127.0.0.1:9222/',
    },
  );
  assert.match(
    discoverBrowserExecutable({
      env: { FARMING_BROWSER_CDP_URL: 'http://browser.example:9222' },
      platform: 'linux',
    }).error,
    /loopback/,
  );
}

async function testExternalCdpRuntime() {
  const commands = [];
  const connections = [];
  let discoveryRequests = 0;
  const server = http.createServer();
  const webSocketServer = new WebSocketServer({ server });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  server.on('request', (request, response) => {
    if (request.url !== '/json/version') {
      response.writeHead(404).end();
      return;
    }
    discoveryRequests += 1;
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({
      webSocketDebuggerUrl: `ws://0.0.0.0:${port}/devtools/browser/external-test`,
    }));
  });
  webSocketServer.on('connection', socket => {
    connections.push(socket);
    socket.on('message', raw => {
      const message = JSON.parse(raw.toString());
      commands.push(message.method);
      const results = {
        'Target.createTarget': { targetId: 'target-external' },
        'Target.attachToTarget': { sessionId: 'session-external' },
        'Target.getTargets': {
          targetInfos: [
            { targetId: 'target-external', type: 'page', url: 'about:blank' },
            { targetId: 'popup-external', type: 'page', url: 'about:blank', openerId: 'target-external' },
          ],
        },
        'Page.captureScreenshot': { data: 'jpeg-frame' },
        'Runtime.evaluate': {
          result: {
            value: {
              url: 'about:blank',
              title: 'External Browser',
            },
          },
        },
        'Target.closeTarget': { success: true },
      };
      socket.send(JSON.stringify({
        id: message.id,
        sessionId: message.sessionId,
        result: results[message.method] || {},
      }));
    });
  });
  const endpoint = `http://127.0.0.1:${port}`;
  try {
    assert.strictEqual(
      await resolveExternalCdpWebSocketUrl(endpoint),
      `ws://127.0.0.1:${port}/devtools/browser/external-test`,
    );
    const runtime = new CdpBrowserRuntime({
      id: 'browser_external',
      generation: 1,
      externalCdpUrl: endpoint,
      profileDir: '/unused',
      launchBrowser: () => {
        throw new Error('External CDP must not launch a system browser');
      },
    });
    let processIdentityCommitted = false;
    runtime.on('process-identity', () => {
      processIdentityCommitted = true;
    });
    assert.deepStrictEqual(await runtime.start('about:blank'), {
      url: 'about:blank',
      title: 'External Browser',
    });
    const discoveryRequestsBeforeCleanup = discoveryRequests;
    connections[0].terminate();
    await new Promise(resolve => setImmediate(resolve));
    await runtime.close();
    assert.strictEqual(processIdentityCommitted, false);
    assert(connections.length >= 2, 'Target cleanup should reconnect after the original CDP connection is lost');
    assert.strictEqual(
      discoveryRequests,
      discoveryRequestsBeforeCleanup,
      'Cleanup must reconnect to the exact Browser WebSocket without rediscovery',
    );
    assert(commands.includes('Target.createTarget'));
    assert.strictEqual(
      commands.filter(method => method === 'Target.closeTarget').length,
      2,
      'Cleanup must close the root target and popups discovered through the opener chain',
    );
    assert(!commands.includes('Browser.close'));
  } finally {
    for (const client of webSocketServer.clients) client.terminate();
    await new Promise(resolve => webSocketServer.close(resolve));
    await new Promise(resolve => server.close(resolve));
  }
}

async function testExternalCdpLostCreateResponseCleanup() {
  let markerUrl = '';
  const connectedUrls = [];
  const closedTargets = [];
  const listener = () => () => {};
  const firstClient = {
    connect: async url => connectedUrls.push(url),
    onClose: listener,
    on: listener,
    send: async (method, params) => {
      if (method === 'Target.setDiscoverTargets') return {};
      if (method === 'Target.createTarget') {
        markerUrl = params.url;
        throw new Error('CDP connection lost after target creation');
      }
      throw new Error('original CDP connection is closed');
    },
    close() {},
  };
  const cleanupClient = {
    connect: async url => connectedUrls.push(url),
    send: async (method, params) => {
      if (method === 'Target.getTargets') {
        return { targetInfos: [{ targetId: 'lost-response-target', type: 'page', url: markerUrl }] };
      }
      if (method === 'Target.closeTarget') {
        closedTargets.push(params.targetId);
        return { success: true };
      }
      return {};
    },
    close() {},
  };
  const clients = [firstClient, cleanupClient];
  const runtime = new CdpBrowserRuntime({
    id: 'browser_lost_create',
    generation: 3,
    externalCdpUrl: 'ws://127.0.0.1:9222/devtools/browser/exact-browser',
    profileDir: '/unused',
    markerNonce: 'fixed-nonce',
    createClient: () => clients.shift(),
  });
  await assert.rejects(runtime.start('about:blank'), /lost after target creation/);
  assert.deepStrictEqual(connectedUrls, [
    'ws://127.0.0.1:9222/devtools/browser/exact-browser',
    'ws://127.0.0.1:9222/devtools/browser/exact-browser',
  ]);
  assert.deepStrictEqual(closedTargets, ['lost-response-target']);
  assert.match(markerUrl, /fixed-nonce/);
}

function testSystemBrowserLaunchFlags() {
  const profileDir = '/tmp/farming-browser-launch-flags';
  const sandboxed = browserLaunchArguments(profileDir, { platform: 'linux', noSandbox: false });
  const unsandboxed = browserLaunchArguments(profileDir, { platform: 'linux', noSandbox: true });
  assert(sandboxed.includes('--disable-dev-shm-usage'));
  assert(!sandboxed.includes('--no-sandbox'));
  assert(unsandboxed.includes('--no-sandbox'));
  assert(unsandboxed.includes('--disable-setuid-sandbox'));
  assert(sandboxed.includes('--remote-debugging-port=0'));
}

async function testBrowserLaunchGate() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-browser-gate-'));
  const fixture = path.join(root, 'browser-fixture.js');
  const marker = path.join(root, 'launched');
  const gatePath = path.join(__dirname, '..', '..', 'extensions', 'browser', 'backend', 'browser-launch-gate.js');
  fs.writeFileSync(fixture, `require('fs').writeFileSync(process.argv[2], 'launched');\n`);
  const gate = spawn(process.execPath, [gatePath, process.execPath, fixture, marker], {
    detached: true,
    stdio: ['pipe', 'ignore', 'ignore'],
  });
  try {
    await new Promise((resolve, reject) => {
      gate.once('spawn', resolve);
      gate.once('error', reject);
    });
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.strictEqual(fs.existsSync(marker), false, 'the Browser executable must not start before identity commit releases the gate');
    const exited = new Promise(resolve => gate.once('exit', resolve));
    gate.stdin.end('GO\n');
    await exited;
    assert.strictEqual(fs.readFileSync(marker, 'utf8'), 'launched');
  } finally {
    if (gate.exitCode === null && gate.signalCode === null) process.kill(-gate.pid, 'SIGKILL');
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function testScreencastFrameRateBound() {
  let now = 1_000;
  const scheduled = [];
  const cancelled = [];
  const runtime = new CdpBrowserRuntime({
    id: 'browser_test',
    generation: 1,
    executablePath: '/fake/chrome',
    profileDir: '/tmp/fake-browser-profile',
    now: () => now,
    scheduleTimeout: (callback, waitMs) => {
      const timer = { callback, waitMs };
      scheduled.push(timer);
      return timer;
    },
    cancelTimeout: timer => cancelled.push(timer),
  });
  runtime.sessionId = 'target-session';
  runtime.client = {
    send: async () => ({}),
  };
  const frames = [];
  runtime.on('frame', frame => frames.push(frame));

  runtime.publishScreencastFrame({ data: 'frame-1' }, 'target-session');
  assert.deepStrictEqual(frames, [{ data: 'frame-1' }], 'The first Browser frame should be visible immediately');

  now += 1;
  runtime.publishScreencastFrame({ data: 'frame-2' }, 'target-session');
  runtime.publishScreencastFrame({ data: 'frame-3' }, 'target-session');
  assert.strictEqual(frames.length, 1, 'Following Browser frames must wait for the frame-rate boundary');
  assert.strictEqual(scheduled.length, 1, 'A burst should own only one trailing frame timer');
  assert(scheduled[0].waitMs >= 65 && scheduled[0].waitMs <= 67);
  now += scheduled[0].waitMs;
  scheduled[0].callback();
  assert.deepStrictEqual(
    frames,
    [{ data: 'frame-1' }, { data: 'frame-3' }],
    'The trailing frame must be the newest frame from the burst',
  );

  now += 1;
  runtime.publishScreencastFrame({ data: 'stale-frame' }, 'target-session');
  await runtime.detachActiveTarget();
  assert.strictEqual(cancelled.length, 1, 'Detaching a page must cancel its delayed Viewer frame');
  scheduled[1].callback();
  assert.strictEqual(frames.length, 2, 'A detached page must not publish a stale trailing frame');
}

async function testDeterministicViewerFrameCapture() {
  const calls = [];
  const runtime = new CdpBrowserRuntime({
    id: 'browser_capture',
    generation: 7,
    executablePath: '/fake/chrome',
    profileDir: '/tmp/fake-browser-profile',
  });
  runtime.sessionId = 'capture-session';
  runtime.client = {
    send: async (method, params, sessionId) => {
      calls.push({ method, params, sessionId });
      return { data: 'jpeg-frame' };
    },
  };
  const frames = [];
  runtime.on('frame', frame => frames.push(frame));
  await runtime.captureViewerFrame();
  assert.deepStrictEqual(calls, [{
    method: 'Page.captureScreenshot',
    params: {
      format: 'jpeg',
      quality: 80,
      fromSurface: true,
      captureBeyondViewport: false,
    },
    sessionId: 'capture-session',
  }]);
  assert.deepStrictEqual(frames, [{
    type: 'browser-frame',
    generation: 7,
    data: 'jpeg-frame',
  }]);
  assert.deepStrictEqual(runtime.latestFrame, frames[0]);
}

async function testBrowserResourceManager() {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-browser-extension-'));
  const runtimes = [];
  let enabled = false;
  const unavailableManager = new BrowserResourceManager({
    configDir,
    discoverExecutable: () => null,
  });
  assert.deepStrictEqual(unavailableManager.capability(), {
    enabled: true,
    available: false,
    browser: null,
    message: 'Install a Chromium-based browser or configure a loopback external CDP endpoint',
  });
  const manager = new BrowserResourceManager({
    configDir,
    isEnabled: () => enabled,
    discoverExecutable: () => ({ kind: 'chrome', path: '/fake/chrome' }),
    createRuntime: options => {
      const runtime = new FakeBrowserRuntime(options);
      runtimes.push(runtime);
      return runtime;
    },
  });
  try {
    await manager.init();
    assert.deepStrictEqual(manager.capability(), {
      enabled: false,
      available: false,
      browser: { kind: 'chrome', path: '/fake/chrome' },
      message: 'Browser extension is disabled',
    });
    assert.throws(() => manager.list(), /disabled/);
    enabled = true;
    assert.strictEqual(manager.capability().available, true);
    const externalManager = new BrowserResourceManager({
      configDir,
      discoverExecutable: () => ({
        kind: 'external-cdp',
        path: '',
        cdpUrl: 'http://127.0.0.1:9222/',
      }),
    });
    assert.deepStrictEqual(externalManager.capability(), {
      enabled: true,
      available: true,
      browser: { kind: 'external-cdp', path: '' },
      message: '',
    });
    const created = manager.create({
      projectRootId: 'wroot_project',
      workspace: '/tmp/project',
      name: 'App',
      url: 'localhost:3000',
    });
    assert.strictEqual(created.status, 'stopped');
    assert.strictEqual(created.url, 'http://localhost:3000/');

    const transitions = [];
    manager.on('resource', resource => transitions.push(resource.status));
    const running = await manager.start(created.id);
    assert.strictEqual(running.status, 'running');
    assert.strictEqual(running.generation, 1);
    assert.strictEqual(running.revision, 3);
    assert.strictEqual(running.collectionRevision, manager.store.revision);
    assert.deepStrictEqual(manager.snapshot(), {
      collectionRevision: manager.store.revision,
      resources: [running],
    });
    assert.deepStrictEqual(transitions.slice(-2), ['starting', 'running']);
    assert.strictEqual(runtimes[0].startedUrl, 'http://localhost:3000/');
    assert.deepStrictEqual((await manager.action(created.id, { kind: 'snapshot' })).elements, [
      { ref: 'e1', role: 'button' },
    ]);

    const viewer = new FakeViewer();
    manager.attachViewer(created.id, viewer);
    assert.strictEqual(viewer.messages[0].type, 'browser-state');
    const frame = { type: 'browser-frame', generation: 1, data: 'frame' };
    runtimes[0].emit('frame', frame);
    assert.deepStrictEqual(viewer.messages.at(-1), frame);
    viewer.emit('message', Buffer.from(JSON.stringify({
      type: 'resize',
      generation: running.generation,
      width: 390,
      height: 800,
    })));
    await new Promise(resolve => setImmediate(resolve));
    assert.strictEqual(
      runtimes[0].resizeCalls,
      0,
      'Viewer layout must not mutate the authoritative Browser viewport',
    );

    const navigated = await manager.navigate(created.id, 'https://example.com/path');
    assert.strictEqual(navigated.url, 'https://example.com/path');
    assert.strictEqual(navigated.title, 'Navigated');
    const stopped = await manager.stop(created.id);
    assert.strictEqual(stopped.status, 'stopped');
    assert.strictEqual(runtimes[0].closed, true);

    const second = manager.create({
      projectRootId: 'wroot_project',
      workspace: '/tmp/project',
      name: 'Crash',
      url: 'about:blank',
    });
    await manager.start(second.id);
    runtimes[1].emit('exit', 'Browser crashed');
    await new Promise(resolve => setImmediate(resolve));
    assert.strictEqual(manager.get(second.id).status, 'failed');
    assert.strictEqual(manager.get(second.id).error, 'Browser crashed');

    const retryable = manager.create({
      projectRootId: 'wroot_project',
      workspace: '/tmp/project',
      name: 'Retry cleanup',
      url: 'about:blank',
    });
    await manager.start(retryable.id);
    runtimes[2].closeFailures = 1;
    await assert.rejects(manager.stop(retryable.id), /close not proven/);
    assert.strictEqual(manager.get(retryable.id).status, 'stopping');
    assert.strictEqual((await manager.stop(retryable.id)).status, 'stopped');

    await manager.delete(created.id);
    assert.throws(() => manager.get(created.id), /not found/);
    assert.throws(() => normalizeUrl('file:///tmp/private'), /only http/);

    const orphaned = manager.create({
      projectRootId: 'wroot_project',
      workspace: '/tmp/project',
      name: 'Restart recovery',
      url: 'about:blank',
    });
    const orphanedIdentity = {
      pid: 51_001,
      processGroupId: 51_001,
      startedAt: 'orphaned-browser',
      format: 'test-v1',
    };
    manager.store.update(orphaned.id, {
      status: 'running',
      processIdentity: orphanedIdentity,
    });
    let orphanedAlive = true;
    const killedGroups = [];
    const restartedManager = new BrowserResourceManager({
      configDir,
      discoverExecutable: () => ({ kind: 'chrome', path: '/fake/chrome' }),
      createRuntime: options => new FakeBrowserRuntime(options),
      readProcessIdentity: async pid => (
        orphanedAlive && pid === orphanedIdentity.pid ? orphanedIdentity : null
      ),
      killProcessGroup: (processGroupId, signal) => {
        killedGroups.push({ processGroupId, signal });
        orphanedAlive = false;
      },
    });
    await restartedManager.init();
    assert.strictEqual(restartedManager.capability().enabled, true, 'System browser integration should default to enabled');
    assert.strictEqual(restartedManager.get(orphaned.id).status, 'failed');
    assert.strictEqual(restartedManager.store.get(orphaned.id).processIdentity, null);
    assert.match(restartedManager.get(orphaned.id).error, /cleaned up/);
    assert.deepStrictEqual(killedGroups, [{
      processGroupId: orphanedIdentity.processGroupId,
      signal: 'SIGKILL',
    }]);
    await restartedManager.dispose();

    const blocked = manager.store.create({
      projectRootId: 'project_test',
      workspace: '/tmp/project-test',
      name: 'Permission recovery',
      url: 'about:blank',
    });
    const blockedIdentity = {
      pid: 51_002,
      processGroupId: 51_002,
      startedAt: 'permission-browser',
      format: 'test-v1',
    };
    manager.store.update(blocked.id, { status: 'running', processIdentity: blockedIdentity });
    const permissionManager = new BrowserResourceManager({
      configDir,
      discoverExecutable: () => ({ kind: 'chrome', path: '/fake/chrome' }),
      createRuntime: options => new FakeBrowserRuntime(options),
      readProcessIdentity: async pid => (pid === blockedIdentity.pid ? blockedIdentity : null),
      killProcessGroup: () => {
        const error = new Error('Operation not permitted');
        error.code = 'EPERM';
        throw error;
      },
    });
    await permissionManager.init();
    assert.strictEqual(permissionManager.store.get(blocked.id).processIdentity.pid, blockedIdentity.pid);
    await assert.rejects(
      () => permissionManager.stop(blocked.id),
      error => error.code === 'BROWSER_RECOVERY_CLEANUP_REQUIRED',
    );
    assert.strictEqual(
      permissionManager.store.get(blocked.id).processIdentity.pid,
      blockedIdentity.pid,
      'a failed cleanup must retain the exact Browser identity for retry',
    );
    await permissionManager.dispose();
  } finally {
    await manager.dispose();
    fs.rmSync(configDir, { recursive: true, force: true });
  }
}

async function testExternalBrowserErrorRedaction() {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-external-browser-errors-'));
  let failStart = true;
  let failClose = false;
  const manager = new BrowserResourceManager({
    configDir,
    discoverExecutable: () => ({
      kind: 'external-cdp',
      path: '',
      cdpUrl: 'http://127.0.0.1:9222/',
    }),
    createRuntime: options => {
      const runtime = new EventEmitter();
      runtime.id = options.id;
      runtime.generation = options.generation;
      runtime.start = async url => {
        if (failStart) throw new Error('connect ECONNREFUSED 127.0.0.1:9222');
        return { url, title: 'External Browser' };
      };
      runtime.close = async () => {
        if (failClose) throw new Error('connect ECONNREFUSED 127.0.0.1:9222');
      };
      return runtime;
    },
  });
  try {
    await manager.init();
    const failed = manager.create({
      projectRootId: 'wroot_external',
      workspace: '/tmp/external',
      name: 'External',
      url: 'about:blank',
    });
    await assert.rejects(
      manager.start(failed.id),
      error => error.code === 'BROWSER_START_FAILED' && !error.message.includes('127.0.0.1'),
    );
    assert(!manager.get(failed.id).error.includes('127.0.0.1'));

    failStart = false;
    await manager.start(failed.id);
    failClose = true;
    await assert.rejects(
      manager.stop(failed.id),
      error => error.code === 'BROWSER_EXTERNAL_CDP_FAILED' && !error.message.includes('127.0.0.1'),
    );
    failClose = false;
    await manager.stop(failed.id);
  } finally {
    await manager.dispose();
    fs.rmSync(configDir, { recursive: true, force: true });
  }
}

function testBrowserResourceRevisionOrdering() {
  const current = {
    id: 'browser_revision',
    projectRootId: 'wroot_project',
    workspace: '/tmp/project',
    name: 'Browser',
    status: 'running',
    generation: 1,
    revision: 2,
    collectionRevision: 3,
    url: 'about:blank',
    title: '',
    browserKind: 'chrome',
    error: '',
    createdAt: 1,
    updatedAt: 2,
  };
  const stale = { ...current, status: 'starting', revision: 1, updatedAt: 1 };
  assert.strictEqual(
    mergeBrowserResource([current], stale)[0],
    current,
    'A late starting event must not replace the newer running response',
  );
  const newer = { ...current, status: 'failed', revision: 3, updatedAt: 3 };
  assert.deepStrictEqual(mergeBrowserResource([current], newer), [newer]);

  const running = applyBrowserResource(
    { collectionRevision: 0, resources: [] },
    current,
  );
  assert.strictEqual(running.collectionRevision, 3);
  assert.strictEqual(
    applyBrowserResourceSnapshot(running, { collectionRevision: 1, resources: [] }),
    running,
    'A late empty bootstrap snapshot must not remove a Browser created by a newer HTTP response',
  );
  assert.strictEqual(
    applyBrowserResource(running, stale),
    running,
    'A late starting event must not replace the running Resource collection',
  );
  assert.deepStrictEqual(
    applyBrowserResourceDeletion(running, {
      id: current.id,
      collectionRevision: 4,
    }),
    { collectionRevision: 4, resources: [] },
  );
}

function testBrowserUiAndPackagingWiring() {
  const projectRoot = path.join(__dirname, '..', '..');
  const workspaceSource = fs.readFileSync(path.join(projectRoot, 'src', 'components', 'CodeWorkspace.tsx'), 'utf8');
  const mainAreaSource = fs.readFileSync(path.join(projectRoot, 'src', 'components', 'code', 'CodeMainArea.tsx'), 'utf8');
  const serverSource = fs.readFileSync(path.join(projectRoot, 'backend', 'server.js'), 'utf8');
  const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
  assert(workspaceSource.includes('<BrowserSidebarPortals'));
  assert(workspaceSource.includes("setMainPaneMode('browser')"));
  assert(mainAreaSource.includes('<BrowserViewer'));
  assert(serverSource.includes("createBrowserRouter(browserResourceManager"));
  assert.strictEqual(packageJson.dependencies['playwright-core'], undefined);
  assert.strictEqual(packageJson.bin['farming-browser'], 'extensions/browser/bin/farming-browser');
  assert(packageJson.files.includes('extensions/browser/'));
  assert(packageJson.files.includes('backend/farming-agent-bootstrap.zh_cn.md'));
}

Promise.resolve()
  .then(testCdpClient)
  .then(testCdpClientConnectTimeout)
  .then(testExternalCdpDiscoveryConfiguration)
  .then(testExternalCdpRuntime)
  .then(testExternalCdpLostCreateResponseCleanup)
  .then(testSystemBrowserLaunchFlags)
  .then(testBrowserLaunchGate)
  .then(testScreencastFrameRateBound)
  .then(testDeterministicViewerFrameCapture)
  .then(testBrowserResourceManager)
  .then(testExternalBrowserErrorRedaction)
  .then(testBrowserResourceRevisionOrdering)
  .then(testBrowserUiAndPackagingWiring)
  .then(() => console.log('browser extension tests passed'))
  .catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
