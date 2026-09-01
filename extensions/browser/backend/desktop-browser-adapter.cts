const crypto = require('crypto');
import { EventEmitter } from 'events';

const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
const MAX_ADAPTER_ID_LENGTH = 160;
const MAX_COMMAND_ID_LENGTH = 160;
const MAX_ERROR_LENGTH = 2_000;

type UnknownRecord = Record<string, unknown>;

interface DesktopBrowserAdapterSocket {
  connectionId?: string;
  readyState: number;
  send(message: string): void;
}

interface DesktopBrowserCommand {
  adapterId: string;
  generation: number;
  input?: UnknownRecord;
  operation: string;
  requestId: string;
  resourceId: string;
  sessionId: string;
}

interface DesktopBrowserAdapterEvent {
  adapterId: string;
  generation: number;
  kind: string;
  payload?: UnknownRecord;
  resourceId: string;
  sessionId: string;
}

interface PendingCommand {
  adapterId: string;
  generation: number;
  reject(error: Error): void;
  resolve(value: unknown): void;
  resourceId: string;
  sessionId: string;
  socket: DesktopBrowserAdapterSocket;
  timeout: NodeJS.Timeout;
}

interface DesktopBrowserAdapterRegistryOptions {
  commandTimeoutMs?: number;
  openState?: number;
  scheduleTimeout?: typeof setTimeout;
  cancelTimeout?: typeof clearTimeout;
}

type DesktopBrowserAdapterConnection = {
  adapterId: string;
  socket: DesktopBrowserAdapterSocket;
};

function recordValue(value: unknown): UnknownRecord {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : {};
}

function text(value: unknown, maximum = MAX_ERROR_LENGTH): string {
  return String(value || '').trim().slice(0, maximum);
}

function browserError(
  message: string,
  code = 'BROWSER_DESKTOP_ADAPTER_UNAVAILABLE',
  status = 503,
  uncertain = false,
) {
  return Object.assign(new Error(message), { code, status, uncertain });
}

function validAdapterId(value: unknown): value is string {
  const id = text(value, MAX_ADAPTER_ID_LENGTH);
  return Boolean(id) && id.length <= MAX_ADAPTER_ID_LENGTH;
}

function validCommandId(value: unknown): value is string {
  const id = text(value, MAX_COMMAND_ID_LENGTH);
  return Boolean(id) && id.length <= MAX_COMMAND_ID_LENGTH;
}

/**
 * Exact Desktop adapter ownership lives at this boundary. Browser Resource
 * ownership remains in BrowserResourceManager; this registry only routes a
 * generation-fenced request to the Electron adapter that was selected for it.
 */
class DesktopBrowserAdapterRegistry extends EventEmitter {
  readonly openState: number;
  readonly commandTimeoutMs: number;
  readonly scheduleTimeout: typeof setTimeout;
  readonly cancelTimeout: typeof clearTimeout;
  readonly adapters = new Map<string, DesktopBrowserAdapterConnection>();
  readonly pending = new Map<string, PendingCommand>();
  readonly resourceControls = new Map<string, {
    adapterId: string;
    generation: number;
    owner: 'agent' | 'user';
  }>();

  constructor(options: DesktopBrowserAdapterRegistryOptions = {}) {
    super();
    this.openState = options.openState ?? 1;
    this.commandTimeoutMs = Math.max(1_000, Math.min(
      Number(options.commandTimeoutMs) || DEFAULT_COMMAND_TIMEOUT_MS,
      120_000,
    ));
    this.scheduleTimeout = options.scheduleTimeout || setTimeout;
    this.cancelTimeout = options.cancelTimeout || clearTimeout;
  }

