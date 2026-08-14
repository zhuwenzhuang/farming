const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
import * as storageLayout from '../../../backend/storage-layout.cjs';
import { canonicalConfigDir, configInstanceFingerprint } from '../../../backend/config-instance.cjs';
import {
  matchingProcessIdentity,
  readServerProcessIdentity,
  type ServerProcessIdentity,
} from '../../../backend/server-process-identity.cjs';
import {
  MAX_IMAGE_ARTIFACT_BYTES,
  writeWorkspaceImageArtifact,
} from '../../../backend/workspace-artifacts.cjs';
import {
  BrowserResourceStore,
  RESOURCE_ID_RE,
  type BrowserResource,
  type BrowserResourceCreateInput,
  type BrowserResourcePatch,
  type BrowserProcessIdentity,
  type RunningBrowserTabInput,
} from './browser-resource-store.cjs';
import {
  AgentBrowserRuntime,
  type RuntimeOptions,
} from './agent-browser-runtime.cjs';
import {
  discoverBrowserExecutables,
  discoverBrowserRuntime,
  type BrowserCandidate,
  type BrowserDiscoveryOptions,
  type BrowserExecutable,
} from './executable-discovery.cjs';

const MAX_VIEWER_BUFFER_BYTES = 2 * 1024 * 1024;
const VIEWER_RESIZE_SETTLE_MS = 80;
const VIEWER_METRICS_REPORT_MS = 5_000;
const BROWSER_RECOVERY_TIMEOUT_MS = 5_000;
const BROWSER_RECOVERY_POLL_MS = 100;
const MAX_UPLOAD_FILES = 20;
const INACTIVE_AGENT_STATUSES = new Set(['dead', 'error', 'exited', 'stopped']);

type BrowserResourceStatus = 'stopped' | 'starting' | 'running' | 'stopping' | 'failed';
type BrowserResourceOwnerType = 'agent' | 'project';
type BrowserTab = {
  active?: boolean;
  tabId: string;
  title?: string;
  type?: string;
  url?: string;
};
type BrowserTabsEvent = {
  newTabIds?: unknown[];
  popupAdmitted?: boolean;
  tabs?: BrowserTab[];
};
type BrowserMetadata = { title?: string; url?: string };
type BrowserCapability = BrowserExecutable;
type BrowserSelection = {
  executablePath: string;
  source: string;
};
type CapabilityRefreshOptions = {
  reuseVerified?: boolean;
};
type BrowserSettings = {
  browserExecutablePath?: string;
  browserSource?: string;
};
const BROWSER_SOURCES = new Set(['extension', 'isolated', 'system']);
type BrowserOption = BrowserCandidate;
type BrowserMessage = Record<string, unknown> & {
  claim?: boolean;
  deviceScaleFactor?: number;
  generation?: number;
  height?: number;
  text?: string;
  type?: string;
  width?: number;
};
type ViewerGeometry = {
  deviceScaleFactor: number;
  generation: number;
  height: number;
  type: 'resize';
  width: number;
};
type BrowserViewport = Pick<ViewerGeometry, 'deviceScaleFactor' | 'height' | 'width'>;
type PendingViewerInput = {
  binding: BrowserBinding;
  enqueuedAt: number;
  message: BrowserMessage;
  rejecters: Array<(error: unknown) => void>;
  resolvers: Array<(value: unknown) => void>;
  viewer: BrowserViewer;
};
interface BrowserViewer {
  bufferedAmount?: number;
  readyState: number;
  send(message: string): void;
  on(event: string, listener: (value: Buffer | string) => void): this;
  off(event: string, listener: (value: Buffer | string) => void): this;
  once(event: string, listener: () => void): this;
}
interface BrowserViewerOptions {
  readOnly?: boolean;
}
interface BrowserRuntime {
  activeTabId: string;
  externalCdpUrl?: string;
  ownedTabIds: Set<string>;
  streamTabId: string;
  start(url: string): Promise<BrowserMetadata>;
  close(): Promise<void>;
  closeTab(tabId: string): Promise<unknown>;
  createTab(url: string, label?: string): Promise<BrowserTab>;
  listTabs(): Promise<BrowserTab[]>;
  switchTab(tabId: string): Promise<BrowserTab>;
  navigate(url: string): Promise<BrowserMetadata>;
  goBack(): Promise<BrowserMetadata>;
  goForward(): Promise<BrowserMetadata>;
  reload(): Promise<BrowserMetadata>;
  snapshot(): Promise<unknown>;
  screenshot(): Promise<unknown>;
  click(input: BrowserMessage): Promise<unknown>;
  elementAction(kind: string, input: BrowserMessage): Promise<unknown>;
  type(input: BrowserMessage, fill: boolean): Promise<unknown>;
  keyboard(input: BrowserMessage): Promise<unknown>;
  press(input: BrowserMessage): Promise<unknown>;
  select(input: BrowserMessage): Promise<unknown>;
  drag(input: BrowserMessage): Promise<unknown>;
  waitFor(input: BrowserMessage): Promise<unknown>;
  get(input: BrowserMessage): Promise<unknown>;
  is(input: BrowserMessage): Promise<unknown>;
  find(input: BrowserMessage): Promise<unknown>;
  evaluate(input: BrowserMessage): Promise<unknown>;
  debugLog(kind: string, input: BrowserMessage): Promise<unknown>;
  network(input: BrowserMessage): Promise<unknown>;
  cookies(input: BrowserMessage): Promise<unknown>;
  storage(input: BrowserMessage): Promise<unknown>;
  frame(input: BrowserMessage): Promise<unknown>;
  dialog(input: BrowserMessage): Promise<unknown>;
  upload(input: BrowserMessage): Promise<unknown>;
  download(input: BrowserMessage): Promise<unknown>;
  wheel(input: BrowserMessage): Promise<void>;
  pointer(input: BrowserMessage): Promise<void>;
  resize(input: BrowserViewport): Promise<unknown>;
  insertText(text: string): Promise<void>;
  on<Value>(event: string, listener: (value: Value) => void): this;
  once<Value>(event: string, listener: (value: Value) => void): this;
}
type BrowserBinding = {
  admittedTabsRevision: number;
  generation: number;
  id: string;
  latestFrame: BrowserMessage | null;
  pendingViewerResize: { geometry: ViewerGeometry; viewer: BrowserViewer } | null;
  session: BrowserSession;
  tabId: string;
  viewerGeometries: Map<BrowserViewer, ViewerGeometry>;
  viewerResizeTimer: NodeJS.Timeout | null;
  viewerViewportOwner: BrowserViewer | null;
  viewers: Set<BrowserViewer>;
};
type BrowserSession = {
  actionChain: Promise<unknown>;
  activeResourceId: string;
  bindings: Map<string, BrowserBinding>;
  browserKind: string;
  closing: boolean;
  generation: number;
  id: string;
  initializing: boolean;
  isolatedLeaseKey: string;
  processOwnerResourceId: string;
  projectRootId: string;
  ownerKey: string;
  pendingViewerInputs: PendingViewerInput[];
  reconcilingTabs: Promise<unknown>;
  runtime: BrowserRuntime;
  tabsRevision: number;
  viewerInputDrainScheduled: boolean;
};
interface BrowserResourceStoreLike {
  revision: number;
  init(): void;
  list(): BrowserResource[];
  get(id: string): BrowserResource | null;
  create(input: BrowserResourceCreateInput): BrowserResource;
  createRunningTab(input: RunningBrowserTabInput): BrowserResource;
  update(id: string, patch: BrowserResourcePatch): BrowserResource;
  delete(id: string): boolean | void;
}
type IsolatedBrowserProvider = {
  acquire(owner: {
    ownerAgentId: string;
    ownerKey: string;
    projectRootId: string;
    workspace: string;
  }): Promise<{ cdpUrl: string; leaseKey: string }>;
  capability(refresh?: boolean): Promise<Record<string, unknown>>;
  deleteOwner(ownerKey: string): Promise<void>;
  prepare(): Promise<unknown>;
  release(leaseKey: string): Promise<void>;
};
type BrowserExtensionRelayProvider = {
  capability(): Record<string, unknown>;
  cdpUrl(): string;
  pairingString(relayUrl: string): string;
  prepare(): Record<string, unknown>;
  tabs(): Array<{
    active: boolean;
    id: number;
    title: string;
    url: string;
  }>;
};
type BrowserManagerOptions = Record<string, unknown> & {
  configDir: string;
  store?: BrowserResourceStoreLike;
  isolatedBrowserProvider?: IsolatedBrowserProvider;
  browserExtensionRelay?: BrowserExtensionRelayProvider;
  discoverExecutable?: (
    selection: BrowserDiscoveryOptions,
  ) => Promise<BrowserCapability | null>;
  discoverBrowserOptions?: () => BrowserOption[];
  getBrowserSettings?: () => BrowserSettings;
  saveBrowserSelection?: (selection: Pick<BrowserSelection, 'executablePath' | 'source'>) => void;
  createRuntime?: (input: RuntimeOptions) => BrowserRuntime;
  recoverRuntime?: (input: RuntimeOptions) => Promise<unknown>;
  isEnabled?: () => boolean;
  readProcessIdentity?: (
    pid: number,
  ) => ServerProcessIdentity | null | Promise<ServerProcessIdentity | null>;
  killProcessGroup?: (processGroupId: number, signal: NodeJS.Signals) => void;
  wait?: (durationMs: number) => Promise<void>;
  scheduleTimeout?: typeof setTimeout;
  cancelTimeout?: typeof clearTimeout;
};
type AgentLifecycleState = {
  archived?: boolean;
  id: string;
  lifecycleOperation?: { type?: string } | null;
  status?: string;
};
type BrowserError = Error & { cause?: unknown; code: string; status: number };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string {
  if (!error || typeof error !== 'object' || !('code' in error)) return '';
  return typeof error.code === 'string' ? error.code : '';
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function publicResource(resource: BrowserResource, collectionRevision: number) {
  return {
    id: resource.id,
    ownerType: resource.ownerType,
    ownerAgentId: resource.ownerAgentId,
    projectRootId: resource.projectRootId,
    workspace: resource.workspace,
    name: resource.name,
    status: resource.status,
    generation: resource.generation,
    revision: resource.revision,
    collectionRevision,
    url: resource.url,
    title: resource.title,
    browserKind: resource.browserKind,
    browserSource: resource.browserSource,
    existingTabId: resource.existingTabId,
    error: resource.error,
    createdAt: resource.createdAt,
    updatedAt: resource.updatedAt,
  };
}

function browserError(message: string, status = 400, code = 'BROWSER_INVALID_REQUEST'): BrowserError {
  const error = new Error(message) as BrowserError;
  error.status = status;
  error.code = code;
  return error;
}

function browserOwnerKey(resource: Pick<BrowserResource, 'ownerAgentId' | 'ownerType' | 'projectRootId'>): string {
  return resource.ownerType === 'agent'
    ? `agent:${resource.ownerAgentId}`
    : `project:${resource.projectRootId}`;
}

function normalizeUrl(value: unknown): string {
  const input = String(value || '').trim();
  if (!input) return 'about:blank';
  if (input === 'about:blank') return input;
  let url = input;
  if (!/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(input)) {
    const authority = input.split(/[/?#]/, 1)[0];
    const hostname = authority.replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase();
    const explicitPort = authority.match(/:(\d+)$/)?.[1] || '';
    const isIpLiteral = /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname) || authority.startsWith('[');
    const localHost = hostname === 'localhost'
      || hostname.endsWith('.localhost')
      || !hostname.includes('.')
      || isIpLiteral;
    url = `${localHost || (explicitPort && explicitPort !== '443') ? 'http' : 'https'}://${input}`;
  }
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw browserError('Browser navigation supports only http, https, and about:blank URLs');
    }
    return parsed.href;
  } catch (error) {
    if (error && typeof error === 'object' && 'status' in error) throw error;
    throw browserError('Invalid Browser URL');
  }
}

