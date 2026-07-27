const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
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
    this.resizeValues = [];
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
  async resize(value) {
    this.resizeCalls += 1;
    this.resizeValues.push(value);
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

async function testBrowserResourceManager() {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-browser-extension-'));
  const runtimes = [];
  let enabled = false;
  const unavailableManager = new BrowserResourceManager({
    configDir,
    discoverExecutable: () => null,
  });
  await unavailableManager.init();
  assert.deepStrictEqual(unavailableManager.capability(), {
    enabled: true,
    available: false,
    browser: null,
    message: 'Install agent-browser and a Chromium-based browser, or configure a loopback external CDP endpoint',
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
    await externalManager.init();
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
      width: 1200,
      height: 700,
      deviceScaleFactor: 2,
    })));
    viewer.emit('message', Buffer.from(JSON.stringify({
      type: 'resize',
      generation: running.generation,
      width: 1280,
      height: 720,
      deviceScaleFactor: 2,
    })));
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.strictEqual(runtimes[0].resizeCalls, 1, 'Rapid primary Viewer resizes must coalesce');
    assert.deepStrictEqual(runtimes[0].resizeValues, [{ width: 1280, height: 720, deviceScaleFactor: 2 }]);

    const mobileViewer = new FakeViewer();
    manager.attachViewer(created.id, mobileViewer);
    mobileViewer.emit('message', Buffer.from(JSON.stringify({
      type: 'resize',
      generation: running.generation,
      width: 390,
      height: 800,
    })));
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.strictEqual(
      runtimes[0].resizeCalls,
      1,
      'A secondary Viewer must not fight the primary Viewer for Browser geometry',
    );
    mobileViewer.emit('message', Buffer.from(JSON.stringify({
      type: 'resize',
      generation: running.generation,
      width: 390,
      height: 800,
      claim: true,
    })));
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.deepStrictEqual(
      runtimes[0].resizeValues,
      [
        { width: 1280, height: 720, deviceScaleFactor: 2 },
        { width: 390, height: 800, deviceScaleFactor: 1 },
      ],
      'A focused Viewer must be able to take geometry ownership',
    );
    viewer.emit('message', Buffer.from(JSON.stringify({
      type: 'resize',
      generation: running.generation,
      width: 1300,
      height: 730,
    })));
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.strictEqual(
      runtimes[0].resizeCalls,
      2,
      'The old Viewer must become passive after ownership transfers',
    );
    mobileViewer.emit('close');
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.deepStrictEqual(
      runtimes[0].resizeValues,
      [
        { width: 1280, height: 720, deviceScaleFactor: 2 },
        { width: 390, height: 800, deviceScaleFactor: 1 },
        { width: 1300, height: 730, deviceScaleFactor: 1 },
      ],
      'The previous Viewer must regain ownership with its latest geometry when the owner disconnects',
    );
    viewer.emit('close');

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

async function testAgentBrowserRestartRecovery() {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-agent-browser-recovery-'));
  const seed = new BrowserResourceManager({
    configDir,
    discoverExecutable: () => ({
      kind: 'external-cdp',
      path: '',
      cdpUrl: 'http://127.0.0.1:9222/',
      agentBrowserPath: '/test/agent-browser',
    }),
  });
  try {
    await seed.init();
    const created = seed.store.create({
      projectRootId: 'wroot_recovery',
      workspace: '/tmp/recovery',
      name: 'Recover',
      url: 'about:blank',
    });
    seed.store.update(created.id, {
      status: 'starting',
      generation: 7,
      browserKind: 'external-cdp',
      runtimeKind: 'agent-browser',
      processIdentity: null,
    });
    const local = seed.store.create({
      projectRootId: 'wroot_recovery',
      workspace: '/tmp/recovery',
      name: 'Recover local',
      url: 'about:blank',
    });
    seed.store.update(local.id, {
      status: 'running',
      generation: 3,
      browserKind: 'chrome',
      runtimeKind: 'agent-browser',
      processIdentity: null,
    });
    const recoveries = [];
    const recovered = new BrowserResourceManager({
      configDir,
      discoverExecutable: () => ({
        kind: 'external-cdp',
        path: '',
        cdpUrl: 'http://127.0.0.1:9222/',
        agentBrowserPath: '/test/agent-browser',
      }),
      recoverRuntime: async input => recoveries.push(input),
    });
    await recovered.init();
    assert.strictEqual(recoveries.length, 2);
    assert(recoveries.some(input => input.id === created.id && input.generation === 7));
    assert(recoveries.some(input => input.id === local.id && input.generation === 3));
    assert.strictEqual(recovered.store.get(created.id).status, 'failed');
    assert.match(recovered.store.get(created.id).error, /cleaned up/);
    assert.strictEqual(recovered.store.get(local.id).processIdentity, null);
    await recovered.dispose();
  } finally {
    await seed.dispose();
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
  const sidebarSource = fs.readFileSync(path.join(projectRoot, 'extensions', 'browser', 'frontend', 'BrowserSidebarPortals.tsx'), 'utf8');
  const serverSource = fs.readFileSync(path.join(projectRoot, 'backend', 'server.js'), 'utf8');
  const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
  assert(workspaceSource.includes('<BrowserSidebarPortals'));
  assert(workspaceSource.includes("setMainPaneMode('browser')"));
  assert(mainAreaSource.includes('<BrowserViewer'));
  assert(!sidebarSource.includes('window.confirm'), 'Browser row close must remove directly without a redundant confirmation');
  assert(serverSource.includes("createBrowserRouter(browserResourceManager"));
  assert.strictEqual(packageJson.dependencies['playwright-core'], undefined);
  assert.strictEqual(packageJson.bin['farming-browser'], 'extensions/browser/bin/farming-browser');
  assert(packageJson.files.includes('extensions/browser/'));
  assert(packageJson.files.includes('backend/farming-agent-bootstrap.zh_cn.md'));
}

Promise.resolve()
  .then(testExternalCdpDiscoveryConfiguration)
  .then(testBrowserResourceManager)
  .then(testExternalBrowserErrorRedaction)
  .then(testAgentBrowserRestartRecovery)
  .then(testBrowserResourceRevisionOrdering)
  .then(testBrowserUiAndPackagingWiring)
  .then(() => console.log('browser extension tests passed'))
  .catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
