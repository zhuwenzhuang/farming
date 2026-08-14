const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const express = require('express');
const {
  discoverBrowserExecutable,
  discoverBrowserRuntime,
  normalizeExternalCdpUrl,
} = require('../../extensions/browser/backend/executable-discovery.cjs');
const {
  applyBrowserResource,
  applyBrowserResourceDeletion,
  applyBrowserResourceSnapshot,
  emptyBrowserResourceState,
  mergeBrowserResource,
} = require('../../extensions/browser/frontend/browser-resource-state.ts');
const {
  BrowserResourceManager,
  normalizeUrl,
} = require('../../extensions/browser/backend/browser-resource-manager.cjs');
const {
  createBrowserRouter,
} = require('../../extensions/browser/backend/browser-router.cjs');
const { configInstanceFingerprint } = require('../config-instance.cjs');

class FakeBrowserRuntime extends EventEmitter {
  constructor(options) {
    super();
    this.id = options.id;
    this.generation = options.generation;
    this.configDir = options.configDir;
    this.profileDir = options.profileDir;
    this.externalCdpUrl = options.externalCdpUrl || '';
    this.selectInitialExternalTab = options.selectInitialExternalTab || null;
    this.startedUrl = '';
    this.closed = false;
    this.closeFailures = 0;
    this.latestFrame = null;
    this.viewers = new Set();
    this.resizeCalls = 0;
    this.resizeValues = [];
    this.actionCalls = [];
    this.tabs = [];
    this.nextTab = 1;
    this.activeTabId = '';
    this.streamTabId = '';
    this.ownedTabIds = new Set();
    this.closedTabIds = [];
    this.emitStaleTabsBeforeCreate = false;
  }

  async start(url) {
    this.startedUrl = url;
    const candidate = {
      active: true,
      label: null,
      tabId: `t${this.nextTab++}`,
      title: url === 'https://account.example/' ? 'Signed in account' : 'Fake Browser',
      type: 'page',
      url,
    };
    const selected = this.selectInitialExternalTab
      ? await this.selectInitialExternalTab([candidate])
      : candidate;
    const tab = {
      ...selected,
      active: true,
    };
    this.tabs = [tab];
    this.activeTabId = tab.tabId;
    this.streamTabId = tab.tabId;
    this.emit('process-identity', {
      pid: 41_001 + this.generation,
      processGroupId: 41_001 + this.generation,
      startedAt: `generation-${this.generation}`,
      format: 'test-v1',
    });
    return { url, title: 'Fake Browser' };
  }

  async listTabs() {
    return this.tabs.map(tab => ({ ...tab }));
  }

  async createTab(url) {
    if (this.emitStaleTabsBeforeCreate) {
      this.emit('tabs', {
        tabs: this.tabs.map(tab => ({ ...tab })),
        newTabIds: [],
      });
    }
    this.tabs.forEach(tab => { tab.active = false; });
    const tab = {
      active: true,
      label: null,
      tabId: `t${this.nextTab++}`,
      title: 'Fake Browser',
      type: 'page',
      url,
    };
    this.tabs.push(tab);
    this.activeTabId = tab.tabId;
    this.streamTabId = tab.tabId;
    this.emit('tabs', { tabs: this.tabs.map(candidate => ({ ...candidate })), newTabIds: [tab.tabId] });
    return { ...tab };
  }

  async switchTab(tabId) {
    const tab = this.tabs.find(candidate => candidate.tabId === tabId);
    if (!tab) throw new Error('missing fake tab');
    this.tabs.forEach(candidate => { candidate.active = candidate === tab; });
    this.activeTabId = tabId;
    this.streamTabId = tabId;
    return { ...tab };
  }

  async closeTab(tabId) {
    this.closedTabIds.push(tabId);
    this.tabs = this.tabs.filter(tab => tab.tabId !== tabId);
    if (this.activeTabId === tabId) {
      const next = this.tabs[0];
      if (next) next.active = true;
      this.activeTabId = next?.tabId || '';
      this.streamTabId = next?.tabId || '';
    }
    this.emit('tabs', { tabs: this.tabs.map(tab => ({ ...tab })), newTabIds: [] });
    return this.listTabs();
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

  async click(input) {
    this.actionCalls.push({ kind: 'click', input });
    return { ok: true };
  }

  async type() {
    return { ok: true };
  }

  async press() {
    return { ok: true };
  }

  async elementAction(kind, input) {
    this.actionCalls.push({ kind, input });
    return { ok: true };
  }

  async evaluate(input) {
    this.actionCalls.push({ kind: 'eval', input });
    return { value: 'evaluated' };
  }

  async upload(input) {
    this.actionCalls.push({ kind: 'upload', input });
    return { ok: true };
  }

  async download(input) {
    this.actionCalls.push({ kind: 'download', input });
    fs.writeFileSync(input.outputPath, 'downloaded');
    return { ok: true };
  }

  async wheel(input) {
    this.actionCalls.push({ kind: 'wheel', input });
  }
  async pointer(input) {
    this.actionCalls.push({ kind: 'pointer', input });
  }
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

function testInternalCdpDiscoveryConfiguration() {
  assert.deepStrictEqual(
    discoverBrowserExecutable({ source: 'isolated' }),
    { kind: 'isolated-computer', path: '' },
  );
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
      source: 'external-cdp',
      externalCdpUrl: 'http://127.0.0.1:9222',
    }),
    {
      kind: 'external-cdp',
      path: '',
      cdpUrl: 'http://127.0.0.1:9222/',
    },
  );
  assert.match(
    discoverBrowserExecutable({
      source: 'external-cdp',
      externalCdpUrl: 'http://browser.example:9222',
    }).error,
    /loopback/,
  );
}