function normalizeExistingTabId(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null;
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw browserError('Chrome tab id must be a positive integer');
  }
  return id;
}

function tabResourceName(tab: BrowserTab): string {
  const title = String(tab?.title || '').trim();
  if (title) return title.slice(0, 120);
  try {
    return new URL(String(tab?.url || '')).hostname.slice(0, 120) || 'Browser';
  } catch {
    return 'Browser';
  }
}

function pathInside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function resolveWorkspaceInputFile(resource: BrowserResource, value: unknown): string {
  const workspace = fs.realpathSync(resource.workspace);
  const requested = path.resolve(resource.workspace, String(value || ''));
  let resolved;
  try {
    resolved = fs.realpathSync(requested);
  } catch {
    throw browserError(`Upload file does not exist: ${value}`);
  }
  if (!pathInside(workspace, resolved)) {
    throw browserError('Browser uploads must stay inside the Browser Project workspace');
  }
  if (!fs.statSync(resolved).isFile()) {
    throw browserError(`Browser upload path is not a file: ${value}`);
  }
  return resolved;
}

function resolveWorkspaceOutputFile(resource: BrowserResource, value: unknown): string {
  const requestedValue = String(value || '').trim();
  if (!requestedValue) throw browserError('Download output path is required');
  const workspace = fs.realpathSync(resource.workspace);
  const requested = path.resolve(resource.workspace, requestedValue);
  if (!pathInside(path.resolve(resource.workspace), requested)) {
    throw browserError('Browser downloads must stay inside the Browser Project workspace');
  }
  let parent;
  try {
    parent = fs.realpathSync(path.dirname(requested));
  } catch {
    throw browserError('Browser download parent directory does not exist');
  }
  if (!pathInside(workspace, parent)) {
    throw browserError('Browser downloads must stay inside the Browser Project workspace');
  }
  if (fs.existsSync(requested)) {
    throw browserError('Browser download target already exists');
  }
  return requested;
}

class BrowserResourceManager extends EventEmitter {
  readonly configDir: string;
  readonly store: BrowserResourceStoreLike;
  readonly isolatedBrowserProvider: IsolatedBrowserProvider | null;
  readonly browserExtensionRelay: BrowserExtensionRelayProvider | null;
  readonly discoverExecutable: (
    selection: BrowserDiscoveryOptions,
  ) => Promise<BrowserCapability | null>;
  readonly discoverBrowserOptions: () => BrowserOption[];
  readonly getBrowserSettings: () => BrowserSettings;
  readonly saveBrowserSelection: (
    selection: Pick<BrowserSelection, 'executablePath' | 'source'>,
  ) => void;
  readonly createRuntime: (input: RuntimeOptions) => BrowserRuntime;
  readonly recoverRuntime: (input: RuntimeOptions) => Promise<unknown>;
  readonly isEnabled: () => boolean;
  readonly readProcessIdentity: (
    pid: number,
  ) => ServerProcessIdentity | null | Promise<ServerProcessIdentity | null>;
  readonly killProcessGroup: (processGroupId: number, signal: NodeJS.Signals) => void;
  readonly wait: (durationMs: number) => Promise<void>;
  readonly scheduleTimeout: typeof setTimeout;
  readonly cancelTimeout: typeof clearTimeout;
  readonly runtimes = new Map<string, BrowserBinding>();
  readonly sessions = new Map<string, BrowserSession>();
  readonly operations = new Map<string, Promise<unknown>>();
  readonly stopAdmissions = new Map<string, number>();
  readonly existingTabReservations = new Map<number, string>();
  disposed = false;
  runtimeCapability: BrowserCapability | null = null;
  browserOptions: BrowserOption[] = [];
  isolatedBrowserCapability: Record<string, unknown> | null = null;
  capabilityProbeSignature = '';
  capabilityRefreshPromise: Promise<BrowserCapability | null> | null = null;
  viewerInputMetrics = {
    admitted: 0,
    coalescedMoves: 0,
    coalescedWheels: 0,
    executed: 0,
    maxPending: 0,
    maxWaitMs: 0,
    reportStartedAt: Date.now(),
  };

  constructor(options: BrowserManagerOptions) {
    super();
    this.configDir = canonicalConfigDir(options.configDir);
    this.store = options.store || new BrowserResourceStore(this.configDir);
    this.isolatedBrowserProvider = options.isolatedBrowserProvider || null;
    this.browserExtensionRelay = options.browserExtensionRelay || null;
    this.discoverExecutable = options.discoverExecutable || (selection => discoverBrowserRuntime({
      ...options,
      ...selection,
    }));
    this.discoverBrowserOptions = options.discoverBrowserOptions
      || (options.discoverExecutable
        ? () => []
        : () => discoverBrowserExecutables());
    this.getBrowserSettings = typeof options.getBrowserSettings === 'function'
      ? options.getBrowserSettings
      : () => ({ browserSource: 'system', browserExecutablePath: '' });
    this.saveBrowserSelection = typeof options.saveBrowserSelection === 'function'
      ? options.saveBrowserSelection
      : () => {};
    this.createRuntime = options.createRuntime || (input => new AgentBrowserRuntime(input));
    this.recoverRuntime = options.recoverRuntime || (input => AgentBrowserRuntime.recover(input));
    this.isEnabled = typeof options.isEnabled === 'function' ? options.isEnabled : () => true;
    this.readProcessIdentity = options.readProcessIdentity || readServerProcessIdentity;
    this.killProcessGroup = options.killProcessGroup || ((processGroupId, signal) => process.kill(-processGroupId, signal));
    this.wait = options.wait || (durationMs => new Promise(resolve => setTimeout(resolve, durationMs)));
    this.scheduleTimeout = options.scheduleTimeout || setTimeout;
    this.cancelTimeout = options.cancelTimeout || clearTimeout;
  }

  async init(): Promise<void> {
    this.store.init();
    await this.refreshCapability();
    const interrupted = this.store.list().filter(resource =>
      Boolean(resource.processIdentity)
      || ['running', 'starting', 'stopping'].includes(resource.status)
    );
    const groups = new Map<string, BrowserResource[]>();
    for (const resource of interrupted) {
      const key = resource.runtimeKind === 'agent-browser'
        ? (resource.sessionId || resource.id)
        : resource.id;
      const group = groups.get(key) || [];
      group.push(resource);
      groups.set(key, group);
    }
    await Promise.all([...groups.values()].map(resources => {
      const owner = resources.find(resource => resource.processIdentity) || resources[0];
      if (!owner) return Promise.resolve();
      return this.recoverInterruptedRuntime(owner, resources);
    }));
  }

  async recoverInterruptedRuntime(
    resource: BrowserResource,
    relatedResources: BrowserResource[] = [resource],
  ): Promise<void> {
    if (resource.runtimeKind === 'agent-browser') {
      const capability = this.runtimeCapability?.agentBrowserPath
        ? this.runtimeCapability
        : await this.discoverExecutable({ source: 'isolated' });
      let runtimeError = null;
      if (!capability || capability.error || !capability.agentBrowserPath) {
        runtimeError = new Error(
          capability?.error
          || 'The exact agent-browser runtime required to clean up this Browser is unavailable',
        );
      } else {
        try {
          await this.recoverRuntime({
            id: resource.sessionId || resource.id,
            generation: resource.sessionGeneration || resource.generation,
            processIdentity: resource.processIdentity,
            configDir: this.configDir,
            profileDir: storageLayout.browserProfileDir(
              this.configDir,
              resource.sessionId || resource.id,
            ),
            agentBrowserPath: capability.agentBrowserPath,
            readProcessIdentity: this.readProcessIdentity,
            wait: this.wait,
          });
        } catch (error) {
          runtimeError = error;
        }
      }
      for (const related of relatedResources) {
        this.store.update(related.id, {
          status: 'failed',
          error: runtimeError
            ? `agent-browser Session cleanup failed: ${errorMessage(runtimeError)}`
            : 'Farming restarted and cleaned up the previous Browser runtime',
          ...(!runtimeError ? { processIdentity: null } : {}),
          tabId: '',
        });
      }
      return;
    }

    // Migration cleanup for Browser rows created by Farming's former raw-CDP runtime.
    const expected = resource.processIdentity;
    if (!expected) {
      this.store.update(resource.id, {
        status: 'failed',
        error: resource.browserKind === 'isolated-computer'
          ? 'Farming restarted and stopped the isolated Browser runtime'
          : 'Farming restarted before the Browser runtime identity was committed',
        processIdentity: null,
      });
      return;
    }
    const current = await this.readProcessIdentity(expected.pid);
    if (!matchingProcessIdentity(expected, current)) {
      this.store.update(resource.id, {
        status: 'failed',
        error: 'Farming restarted after the previous Browser runtime exited',
        processIdentity: null,
      });
      return;
    }
    if (expected.processGroupId !== expected.pid) {
      this.store.update(resource.id, {
        status: 'failed',
        error: `Previous Browser process ${expected.pid} has an unsafe process-group identity; stop it manually`,
      });
      return;
    }
    try {
      this.killProcessGroup(expected.processGroupId, 'SIGKILL');
    } catch (error) {
      if (errorCode(error) !== 'ESRCH') {
        const permission = errorCode(error) === 'EPERM' || errorCode(error) === 'EACCES';
        this.store.update(resource.id, {
          status: 'failed',
          error: permission
            ? `Farming cannot clean up previous Browser process ${expected.pid} because it lacks permission`
            : `Farming could not clean up previous Browser process ${expected.pid}: ${errorMessage(error)}`,
        });
        return;
      }
    }
    const startedAt = Date.now();
    while (matchingProcessIdentity(expected, await this.readProcessIdentity(expected.pid))) {
      if (Date.now() - startedAt >= BROWSER_RECOVERY_TIMEOUT_MS) {
        this.store.update(resource.id, {
          status: 'failed',
          error: `Previous Browser process ${expected.pid} did not exit after SIGKILL`,
        });
        return;
      }
      await this.wait(BROWSER_RECOVERY_POLL_MS);
    }
    this.store.update(resource.id, {
      status: 'failed',
      error: 'Farming restarted and cleaned up the previous Browser runtime',
      processIdentity: null,
    });
  }