  register(adapterId: unknown, socket: DesktopBrowserAdapterSocket): () => void {
    if (!validAdapterId(adapterId)) {
      throw browserError('Desktop Browser adapter identity is invalid', 'BROWSER_DESKTOP_ADAPTER_INVALID', 400);
    }
    if (!socket || socket.readyState !== this.openState) {
      throw browserError('Desktop Browser adapter is not connected', 'BROWSER_DESKTOP_ADAPTER_UNAVAILABLE');
    }
    const id = adapterId;
    const previous = this.adapters.get(id);
    if (previous && previous.socket !== socket) {
      this.adapters.delete(id);
      this.failAdapter(id, 'Desktop Browser adapter was replaced');
      for (const [resourceId, control] of this.resourceControls) {
        if (control.adapterId === id) this.resourceControls.delete(resourceId);
      }
      this.emit('unavailable', {
        adapterId: id,
        message: 'Desktop Browser adapter was replaced',
      });
    }
    this.adapters.set(id, { adapterId: id, socket });
    this.emit('available', { adapterId: id });
    return () => {
      const current = this.adapters.get(id);
      if (!current || current.socket !== socket) return;
      this.adapters.delete(id);
      this.failAdapter(id, 'Desktop Browser adapter disconnected');
      for (const [resourceId, control] of this.resourceControls) {
        if (control.adapterId === id) this.resourceControls.delete(resourceId);
      }
      this.emit('unavailable', {
        adapterId: id,
        message: 'Desktop Browser adapter disconnected',
      });
    };
  }

  ids(): string[] {
    return [...this.adapters.values()]
      .filter(connection => connection.socket.readyState === this.openState)
      .map(connection => connection.adapterId)
      .sort();
  }

  has(adapterId: unknown): boolean {
    return validAdapterId(adapterId)
      && this.adapters.get(adapterId)?.socket.readyState === this.openState;
  }

  select(requestedAdapterId: unknown): string {
    const requested = text(requestedAdapterId, MAX_ADAPTER_ID_LENGTH);
    if (requested) {
      if (!this.has(requested)) {
        throw browserError(
          'The selected Farming Desktop Browser adapter is unavailable',
          'BROWSER_DESKTOP_ADAPTER_UNAVAILABLE',
        );
      }
      return requested;
    }
    const ids = this.ids();
    if (ids.length === 1) return ids[0]!;
    if (ids.length === 0) {
      throw browserError(
        'Open Farming Desktop to use its native Browser view',
        'BROWSER_DESKTOP_ADAPTER_UNAVAILABLE',
      );
    }
    throw browserError(
      'More than one Farming Desktop Browser adapter is available; select the Desktop window explicitly',
      'BROWSER_DESKTOP_ADAPTER_AMBIGUOUS',
      409,
    );
  }

  setControl(
    adapterId: unknown,
    resourceId: unknown,
    generation: unknown,
    owner: unknown,
  ): void {
    if (!validAdapterId(adapterId) || !this.has(adapterId)) return;
    const id = text(resourceId, 256);
    const normalizedGeneration = Number(generation);
    if (!id || !Number.isSafeInteger(normalizedGeneration) || normalizedGeneration < 0) return;
    if (owner !== 'agent' && owner !== 'user') return;
    this.resourceControls.set(id, {
      adapterId,
      generation: normalizedGeneration,
      owner,
    });
    this.emit('control', {
      adapterId,
      generation: normalizedGeneration,
      owner,
      resourceId: id,
    });
  }

  clearControl(resourceId: unknown, generation?: unknown): void {
    const id = text(resourceId, 256);
    const current = this.resourceControls.get(id);
    if (!current) return;
    if (generation !== undefined && Number(generation) !== current.generation) return;
    this.resourceControls.delete(id);
  }

  controlOwner(resourceId: unknown, generation: unknown): 'agent' | 'user' {
    const current = this.resourceControls.get(text(resourceId, 256));
    return current && current.generation === Number(generation) ? current.owner : 'agent';
  }

  assertAgentControl(resourceId: unknown, generation: unknown): void {
    if (this.controlOwner(resourceId, generation) !== 'user') return;
    throw browserError(
      'The user has control of this Browser tab. Return control to the Agent before retrying.',
      'BROWSER_HUMAN_CONTROL_ACTIVE',
      409,
    );
  }