async function testManagedAgentBrowserDiscovery() {
  const probed = [];
  const managedPath = '/farming/runtime/agent-browser';
  const runtime = await discoverBrowserRuntime({
    source: 'external-cdp',
    externalCdpUrl: 'http://127.0.0.1:9222',
    platform: 'linux',
    env: {
      FARMING_AGENT_BROWSER_BIN: managedPath,
      FARMING_NODE_LD: '/runtime/ld-linux.so',
      FARMING_NODE_LIBRARY_PATH: '/runtime/lib',
      PATH: '/system/bin',
    },
    execFile(executablePath, args, options, callback) {
      probed.push({ executablePath, args, env: options.env });
      callback(null, 'agent-browser 0.32.3', '');
    },
  });
  assert.strictEqual(runtime.agentBrowserPath, managedPath);
  assert.strictEqual(runtime.agentBrowserSource, 'managed');
  assert.deepStrictEqual(probed, [{
    executablePath: '/runtime/ld-linux.so',
    args: ['--library-path', '/runtime/lib', managedPath, '--version'],
    env: {
      FARMING_AGENT_BROWSER_BIN: managedPath,
      FARMING_NODE_LD: '/runtime/ld-linux.so',
      FARMING_NODE_LIBRARY_PATH: '/runtime/lib',
      PATH: '/system/bin',
    },
  }]);

  probed.length = 0;
  const staticRuntime = await discoverBrowserRuntime({
    source: 'external-cdp',
    externalCdpUrl: 'http://127.0.0.1:9222',
    platform: 'linux',
    env: {
      FARMING_AGENT_BROWSER_BIN: managedPath,
      FARMING_AGENT_BROWSER_STATIC: '1',
      FARMING_NODE_LD: '/runtime/ld-linux.so',
      FARMING_NODE_LIBRARY_PATH: '/runtime/lib',
      PATH: '/system/bin',
    },
    execFile(executablePath, args, options, callback) {
      probed.push({ executablePath, args, env: options.env });
      callback(null, 'agent-browser 0.32.3', '');
    },
  });
  assert.strictEqual(staticRuntime.agentBrowserPath, managedPath);
  assert.strictEqual(probed[0].executablePath, managedPath);
  assert.deepStrictEqual(probed[0].args, ['--version']);

  const missing = await discoverBrowserRuntime({
    source: 'external-cdp',
    externalCdpUrl: 'http://127.0.0.1:9222',
    env: {
      PATH: '/system/bin',
    },
    execFile() {
      throw new Error('system agent-browser must not be probed');
    },
  });
  assert.strictEqual(missing.runtimeErrorCode, 'NOT_FOUND');

  const browserDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-managed-browser-discovery-'));
  const systemBrowserPath = path.join(browserDir, 'google-chrome');
  fs.writeFileSync(systemBrowserPath, 'fake system chrome');
  fs.chmodSync(systemBrowserPath, 0o755);
  const previousPath = process.env.PATH;
  try {
    process.env.PATH = `${browserDir}${path.delimiter}${previousPath || ''}`;
    assert.deepStrictEqual(
      discoverBrowserExecutable({
        source: 'system',
        platform: 'linux',
      }),
      { kind: 'chrome', path: systemBrowserPath },
      'system discovery should find an installed Chromium browser',
    );
    assert.strictEqual(
      discoverBrowserExecutable({
        source: 'system',
        platform: 'freebsd',
      }),
      null,
      'an unavailable system selection must not fall back to another Browser source',
    );
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    fs.rmSync(browserDir, { recursive: true, force: true });
  }
}

