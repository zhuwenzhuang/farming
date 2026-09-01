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
const storageLayout = require('../storage-layout.cjs');

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
    this.closeTabFailures = 0;
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
    if (this.closeTabFailures > 0) {
      this.closeTabFailures -= 1;
      throw new Error('tab close not proven');
    }
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
  let pureReadOnlyBrowserSaves = 0;
  let pureReadOnlyBrowserProbes = 0;
  const pureReadOnlyBrowserManager = new BrowserResourceManager({
    configDir,
    getBrowserSettings: () => ({ browserSource: 'system', browserExecutablePath: '' }),
    saveBrowserSelection: () => {
      pureReadOnlyBrowserSaves += 1;
    },
    discoverBrowserOptions: () => [{ kind: 'chrome', path: '/detected/pure-read-only-chrome' }],
    discoverExecutable: async selection => {
      pureReadOnlyBrowserProbes += 1;
      return { kind: 'chrome', path: selection.executablePath, agentBrowserPath: '/fake/agent-browser' };
    },
  });
  await pureReadOnlyBrowserManager.refreshCapability(undefined, {
    persistDefaultSelection: false,
    reuseVerified: true,
  });
  assert.strictEqual(pureReadOnlyBrowserSaves, 0);
  assert.strictEqual(
    pureReadOnlyBrowserManager.capability().selection.executablePath,
    '/detected/pure-read-only-chrome',
    'a first read-only probe must return its effective default without persisting Config settings',
  );
  const [firstSources, concurrentSources] = await Promise.all([
    pureReadOnlyBrowserManager.sourceCapabilities({ reuseVerified: true }),
    pureReadOnlyBrowserManager.sourceCapabilities({ reuseVerified: true }),
  ]);
  assert.deepStrictEqual(concurrentSources, firstSources);
  assert.strictEqual(
    pureReadOnlyBrowserProbes,
    4,
    'concurrent capability snapshots must share one current-source probe plus three source probes',
  );
  await pureReadOnlyBrowserManager.sourceCapabilities({ reuseVerified: true });
  assert.strictEqual(
    pureReadOnlyBrowserProbes,
    4,
    'an unchanged capability snapshot must reuse verified per-source results',
  );
  await pureReadOnlyBrowserManager.dispose();
  let transientSystemProbes = 0;
  const transientSourceManager = new BrowserResourceManager({
    configDir,
    getBrowserSettings: () => ({
      browserSource: 'system',
      browserExecutablePath: '/detected/transient-chrome',
    }),
    discoverBrowserOptions: () => [{ kind: 'chrome', path: '/detected/transient-chrome' }],
    discoverExecutable: async selection => {
      if (selection.source !== 'system') return null;
      transientSystemProbes += 1;
      return transientSystemProbes === 1
        ? {
            kind: 'chrome',
            path: selection.executablePath,
            error: 'temporary Browser verification failure',
          }
        : {
            kind: 'chrome',
            path: selection.executablePath,
            agentBrowserPath: '/fake/agent-browser',
          };
    },
  });
  const transientSources = await transientSourceManager.sourceCapabilities({ reuseVerified: true });
  assert.strictEqual(transientSources.find(source => source.source === 'system')?.available, false);
  const recoveredSources = await transientSourceManager.sourceCapabilities({ reuseVerified: true });
  assert.strictEqual(recoveredSources.find(source => source.source === 'system')?.available, true);
  await transientSourceManager.sourceCapabilities({ reuseVerified: true });
  assert.strictEqual(
    transientSystemProbes,
    2,
    'a retryable source failure must be retried once and the recovered result may then be cached',
  );
  await transientSourceManager.dispose();
  let readOnlyBrowserSelectionSaves = 0;
  let readOnlyBrowserSettings = {
    browserSource: 'system',
    browserExecutablePath: '',
  };
  let releaseConcurrentBrowserProbe;
  const concurrentBrowserProbe = new Promise(resolve => {
    releaseConcurrentBrowserProbe = resolve;
  });
  const readOnlyBrowserManager = new BrowserResourceManager({
    configDir,
    getBrowserSettings: () => readOnlyBrowserSettings,
    saveBrowserSelection: selection => {
      readOnlyBrowserSelectionSaves += 1;
      readOnlyBrowserSettings = {
        browserSource: selection.source,
        browserExecutablePath: selection.executablePath,
      };
    },
    discoverBrowserOptions: () => [{ kind: 'chrome', path: '/detected/read-only-chrome' }],
    discoverExecutable: async selection => {
      await concurrentBrowserProbe;
      return { kind: 'chrome', path: selection.executablePath, agentBrowserPath: '/fake/agent-browser' };
    },
  });
  const readOnlyRefresh = readOnlyBrowserManager.refreshCapability(undefined, {
    persistDefaultSelection: false,
    reuseVerified: true,
  });
  await Promise.resolve();
  assert.strictEqual(
    readOnlyBrowserSelectionSaves,
    0,
    'a read-only capability probe must not persist the discovered default Browser',
  );
  const concurrentOwnerRefresh = readOnlyBrowserManager.refreshCapability(undefined, {
    persistDefaultSelection: true,
    reuseVerified: true,
  });
  assert.strictEqual(
    readOnlyBrowserSelectionSaves,
    0,
    'a conflicting Owner refresh waits for the in-flight read-only probe instead of racing its shared state',
  );
  releaseConcurrentBrowserProbe();
  await Promise.all([readOnlyRefresh, concurrentOwnerRefresh]);
  assert.strictEqual(
    readOnlyBrowserSelectionSaves,
    1,
    'the queued Owner refresh must still persist the discovered default Browser exactly once',
  );
  assert.strictEqual(
    readOnlyBrowserManager.capability().selection.executablePath,
    '/detected/read-only-chrome',
  );
  await readOnlyBrowserManager.dispose();
  let staleDefaultSelectionSaves = 0;
  let concurrentBrowserSettings = {
    browserSource: 'system',
    browserExecutablePath: '',
  };
  let releaseStaleProbe;
  const staleProbe = new Promise(resolve => {
    releaseStaleProbe = resolve;
  });
  const staleSelectionManager = new BrowserResourceManager({
    configDir,
    getBrowserSettings: () => concurrentBrowserSettings,
    saveBrowserSelection: selection => {
      staleDefaultSelectionSaves += 1;
      concurrentBrowserSettings = {
        browserSource: selection.source,
        browserExecutablePath: selection.executablePath,
      };
    },
    discoverBrowserOptions: () => [{ kind: 'chrome', path: '/detected/stale-chrome' }],
    discoverExecutable: async selection => {
      await staleProbe;
      return {
        kind: selection.source === 'extension' ? 'chrome-extension' : 'chrome',
        path: selection.executablePath,
        agentBrowserPath: '/fake/agent-browser',
      };
    },
  });
  const staleReadOnlyRefresh = staleSelectionManager.refreshCapability(undefined, {
    persistDefaultSelection: false,
    reuseVerified: true,
  });
  await Promise.resolve();
  const staleOwnerRefresh = staleSelectionManager.refreshCapability(undefined, {
    persistDefaultSelection: true,
    reuseVerified: true,
  });
  concurrentBrowserSettings = {
    browserSource: 'extension',
    browserExecutablePath: '',
  };
  const updatedOwnerRefresh = staleSelectionManager.refreshCapability(undefined, {
    persistDefaultSelection: true,
    reuseVerified: true,
  });
  releaseStaleProbe();
  await Promise.all([staleReadOnlyRefresh, staleOwnerRefresh, updatedOwnerRefresh]);
  assert.strictEqual(
    staleDefaultSelectionSaves,
    0,
    'a queued implicit refresh must not overwrite a newer Owner Browser selection',
  );
  assert.deepStrictEqual(concurrentBrowserSettings, {
    browserSource: 'extension',
    browserExecutablePath: '',
  });
  assert.strictEqual(staleSelectionManager.capability().selection.source, 'extension');
  await staleSelectionManager.dispose();
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
      ownerAgentId: 'agent_project',
      browserSource: 'external-cdp',
    }), error => error?.code === 'BROWSER_INVALID_SOURCE');
    const isolatedConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-isolated-browser-manager-'));
    const isolatedCalls = {
      acquired: 0,
      killedProcessGroups: [],
      released: 0,
      deleted: 0,
      deleteShouldFail: true,
      processAlive: false,
      runtimes: new Map(),
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
        const runtime = new FakeBrowserRuntime(options);
        isolatedCalls.runtimes.set(options.id, runtime);
        return runtime;
      },
      readProcessIdentity: async pid => (
        isolatedCalls.processAlive && pid === 41_002
          ? {
              pid,
              processGroupId: pid,
              startedAt: 'generation-1',
              format: 'test-v1',
            }
          : null
      ),
      killProcessGroup: (processGroupId, signal) => {
        isolatedCalls.killedProcessGroups.push({ processGroupId, signal });
        isolatedCalls.processAlive = false;
      },
      wait: async () => {},
    });
    try {
      await isolatedManager.init();
      assert.strictEqual(isolatedManager.capability().browser.kind, 'isolated-computer');
      assert.strictEqual(isolatedManager.capability().selection.source, 'isolated');
      assert.throws(() => isolatedManager.create({
        projectRootId: 'wroot_isolated',
        workspace: projectWorkspace,
        ownerAgentId: '',
        name: 'Ownerless Browser',
        url: 'https://example.com',
      }), error => (
        error?.code === 'BROWSER_AGENT_OWNER_REQUIRED'
        && error?.status === 400
      ), 'Browser creation must reject a missing Agent owner before persisting a row');
      const isolatedResource = isolatedManager.create({
        projectRootId: 'wroot_isolated',
        workspace: projectWorkspace,
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

      const orphanedIsolated = isolatedManager.create({
        projectRootId: 'wroot_isolated',
        workspace: projectWorkspace,
        ownerAgentId: 'agent_orphaned',
        name: 'Orphaned isolated Browser',
        url: 'https://example.com',
      });
      const retainedIsolated = isolatedManager.create({
        projectRootId: 'wroot_isolated',
        workspace: projectWorkspace,
        ownerAgentId: 'agent_retained',
        name: 'Retained isolated Browser',
        url: 'https://example.com',
      });
      await isolatedManager.start(orphanedIsolated.id);
      isolatedCalls.processAlive = true;
      isolatedCalls.runtimes.get(orphanedIsolated.id).closeFailures = 1;
      await isolatedManager.reconcileAgentLifecycle([
        { id: 'agent_retained', status: 'running' },
      ]);
      assert.throws(
        () => isolatedManager.get(orphanedIsolated.id),
        /not found/,
        'orphan cleanup must converge after exact isolated runtime close failure',
      );
      assert.strictEqual(
        isolatedManager.get(retainedIsolated.id).status,
        'stopped',
        'orphan cleanup must retain the exact Browser owned by the live Agent',
      );
      assert.deepStrictEqual(isolatedCalls.killedProcessGroups, [{
        processGroupId: 41_002,
        signal: 'SIGKILL',
      }]);
      assert.strictEqual(
        isolatedCalls.released,
        2,
        'isolated lease release must not be blocked by runtime close failure',
      );

      await isolatedManager.start(retainedIsolated.id);
      const sharedIsolated = isolatedManager.create({
        projectRootId: 'wroot_isolated',
        workspace: projectWorkspace,
        ownerAgentId: 'agent_retained',
        name: 'Shared isolated Browser',
        url: 'https://example.com/shared',
      });
      await isolatedManager.start(sharedIsolated.id);
      const sharedRuntime = isolatedCalls.runtimes.get(retainedIsolated.id);
      sharedRuntime.closeTabFailures = 1;
      await assert.rejects(isolatedManager.stop(sharedIsolated.id), /tab close not proven/);
      assert.strictEqual(isolatedManager.get(sharedIsolated.id).status, 'failed');
      assert.deepStrictEqual(
        isolatedCalls.killedProcessGroups,
        [{ processGroupId: 41_002, signal: 'SIGKILL' }],
        'a failed tab close must never kill the shared isolated Session',
      );
      await isolatedManager.delete(sharedIsolated.id);
      await isolatedManager.delete(retainedIsolated.id);
    } finally {
      await isolatedManager.dispose();
      fs.rmSync(isolatedConfigDir, { recursive: true, force: true });
    }
    const created = manager.create({
      projectRootId: 'wroot_project',
      workspace: projectWorkspace,
      ownerAgentId: 'agent_project',
      name: 'App',
      url: 'localhost:3000',
    });
    assert.strictEqual(created.status, 'stopped');
    assert.strictEqual(created.url, 'http://localhost:3000/');
    assert.strictEqual(created.ownerAgentId, 'agent_project');

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
      ownerAgentId: 'agent_project',
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

    const recovering = manager.create({
      projectRootId: 'wroot_project',
      workspace: '/tmp/project',
      ownerAgentId: 'agent_project',
      name: 'Recovering',
      url: 'about:blank',
    });
    await manager.start(recovering.id);
    const recoveringRuntime = runtimes.at(-1);
    recoveringRuntime.emit('disconnected', 'Browser connection interrupted; reconnecting');
    assert.strictEqual(manager.get(recovering.id).status, 'reconnecting');
    assert.throws(
      () => manager.action(recovering.id, { kind: 'snapshot' }),
      error => error.code === 'BROWSER_NOT_RUNNING',
      'Browser actions must stop while the authoritative runtime connection is recovering',
    );
    recoveringRuntime.emit('connected');
    assert.strictEqual(manager.get(recovering.id).status, 'running');
    recoveringRuntime.emit('disconnected', 'Browser connection interrupted; reconnecting');
    recoveringRuntime.emit('exit', 'Browser connection did not recover');
    await new Promise(resolve => setImmediate(resolve));
    assert.strictEqual(manager.get(recovering.id).status, 'failed');
    recoveringRuntime.emit('connected');
    assert.strictEqual(
      manager.get(recovering.id).status,
      'failed',
      'A stale connected callback must not revive a terminal Browser generation',
    );

    const stoppedWithOldCallbacks = manager.create({
      projectRootId: 'wroot_project',
      workspace: '/tmp/project',
      ownerAgentId: 'agent_project',
      name: 'Stopped callback fence',
      url: 'about:blank',
    });
    await manager.start(stoppedWithOldCallbacks.id);
    const stoppedRuntime = runtimes.at(-1);
    await manager.stop(stoppedWithOldCallbacks.id);
    stoppedRuntime.emit('disconnected', 'late disconnect');
    stoppedRuntime.emit('connected');
    stoppedRuntime.emit('exit', 'late exit');
    await new Promise(resolve => setImmediate(resolve));
    assert.strictEqual(
      manager.get(stoppedWithOldCallbacks.id).status,
      'stopped',
      'Callbacks from a released runtime must not revive or fail a stopped Resource',
    );
    await manager.stop(stoppedWithOldCallbacks.id);
    await manager.delete(stoppedWithOldCallbacks.id);
    await assert.rejects(
      manager.delete(stoppedWithOldCallbacks.id),
      error => error.code === 'BROWSER_NOT_FOUND',
      'A repeated delete must fail closed without recreating the Resource',
    );

    const second = manager.create({
      projectRootId: 'wroot_project',
      workspace: '/tmp/project',
      ownerAgentId: 'agent_project',
      name: 'Crash',
      url: 'about:blank',
    });
    await manager.start(second.id);
    runtimes.at(-1).emit('exit', 'Browser crashed');
    await new Promise(resolve => setImmediate(resolve));
    assert.strictEqual(manager.get(second.id).status, 'failed');
    assert.strictEqual(manager.get(second.id).error, 'Browser crashed');

    const retryable = manager.create({
      projectRootId: 'wroot_project',
      workspace: '/tmp/project',
      ownerAgentId: 'agent_project',
      name: 'Retry cleanup',
      url: 'about:blank',
    });
    await manager.start(retryable.id);
    runtimes.at(-1).closeFailures = 1;
    await assert.rejects(manager.stop(retryable.id), /close not proven/);
    assert.strictEqual(
      manager.get(retryable.id).status,
      'failed',
      'a failed Browser close must leave a terminal retryable state instead of remaining stopping',
    );
    await manager.delete(retryable.id);
    assert.throws(
      () => manager.get(retryable.id),
      /not found/,
      'an exact delete retry must finish cleanup and remove the retained Browser row',
    );

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
      ownerAgentId: 'agent_project',
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
      ownerAgentId: 'agent_permission',
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
    assert.strictEqual(manager.matchExtensionRuntimeTab([{
      active: false,
      tabId: 'restoring',
      title: '',
      type: 'page',
      url: 'https://account.example/',
    }], 42).tabId, 'restoring', 'discarded tabs may have a transient title while Chrome restores them');
    const borrowed = manager.create({
      projectRootId: 'wroot_project',
      workspace,
      ownerAgentId: 'agent_a',
      browserSource: 'extension',
      existingTabId: 42,
    });
    assert.strictEqual(borrowed.existingTabId, 42);
    assert.strictEqual(borrowed.url, 'https://account.example/');
    const attachedSession = manager.ensureSession({
      projectRootId: 'wroot_project',
      workspace,
      ownerAgentId: 'agent_a',
      browserSource: 'extension',
      existingTabId: 42,
      sessionName: 'default',
    });
    assert.strictEqual(attachedSession.id, borrowed.id);
    assert.strictEqual(attachedSession.sessionCreated, false);
    assert.strictEqual(manager.ensureSession({
      projectRootId: 'wroot_project',
      workspace,
      ownerAgentId: 'agent_a',
      browserSource: 'extension',
      existingTabId: 42,
      sessionName: 'default',
    }).id, borrowed.id);
    assert.throws(
      () => manager.ensureSession({
        projectRootId: 'wroot_project',
        workspace,
        ownerAgentId: 'agent_a',
        browserSource: 'extension',
        existingTabId: 43,
        sessionName: 'default',
      }),
      error => error?.code === 'BROWSER_SESSION_TAB_MISMATCH',
    );
    const runningBorrowed = await manager.start(borrowed.id);
    assert.strictEqual(runningBorrowed.status, 'running');
    assert.strictEqual(runtimes[0].activeTabId, 't1');
    assert.strictEqual(runtimes[0].ownedTabIds.has('t1'), false);
    assert.strictEqual(manager.extensionTabs()[0].managed, true);
    assert.strictEqual(runtimes[0].externalCdpUrl, 'http://127.0.0.1:19444?tabId=42');

    const duplicate = manager.create({
      projectRootId: 'wroot_project',
      workspace,
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
      ownerAgentId: 'agent_a',
      name: 'A1',
      url: 'about:blank',
    });
    const second = manager.create({
      projectRootId: 'wroot_shared',
      workspace: '/tmp/shared',
      ownerAgentId: 'agent_a',
      name: 'A2',
      url: 'about:blank',
    });
    const isolated = manager.create({
      projectRootId: 'wroot_shared',
      workspace: '/tmp/shared',
      ownerAgentId: 'agent_b',
      name: 'B1',
      url: 'about:blank',
    });
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

    manager.beginAgentOwnerReplacement('agent_a');
    await manager.reconcileAgentLifecycle([
      { id: 'agent_b', status: 'running' },
    ]);
    assert.strictEqual(
      manager.get(first.id).status,
      'running',
      'a replacement hold must retain the Browser while the old Agent is absent',
    );
    manager.completeAgentOwnerReplacement('agent_a', 'agent_replacement');
    assert.strictEqual(manager.get(first.id).ownerAgentId, 'agent_replacement');
    assert.strictEqual(manager.get(second.id).ownerAgentId, 'agent_replacement');
    assert.strictEqual(manager.sessions.get(first.id)?.ownerKey, 'agent:agent_replacement');
    await manager.reconcileAgentLifecycle([
      { id: 'agent_replacement', status: 'stopped' },
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

    const recoveredReplacement = manager.create({
      projectRootId: 'wroot_shared',
      workspace: '/tmp/shared',
      ownerAgentId: 'agent_recovery_old',
      name: 'Recovered',
      url: 'about:blank',
    });
    await manager.start(recoveredReplacement.id);
    const recoveredBinding = manager.runtimes.get(recoveredReplacement.id);
    await assert.rejects(
      manager.reconcileAgentLifecycle([
        { id: 'agent_b', status: 'running' },
        {
          id: 'agent_recovery_first',
          projectWorkspace: '/tmp/shared',
          restartedFromAgentId: 'agent_recovery_old',
          status: 'running',
        },
        {
          id: 'agent_recovery_second',
          projectWorkspace: '/tmp/shared',
          restartedFromAgentIds: ['agent_recovery_old'],
          status: 'running',
        },
      ]),
      error => error.code === 'BROWSER_OWNER_REPLACEMENT_AMBIGUOUS',
    );
    assert.strictEqual(manager.get(recoveredReplacement.id).ownerAgentId, 'agent_recovery_old');
    assert.strictEqual(manager.runtimes.get(recoveredReplacement.id), recoveredBinding);
    await manager.reconcileAgentLifecycle([
      { id: 'agent_b', status: 'running' },
      {
        id: 'agent_recovery_new',
        projectWorkspace: '/tmp/shared',
        restartedFromAgentId: 'agent_recovery_old',
        status: 'running',
      },
    ]);
    assert.strictEqual(manager.get(recoveredReplacement.id).ownerAgentId, 'agent_recovery_new');
    assert.strictEqual(manager.runtimes.get(recoveredReplacement.id), recoveredBinding);
    assert.strictEqual(recoveredBinding?.session.ownerKey, 'agent:agent_recovery_new');
    await manager.reconcileAgentLifecycle([
      { id: 'agent_b', status: 'running' },
      {
        id: 'agent_recovery_new',
        projectWorkspace: '/tmp/shared',
        status: 'stopped',
      },
    ]);
    assert.throws(
      () => manager.get(recoveredReplacement.id),
      /not found/,
      'restart recovery must transfer before ordinary replacement cleanup resumes',
    );

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

async function testAgentBrowserNamedSessionEnsure() {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-agent-browser-session-'));
  const manager = new BrowserResourceManager({
    configDir,
    discoverExecutable: () => ({
      kind: 'chrome',
      path: '/fake/chrome',
      agentBrowserPath: '/fake/agent-browser',
    }),
    createRuntime: options => new FakeBrowserRuntime(options),
  });
  const owner = {
    projectRootId: 'wroot_session',
    workspace: '/tmp/session',
    ownerAgentId: 'agent_session',
  };
  try {
    await manager.init();
    const older = manager.create({ ...owner, name: 'Older' });
    const running = manager.create({ ...owner, name: 'Running' });
    await manager.start(running.id);

    const adopted = manager.ensureSession({ ...owner, sessionName: 'default' });
    assert.strictEqual(adopted.id, running.id, 'default Session should adopt the live legacy Resource');
    assert.strictEqual(adopted.sessionName, 'default');
    assert.strictEqual(adopted.sessionCreated, false);
    assert.strictEqual(manager.get(older.id).sessionName, '');

    const repeated = manager.ensureSession({ ...owner, sessionName: 'default' });
    assert.strictEqual(repeated.id, running.id, 'repeated ensure must reuse the same Resource');
    assert.strictEqual(manager.list().length, 2);

    const namedFirst = manager.ensureSession({ ...owner, sessionName: 'docs', url: 'https://docs.example/' });
    const namedSecond = manager.ensureSession({ ...owner, sessionName: 'docs' });
    assert.strictEqual(namedFirst.sessionCreated, true);
    assert.strictEqual(namedSecond.sessionCreated, false);
    assert.strictEqual(namedSecond.id, namedFirst.id);
    assert.strictEqual(manager.list().filter(resource => resource.sessionName === 'docs').length, 1);
    assert.throws(
      () => manager.ensureSession({ ...owner, sessionName: 'docs', browserSource: 'isolated' }),
      error => error?.code === 'BROWSER_SESSION_SOURCE_MISMATCH',
    );
  } finally {
    await manager.dispose().catch(() => {});
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
      ownerAgentId: 'agent_recovery',
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
      ownerAgentId: 'agent_recovery',
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
      ownerAgentId: 'agent_recovery',
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

async function testLegacyProjectBrowserMigrationCleanup() {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-legacy-project-browser-'));
  const runningId = 'browser_legacy_project_running';
  const stoppedId = 'browser_legacy_project_stopped';
  const runningIdentity = {
    pid: 53_001,
    processGroupId: 53_001,
    startedAt: 'legacy-project-browser',
    format: 'test-v1',
  };
  const resourcesFile = storageLayout.browserResourcesFile(configDir);
  const runningProfile = storageLayout.browserProfileDir(configDir, runningId);
  const stoppedProfile = storageLayout.browserProfileDir(configDir, stoppedId);
  fs.mkdirSync(runningProfile, { recursive: true });
  fs.mkdirSync(stoppedProfile, { recursive: true });
  const canonicalRunningProfile = fs.realpathSync(runningProfile);
  fs.writeFileSync(path.join(runningProfile, 'state'), 'running');
  fs.writeFileSync(path.join(stoppedProfile, 'state'), 'stopped');
  fs.writeFileSync(resourcesFile, JSON.stringify({
    version: 10,
    revision: 7,
    resources: [{
      id: runningId,
      projectRootId: 'wroot_legacy',
      workspace: '/tmp/legacy',
      ownerType: 'project',
      ownerAgentId: '',
      name: 'Legacy running Browser',
      status: 'running',
      generation: 4,
      runtimeKind: 'agent-browser',
      browserKind: 'chrome',
      sessionId: runningId,
      sessionGeneration: 4,
      processIdentity: runningIdentity,
    }, {
      id: stoppedId,
      projectRootId: 'wroot_legacy',
      workspace: '/tmp/legacy',
      ownerType: 'project',
      ownerAgentId: '',
      name: 'Legacy stopped Browser',
      status: 'stopped',
      processIdentity: null,
    }],
  }));

  const discovery = () => ({
    kind: 'chrome',
    path: '/fake/chrome',
    agentBrowserPath: '/test/agent-browser',
  });
  const blocked = new BrowserResourceManager({
    configDir,
    discoverExecutable: discovery,
    recoverRuntime: async input => {
      const persisted = JSON.parse(fs.readFileSync(resourcesFile, 'utf8'));
      assert(persisted.resources.some(resource => resource.id === runningId));
      assert(fs.existsSync(runningProfile));
      assert.strictEqual(input.id, runningId);
      assert.strictEqual(input.generation, 4);
      assert.strictEqual(input.profileDir, canonicalRunningProfile);
      assert.deepStrictEqual(input.processIdentity, runningIdentity);
      throw new Error('cleanup blocked');
    },
  });
  try {
    await blocked.init();
    assert.deepStrictEqual(blocked.store.list(), []);
    assert.strictEqual(blocked.store.listLegacyProjectResources().length, 1);
    assert(fs.existsSync(runningProfile), 'failed runtime cleanup must retain the legacy profile');
    assert(!fs.existsSync(stoppedProfile), 'a stopped legacy Browser profile should be removed');
    const retained = JSON.parse(fs.readFileSync(resourcesFile, 'utf8'));
    assert.strictEqual(retained.version, 10);
    assert.deepStrictEqual(retained.resources.map(resource => resource.id), [runningId]);
  } finally {
    await blocked.dispose();
  }

  const recoveries = [];
  const recovered = new BrowserResourceManager({
    configDir,
    discoverExecutable: discovery,
    recoverRuntime: async input => {
      const persisted = JSON.parse(fs.readFileSync(resourcesFile, 'utf8'));
      assert(persisted.resources.some(resource => resource.id === runningId));
      assert(fs.existsSync(runningProfile));
      recoveries.push(input);
    },
  });
  try {
    await recovered.init();
    assert.strictEqual(recoveries.length, 1);
    assert.strictEqual(recoveries[0].id, runningId);
    assert.strictEqual(recoveries[0].generation, 4);
    assert.strictEqual(recoveries[0].profileDir, canonicalRunningProfile);
    assert.deepStrictEqual(recoveries[0].processIdentity, runningIdentity);
    assert.deepStrictEqual(recovered.store.listLegacyProjectResources(), []);
    assert(!fs.existsSync(runningProfile));
    const migrated = JSON.parse(fs.readFileSync(resourcesFile, 'utf8'));
    assert.strictEqual(migrated.version, 12);
    assert.deepStrictEqual(migrated.resources, []);
  } finally {
    await recovered.dispose();
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
  const reconnecting = { ...current, status: 'reconnecting', revision: 3, collectionRevision: 4 };
  const recovered = { ...current, status: 'running', revision: 4, collectionRevision: 5 };
  assert.deepStrictEqual(mergeBrowserResource([current], reconnecting), [reconnecting]);
  assert.deepStrictEqual(mergeBrowserResource([reconnecting], recovered), [recovered]);
  assert.deepStrictEqual(
    mergeBrowserResource([recovered], reconnecting),
    [recovered],
    'A delayed reconnecting callback must not replace a recovered generation',
  );

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
    ownerAgentId: 'agent_a',
    projectRootId: 'wroot_project',
    workspace: '/tmp/project',
    name: 'Agent A Browser',
  }, {
    id: 'browser_agent_b',
    ownerAgentId: 'agent_b',
    projectRootId: 'wroot_project',
    workspace: '/tmp/project',
    name: 'Agent B Browser',
  }, {
    id: 'browser_agent_a_other_project',
    ownerAgentId: 'agent_a',
    projectRootId: 'wroot_other',
    workspace: '/tmp/other-project',
    name: 'Stale Agent A Browser',
  }];
  const calls = [];
  const manager = {
    requireEnabled() {},
    refreshCapability: async (_selection, options) => {
      calls.push({ kind: 'refresh-capability', options });
    },
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
    ensureSession: input => {
      calls.push({ kind: 'ensure-session', input });
      return { id: 'browser_agent_a', ...input, sessionCreated: false };
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
    takeControl: async (id, owner) => {
      calls.push({ kind: 'take-control', id, owner });
      return { id, controlOwner: owner };
    },
    nativeUserAction: async (id, input) => {
      calls.push({ kind: 'native-user-action', id, input });
      return { id, ...input };
    },
    selectNativeTab: async id => {
      calls.push({ kind: 'select-native-tab', id });
      return { id, selected: true };
    },
    createNativeTab: async (id, input) => {
      calls.push({ kind: 'create-native-tab', id, input });
      return { id: 'browser_native_tab', ...input };
    },
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
  app.use((req, _res, next) => {
    req.authAccessMode = req.headers['x-test-access'] === 'read-only' ? 'read-only' : 'owner';
    next();
  });
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
  const humanRequest = (pathname, options: Parameters<typeof fetch>[1] = {}) => (
    request(pathname, {
      ...options,
      headers: {
        'X-Farming-Agent-Id': '',
        ...options.headers,
      },
    })
  );
  try {
    const readOnlyCapability = await request('/api/browsers/capability', {
      headers: { 'X-Test-Access': 'read-only' },
    });
    assert.strictEqual(readOnlyCapability.status, 200);
    assert.deepStrictEqual(calls.at(-1), {
      kind: 'refresh-capability',
      options: { persistDefaultSelection: false, reuseVerified: true },
    });

    const ownerCapability = await request('/api/browsers/capability');
    assert.strictEqual(ownerCapability.status, 200);
    assert.deepStrictEqual(calls.at(-1), {
      kind: 'refresh-capability',
      options: { persistDefaultSelection: true, reuseVerified: true },
    });

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
      'Agent-scoped Browser listing must be filtered by Agent and current Project',
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

    const nativeOnlyRoutes = [
      ['/api/browsers/browser_agent_a/control', { owner: 'user' }],
      ['/api/browsers/browser_agent_a/native-action', { kind: 'reload' }],
      ['/api/browsers/browser_agent_a/select-native-tab', {}],
      ['/api/browsers/browser_agent_a/native-tab', {}],
    ];
    for (const [pathname, body] of nativeOnlyRoutes) {
      const forbidden = await request(pathname, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      assert.strictEqual(forbidden.status, 403);
      assert.strictEqual(forbidden.body.code, 'BROWSER_HUMAN_CONTROL_ONLY');
    }

    const userControl = await humanRequest('/api/browsers/browser_agent_a/control', {
      method: 'POST',
      body: JSON.stringify({ owner: 'user' }),
    });
    assert.strictEqual(userControl.status, 200);
    assert.deepStrictEqual(calls.at(-1), {
      kind: 'take-control',
      id: 'browser_agent_a',
      owner: 'user',
    });
    const userAction = await humanRequest('/api/browsers/browser_agent_a/native-action', {
      method: 'POST',
      body: JSON.stringify({ kind: 'reload' }),
    });
    assert.strictEqual(userAction.status, 200);
    assert.deepStrictEqual(calls.at(-1), {
      kind: 'native-user-action',
      id: 'browser_agent_a',
      input: { kind: 'reload' },
    });
    const userSelection = await humanRequest('/api/browsers/browser_agent_a/select-native-tab', {
      method: 'POST',
    });
    assert.strictEqual(userSelection.status, 200);
    assert.deepStrictEqual(calls.at(-1), {
      kind: 'select-native-tab',
      id: 'browser_agent_a',
    });
    const userTab = await humanRequest('/api/browsers/browser_agent_a/native-tab', {
      method: 'POST',
      body: JSON.stringify({ url: 'about:blank' }),
    });
    assert.strictEqual(userTab.status, 201);
    assert.deepStrictEqual(calls.at(-1), {
      kind: 'create-native-tab',
      id: 'browser_agent_a',
      input: { url: 'about:blank' },
    });

    const ownerless = await request('/api/browsers', {
      method: 'POST',
      headers: { 'X-Farming-Agent-Id': '' },
      body: JSON.stringify({ rootId: 'wroot_project' }),
    });
    assert.strictEqual(ownerless.status, 400);
    assert.strictEqual(ownerless.body.code, 'BROWSER_AGENT_OWNER_REQUIRED');

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
        ownerAgentId: 'agent_a',
        name: 'Owned',
        url: 'https://example.test/',
        browserSource: 'extension',
        existingTabId: 42,
      },
    });

    const reused = await request('/api/browsers', {
      method: 'POST',
      body: JSON.stringify({
        rootId: 'wroot_project',
        agentId: 'agent_a',
        sessionName: 'default',
        reuseSession: true,
        url: 'https://reuse.example/',
      }),
    });
    assert.strictEqual(reused.status, 200);
    assert.deepStrictEqual(calls.at(-1), {
      kind: 'ensure-session',
      input: {
        projectRootId: 'wroot_project',
        workspace: '/tmp/project',
        ownerAgentId: 'agent_a',
        name: undefined,
        url: 'https://reuse.example/',
        preferDesktop: true,
        sessionName: 'default',
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
  .then(testAgentBrowserNamedSessionEnsure)
  .then(testAgentBrowserRestartRecovery)
  .then(testLegacyProjectBrowserMigrationCleanup)
  .then(testBrowserResourceRevisionOrdering)
  .then(testBrowserRouterAgentOwnership)
  .then(testBrowserPackaging)
  .then(() => console.log('browser extension tests passed'))
  .catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