  invoke(command: Omit<DesktopBrowserCommand, 'requestId'> & { requestId?: string }): Promise<unknown> {
    const adapterId = this.select(command.adapterId);
    const resourceId = text(command.resourceId, 256);
    const sessionId = text(command.sessionId, 256);
    const operation = text(command.operation, 128);
    const generation = Number(command.generation);
    if (!resourceId || !sessionId || !operation || !Number.isSafeInteger(generation) || generation < 0) {
      return Promise.reject(browserError('Desktop Browser command is invalid', 'BROWSER_DESKTOP_COMMAND_INVALID', 400));
    }
    const connection = this.adapters.get(adapterId);
    if (!connection || connection.socket.readyState !== this.openState) {
      return Promise.reject(browserError(
        'The selected Farming Desktop Browser adapter is unavailable',
        'BROWSER_DESKTOP_ADAPTER_UNAVAILABLE',
      ));
    }
    const requestId = validCommandId(command.requestId)
      ? command.requestId
      : `desktop_browser_${crypto.randomUUID()}`;
    const message: DesktopBrowserCommand = {
      adapterId,
      generation,
      input: recordValue(command.input),
      operation,
      requestId,
      resourceId,
      sessionId,
    };
    return new Promise((resolve, reject) => {
      const timeout = this.scheduleTimeout(() => {
        const pending = this.pending.get(requestId);
        if (!pending) return;
        this.pending.delete(requestId);
        reject(browserError(
          'Desktop Browser command timed out; its outcome is uncertain. Refresh Browser state before retrying.',
          'BROWSER_DESKTOP_COMMAND_TIMEOUT',
          504,
          true,
        ));
      }, this.commandTimeoutMs);
      this.pending.set(requestId, {
        adapterId,
        generation,
        reject,
        resolve,
        resourceId,
        sessionId,
        socket: connection.socket,
        timeout,
      });
      try {
        connection.socket.send(JSON.stringify({
          type: 'desktop-browser-command',
          command: message,
        }));
      } catch (error) {
        this.settle({
          adapterId,
          code: 'BROWSER_DESKTOP_ADAPTER_UNAVAILABLE',
          error: error instanceof Error ? error.message : String(error),
          generation,
          ok: false,
          requestId,
          resourceId,
          sessionId,
          status: 503,
          uncertain: true,
        }, connection.socket);
      }
    });
  }

  settle(value: unknown, sourceSocket?: DesktopBrowserAdapterSocket): void {
    const message = recordValue(value);
    const requestId = text(message.requestId, MAX_COMMAND_ID_LENGTH);
    const pending = this.pending.get(requestId);
    if (!pending) return;
    if (!validAdapterId(message.adapterId) || message.adapterId !== pending.adapterId) return;
    const connection = this.adapters.get(pending.adapterId);
    if (
      !connection
      || connection.socket !== pending.socket
      || (sourceSocket && sourceSocket !== pending.socket)
      || text(message.resourceId, 256) !== pending.resourceId
      || text(message.sessionId, 256) !== pending.sessionId
      || Number(message.generation) !== pending.generation
    ) return;
    this.pending.delete(requestId);
    this.cancelTimeout(pending.timeout);
    if (message.ok === true) {
      pending.resolve(message.result);
      return;
    }
    pending.reject(browserError(
      text(message.error) || 'Desktop Browser command failed',
      text(message.code, 128) || 'BROWSER_DESKTOP_COMMAND_FAILED',
      Number(message.status) || 500,
      message.uncertain === true,
    ));
  }

  publish(value: unknown): void {
    const event = recordValue(value);
    if (!validAdapterId(event.adapterId) || !this.has(event.adapterId)) return;
    const resourceId = text(event.resourceId, 256);
    const sessionId = text(event.sessionId, 256);
    const generation = Number(event.generation);
    const kind = text(event.kind, 128);
    if (!resourceId || !sessionId || !kind || !Number.isSafeInteger(generation) || generation < 0) return;
    if (kind === 'control') {
      this.setControl(event.adapterId, resourceId, generation, recordValue(event.payload).owner);
      return;
    }
    this.emit('event', {
      adapterId: event.adapterId,
      generation,
      kind,
      payload: recordValue(event.payload),
      resourceId,
      sessionId,
    } satisfies DesktopBrowserAdapterEvent);
  }

  dispose(): void {
    for (const adapterId of this.adapters.keys()) this.failAdapter(adapterId, 'Desktop Browser adapter is stopping');
    this.adapters.clear();
    this.resourceControls.clear();
  }