async function testBrowserResourceManager() {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-browser-extension-'));
  const projectWorkspace = path.join(configDir, 'project');
  fs.mkdirSync(projectWorkspace);
  const canonicalConfigDir = fs.realpathSync.native(configDir);
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
    selection: {
      source: 'system',
      executablePath: '',
    },
    options: [],
    message: 'Choose a local Chromium browser or prepare the isolated Browser runtime',
  });
  let migratedBrowserSettings = {
    browserSource: 'system',
    browserExecutablePath: '',
  };
  let defaultBrowserProbes = 0;
  const defaultBrowserManager = new BrowserResourceManager({
    configDir,
    getBrowserSettings: () => migratedBrowserSettings,
    saveBrowserSelection: selection => {
      migratedBrowserSettings = {
        browserSource: selection.source,
        browserExecutablePath: selection.executablePath,
      };
    },
    discoverBrowserOptions: () => [{ kind: 'chrome', path: '/detected/chrome' }],
    discoverExecutable: selection => {
      defaultBrowserProbes += 1;
      return selection.executablePath === '/detected/chrome'
        ? { kind: 'chrome', path: selection.executablePath, agentBrowserPath: '/fake/agent-browser' }
        : null;
    },
  });
  await defaultBrowserManager.init();
  assert.deepStrictEqual(migratedBrowserSettings, {
    browserSource: 'system',
    browserExecutablePath: '/detected/chrome',
  });
  assert.strictEqual(defaultBrowserManager.capability().selection.executablePath, '/detected/chrome');
  await defaultBrowserManager.refreshCapability(undefined, { reuseVerified: true });
  await defaultBrowserManager.refreshCapability(undefined, { reuseVerified: true });
  assert.strictEqual(defaultBrowserProbes, 1, 'unchanged Browser capability reads should reuse the verified probe');
  await defaultBrowserManager.refreshCapability();
  assert.strictEqual(defaultBrowserProbes, 2, 'explicit capability changes should still run a full probe');
  await defaultBrowserManager.dispose();
  let missingBrowserSelectionSaved = false;
  const missingBrowserManager = new BrowserResourceManager({
    configDir,
    getBrowserSettings: () => ({
      browserSource: 'system',
      browserExecutablePath: '/missing/chrome',
    }),
    saveBrowserSelection: () => {
      missingBrowserSelectionSaved = true;
    },
    discoverBrowserOptions: () => [{ kind: 'chromium', path: '/detected/chromium' }],
    discoverExecutable: selection => selection.executablePath === '/detected/chromium'
      ? { kind: 'chromium', path: selection.executablePath, agentBrowserPath: '/fake/agent-browser' }
      : null,
  });
  await missingBrowserManager.init();
  assert.strictEqual(missingBrowserSelectionSaved, false);
  assert.strictEqual(missingBrowserManager.capability().browser, null);
  assert.strictEqual(missingBrowserManager.capability().selection.executablePath, '/missing/chrome');
  await missingBrowserManager.dispose();
  type ViewerResizeTimer = { callback: () => void; unref(): void };
  const viewerResizeTimers = new Set<ViewerResizeTimer>();
  const scheduleViewerResize = (callback: () => void): ViewerResizeTimer => {
    const timer = { callback, unref() {} };
    viewerResizeTimers.add(timer);
    return timer;
  };
  const cancelViewerResize = (timer: ViewerResizeTimer) => { viewerResizeTimers.delete(timer); };
  const manager = new BrowserResourceManager({
    configDir,
    isEnabled: () => enabled,
    discoverExecutable: () => ({
      kind: 'chrome',
      path: '/fake/chrome',
      agentBrowserPath: '/fake/agent-browser',
    }),
    createRuntime: options => {
      const runtime = new FakeBrowserRuntime(options);
      runtimes.push(runtime);
      return runtime;
    },
    scheduleTimeout: scheduleViewerResize,
    cancelTimeout: cancelViewerResize,
  });
  const flushViewerResize = async () => {
    const timers = [...viewerResizeTimers];
    viewerResizeTimers.clear();
    for (const timer of timers) timer.callback();
    await manager.sessions.values().next().value.actionChain;
  };
  try {
    await manager.init();
    assert.strictEqual(
      manager.store.directory,
      path.join(canonicalConfigDir, 'browsers'),
      'Browser registry storage must stay under the canonical Config directory',
    );
    assert.deepStrictEqual(manager.capability(), {
      enabled: false,
      available: false,
      browser: { kind: 'chrome', path: '/fake/chrome' },
      selection: {
        source: 'system',
        executablePath: '',
      },
      options: [],
      message: 'Browser extension is disabled',
    });
    assert.throws(() => manager.list(), /disabled/);
    enabled = true;
    assert.strictEqual(manager.capability().available, true);
    assert.throws(() => manager.create({
      projectRootId: 'wroot_project',
      workspace: projectWorkspace,
      browserSource: 'external-cdp',
    }), error => error?.code === 'BROWSER_INVALID_SOURCE');
    const isolatedConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-isolated-browser-manager-'));
    const isolatedCalls = {
      acquired: 0,
      released: 0,
      deleted: 0,
      deleteShouldFail: true,
      runtimeOptions: null,
    };
    const isolatedManager = new BrowserResourceManager({
      configDir: isolatedConfigDir,
      getBrowserSettings: () => ({ browserSource: 'isolated' }),
      isolatedBrowserProvider: {
        capability: async () => ({
          available: true,
          dockerAvailable: true,
          imageReady: true,
        }),
        prepare: async () => ({}),
        acquire: async ({ ownerKey }) => {
          isolatedCalls.acquired += 1;
          return { cdpUrl: 'http://127.0.0.1:19444', leaseKey: ownerKey };
        },
        release: async () => {
          isolatedCalls.released += 1;
        },
        deleteOwner: async () => {
          isolatedCalls.deleted += 1;
          if (isolatedCalls.deleteShouldFail) throw new Error('Docker rm failed');
        },
      },
      discoverExecutable: async selection => (
        selection.source === 'isolated'
          ? {
              kind: 'isolated-computer',
              path: '',
              agentBrowserPath: '/fake/agent-browser',
            }
          : null
      ),
      createRuntime: options => {
        isolatedCalls.runtimeOptions = options;
        return new FakeBrowserRuntime(options);
      },
    });
    try {
      await isolatedManager.init();
      assert.strictEqual(isolatedManager.capability().browser.kind, 'isolated-computer');
      assert.strictEqual(isolatedManager.capability().selection.source, 'isolated');
      assert.throws(() => isolatedManager.create({
        projectRootId: 'wroot_isolated',
        workspace: projectWorkspace,
        ownerType: 'project',
        ownerAgentId: '',
        name: 'Invalid Project Browser',
        url: 'https://example.com',
      }), error => (
        error?.code === 'ISOLATED_BROWSER_AGENT_OWNER_REQUIRED'
        && error?.status === 409
      ), 'isolated Browser creation must reject a Project owner before persisting an unusable row');
      const isolatedResource = isolatedManager.create({
        projectRootId: 'wroot_isolated',
        workspace: projectWorkspace,
        ownerType: 'agent',
        ownerAgentId: 'agent_isolated',
        name: 'Isolated',
        url: 'https://example.com',
      });
      await isolatedManager.start(isolatedResource.id);
      assert.strictEqual(isolatedCalls.acquired, 1);
      assert.strictEqual(
        isolatedCalls.runtimeOptions.externalCdpUrl,
        'http://127.0.0.1:19444',
      );
      await assert.rejects(isolatedManager.delete(isolatedResource.id), /Docker rm failed/);
      assert.strictEqual(
        isolatedManager.store.get(isolatedResource.id)?.status,
        'stopped',
        'failed container deletion must retain the stopped Browser row for retry',
      );
      isolatedCalls.deleteShouldFail = false;
      await isolatedManager.delete(isolatedResource.id);
      assert.strictEqual(isolatedCalls.released, 1);
      assert.strictEqual(isolatedCalls.deleted, 2);
    } finally {
      await isolatedManager.dispose();
      fs.rmSync(isolatedConfigDir, { recursive: true, force: true });
    }
    const created = manager.create({
      projectRootId: 'wroot_project',
      workspace: projectWorkspace,
      name: 'App',
      url: 'localhost:3000',
    });
    assert.strictEqual(created.status, 'stopped');
    assert.strictEqual(created.url, 'http://localhost:3000/');
    assert.strictEqual(created.ownerType, 'project', 'Existing create callers migrate to Project ownership');
    assert.strictEqual(created.ownerAgentId, '');

    const transitions = [];
    manager.on('resource', resource => transitions.push(resource.status));
    const running = await manager.start(created.id);
    assert.strictEqual(running.status, 'running');
    assert.strictEqual(running.generation, 1);
    assert.strictEqual(running.revision, 3);
    assert.strictEqual(running.collectionRevision, manager.store.revision);
    assert.strictEqual(
      manager.store.get(created.id).processIdentity.configInstanceFingerprint,
      configInstanceFingerprint(configDir),
      'Browser process ownership must persist the exact Config fingerprint',
    );
    assert.strictEqual(manager.configDir, canonicalConfigDir);
    assert.strictEqual(
      runtimes[0].profileDir,
      path.join(canonicalConfigDir, 'browsers', created.id, 'profile'),
      'Browser profiles must stay under the canonical Config directory',
    );
    assert.deepStrictEqual(manager.snapshot(), {
      collectionRevision: manager.store.revision,
      resources: [running],
    });
    manager.isEnabled = () => false;
    assert.strictEqual(
      manager.stateSnapshot().resources.length,
      1,
      'The negotiated control protocol must hydrate persisted Browser metadata even while the plugin is disabled',
    );
    assert.throws(() => manager.snapshot(), /disabled/);
    manager.isEnabled = () => true;
    assert.deepStrictEqual(transitions.slice(-2), ['starting', 'running']);
    assert.strictEqual(runtimes[0].startedUrl, 'http://localhost:3000/');
    assert.deepStrictEqual((await manager.action(created.id, { kind: 'snapshot' })).elements, [
      { ref: 'e1', role: 'button' },
    ]);
    await manager.action(created.id, { kind: 'hover', selector: '#menu' });
    assert.deepStrictEqual(
      await manager.action(created.id, { kind: 'eval', expression: 'document.title' }),
      { value: 'evaluated' },
    );
    const uploadPath = path.join(projectWorkspace, 'upload.txt');
    fs.writeFileSync(uploadPath, 'upload');
    await manager.action(created.id, {
      kind: 'upload',
      selector: '#file',
      files: [uploadPath],
    });
    const downloadPath = path.join(projectWorkspace, 'download.txt');
    assert.deepStrictEqual(
      await manager.action(created.id, {
        kind: 'download',
        selector: '#download',
        path: downloadPath,
      }),
      { ok: true, path: 'download.txt', size: 10 },
    );
    assert.strictEqual(fs.readFileSync(downloadPath, 'utf8'), 'downloaded');
    assert.throws(
      () => manager.action(created.id, {
        kind: 'upload',
        selector: '#file',
        files: [path.join(configDir, 'outside.txt')],
      }),
      /does not exist/,
    );
    assert.throws(
      () => manager.action(created.id, {
        kind: 'download',
        selector: '#download',
        path: downloadPath,
      }),
      /already exists/,
    );
    assert(runtimes[0].actionCalls.some(call => call.kind === 'hover'));
    assert(runtimes[0].actionCalls.some(call => (
      call.kind === 'upload' && call.input.files[0] === fs.realpathSync(uploadPath)
    )));

    const viewer = new FakeViewer();
    manager.attachViewer(created.id, viewer);
    assert.strictEqual(viewer.messages[0].type, 'browser-state');
    const frame = { type: 'browser-frame', generation: 1, data: 'frame' };
    runtimes[0].emit('frame', frame);
    assert.deepStrictEqual(viewer.messages.at(-1), frame);

    const readOnlyViewer = new FakeViewer();
    const actionCountBeforeReadOnlyInput = runtimes[0].actionCalls.length;
    const resizeCountBeforeReadOnlyInput = runtimes[0].resizeCalls;
    manager.attachViewer(created.id, readOnlyViewer, { readOnly: true });
    readOnlyViewer.emit('message', Buffer.from(JSON.stringify({
      type: 'pointer',
      generation: running.generation,
      action: 'down',
      x: 10,
      y: 10,
    })));
    readOnlyViewer.emit('message', Buffer.from(JSON.stringify({
      type: 'resize',
      generation: running.generation,
      width: 640,
      height: 480,
    })));
    await new Promise(resolve => setImmediate(resolve));
    assert.strictEqual(runtimes[0].actionCalls.length, actionCountBeforeReadOnlyInput);
    assert.strictEqual(runtimes[0].resizeCalls, resizeCountBeforeReadOnlyInput);
    const readOnlyFrame = { type: 'browser-frame', generation: 1, data: 'read-only-frame' };
    runtimes[0].emit('frame', readOnlyFrame);
    assert.deepStrictEqual(readOnlyViewer.messages.at(-1), readOnlyFrame);

    runtimes[0].tabs[0].active = false;
    runtimes[0].tabs.push({
      active: true,
      label: null,
      tabId: 't2',
      title: 'Popup destination',
      type: 'page',
      url: 'https://popup.example/',
    });
    runtimes[0].nextTab = 3;
    runtimes[0].activeTabId = 't2';
    runtimes[0].emit('tabs', {
      tabs: runtimes[0].tabs.map(tab => ({ ...tab })),
      newTabIds: ['t2'],
      popupAdmitted: true,
    });
    await manager.sessions.values().next().value.actionChain;
    const popupResource = manager.list().find(resource => resource.url === 'https://popup.example/');
    assert(popupResource, 'An admitted popup must become its own Browser Resource');
    assert.strictEqual(runtimes.length, 1, 'A new tab must reuse the existing Browser process');
    assert.strictEqual(viewer.messages.at(-1).type, 'browser-tab-opened');
    assert.strictEqual(viewer.messages.at(-1).resource.id, popupResource.id);
    assert.strictEqual(runtimes[0].streamTabId, 't2');
    await manager.delete(popupResource.id);
    assert.strictEqual(runtimes[0].closed, false, 'Closing one tab must keep the shared Browser alive');
    runtimes[0].emit('tabs', {
      tabs: [
        ...runtimes[0].tabs.map(tab => ({ ...tab })),
        {
          active: false,
          label: null,
          tabId: 't2',
          title: 'Popup destination',
          type: 'page',
          url: 'https://popup.example/',
        },
      ],
      newTabIds: [],
      popupAdmitted: true,
    });
    await manager.sessions.values().next().value.actionChain;
    assert.strictEqual(
      manager.list().filter(resource => resource.url === 'https://popup.example/').length,
      0,
      'A stale tab snapshot must not recreate a closed Browser Resource',
    );

    const manualTab = manager.create({
      projectRootId: 'wroot_project',
      workspace: projectWorkspace,
      name: 'Manual tab',
      url: 'https://manual.example/',
    });
    runtimes[0].emitStaleTabsBeforeCreate = true;
    const runningManualTab = await manager.start(manualTab.id);
    await manager.sessions.values().next().value.actionChain;
    assert.strictEqual(runningManualTab.status, 'running');
    assert.strictEqual(
      manager.list().find(resource => resource.id === manualTab.id)?.status,
      'running',
      'A tabs snapshot observed before explicit tab ownership commits must not stop the new Resource',
    );
    assert.strictEqual(
      manager.list().filter(resource => resource.url === 'https://manual.example/').length,
      1,
      'A manager-created tab must not be admitted again as a popup Resource',
    );
    assert.strictEqual(runtimes.length, 1, 'Starting another tab must reuse the shared Browser process');
    await manager.action(created.id, { kind: 'snapshot' });
    assert.strictEqual(runtimes[0].activeTabId, 't1');
    await manager.action(manualTab.id, { kind: 'snapshot' });
    assert.strictEqual(runtimes[0].activeTabId, 't3');
    await manager.stop(manualTab.id);

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
    await flushViewerResize();
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
    await flushViewerResize();
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
    await flushViewerResize();
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
    await flushViewerResize();
    assert.strictEqual(
      runtimes[0].resizeCalls,
      2,
      'The old Viewer must become passive after ownership transfers',
    );
    mobileViewer.emit('close');
    await flushViewerResize();
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
    readOnlyViewer.emit('close');

    let releaseViewerBlocker;
    runtimes[0].click = () => new Promise(resolve => {
      releaseViewerBlocker = () => resolve({ ok: true });
    });
    const viewerBlocker = manager.action(created.id, { kind: 'click', selector: '#viewer-blocker' });
    const coalescingViewer = new FakeViewer();
    manager.attachViewer(created.id, coalescingViewer);
    await new Promise(resolve => setImmediate(resolve));
    for (let index = 1; index <= 100; index += 1) {
      coalescingViewer.emit('message', Buffer.from(JSON.stringify({
        type: 'pointer',
        generation: running.generation,
        action: 'move',
        x: index,
        y: index,
      })));
      coalescingViewer.emit('message', Buffer.from(JSON.stringify({
        type: 'wheel',
        generation: running.generation,
        deltaX: 0,
        deltaY: 1,
        x: index,
        y: index,
      })));
    }
    coalescingViewer.emit('message', Buffer.from(JSON.stringify({
      type: 'pointer',
      generation: running.generation,
      action: 'down',
      x: 100,
      y: 100,
      button: 'left',
    })));
    releaseViewerBlocker();
    await viewerBlocker;
    await manager.sessions.values().next().value.actionChain;
    assert.deepStrictEqual(
      runtimes[0].actionCalls.slice(-3).map(call => ({
        kind: call.kind,
        action: call.input.action,
        deltaY: call.input.deltaY,
        x: call.input.x,
      })),
      [
        { kind: 'pointer', action: 'move', deltaY: undefined, x: 100 },
        { kind: 'wheel', action: undefined, deltaY: 100, x: 100 },
        { kind: 'pointer', action: 'down', deltaY: undefined, x: 100 },
      ],
      'Queued Viewer move and wheel input must coalesce without crossing the button-order barrier',
    );
    assert.strictEqual(manager.viewerInputMetrics.coalescedMoves, 99);
    assert.strictEqual(manager.viewerInputMetrics.coalescedWheels, 99);
    assert.strictEqual(manager.viewerInputMetrics.maxPending, 3);
    coalescingViewer.emit('close');

    const navigated = await manager.navigate(created.id, 'https://example.com/path');
    assert.strictEqual(navigated.url, 'https://example.com/path');
    assert.strictEqual(navigated.title, 'Navigated');
    let releaseAction;
    runtimes[0].click = () => new Promise(resolve => {
      releaseAction = () => resolve({ ok: true });
    });
    const pendingAction = manager.action(created.id, { kind: 'click', selector: '#slow' });
    const lateViewer = new FakeViewer();
    manager.attachViewer(created.id, lateViewer);
    const pointerCallsBeforeStop = runtimes[0].actionCalls.filter(call => call.kind === 'pointer').length;
    await new Promise(resolve => setImmediate(resolve));
    const stopPromise = manager.stop(created.id);
    assert.throws(
      () => manager.action(created.id, { kind: 'snapshot' }),
      error => error.code === 'BROWSER_STOPPING',
      'Stop must synchronously close new Agent admissions',
    );
    await new Promise(resolve => setImmediate(resolve));
    assert.strictEqual(
      runtimes[0].closed,
      false,
      'Stopping must drain the already admitted Browser action before closing its Session',
    );
    lateViewer.emit('message', Buffer.from(JSON.stringify({
      type: 'pointer',
      generation: running.generation,
      action: 'down',
      x: 20,
      y: 30,
      button: 'left',
    })));
    await new Promise(resolve => setImmediate(resolve));
    assert.strictEqual(
      runtimes[0].actionCalls.filter(call => call.kind === 'pointer').length,
      pointerCallsBeforeStop,
      'Viewer input arriving after stopping begins must not reach the Browser runtime',
    );
    assert.strictEqual(lateViewer.messages.at(-1).type, 'browser-error');
    const restartPromise = manager.start(created.id);
    releaseAction();
    await pendingAction;
    const stopped = await stopPromise;
    assert.strictEqual(stopped.status, 'stopped');
    assert.strictEqual(runtimes[0].closed, true);
    assert.strictEqual(
      manager.stopAdmissions.has(created.id),
      false,
      'A completed Stop must reopen admissions for an explicit later Start',
    );
    const restarted = await restartPromise;
    assert.strictEqual(restarted.status, 'running');
    assert.strictEqual((await manager.action(created.id, { kind: 'snapshot' })).title, 'Fake Browser');
    await manager.stop(created.id);

    const second = manager.create({
      projectRootId: 'wroot_project',
      workspace: '/tmp/project',
      name: 'Crash',
      url: 'about:blank',
    });
    await manager.start(second.id);
    runtimes[2].emit('exit', 'Browser crashed');
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
    runtimes[3].closeFailures = 1;
    await assert.rejects(manager.stop(retryable.id), /close not proven/);
    assert.strictEqual(manager.get(retryable.id).status, 'stopping');
    assert.strictEqual((await manager.stop(retryable.id)).status, 'stopped');

    await manager.delete(created.id);
    assert.throws(() => manager.get(created.id), /not found/);
    assert.strictEqual(normalizeUrl('example.com/path'), 'https://example.com/path');
    assert.strictEqual(normalizeUrl('www.baidu.com'), 'https://www.baidu.com/');
    assert.strictEqual(normalizeUrl('localhost:3000/path'), 'http://localhost:3000/path');
    assert.strictEqual(normalizeUrl('127.0.0.1:3000/path'), 'http://127.0.0.1:3000/path');
    assert.strictEqual(normalizeUrl('intranet/path'), 'http://intranet/path');
    assert.strictEqual(normalizeUrl('example.com:8080/path'), 'http://example.com:8080/path');
    assert.strictEqual(normalizeUrl('example.com:443/path'), 'https://example.com/path');
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
      discoverExecutable: () => ({
        kind: 'chrome',
        path: '/fake/chrome',
        agentBrowserPath: '/fake/agent-browser',
      }),
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
      discoverExecutable: () => ({
        kind: 'chrome',
        path: '/fake/chrome',
        agentBrowserPath: '/fake/agent-browser',
      }),
      createRuntime: options => new FakeBrowserRuntime(options),
      readProcessIdentity: async pid => (pid === blockedIdentity.pid ? blockedIdentity : null),
      killProcessGroup: () => {
        const error = Object.assign(new Error('Operation not permitted'), {
          code: 'EPERM',
        });
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

async function testExistingChromeTabManagement() {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-existing-chrome-tab-'));
  const workspace = path.join(configDir, 'project');
  fs.mkdirSync(workspace);
  const runtimes = [];
  const relayTabs = [{
    active: true,
    id: 42,
    title: 'Signed in account',
    url: 'https://account.example/',
  }];
  const manager = new BrowserResourceManager({
    configDir,
    getBrowserSettings: () => ({ browserSource: 'extension' }),
    browserExtensionRelay: {
      capability: () => ({ connected: true }),
      cdpUrl: tabId => `http://127.0.0.1:19444${tabId === undefined ? '' : `?tabId=${tabId}`}`,
      pairingString: url => `${url}#token`,
      prepare: () => ({ installed: true, connected: true }),
      tabs: () => relayTabs.map(tab => ({ ...tab })),
    },
    discoverBrowserOptions: () => [],
    discoverExecutable: async selection => selection.source === 'external-cdp'
      ? {
          kind: 'external-cdp',
          path: '',
          cdpUrl: selection.externalCdpUrl,
          agentBrowserPath: '/fake/agent-browser',
        }
      : null,
    createRuntime: options => {
      const runtime = new FakeBrowserRuntime(options);
      runtimes.push(runtime);
      return runtime;
    },
  });
  try {
    await manager.init();
    assert.deepStrictEqual(manager.extensionTabs(), [{
      active: true,
      id: 42,
      managed: false,
      title: 'Signed in account',
      url: 'https://account.example/',
    }]);
    relayTabs.push({ ...relayTabs[0], id: 43 });
    assert.strictEqual(manager.matchExtensionRuntimeTab([{
      active: true,
      tabId: 't1',
      title: 'Signed in account',
      type: 'page',
      url: 'https://account.example/',
    }, {
      active: false,
      tabId: 't2',
      title: 'Signed in account',
      type: 'page',
      url: 'https://account.example/',
    }], 43).tabId, 't2', 'duplicate pages must preserve their Chrome occurrence');
    relayTabs.pop();
    const borrowed = manager.create({
      projectRootId: 'wroot_project',
      workspace,
      ownerType: 'agent',
      ownerAgentId: 'agent_a',
      browserSource: 'extension',
      existingTabId: 42,
    });
    assert.strictEqual(borrowed.existingTabId, 42);
    assert.strictEqual(borrowed.url, 'https://account.example/');
    const runningBorrowed = await manager.start(borrowed.id);
    assert.strictEqual(runningBorrowed.status, 'running');
    assert.strictEqual(runtimes[0].activeTabId, 't1');
    assert.strictEqual(runtimes[0].ownedTabIds.has('t1'), false);
    assert.strictEqual(manager.extensionTabs()[0].managed, true);
    assert.strictEqual(runtimes[0].externalCdpUrl, 'http://127.0.0.1:19444?tabId=42');

    const duplicate = manager.create({
      projectRootId: 'wroot_project',
      workspace,
      ownerType: 'agent',
      ownerAgentId: 'agent_b',
      browserSource: 'extension',
      existingTabId: 42,
    });
    await assert.rejects(
      manager.start(duplicate.id),
      error => error?.code === 'BROWSER_EXTENSION_TAB_IN_USE',
    );

    const created = manager.create({
      projectRootId: 'wroot_project',
      workspace,
      ownerType: 'agent',
      ownerAgentId: 'agent_a',
      browserSource: 'extension',
      url: 'https://fresh.example/',
    });
    await manager.start(created.id);
    assert.strictEqual(manager.sessions.size, 1, 'one Agent should reuse its extension session');
    await manager.stop(borrowed.id);
    assert.deepStrictEqual(
      runtimes[0].closedTabIds,
      [],
      'stopping a borrowed Chrome page must not close the user tab',
    );
    assert.strictEqual(manager.extensionTabs()[0].managed, false);
    await manager.delete(borrowed.id);
    assert.deepStrictEqual(runtimes[0].closedTabIds, []);
  } finally {
    await manager.dispose().catch(() => {});
    fs.rmSync(configDir, { recursive: true, force: true });
  }
}

async function testAgentOwnedBrowserIsolationAndLifecycle() {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-agent-browser-owner-'));
  const runtimes = [];
  const manager = new BrowserResourceManager({
    configDir,
    discoverExecutable: () => ({
      kind: 'chrome',
      path: '/fake/chrome',
      agentBrowserPath: '/fake/agent-browser',
    }),
    createRuntime: options => {
      const runtime = new FakeBrowserRuntime(options);
      runtimes.push(runtime);
      return runtime;
    },
  });
  try {
    await manager.init();
    const first = manager.create({
      projectRootId: 'wroot_shared',
      workspace: '/tmp/shared',
      ownerType: 'agent',
      ownerAgentId: 'agent_a',
      name: 'A1',
      url: 'about:blank',
    });
    const second = manager.create({
      projectRootId: 'wroot_shared',
      workspace: '/tmp/shared',
      ownerType: 'agent',
      ownerAgentId: 'agent_a',
      name: 'A2',
      url: 'about:blank',
    });
    const isolated = manager.create({
      projectRootId: 'wroot_shared',
      workspace: '/tmp/shared',
      ownerType: 'agent',
      ownerAgentId: 'agent_b',
      name: 'B1',
      url: 'about:blank',
    });
    assert.strictEqual(first.ownerType, 'agent');
    assert.strictEqual(first.ownerAgentId, 'agent_a');
    await manager.start(first.id);
    await manager.start(second.id);
    assert.strictEqual(runtimes.length, 1, 'Browsers owned by one Agent may share one Session');
    await manager.start(isolated.id);
    assert.strictEqual(runtimes.length, 2, 'Different Agents must not share a Browser Session');
    const isolatedRunning = manager.store.get(isolated.id);
    manager.store.update(isolated.id, { generation: isolatedRunning.generation + 1 });
    assert.throws(
      () => manager.action(isolated.id, { kind: 'snapshot' }),
      error => error.code === 'BROWSER_STALE_GENERATION',
    );
    manager.store.update(isolated.id, { generation: isolatedRunning.generation });

    await manager.reconcileAgentLifecycle([
      { id: 'agent_a', status: 'stopped', lifecycleOperation: { type: 'runtime-switch' } },
      { id: 'agent_b', status: 'running' },
    ]);
    assert.strictEqual(
      manager.get(first.id).status,
      'running',
      'A Chat/Terminal runtime switch must retain Browser ownership and runtime',
    );
    await manager.stop(second.id);
    assert.strictEqual(
      manager.get(second.id).status,
      'stopped',
      'An explicit Browser stop may retain the row while its Agent remains active',
    );

    await manager.reconcileAgentLifecycle([
      { id: 'agent_a', status: 'stopped' },
      { id: 'agent_b', status: 'running' },
    ]);
    assert.throws(() => manager.get(first.id), /not found/);
    assert.throws(() => manager.get(second.id), /not found/);
    assert.strictEqual(
      runtimes[0].closed,
      true,
      'Reclaiming an Agent must close its shared Browser runtime after deleting every owned Resource',
    );
    assert.strictEqual(manager.get(isolated.id).status, 'running');

    await manager.reconcileAgentLifecycle([{ id: 'agent_a', status: 'running' }]);
    assert.throws(() => manager.get(isolated.id), /not found/);
    assert.strictEqual(
      runtimes[1].closed,
      true,
      'A Browser owned by an Agent missing from authoritative state must be closed and deleted',
    );
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
      kind: 'chrome',
      path: '/fake/chrome',
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
      browserKind: 'chrome',
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
    const failedWithIdentity = seed.store.create({
      projectRootId: 'wroot_recovery',
      workspace: '/tmp/recovery',
      name: 'Retry failed cleanup',
      url: 'about:blank',
    });
    const failedIdentity = {
      pid: 52_001,
      processGroupId: 52_001,
      startedAt: 'failed-agent-browser',
      format: 'test-v1',
    };
    seed.store.update(failedWithIdentity.id, {
      status: 'failed',
      generation: 5,
      browserKind: 'isolated-computer',
      runtimeKind: 'agent-browser',
      processIdentity: failedIdentity,
      error: 'Previous cleanup failed',
    });
    const recoveries = [];
    const recovered = new BrowserResourceManager({
      configDir,
      discoverExecutable: selection => selection.source === 'isolated'
        ? {
            kind: 'isolated-computer',
            path: '',
            agentBrowserPath: '/test/agent-browser',
          }
        : {
            kind: 'chrome',
            path: '/missing/chrome',
            error: 'The selected Chromium browser is no longer available',
          },
      recoverRuntime: async input => recoveries.push(input),
    });
    await recovered.init();
    assert.strictEqual(recoveries.length, 3);
    assert(recoveries.some(input => input.id === created.id && input.generation === 7));
    assert(recoveries.some(input => input.id === local.id && input.generation === 3));
    assert(recoveries.some(input => (
      input.id === failedWithIdentity.id
      && input.generation === 5
      && input.processIdentity?.pid === failedIdentity.pid
    )));
    assert.strictEqual(recovered.store.get(created.id).status, 'failed');
    assert.match(recovered.store.get(created.id).error, /cleaned up/);
    assert.strictEqual(recovered.store.get(local.id).processIdentity, null);
    assert.strictEqual(recovered.store.get(failedWithIdentity.id).processIdentity, null);
    assert.match(recovered.store.get(failedWithIdentity.id).error, /cleaned up/);
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
    emptyBrowserResourceState(),
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
    }).resources,
    [],
  );

  const snapshot = applyBrowserResourceSnapshot(emptyBrowserResourceState(), {
    collectionRevision: 5,
    resources: [],
  });
  assert.strictEqual(
    applyBrowserResource(snapshot, { ...current, collectionRevision: 4 }),
    snapshot,
    'An update already covered by the authoritative snapshot must be ignored',
  );
  const browserA = { ...current, id: 'browser_a', revision: 4, collectionRevision: 7 };
  const browserB = { ...current, id: 'browser_b', revision: 1, collectionRevision: 6 };
  const withA = applyBrowserResource(snapshot, browserA);
  const withBoth = applyBrowserResource(withA, browserB);
  assert.deepStrictEqual(
    withBoth.resources.map(resource => resource.id).sort(),
    ['browser_a', 'browser_b'],
    'A lower collection revision for another Resource must not be lost after an HTTP response arrives first',
  );
  assert.strictEqual(
    applyBrowserResourceDeletion(withBoth, { id: browserA.id, collectionRevision: 6 }).resources.length,
    2,
    'A delayed delete must not remove a newer Resource revision',
  );
  const withoutB = applyBrowserResourceDeletion(withBoth, {
    id: browserB.id,
    collectionRevision: 8,
  });
  assert.strictEqual(
    applyBrowserResource(withoutB, { ...browserB, collectionRevision: 7 }),
    withoutB,
    'A delayed update must not resurrect a deleted Resource',
  );
  assert.deepStrictEqual(
    applyBrowserResourceSnapshot(withoutB, { collectionRevision: 9, resources: [] }).resources,
    [],
    'A reconnect snapshot must correct all prior incremental state',
  );
}

