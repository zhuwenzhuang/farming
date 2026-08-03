const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const {
  BrowserResourceManager,
} = require('../../extensions/browser/backend/browser-resource-manager.cjs');
const {
  AgentBrowserRuntime,
} = require('../../extensions/browser/backend/agent-browser-runtime.cjs');

/**
 * Deterministic agent-browser stand-in for Browser recovery. It records every
 * lifecycle call so a test can prove that no Agent action is ever replayed.
 */
class RecoveryRuntime extends EventEmitter {
  constructor(options) {
    super();
    this.id = options.id;
    this.generation = options.generation;
    this.configDir = options.configDir;
    this.profileDir = options.profileDir;
    this.externalCdpUrl = options.externalCdpUrl || '';
    this.tabs = [];
    this.nextTab = 1;
    this.activeTabId = '';
    this.streamTabId = '';
    this.ownedTabIds = new Set();
    this.streamGeneration = 1;
    this.daemonRunning = true;
    this.processIdentity = null;
    this.closed = false;
    this.closeFailure = '';
    this.startFailure = '';
    this.reattachFailure = '';
    this.reattachCalls = 0;
    this.startedUrls = [];
    this.actionCalls = [];
    this.switchedTabs = [];
    this.pendingActions = [];
  }

  createFakeTab(url) {
    const tab = {
      active: true,
      tabId: `t${this.nextTab++}`,
      title: `Title ${url}`,
      type: 'page',
      url,
    };
    this.tabs.forEach(candidate => { candidate.active = false; });
    this.tabs.push(tab);
    this.activeTabId = tab.tabId;
    this.streamTabId = tab.tabId;
    return tab;
  }

  async start(url) {
    if (this.startFailure) throw new Error(this.startFailure);
    this.startedUrls.push(url);
    this.createFakeTab(url);
    this.processIdentity = {
      pid: 61_000 + this.generation,
      processGroupId: 61_000 + this.generation,
      startedAt: `recovery-generation-${this.generation}`,
      format: 'test-v1',
    };
    this.emit('process-identity', this.processIdentity);
    return { url, title: `Title ${url}` };
  }

  async createTab(url) {
    this.startedUrls.push(url);
    return { ...this.createFakeTab(url) };
  }

  async listTabs() {
    return this.tabs.map(tab => ({ ...tab }));
  }

  async switchTab(tabId) {
    const tab = this.tabs.find(candidate => candidate.tabId === tabId);
    if (!tab) throw new Error(`missing tab ${tabId}`);
    this.tabs.forEach(candidate => { candidate.active = candidate === tab; });
    this.activeTabId = tabId;
    this.streamTabId = tabId;
    this.switchedTabs.push(tabId);
    return { ...tab };
  }

  async closeTab(tabId) {
    this.tabs = this.tabs.filter(tab => tab.tabId !== tabId);
    const next = this.tabs[0];
    if (next) next.active = true;
    this.activeTabId = next?.tabId || '';
    this.streamTabId = next?.tabId || '';
    return this.listTabs();
  }

  async close() {
    if (this.closeFailure) throw new Error(this.closeFailure);
    this.closed = true;
  }

  async daemonAlive() {
    return this.daemonRunning;
  }

  async reattachStream() {
    this.reattachCalls += 1;
    if (this.reattachFailure) throw new Error(this.reattachFailure);
    this.streamGeneration += 1;
  }

  dropStream(reason = 'agent-browser stream closed', streamGeneration = this.streamGeneration) {
    this.emit('stream-closed', { reason, streamGeneration });
  }

  /** Resolves only when the test releases it, modelling an in-flight mutation. */
  blockingAction(kind) {
    return new Promise(resolve => {
      this.pendingActions.push({ kind, release: () => resolve({ ok: true }) });
    });
  }

  async click(input) {
    this.actionCalls.push({ kind: 'click', input });
    return this.blockingAction('click');
  }

  async snapshot(input = {}) {
    this.actionCalls.push({ kind: 'snapshot', input });
    return { url: this.activeTabId, title: 'snapshot' };
  }

  async navigate(url) {
    this.actionCalls.push({ kind: 'navigate', input: { url } });
    return { url, title: `Title ${url}` };
  }

