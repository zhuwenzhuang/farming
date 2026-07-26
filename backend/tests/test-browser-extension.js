const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const WebSocket = require('ws');
const { WebSocketServer } = WebSocket;
const { CdpClient } = require('../../extensions/browser/backend/cdp-client');
const { CdpBrowserRuntime } = require('../../extensions/browser/backend/cdp-browser-runtime');
const {
  BrowserResourceManager,
  normalizeUrl,
} = require('../../extensions/browser/backend/browser-resource-manager');

class FakeBrowserRuntime extends EventEmitter {
  constructor(options) {
    super();
    this.id = options.id;
    this.generation = options.generation;
    this.startedUrl = '';
    this.closed = false;
    this.closeFailures = 0;
    this.latestFrame = null;
    this.viewers = new Set();
    this.resizeCalls = 0;
  }

  async start(url) {
    this.startedUrl = url;
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
    message: 'Install a Chromium-based browser to use the system Browser in Farming',
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
    manager.init();
    assert.deepStrictEqual(manager.capability(), {
      enabled: false,
      available: false,
      browser: { kind: 'chrome', path: '/fake/chrome' },
      message: 'Browser extension is disabled',
    });
    assert.throws(() => manager.list(), /disabled/);
    enabled = true;
    assert.strictEqual(manager.capability().available, true);
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
    manager.store.update(orphaned.id, { status: 'running' });
    const restartedManager = new BrowserResourceManager({
      configDir,
      discoverExecutable: () => ({ kind: 'chrome', path: '/fake/chrome' }),
      createRuntime: options => new FakeBrowserRuntime(options),
    });
    restartedManager.init();
    assert.strictEqual(restartedManager.capability().enabled, true, 'System browser integration should default to enabled');
    assert.strictEqual(restartedManager.get(orphaned.id).status, 'failed');
    assert.match(restartedManager.get(orphaned.id).error, /restarted/);
    await restartedManager.dispose();
  } finally {
    await manager.dispose();
    fs.rmSync(configDir, { recursive: true, force: true });
  }
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
  .then(testScreencastFrameRateBound)
  .then(testBrowserResourceManager)
  .then(testBrowserUiAndPackagingWiring)
  .then(() => console.log('browser extension tests passed'))
  .catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