  private failAdapter(adapterId: string, message: string): void {
    for (const [requestId, pending] of this.pending) {
      if (pending.adapterId !== adapterId) continue;
      this.pending.delete(requestId);
      this.cancelTimeout(pending.timeout);
      pending.reject(browserError(
        `${message}; its command outcome is uncertain. Refresh Browser state before retrying.`,
        'BROWSER_DESKTOP_ADAPTER_UNAVAILABLE',
        503,
        true,
      ));
    }
  }
}

interface DesktopBrowserRuntimeOptions {
  adapterId: string;
  controlEpoch: number;
  generation: number;
  registry: DesktopBrowserAdapterRegistry;
  resourceId: string;
  sessionId: string;
}

type BrowserTab = {
  active?: boolean;
  controlEpoch?: number;
  controlOwner?: 'agent' | 'user';
  tabId: string;
  title?: string;
  type?: string;
  url?: string;
};

function browserTabs(value: unknown): BrowserTab[] {
  const input = recordValue(value);
  const candidates = Array.isArray(input.tabs) ? input.tabs : Array.isArray(value) ? value : [];
  return candidates.flatMap(candidate => {
    const tab = recordValue(candidate);
    const tabId = text(tab.tabId || tab.id, 256);
    return tabId ? [{
      active: tab.active === true,
      controlEpoch: Number.isSafeInteger(Number(tab.controlEpoch)) && Number(tab.controlEpoch) >= 0
        ? Number(tab.controlEpoch)
        : 0,
      controlOwner: tab.controlOwner === 'user' ? 'user' : 'agent',
      tabId,
      title: text(tab.title, 512),
      type: text(tab.type, 64) || 'page',
      url: text(tab.url, 8_192) || 'about:blank',
    }] : [];
  });
}

/**
 * BrowserResourceManager sees this as a regular Browser runtime. Electron
 * remains the view owner; every mutation crosses the registry with the exact
 * resource generation and gets an explicit bounded result.
 */
class DesktopBrowserRuntime extends EventEmitter {
  readonly adapterId: string;
  readonly generation: number;
  readonly registry: DesktopBrowserAdapterRegistry;
  readonly resourceId: string;
  readonly sessionId: string;
  activeResourceId: string;
  private readonly resourceGenerations = new Map<string, number>();
  private readonly resourceControlEpochs = new Map<string, number>();
  private readonly boundResourceIds = new Set<string>();
  activeTabId = '';
  streamTabId = '';
  externalCdpUrl = '';
  ownedTabIds = new Set<string>();
  private readonly onEvent: (event: DesktopBrowserAdapterEvent) => void;
  private readonly onAdapterUnavailable: (event: { adapterId: string; message?: string }) => void;
  private adapterAvailable = true;
  private closed = false;