  async goBack() { return { url: 'about:blank', title: '' }; }
  async goForward() { return { url: 'about:blank', title: '' }; }
  async reload() { return { url: 'about:blank', title: '' }; }
  async screenshot() { return { mimeType: 'image/png', data: '' }; }
  async emulate() { return { ok: true }; }
  async elementAction() { return { ok: true }; }
  async type(input) {
    this.actionCalls.push({ kind: 'type', input });
    return { ok: true };
  }
  async keyboard() { return { ok: true }; }
  async press() { return { ok: true }; }
  async select() { return { ok: true }; }
  async drag() { return { ok: true }; }
  async waitFor() { return { ok: true }; }
  async get() { return { ok: true }; }
  async is() { return { ok: true }; }
  async find() { return { ok: true }; }
  async evaluate() { return { ok: true }; }
  async debugLog() { return { ok: true }; }
  async network() { return { ok: true }; }
  async cookies() { return { ok: true }; }
  async storage() { return { ok: true }; }
  async frame() { return { ok: true }; }
  async dialog() { return { ok: true }; }
  async upload() { return { ok: true }; }
  async download() { return { ok: true }; }
  async wheel(input) {
    this.actionCalls.push({ kind: 'wheel', input });
  }
  async pointer(input) {
    this.actionCalls.push({ kind: 'pointer', input });
  }
  async resize(input) {
    this.actionCalls.push({ kind: 'resize', input });
  }
  async insertText(text) {
    this.actionCalls.push({ kind: 'text', input: { text } });
  }
}

class RecoveryViewer extends EventEmitter {
  constructor() {
    super();
    this.readyState = 1;
    this.messages = [];
  }

  send(message) {
    this.messages.push(JSON.parse(message));
  }
}

interface RecoveryManagerOptions {
  browserKind?: string;
  cdpUrl?: string;
  manager?: Record<string, unknown>;
  onCreate?: (runtime: RecoveryRuntime, index: number) => void;
  startFailures?: Record<number, string>;
}

function createManager(configDir, options: RecoveryManagerOptions = {}) {
  const runtimes = [];
  const manager = new BrowserResourceManager({
    configDir,
    discoverExecutable: () => ({
      kind: options.browserKind || 'chrome',
      path: '/fake/chrome',
      agentBrowserPath: '/fake/agent-browser',
      ...(options.cdpUrl ? { cdpUrl: options.cdpUrl } : {}),
    }),
    createRuntime: input => {
      const runtime = new RecoveryRuntime(input);
      runtime.startFailure = options.startFailures?.[runtimes.length] || '';
      runtimes.push(runtime);
      options.onCreate?.(runtime, runtimes.length - 1);
      return runtime;
    },
    readProcessIdentity: async () => null,
    wait: async () => {},
    ...options.manager,
  });
  return { manager, runtimes };
}

function createBrowser(manager, name, url = 'about:blank') {
  return manager.create({
    projectRootId: 'wroot_recovery',
    workspace: '/tmp/recovery-project',
    ownerType: 'agent',
    ownerAgentId: 'agent_recovery',
    name,
    url,
  });
}

function sessionOf(manager, id) {
  const stored = manager.store.get(id);
  return manager.sessions.get(stored.sessionId);
}

async function settleRecovery(session) {
  assert(session.recovery, 'a stream loss must open exactly one bounded recovery');
  await session.recovery.settled;
}

async function testStreamReattachSucceeds() {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-browser-recovery-reattach-'));
  const { manager, runtimes } = createManager(configDir);
  try {
    await manager.init();
    const browser = createBrowser(manager, 'Reattach', 'https://example.test/page');
    const running = await manager.start(browser.id);
    assert.strictEqual(running.status, 'running');
    const session = sessionOf(manager, browser.id);
    const runtime = runtimes[0];
    const viewer = new RecoveryViewer();
    manager.attachViewer(browser.id, viewer);

    runtime.dropStream();
    assert.strictEqual(
      manager.get(browser.id).status,
      'recovering',
      'a live daemon with a dropped stream must expose the explicit recovering phase',
    );
    assert.strictEqual(
      viewer.messages.filter(message => message.type === 'browser-state')
        .at(-1).resource.status,
      'recovering',
      'the Viewer must receive the recovering state instead of a silent freeze',
    );
    assert.match(
      viewer.messages.filter(message => message.type === 'browser-error').at(-1).message,
      /reconnecting this Browser without replaying any action/,
    );
    assert.throws(
      () => manager.action(browser.id, { kind: 'snapshot' }),
      error => error.code === 'BROWSER_RECOVERING',
      'new Agent actions must fail explicitly while the Session is recovering',
    );

    await settleRecovery(session);
    assert.strictEqual(runtime.reattachCalls, 1, 'recovery must attempt exactly one re-attach');
    assert.strictEqual(manager.get(browser.id).status, 'running');
    assert.strictEqual(manager.get(browser.id).error, '');
    assert.strictEqual(
      manager.get(browser.id).generation,
      running.generation,
      'a stream re-attach keeps the same Resource generation because nothing restarted',
    );
    assert.strictEqual(runtime.closed, false, 'a live daemon must not be closed by recovery');
    assert.strictEqual(
      (await manager.action(browser.id, { kind: 'snapshot' })).title,
      'snapshot',
      'a recovered Session must admit Agent actions again',
    );
    assert.strictEqual(
      runtime.actionCalls.filter(call => call.kind === 'click').length,
      0,
      'recovery must never replay an interaction',
    );
    await manager.stop(browser.id);
  } finally {
    await manager.dispose().catch(() => {});
    fs.rmSync(configDir, { recursive: true, force: true });
  }
}