  capability() {
    const executable = this.runtimeCapability;
    const runnable = executable && !executable.error;
    const enabled = this.isEnabled() === true;
    const selection = this.browserSelection();
    return {
      enabled,
      available: enabled && Boolean(runnable),
      browser: runnable ? { kind: executable.kind, path: executable.path } : null,
      selection,
      options: this.browserOptions.map(option => ({ kind: option.kind, path: option.path })),
      ...(this.isolatedBrowserCapability ? { isolated: this.isolatedBrowserCapability } : {}),
      ...(this.browserExtensionRelay ? { extension: this.browserExtensionRelay.capability() } : {}),
      message: !enabled
        ? 'Browser extension is disabled'
        : (executable?.error || (runnable
            ? ''
            : 'Choose a local Chromium browser or prepare the isolated Browser runtime')),
    };
  }

  async sourceCapabilities(): Promise<Array<Record<string, unknown>>> {
    const settings = this.getBrowserSettings();
    const systemOptions = this.discoverBrowserOptions();
    const systemPath = String(settings.browserExecutablePath || systemOptions[0]?.path || '');
    const isolatedCapability = this.isolatedBrowserProvider
      ? await this.isolatedBrowserProvider.capability()
      : null;
    const selections: BrowserSelection[] = [
      { source: 'system', executablePath: systemPath },
      { source: 'extension', executablePath: '' },
      { source: 'isolated', executablePath: '' },
    ];
    const probes = await Promise.all(selections.map(async selection => {
      const probe = await this.probeCapability(selection, systemOptions, isolatedCapability);
      const runtime = probe.runtimeCapability;
      return {
        source: selection.source,
        available: Boolean(runtime && !runtime.error),
        kind: String(runtime?.kind || ''),
        path: String(runtime?.path || ''),
        message: String(runtime?.error || ''),
      };
    }));
    return probes;
  }

  browserSelection(settings: BrowserSettings = this.getBrowserSettings()): BrowserSelection {
    const source = settings?.browserSource;
    return {
      source: source && BROWSER_SOURCES.has(source) ? source : 'system',
      executablePath: String(settings?.browserExecutablePath || ''),
    };
  }

  browserCapabilitySignature(
    selection: BrowserSelection,
    browserOptions: BrowserOption[],
    isolatedBrowserCapability: Record<string, unknown> | null = this.isolatedBrowserCapability,
  ): string {
    const executablePaths = [...new Set([
      ...browserOptions.map(option => option.path),
      selection.executablePath,
    ].filter(Boolean))].sort();
    return JSON.stringify({
      selection,
      options: browserOptions.map(option => ({ kind: option.kind, path: option.path })),
      executables: executablePaths.map(executablePath => {
        try {
          const stat = fs.statSync(executablePath);
          return { path: executablePath, size: stat.size, mtimeMs: stat.mtimeMs };
        } catch {
          return { path: executablePath, missing: true };
        }
      }),
      isolatedBrowserCapability,
      extension: this.browserExtensionRelay?.capability() || null,
    });
  }

  async probeCapability(
    selection: BrowserSelection = this.browserSelection(),
    discoveredOptions?: BrowserOption[],
    discoveredIsolatedCapability?: Record<string, unknown> | null,
  ): Promise<{
    browserOptions: BrowserOption[];
    isolatedBrowserCapability: Record<string, unknown> | null;
    runtimeCapability: BrowserCapability | null;
  }> {
    const browserOptions = discoveredOptions || this.discoverBrowserOptions();
    const selectedOption = browserOptions.find(option => option.path === selection.executablePath);
    const isolatedBrowserCapability = discoveredIsolatedCapability !== undefined
      ? discoveredIsolatedCapability
      : this.isolatedBrowserProvider
        ? await this.isolatedBrowserProvider.capability()
        : null;
    let runtimeCapability = await this.discoverExecutable({
      source: selection.source,
      executablePath: selection.executablePath,
      executableKind: selectedOption?.kind,
    });
    if (selection.source === 'extension') {
      const extension = this.browserExtensionRelay?.capability() || {};
      const cdpUrl = this.browserExtensionRelay?.cdpUrl() || '';
      if (extension.connected === true && cdpUrl) {
        const discovered = await this.discoverExecutable({
          source: 'external-cdp',
          externalCdpUrl: cdpUrl,
        });
        runtimeCapability = discovered ? { ...discovered, kind: 'chrome-extension' } : null;
      } else {
        runtimeCapability = {
          kind: 'chrome-extension',
          path: '',
          error: 'Install and pair Farming Browser Connector, then keep Chrome running',
        };
      }
    }
    if (
      selection.source === 'isolated'
      && isolatedBrowserCapability?.available === true
    ) {
      runtimeCapability = await this.discoverExecutable({ source: 'isolated' });
    }
    if (selection.source === 'isolated' && isolatedBrowserCapability?.available !== true) {
      runtimeCapability = {
        kind: 'isolated-computer',
        path: '',
        error: isolatedBrowserCapability?.dockerAvailable === true
          ? 'Prepare the isolated Browser runtime before selecting it'
          : 'Docker is required for the isolated Browser',
      };
    }
    return { browserOptions, isolatedBrowserCapability, runtimeCapability };
  }

  async refreshCapability(
    selection?: BrowserSelection,
    options: CapabilityRefreshOptions = {},
  ): Promise<BrowserCapability | null> {
    if (options.reuseVerified && this.capabilityRefreshPromise) {
      return this.capabilityRefreshPromise;
    }
    const refresh = async () => {
      let desiredSelection = selection || this.browserSelection();
      const browserOptions = this.discoverBrowserOptions();
      if (!selection && desiredSelection.source === 'system' && !desiredSelection.executablePath) {
        const defaultBrowser = browserOptions[0];
        if (defaultBrowser) {
          this.saveBrowserSelection({
            source: 'system',
            executablePath: defaultBrowser.path,
          });
          desiredSelection = {
            ...desiredSelection,
            executablePath: defaultBrowser.path,
          };
        }
      }
      const cachedIsolatedCapability = options.reuseVerified && this.isolatedBrowserProvider
        ? await this.isolatedBrowserProvider.capability()
        : undefined;
      const signature = this.browserCapabilitySignature(
        desiredSelection,
        browserOptions,
        cachedIsolatedCapability,
      );
      if (options.reuseVerified && signature === this.capabilityProbeSignature) {
        this.browserOptions = browserOptions;
        if (cachedIsolatedCapability !== undefined) {
          this.isolatedBrowserCapability = cachedIsolatedCapability;
        }
        return this.runtimeCapability;
      }
      const probe = await this.probeCapability(
        desiredSelection,
        browserOptions,
        cachedIsolatedCapability,
      );
      this.browserOptions = browserOptions;
      this.isolatedBrowserCapability = probe.isolatedBrowserCapability;
      this.runtimeCapability = probe.runtimeCapability;
      this.capabilityProbeSignature = this.browserCapabilitySignature(
        desiredSelection,
        probe.browserOptions,
        probe.isolatedBrowserCapability,
      );
      return this.runtimeCapability;
    };
    if (!options.reuseVerified) return refresh();
    this.capabilityRefreshPromise = refresh().finally(() => {
      this.capabilityRefreshPromise = null;
    });
    return this.capabilityRefreshPromise;
  }

  async prepareIsolatedBrowser(): Promise<unknown> {
    if (!this.isolatedBrowserProvider) {
      throw browserError('The isolated Browser runtime is unavailable', 503, 'ISOLATED_BROWSER_UNAVAILABLE');
    }
    await this.isolatedBrowserProvider.prepare();
    await this.refreshCapability();
    return this.capability();
  }

  prepareBrowserExtension(): Record<string, unknown> {
    if (!this.browserExtensionRelay) {
      throw browserError('Farming Browser Connector is unavailable', 503, 'BROWSER_EXTENSION_UNAVAILABLE');
    }
    return this.browserExtensionRelay.prepare();
  }

  browserExtensionStatus(relayUrl?: string) {
    if (!this.browserExtensionRelay) {
      throw browserError('Farming Browser Connector is unavailable', 503, 'BROWSER_EXTENSION_UNAVAILABLE');
    }
    return {
      ...this.browserExtensionRelay.capability(),
      ...(relayUrl ? { pairingString: this.browserExtensionRelay.pairingString(relayUrl) } : {}),
    };
  }

  extensionTabs() {
    this.requireEnabled();
    if (!this.browserExtensionRelay?.capability().connected) {
      throw browserError(
        'Farming Browser Connector is not connected',
        503,
        'BROWSER_EXTENSION_NOT_CONNECTED',
      );
    }
    const reservations = new Map(
      this.store.list()
        .filter(resource => (
          resource.existingTabId !== null
          && ['starting', 'running'].includes(resource.status)
        ))
        .map(resource => [resource.existingTabId as number, resource.id]),
    );
    return this.browserExtensionRelay.tabs().map(tab => ({
      active: tab.active,
      id: tab.id,
      managed: reservations.has(tab.id),
      title: tab.title,
      url: tab.url,
    }));
  }