  constructor(options: DesktopBrowserRuntimeOptions) {
    super();
    this.adapterId = options.adapterId;
    this.generation = options.generation;
    this.registry = options.registry;
    this.resourceId = options.resourceId;
    this.sessionId = options.sessionId;
    this.activeResourceId = options.resourceId;
    this.resourceGenerations.set(options.resourceId, options.generation);
    this.resourceControlEpochs.set(options.resourceId, options.controlEpoch);
    this.onEvent = event => {
      if (
        event.adapterId !== this.adapterId
        || event.sessionId !== this.sessionId
      ) return;
      const resourceGeneration = this.resourceGenerations.get(event.resourceId);
      if (resourceGeneration === undefined || resourceGeneration !== event.generation) return;
      if (event.kind === 'tabs') {
        const tabs = browserTabs(event.payload);
        const active = tabs.find(tab => tab.active) || tabs[0];
        if (active) {
          this.activeTabId = active.tabId;
          this.streamTabId = active.tabId;
        }
        this.emit('tabs', {
          newTabIds: Array.isArray(event.payload?.newTabIds) ? event.payload.newTabIds : [],
          popupAdmitted: event.payload?.popupAdmitted === true,
          tabs,
        });
        return;
      }
      if (event.kind === 'metadata') {
        this.emit('metadata', {
          generation: event.generation,
          resourceId: event.resourceId,
          tabId: text(event.payload?.tabId, 256),
          title: text(event.payload?.title, 512),
          url: text(event.payload?.url, 8_192),
        });
        return;
      }
      if (event.kind === 'loading') {
        this.emit('loading', {
          generation: event.generation,
          loading: event.payload?.loading === true,
          resourceId: event.resourceId,
          tabId: text(event.payload?.tabId, 256),
        });
        return;
      }
      if (event.kind === 'frame') {
        this.emit('frame', event.payload);
        return;
      }
      if (event.kind === 'error') {
        this.emit('error', {
          generation: event.generation,
          message: text(event.payload?.message) || 'Desktop Browser failed',
          resourceId: event.resourceId,
          tabId: text(event.payload?.tabId, 256),
        });
        return;
      }
      if (event.kind === 'tab-exit') {
        this.boundResourceIds.delete(event.resourceId);
        this.registry.clearControl(event.resourceId, event.generation);
        this.resourceGenerations.delete(event.resourceId);
        this.resourceControlEpochs.delete(event.resourceId);
        this.emit('tab-exit', {
          generation: event.generation,
          message: text(event.payload?.message) || 'Desktop Browser tab closed',
          resourceId: event.resourceId,
          tabId: text(event.payload?.tabId, 256),
        });
      }
    };
    this.registry.on('event', this.onEvent);
    this.onAdapterUnavailable = event => {
      if (event.adapterId !== this.adapterId || this.closed || !this.adapterAvailable) return;
      this.adapterAvailable = false;
      this.emit('exit', text(event.message) || 'Desktop Browser adapter disconnected');
    };
    this.registry.on('unavailable', this.onAdapterUnavailable);
  }

  setActiveResourceId(resourceId: string, generation?: number, controlEpoch?: number): void {
    if (!text(resourceId, 256)) return;
    this.activeResourceId = resourceId;
    if (Number.isSafeInteger(generation) && Number(generation) >= 0) {
      this.resourceGenerations.set(resourceId, Number(generation));
    }
    if (Number.isSafeInteger(controlEpoch) && Number(controlEpoch) >= 0) {
      this.resourceControlEpochs.set(resourceId, Number(controlEpoch));
    }
  }

  async bindResourceTab(
    resourceId: string,
    tabId: string,
    generation?: number,
    controlEpoch?: number,
    controlOwner: 'agent' | 'user' = 'agent',
  ): Promise<unknown> {
    const resourceGeneration = Number.isSafeInteger(generation) && Number(generation) >= 0
      ? Number(generation)
      : this.resourceGenerations.get(resourceId);
    if (resourceGeneration === undefined) {
      return Promise.reject(browserError(
        'Desktop Browser Resource generation is invalid',
        'BROWSER_STALE_GENERATION',
        409,
      ));
    }
    this.resourceGenerations.set(resourceId, resourceGeneration);
    const resourceControlEpoch = Number.isSafeInteger(controlEpoch) && Number(controlEpoch) >= 0
      ? Number(controlEpoch)
      : this.resourceControlEpochs.get(resourceId);
    if (resourceControlEpoch === undefined) {
      return Promise.reject(browserError(
        'Desktop Browser Resource control epoch is invalid',
        'BROWSER_STALE_CONTROL',
        409,
      ));
    }
    this.resourceControlEpochs.set(resourceId, resourceControlEpoch);
    const result = await this.registry.invoke({
      adapterId: this.adapterId,
      generation: resourceGeneration,
      input: {
        activeResourceId: resourceId,
        controlEpoch: resourceControlEpoch,
        controlOwner,
        resourceId,
        tabId,
      },
      operation: 'bind-tab',
      resourceId,
      sessionId: this.sessionId,
    });
    this.boundResourceIds.add(resourceId);
    return result;
  }