async function testReattachReconcilesTabsWithoutAdoption() {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-browser-recovery-tabs-'));
  const { manager, runtimes } = createManager(configDir);
  try {
    await manager.init();
    const kept = createBrowser(manager, 'Kept', 'https://kept.test/page');
    await manager.start(kept.id);
    const session = sessionOf(manager, kept.id);
    const closed = createBrowser(manager, 'Closed while offline', 'https://closed.test/page');
    await manager.start(closed.id);
    const runtime = runtimes[0];
    const closedTabId = manager.store.get(closed.id).tabId;

    // While the stream is down the page closes one owned tab and a popup opens.
    runtime.tabs = runtime.tabs.filter(tab => tab.tabId !== closedTabId);
    const keptTab = runtime.tabs.find(tab => tab.tabId === manager.store.get(kept.id).tabId);
    keptTab.url = 'https://kept.test/moved';
    keptTab.title = 'Moved';
    runtime.tabs.push({
      active: false,
      tabId: 't99',
      title: 'Unproven popup',
      type: 'page',
      url: 'https://popup.test/ad',
    });
    runtime.dropStream();
    await settleRecovery(session);

    assert.strictEqual(manager.get(kept.id).status, 'running');
    assert.strictEqual(
      manager.get(kept.id).url,
      'https://kept.test/moved',
      'a reconnected Session must refresh surviving tabs from authoritative daemon state',
    );
    assert.strictEqual(manager.get(kept.id).title, 'Moved');
    assert.strictEqual(
      manager.get(closed.id).status,
      'stopped',
      'a tab closed during the outage must become a stopped Resource, not a restored one',
    );
    assert.strictEqual(manager.store.get(closed.id).tabId, '');
    assert.strictEqual(
      manager.list().length,
      2,
      'recovery must not adopt a tab whose admission it cannot prove',
    );
    assert.strictEqual(manager.runtimes.has(closed.id), false);
    assert.strictEqual(session.bindings.size, 1);
    await manager.stop(kept.id);
  } finally {
    await manager.dispose().catch(() => {});
    fs.rmSync(configDir, { recursive: true, force: true });
  }
}

async function testReattachFailureRestartsSessionOnce() {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-browser-recovery-restart-'));
  const { manager, runtimes } = createManager(configDir);
  try {
    await manager.init();
    const first = createBrowser(manager, 'Primary', 'https://first.test/page');
    const firstRunning = await manager.start(first.id);
    const session = sessionOf(manager, first.id);
    const second = createBrowser(manager, 'Secondary', 'https://second.test/page');
    await manager.start(second.id);
    const blank = createBrowser(manager, 'Blank', 'about:blank');
    await manager.start(blank.id);
    const closedTab = createBrowser(manager, 'Closed', 'https://closed.test/page');
    await manager.start(closedTab.id);
    const runtime = runtimes[0];
    assert.strictEqual(manager.sessions.size, 1, 'one Agent and one source share one Session');

    // The tab is gone before the stream drops, so it must not be restored.
    const closedTabId = manager.store.get(closedTab.id).tabId;
    await manager.stop(closedTab.id);
    assert.strictEqual(manager.get(closedTab.id).status, 'stopped');

    runtime.daemonRunning = true;
    runtime.reattachFailure = 'stream port unavailable';
    runtime.dropStream();
    await settleRecovery(session);

    const restarted = runtimes[1];
    assert(restarted, 'a failed re-attach must be followed by exactly one Session restart');
    assert.strictEqual(runtimes.length, 2, 'recovery must restart the Session at most once');
    assert.strictEqual(runtime.closed, true, 'the superseded runtime must be closed exactly once');
    assert.deepStrictEqual(
      restarted.startedUrls,
      ['https://first.test/page', 'https://second.test/page', 'about:blank'],
      'restart must restore only the Resources that still belong to this Session, from stored URLs',
    );
    assert.strictEqual(
      restarted.startedUrls.includes('https://closed.test/page'),
      false,
      'a stopped Resource must never be restored by recovery',
    );
    assert.strictEqual(manager.get(first.id).status, 'running');
    assert.strictEqual(manager.get(second.id).status, 'running');
    assert.strictEqual(manager.get(blank.id).status, 'running');
    assert.strictEqual(manager.get(blank.id).url, 'about:blank');
    assert.strictEqual(manager.get(closedTab.id).status, 'stopped');
    assert.strictEqual(
      manager.get(first.id).generation,
      firstRunning.generation + 1,
      'a restarted tab must expose a new Resource generation so stale Viewer input is rejected',
    );
    assert.strictEqual(
      manager.store.get(first.id).sessionGeneration,
      session.generation,
      'the restored Resource must record the new Session generation',
    );
    assert.notStrictEqual(manager.store.get(first.id).tabId, closedTabId);
    assert.deepStrictEqual(
      manager.store.get(first.id).processIdentity,
      restarted.processIdentity,
      'the restarted Session process identity must be recorded for exact cleanup',
    );
    assert.strictEqual(manager.store.get(second.id).processIdentity, null);

    runtime.dropStream('late stream close from the superseded runtime', 1);
    await new Promise(resolve => setImmediate(resolve));
    assert.strictEqual(
      manager.get(first.id).status,
      'running',
      'a late stream close from a superseded runtime must not disturb the new generation',
    );
    assert.strictEqual(runtimes.length, 2, 'a stale stream event must not open a second recovery');

    restarted.daemonRunning = false;
    restarted.dropStream();
    await settleRecovery(session);
    assert.strictEqual(
      runtimes.length,
      2,
      'a Session may only spend its single restart budget once',
    );
    assert.strictEqual(manager.get(first.id).status, 'failed');
    assert.match(manager.get(first.id).error, /Session process is gone/);
    assert.strictEqual(manager.get(second.id).status, 'failed');
    assert.strictEqual(manager.store.get(first.id).processIdentity, null);
    assert.strictEqual(manager.sessions.size, 0, 'a failed Session must be released');
    assert.strictEqual(manager.runtimes.size, 0, 'a failed Session must release its bindings');
  } finally {
    await manager.dispose().catch(() => {});
    fs.rmSync(configDir, { recursive: true, force: true });
  }
}