  extensionTab(existingTabId: number) {
    const tab = this.browserExtensionRelay?.tabs().find(candidate => candidate.id === existingTabId);
    if (!tab) {
      throw browserError(
        'The selected Chrome page is no longer available',
        404,
        'BROWSER_EXTENSION_TAB_NOT_FOUND',
      );
    }
    return tab;
  }

  matchExtensionRuntimeTab(tabs: BrowserTab[], existingTabId: number): BrowserTab {
    const extensionTabs = this.browserExtensionRelay?.tabs() || [];
    const selected = extensionTabs.find(tab => tab.id === existingTabId);
    if (!selected) {
      throw browserError(
        'The selected Chrome page is no longer available',
        404,
        'BROWSER_EXTENSION_TAB_NOT_FOUND',
      );
    }
    const samePage = (tab: Pick<BrowserTab, 'title' | 'url'>) => (
      tab.url === selected.url && tab.title === selected.title
    );
    const matchingRuntimeTabs = tabs.filter(samePage);
    if (matchingRuntimeTabs.length === 1) return matchingRuntimeTabs[0];
    if (matchingRuntimeTabs.length > 1) {
      const matchingExtensionTabs = extensionTabs.filter(samePage);
      const occurrence = matchingExtensionTabs.findIndex(tab => tab.id === existingTabId);
      const matched = matchingRuntimeTabs[occurrence];
      if (matched) return matched;
    }
    throw browserError(
      'The selected Chrome page changed while Farming was connecting',
      409,
      'BROWSER_EXTENSION_TAB_CHANGED',
    );
  }

  list() {
    this.requireEnabled();
    return this.store.list().map(resource => publicResource(resource, this.store.revision));
  }

  snapshot() {
    this.requireEnabled();
    return this.stateSnapshot();
  }

  stateSnapshot() {
    return {
      collectionRevision: this.store.revision,
      resources: this.store.list().map(resource => publicResource(resource, this.store.revision)),
    };
  }

  get(id: string) {
    this.requireEnabled();
    return publicResource(this.requireStored(id), this.store.revision);
  }

  create(input: Record<string, unknown>) {
    this.requireEnabled();
    if (this.disposed) throw browserError('Browser manager is stopping', 503, 'BROWSER_MANAGER_STOPPING');
    const requestedSource = String(input.browserSource || '').trim();
    if (requestedSource && !BROWSER_SOURCES.has(requestedSource)) {
      throw browserError(
        `Unsupported Browser source: ${requestedSource}`,
        400,
        'BROWSER_INVALID_SOURCE',
      );
    }
    const settings = this.getBrowserSettings();
    const selection = this.browserSelection({
      browserSource: requestedSource || settings.browserSource || 'system',
      browserExecutablePath: String(input.browserExecutablePath || settings.browserExecutablePath || ''),
    });
    const existingTabId = normalizeExistingTabId(input.existingTabId);
    if (existingTabId !== null && selection.source !== 'extension') {
      throw browserError(
        'Existing Chrome pages require the extension Browser source',
        400,
        'BROWSER_INVALID_SOURCE',
      );
    }
    const existingTab = existingTabId === null
      ? null
      : this.browserExtensionRelay?.tabs().find(tab => tab.id === existingTabId) || null;
    if (existingTabId !== null && !existingTab) {
      throw browserError(
        'The selected Chrome page is no longer available',
        404,
        'BROWSER_EXTENSION_TAB_NOT_FOUND',
      );
    }
    if (selection.source === 'isolated' && input.ownerType !== 'agent') {
      throw browserError(
        'The isolated Browser requires an active Agent owner; create it from an Agent',
        409,
        'ISOLATED_BROWSER_AGENT_OWNER_REQUIRED',
      );
    }
    const resource = this.store.create({
      projectRootId: input.projectRootId,
      workspace: input.workspace,
      ownerType: input.ownerType,
      ownerAgentId: input.ownerAgentId,
      name: input.name || existingTab?.title || 'Browser',
      url: existingTab?.url || normalizeUrl(input.url),
      browserSource: selection.source,
      browserExecutablePath: selection.executablePath,
      existingTabId,
    });
    this.emitResource(resource);
    return publicResource(resource, this.store.revision);
  }

  rename(id: string, name: unknown) {
    this.requireEnabled();
    const title = String(name || '').trim();
    if (!title) throw browserError('Browser name is required');
    const resource = this.requireStored(id);
    const next = this.store.update(resource.id, {
      name: title.slice(0, 120),
      autoName: false,
    });
    this.emitResource(next);
    return publicResource(next, this.store.revision);
  }

  start(id: string): Promise<unknown> {
    this.requireEnabled();
    return this.enqueue(id, async () => {
      const resource = this.requireStored(id);
      const existingBinding = this.runtimes.get(id);
      if (resource.status === 'running' && existingBinding) {
        return publicResource(resource, this.store.revision);
      }
      if (existingBinding) {
        throw browserError(
          'A previous Browser runtime still owns this resource; stop it before restarting',
          409,
          'BROWSER_RUNTIME_OWNED',
        );
      }
      if (resource.status === 'starting' || resource.status === 'stopping') {
        throw browserError(`Browser is ${resource.status}`, 409, 'BROWSER_BUSY');
      }
      if (resource.processIdentity) {
        const blockedIdentity = resource.processIdentity;
        throw browserError(
          `Previous Browser process ${blockedIdentity.pid} still requires cleanup`,
          409,
          'BROWSER_RECOVERY_CLEANUP_REQUIRED',
        );
      }
      if (resource.existingTabId !== null) {
        const conflicting = this.store.list().find(candidate => (
          candidate.id !== resource.id
          && candidate.existingTabId === resource.existingTabId
          && ['starting', 'running'].includes(candidate.status)
        ));
        const reservedBy = this.existingTabReservations.get(resource.existingTabId);
        if (conflicting || (reservedBy && reservedBy !== resource.id)) {
          throw browserError(
            'This Chrome page is already managed by another Browser Resource',
            409,
            'BROWSER_EXTENSION_TAB_IN_USE',
          );
        }
        this.extensionTab(resource.existingTabId);
        this.existingTabReservations.set(resource.existingTabId, resource.id);
      }
      const selection = this.browserSelection({
        browserSource: resource.browserSource,
        browserExecutablePath: resource.browserExecutablePath,
      });
      const probe = await this.probeCapability(selection);
      const executable = probe.runtimeCapability;
      if (!executable || executable.error || !executable.agentBrowserPath) {
        const failed = this.store.update(id, {
          status: 'failed',
          error: executable?.error
            || 'Choose a local Chromium browser or prepare the isolated Browser runtime',
        });
        this.emitResource(failed);
        throw browserError(failed.error, 503, 'BROWSER_EXECUTABLE_NOT_FOUND');
      }
      if (executable.kind === 'isolated-computer' && resource.ownerType !== 'agent') {
        throw browserError(
          'The isolated Browser requires an active Agent owner; create it from an Agent',
          409,
          'ISOLATED_BROWSER_AGENT_OWNER_REQUIRED',
        );
      }

      const generation = resource.generation + 1;
      const starting = this.store.update(id, {
        status: 'starting',
        generation,
        browserKind: executable.kind,
        runtimeKind: 'agent-browser',
        error: '',
        processIdentity: null,
      });
      this.emitResource(starting);

      const reusableSession = [...this.sessions.values()].find(session => (
        !session.closing
        && session.ownerKey === browserOwnerKey(resource)
        && session.projectRootId === resource.projectRootId
        && session.browserKind === executable.kind
      ));
      if (reusableSession) {
        try {
          let running: BrowserResource | undefined;
          let binding: BrowserBinding | undefined;
          const operation = (reusableSession.actionChain || Promise.resolve())
            .catch(() => {})
            .then(async () => {
              const tab = resource.existingTabId === null
                ? await reusableSession.runtime.createTab(
                  resource.url,
                  executable.kind === 'isolated-computer'
                    ? `farming-${resource.id}-g${generation}`
                    : '',
                )
                : await reusableSession.runtime.switchTab(this.matchExtensionRuntimeTab(
                  await reusableSession.runtime.listTabs(),
                  resource.existingTabId,
                ).tabId);
              binding = this.createBinding(reusableSession, {
                ...starting,
                tabId: tab.tabId,
              });
              reusableSession.bindings.set(id, binding);
              reusableSession.activeResourceId = id;
              this.runtimes.set(id, binding);
              running = this.store.update(id, {
                status: 'running',
                sessionId: reusableSession.id,
                sessionGeneration: reusableSession.generation,
                tabId: tab.tabId,
                url: tab.url || resource.url,
                title: tab.title || '',
                error: '',
                processIdentity: null,
              });
            });
          reusableSession.actionChain = operation;
          await operation;
          if (!running || !binding) {
            throw browserError('Browser tab creation did not commit ownership', 500, 'BROWSER_START_FAILED');
          }
          this.emitResource(running);
          this.broadcastRuntimeState(binding);
          return publicResource(running, this.store.revision);
        } catch (error) {
          const failed = this.store.update(id, {
            status: 'failed',
            error: errorMessage(error) || 'Failed to create Browser tab',
            tabId: '',
          });
          this.emitResource(failed);
          throw browserError(failed.error, 500, 'BROWSER_START_FAILED');
        }
      }

      const sessionId = resource.sessionId || id;
      const previousSessionGeneration = this.store.list()
        .filter(candidate => candidate.sessionId === sessionId)
        .reduce((maximum, candidate) => Math.max(maximum, candidate.sessionGeneration || 0), 0);
      const sessionGeneration = previousSessionGeneration + 1;
      let isolatedLeaseKey = '';
      let externalCdpUrl = executable.cdpUrl || '';
      if (executable.kind === 'isolated-computer') {
        try {
          if (!this.isolatedBrowserProvider) {
            throw browserError(
              'The isolated Browser runtime is unavailable',
              503,
              'ISOLATED_BROWSER_UNAVAILABLE',
            );
          }
          const isolated = await this.isolatedBrowserProvider.acquire({
            ownerAgentId: resource.ownerAgentId,
            ownerKey: browserOwnerKey(resource),
            projectRootId: resource.projectRootId,
            workspace: resource.workspace,
          });
          externalCdpUrl = isolated.cdpUrl;
          isolatedLeaseKey = isolated.leaseKey;
        } catch (error) {
          const failed = this.store.update(id, {
            status: 'failed',
            error: errorMessage(error) || 'Failed to start the isolated Browser runtime',
          });
          this.emitResource(failed);
          throw error;
        }
      }
      let runtime: BrowserRuntime;
      try {
        runtime = this.createRuntime({
          id: sessionId,
          generation: sessionGeneration,
          configDir: this.configDir,
          agentBrowserPath: executable.agentBrowserPath,
          executablePath: executable.path,
          externalCdpUrl,
          ...(resource.existingTabId !== null ? {
            selectInitialExternalTab: tabs => this.matchExtensionRuntimeTab(
              tabs,
              resource.existingTabId as number,
            ),
          } : {}),
          profileDir: storageLayout.browserProfileDir(this.configDir, sessionId),
        });
      } catch (error) {
        if (isolatedLeaseKey && this.isolatedBrowserProvider) {
          await this.isolatedBrowserProvider.release(isolatedLeaseKey).catch(() => null);
        }
        const failed = this.store.update(id, {
          status: 'failed',
          error: errorMessage(error) || 'Failed to create Browser runtime',
        });
        this.emitResource(failed);
        throw error;
      }
      const session: BrowserSession = {
        id: sessionId,
        generation: sessionGeneration,
        projectRootId: resource.projectRootId,
        ownerKey: browserOwnerKey(resource),
        browserKind: executable.kind,
        runtime,
        bindings: new Map(),
        activeResourceId: id,
        processOwnerResourceId: id,
        actionChain: Promise.resolve(),
        pendingViewerInputs: [],
        reconcilingTabs: Promise.resolve(),
        initializing: true,
        isolatedLeaseKey,
        closing: false,
        tabsRevision: 0,
        viewerInputDrainScheduled: false,
      };
      const binding = this.createBinding(session, starting);
      session.bindings.set(id, binding);
      this.sessions.set(sessionId, session);
      this.runtimes.set(id, binding);
      this.bindSession(session);
      try {
        const metadata = await runtime.start(resource.url);
        const tabs = await runtime.listTabs();
        const tab = tabs.find(candidate => candidate.active) || tabs[0];
        if (!tab) throw new Error('agent-browser did not report the Browser tab');
        binding.tabId = tab.tabId;
        if (this.runtimes.get(id) !== binding) {
          throw browserError('Browser startup lost runtime ownership', 409, 'BROWSER_START_REPLACED');
        }
        const running = this.store.update(id, {
          status: 'running',
          sessionId,
          sessionGeneration,
          tabId: tab.tabId,
          url: metadata.url || resource.url,
          title: metadata.title || '',
          error: '',
        });
        session.initializing = false;
        this.emitResource(running);
        this.broadcastRuntimeState(binding);
        return publicResource(running, this.store.revision);
      } catch (error) {
        session.initializing = false;
        let cleanupError = null;
        try {
          await runtime.close();
        } catch (closeError) {
          cleanupError = closeError;
        }
        if (!cleanupError && isolatedLeaseKey && this.isolatedBrowserProvider) {
          try {
            await this.isolatedBrowserProvider.release(isolatedLeaseKey);
          } catch (releaseError) {
            cleanupError = releaseError;
          }
        }
        if (!cleanupError && this.runtimes.get(id) === binding) this.runtimes.delete(id);
        if (!cleanupError && this.sessions.get(sessionId) === session) this.sessions.delete(sessionId);
        const current = this.store.get(id);
        const failureMessage = executable.kind === 'isolated-computer'
          ? `Isolated Browser connection failed: ${errorMessage(error)}`
          : errorMessage(error) || 'Failed to start Browser';
        const failed = current?.generation === generation
          ? this.store.update(id, {
            status: 'failed',
            error: cleanupError
              ? `${failureMessage}; cleanup failed`
              : failureMessage,
            tabId: '',
            ...(!cleanupError ? { processIdentity: null } : {}),
          })
          : null;
        if (failed) this.emitResource(failed);
        throw browserError(
          failed?.error || errorMessage(error) || 'Failed to start Browser',
          500,
          'BROWSER_START_FAILED',
        );
      }
    }).catch(error => {
      const resource = this.store.get(id);
      if (
        resource?.existingTabId !== null
        && resource?.existingTabId !== undefined
        && resource.status !== 'running'
        && this.existingTabReservations.get(resource.existingTabId) === id
      ) {
        this.existingTabReservations.delete(resource.existingTabId);
      }
      throw error;
    });
  }