  async start(url: string): Promise<{ title: string; url: string }> {
    const result = recordValue(await this.invoke('start', {
      controlEpoch: this.activeControlEpoch(),
      url,
    }, false));
    this.applyTabs(result);
    return {
      title: text(result.title, 512),
      url: text(result.url, 8_192) || url,
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    try {
      if (this.adapterAvailable) await this.invoke('close-session', {}, false);
    } finally {
      this.closed = true;
      this.boundResourceIds.clear();
      for (const [resourceId, generation] of this.resourceGenerations) {
        this.registry.clearControl(resourceId, generation);
      }
      this.registry.off('event', this.onEvent);
      this.registry.off('unavailable', this.onAdapterUnavailable);
    }
  }

  async closeTab(tabId: string): Promise<BrowserTab[]> {
    const resourceId = this.activeResourceId;
    const generation = this.resourceGenerations.get(resourceId);
    const result = await this.invoke('close-tab', { tabId }, false);
    this.boundResourceIds.delete(resourceId);
    this.registry.clearControl(resourceId, generation);
    this.resourceGenerations.delete(resourceId);
    this.resourceControlEpochs.delete(resourceId);
    return this.applyTabs(result);
  }

  async createTab(
    url = 'about:blank',
    label = '',
    caller: 'agent' | 'user' = 'agent',
  ): Promise<BrowserTab> {
    const unboundResource = !this.boundResourceIds.has(this.activeResourceId);
    const result = recordValue(await this.invoke('create-tab', {
      initialControlEpoch: unboundResource ? this.activeControlEpoch() : 0,
      label,
      pendingResourceId: `popup:${crypto.randomUUID()}`,
      ...(unboundResource ? { unboundResource: true } : {}),
      url,
    }, unboundResource ? false : caller === 'agent', unboundResource ? undefined : caller));
    const tabs = this.applyTabs(result);
    const tabId = text(result.tabId || result.id, 256);
    const tab = tabs.find(candidate => candidate.tabId === tabId)
      || tabs.find(candidate => candidate.active)
      || tabs.at(-1);
    if (!tab) throw browserError('Desktop Browser did not create a tab', 'BROWSER_DESKTOP_COMMAND_FAILED');
    this.ownedTabIds.add(tab.tabId);
    return tab;
  }

  async listTabs(caller: 'agent' | 'user' = 'agent'): Promise<BrowserTab[]> {
    return this.applyTabs(await this.invoke(
      'list-tabs',
      {},
      caller === 'agent',
      caller,
    ));
  }

  async switchTab(tabId: string): Promise<BrowserTab> {
    return this.switchTabWithControl(tabId, true);
  }

  async switchTabForUser(tabId: string): Promise<BrowserTab> {
    return this.switchTabWithControl(tabId, false);
  }

  async prepareControl(input: {
    controlEpoch: number;
    expectedControlEpoch: number;
    expectedControlOwner: 'agent' | 'user';
    owner: 'agent' | 'user';
  }): Promise<unknown> {
    return this.invoke('prepare-control', input, false);
  }

  async commitControl(owner: 'agent' | 'user', controlEpoch: number): Promise<unknown> {
    const result = await this.invoke('commit-control', { controlEpoch, owner }, false);
    this.resourceControlEpochs.set(this.activeResourceId, controlEpoch);
    return result;
  }

  cancelControl(owner: 'agent' | 'user', controlEpoch: number): Promise<unknown> {
    return this.invoke('cancel-control', { controlEpoch, owner }, false);
  }

  userAction(operation: string, input: UnknownRecord): Promise<unknown> {
    return this.invoke(operation, input, false, 'user');
  }

  private async switchTabWithControl(tabId: string, requiresAgentControl: boolean): Promise<BrowserTab> {
    const result = await this.invoke('switch-tab', { tabId }, requiresAgentControl);
    const tabs = this.applyTabs(result);
    const tab = tabs.find(candidate => candidate.tabId === tabId);
    if (!tab) throw browserError('Desktop Browser tab is unavailable', 'BROWSER_TAB_UNAVAILABLE', 409);
    this.activeTabId = tabId;
    this.streamTabId = tabId;
    return tab;
  }

  navigate(url: string) { return this.metadataCommand('navigate', { url }); }
  goBack() { return this.metadataCommand('back', {}); }
  goForward() { return this.metadataCommand('forward', {}); }
  reload() { return this.metadataCommand('reload', {}); }
  stopLoading() { return this.metadataCommand('stop-loading', {}); }
  snapshot() { return this.invoke('snapshot', {}); }
  screenshot() { return this.invoke('screenshot', {}); }
  click(input: UnknownRecord) { return this.invoke('click', input); }
  elementAction(kind: string, input: UnknownRecord) { return this.invoke('element-action', { ...input, kind }); }
  type(input: UnknownRecord, fill: boolean) { return this.invoke(fill ? 'fill' : 'type', input); }
  keyboard(input: UnknownRecord) { return this.invoke('keyboard', input); }
  press(input: UnknownRecord) { return this.invoke('press', input); }
  select(input: UnknownRecord) { return this.invoke('select', input); }
  drag(input: UnknownRecord) { return this.invoke('drag', input); }
  waitFor(input: UnknownRecord) { return this.invoke('wait', input); }
  get(input: UnknownRecord) { return this.invoke('get', input); }
  is(input: UnknownRecord) { return this.invoke('is', input); }
  find(input: UnknownRecord) { return this.invoke('find', input); }
  evaluate(input: UnknownRecord) { return this.invoke('evaluate', input); }
  debugLog(kind: string, input: UnknownRecord) { return this.invoke('debug-log', { ...input, kind }); }
  network(input: UnknownRecord) { return this.invoke('network', input); }
  cookies(input: UnknownRecord) { return this.invoke('cookies', input); }
  storage(input: UnknownRecord) { return this.invoke('storage', input); }
  frame(input: UnknownRecord) { return this.invoke('frame', input); }
  dialog(input: UnknownRecord) { return this.invoke('dialog', input); }
  upload(input: UnknownRecord) { return this.invoke('upload', input); }
  download(input: UnknownRecord) { return this.invoke('download', input); }
  async wheel(input: UnknownRecord): Promise<void> {
    await this.invoke('wheel', input);
  }
  async pointer(input: UnknownRecord): Promise<void> {
    await this.invoke('pointer', input);
  }
  resize(input: UnknownRecord) { return this.invoke('resize', input, false); }
  async insertText(textValue: string): Promise<void> {
    await this.invoke('insert-text', { text: textValue });
  }

  private async metadataCommand(operation: string, input: UnknownRecord) {
    const result = recordValue(await this.invoke(operation, input));
    const metadata = {
      generation: this.resourceGenerations.get(this.activeResourceId),
      resourceId: this.activeResourceId,
      title: text(result.title, 512),
      url: text(result.url, 8_192) || 'about:blank',
    };
    this.emit('metadata', metadata);
    return metadata;
  }

  private activeControlEpoch(): number {
    return this.resourceControlEpochs.get(this.activeResourceId) ?? 0;
  }

  private async invoke(
    operation: string,
    input: UnknownRecord,
    requiresAgentControl = true,
    controlOwner?: 'agent' | 'user',
  ): Promise<unknown> {
    if (this.closed || !this.adapterAvailable) {
      throw browserError('Desktop Browser runtime is closed', 'BROWSER_DESKTOP_ADAPTER_UNAVAILABLE');
    }
    if (requiresAgentControl) {
      this.registry.assertAgentControl(
        this.activeResourceId,
        this.resourceGenerations.get(this.activeResourceId) ?? this.generation,
      );
    }
    const caller = controlOwner || (requiresAgentControl ? 'agent' : null);
    return this.registry.invoke({
      adapterId: this.adapterId,
      generation: this.resourceGenerations.get(this.activeResourceId) ?? this.generation,
      input: {
        ...input,
        activeResourceId: this.activeResourceId,
        ...(caller ? {
          controlEpoch: this.activeControlEpoch(),
          controlOwner: caller,
        } : {}),
      },
      operation,
      resourceId: this.activeResourceId,
      sessionId: this.sessionId,
    });
  }

  private applyTabs(value: unknown): BrowserTab[] {
    const tabs = browserTabs(value);
    const active = tabs.find(tab => tab.active) || tabs[0];
    if (active) {
      this.activeTabId = active.tabId;
      this.streamTabId = active.tabId;
    }
    return tabs;
  }
}

export {
  DesktopBrowserAdapterRegistry,
  DesktopBrowserRuntime,
};

export type {
  DesktopBrowserAdapterEvent,
  DesktopBrowserAdapterSocket,
};