async function testRestartFailureFailsExplicitly() {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-browser-recovery-restart-fail-'));
  const { manager, runtimes } = createManager(configDir, {
    startFailures: { 1: 'Chromium profile is locked' },
  });
  try {
    await manager.init();
    const browser = createBrowser(manager, 'Restart failure', 'https://example.test/page');
    await manager.start(browser.id);
    const session = sessionOf(manager, browser.id);
    runtimes[0].daemonRunning = false;
    runtimes[0].dropStream();
    await settleRecovery(session);
    assert.strictEqual(manager.get(browser.id).status, 'failed');
    assert.match(manager.get(browser.id).error, /Session restart failed: Chromium profile is locked/);
    assert.strictEqual(
      runtimes[1].closed,
      true,
      'a failed restart must close the replacement runtime it created',
    );
    assert.strictEqual(manager.sessions.size, 0);
    assert.strictEqual(manager.store.get(browser.id).processIdentity, null);
  } finally {
    await manager.dispose().catch(() => {});
    fs.rmSync(configDir, { recursive: true, force: true });
  }
}

async function testRestartTimeoutCannotCommitLate() {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-browser-recovery-timeout-'));
  let releaseRestartStart = null;
  const { manager, runtimes } = createManager(configDir, {
    onCreate: (runtime, index) => {
      if (index !== 1) return;
      const original = runtime.start.bind(runtime);
      runtime.start = url => new Promise((resolve, reject) => {
        releaseRestartStart = () => original(url).then(resolve, reject);
      });
    },
    manager: {
      scheduleTimeout: (callback, delay) => (
        delay === 30_000 ? setImmediate(callback) : setTimeout(callback, delay)
      ),
      cancelTimeout: handle => {
        clearTimeout(handle);
        clearImmediate(handle);
      },
    },
  });
  try {
    await manager.init();
    const browser = createBrowser(manager, 'Timed out restart', 'https://example.test/page');
    await manager.start(browser.id);
    const session = sessionOf(manager, browser.id);
    runtimes[0].daemonRunning = false;
    runtimes[0].dropStream();
    while (!releaseRestartStart) await new Promise(resolve => setImmediate(resolve));
    await settleRecovery(session);
    assert.strictEqual(manager.get(browser.id).status, 'failed');
    assert.match(manager.get(browser.id).error, /Session restart timed out/);

    releaseRestartStart();
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
    assert.strictEqual(
      manager.get(browser.id).status,
      'failed',
      'a replacement runtime that completes after the deadline must not restore the Resource',
    );
    assert.strictEqual(manager.sessions.size, 0);
    assert.strictEqual(manager.runtimes.size, 0);
    assert.strictEqual(runtimes[1].closed, true);
  } finally {
    await manager.dispose().catch(() => {});
    fs.rmSync(configDir, { recursive: true, force: true });
  }
}

async function testExternalCdpSessionNeverRestarts() {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-browser-recovery-external-'));
  const { manager, runtimes } = createManager(configDir, {
    browserKind: 'external-cdp',
    cdpUrl: 'http://127.0.0.1:9222/',
  });
  try {
    await manager.init();
    const browser = createBrowser(manager, 'External', 'https://example.test/page');
    await manager.start(browser.id);
    const session = sessionOf(manager, browser.id);
    assert.strictEqual(session.restartable, false);
    runtimes[0].daemonRunning = false;
    runtimes[0].dropStream();
    await settleRecovery(session);
    assert.strictEqual(
      runtimes.length,
      1,
      'Farming must never restart a Browser process it does not own',
    );
    assert.strictEqual(manager.get(browser.id).status, 'failed');
    assert.match(manager.get(browser.id).error, /External Browser connection exited/);
  } finally {
    await manager.dispose().catch(() => {});
    fs.rmSync(configDir, { recursive: true, force: true });
  }
}

