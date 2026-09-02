const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const {
  DesktopBrowserAdapterRegistry,
} = require('../../extensions/browser/backend/desktop-browser-adapter.cjs');
const {
  BrowserResourceManager,
} = require('../../extensions/browser/backend/browser-resource-manager.cjs');

function adapterError(operation: () => Promise<unknown>, code: string) {
  return assert.rejects(operation, (error: Error & { code?: string }) => error.code === code);
}

function synchronousAdapterError(operation: () => unknown, code: string) {
  return assert.throws(operation, (error: Error & { code?: string }) => error.code === code);
}

function createAdapterHarness(options: {
  adapterId?: string;
  registry?: InstanceType<typeof DesktopBrowserAdapterRegistry>;
  startDelayMs?: number;
} = {}) {
  const registry = options.registry || new DesktopBrowserAdapterRegistry({ commandTimeoutMs: 1_000 });
  const adapterId = options.adapterId || 'desktop-test-adapter';
  const tabs = new Map<string, {
    active: boolean;
    controlEpoch: number;
    controlOwner: 'agent' | 'user';
    tabId: string;
    title: string;
    type: string;
    url: string;
  }>();
  let activeTabId = '';
  let nextTab = 1;
  const commands: Array<Record<string, unknown>> = [];
  let onCommand: ((command: Record<string, unknown>) => unknown) | null = null;
  const socket = {
    readyState: 1,
    send(serialized: string) {
      const message = JSON.parse(serialized) as { command?: Record<string, unknown> };
      const command = message.command || {};
      commands.push(command);
      const operation = String(command.operation || '');
      const input = command.input && typeof command.input === 'object'
        ? command.input as Record<string, unknown>
        : {};
      const settle = (result: unknown) => registry.settle({
        adapterId: command.adapterId,
        generation: command.generation,
        ok: true,
        requestId: command.requestId,
        resourceId: command.resourceId,
        result,
        sessionId: command.sessionId,
      }, socket);
      const fail = (
        error: unknown,
        code = 'BROWSER_DESKTOP_COMMAND_FAILED',
      ) => {
        const details = error && typeof error === 'object'
          ? error as { code?: unknown; message?: unknown; uncertain?: unknown }
          : {};
        registry.settle({
        adapterId: command.adapterId,
        code: typeof details.code === 'string' ? details.code : code,
        error: typeof details.message === 'string' ? details.message : String(error),
        generation: command.generation,
        ok: false,
        requestId: command.requestId,
        resourceId: command.resourceId,
        sessionId: command.sessionId,
        status: 500,
        ...(details.uncertain === true ? { uncertain: true } : {}),
      }, socket);
      };
      if (onCommand) {
        void Promise.resolve(onCommand(command)).then(result => {
          if (result !== undefined) settle(result);
        }).catch(error => fail(error));
        return;
      }
      if (operation === 'start' || operation === 'create-tab') {
        const tabId = `native:test-${nextTab++}`;
        const activate = operation === 'start' || input.unboundResource !== true;
        if (activate) {
          for (const tab of tabs.values()) tab.active = false;
        }
        const tab = {
          active: activate,
          controlEpoch: Number(input.controlEpoch ?? input.initialControlEpoch) || 0,
          controlOwner: 'agent' as const,
          tabId,
          title: operation === 'start' ? 'Desktop Browser' : 'New tab',
          type: 'page',
          url: String(input.url || 'about:blank'),
        };
        tabs.set(tabId, tab);
        if (activate) activeTabId = tabId;
        const result = operation === 'start'
          ? { title: tab.title, url: tab.url, tabs: [...tabs.values()] }
          : { tabId, tabs: [...tabs.values()] };
        if (operation === 'start' && options.startDelayMs) {
          setTimeout(() => settle(result), options.startDelayMs);
        } else {
          settle(result);
        }
        return;
      }
      if (operation === 'list-tabs' || operation === 'bind-tab' || operation === 'close-tab') {
        if (operation === 'bind-tab') {
          const tab = tabs.get(String(input.tabId || ''));
          if (!tab) {
            fail(new Error('Desktop Browser tab is unavailable'), 'BROWSER_TAB_UNAVAILABLE');
            return;
          }
          tab.controlEpoch = Number(input.controlEpoch) || 0;
          tab.controlOwner = input.controlOwner === 'user' ? 'user' : 'agent';
          registry.setControl(
            adapterId,
            command.resourceId,
            command.generation,
            tab.controlOwner,
          );
        }
        if (operation === 'close-tab') {
          tabs.delete(String(input.tabId || ''));
          const first = [...tabs.values()][0];
          if (first) {
            first.active = true;
            activeTabId = first.tabId;
          } else {
            activeTabId = '';
          }
        }
        settle({ tabs: [...tabs.values()] });
        return;
      }
      if (operation === 'commit-control') {
        registry.setControl(
          adapterId,
          command.resourceId,
          command.generation,
          input.owner,
        );
        settle({ controlEpoch: input.controlEpoch, owner: input.owner });
        return;
      }
      if (operation === 'switch-tab') {
        const selected = tabs.get(String(input.tabId || ''));
        if (!selected) {
          fail(new Error('Desktop Browser tab is unavailable'), 'BROWSER_TAB_UNAVAILABLE');
          return;
        }
        for (const tab of tabs.values()) tab.active = tab === selected;
        activeTabId = selected.tabId;
        settle({ tabs: [...tabs.values()] });
        return;
      }
      if (operation === 'navigate') {
        const active = tabs.get(activeTabId);
        if (!active) {
          fail('Desktop Browser tab is unavailable', 'BROWSER_TAB_UNAVAILABLE');
          return;
        }
        active.url = String(input.url || active.url);
        active.title = 'Navigated';
        settle({ title: active.title, url: active.url });
        return;
      }
      if (operation === 'get-zoom') {
        settle({ zoomFactor: 1 });
        return;
      }
      if (operation === 'zoom-in') {
        settle({ zoomFactor: 1.1 });
        return;
      }
      if (operation === 'zoom-out') {
        settle({ zoomFactor: 0.9 });
        return;
      }
      if (operation === 'reset-zoom') {
        settle({ zoomFactor: 1 });
        return;
      }
      if (operation === 'close-session') {
        settle({ ok: true });
        return;
      }
      settle({ ok: true });
    },
  };
  const unregister = registry.register(adapterId, socket);
  return {
    adapterId,
    activeTabId: () => activeTabId,
    commands,
    registry,
    socket,
    setOnCommand(handler: ((command: Record<string, unknown>) => unknown) | null) {
      onCommand = handler;
    },
    unregister,
  };
}