  stop(id: string, internal = false): Promise<unknown> {
    if (!internal) this.requireEnabled();
    this.stopAdmissions.set(id, (this.stopAdmissions.get(id) || 0) + 1);
    return this.enqueue(id, async () => {
      const resource = this.requireStored(id);
      const binding = this.runtimes.get(id);
      if (!binding) {
        if (resource.processIdentity) {
          await this.recoverInterruptedRuntime(resource);
          const recovered = this.requireStored(id);
          if (recovered.processIdentity) {
            const blockedIdentity = recovered.processIdentity;
            throw browserError(
              recovered.error || `Previous Browser process ${blockedIdentity.pid} still requires cleanup`,
              500,
              'BROWSER_RECOVERY_CLEANUP_REQUIRED',
            );
          }
        }
        const stopped = this.store.update(id, {
          status: 'stopped',
          error: '',
          processIdentity: null,
        });
        if (
          resource.existingTabId !== null
          && this.existingTabReservations.get(resource.existingTabId) === id
        ) {
          this.existingTabReservations.delete(resource.existingTabId);
        }
        this.emitResource(stopped);
        return publicResource(stopped, this.store.revision);
      }
      const stopping = this.store.update(id, { status: 'stopping', error: '' });
      this.emitResource(stopping);
      this.broadcastRuntimeState(binding);
      const { session } = binding;
      session.closing = session.bindings.size === 1;
      let isolatedReleaseError: unknown = null;
      try {
        const closeOperation = (session.actionChain || Promise.resolve())
          .catch(() => {})
          .then(async () => {
            if (session.bindings.size === 1) return session.runtime.close();
            if (resource.existingTabId === null) return session.runtime.closeTab(binding.tabId);
            if (session.runtime.activeTabId === binding.tabId) {
              const next = [...session.bindings.values()].find(candidate => candidate.id !== id);
              if (next) await session.runtime.switchTab(next.tabId);
            }
            return undefined;
          });
        session.actionChain = closeOperation;
        await closeOperation;
        if (session.bindings.size === 1 && session.isolatedLeaseKey && this.isolatedBrowserProvider) {
          try {
            await this.isolatedBrowserProvider.release(session.isolatedLeaseKey);
            session.isolatedLeaseKey = '';
          } catch (error) {
            isolatedReleaseError = error;
          }
        }
      } catch (error) {
        session.closing = false;
        throw error;
      }
      if (isolatedReleaseError) {
        session.closing = false;
        const failed = this.store.update(id, {
          status: 'failed',
          error: `Browser closed, but its isolated container could not be stopped: ${errorMessage(isolatedReleaseError)}`,
        });
        this.emitResource(failed);
        this.broadcastRuntimeState(binding);
        throw browserError(failed.error, 500, 'ISOLATED_BROWSER_RELEASE_FAILED');
      }
      session.bindings.delete(id);
      if (session.activeResourceId === id) {
        session.activeResourceId = session.bindings.values().next().value?.id || '';
      }
      if (this.runtimes.get(id) === binding) this.runtimes.delete(id);
      if (session.bindings.size === 0 && this.sessions.get(session.id) === session) {
        this.sessions.delete(session.id);
      }
      session.closing = false;

      if (session.processOwnerResourceId === id && session.bindings.size > 0) {
        const nextOwner = session.bindings.values().next().value;
        if (!nextOwner) throw new Error('Browser Session lost its remaining resource owner');
        session.processOwnerResourceId = nextOwner.id;
        const ownerResource = this.store.update(nextOwner.id, {
          processIdentity: resource.processIdentity,
        });
        this.emitResource(ownerResource);
        this.broadcastRuntimeState(nextOwner);
      }
      const stopped = this.store.update(id, {
        status: 'stopped',
        error: '',
        processIdentity: null,
        tabId: '',
      });
      if (
        resource.existingTabId !== null
        && this.existingTabReservations.get(resource.existingTabId) === id
      ) {
        this.existingTabReservations.delete(resource.existingTabId);
      }
      this.emitResource(stopped);
      this.broadcastRuntimeState(binding);
      this.releaseViewerState(binding);
      return publicResource(stopped, this.store.revision);
    }).finally(() => {
      const remainingStops = (this.stopAdmissions.get(id) || 1) - 1;
      if (remainingStops > 0) this.stopAdmissions.set(id, remainingStops);
      else this.stopAdmissions.delete(id);
    });
  }

  async delete(id: string, internal = false): Promise<unknown> {
    if (!internal) this.requireEnabled();
    await this.stop(id, internal);
    const resource = this.requireStored(id);
    const ownerKey = browserOwnerKey(resource);
    const deletesLastIsolatedOwner = resource.browserKind === 'isolated-computer'
      && this.isolatedBrowserProvider
      && !this.store.list().some(candidate => (
        candidate.id !== resource.id
        && candidate.browserKind === 'isolated-computer'
        && browserOwnerKey(candidate) === ownerKey
      ));
    if (deletesLastIsolatedOwner) {
      await this.isolatedBrowserProvider!.deleteOwner(ownerKey);
    }
    this.store.delete(id);
    const sessionId = resource.sessionId || id;
    const profileDir = storageLayout.browserProfileDir(this.configDir, sessionId);
    const browsersDir = path.resolve(storageLayout.browserResourcesDir(this.configDir));
    const resourceDir = path.resolve(profileDir, '..');
    const sessionStillReferenced = this.store.list().some(candidate => candidate.sessionId === sessionId);
    if (
      !sessionStillReferenced
      && resourceDir.startsWith(`${browsersDir}${path.sep}`)
      && RESOURCE_ID_RE.test(sessionId)
    ) {
      fs.rmSync(resourceDir, { recursive: true, force: true });
    }
    this.emit('deleted', { id, collectionRevision: this.store.revision });
    return { id, collectionRevision: this.store.revision };
  }