async function testInFlightActionsFailAsUncertainOutcome() {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-browser-recovery-uncertain-'));
  const { manager, runtimes } = createManager(configDir);
  try {
    await manager.init();
    const browser = createBrowser(manager, 'Uncertain', 'https://example.test/page');
    const running = await manager.start(browser.id);
    const session = sessionOf(manager, browser.id);
    const runtime = runtimes[0];
    const viewer = new RecoveryViewer();
    manager.attachViewer(browser.id, viewer);

    const clicking = manager.action(browser.id, { kind: 'click', selector: '#submit' });
    await new Promise(resolve => setImmediate(resolve));
    assert.strictEqual(runtime.pendingActions.length, 1, 'the click must be in flight');
    const queuedClick = manager.action(browser.id, { kind: 'click', selector: '#queued' });
    const clickingRejected = assert.rejects(
      clicking,
      error => (
        error.code === 'BROWSER_UNCERTAIN_OUTCOME'
        && /outcome is unknown and Farming did not replay it/.test(error.message)
      ),
      'an in-flight mutation must fail immediately as an uncertain outcome',
    );
    const queuedRejected = assert.rejects(
      queuedClick,
      error => error.code === 'BROWSER_UNCERTAIN_OUTCOME',
      'an admitted mutation that has not started must be cancelled, not replayed later',
    );
    viewer.emit('message', Buffer.from(JSON.stringify({
      type: 'pointer',
      generation: running.generation,
      action: 'down',
      x: 12,
      y: 24,
      button: 'left',
    })));
    await new Promise(resolve => setImmediate(resolve));

    runtime.dropStream();
    await Promise.all([clickingRejected, queuedRejected]);
    await settleRecovery(session);
    assert.strictEqual(manager.get(browser.id).status, 'running');
    assert.strictEqual(
      runtime.actionCalls.filter(call => call.kind === 'click').length,
      1,
      'the interrupted click must never be replayed after recovery',
    );
    assert.strictEqual(
      runtime.actionCalls.filter(call => call.kind === 'pointer').length,
      0,
      'queued Viewer input must be discarded instead of replayed into the recovered page',
    );
    // The interrupted runtime call still settles; it must not resurface as a result.
    runtime.pendingActions.forEach(pending => pending.release());
    await new Promise(resolve => setImmediate(resolve));
    assert.strictEqual(
      runtime.actionCalls.filter(call => call.kind === 'click').length,
      1,
      'a queued click whose caller received uncertain outcome must never execute later',
    );
    assert.strictEqual(manager.get(browser.id).status, 'running');
    await manager.stop(browser.id);
  } finally {
    await manager.dispose().catch(() => {});
    fs.rmSync(configDir, { recursive: true, force: true });
  }
}

async function testDrainedViewerBatchFailsAsUncertainOutcome() {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-browser-recovery-viewer-'));
  const { manager, runtimes } = createManager(configDir);
  try {
    await manager.init();
    const browser = createBrowser(manager, 'Viewer uncertain', 'https://example.test/page');
    const running = await manager.start(browser.id);
    const session = sessionOf(manager, browser.id);
    const runtime = runtimes[0];
    const binding = manager.runtimes.get(browser.id);
    const viewer = new RecoveryViewer();
    runtime.pointer = input => {
      runtime.actionCalls.push({ kind: 'pointer', input });
      return input.x === 1 ? runtime.blockingAction('pointer') : Promise.resolve();
    };

    const first = manager.handleViewerMessage(binding, viewer, {
      type: 'pointer',
      generation: running.generation,
      action: 'down',
      x: 1,
      y: 1,
      button: 'left',
    });
    const second = manager.handleViewerMessage(binding, viewer, {
      type: 'pointer',
      generation: running.generation,
      action: 'up',
      x: 2,
      y: 2,
      button: 'left',
    });
    await new Promise(resolve => setImmediate(resolve));
    assert.strictEqual(runtime.pendingActions.length, 1, 'the first Viewer input must be in flight');
    assert.strictEqual(
      session.pendingViewerInputs.length,
      0,
      'both Viewer inputs must already be owned by the active drain batch',
    );

    const firstRejected = assert.rejects(
      first,
      error => error.code === 'BROWSER_UNCERTAIN_OUTCOME',
    );
    const secondRejected = assert.rejects(
      second,
      error => error.code === 'BROWSER_UNCERTAIN_OUTCOME',
    );
    runtime.dropStream();
    await Promise.all([firstRejected, secondRejected]);
    await settleRecovery(session);
    assert.strictEqual(manager.get(browser.id).status, 'running');
    assert.strictEqual(
      runtime.actionCalls.filter(call => call.kind === 'pointer').length,
      1,
      'a later input already extracted into the drain batch must never execute after recovery',
    );

    runtime.pendingActions.forEach(pending => pending.release());
    await new Promise(resolve => setImmediate(resolve));
    assert.strictEqual(runtime.actionCalls.filter(call => call.kind === 'pointer').length, 1);
    await manager.stop(browser.id);
  } finally {
    await manager.dispose().catch(() => {});
    fs.rmSync(configDir, { recursive: true, force: true });
  }
}