function createViewer() {
  const viewer = new EventEmitter() as InstanceType<typeof EventEmitter> & {
    messages: unknown[];
    readyState: number;
    send(message: string): void;
  };
  viewer.readyState = 1;
  viewer.messages = [];
  viewer.send = message => viewer.messages.push(JSON.parse(message));
  return viewer;
}

async function waitFor(condition: () => boolean, message: string) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (condition()) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  throw new Error(message);
}

async function testDesktopAdapterRegistry() {
  const harness = createAdapterHarness();
  const second = createAdapterHarness({
    adapterId: 'desktop-second-adapter',
    registry: harness.registry,
  });
  try {
    const result = await harness.registry.invoke({
      adapterId: harness.adapterId,
      generation: 1,
      operation: 'get-zoom',
      resourceId: 'browser_adapter',
      sessionId: 'browser_session',
    });
    assert.deepStrictEqual(result, { zoomFactor: 1 });
    assert.strictEqual(harness.commands[0]?.operation, 'get-zoom');

    harness.registry.setControl(harness.adapterId, 'browser_adapter', 1, 'user');
    assert.throws(
      () => harness.registry.assertAgentControl('browser_adapter', 1),
      (error: Error & { code?: string }) => error.code === 'BROWSER_HUMAN_CONTROL_ACTIVE',
    );
    harness.registry.clearControl('browser_adapter', 1);
    assert.doesNotThrow(() => harness.registry.assertAgentControl('browser_adapter', 1));

    harness.setOnCommand(() => undefined);
    const pending = harness.registry.invoke({
      adapterId: harness.adapterId,
      generation: 1,
      operation: 'get-zoom',
      resourceId: 'browser_adapter',
      sessionId: 'browser_session',
    });
    const requestId = String(harness.commands.at(-1)?.requestId || '');
    const command = harness.commands.at(-1) || {};
    assert(requestId, 'A Desktop command must have an exact request identity');
    second.registry.settle({
      adapterId: second.adapterId,
      generation: command.generation,
      ok: true,
      requestId,
      resourceId: command.resourceId,
      result: { zoomFactor: 2 },
      sessionId: command.sessionId,
    });
    let settled = false;
    void pending.then(() => { settled = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.strictEqual(settled, false, 'A response from another Desktop adapter must not settle the command');
    harness.registry.settle({
      adapterId: harness.adapterId,
      generation: Number(command.generation) + 1,
      ok: true,
      requestId,
      resourceId: command.resourceId,
      result: { zoomFactor: 2 },
      sessionId: command.sessionId,
    }, harness.socket);
    await new Promise(resolve => setImmediate(resolve));
    assert.strictEqual(
      settled,
      false,
      'A response with a stale Resource generation must not settle the command',
    );
    harness.registry.settle({
      adapterId: harness.adapterId,
      generation: command.generation,
      ok: true,
      requestId,
      resourceId: command.resourceId,
      result: { zoomFactor: 2 },
      sessionId: command.sessionId,
    }, second.socket);
    await new Promise(resolve => setImmediate(resolve));
    assert.strictEqual(
      settled,
      false,
      'A response delivered over another Desktop socket must not settle the command',
    );
    harness.registry.settle({
      adapterId: harness.adapterId,
      generation: command.generation,
      ok: true,
      requestId,
      resourceId: command.resourceId,
      result: { zoomFactor: 1.5 },
      sessionId: command.sessionId,
    }, harness.socket);
    assert.deepStrictEqual(await pending, { zoomFactor: 1.5 });
  } finally {
    second.unregister();
    harness.unregister();
    harness.registry.dispose();
  }
}

async function testDesktopAdapterDisconnectIsUncertain() {
  const harness = createAdapterHarness({ adapterId: 'desktop-disconnect-adapter' });
  harness.setOnCommand(() => undefined);
  try {
    const pending = harness.registry.invoke({
      adapterId: harness.adapterId,
      generation: 1,
      operation: 'navigate',
      resourceId: 'browser_disconnect',
      sessionId: 'browser_session',
    });
    harness.unregister();
    await assert.rejects(
      pending,
      (error: Error & { code?: string; uncertain?: boolean }) => (
        error.code === 'BROWSER_DESKTOP_ADAPTER_UNAVAILABLE'
        && error.uncertain === true
      ),
    );
  } finally {
    harness.unregister();
    harness.registry.dispose();
  }
}

async function testDesktopAdapterTimeoutIsUncertain() {
  const registry = new DesktopBrowserAdapterRegistry({
    commandTimeoutMs: 1_000,
    scheduleTimeout: callback => setTimeout(callback, 0),
  });
  const harness = createAdapterHarness({
    adapterId: 'desktop-timeout-adapter',
    registry,
  });
  harness.setOnCommand(() => undefined);
  try {
    await assert.rejects(
      () => registry.invoke({
        adapterId: harness.adapterId,
        generation: 1,
        operation: 'navigate',
        resourceId: 'browser_timeout',
        sessionId: 'browser_session',
      }),
      (error: Error & { code?: string; uncertain?: boolean }) => (
        error.code === 'BROWSER_DESKTOP_COMMAND_TIMEOUT'
        && error.uncertain === true
      ),
    );
    assert.strictEqual(
      harness.commands.filter(command => command.operation === 'navigate').length,
      1,
      'An uncertain Desktop command timeout must not retry the mutation automatically',
    );
  } finally {
    harness.unregister();
    registry.dispose();
  }
}

async function testDesktopNativeOperationTimeoutFailsClosed() {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-desktop-browser-timeout-'));
  const workspace = path.join(configDir, 'workspace');
  fs.mkdirSync(workspace);
  const registry = new DesktopBrowserAdapterRegistry({
    commandTimeoutMs: 1_000,
    scheduleTimeout: callback => setTimeout(callback, 0),
  });
  const harness = createAdapterHarness({
    adapterId: 'desktop-operation-timeout',
    registry,
  });
  const manager = new BrowserResourceManager({
    configDir,
    desktopBrowserAdapters: registry,
    discoverExecutable: async selection => (
      selection.source === 'desktop'
        ? { kind: 'desktop-native', path: '' }
        : null
    ),
    getBrowserSettings: () => ({
      browserExecutablePath: '',
      browserSource: 'desktop',
    }),
    isEnabled: () => true,
  });
  try {
    await manager.init();
    const created = manager.create({
      browserSource: 'desktop',
      desktopAdapterId: harness.adapterId,
      ownerAgentId: 'agent-operation-timeout',
      projectRootId: 'project-operation-timeout',
      workspace,
    });
    await manager.start(created.id);
    harness.setOnCommand(command => (
      String(command.operation || '') === 'click' ? undefined : { ok: true }
    ));

    await assert.rejects(
      () => manager.action(created.id, { kind: 'click', selector: '#submit' }),
      (error: Error & { code?: string; uncertain?: boolean }) => (
        error.code === 'BROWSER_DESKTOP_OPERATION_UNCERTAIN'
        && error.uncertain === true
      ),
    );
    const failed = manager.get(created.id);
    assert.strictEqual(failed.status, 'failed');
    assert.match(
      failed.error,
      /command outcome is uncertain/i,
      'A timed-out native mutation must fail closed instead of leaving a runnable lease.',
    );
    assert.strictEqual(
      harness.commands.filter(command => command.operation === 'click').length,
      1,
      'A timed-out native mutation must not be retried automatically.',
    );
    synchronousAdapterError(
      () => manager.action(created.id, { kind: 'click', selector: '#submit' }),
      'BROWSER_NOT_RUNNING',
    );
    assert.strictEqual(
      harness.commands.filter(command => command.operation === 'click').length,
      1,
      'A failed native Resource must fence later Agent actions until an explicit cleanup.',
    );
  } finally {
    harness.setOnCommand(null);
    await manager.dispose().catch(() => {});
    harness.unregister();
    registry.dispose();
    fs.rmSync(configDir, { recursive: true, force: true });
  }
}

async function testDesktopBrowserResourceControl() {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-desktop-browser-adapter-'));
  const workspace = path.join(configDir, 'workspace');
  fs.mkdirSync(workspace);
  const harness = createAdapterHarness();
  const manager = new BrowserResourceManager({
    configDir,
    desktopBrowserAdapters: harness.registry,
    discoverExecutable: async selection => {
      if (selection.source === 'system') {
        return {
          agentBrowserPath: '/fake/agent-browser',
          kind: 'chrome',
          path: '/fake/chrome',
        };
      }
      return null;
    },
    getBrowserSettings: () => ({
      browserExecutablePath: '/fake/chrome',
      browserSource: 'system',
    }),
    isEnabled: () => true,
  });
  try {
    await manager.init();
    const created = manager.create({
      browserSource: 'desktop',
      desktopAdapterId: harness.adapterId,
      ownerAgentId: 'agent-desktop',
      projectRootId: 'project-desktop',
      url: 'https://initial.example/',
      workspace,
    });
    const running = await manager.start(created.id);
    assert.strictEqual(running.browserSource, 'desktop');
    assert.strictEqual(running.status, 'running');
    assert.match(String(running.tabId || ''), /^native:test-/);

    const nativeViewer = createViewer();
    manager.attachViewer(created.id, nativeViewer);
    assert.deepStrictEqual(
      nativeViewer.messages.map((message: { type?: string }) => message.type),
      ['browser-state', 'browser-error'],
      'A Desktop-leased Browser Viewer must report native-only state without starting a stream',
    );
    harness.registry.publish({
      adapterId: harness.adapterId,
      generation: Number(running.generation),
      kind: 'frame',
      payload: { data: 'not-a-stream-fallback' },
      resourceId: created.id,
      sessionId: String(running.sessionId),
    });
    assert.strictEqual(
      nativeViewer.messages.length,
      2,
      'A Desktop-leased Browser Viewer must not receive a forwarded frame',
    );

    const commandCountBeforeRace = harness.commands.length;
    const queuedAgentAction = manager.action(created.id, { kind: 'click', selector: '#submit' });
    const userTakeover = manager.takeControl(created.id, 'user');
    await adapterError(() => queuedAgentAction, 'BROWSER_STALE_ADMISSION');
    const handedToUser = await userTakeover;
    assert.strictEqual(
      harness.commands.slice(commandCountBeforeRace).some(command => command.operation === 'click'),
      false,
      'A handoff that wins the Session queue race must fence the queued Agent action before it reaches Desktop',
    );
    assert.strictEqual(handedToUser.controlOwner, 'user');
    assert.ok(Number(handedToUser.controlEpoch) > Number(running.controlEpoch));
    synchronousAdapterError(
      () => manager.action(created.id, { kind: 'click', selector: '#submit' }),
      'BROWSER_HUMAN_CONTROL_ACTIVE',
    );

    const secondTab = await manager.createNativeTab(created.id);
    assert.strictEqual(secondTab.browserSource, 'desktop');
    assert.strictEqual(secondTab.controlOwner, 'user');
    assert.strictEqual(secondTab.sessionId, running.sessionId);
    assert.notStrictEqual(secondTab.id, created.id);
    assert.notStrictEqual(secondTab.tabId, running.tabId);
    assert.ok(harness.commands.some(command => command.operation === 'create-tab'));
    assert.ok(
      harness.commands.some(command => (
        command.operation === 'create-tab'
        && String((command.input as Record<string, unknown>)?.pendingResourceId || '').startsWith('popup:')
      )),
      'A newly-created native tab must keep a temporary adapter mapping until its exact Resource is bound',
    );
    assert.ok(harness.commands.some(command => (
      command.operation === 'bind-tab'
      && (command.input as Record<string, unknown>)?.resourceId === secondTab.id
    )));
    await adapterError(
      () => manager.stop(secondTab.id),
      'BROWSER_HUMAN_CONTROL_ACTIVE',
    );
    await manager.stop(secondTab.id, false, 'user');
    const closeTabCommand = harness.commands.at(-1);
    assert.strictEqual(closeTabCommand?.operation, 'close-tab');
    assert.strictEqual(
      closeTabCommand?.resourceId,
      secondTab.id,
      'A native tab close must be routed through the exact Resource lease, not the Session creator.',
    );
    assert.strictEqual(
      (closeTabCommand?.input as Record<string, unknown>)?.activeResourceId,
      secondTab.id,
      'A native tab close must target the exact active Resource binding.',
    );
    const restartedSecondTab = await manager.start(secondTab.id);
    assert.strictEqual(restartedSecondTab.status, 'running');
    assert.ok(
      Number(restartedSecondTab.generation) > Number(secondTab.generation),
      'A stopped native tab must start a new exact Resource generation.',
    );
    assert.notStrictEqual(
      restartedSecondTab.tabId,
      secondTab.tabId,
      'Restarting a stopped native tab must create a fresh native tab rather than reuse a removed lease.',
    );

    const navigated = await manager.nativeUserAction(created.id, {
      kind: 'navigate',
      url: 'https://native.example/path',
    });
    assert.strictEqual(navigated.url, 'https://native.example/path');
    assert.strictEqual(navigated.title, 'Navigated');
    assert.ok(harness.commands.some(command => command.operation === 'navigate'));
    assert.ok(
      harness.commands.some(command => (
        command.operation === 'navigate'
        && (command.input as Record<string, unknown>)?.activeResourceId === created.id
      )),
      'The original native Browser Resource must remain addressable after another tab is bound',
    );

    const returnedToAgent = await manager.takeControl(created.id, 'agent');
    assert.strictEqual(returnedToAgent.controlOwner, 'agent');
    assert.ok(Number(returnedToAgent.controlEpoch) > Number(handedToUser.controlEpoch));

    const selected = await manager.selectNativeTab(created.id);
    assert.strictEqual(selected.id, created.id);
    assert.ok(harness.activeTabId());

    harness.registry.publish({
      adapterId: harness.adapterId,
      generation: Number(returnedToAgent.generation),
      kind: 'tab-exit',
      resourceId: created.id,
      sessionId: returnedToAgent.sessionId,
    });
    await new Promise(resolve => setImmediate(resolve));
    const failed = manager.get(created.id);
    assert.strictEqual(failed.status, 'failed');
    assert.strictEqual(failed.tabId, '');
  } finally {
    await manager.dispose().catch(() => {});
    harness.unregister();
    harness.registry.dispose();
    fs.rmSync(configDir, { recursive: true, force: true });
  }
}

async function testDesktopAgentActionKeepsSelectedUserTabVisible() {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-desktop-browser-visible-tab-'));
  const workspace = path.join(configDir, 'workspace');
  fs.mkdirSync(workspace);
  const harness = createAdapterHarness({ adapterId: 'desktop-visible-tab' });
  const manager = new BrowserResourceManager({
    configDir,
    desktopBrowserAdapters: harness.registry,
    discoverExecutable: async selection => (
      selection.source === 'desktop'
        ? { kind: 'desktop-native', path: '' }
        : null
    ),
    getBrowserSettings: () => ({
      browserExecutablePath: '',
      browserSource: 'desktop',
    }),
    isEnabled: () => true,
  });
  try {
    await manager.init();
    const first = manager.create({
      browserSource: 'desktop',
      desktopAdapterId: harness.adapterId,
      ownerAgentId: 'agent-visible-tab',
      projectRootId: 'project-visible-tab',
      workspace,
    });
    const firstRunning = await manager.start(first.id);
    const second = manager.create({
      browserSource: 'desktop',
      desktopAdapterId: harness.adapterId,
      ownerAgentId: 'agent-visible-tab',
      projectRootId: 'project-visible-tab',
      workspace,
    });
    const secondRunning = await manager.start(second.id);
    const secondStart = harness.commands.find(command => (
      command.operation === 'create-tab' && command.resourceId === secondRunning.id
    ));
    assert.ok(secondStart, 'Starting a second native Resource must create a tab through its new exact lease.');
    assert.strictEqual(
      (secondStart?.input as Record<string, unknown>)?.unboundResource,
      true,
      'An Agent-created native Resource must be admitted before its tab binding exists.',
    );
    assert.strictEqual(
      (secondStart?.input as Record<string, unknown>)?.initialControlEpoch,
      secondRunning.controlEpoch,
      'The unbound native tab must start at the exact persisted Resource control epoch.',
    );
    assert.strictEqual(
      harness.activeTabId(),
      firstRunning.tabId,
      'Creating an Agent-owned background native tab must not replace the existing visible tab.',
    );

    await manager.selectNativeTab(first.id);
    await manager.takeControl(first.id, 'user');
    assert.strictEqual(
      harness.activeTabId(),
      firstRunning.tabId,
      'The user-selected native tab must be the active presentation before Agent background work.',
    );

    const commandStart = harness.commands.length;
    await manager.action(second.id, { kind: 'click', selector: '#next' });
    const backgroundCommands = harness.commands.slice(commandStart);
    assert.ok(
      backgroundCommands.some(command => (
        command.operation === 'click' && command.resourceId === secondRunning.id
      )),
      'The Agent action must still target its exact hidden native Resource.',
    );
    assert.strictEqual(
      backgroundCommands.some(command => command.operation === 'switch-tab'),
      false,
      'An Agent action in another native tab must not replace the user-selected presentation tab.',
    );
    assert.strictEqual(
      harness.activeTabId(),
      firstRunning.tabId,
      'Agent background work must leave the user-selected native tab visible.',
    );
  } finally {
    await manager.dispose().catch(() => {});
    harness.unregister();
    harness.registry.dispose();
    fs.rmSync(configDir, { recursive: true, force: true });
  }
}

async function testDesktopReplacementAndBackendRecovery() {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-desktop-browser-recovery-'));
  const workspace = path.join(configDir, 'workspace');
  fs.mkdirSync(workspace);
  const harness = createAdapterHarness({ adapterId: 'desktop-recovery' });
  const options = {
    configDir,
    desktopBrowserAdapters: harness.registry,
    discoverExecutable: async (selection: { source?: string }) => (
      selection.source === 'desktop'
        ? { kind: 'desktop-native', path: '' }
        : null
    ),
    getBrowserSettings: () => ({
      browserExecutablePath: '',
      browserSource: 'desktop',
    }),
    isEnabled: () => true,
  };
  const manager = new BrowserResourceManager(options);
  const recoveredManager = new BrowserResourceManager(options);
  try {
    await manager.init();
    const created = manager.create({
      browserSource: 'desktop',
      desktopAdapterId: harness.adapterId,
      ownerAgentId: 'agent-native-old',
      projectRootId: 'project-native-recovery',
      workspace,
    });
    const running = await manager.start(created.id);

    await manager.reconcileAgentLifecycle([{
      id: 'agent-native-old',
      lifecycleOperation: { type: 'runtime-switch' },
      status: 'stopped',
    }]);
    assert.strictEqual(
      manager.get(created.id).status,
      'running',
      'A Chat/Terminal runtime switch must retain a native Browser Resource.',
    );

    manager.beginAgentOwnerReplacement('agent-native-old');
    await manager.reconcileAgentLifecycle([]);
    assert.strictEqual(
      manager.get(created.id).status,
      'running',
      'A pending Agent replacement must retain the exact native Browser lease.',
    );
    manager.completeAgentOwnerReplacement('agent-native-old', 'agent-native-new');
    assert.strictEqual(manager.get(created.id).ownerAgentId, 'agent-native-new');
    await manager.action(created.id, { kind: 'click', selector: '#replacement' });
    assert.ok(
      harness.commands.some(command => (
        command.operation === 'click' && command.resourceId === created.id
      )),
      'The replacement Agent must keep the same native Browser tool path.',
    );

    await recoveredManager.init();
    const recovered = recoveredManager.get(created.id);
    assert.strictEqual(recovered.status, 'failed');
    assert.strictEqual(recovered.tabId, '');
    assert.strictEqual(recovered.controlOwner, 'agent');
    assert.ok(
      Number(recovered.controlEpoch) > Number(running.controlEpoch),
      'Backend restart recovery must fence the old native control epoch.',
    );
    assert.match(
      recovered.error,
      /invalidated the previous Desktop native Browser lease/i,
      'Backend recovery must report an explicit lost native lease rather than adopting a stale view.',
    );

    const restarted = await recoveredManager.start(created.id);
    assert.strictEqual(restarted.status, 'running');
    assert.ok(
      Number(restarted.generation) > Number(running.generation),
      'An explicit restart must create a new native Resource generation.',
    );
  } finally {
    await recoveredManager.dispose().catch(() => {});
    await manager.dispose().catch(() => {});
    harness.unregister();
    harness.registry.dispose();
    fs.rmSync(configDir, { recursive: true, force: true });
  }
}

async function testDesktopControlCommitFencing() {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-desktop-browser-control-fence-'));
  const workspace = path.join(configDir, 'workspace');
  fs.mkdirSync(workspace);
  const harness = createAdapterHarness({ adapterId: 'desktop-control-fence' });
  const manager = new BrowserResourceManager({
    configDir,
    desktopBrowserAdapters: harness.registry,
    discoverExecutable: async selection => (
      selection.source === 'desktop'
        ? { kind: 'desktop-native', path: '' }
        : null
    ),
    getBrowserSettings: () => ({
      browserExecutablePath: '',
      browserSource: 'desktop',
    }),
    isEnabled: () => true,
  });
  try {
    await manager.init();
    const created = manager.create({
      browserSource: 'desktop',
      desktopAdapterId: harness.adapterId,
      ownerAgentId: 'agent-control-fence',
      projectRootId: 'project-control-fence',
      workspace,
    });
    const running = await manager.start(created.id);
    const expectedEpoch = Number(running.controlEpoch);
    const commandOrder: string[] = [];
    harness.setOnCommand(command => {
      const input = command.input as Record<string, unknown>;
      const operation = String(command.operation || '');
      if (operation === 'prepare-control') {
        commandOrder.push(operation);
        const current = manager.get(created.id);
        assert.strictEqual(current.controlOwner, 'agent');
        assert.strictEqual(current.controlEpoch, expectedEpoch);
        assert.strictEqual(input.expectedControlOwner, 'agent');
        assert.strictEqual(input.expectedControlEpoch, expectedEpoch);
        assert.strictEqual(input.owner, 'user');
        assert.strictEqual(input.controlEpoch, expectedEpoch + 1);
        return { ok: true };
      }
      if (operation === 'commit-control') {
        commandOrder.push(operation);
        const current = manager.get(created.id);
        assert.strictEqual(
          current.controlOwner,
          'user',
          'The backend must persist user control before Electron removes the native input shield.',
        );
        assert.strictEqual(current.controlEpoch, expectedEpoch + 1);
        return { ok: true };
      }
      throw new Error(`Unexpected Desktop control command: ${operation}`);
    });
    const user = await manager.takeControl(created.id, 'user');
    assert.deepStrictEqual(commandOrder, ['prepare-control', 'commit-control']);
    assert.strictEqual(user.controlOwner, 'user');
    harness.setOnCommand(null);

    harness.setOnCommand(command => {
      const operation = String(command.operation || '');
      if (operation === 'prepare-control') return { ok: true };
      if (operation === 'commit-control') {
        throw Object.assign(
          new Error('Desktop Browser control response was lost'),
          { uncertain: true },
        );
      }
      throw new Error(`Unexpected Desktop control command: ${operation}`);
    });
    await adapterError(
      () => manager.takeControl(created.id, 'agent'),
      'BROWSER_DESKTOP_CONTROL_UNCERTAIN',
    );
    const failed = manager.get(created.id);
    assert.strictEqual(failed.status, 'failed');
    assert.match(
      failed.error,
      /control handoff outcome is uncertain/i,
      'An uncertain native control commit must remain explicit rather than re-enabling an Agent action.',
    );
    synchronousAdapterError(
      () => manager.action(created.id, { kind: 'click', selector: '#resume' }),
      'BROWSER_NOT_RUNNING',
    );
  } finally {
    await manager.dispose().catch(() => {});
    harness.unregister();
    harness.registry.dispose();
    fs.rmSync(configDir, { recursive: true, force: true });
  }
}

async function testDesktopNativeProfileCleanup() {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-desktop-browser-profile-cleanup-'));
  const workspace = path.join(configDir, 'workspace');
  fs.mkdirSync(workspace);
  const harness = createAdapterHarness({ adapterId: 'desktop-profile-cleanup' });
  const manager = new BrowserResourceManager({
    configDir,
    desktopBrowserAdapters: harness.registry,
    discoverExecutable: async selection => (
      selection.source === 'desktop'
        ? { kind: 'desktop-native', path: '' }
        : null
    ),
    getBrowserSettings: () => ({
      browserExecutablePath: '',
      browserSource: 'desktop',
    }),
    isEnabled: () => true,
  });
  const createAndStart = async (ownerAgentId: string, projectRootId: string) => {
    const created = manager.create({
      browserSource: 'desktop',
      desktopAdapterId: harness.adapterId,
      ownerAgentId,
      projectRootId,
      workspace,
    });
    return manager.start(created.id);
  };
  try {
    await manager.init();
    const first = await createAndStart('agent-profile-cleanup', 'project-profile-cleanup');
    const second = await createAndStart('agent-profile-cleanup', 'project-profile-cleanup');
    assert.strictEqual(
      first.sessionId,
      second.sessionId,
      'Two tabs in the same exact Desktop adapter must share the native session being cleaned.',
    );

    const cleanupStart = harness.commands.length;
    await manager.delete(second.id);
    assert.strictEqual(
      harness.commands.slice(cleanupStart).filter(command => (
        command.operation === 'clear-session-data'
      )).length,
      0,
      'Deleting a non-final native tab must retain its shared Electron profile.',
    );
    assert.strictEqual(manager.get(first.id).status, 'running');

    await manager.delete(first.id);
    const firstCleanup = harness.commands.slice(cleanupStart).filter(command => (
      command.operation === 'clear-session-data'
    ));
    assert.strictEqual(
      firstCleanup.length,
      1,
      'Deleting the final native tab must clear its exact Electron profile once.',
    );
    assert.strictEqual(firstCleanup[0]?.adapterId, harness.adapterId);
    assert.strictEqual(firstCleanup[0]?.resourceId, first.id);
    assert.strictEqual(firstCleanup[0]?.sessionId, first.sessionId);

    const retained = await createAndStart('agent-profile-retained', 'project-profile-retained');
    harness.setOnCommand(command => {
      if (command.operation === 'clear-session-data') {
        throw Object.assign(
          new Error('Desktop Browser profile cleanup response was lost'),
          { uncertain: true },
        );
      }
      return { ok: true };
    });
    const cleanupCountBeforeFailure = harness.commands.filter(command => (
      command.operation === 'clear-session-data'
    )).length;
    await adapterError(
      () => manager.delete(retained.id),
      'BROWSER_DESKTOP_PROFILE_CLEANUP_UNCERTAIN',
    );
    const failedCleanup = manager.get(retained.id);
    assert.strictEqual(
      failedCleanup.status,
      'stopped',
      'An uncertain profile cleanup must retain a stopped Resource for explicit reconciliation.',
    );
    assert.match(failedCleanup.error, /profile cleanup outcome is uncertain/i);
    assert.strictEqual(
      harness.commands.filter(command => command.operation === 'clear-session-data').length,
      cleanupCountBeforeFailure + 1,
      'An uncertain profile cleanup must not retry automatically.',
    );

    harness.setOnCommand(null);
    await manager.delete(retained.id);
    assert.throws(
      () => manager.get(retained.id),
      (error: Error & { code?: string }) => error.code === 'BROWSER_NOT_FOUND',
      'A user-initiated retry may delete the retained stopped Resource after an explicit cleanup succeeds.',
    );

    const parallelFirst = await createAndStart('agent-profile-parallel', 'project-profile-parallel');
    const parallelSecond = await createAndStart('agent-profile-parallel', 'project-profile-parallel');
    const cleanupCountBeforeParallel = harness.commands.filter(command => (
      command.operation === 'clear-session-data'
    )).length;
    await Promise.all([
      manager.delete(parallelFirst.id),
      manager.delete(parallelSecond.id),
    ]);
    assert.strictEqual(
      harness.commands.filter(command => command.operation === 'clear-session-data').length,
      cleanupCountBeforeParallel + 1,
      'Concurrent deletes of one native session must serialize final profile cleanup exactly once.',
    );
  } finally {
    harness.setOnCommand(null);
    await manager.dispose().catch(() => {});
    harness.unregister();
    harness.registry.dispose();
    fs.rmSync(configDir, { recursive: true, force: true });
  }
}

async function testDesktopAdapterExactIsolationAndDisconnectRecovery() {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-desktop-browser-isolation-'));
  const workspace = path.join(configDir, 'workspace');
  fs.mkdirSync(workspace);
  const registry = new DesktopBrowserAdapterRegistry({ commandTimeoutMs: 1_000 });
  const first = createAdapterHarness({ adapterId: 'desktop-isolation-a', registry });
  const second = createAdapterHarness({ adapterId: 'desktop-isolation-b', registry });
  const manager = new BrowserResourceManager({
    configDir,
    desktopBrowserAdapters: registry,
    discoverExecutable: async selection => (
      selection.source === 'desktop'
        ? { kind: 'desktop-native', path: '' }
        : null
    ),
    getBrowserSettings: () => ({
      browserExecutablePath: '',
      browserSource: 'desktop',
    }),
    isEnabled: () => true,
  });
  try {
    await manager.init();
    const firstResource = manager.create({
      browserSource: 'desktop',
      desktopAdapterId: first.adapterId,
      ownerAgentId: 'agent-isolation',
      projectRootId: 'project-isolation',
      workspace,
    });
    const firstRunning = await manager.start(firstResource.id);
    const secondOnFirstAdapter = manager.create({
      browserSource: 'desktop',
      desktopAdapterId: first.adapterId,
      ownerAgentId: 'agent-isolation',
      projectRootId: 'project-isolation',
      workspace,
    });
    const secondRunning = await manager.start(secondOnFirstAdapter.id);
    assert.strictEqual(
      secondRunning.sessionId,
      firstRunning.sessionId,
      'Resources assigned to the same exact Desktop adapter may share their Browser Session',
    );

    const isolatedResource = manager.create({
      browserSource: 'desktop',
      desktopAdapterId: second.adapterId,
      ownerAgentId: 'agent-isolation',
      projectRootId: 'project-isolation',
      workspace,
    });
    const isolatedRunning = await manager.start(isolatedResource.id);
    assert.notStrictEqual(
      isolatedRunning.sessionId,
      firstRunning.sessionId,
      'A Browser Resource must not reuse a Session hosted by another exact Desktop adapter',
    );
    assert(first.commands.some(command => command.operation === 'create-tab'));
    assert(second.commands.some(command => command.operation === 'start'));

    registry.publish({
      adapterId: second.adapterId,
      generation: Number(firstRunning.generation),
      kind: 'tab-exit',
      resourceId: firstRunning.id,
      sessionId: String(firstRunning.sessionId),
    });
    await new Promise(resolve => setImmediate(resolve));
    assert.strictEqual(
      manager.get(firstRunning.id).status,
      'running',
      'An event from another Desktop adapter must not mutate the exact Resource lease',
    );

    first.unregister();
    await waitFor(
      () => manager.get(firstRunning.id).status === 'failed'
        && manager.get(secondRunning.id).status === 'failed',
      'Desktop adapter loss did not fail only its exact native Browser Resources',
    );
    assert.strictEqual(
      manager.get(isolatedRunning.id).status,
      'running',
      'Desktop adapter loss must not stop a Browser Resource isolated on another Desktop adapter',
    );
  } finally {
    await manager.dispose().catch(() => {});
    first.unregister();
    second.unregister();
    registry.dispose();
    fs.rmSync(configDir, { recursive: true, force: true });
  }
}

async function testDesktopAdapterConnectionReplacementFailsOldLease() {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-desktop-browser-adapter-replacement-'));
  const workspace = path.join(configDir, 'workspace');
  fs.mkdirSync(workspace);
  const first = createAdapterHarness({ adapterId: 'desktop-replaced-connection' });
  const manager = new BrowserResourceManager({
    configDir,
    desktopBrowserAdapters: first.registry,
    discoverExecutable: async selection => (
      selection.source === 'desktop'
        ? { kind: 'desktop-native', path: '' }
        : null
    ),
    getBrowserSettings: () => ({
      browserExecutablePath: '',
      browserSource: 'desktop',
    }),
    isEnabled: () => true,
  });
  let replacement: ReturnType<typeof createAdapterHarness> | null = null;
  try {
    await manager.init();
    const created = manager.create({
      browserSource: 'desktop',
      desktopAdapterId: first.adapterId,
      ownerAgentId: 'agent-replaced-connection',
      projectRootId: 'project-replaced-connection',
      workspace,
    });
    const running = await manager.start(created.id);
    replacement = createAdapterHarness({
      adapterId: first.adapterId,
      registry: first.registry,
    });
    await waitFor(
      () => manager.get(created.id).status === 'failed',
      'A replacement Desktop adapter connection did not invalidate the old native lease.',
    );
    assert.match(
      manager.get(created.id).error,
      /adapter was replaced/i,
      'Adapter connection replacement must remain an explicit native lease failure.',
    );
    const restarted = await manager.start(created.id);
    assert.strictEqual(restarted.status, 'running');
    assert.ok(
      Number(restarted.generation) > Number(running.generation),
      'Restarting after adapter replacement must create a fresh Resource generation.',
    );
    assert.ok(
      replacement.commands.some(command => command.operation === 'start'),
      'The replacement connection must own the explicit fresh native start.',
    );
  } finally {
    await manager.dispose().catch(() => {});
    replacement?.unregister();
    first.unregister();
    first.registry.dispose();
    fs.rmSync(configDir, { recursive: true, force: true });
  }
}

async function testConcurrentDesktopStartsDoNotReuseInitializingSession() {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-desktop-browser-concurrent-start-'));
  const workspace = path.join(configDir, 'workspace');
  fs.mkdirSync(workspace);
  const harness = createAdapterHarness({ startDelayMs: 100 });
  const manager = new BrowserResourceManager({
    configDir,
    desktopBrowserAdapters: harness.registry,
    discoverExecutable: async selection => (
      selection.source === 'desktop'
        ? { kind: 'desktop-native', path: '' }
        : null
    ),
    getBrowserSettings: () => ({
      browserExecutablePath: '',
      browserSource: 'desktop',
    }),
    isEnabled: () => true,
  });
  try {
    await manager.init();
    const create = (name: string) => manager.create({
      browserSource: 'desktop',
      desktopAdapterId: harness.adapterId,
      name,
      ownerAgentId: 'agent-concurrent-start',
      projectRootId: 'project-concurrent-start',
      workspace,
    });
    const first = create('Concurrent first');
    const second = create('Concurrent second');
    const firstStart = manager.start(first.id);
    await waitFor(
      () => harness.commands.filter(command => command.operation === 'start').length === 1,
      'The first Desktop Resource did not begin native startup.',
    );
    const secondStart = manager.start(second.id);
    await waitFor(
      () => harness.commands.filter(command => (
        command.operation === 'start' || command.operation === 'create-tab'
      )).length >= 2,
      'The second Desktop Resource did not begin native startup.',
    );
    const startupCommands = harness.commands.filter(command => (
      command.operation === 'start' || command.operation === 'create-tab'
    ));
    assert.deepStrictEqual(
      startupCommands.map(command => command.operation),
      ['start', 'start'],
      'A concurrent Resource must not reuse a Desktop session before its initial native lease commits.',
    );
    const [firstRunning, secondRunning] = await Promise.all([firstStart, secondStart]);
    assert.strictEqual(firstRunning.status, 'running');
    assert.strictEqual(secondRunning.status, 'running');
    assert.notStrictEqual(
      firstRunning.sessionId,
      secondRunning.sessionId,
      'Concurrent Desktop starts must own independent initializing sessions.',
    );
  } finally {
    await manager.dispose().catch(() => {});
    harness.unregister();
    harness.registry.dispose();
    fs.rmSync(configDir, { recursive: true, force: true });
  }
}

Promise.resolve()
  .then(testDesktopAdapterRegistry)
  .then(testDesktopAdapterTimeoutIsUncertain)
  .then(testDesktopNativeOperationTimeoutFailsClosed)
  .then(testDesktopAdapterDisconnectIsUncertain)
  .then(testDesktopBrowserResourceControl)
  .then(testDesktopAgentActionKeepsSelectedUserTabVisible)
  .then(testDesktopReplacementAndBackendRecovery)
  .then(testDesktopControlCommitFencing)
  .then(testDesktopNativeProfileCleanup)
  .then(testDesktopAdapterExactIsolationAndDisconnectRecovery)
  .then(testDesktopAdapterConnectionReplacementFailsOldLease)
  .then(testConcurrentDesktopStartsDoNotReuseInitializingSession)
  .catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