  navigate(id: string, url: unknown): Promise<unknown> {
    this.requireEnabled();
    const normalized = normalizeUrl(url);
    return this.withRuntime(id, async (runtime, binding) => {
      const metadata = await runtime.navigate(normalized);
      this.updateMetadata(binding, metadata);
      return this.get(id);
    });
  }

  goBack(id: string): Promise<unknown> {
    return this.withRuntime(id, async (runtime, binding) => {
      const metadata = await runtime.goBack();
      this.updateMetadata(binding, metadata);
      return this.get(id);
    });
  }

  goForward(id: string): Promise<unknown> {
    return this.withRuntime(id, async (runtime, binding) => {
      const metadata = await runtime.goForward();
      this.updateMetadata(binding, metadata);
      return this.get(id);
    });
  }

  reload(id: string): Promise<unknown> {
    return this.withRuntime(id, async (runtime, binding) => {
      const metadata = await runtime.reload();
      this.updateMetadata(binding, metadata);
      return this.get(id);
    });
  }

  action(id: string, input: BrowserMessage): Promise<unknown> {
    this.requireEnabled();
    const kind = String(input?.kind || '').trim();
    if (kind === 'snapshot') return this.withRuntime(id, runtime => runtime.snapshot());
    if (kind === 'screenshot') {
      const resource = this.requireStored(id);
      return this.withRuntime(id, async runtime => {
        const screenshot = recordValue(await runtime.screenshot());
        const data = String(screenshot.data || '');
        if (!data) throw browserError('Browser screenshot did not return image data');
        if (Buffer.byteLength(data, 'base64') > MAX_IMAGE_ARTIFACT_BYTES) {
          throw browserError(`Browser screenshot exceeds ${MAX_IMAGE_ARTIFACT_BYTES} bytes`);
        }
        const artifact = await writeWorkspaceImageArtifact({
          bytes: Buffer.from(data, 'base64'),
          capability: 'browser',
          mimeType: String(screenshot.mimeType || 'image/png'),
          operation: 'screenshot',
          workspace: resource.workspace,
        });
        return { artifact };
      });
    }
    if (kind === 'navigate') return this.navigate(id, input.url);
    if (kind === 'back') return this.goBack(id);
    if (kind === 'forward') return this.goForward(id);
    if (kind === 'reload') return this.reload(id);
    if (kind === 'click') return this.withRuntime(id, runtime => runtime.click(input));
    if ([
      'dblclick',
      'hover',
      'focus',
      'check',
      'uncheck',
      'scrollintoview',
      'highlight',
    ].includes(kind)) {
      return this.withRuntime(id, runtime => runtime.elementAction(kind, input));
    }
    if (kind === 'type') return this.withRuntime(id, runtime => runtime.type(input, false));
    if (kind === 'fill') return this.withRuntime(id, runtime => runtime.type(input, true));
    if (kind === 'keyboard') return this.withRuntime(id, runtime => runtime.keyboard(input));
    if (kind === 'press') return this.withRuntime(id, runtime => runtime.press(input));
    if (kind === 'select') return this.withRuntime(id, runtime => runtime.select(input));
    if (kind === 'drag') return this.withRuntime(id, runtime => runtime.drag(input));
    if (kind === 'wait') return this.withRuntime(id, runtime => runtime.waitFor(input));
    if (kind === 'get') return this.withRuntime(id, runtime => runtime.get(input));
    if (kind === 'is') return this.withRuntime(id, runtime => runtime.is(input));
    if (kind === 'find') return this.withRuntime(id, runtime => runtime.find(input));
    if (kind === 'eval') return this.withRuntime(id, runtime => runtime.evaluate(input));
    if (kind === 'console' || kind === 'errors') {
      return this.withRuntime(id, runtime => runtime.debugLog(kind, input));
    }
    if (kind === 'network') return this.withRuntime(id, runtime => runtime.network(input));
    if (kind === 'cookies') return this.withRuntime(id, runtime => runtime.cookies(input));
    if (kind === 'storage') return this.withRuntime(id, runtime => runtime.storage(input));
    if (kind === 'frame') return this.withRuntime(id, runtime => runtime.frame(input));
    if (kind === 'dialog') return this.withRuntime(id, runtime => runtime.dialog(input));
    if (kind === 'upload') {
      const resource = this.requireStored(id);
      const requestedFiles = Array.isArray(input?.files) ? input.files : [];
      if (requestedFiles.length === 0 || requestedFiles.length > MAX_UPLOAD_FILES) {
        throw browserError(`Browser upload requires between 1 and ${MAX_UPLOAD_FILES} files`);
      }
      const files = requestedFiles.map(file => resolveWorkspaceInputFile(resource, file));
      return this.withRuntime(id, runtime => runtime.upload({ ...input, files }));
    }
    if (kind === 'download') {
      const resource = this.requireStored(id);
      const target = resolveWorkspaceOutputFile(resource, input?.path);
      return this.withRuntime(id, async runtime => {
        const resourceDir = path.dirname(storageLayout.browserProfileDir(
          this.configDir,
          resource.sessionId || id,
        ));
        const downloadDir = path.join(resourceDir, 'downloads');
        fs.mkdirSync(downloadDir, { recursive: true, mode: 0o700 });
        const temporaryPath = path.join(
          downloadDir,
          `${crypto.randomUUID()}-${path.basename(target)}`,
        );
        try {
          await runtime.download({ ...input, outputPath: temporaryPath });
          const stat = fs.statSync(temporaryPath);
          if (!stat.isFile()) throw browserError('Browser download did not produce a regular file');
          fs.copyFileSync(temporaryPath, target, fs.constants.COPYFILE_EXCL);
          return {
            ok: true,
            path: path.relative(resource.workspace, target) || path.basename(target),
            size: stat.size,
          };
        } finally {
          fs.rmSync(temporaryPath, { force: true });
        }
      });
    }
    if (kind === 'scroll') return this.withRuntime(id, async runtime => {
      await runtime.wheel(input);
      return { ok: true };
    });
    throw browserError(`Unsupported Browser action: ${kind || '(missing)'}`);
  }