async function testStoppingOneTabDoesNotCancelSharedReattach() {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-browser-recovery-shared-stop-'));
  const { manager, runtimes } = createManager(configDir);
  try {
    await manager.init();
    const stopping = createBrowser(manager, 'Stop one', 'https://stop.test/page');
    await manager.start(stopping.id);
    const surviving = createBrowser(manager, 'Keep one', 'https://keep.test/page');
    await manager.start(surviving.id);
    const session = sessionOf(manager, stopping.id);
    const runtime = runtimes[0];
    let releaseReattach: (value?: unknown) => void = () => {};
    runtime.reattachStream = () => new Promise(resolve => {
      runtime.reattachCalls += 1;
      releaseReattach = resolve;
    });

    runtime.dropStream();
    assert.strictEqual(manager.get(stopping.id).status, 'recovering');
    assert.strictEqual(manager.get(surviving.id).status, 'recovering');
    while (runtime.reattachCalls === 0) await new Promise(resolve => setImmediate(resolve));
    const stopped = manager.stop(stopping.id);
    assert.strictEqual(
      session.recovery.cancelled,
      false,
      'stopping one tab must not cancel recovery for the remaining shared Session',
    );
    releaseReattach();
    assert.strictEqual((await stopped).status, 'stopped');
    await session.recovery?.settled;

    assert.strictEqual(manager.get(stopping.id).status, 'stopped');
    assert.strictEqual(manager.get(surviving.id).status, 'running');
    assert.strictEqual(runtime.closed, false);
    assert.strictEqual(session.bindings.size, 1);
    assert.strictEqual((await manager.action(surviving.id, { kind: 'snapshot' })).title, 'snapshot');
    await manager.stop(surviving.id);
  } finally {
    await manager.dispose().catch(() => {});
    fs.rmSync(configDir, { recursive: true, force: true });
  }
}

async function testStopWinsOverRecovery() {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-browser-recovery-stop-'));
  const { manager, runtimes } = createManager(configDir);
  try {
    await manager.init();
    const stopped = createBrowser(manager, 'Stop wins', 'https://example.test/page');
    await manager.start(stopped.id);
    const stoppedSession = sessionOf(manager, stopped.id);
    const runtime = runtimes[0];
    let releaseReattach: (value?: unknown) => void = () => {};
    runtime.reattachStream = () => new Promise(resolve => {
      runtime.reattachCalls += 1;
      releaseReattach = resolve;
    });
    runtime.dropStream();
    assert.strictEqual(manager.get(stopped.id).status, 'recovering');
    const stopping = manager.stop(stopped.id);
    assert.strictEqual(
      stoppedSession.recovery.cancelled,
      true,
      'Stop must cancel recovery at admission time',
    );
    releaseReattach();
    assert.strictEqual((await stopping).status, 'stopped');
    await stoppedSession.recovery?.settled;
    assert.strictEqual(
      manager.get(stopped.id).status,
      'stopped',
      'a cancelled recovery must never overwrite the explicit stopped outcome',
    );
    assert.strictEqual(runtime.closed, true);
    assert.strictEqual(manager.sessions.size, 0);
    assert.strictEqual(manager.runtimes.size, 0);
    assert.strictEqual(manager.store.get(stopped.id).processIdentity, null);
    assert.strictEqual(manager.store.get(stopped.id).tabId, '');

    const deleted = createBrowser(manager, 'Delete wins', 'https://example.test/other');
    await manager.start(deleted.id);
    const deletedSession = sessionOf(manager, deleted.id);
    const deletedRuntime = runtimes[1];
    let releaseDeletedReattach: (value?: unknown) => void = () => {};
    deletedRuntime.reattachStream = () => new Promise(resolve => {
      releaseDeletedReattach = resolve;
    });
    deletedRuntime.dropStream();
    const deleting = manager.delete(deleted.id);
    assert.strictEqual(deletedSession.recovery.cancelled, true);
    releaseDeletedReattach();
    await deleting;
    await deletedSession.recovery?.settled;
    assert.throws(() => manager.get(deleted.id), /not found/);
    assert.strictEqual(deletedRuntime.closed, true);
    assert.strictEqual(manager.sessions.size, 0);
    assert.strictEqual(manager.runtimes.size, 0);
  } finally {
    await manager.dispose().catch(() => {});
    fs.rmSync(configDir, { recursive: true, force: true });
  }
}