async function testBrowserRouterAgentOwnership() {
  const resources = [{
    id: 'browser_agent_a',
    ownerType: 'agent',
    ownerAgentId: 'agent_a',
    projectRootId: 'wroot_project',
    workspace: '/tmp/project',
    name: 'Agent A Browser',
  }, {
    id: 'browser_agent_b',
    ownerType: 'agent',
    ownerAgentId: 'agent_b',
    projectRootId: 'wroot_project',
    workspace: '/tmp/project',
    name: 'Agent B Browser',
  }];
  const calls = [];
  const manager = {
    requireEnabled() {},
    refreshCapability: async () => {},
    capability: () => ({ enabled: true }),
    sourceCapabilities: async () => [],
    prepareBrowserExtension: () => {
      calls.push({ kind: 'prepare-extension' });
      return { installed: true, connected: false };
    },
    removeBrowserExtension: () => {
      calls.push({ kind: 'remove-extension' });
      return { installed: false, connected: false };
    },
    extensionTabs: () => [{
      active: true,
      id: 42,
      managed: false,
      title: 'Signed in account',
      url: 'https://account.example/',
    }],
    snapshot: () => ({ collectionRevision: 1, resources }),
    get: id => {
      const resource = resources.find(candidate => candidate.id === id);
      if (!resource) {
        const error = Object.assign(new Error('Browser resource not found'), {
          status: 404,
        });
        throw error;
      }
      return resource;
    },
    create: input => {
      calls.push({ kind: 'create', input });
      return { id: 'browser_created', ...input };
    },
    rename: (id, name) => {
      calls.push({ kind: 'rename', id, name });
      return { id, name };
    },
    start: async id => {
      calls.push({ kind: 'start', id });
      return { id, status: 'running' };
    },
    stop: async id => ({ id, status: 'stopped' }),
    delete: async id => ({ id }),
    navigate: async (id, url) => ({ id, url }),
    action: async (id, input) => ({ id, input }),
    on() {},
    off() {},
  };
  const rootRegistry = {
    resolve: () => ({
      rootId: 'wroot_project',
      canonicalPath: '/tmp/project',
      kind: 'project',
    }),
  };
  const agentStateReader = {
    resolveAgentResourceBinding(agentId) {
      if (!['agent_a', 'agent_b'].includes(agentId)) return null;
      return { agentId, workspace: '/tmp/project' };
    },
    getState: () => ({
      agents: [{
        id: 'agent_a',
        status: 'running',
        projectWorkspace: '/tmp/project',
      }, {
        id: 'agent_b',
        status: 'running',
        projectWorkspace: '/tmp/project',
      }],
    }),
  };
  const app = express();
  app.use('/api/browsers', createBrowserRouter(manager, rootRegistry, agentStateReader));
  const server = http.createServer(app);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const request = async (pathname, options: Parameters<typeof fetch>[1] = {}) => {
    const response = await fetch(`${origin}${pathname}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        'X-Farming-Agent-Id': 'agent_a',
        ...options.headers,
      },
    });
    return { status: response.status, body: await response.json() };
  };
  try {
    const expired = await request('/api/browsers', {
      headers: { 'X-Farming-Agent-Id': 'agent_missing' },
    });
    assert.strictEqual(expired.status, 404);
    assert.strictEqual(expired.body.code, 'BROWSER_AGENT_NOT_FOUND');

    const listed = await request('/api/browsers');
    assert.strictEqual(listed.status, 200);
    assert.deepStrictEqual(
      listed.body.resources.map(resource => resource.id),
      ['browser_agent_a'],
      'Agent-scoped Browser listing must be filtered by the Server',
    );

    const tabs = await request('/api/browsers/extension/tabs');
    assert.strictEqual(tabs.status, 200);
    assert.deepStrictEqual(tabs.body.tabs.map(tab => tab.id), [42]);

    const prepared = await request('/api/browsers/extension/prepare', { method: 'POST' });
    assert.strictEqual(prepared.status, 200);
    assert.deepStrictEqual(prepared.body, { installed: true, connected: false });
    assert.deepStrictEqual(calls.at(-1), { kind: 'prepare-extension' });

    const removed = await request('/api/browsers/extension/prepare', { method: 'DELETE' });
    assert.strictEqual(removed.status, 200);
    assert.deepStrictEqual(removed.body, { installed: false, connected: false });
    assert.deepStrictEqual(calls.at(-1), { kind: 'remove-extension' });

    const crossAgent = await request('/api/browsers/browser_agent_b/start', { method: 'POST' });
    assert.strictEqual(crossAgent.status, 403);
    assert.strictEqual(crossAgent.body.code, 'BROWSER_OWNER_MISMATCH');
    assert.strictEqual(
      calls.some(call => call.kind === 'start'),
      false,
      'A cross-Agent operation must be rejected before it reaches the manager',
    );

    const created = await request('/api/browsers', {
      method: 'POST',
      body: JSON.stringify({
        rootId: 'wroot_project',
        agentId: 'agent_a',
        name: 'Owned',
        source: 'extension',
        existingTabId: 42,
        url: 'https://example.test/',
      }),
    });
    assert.strictEqual(created.status, 201);
    assert.deepStrictEqual(calls.at(-1), {
      kind: 'create',
      input: {
        projectRootId: 'wroot_project',
        workspace: '/tmp/project',
        ownerType: 'agent',
        ownerAgentId: 'agent_a',
        name: 'Owned',
        url: 'https://example.test/',
        browserSource: 'extension',
        existingTabId: 42,
      },
    });

    const spoofed = await request('/api/browsers', {
      method: 'POST',
      body: JSON.stringify({
        rootId: 'wroot_project',
        agentId: 'agent_b',
        url: 'about:blank',
      }),
    });
    assert.strictEqual(spoofed.status, 403);

    agentStateReader.getState = () => ({
      agents: [{
        id: 'agent_a',
        status: 'stopped',
        projectWorkspace: '/tmp/project',
      }],
    });
    const stoppedOwner = await request('/api/browsers/browser_agent_a/start', { method: 'POST' });
    assert.strictEqual(stoppedOwner.status, 409);
    assert.strictEqual(stoppedOwner.body.code, 'BROWSER_OWNER_NOT_RUNNING');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

function testBrowserPackaging() {
  const projectRoot = path.join(__dirname, '..', '..');
  const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
  assert.strictEqual(packageJson.dependencies['playwright-core'], undefined);
  assert.strictEqual(packageJson.bin['farming-browser'], 'extensions/browser/bin/farming-browser');
  assert(packageJson.files.includes('extensions/browser/backend/*.cjs'));
  assert(packageJson.files.includes('extensions/browser/bin/'));
  assert(packageJson.files.includes('backend/farming-agent-bootstrap.md'));
}

Promise.resolve()
  .then(testInternalCdpDiscoveryConfiguration)
  .then(testManagedAgentBrowserDiscovery)
  .then(testBrowserResourceManager)
  .then(testExistingChromeTabManagement)
  .then(testAgentOwnedBrowserIsolationAndLifecycle)
  .then(testAgentBrowserRestartRecovery)
  .then(testBrowserResourceRevisionOrdering)
  .then(testBrowserRouterAgentOwnership)
  .then(testBrowserPackaging)
  .then(() => console.log('browser extension tests passed'))
  .catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