  attachViewer(id: string, ws: BrowserViewer, options: BrowserViewerOptions = {}): () => void {
    this.requireEnabled();
    const resource = this.requireStored(id);
    const binding = this.runtimes.get(id);
    ws.send(JSON.stringify({
      type: 'browser-state',
      resource: publicResource(resource, this.store.revision),
    }));
    if (!binding || resource.status !== 'running') return () => {};
    binding.viewers.add(ws);
    if (binding.latestFrame) ws.send(JSON.stringify(binding.latestFrame));
    void this.withRuntime(id, () => {}).catch(error => {
      if (ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'browser-error', message: errorMessage(error) || 'Browser tab failed' }));
      }
    });
    const onMessage = (raw: Buffer | string) => {
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        return;
      }
      const operation = message.type === 'resize'
        ? this.scheduleViewerResize(binding, ws, message)
        : this.handleViewerMessage(binding, ws, message);
      void Promise.resolve(operation).catch(error => {
        if (ws.readyState === 1) {
          ws.send(JSON.stringify({ type: 'browser-error', message: errorMessage(error) || 'Browser input failed' }));
        }
      });
    };
    if (options.readOnly !== true) ws.on('message', onMessage);
    const detach = () => {
      binding.viewers.delete(ws);
      binding.viewerGeometries.delete(ws);
      if (binding.viewerViewportOwner === ws) {
        binding.viewerViewportOwner = Array.from(binding.viewers)
          .find(viewer => binding.viewerGeometries.has(viewer)) || null;
        if (binding.viewerViewportOwner) {
          const geometry = binding.viewerGeometries.get(binding.viewerViewportOwner);
          if (geometry) {
            void this.scheduleViewerResize(binding, binding.viewerViewportOwner, geometry).catch(() => {});
          }
        } else {
          this.clearViewerResize(binding);
        }
      }
      if (options.readOnly !== true) ws.off('message', onMessage);
    };
    ws.once('close', detach);
    return detach;
  }

  handleViewerMessage(
    binding: BrowserBinding,
    viewer: BrowserViewer,
    message: BrowserMessage,
  ): Promise<unknown> {
    const resource = this.requireStored(binding.id);
    if (
      resource.status !== 'running'
      || this.stopAdmissions.has(binding.id)
      || message.generation !== binding.generation
      || this.runtimes.get(binding.id) !== binding
    ) {
      return Promise.reject(browserError(
        'Browser Viewer input is no longer admitted',
        409,
        'BROWSER_NOT_RUNNING',
      ));
    }
    return this.enqueueViewerInput(binding, viewer, message);
  }

  enqueueViewerInput(
    binding: BrowserBinding,
    viewer: BrowserViewer,
    message: BrowserMessage,
  ): Promise<unknown> {
    const { session } = binding;
    this.viewerInputMetrics.admitted += 1;
    return new Promise((resolve, reject) => {
      const coalescible = message.type === 'wheel'
        || (message.type === 'pointer' && message.action === 'move');
      let merged = false;
      if (coalescible) {
        for (let index = session.pendingViewerInputs.length - 1; index >= 0; index -= 1) {
          const pending = session.pendingViewerInputs[index];
          const pendingCoalescible = pending.message.type === 'wheel'
            || (pending.message.type === 'pointer' && pending.message.action === 'move');
          if (!pendingCoalescible || pending.binding !== binding || pending.viewer !== viewer) break;
          if (pending.message.type !== message.type) continue;
          pending.message = message.type === 'wheel'
            ? {
                ...message,
                deltaX: Number(pending.message.deltaX || 0) + Number(message.deltaX || 0),
                deltaY: Number(pending.message.deltaY || 0) + Number(message.deltaY || 0),
              }
            : message;
          pending.resolvers.push(resolve);
          pending.rejecters.push(reject);
          session.pendingViewerInputs.splice(index, 1);
          session.pendingViewerInputs.push(pending);
          if (message.type === 'wheel') this.viewerInputMetrics.coalescedWheels += 1;
          else this.viewerInputMetrics.coalescedMoves += 1;
          merged = true;
          break;
        }
      }
      if (!merged) {
        session.pendingViewerInputs.push({
          binding,
          enqueuedAt: Date.now(),
          message,
          rejecters: [reject],
          resolvers: [resolve],
          viewer,
        });
      }
      this.viewerInputMetrics.maxPending = Math.max(
        this.viewerInputMetrics.maxPending,
        session.pendingViewerInputs.length,
      );
      if (session.viewerInputDrainScheduled) return;
      session.viewerInputDrainScheduled = true;
      const next = (session.actionChain || Promise.resolve())
        .catch(() => {})
        .then(() => this.drainViewerInputs(session));
      session.actionChain = next;
    });
  }

  async drainViewerInputs(session: BrowserSession): Promise<void> {
    const pending = session.pendingViewerInputs.splice(0);
    session.viewerInputDrainScheduled = false;
    for (const input of pending) {
      this.viewerInputMetrics.maxWaitMs = Math.max(
        this.viewerInputMetrics.maxWaitMs,
        Date.now() - input.enqueuedAt,
      );
      try {
        await this.activateBinding(input.binding);
        const result = await this.performViewerMessage(input.binding, input.viewer, input.message);
        this.viewerInputMetrics.executed += 1;
        input.resolvers.forEach(resolve => resolve(result));
      } catch (error) {
        input.rejecters.forEach(reject => reject(error));
      }
    }
    this.reportViewerInputMetrics();
  }

  reportViewerInputMetrics(): void {
    if (process.env.FARMING_BROWSER_VIEWER_METRICS !== '1') return;
    const now = Date.now();
    if (now - this.viewerInputMetrics.reportStartedAt < VIEWER_METRICS_REPORT_MS) return;
    console.info('[Farming Browser Viewer input metrics]', JSON.stringify(this.viewerInputMetrics));
    this.viewerInputMetrics = {
      admitted: 0,
      coalescedMoves: 0,
      coalescedWheels: 0,
      executed: 0,
      maxPending: 0,
      maxWaitMs: 0,
      reportStartedAt: now,
    };
  }

  scheduleViewerResize(
    binding: BrowserBinding,
    viewer: BrowserViewer,
    message: BrowserMessage,
  ): Promise<void> {
    const resource = this.requireStored(binding.id);
    if (
      resource.status !== 'running'
      || this.stopAdmissions.has(binding.id)
      || message.generation !== binding.generation
      || this.runtimes.get(binding.id) !== binding
    ) {
      return Promise.reject(browserError(
        'Browser Viewer resize is no longer admitted',
        409,
        'BROWSER_NOT_RUNNING',
      ));
    }
    const width = Math.round(Number(message.width));
    const height = Math.round(Number(message.height));
    const requestedDeviceScaleFactor = Number(message.deviceScaleFactor);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      return Promise.reject(browserError('Browser Viewer size is invalid'));
    }
    const deviceScaleFactor = Number.isFinite(requestedDeviceScaleFactor)
      ? Math.max(1, Math.min(2, requestedDeviceScaleFactor))
      : 1;
    const geometry: ViewerGeometry = {
      type: 'resize',
      generation: binding.generation,
      width,
      height,
      deviceScaleFactor,
    };
    binding.viewerGeometries.set(viewer, geometry);
    if (
      message.claim === true
      || !binding.viewerViewportOwner
      || !binding.viewers.has(binding.viewerViewportOwner)
    ) {
      binding.viewerViewportOwner = viewer;
    }
    if (binding.viewerViewportOwner !== viewer) return Promise.resolve();
    binding.pendingViewerResize = { viewer, geometry };
    if (binding.viewerResizeTimer) this.cancelTimeout(binding.viewerResizeTimer);
    binding.viewerResizeTimer = this.scheduleTimeout(() => {
      binding.viewerResizeTimer = null;
      const pending = binding.pendingViewerResize;
      binding.pendingViewerResize = null;
      if (!pending || binding.viewerViewportOwner !== pending.viewer) return;
      void this.handleViewerMessage(binding, pending.viewer, pending.geometry).catch((error: unknown) => {
        if (pending.viewer.readyState === 1) {
          pending.viewer.send(JSON.stringify({
            type: 'browser-error',
            message: errorMessage(error) || 'Browser resize failed',
          }));
        }
      });
    }, VIEWER_RESIZE_SETTLE_MS);
    binding.viewerResizeTimer.unref?.();
    return Promise.resolve();
  }

  clearViewerResize(runtime: BrowserBinding): void {
    if (runtime.viewerResizeTimer) this.cancelTimeout(runtime.viewerResizeTimer);
    runtime.viewerResizeTimer = null;
    runtime.pendingViewerResize = null;
  }

  releaseViewerState(runtime: BrowserBinding): void {
    this.clearViewerResize(runtime);
    runtime.viewerGeometries?.clear?.();
    runtime.viewerViewportOwner = null;
    runtime.viewers?.clear?.();
  }

  async performViewerMessage(
    binding: BrowserBinding,
    viewer: BrowserViewer,
    message: BrowserMessage,
  ): Promise<void> {
    if (message.generation !== binding.generation || this.runtimes.get(binding.id) !== binding) {
      throw browserError('Browser Viewer generation is stale', 409, 'BROWSER_STALE_GENERATION');
    }
    const runtime = binding.session.runtime;
    if (message.type === 'resize') {
      if (binding.viewerViewportOwner !== viewer) return;
      if (
        typeof message.width !== 'number'
        || typeof message.height !== 'number'
        || typeof message.deviceScaleFactor !== 'number'
      ) {
        throw browserError('Browser Viewer size is invalid');
      }
      await runtime.resize({
        width: message.width,
        height: message.height,
        deviceScaleFactor: message.deviceScaleFactor,
      });
      return;
    }
    if (message.type === 'pointer') {
      await runtime.pointer(message);
      return;
    }
    if (message.type === 'wheel') {
      await runtime.wheel(message);
      return;
    }
    if (message.type === 'key') {
      await runtime.press(message);
      return;
    }
    if (message.type === 'text') {
      await runtime.insertText(String(message.text || ''));
    }
  }

  async dispose() {
    this.disposed = true;
    const sessions = [...this.sessions.values()];
    const results = await Promise.allSettled(sessions.map(async session => {
      await session.runtime.close();
      if (session.isolatedLeaseKey && this.isolatedBrowserProvider) {
        await this.isolatedBrowserProvider.release(session.isolatedLeaseKey);
        session.isolatedLeaseKey = '';
      }
    }));
    const failures = results
      .filter(result => result.status === 'rejected')
      .map(result => result.reason?.message || String(result.reason));
    if (failures.length > 0) {
      throw new Error(`Browser runtime cleanup failed: ${failures.join('; ')}`);
    }
    for (const binding of this.runtimes.values()) this.releaseViewerState(binding);
    this.runtimes.clear();
    this.sessions.clear();
  }

  async stopAll(): Promise<void> {
    const ids = [...this.runtimes.keys()];
    const results: PromiseSettledResult<unknown>[] = [];
    for (const id of ids) {
      try {
        results.push({ status: 'fulfilled', value: await this.stop(id) });
      } catch (reason) {
        results.push({ status: 'rejected', reason });
      }
    }
    const failures = results
      .filter(result => result.status === 'rejected')
      .map(result => errorMessage(result.reason));
    if (failures.length > 0) {
      throw browserError(
        `Browser extension could not stop every running Browser: ${failures.join('; ')}`,
        500,
        'BROWSER_DISABLE_FAILED',
      );
    }
  }

  async reconcileAgentLifecycle(agentStates: AgentLifecycleState[]): Promise<void> {
    const agents = new Map(agentStates.map(agent => [String(agent.id || ''), agent]));
    const resources = this.store.list().filter(resource => resource.ownerType === 'agent');
    for (const resource of resources) {
      const owner = agents.get(resource.ownerAgentId);
      if (!owner) {
        await this.delete(resource.id, true);
        continue;
      }
      const preservesBrowserRuntime = ['permission-restart', 'runtime-switch'].includes(
        String(owner.lifecycleOperation?.type || ''),
      );
      const ownerStopped = !preservesBrowserRuntime && (
        owner.archived === true
        || INACTIVE_AGENT_STATUSES.has(String(owner.status || ''))
      );
      if (ownerStopped) {
        await this.delete(resource.id, true);
      }
    }
  }

  requireEnabled(): void {
    if (this.isEnabled() !== true) {
      throw browserError('Browser extension is disabled', 409, 'BROWSER_EXTENSION_DISABLED');
    }
  }

  requireAvailable(): void {
    this.requireEnabled();
    const executable = this.runtimeCapability;
    if (!executable || executable.error) {
      throw browserError(
        executable?.error || 'Choose a local Chromium browser or prepare the isolated Browser runtime',
        503,
        'BROWSER_EXECUTABLE_NOT_FOUND',
      );
    }
  }

  requireStored(id: string): BrowserResource {
    if (!RESOURCE_ID_RE.test(String(id || ''))) {
      throw browserError('Invalid Browser resource id');
    }
    const resource = this.store.get(id);
    if (!resource) throw browserError('Browser resource not found', 404, 'BROWSER_NOT_FOUND');
    return resource;
  }

  enqueue<Result>(id: string, operation: () => Promise<Result>): Promise<Result> {
    const previous = this.operations.get(id) || Promise.resolve();
    const next = previous.catch(() => {}).then(operation);
    this.operations.set(id, next);
    return next.finally(() => {
      if (this.operations.get(id) === next) this.operations.delete(id);
    });
  }

  createBinding(session: BrowserSession, resource: BrowserResource): BrowserBinding {
    return {
      admittedTabsRevision: session.tabsRevision,
      id: resource.id,
      generation: resource.generation,
      session,
      tabId: resource.tabId || '',
      viewers: new Set<BrowserViewer>(),
      viewerGeometries: new Map<BrowserViewer, ViewerGeometry>(),
      viewerViewportOwner: null,
      viewerResizeTimer: null,
      pendingViewerResize: null,
      latestFrame: null,
    };
  }

  async activateBinding(binding: BrowserBinding): Promise<void> {
    const { session } = binding;
    if (!binding.tabId) throw browserError('Browser tab is unavailable', 409, 'BROWSER_TAB_UNAVAILABLE');
    if (
      session.runtime.activeTabId !== binding.tabId
      || session.runtime.streamTabId !== binding.tabId
    ) {
      await session.runtime.switchTab(binding.tabId);
    }
    session.activeResourceId = binding.id;
  }

  withRuntime<Result>(
    id: string,
    operation: (runtime: BrowserRuntime, binding: BrowserBinding) => Promise<Result> | Result,
  ): Promise<Result> {
    const binding = this.runtimes.get(id);
    const resource = this.requireStored(id);
    if (!binding || resource.status !== 'running') {
      throw browserError('Browser is not running', 409, 'BROWSER_NOT_RUNNING');
    }
    if (this.stopAdmissions.has(id)) {
      throw browserError('Browser is stopping', 409, 'BROWSER_STOPPING');
    }
    if (
      resource.generation !== binding.generation
      || resource.sessionId !== binding.session.id
      || resource.sessionGeneration !== binding.session.generation
      || resource.tabId !== binding.tabId
    ) {
      throw browserError(
        'Browser runtime ownership changed; refresh the Browser Resource before retrying',
        409,
        'BROWSER_STALE_GENERATION',
      );
    }
    const { session } = binding;
    const next = (session.actionChain || Promise.resolve())
      .catch(() => {})
      .then(async () => {
        await this.activateBinding(binding);
        return operation(session.runtime, binding);
      });
    session.actionChain = next;
    return next;
  }

  bindSession(session: BrowserSession): void {
    const { runtime } = session;
    runtime.on('process-identity', (processIdentity: BrowserProcessIdentity) => {
      const owner = this.store.get(session.processOwnerResourceId);
      if (
        this.sessions.get(session.id) !== session
        || !owner
        || owner.sessionId && owner.sessionId !== session.id
      ) return;
      const next = this.store.update(owner.id, {
        processIdentity: {
          ...processIdentity,
          configInstanceFingerprint: configInstanceFingerprint(this.configDir),
        },
      });
      this.emitResource(next);
    });
    runtime.on('frame', (frame: BrowserMessage) => {
      const binding = [...session.bindings.values()]
        .find(candidate => candidate.tabId === runtime.streamTabId)
        || session.bindings.get(session.activeResourceId);
      if (!binding) return;
      const resourceFrame = {
        ...frame,
        generation: binding.generation,
      };
      binding.latestFrame = resourceFrame;
      for (const viewer of binding.viewers) {
        if (viewer.readyState === 1 && (Number(viewer.bufferedAmount) || 0) <= MAX_VIEWER_BUFFER_BYTES) {
          viewer.send(JSON.stringify(resourceFrame));
        }
      }
    });
    runtime.on('metadata', (metadata: BrowserMetadata) => {
      const binding = [...session.bindings.values()]
        .find(candidate => candidate.tabId === runtime.activeTabId)
        || session.bindings.get(session.activeResourceId);
      if (binding) this.updateMetadata(binding, metadata);
    });
    runtime.on('tabs', (event: BrowserTabsEvent) => {
      if (session.initializing || session.closing) return;
      const observedTabsRevision = session.tabsRevision + 1;
      session.tabsRevision = observedTabsRevision;
      const next = (session.actionChain || Promise.resolve())
        .catch(() => {})
        .then(() => this.reconcileTabs(session, event, observedTabsRevision));
      session.actionChain = next;
    });
    runtime.on('error', (error: unknown) => {
      for (const binding of session.bindings.values()) {
        for (const viewer of binding.viewers) {
          if (viewer.readyState === 1) {
            viewer.send(JSON.stringify({ type: 'browser-error', message: errorMessage(error) || 'Browser runtime failed' }));
          }
        }
      }
    });
    runtime.once('exit', (message: string) => {
      void this.handleRuntimeExit(session, message);
    });
  }

  async reconcileTabs(
    session: BrowserSession,
    event: BrowserTabsEvent,
    observedTabsRevision = session.tabsRevision,
  ): Promise<void> {
    if (this.sessions.get(session.id) !== session || session.closing) return;
    const tabs = Array.isArray(event?.tabs) ? event.tabs.filter(tab => tab.type === 'page') : [];
    const newlyObservedTabIds = new Set(
      Array.isArray(event?.newTabIds) ? event.newTabIds.map(String) : [],
    );
    const byTabId = new Map([...session.bindings.values()].map(binding => [binding.tabId, binding]));
    const opener = session.bindings.get(session.activeResourceId) || null;
    const opened = [];

    for (const tab of tabs) {
      let binding = byTabId.get(tab.tabId);
      if (
        !binding
        && newlyObservedTabIds.has(tab.tabId)
        && (!session.runtime.externalCdpUrl || event.popupAdmitted)
      ) {
        session.runtime.ownedTabIds.add(tab.tabId);
        const created = this.store.createRunningTab({
          projectRootId: opener?.session.projectRootId || session.projectRootId,
          ownerType: opener ? this.store.get(opener.id)?.ownerType : undefined,
          ownerAgentId: opener ? this.store.get(opener.id)?.ownerAgentId : undefined,
          workspace: (opener ? this.store.get(opener.id)?.workspace : undefined)
            || this.store.list().find(resource => resource.sessionId === session.id)?.workspace,
          name: tabResourceName(tab),
          url: tab.url,
          title: tab.title,
          browserKind: session.browserKind,
          sessionId: session.id,
          sessionGeneration: session.generation,
          tabId: tab.tabId,
        });
        binding = this.createBinding(session, created);
        session.bindings.set(created.id, binding);
        this.runtimes.set(created.id, binding);
        byTabId.set(tab.tabId, binding);
        this.emitResource(created);
        opened.push(publicResource(created, this.store.revision));
      }
      if (!binding) continue;
      const current = this.store.get(binding.id);
      if (!current || current.status !== 'running') continue;
      if (current.url !== tab.url || current.title !== tab.title) {
        const updated = this.store.update(binding.id, {
          url: tab.url || current.url,
          title: tab.title || '',
          ...(current.autoName ? { name: tabResourceName(tab) } : {}),
        });
        this.emitResource(updated);
        this.broadcastRuntimeState(binding);
      }
    }

    const liveTabIds = new Set(tabs.map(tab => tab.tabId));
    for (const binding of [...session.bindings.values()]) {
      if (liveTabIds.has(binding.tabId)) continue;
      if (observedTabsRevision <= binding.admittedTabsRevision) continue;
      const current = this.store.get(binding.id);
      if (!current || current.status === 'stopping') continue;
      session.bindings.delete(binding.id);
      this.runtimes.delete(binding.id);
      if (session.processOwnerResourceId === binding.id && session.bindings.size > 0) {
        const nextOwner = session.bindings.values().next().value;
        if (!nextOwner) throw new Error('Browser Session lost its remaining resource owner');
        session.processOwnerResourceId = nextOwner.id;
        const transferred = this.store.update(nextOwner.id, {
          processIdentity: current.processIdentity,
        });
        this.emitResource(transferred);
        this.broadcastRuntimeState(nextOwner);
      }
      const stopped = this.store.update(binding.id, {
        status: 'stopped',
        tabId: '',
        processIdentity: null,
        error: '',
      });
      this.emitResource(stopped);
      this.broadcastRuntimeState(binding);
      this.releaseViewerState(binding);
    }

    const activeTab = tabs.find(tab => tab.active);
    const activeBinding = activeTab ? byTabId.get(activeTab.tabId) : null;
    if (activeBinding) {
      session.activeResourceId = activeBinding.id;
      if (session.runtime.streamTabId !== activeBinding.tabId) {
        await session.runtime.switchTab(activeBinding.tabId);
      }
    }
    if (opened.length > 0 && opener) {
      const message = JSON.stringify({
        type: 'browser-tab-opened',
        resource: opened.at(-1),
      });
      for (const viewer of opener.viewers) {
        if (viewer.readyState === 1) viewer.send(message);
      }
    }
  }

  updateMetadata(binding: BrowserBinding, metadata: BrowserMetadata | null | undefined): void {
    const current = this.store.get(binding.id);
    if (!current || current.generation !== binding.generation || !metadata) return;
    const next = this.store.update(binding.id, {
      url: String(metadata.url || current.url),
      title: String(metadata.title || ''),
    });
    this.emitResource(next);
    this.broadcastRuntimeState(binding);
  }

  emitResource(resource: BrowserResource): void {
    this.emit('resource', publicResource(resource, this.store.revision));
  }

  broadcastRuntimeState(binding: BrowserBinding): void {
    const resource = this.store.get(binding.id);
    if (!resource) return;
    const message = JSON.stringify({
      type: 'browser-state',
      resource: publicResource(resource, this.store.revision),
    });
    for (const viewer of binding.viewers || []) {
      if (viewer.readyState === 1) viewer.send(message);
    }
  }

  async handleRuntimeExit(session: BrowserSession, message: string): Promise<void> {
    if (this.sessions.get(session.id) !== session) return;
    const failedBindings = [...session.bindings.values()];
    for (const binding of failedBindings) {
      const current = this.store.get(binding.id);
      if (!current) continue;
      const failed = this.store.update(binding.id, {
        status: 'failed',
        error: current.browserKind === 'isolated-computer'
          ? 'Isolated Browser connection exited'
          : message || 'Browser connection exited',
      });
      this.emitResource(failed);
      this.broadcastRuntimeState(binding);
    }
    try {
      await session.runtime.close();
      if (session.isolatedLeaseKey && this.isolatedBrowserProvider) {
        await this.isolatedBrowserProvider.release(session.isolatedLeaseKey);
        session.isolatedLeaseKey = '';
      }
      this.sessions.delete(session.id);
      for (const binding of failedBindings) {
        this.runtimes.delete(binding.id);
        this.releaseViewerState(binding);
        const cleaned = this.store.update(binding.id, { processIdentity: null });
        if (cleaned) this.emitResource(cleaned);
      }
    } catch (error) {
      for (const binding of failedBindings) {
        const current = this.store.get(binding.id);
        if (!current) continue;
        const cleanupFailed = this.store.update(binding.id, {
          status: 'failed',
          error: `${current.error}; cleanup failed: ${errorMessage(error)}`,
        });
        this.emitResource(cleanupFailed);
        this.broadcastRuntimeState(binding);
      }
    }
  }
}

export {
  BrowserResourceManager,
  browserError,
  normalizeUrl,
};