async function testStopDuringRestartClaimsOnlyItsResource() {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-browser-recovery-stop-restart-'));
  let releaseRestartStart = null;
  const { manager, runtimes } = createManager(configDir, {
    onCreate: (runtime, index) => {
      if (index !== 1) return;
      const original = runtime.start.bind(runtime);
      runtime.start = url => new Promise((resolve, reject) => {
        releaseRestartStart = () => original(url).then(resolve, reject);
      });
    },
  });
  try {
    await manager.init();
    const stopping = createBrowser(manager, 'Stopped mid restart', 'https://stop.test/page');
    await manager.start(stopping.id);
    const session = sessionOf(manager, stopping.id);
    const surviving = createBrowser(manager, 'Survivor', 'https://survivor.test/page');
    await manager.start(surviving.id);

    runtimes[0].daemonRunning = false;
    runtimes[0].dropStream();
    while (!releaseRestartStart) await new Promise(resolve => setImmediate(resolve));

    const stopped = manager.stop(stopping.id);
    releaseRestartStart();
    assert.strictEqual((await stopped).status, 'stopped');
    await session.recovery?.settled;

    assert.strictEqual(manager.get(stopping.id).status, 'stopped');
    assert.strictEqual(manager.store.get(stopping.id).tabId, '');
    assert.strictEqual(manager.store.get(stopping.id).processIdentity, null);
    assert.deepStrictEqual(
      runtimes[1].tabs.map(tab => tab.url),
      ['https://survivor.test/page'],
      'a Resource claimed by Stop during a restart must not keep a restored tab',
    );
    assert.strictEqual(
      manager.get(surviving.id).status,
      'running',
      'stopping one tab must not stop the rest of the restarted Session',
    );
    assert.strictEqual(manager.runtimes.size, 1);
    assert.strictEqual(session.bindings.size, 1);
    await manager.stop(surviving.id);
    assert.strictEqual(manager.sessions.size, 0);
    assert.strictEqual(manager.runtimes.size, 0);
  } finally {
    await manager.dispose().catch(() => {});
    fs.rmSync(configDir, { recursive: true, force: true });
  }
}

async function testHungReattachIsBounded() {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-browser-recovery-timeout-'));
  const { manager, runtimes } = createManager(configDir, {
    startFailures: { 1: 'restart refused' },
    manager: {
      // Only the stream re-attach bound is shortened, so the test proves the
      // bound exists without waiting for the production timeout.
      scheduleTimeout: (callback, durationMs) => setTimeout(callback, durationMs === 10_000 ? 0 : durationMs),
      cancelTimeout: clearTimeout,
    },
  });
  try {
    await manager.init();
    const browser = createBrowser(manager, 'Hung re-attach', 'https://example.test/page');
    await manager.start(browser.id);
    const session = sessionOf(manager, browser.id);
    // A live daemon whose stream never comes back must not hold the Session.
    runtimes[0].reattachStream = () => new Promise(() => {});
    runtimes[0].dropStream();
    await settleRecovery(session);
    assert.strictEqual(manager.get(browser.id).status, 'failed');
    assert.match(manager.get(browser.id).error, /Browser stream re-attach timed out/);
    assert.match(manager.get(browser.id).error, /Session restart failed: restart refused/);
    assert.strictEqual(manager.sessions.size, 0);
    assert.strictEqual(manager.runtimes.size, 0);
  } finally {
    await manager.dispose().catch(() => {});
    fs.rmSync(configDir, { recursive: true, force: true });
  }
}

async function testRecoveringSessionIsCleanedUpOnRestart() {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-browser-recovery-boot-'));
  const { manager } = createManager(configDir);
  try {
    await manager.init();
    const browser = createBrowser(manager, 'Interrupted recovery');
    const identity = {
      pid: 62_101,
      processGroupId: 62_101,
      startedAt: 'interrupted-recovery',
      format: 'test-v1',
    };
    manager.store.update(browser.id, {
      status: 'recovering',
      runtimeKind: 'agent-browser',
      sessionId: browser.id,
      sessionGeneration: 1,
      processIdentity: identity,
    });
    const recoveredIds = [];
    const rebooted = new BrowserResourceManager({
      configDir,
      discoverExecutable: () => ({
        kind: 'chrome',
        path: '/fake/chrome',
        agentBrowserPath: '/fake/agent-browser',
      }),
      createRuntime: options => new RecoveryRuntime(options),
      recoverRuntime: options => {
        recoveredIds.push({ id: options.id, generation: options.generation });
        return Promise.resolve();
      },
      readProcessIdentity: async () => null,
      wait: async () => {},
    });
    await rebooted.init();
    assert.deepStrictEqual(
      recoveredIds,
      [{ id: browser.id, generation: 1 }],
      'a Resource interrupted while recovering must be cleaned up by exact Session identity',
    );
    assert.strictEqual(rebooted.get(browser.id).status, 'failed');
    assert.strictEqual(rebooted.store.get(browser.id).processIdentity, null);
    await rebooted.dispose();
  } finally {
    await manager.dispose().catch(() => {});
    fs.rmSync(configDir, { recursive: true, force: true });
  }
}

async function testRuntimeStreamGenerationsAreIsolated() {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-browser-recovery-stream-'));
  const sockets = [];
  let socketsOpenAutomatically = true;
  class FakeSocket extends EventEmitter {
    constructor() {
      super();
      this.readyState = 0;
      this.closed = false;
      sockets.push(this);
      if (socketsOpenAutomatically) {
        setImmediate(() => {
          this.readyState = 1;
          this.emit('open');
        });
      }
    }

    send() {}

    close() {
      this.readyState = 3;
      this.closed = true;
    }
  }
  const identity = {
    pid: 63_001,
    processGroupId: 63_001,
    startedAt: 'stream-generation',
    format: 'test-v1',
  };
  let daemonRunning = true;
  const runtime = new AgentBrowserRuntime({
    id: 'browser_stream',
    generation: 1,
    configDir,
    profileDir: path.join(configDir, 'browsers', 'browser_stream', 'profile'),
    agentBrowserPath: '/fake/agent-browser',
    executablePath: '/fake/chromium',
    runCommand: async (_executable, args) => {
      const command = args.slice(4, -1);
      if (command[0] === 'session' && command[1] === 'info') {
        return { success: true, data: { active: daemonRunning, pid: identity.pid } };
      }
      if (command[0] === 'tab' && command[1] === 'list') {
        return {
          success: true,
          data: { tabs: [{ active: true, tabId: 't1', type: 'page', url: 'about:blank' }] },
        };
      }
      if (command[0] === 'stream') return { success: true, data: { port: 49_001 } };
      if (command[0] === 'get' && command[1] === 'url') {
        return { success: true, data: { url: 'about:blank' } };
      }
      if (command[0] === 'get' && command[1] === 'title') {
        return { success: true, data: { title: '' } };
      }
      if (command[0] === 'close') daemonRunning = false;
      return { success: true, data: {} };
    },
    createWebSocket: () => new FakeSocket(),
    readProcessIdentity: async pid => (daemonRunning && pid === identity.pid ? identity : null),
    wait: async () => {},
  });
  try {
    await runtime.start('about:blank');
    const closures = [];
    runtime.on('stream-closed', event => closures.push(event));
    assert.strictEqual(runtime.streamGeneration, 1);
    assert.strictEqual(await runtime.daemonAlive(), true);

    sockets[0].emit('close');
    assert.deepStrictEqual(
      closures.map(event => event.streamGeneration),
      [1],
      'a live stream close must report its own generation',
    );

    await runtime.reattachStream();
    assert.strictEqual(runtime.streamGeneration, 3, 'detach and re-attach both advance the stream');
    assert.strictEqual(sockets.length, 2);
    assert.strictEqual(sockets[0].closed, true, 'the superseded socket must be released');

    sockets[0].emit('close');
    assert.strictEqual(
      closures.length,
      1,
      'a late close from a superseded socket must not be reported again',
    );

    sockets[1].emit('close');
    assert.deepStrictEqual(closures.map(event => event.streamGeneration), [1, 3]);

    socketsOpenAutomatically = false;
    const pendingReattach = runtime.reattachStream();
    await new Promise(resolve => setImmediate(resolve));
    assert.strictEqual(sockets.length, 3);
    runtime.detachStream();
    await assert.rejects(
      pendingReattach,
      /stream connection was superseded/,
      'superseding a not-yet-open socket must settle the pending connection',
    );
    assert.strictEqual(sockets[2].closed, true);

    daemonRunning = false;
    assert.strictEqual(await runtime.daemonAlive(), false);
    await runtime.close();
    assert.strictEqual(sockets.length, 3, 'close must not open another stream socket');
    await assert.rejects(runtime.reattachStream(), /runtime is closed/);
    assert.strictEqual(sockets.length, 3);
  } finally {
    fs.rmSync(configDir, { recursive: true, force: true });
  }
}

async function run() {
  await testStreamReattachSucceeds();
  await testReattachReconcilesTabsWithoutAdoption();
  await testReattachFailureRestartsSessionOnce();
  await testRestartFailureFailsExplicitly();
  await testRestartTimeoutCannotCommitLate();
  await testExternalCdpSessionNeverRestarts();
  await testInFlightActionsFailAsUncertainOutcome();
  await testDrainedViewerBatchFailsAsUncertainOutcome();
  await testStopWinsOverRecovery();
  await testStoppingOneTabDoesNotCancelSharedReattach();
  await testStopDuringRestartClaimsOnlyItsResource();
  await testHungReattachIsBounded();
  await testRecoveringSessionIsCleanedUpOnRestart();
  await testRuntimeStreamGenerationsAreIsolated();
  console.log('Browser runtime recovery tests passed');
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
