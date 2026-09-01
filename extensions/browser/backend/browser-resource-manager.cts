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
  SESSION_NAME_RE,
  type BrowserResource,
  type BrowserResourceCreateInput,
  type BrowserResourcePatch,
  type BrowserProcessIdentity,
  type LegacyProjectBrowserResource,
  type RunningBrowserTabInput,
} from './browser-resource-store.cjs';
import {
  AgentBrowserRuntime,
  type RuntimeOptions,
} from './agent-browser-runtime.cjs';
import {
  DesktopBrowserAdapterRegistry,
  DesktopBrowserRuntime,
} from './desktop-browser-adapter.cjs';
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
const MAX_DESKTOP_FILE_TRANSFER_BYTES = 8 * 1024 * 1024;
const INACTIVE_AGENT_STATUSES = new Set(['dead', 'error', 'exited', 'stopped']);

type BrowserResourceStatus = 'stopped' | 'starting' | 'running' | 'reconnecting' | 'stopping' | 'failed';
type BrowserResourceOwnerType = 'agent' | 'project';
type BrowserTab = {
  active?: boolean;
  controlEpoch?: number;
  controlOwner?: BrowserControlOwner;
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
type BrowserMetadata = {
  generation?: number;
  resourceId?: string;
  tabId?: string;
  title?: string;
  url?: string;
};
type BrowserControlOwner = 'agent' | 'user';
type BrowserLoadingEvent = {
  generation?: number;
  loading: boolean;
  resourceId?: string;
  tabId?: string;
};
type BrowserCapability = BrowserExecutable;
type BrowserSelection = {
  executablePath: string;
  source: string;
};
type CapabilityRefreshOptions = {
  persistDefaultSelection?: boolean;
  reuseVerified?: boolean;
};
type SourceCapabilityRefreshOptions = {
  reuseVerified?: boolean;
};
type BrowserSettings = {
  browserExecutablePath?: string;
  browserSource?: string;
};
const BROWSER_SOURCES = new Set(['desktop', 'extension', 'isolated', 'system']);
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
  createTab(url: string, label?: string, caller?: BrowserControlOwner): Promise<BrowserTab>;
  listTabs(caller?: BrowserControlOwner): Promise<BrowserTab[]>;
  switchTab(tabId: string): Promise<BrowserTab>;
  navigate(url: string): Promise<BrowserMetadata>;
  goBack(): Promise<BrowserMetadata>;
  goForward(): Promise<BrowserMetadata>;
  reload(): Promise<BrowserMetadata>;
  stopLoading?(): Promise<BrowserMetadata>;
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
  setActiveResourceId?(resourceId: string, generation?: number, controlEpoch?: number): void;
  bindResourceTab?(
    resourceId: string,
    tabId: string,
    generation?: number,
    controlEpoch?: number,
    controlOwner?: BrowserControlOwner,
  ): Promise<unknown>;
  prepareControl?(input: {
    controlEpoch: number;
    expectedControlEpoch: number;
    expectedControlOwner: BrowserControlOwner;
    owner: BrowserControlOwner;
  }): Promise<unknown>;
  commitControl?(owner: BrowserControlOwner, controlEpoch: number): Promise<unknown>;
  cancelControl?(owner: BrowserControlOwner, controlEpoch: number): Promise<unknown>;
  switchTabForUser?(tabId: string): Promise<BrowserTab>;
  userAction?(operation: string, input: BrowserMessage): Promise<unknown>;
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
  listLegacyProjectResources(): LegacyProjectBrowserResource[];
  get(id: string): BrowserResource | null;
  create(input: BrowserResourceCreateInput): BrowserResource;
  createRunningTab(input: RunningBrowserTabInput): BrowserResource;
  update(id: string, patch: BrowserResourcePatch): BrowserResource;
  transferAgentOwner(sourceAgentId: string, targetAgentId: string): BrowserResource[];
  delete(id: string): boolean | void;
  deleteLegacyProjectResource(id: string): boolean | void;
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
  cdpUrl(tabId?: number | 'new'): string;
  pairingString(relayUrl: string): string;
  prepare(): Record<string, unknown>;
  remove(): Record<string, unknown>;
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
  desktopBrowserAdapters?: DesktopBrowserAdapterRegistry;
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
  cwd?: string;
  id: string;
  lifecycleOperation?: { type?: string } | null;
  projectWorkspace?: string;
  restartedFromAgentId?: string;
  restartedFromAgentIds?: string[];
  status?: string;
};
type BrowserError = Error & {
  cause?: unknown;
  code: string;
  status: number;
  uncertain?: boolean;
};
type InterruptedRuntimeCleanupResult = {
  cleaned: boolean;
  message: string;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string {
  if (!error || typeof error !== 'object' || !('code' in error)) return '';
  return typeof error.code === 'string' ? error.code : '';
}

function uncertainError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (error as { uncertain?: unknown }).uncertain === true);
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function publicResource(resource: BrowserResource, collectionRevision: number) {
  return {
    id: resource.id,
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
    desktopAdapterId: resource.browserSource === 'desktop' ? resource.desktopAdapterId : '',
    existingTabId: resource.existingTabId,
    sessionName: resource.sessionName,
    sessionId: resource.sessionId,
    tabId: resource.tabId,
    controlEpoch: resource.controlEpoch,
    controlOwner: resource.controlOwner,
    loading: resource.loading,
    error: resource.error,
    createdAt: resource.createdAt,
    updatedAt: resource.updatedAt,
  };
}

function browserError(
  message: string,
  status = 400,
  code = 'BROWSER_INVALID_REQUEST',
  uncertain = false,
): BrowserError {
  const error = new Error(message) as BrowserError;
  error.status = status;
  error.code = code;
  if (uncertain) error.uncertain = true;
  return error;
}

function replacementAgentOwner(
  ownerAgentId: string,
  workspace: string,
  agentStates: AgentLifecycleState[],
): AgentLifecycleState | null {
  const expectedWorkspace = path.resolve(workspace);
  const candidates = agentStates.filter(agent => {
    const lineage = new Set([
      String(agent.restartedFromAgentId || ''),
      ...(Array.isArray(agent.restartedFromAgentIds) ? agent.restartedFromAgentIds : []),
    ]);
    const agentWorkspace = String(agent.projectWorkspace || agent.cwd || '').trim();
    return lineage.has(ownerAgentId)
      && agent.archived !== true
      && !INACTIVE_AGENT_STATUSES.has(String(agent.status || ''))
      && Boolean(agentWorkspace)
      && path.resolve(agentWorkspace) === expectedWorkspace;
  });
  if (candidates.length > 1) {
    throw browserError(
      `Browser owner replacement is ambiguous for Agent ${ownerAgentId}`,
      409,
      'BROWSER_OWNER_REPLACEMENT_AMBIGUOUS',
    );
  }
  return candidates[0] || null;
}

function browserOwnerKey(resource: Pick<BrowserResource, 'ownerAgentId'>): string {
  return `agent:${resource.ownerAgentId}`;
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

function normalizeBrowserSessionName(value: unknown): string {
  const name = String(value || '').trim();
  if (!SESSION_NAME_RE.test(name)) {
    throw browserError(
      'Browser session must use 1-64 letters, numbers, dots, underscores, or hyphens',
      400,
      'BROWSER_INVALID_SESSION',
    );
  }
  return name;
}

function sameBrowserOwner(
  resource: BrowserResource,
  input: Record<string, unknown>,
): boolean {
  return resource.ownerAgentId === String(input.ownerAgentId || '')
    && resource.projectRootId === String(input.projectRootId || '');
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
  readonly desktopBrowserAdapters: DesktopBrowserAdapterRegistry | null;
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
  readonly nativeSessionOperations = new Map<string, Promise<unknown>>();
  readonly deleteAdmissions = new Set<string>();
  readonly stopAdmissions = new Map<string, number>();
  readonly controlAdmissions = new Map<string, number>();
  readonly nativeUserTabAdmissions = new Map<string, Map<string, string>>();
  readonly existingTabReservations = new Map<number, string>();
  readonly agentOwnerReplacementHolds = new Set<string>();
  disposed = false;
  runtimeCapability: BrowserCapability | null = null;
  browserOptions: BrowserOption[] = [];
  isolatedBrowserCapability: Record<string, unknown> | null = null;
  effectiveBrowserSelection: BrowserSelection | null = null;
  capabilityProbeSignature = '';
  capabilityRefreshPromise: Promise<BrowserCapability | null> | null = null;
  capabilityRefreshKey = '';
  sourceCapabilitiesCache: {
    signature: string;
    sources: Array<Record<string, unknown>>;
  } | null = null;
  sourceCapabilitiesPromise: Promise<Array<Record<string, unknown>>> | null = null;
  sourceCapabilitiesPromiseKey = '';
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
    this.desktopBrowserAdapters = options.desktopBrowserAdapters || null;
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
    await this.migrateLegacyProjectResources();
    const interrupted = this.store.list().filter(resource =>
      Boolean(resource.processIdentity)
      || ['running', 'reconnecting', 'starting', 'stopping'].includes(resource.status)
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

  async migrateLegacyProjectResources(): Promise<void> {
    const groups = new Map<string, LegacyProjectBrowserResource[]>();
    for (const resource of this.store.listLegacyProjectResources()) {
      const key = resource.runtimeKind === 'agent-browser'
        ? (resource.sessionId || resource.id)
        : resource.id;
      const group = groups.get(key) || [];
      group.push(resource);
      groups.set(key, group);
    }
    for (const resources of groups.values()) {
      const interrupted = resources.find(resource => resource.processIdentity)
        || resources.find(resource => (
          ['running', 'reconnecting', 'starting', 'stopping'].includes(resource.status)
        ));
      if (interrupted) {
        const cleanup = await this.cleanupInterruptedRuntime(interrupted);
        if (!cleanup.cleaned) {
          console.warn(
            `Failed to clean up legacy Project-owned Browser ${interrupted.id}: ${cleanup.message}`,
          );
          continue;
        }
      }
      try {
        const deletingIds = new Set(resources.map(resource => resource.id));
        const removedSessions = new Set<string>();
        for (const resource of resources) {
          const sessionId = resource.sessionId || resource.id;
          if (removedSessions.has(sessionId)) continue;
          this.removeBrowserProfile(resource, deletingIds);
          removedSessions.add(sessionId);
        }
        for (const resource of resources) {
          this.store.deleteLegacyProjectResource(resource.id);
        }
      } catch (error) {
        console.warn(
          `Failed to remove legacy Project-owned Browser ${resources[0]?.id || ''}: ${errorMessage(error)}`,
        );
      }
    }
  }

  async cleanupInterruptedRuntime(
    resource: BrowserResource,
  ): Promise<InterruptedRuntimeCleanupResult> {
    if (resource.runtimeKind === 'desktop-native') {
      return {
        cleaned: true,
        message: 'Farming restarted and invalidated the previous Desktop native Browser lease',
      };
    }
    if (resource.runtimeKind === 'agent-browser') {
      const capability = this.runtimeCapability?.agentBrowserPath
        ? this.runtimeCapability
        : await this.discoverExecutable({ source: 'isolated' });
      let runtimeError: unknown = null;
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
      return {
        cleaned: !runtimeError,
        message: runtimeError
          ? `agent-browser Session cleanup failed: ${errorMessage(runtimeError)}`
          : 'Farming restarted and cleaned up the previous Browser runtime',
      };
    }

    // Migration cleanup for Browser rows created by Farming's former raw-CDP runtime.
    const expected = resource.processIdentity;
    if (!expected) {
      return {
        cleaned: true,
        message: resource.browserKind === 'isolated-computer'
          ? 'Farming restarted and stopped the isolated Browser runtime'
          : 'Farming restarted before the Browser runtime identity was committed',
      };
    }
    const current = await this.readProcessIdentity(expected.pid);
    if (!matchingProcessIdentity(expected, current)) {
      return {
        cleaned: true,
        message: 'Farming restarted after the previous Browser runtime exited',
      };
    }
    if (expected.processGroupId !== expected.pid) {
      return {
        cleaned: false,
        message: `Previous Browser process ${expected.pid} has an unsafe process-group identity; stop it manually`,
      };
    }
    try {
      this.killProcessGroup(expected.processGroupId, 'SIGKILL');
    } catch (error) {
      if (errorCode(error) !== 'ESRCH') {
        const permission = errorCode(error) === 'EPERM' || errorCode(error) === 'EACCES';
        return {
          cleaned: false,
          message: permission
            ? `Farming cannot clean up previous Browser process ${expected.pid} because it lacks permission`
            : `Farming could not clean up previous Browser process ${expected.pid}: ${errorMessage(error)}`,
        };
      }
    }
    const startedAt = Date.now();
    while (matchingProcessIdentity(expected, await this.readProcessIdentity(expected.pid))) {
      if (Date.now() - startedAt >= BROWSER_RECOVERY_TIMEOUT_MS) {
        return {
          cleaned: false,
          message: `Previous Browser process ${expected.pid} did not exit after SIGKILL`,
        };
      }
      await this.wait(BROWSER_RECOVERY_POLL_MS);
    }
    return {
      cleaned: true,
      message: 'Farming restarted and cleaned up the previous Browser runtime',
    };
  }

  async recoverInterruptedRuntime(
    resource: BrowserResource,
    relatedResources: BrowserResource[] = [resource],
  ): Promise<void> {
    const cleanup = await this.cleanupInterruptedRuntime(resource);
    for (const related of relatedResources) {
      this.store.update(related.id, {
        status: 'failed',
        error: cleanup.message,
        ...(cleanup.cleaned ? { processIdentity: null } : {}),
        ...(resource.runtimeKind === 'agent-browser' || resource.runtimeKind === 'desktop-native'
          ? {
              tabId: '',
              loading: false,
              controlEpoch: related.controlEpoch + 1,
              controlOwner: 'agent',
            }
          : {}),
      });
    }
  }

  async forceStopIsolatedRuntime(resource: BrowserResource): Promise<void> {
    const expected = resource.processIdentity;
    if (!expected) {
      throw new Error('the isolated agent-browser process identity was not committed');
    }
    const current = await this.readProcessIdentity(expected.pid);
    if (!matchingProcessIdentity(expected, current)) return;
    if (expected.processGroupId !== expected.pid) {
      throw new Error(
        `isolated agent-browser process ${expected.pid} has an unsafe process-group identity`,
      );
    }
    try {
      this.killProcessGroup(expected.processGroupId, 'SIGKILL');
    } catch (error) {
      if (errorCode(error) !== 'ESRCH') throw error;
    }
    const startedAt = Date.now();
    while (matchingProcessIdentity(expected, await this.readProcessIdentity(expected.pid))) {
      if (Date.now() - startedAt >= BROWSER_RECOVERY_TIMEOUT_MS) {
        throw new Error(
          `isolated agent-browser process ${expected.pid} did not exit after SIGKILL`,
        );
      }
      await this.wait(BROWSER_RECOVERY_POLL_MS);
    }
  }

  capability() {
    const executable = this.runtimeCapability;
    const runnable = executable && !executable.error;
    const enabled = this.isEnabled() === true;
    const selection = this.effectiveBrowserSelection || this.browserSelection();
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

  async sourceCapabilities(
    options: SourceCapabilityRefreshOptions = {},
  ): Promise<Array<Record<string, unknown>>> {
    const settings = this.getBrowserSettings();
    const systemOptions = this.discoverBrowserOptions();
    const systemPath = String(
      settings.browserExecutablePath
      || (this.effectiveBrowserSelection?.source === 'system'
        ? this.effectiveBrowserSelection.executablePath
        : '')
      || systemOptions[0]?.path
      || '',
    );
    const isolatedCapability = this.isolatedBrowserCapability;
    const signature = this.browserCapabilitySignature(
      { source: 'system', executablePath: systemPath },
      systemOptions,
      isolatedCapability,
    );
    if (options.reuseVerified && this.sourceCapabilitiesCache?.signature === signature) {
      return this.sourceCapabilitiesCache.sources;
    }
    if (
      options.reuseVerified
      && this.sourceCapabilitiesPromise
      && this.sourceCapabilitiesPromiseKey === signature
    ) return this.sourceCapabilitiesPromise;
    const selections: BrowserSelection[] = [
      { source: 'desktop', executablePath: '' },
      { source: 'system', executablePath: systemPath },
      { source: 'extension', executablePath: '' },
      { source: 'isolated', executablePath: '' },
    ];
    const refresh = async () => {
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
      const extensionReady = this.browserExtensionRelay?.capability().connected === true
        && Boolean(this.browserExtensionRelay?.cdpUrl());
      const hasRetryableFailure = probes.some(probe => {
        if (probe.available === true) return false;
        if (probe.source === 'system') return Boolean(systemPath);
        if (probe.source === 'extension') return extensionReady;
        if (probe.source === 'isolated') return isolatedCapability?.available === true;
        if (probe.source === 'desktop') return this.desktopBrowserAdapters?.ids().length === 1;
        return false;
      });
      this.sourceCapabilitiesCache = hasRetryableFailure ? null : { signature, sources: probes };
      return probes;
    };
    const previous = this.sourceCapabilitiesPromise;
    const sourceCapabilitiesPromise = (async () => {
      if (previous) {
        try {
          await previous;
        } catch {
          // A changed authoritative signature still needs its own fresh probe.
        }
      }
      return refresh();
    })().finally(() => {
      if (this.sourceCapabilitiesPromise !== sourceCapabilitiesPromise) return;
      this.sourceCapabilitiesPromise = null;
      this.sourceCapabilitiesPromiseKey = '';
    });
    this.sourceCapabilitiesPromise = sourceCapabilitiesPromise;
    this.sourceCapabilitiesPromiseKey = signature;
    return sourceCapabilitiesPromise;
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
      desktopAdapters: this.desktopBrowserAdapters?.ids() || [],
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
    if (selection.source === 'desktop') {
      return {
        browserOptions,
        isolatedBrowserCapability,
        runtimeCapability: {
          kind: 'desktop-native',
          path: '',
          ...(this.desktopBrowserAdapters?.ids().length ? {} : {
            error: 'Open Farming Desktop to use its native Browser view',
          }),
        },
      };
    }
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
    const persistDefaultSelection = options.persistDefaultSelection !== false;
    const requestedSelection = selection || this.browserSelection();
    const refreshKey = JSON.stringify({
      persistDefaultSelection,
      selection: requestedSelection,
    });
    if (
      options.reuseVerified
      && this.capabilityRefreshPromise
      && this.capabilityRefreshKey === refreshKey
    ) {
      return this.capabilityRefreshPromise;
    }
    const refresh = async () => {
      // Implicit refreshes read Config only after receiving queue ownership. A capability
      // request queued before an Owner settings update must not restore its stale selection.
      let desiredSelection = selection || this.browserSelection();
      const browserOptions = this.discoverBrowserOptions();
      if (!selection && desiredSelection.source === 'system' && !desiredSelection.executablePath) {
        const defaultBrowser = browserOptions[0];
        if (defaultBrowser) {
          if (persistDefaultSelection) {
            this.saveBrowserSelection({
              source: 'system',
              executablePath: defaultBrowser.path,
            });
          }
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
        this.effectiveBrowserSelection = desiredSelection;
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
      this.effectiveBrowserSelection = desiredSelection;
      this.isolatedBrowserCapability = probe.isolatedBrowserCapability;
      this.runtimeCapability = probe.runtimeCapability;
      if (this.capabilityProbeSignature !== signature) this.sourceCapabilitiesCache = null;
      this.capabilityProbeSignature = this.browserCapabilitySignature(
        desiredSelection,
        probe.browserOptions,
        probe.isolatedBrowserCapability,
      );
      return this.runtimeCapability;
    };
    const previous = this.capabilityRefreshPromise;
    const capabilityRefreshPromise = (async () => {
      if (previous) {
        try {
          await previous;
        } catch {
          // A newer requested selection must still receive its own probe.
        }
      }
      return refresh();
    })().finally(() => {
      if (this.capabilityRefreshPromise !== capabilityRefreshPromise) return;
      this.capabilityRefreshPromise = null;
      this.capabilityRefreshKey = '';
    });
    this.capabilityRefreshPromise = capabilityRefreshPromise;
    this.capabilityRefreshKey = refreshKey;
    return capabilityRefreshPromise;
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

  removeBrowserExtension(): Record<string, unknown> {
    if (!this.browserExtensionRelay) {
      throw browserError('Farming Browser Connector is unavailable', 503, 'BROWSER_EXTENSION_UNAVAILABLE');
    }
    return this.browserExtensionRelay.remove();
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
    const matchingUrlTabs = tabs.filter(tab => tab.url === selected.url);
    if (matchingUrlTabs.length === 1) {
      // Existing-tab Chrome extension sessions are scoped to the exact tabId in
      // their CDP URL. Chrome can temporarily report an empty or stale title
      // while restoring a discarded tab, so a unique URL match inside that
      // already-isolated session is still the selected page.
      return matchingUrlTabs[0];
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
    if (!String(input.ownerAgentId || '').trim()) {
      throw browserError(
        'Browser creation requires an active Agent owner',
        400,
        'BROWSER_AGENT_OWNER_REQUIRED',
      );
    }
    const requestedSource = String(input.browserSource || '').trim();
    if (requestedSource && !BROWSER_SOURCES.has(requestedSource)) {
      throw browserError(
        `Unsupported Browser source: ${requestedSource}`,
        400,
        'BROWSER_INVALID_SOURCE',
      );
    }
    const settings = this.getBrowserSettings();
    const selectedSource = requestedSource
      || (input.preferDesktop === true && this.desktopBrowserAdapters?.ids().length
        ? 'desktop'
        : settings.browserSource || 'system');
    const selection = this.browserSelection({
      browserSource: selectedSource,
      browserExecutablePath: String(input.browserExecutablePath || settings.browserExecutablePath || ''),
    });
    const desktopAdapterId = selection.source === 'desktop'
      ? this.desktopBrowserAdapters?.select(input.desktopAdapterId)
      : '';
    if (selection.source === 'desktop' && !desktopAdapterId) {
      throw browserError(
        'Open Farming Desktop to use its native Browser view',
        503,
        'BROWSER_DESKTOP_ADAPTER_UNAVAILABLE',
      );
    }
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
    const resource = this.store.create({
      projectRootId: input.projectRootId,
      workspace: input.workspace,
      ownerAgentId: input.ownerAgentId,
      name: input.name || existingTab?.title || 'Browser',
      url: existingTab?.url || normalizeUrl(input.url),
      browserSource: selection.source,
      browserExecutablePath: selection.executablePath,
      desktopAdapterId,
      existingTabId,
      sessionName: input.sessionName
        ? normalizeBrowserSessionName(input.sessionName)
        : '',
    });
    this.emitResource(resource);
    return publicResource(resource, this.store.revision);
  }

  ensureSession(input: Record<string, unknown>) {
    this.requireEnabled();
    if (this.disposed) throw browserError('Browser manager is stopping', 503, 'BROWSER_MANAGER_STOPPING');
    const sessionName = normalizeBrowserSessionName(input.sessionName || 'default');
    const requestedSource = String(input.browserSource || '').trim();
    if (requestedSource && !BROWSER_SOURCES.has(requestedSource)) {
      throw browserError(
        `Unsupported Browser source: ${requestedSource}`,
        400,
        'BROWSER_INVALID_SOURCE',
      );
    }
    const requestedExecutablePath = String(input.browserExecutablePath || '').trim();
    const requestedTabId = normalizeExistingTabId(input.existingTabId);
    const resources = this.store.list().filter(resource => sameBrowserOwner(resource, input));
    const exact = resources.filter(resource => resource.sessionName === sessionName);
    if (exact.length > 1) {
      throw browserError(
        `Browser session ${sessionName} has multiple Resources`,
        409,
        'BROWSER_SESSION_CONFLICT',
      );
    }

    let resource = exact[0] || null;
    if (!resource && sessionName === 'default') {
      const legacy = resources
        .filter(candidate => (
          !candidate.sessionName
          && (requestedTabId === null || candidate.existingTabId === requestedTabId)
          && (!requestedSource || candidate.browserSource === requestedSource)
          && (!requestedExecutablePath || candidate.browserExecutablePath === requestedExecutablePath)
        ))
        .sort((left, right) => {
          const running = Number(['starting', 'running'].includes(right.status))
            - Number(['starting', 'running'].includes(left.status));
          return running || right.updatedAt - left.updatedAt || left.createdAt - right.createdAt;
        });
      if (legacy[0]) {
        resource = this.store.update(legacy[0].id, { sessionName });
        this.emitResource(resource);
      }
    }

    if (!resource) {
      const created = this.create({ ...input, sessionName });
      return {
        ...created,
        sessionCreated: true,
        sessionNeedsNavigation: false,
      };
    }
    if (requestedSource && resource.browserSource !== requestedSource) {
      throw browserError(
        `Browser session ${sessionName} uses source ${resource.browserSource}, not ${requestedSource}`,
        409,
        'BROWSER_SESSION_SOURCE_MISMATCH',
      );
    }
    if (requestedExecutablePath && resource.browserExecutablePath !== requestedExecutablePath) {
      throw browserError(
        `Browser session ${sessionName} uses a different executable`,
        409,
        'BROWSER_SESSION_EXECUTABLE_MISMATCH',
      );
    }
    if (requestedTabId !== null && resource.existingTabId !== requestedTabId) {
      throw browserError(
        resource.existingTabId === null
          ? `Browser session ${sessionName} is not attached to a Chrome page`
          : `Browser session ${sessionName} is attached to Chrome tab ${resource.existingTabId}`,
        409,
        'BROWSER_SESSION_TAB_MISMATCH',
      );
    }

    const requestedUrl = String(input.url || '').trim();
    const needsNavigation = Boolean(requestedUrl && ['starting', 'running'].includes(resource.status));
    if (requestedUrl && !needsNavigation) {
      resource = this.store.update(resource.id, { url: normalizeUrl(requestedUrl) });
      this.emitResource(resource);
    }
    return {
      ...publicResource(resource, this.store.revision),
      sessionCreated: false,
      sessionNeedsNavigation: needsNavigation,
    };
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
      if (this.deleteAdmissions.has(id)) {
        throw browserError('Browser is deleting', 409, 'BROWSER_DELETING');
      }
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
      const desktopNative = selection.source === 'desktop';
      let desktopAdapterId = '';
      if (desktopNative) {
        try {
          desktopAdapterId = this.desktopBrowserAdapters?.select(resource.desktopAdapterId) || '';
        } catch (error) {
          const failed = this.store.update(id, {
            status: 'failed',
            error: errorMessage(error),
          });
          this.emitResource(failed);
          throw error;
        }
      }
      if (!executable || executable.error || (!desktopNative && !executable.agentBrowserPath)) {
        const failed = this.store.update(id, {
          status: 'failed',
          error: executable?.error
            || (desktopNative
              ? 'Open Farming Desktop to use its native Browser view'
              : 'Choose a local Chromium browser or prepare the isolated Browser runtime'),
        });
        this.emitResource(failed);
        throw browserError(
          failed.error,
          503,
          desktopNative ? 'BROWSER_DESKTOP_ADAPTER_UNAVAILABLE' : 'BROWSER_EXECUTABLE_NOT_FOUND',
        );
      }
      const generation = resource.generation + 1;
      const starting = this.store.update(id, {
        status: 'starting',
        generation,
        browserKind: executable.kind,
        runtimeKind: 'agent-browser',
        ...(desktopNative ? {
          browserKind: 'desktop-native',
          desktopAdapterId,
          runtimeKind: 'desktop-native',
        } : {}),
        error: '',
        processIdentity: null,
        loading: false,
        controlEpoch: resource.controlEpoch + 1,
        controlOwner: 'agent',
      });
      this.emitResource(starting);

      const reusableSession = [...this.sessions.values()].find(session => (
        !session.closing
        && session.ownerKey === browserOwnerKey(resource)
        && session.projectRootId === resource.projectRootId
        && session.browserKind === executable.kind
        && (
          !desktopNative
          || (
            session.runtime instanceof DesktopBrowserRuntime
            && session.runtime.adapterId === desktopAdapterId
          )
        )
        && (executable.kind !== 'chrome-extension' || resource.existingTabId === null)
      ));
      if (reusableSession) {
        try {
          let running: BrowserResource | undefined;
          let binding: BrowserBinding | undefined;
          const operation = (reusableSession.actionChain || Promise.resolve())
            .catch(() => {})
            .then(async () => {
              reusableSession.runtime.setActiveResourceId?.(
                id,
                generation,
                starting.controlEpoch,
              );
              const tab = resource.existingTabId === null
                ? await reusableSession.runtime.createTab(
                  resource.url,
                  executable.kind === 'isolated-computer'
                    ? `farming-${resource.id}-g${generation}`
                    : '',
                  desktopNative ? 'agent' : undefined,
                )
                : await reusableSession.runtime.switchTab(this.matchExtensionRuntimeTab(
                  await reusableSession.runtime.listTabs(),
                  resource.existingTabId,
                ).tabId);
              binding = this.createBinding(reusableSession, {
                ...starting,
                tabId: tab.tabId,
              });
              await reusableSession.runtime.bindResourceTab?.(
                id,
                tab.tabId,
                generation,
                starting.controlEpoch,
                starting.controlOwner,
              );
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
      if (executable.kind === 'chrome-extension' && this.browserExtensionRelay) {
        externalCdpUrl = this.browserExtensionRelay.cdpUrl(resource.existingTabId ?? 'new');
      }
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
        if (desktopNative) {
          runtime = new DesktopBrowserRuntime({
            adapterId: desktopAdapterId,
            controlEpoch: starting.controlEpoch,
            generation,
            registry: this.desktopBrowserAdapters!,
            resourceId: id,
            sessionId,
          });
        } else {
          const agentBrowserPath = executable.agentBrowserPath;
          if (!agentBrowserPath) {
            throw browserError(
              'The selected Browser runtime is missing its managed agent-browser executable',
              503,
              'BROWSER_EXECUTABLE_NOT_FOUND',
            );
          }
          runtime = this.createRuntime({
            id: sessionId,
            generation: sessionGeneration,
            configDir: this.configDir,
            agentBrowserPath,
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
        }
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
        await runtime.bindResourceTab?.(
          id,
          tab.tabId,
          generation,
          starting.controlEpoch,
          starting.controlOwner,
        );
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
        const desktopStartUncertain = desktopNative && uncertainError(error);
        let cleanupError = null;
        if (!desktopStartUncertain) {
          try {
            await runtime.close();
          } catch (closeError) {
            cleanupError = closeError;
          }
        }
        if (!desktopStartUncertain && !cleanupError && isolatedLeaseKey && this.isolatedBrowserProvider) {
          try {
            await this.isolatedBrowserProvider.release(isolatedLeaseKey);
          } catch (releaseError) {
            cleanupError = releaseError;
          }
        }
        if (!desktopStartUncertain && !cleanupError && this.runtimes.get(id) === binding) this.runtimes.delete(id);
        if (!desktopStartUncertain && !cleanupError && this.sessions.get(sessionId) === session) this.sessions.delete(sessionId);
        if (desktopStartUncertain) session.closing = true;
        const current = this.store.get(id);
        const failureMessage = executable.kind === 'isolated-computer'
          ? `Isolated Browser connection failed: ${errorMessage(error)}`
          : desktopStartUncertain
            ? `Desktop Browser start outcome is uncertain: ${errorMessage(error)}`
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
          desktopStartUncertain ? 503 : 500,
          desktopStartUncertain ? 'BROWSER_DESKTOP_OPERATION_UNCERTAIN' : 'BROWSER_START_FAILED',
          desktopStartUncertain,
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

  stop(
    id: string,
    internal = false,
    caller: BrowserControlOwner = 'agent',
  ): Promise<unknown> {
    if (!internal) this.requireEnabled();
    this.stopAdmissions.set(id, (this.stopAdmissions.get(id) || 0) + 1);
    return this.enqueue(id, async () => {
      const resource = this.requireStored(id);
      if (
        !internal
        && caller === 'agent'
        && resource.browserSource === 'desktop'
        && resource.controlOwner === 'user'
      ) {
        throw browserError(
          'The user has control of this Browser tab. Return control to the Agent before stopping it.',
          409,
          'BROWSER_HUMAN_CONTROL_ACTIVE',
        );
      }
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
          loading: false,
          controlEpoch: resource.controlEpoch + 1,
          controlOwner: 'agent',
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
      let closeError: unknown = null;
      let isolatedReleaseError: unknown = null;
      const closeOperation = (session.actionChain || Promise.resolve())
        .catch(() => {})
        .then(async () => {
          session.runtime.setActiveResourceId?.(
            binding.id,
            binding.generation,
            resource.controlEpoch,
          );
          if (session.bindings.size === 1) return session.runtime.close();
          if (resource.browserSource === 'desktop') {
            return session.runtime.closeTab(binding.tabId);
          }
          if (resource.existingTabId === null) return session.runtime.closeTab(binding.tabId);
          if (session.runtime.activeTabId === binding.tabId) {
            const next = [...session.bindings.values()].find(candidate => candidate.id !== id);
            if (next) await session.runtime.switchTab(next.tabId);
          }
          return undefined;
        });
      session.actionChain = closeOperation;
      try {
        await closeOperation;
      } catch (error) {
        closeError = error;
      }
      if (session.bindings.size === 1 && session.isolatedLeaseKey && this.isolatedBrowserProvider) {
        try {
          await this.isolatedBrowserProvider.release(session.isolatedLeaseKey);
          session.isolatedLeaseKey = '';
        } catch (error) {
          isolatedReleaseError = error;
        }
      }
      if (
        closeError
        && !isolatedReleaseError
        && session.bindings.size === 1
        && session.browserKind === 'isolated-computer'
      ) {
        try {
          await this.forceStopIsolatedRuntime(resource);
          closeError = null;
        } catch (error) {
          closeError = new Error(
            `Browser close failed: ${errorMessage(closeError)}; exact isolated runtime cleanup failed: ${errorMessage(error)}`,
          );
        }
      }
      if (closeError || isolatedReleaseError) {
        session.closing = false;
        const failures = [
          ...(closeError ? [`Browser runtime could not be stopped: ${errorMessage(closeError)}`] : []),
          ...(isolatedReleaseError
            ? [`Browser isolated lease could not be released: ${errorMessage(isolatedReleaseError)}`]
            : []),
        ];
        const failed = this.store.update(id, {
          status: 'failed',
          error: failures.join('; '),
        });
        this.emitResource(failed);
        this.broadcastRuntimeState(binding);
        throw browserError(
          failed.error,
          500,
          closeError ? 'BROWSER_STOP_FAILED' : 'ISOLATED_BROWSER_RELEASE_FAILED',
        );
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
        loading: false,
        controlEpoch: resource.controlEpoch + 1,
        controlOwner: 'agent',
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

  removeBrowserProfile(
    resource: BrowserResource,
    excludedLegacyIds: Set<string> = new Set(),
  ): void {
    const sessionId = resource.sessionId || resource.id;
    const sessionStillReferenced = this.store.list().some(candidate => (
      candidate.sessionId === sessionId
    )) || this.store.listLegacyProjectResources().some(candidate => (
      !excludedLegacyIds.has(candidate.id) && (candidate.sessionId || candidate.id) === sessionId
    ));
    const profileDir = storageLayout.browserProfileDir(this.configDir, sessionId);
    const browsersDir = path.resolve(storageLayout.browserResourcesDir(this.configDir));
    const resourceDir = path.resolve(profileDir, '..');
    if (
      !sessionStillReferenced
      && resourceDir.startsWith(`${browsersDir}${path.sep}`)
      && RESOURCE_ID_RE.test(sessionId)
    ) {
      fs.rmSync(resourceDir, { recursive: true, force: true });
    }
  }

  async delete(
    id: string,
    internal = false,
    caller: BrowserControlOwner = 'agent',
  ): Promise<unknown> {
    if (!internal) this.requireEnabled();
    if (this.deleteAdmissions.has(id)) {
      throw browserError('Browser is deleting', 409, 'BROWSER_DELETING');
    }
    this.deleteAdmissions.add(id);
    try {
      await this.stop(id, internal, caller);
      const stopped = this.requireStored(id);
      const nativeSessionKey = this.desktopNativeSessionKey(stopped);
      const remove = async () => {
        const resource = this.requireStored(id);
        const ownerKey = browserOwnerKey(resource);
        const deletesLastIsolatedOwner = resource.browserKind === 'isolated-computer'
          && this.isolatedBrowserProvider
          && !this.store.list().some(candidate => (
            candidate.id !== resource.id
            && candidate.browserKind === 'isolated-computer'
            && browserOwnerKey(candidate) === ownerKey
          ));
        const deletesLastDesktopSession = Boolean(nativeSessionKey) && !this.store.list().some(candidate => (
          candidate.id !== resource.id
          && candidate.browserSource === 'desktop'
          && candidate.desktopAdapterId === resource.desktopAdapterId
          && candidate.sessionId === resource.sessionId
        ));
        if (deletesLastIsolatedOwner) {
          await this.isolatedBrowserProvider!.deleteOwner(ownerKey);
        }
        if (deletesLastDesktopSession) {
          try {
            await this.clearDesktopNativeSessionData(resource);
          } catch (error) {
            const uncertain = uncertainError(error);
            const message = uncertain
              ? `Desktop Browser native profile cleanup outcome is uncertain: ${errorMessage(error)}`
              : `Desktop Browser native profile cleanup failed: ${errorMessage(error)}`;
            const retained = this.store.update(id, {
              status: 'stopped',
              loading: false,
              processIdentity: null,
              error: message,
            });
            this.emitResource(retained);
            throw browserError(
              message,
              uncertain ? 504 : 500,
              uncertain
                ? 'BROWSER_DESKTOP_PROFILE_CLEANUP_UNCERTAIN'
                : 'BROWSER_DESKTOP_PROFILE_CLEANUP_FAILED',
              uncertain,
            );
          }
        }
        this.store.delete(id);
        this.removeBrowserProfile(resource);
        this.emit('deleted', { id, collectionRevision: this.store.revision });
        return { id, collectionRevision: this.store.revision };
      };
      return nativeSessionKey
        ? await this.enqueueNativeSessionOperation(nativeSessionKey, remove)
        : await remove();
    } finally {
      this.deleteAdmissions.delete(id);
    }
  }

  takeControl(id: string, owner: BrowserControlOwner): Promise<unknown> {
    this.requireEnabled();
    if (owner !== 'agent' && owner !== 'user') {
      throw browserError('Browser control owner is invalid', 400, 'BROWSER_INVALID_REQUEST');
    }
    const resource = this.requireStored(id);
    const binding = this.runtimes.get(id);
    if (resource.browserSource !== 'desktop' || !binding || !(binding.session.runtime instanceof DesktopBrowserRuntime)) {
      throw browserError(
        'This Browser is not running in a Farming Desktop native view',
        409,
        'BROWSER_NATIVE_CONTROL_UNAVAILABLE',
      );
    }
    if (resource.status !== 'running') {
      throw browserError('Browser is not running', 409, 'BROWSER_NOT_RUNNING');
    }
    if (resource.controlOwner === owner) {
      return Promise.resolve(publicResource(resource, this.store.revision));
    }
    if (this.stopAdmissions.has(id)) {
      throw browserError('Browser is stopping', 409, 'BROWSER_STOPPING');
    }
    if (this.isControlChanging(id)) {
      throw browserError('Browser control is changing', 409, 'BROWSER_CONTROL_CHANGING');
    }
    this.holdControlAdmission(id);
    return this.enqueue(id, async () => {
      const current = this.requireStored(id);
      const currentBinding = this.runtimes.get(id);
      if (
        !currentBinding
        || current.status !== 'running'
        || current.browserSource !== 'desktop'
        || current.generation !== currentBinding.generation
        || current.sessionId !== currentBinding.session.id
        || current.sessionGeneration !== currentBinding.session.generation
        || current.tabId !== currentBinding.tabId
      ) {
        throw browserError(
          'Browser runtime ownership changed; refresh Browser state before retrying',
          409,
          'BROWSER_STALE_GENERATION',
        );
      }
      if (current.controlOwner === owner) {
        return publicResource(current, this.store.revision);
      }
      const { session } = currentBinding;
      const transition = (session.actionChain || Promise.resolve())
        .catch(() => {})
        .then(() => this.transitionNativeControl(currentBinding, owner));
      session.actionChain = transition;
      return transition;
    }).finally(() => this.releaseControlAdmission(id));
  }

  /**
   * A native control transition has an explicit prepare/commit fence:
   *
   * 1. Electron blocks both direct page input and delayed structured commands.
   * 2. The backend atomically persists the new owner and epoch.
   * 3. Electron commits the visible handoff. A user-facing page is never
   *    unshielded before the backend owns that epoch.
   *
   * A failed commit is terminal because the adapter may have changed native
   * input state even when the transport cannot prove its outcome.
   */
  async transitionNativeControl(
    binding: BrowserBinding,
    owner: BrowserControlOwner,
  ): Promise<unknown> {
    const { id, session } = binding;
    const current = this.store.get(id);
    if (
      !current
      || current.status !== 'running'
      || current.browserSource !== 'desktop'
      || current.generation !== binding.generation
      || current.sessionId !== session.id
      || current.sessionGeneration !== session.generation
      || current.tabId !== binding.tabId
      || this.stopAdmissions.has(id)
    ) {
      throw browserError(
        'Browser runtime ownership changed; refresh Browser state before retrying',
        409,
        'BROWSER_STALE_GENERATION',
      );
    }
    if (current.controlOwner === owner) return publicResource(current, this.store.revision);
    const runtime = session.runtime;
    if (
      !runtime.prepareControl
      || !runtime.commitControl
      || !runtime.cancelControl
    ) {
      throw browserError(
        'This Browser runtime does not support native control handoff',
        409,
        'BROWSER_NATIVE_CONTROL_UNAVAILABLE',
      );
    }
    const expectedOwner = current.controlOwner;
    const expectedControlEpoch = current.controlEpoch;
    const controlEpoch = expectedControlEpoch + 1;
    try {
      await this.activateBinding(binding, expectedOwner);
    } catch (error) {
      if (uncertainError(error)) return this.failNativeControlTransition(binding, error);
      throw error;
    }
    try {
      await runtime.prepareControl({
        controlEpoch,
        expectedControlEpoch,
        expectedControlOwner: expectedOwner,
        owner,
      });
    } catch (error) {
      if (uncertainError(error)) {
        return this.failNativeControlTransition(binding, error);
      }
      throw error;
    }
    let committed: BrowserResource;
    try {
      const latest = this.store.get(id);
      if (
        !latest
        || latest.status !== 'running'
        || latest.generation !== binding.generation
        || latest.sessionId !== session.id
        || latest.sessionGeneration !== session.generation
        || latest.tabId !== binding.tabId
        || latest.controlOwner !== expectedOwner
        || latest.controlEpoch !== expectedControlEpoch
        || this.stopAdmissions.has(id)
      ) {
        throw browserError(
          'Browser ownership changed while control was transferring',
          409,
          'BROWSER_STALE_GENERATION',
        );
      }
      committed = this.store.update(id, {
        controlEpoch,
        controlOwner: owner,
      });
    } catch (error) {
      try {
        await runtime.cancelControl(owner, controlEpoch);
      } catch (cancelError) {
        if (uncertainError(cancelError)) return this.failNativeControlTransition(binding, cancelError);
      }
      throw error;
    }
    try {
      await runtime.commitControl(owner, controlEpoch);
    } catch (error) {
      return this.failNativeControlTransition(binding, error, committed);
    }
    const confirmed = this.store.get(id);
    if (
      !confirmed
      || confirmed.status !== 'running'
      || confirmed.generation !== binding.generation
      || confirmed.sessionId !== session.id
      || confirmed.sessionGeneration !== session.generation
      || confirmed.tabId !== binding.tabId
      || confirmed.controlOwner !== owner
      || confirmed.controlEpoch !== controlEpoch
    ) {
      return this.failNativeControlTransition(
        binding,
        browserError(
          'Browser ownership changed while control was committing',
          409,
          'BROWSER_STALE_GENERATION',
        ),
        committed,
      );
    }
    this.emitResource(confirmed);
    this.broadcastRuntimeState(binding);
    return publicResource(confirmed, this.store.revision);
  }

  failNativeControlTransition(
    binding: BrowserBinding,
    error: unknown,
    committed?: BrowserResource,
  ): never {
    const current = committed || this.store.get(binding.id);
    const failure = current
      ? this.store.update(binding.id, {
        error: `Desktop Browser control handoff outcome is uncertain: ${errorMessage(error)}`,
        loading: false,
        status: 'failed',
      })
      : null;
    if (failure) {
      this.emitResource(failure);
      this.broadcastRuntimeState(binding);
    }
    throw browserError(
      failure?.error || 'Desktop Browser control handoff outcome is uncertain',
      503,
      'BROWSER_DESKTOP_CONTROL_UNCERTAIN',
      true,
    );
  }

  failNativeUncertainOperation(
    binding: BrowserBinding,
    error: unknown,
  ): never {
    const current = this.store.get(binding.id);
    const failure = current
      && current.status === 'running'
      && current.browserSource === 'desktop'
      && current.generation === binding.generation
      && current.sessionId === binding.session.id
      && current.sessionGeneration === binding.session.generation
      && current.tabId === binding.tabId
      ? this.store.update(binding.id, {
        error: `Desktop Browser command outcome is uncertain: ${errorMessage(error)}`,
        loading: false,
        status: 'failed',
      })
      : null;
    if (failure) {
      this.emitResource(failure);
      this.broadcastRuntimeState(binding);
    }
    throw browserError(
      failure?.error || 'Desktop Browser command outcome is uncertain',
      503,
      'BROWSER_DESKTOP_OPERATION_UNCERTAIN',
      true,
    );
  }

  nativeUserAction(id: string, input: BrowserMessage): Promise<unknown> {
    this.requireEnabled();
    const kind = String(input?.kind || '').trim();
    const supported = new Set([
      'back',
      'forward',
      'get-zoom',
      'navigate',
      'reload',
      'reset-zoom',
      'set-zoom',
      'stop-loading',
      'zoom-in',
      'zoom-out',
    ]);
    if (!supported.has(kind)) {
      throw browserError(
        `Unsupported native Browser user action: ${kind || '(missing)'}`,
        400,
        'BROWSER_INVALID_REQUEST',
      );
    }
    const commandInput: BrowserMessage = { ...input };
    delete commandInput.kind;
    if (kind === 'navigate') commandInput.url = normalizeUrl(commandInput.url);
    return this.withRuntime(id, async (runtime, binding) => {
      if (!runtime.userAction) {
        throw browserError(
          'This Browser runtime does not support native user actions',
          409,
          'BROWSER_NATIVE_USER_ACTION_UNSUPPORTED',
        );
      }
      const result = recordValue(await runtime.userAction(kind, commandInput));
      if (['back', 'forward', 'navigate', 'reload', 'stop-loading'].includes(kind)) {
        this.updateMetadata(binding, result);
      }
      if (kind === 'stop-loading') {
        const current = this.store.get(binding.id);
        if (current && current.loading) {
          const updated = this.store.update(binding.id, { loading: false });
          this.emitResource(updated);
          this.broadcastRuntimeState(binding);
        }
      }
      const current = this.requireStored(id);
      return {
        ...publicResource(current, this.store.revision),
        ...result,
      };
    }, { caller: 'user' });
  }

  createNativeTab(id: string, input: BrowserMessage = {}): Promise<unknown> {
    this.requireEnabled();
    const resource = this.requireStored(id);
    const binding = this.runtimes.get(id);
    if (
      resource.browserSource !== 'desktop'
      || resource.status !== 'running'
      || !binding
      || !(binding.session.runtime instanceof DesktopBrowserRuntime)
    ) {
      throw browserError(
        'This Browser is not running in a Farming Desktop native view',
        409,
        'BROWSER_NATIVE_TAB_UNAVAILABLE',
      );
    }
    const url = normalizeUrl(input.url || 'about:blank');
    return this.withRuntime(id, async (runtime, activeBinding) => {
      if (!(runtime instanceof DesktopBrowserRuntime)) {
        throw browserError(
          'This Browser runtime does not support native tabs',
          409,
          'BROWSER_NATIVE_TAB_UNAVAILABLE',
        );
      }
      const { session } = activeBinding;
      const tab = await runtime.createTab(url, '', 'user');
      this.reserveNativeUserTabControl(session.id, tab.tabId);
      try {
        const tabs = await runtime.listTabs('user');
        await this.reconcileTabs(session, {
          newTabIds: [tab.tabId],
          popupAdmitted: true,
          tabs,
        });
        const createdBinding = [...session.bindings.values()]
          .find(candidate => candidate.tabId === tab.tabId);
        const created = createdBinding ? this.store.get(createdBinding.id) : null;
        if (
          !createdBinding
          || !created
          || created.status !== 'running'
          || created.browserSource !== 'desktop'
          || created.sessionId !== session.id
          || created.sessionGeneration !== session.generation
        ) {
          throw browserError(
            'Desktop Browser tab creation did not commit an owned Browser Resource',
            500,
            'BROWSER_START_FAILED',
          );
        }
        return this.transitionNativeControl(createdBinding, 'user');
      } finally {
        this.releaseReservedNativeUserTabControl(session.id, tab.tabId);
      }
    }, { caller: 'user' });
  }

  selectNativeTab(id: string): Promise<unknown> {
    this.requireEnabled();
    const resource = this.requireStored(id);
    const binding = this.runtimes.get(id);
    if (
      resource.browserSource !== 'desktop'
      || resource.status !== 'running'
      || !binding
      || !binding.session.runtime.switchTabForUser
    ) {
      throw browserError(
        'This Browser tab is not available in a Farming Desktop native view',
        409,
        'BROWSER_NATIVE_TAB_UNAVAILABLE',
      );
    }
    if (this.stopAdmissions.has(id) || this.isControlChanging(id)) {
      throw browserError('Browser is changing state', 409, 'BROWSER_BUSY');
    }
    const generation = resource.generation;
    const { session } = binding;
    const selection = (session.actionChain || Promise.resolve())
      .catch(() => {})
      .then(async () => {
        const current = this.store.get(id);
        if (
          !current
          || current.status !== 'running'
          || current.browserSource !== 'desktop'
          || current.generation !== generation
          || current.sessionId !== session.id
          || current.sessionGeneration !== session.generation
          || current.tabId !== binding.tabId
          || this.stopAdmissions.has(id)
          || this.isControlChanging(id)
        ) {
          throw browserError(
            'Browser tab selection is stale; refresh Browser state before retrying',
            409,
            'BROWSER_STALE_ADMISSION',
          );
        }
        await this.activateBinding(binding, 'user');
        return this.get(id);
      });
    const guardedSelection = selection.catch(error => {
      if (uncertainError(error)) return this.failNativeUncertainOperation(binding, error);
      throw error;
    });
    session.actionChain = guardedSelection;
    return guardedSelection;
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

  stopLoading(id: string): Promise<unknown> {
    return this.withRuntime(id, async (runtime, binding) => {
      if (!runtime.stopLoading) {
        throw browserError('This Browser runtime cannot stop the current navigation', 409, 'BROWSER_STOP_LOADING_UNSUPPORTED');
      }
      const metadata = await runtime.stopLoading();
      const next = this.store.update(binding.id, { loading: false });
      this.emitResource(next);
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
    if (kind === 'stop-loading') return this.stopLoading(id);
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
      if (resource.browserSource === 'desktop') {
        let totalBytes = 0;
        return Promise.all(files.map(async file => {
          const stat = await fs.promises.stat(file);
          if (!stat.isFile()) throw browserError(`Browser upload path is not a file: ${file}`);
          totalBytes += stat.size;
          if (totalBytes > MAX_DESKTOP_FILE_TRANSFER_BYTES) {
            throw browserError(
              `Desktop Browser uploads exceed ${MAX_DESKTOP_FILE_TRANSFER_BYTES} bytes`,
              413,
              'BROWSER_UPLOAD_TOO_LARGE',
            );
          }
          return {
            data: (await fs.promises.readFile(file)).toString('base64'),
            name: path.basename(file),
            type: 'application/octet-stream',
          };
        })).then(nativeFiles => (
          this.withRuntime(id, runtime => runtime.upload({ ...input, files: nativeFiles }))
        ));
      }
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
          const result = recordValue(await runtime.download({ ...input, outputPath: temporaryPath }));
          if (resource.browserSource === 'desktop') {
            const encoded = String(result.data || '');
            if (!encoded) throw browserError('Desktop Browser download did not return file data');
            const bytes = Buffer.from(encoded, 'base64');
            if (
              bytes.byteLength === 0
              || bytes.byteLength > MAX_DESKTOP_FILE_TRANSFER_BYTES
              || Buffer.byteLength(encoded, 'base64') !== bytes.byteLength
            ) {
              throw browserError(
                `Desktop Browser download exceeds ${MAX_DESKTOP_FILE_TRANSFER_BYTES} bytes`,
                413,
                'BROWSER_DOWNLOAD_TOO_LARGE',
              );
            }
            await fs.promises.writeFile(temporaryPath, bytes, { flag: 'wx', mode: 0o600 });
          }
          const stat = await fs.promises.stat(temporaryPath);
          if (!stat.isFile()) throw browserError('Browser download did not produce a regular file');
          await fs.promises.copyFile(temporaryPath, target, fs.constants.COPYFILE_EXCL);
          return {
            ok: true,
            path: path.relative(resource.workspace, target) || path.basename(target),
            size: stat.size,
          };
        } finally {
          await fs.promises.rm(temporaryPath, { force: true });
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
    if (resource.browserSource === 'desktop') {
      ws.send(JSON.stringify({
        type: 'browser-error',
        message: 'This Browser is presented by its leased Farming Desktop native view.',
      }));
      return () => {};
    }
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
    const resources = this.store.list();
    for (const resource of resources) {
      const owner = agents.get(resource.ownerAgentId);
      if (!owner) {
        const replacement = replacementAgentOwner(
          resource.ownerAgentId,
          resource.workspace,
          agentStates,
        );
        if (replacement) {
          this.completeAgentOwnerReplacement(resource.ownerAgentId, replacement.id);
          continue;
        }
        if (this.agentOwnerReplacementHolds.has(resource.ownerAgentId)) continue;
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

  beginAgentOwnerReplacement(sourceAgentId: string): void {
    this.agentOwnerReplacementHolds.add(sourceAgentId);
  }

  completeAgentOwnerReplacement(sourceAgentId: string, targetAgentId: string): void {
    try {
      const transferred = this.store.transferAgentOwner(sourceAgentId, targetAgentId);
      if (transferred.length === 0) return;
      const sourceOwnerKey = `agent:${sourceAgentId}`;
      const targetOwnerKey = `agent:${targetAgentId}`;
      for (const session of this.sessions.values()) {
        if (session.ownerKey === sourceOwnerKey) session.ownerKey = targetOwnerKey;
      }
      for (const resource of transferred) this.emitResource(resource);
    } finally {
      this.agentOwnerReplacementHolds.delete(sourceAgentId);
    }
  }

  cancelAgentOwnerReplacement(sourceAgentId: string): void {
    this.agentOwnerReplacementHolds.delete(sourceAgentId);
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

  enqueueNativeSessionOperation<Result>(
    sessionKey: string,
    operation: () => Promise<Result>,
  ): Promise<Result> {
    const previous = this.nativeSessionOperations.get(sessionKey) || Promise.resolve();
    const next = previous.catch(() => {}).then(operation);
    this.nativeSessionOperations.set(sessionKey, next);
    return next.finally(() => {
      if (this.nativeSessionOperations.get(sessionKey) === next) {
        this.nativeSessionOperations.delete(sessionKey);
      }
    });
  }

  desktopNativeSessionKey(resource: BrowserResource): string {
    if (
      resource.browserSource !== 'desktop'
      || !resource.desktopAdapterId
      || !resource.sessionId
    ) return '';
    return `${resource.desktopAdapterId}:${resource.sessionId}`;
  }

  async clearDesktopNativeSessionData(resource: BrowserResource): Promise<void> {
    if (
      resource.browserSource !== 'desktop'
      || !resource.desktopAdapterId
      || !resource.sessionId
      || !this.desktopBrowserAdapters
    ) {
      throw browserError(
        'Desktop Browser native profile cleanup has no exact adapter lease',
        409,
        'BROWSER_DESKTOP_PROFILE_CLEANUP_UNAVAILABLE',
      );
    }
    await this.desktopBrowserAdapters.invoke({
      adapterId: resource.desktopAdapterId,
      generation: resource.generation,
      input: { activeResourceId: resource.id },
      operation: 'clear-session-data',
      resourceId: resource.id,
      sessionId: resource.sessionId,
    });
  }

  holdControlAdmission(id: string): void {
    this.controlAdmissions.set(id, (this.controlAdmissions.get(id) || 0) + 1);
  }

  releaseControlAdmission(id: string): void {
    const next = (this.controlAdmissions.get(id) || 1) - 1;
    if (next <= 0) this.controlAdmissions.delete(id);
    else this.controlAdmissions.set(id, next);
  }

  isControlChanging(id: string): boolean {
    return (this.controlAdmissions.get(id) || 0) > 0;
  }

  reserveNativeUserTabControl(sessionId: string, tabId: string): void {
    const tabs = this.nativeUserTabAdmissions.get(sessionId) || new Map<string, string>();
    tabs.set(tabId, '');
    this.nativeUserTabAdmissions.set(sessionId, tabs);
  }

  admitReservedNativeUserTabControl(sessionId: string, tabId: string, resourceId: string): void {
    const tabs = this.nativeUserTabAdmissions.get(sessionId);
    if (!tabs || !tabs.has(tabId)) return;
    tabs.set(tabId, resourceId);
    this.holdControlAdmission(resourceId);
  }

  releaseReservedNativeUserTabControl(sessionId: string, tabId: string): void {
    const tabs = this.nativeUserTabAdmissions.get(sessionId);
    if (!tabs) return;
    const resourceId = tabs.get(tabId);
    tabs.delete(tabId);
    if (tabs.size === 0) this.nativeUserTabAdmissions.delete(sessionId);
    if (resourceId) this.releaseControlAdmission(resourceId);
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

  async activateBinding(
    binding: BrowserBinding,
    caller: BrowserControlOwner = 'agent',
  ): Promise<void> {
    const { session } = binding;
    if (!binding.tabId) throw browserError('Browser tab is unavailable', 409, 'BROWSER_TAB_UNAVAILABLE');
    const resource = this.store.get(binding.id);
    session.runtime.setActiveResourceId?.(
      binding.id,
      binding.generation,
      resource?.controlEpoch,
    );
    if (caller === 'agent' && session.runtime instanceof DesktopBrowserRuntime) {
      // Native commands carry the exact Resource id and can therefore target a
      // hidden tab without taking over the user-visible selected tab. Keeping
      // the presentation selection stable prevents an Agent action in another
      // tab from stealing a user-controlled native view.
      return;
    }
    if (
      session.runtime.activeTabId !== binding.tabId
      || session.runtime.streamTabId !== binding.tabId
    ) {
      if (caller === 'user') {
        if (!session.runtime.switchTabForUser) {
          throw browserError(
            'This Browser runtime does not support native user tab selection',
            409,
            'BROWSER_NATIVE_USER_ACTION_UNSUPPORTED',
          );
        }
        await session.runtime.switchTabForUser(binding.tabId);
      } else {
        await session.runtime.switchTab(binding.tabId);
      }
    }
    session.activeResourceId = binding.id;
  }

  withRuntime<Result>(
    id: string,
    operation: (runtime: BrowserRuntime, binding: BrowserBinding) => Promise<Result> | Result,
    options: { caller?: BrowserControlOwner } = {},
  ): Promise<Result> {
    const caller = options.caller || 'agent';
    const binding = this.runtimes.get(id);
    const resource = this.requireStored(id);
    if (!binding || resource.status !== 'running') {
      throw browserError('Browser is not running', 409, 'BROWSER_NOT_RUNNING');
    }
    if (this.stopAdmissions.has(id)) {
      throw browserError('Browser is stopping', 409, 'BROWSER_STOPPING');
    }
    if (this.isControlChanging(id)) {
      throw browserError('Browser control is changing', 409, 'BROWSER_CONTROL_CHANGING');
    }
    if (resource.browserSource === 'desktop' && resource.controlOwner !== caller) {
      throw browserError(
        caller === 'agent'
          ? 'The user has control of this Browser tab. Return control to the Agent before retrying.'
          : 'The Agent controls this Browser tab. Take control before using the native toolbar.',
        409,
        caller === 'agent'
          ? 'BROWSER_HUMAN_CONTROL_ACTIVE'
          : 'BROWSER_AGENT_CONTROL_ACTIVE',
      );
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
    const admittedControlEpoch = resource.controlEpoch;
    const { session } = binding;
    const next = (session.actionChain || Promise.resolve())
      .catch(() => {})
      .then(async () => {
        const current = this.store.get(id);
        if (
          !current
          || current.status !== 'running'
          || current.generation !== binding.generation
          || current.sessionId !== binding.session.id
          || current.sessionGeneration !== binding.session.generation
          || current.tabId !== binding.tabId
          || current.controlEpoch !== admittedControlEpoch
          || (current.browserSource === 'desktop' && current.controlOwner !== caller)
          || this.stopAdmissions.has(id)
          || this.isControlChanging(id)
        ) {
          throw browserError(
            'Browser ownership changed before this action ran; refresh Browser state before retrying.',
            409,
            'BROWSER_STALE_ADMISSION',
          );
        }
        await this.activateBinding(binding, caller);
        return operation(session.runtime, binding);
      });
    const guarded = next.catch(error => {
      if (
        uncertainError(error)
        && resource.browserSource === 'desktop'
        && session.runtime instanceof DesktopBrowserRuntime
      ) {
        return this.failNativeUncertainOperation(binding, error);
      }
      throw error;
    });
    session.actionChain = guarded;
    return guarded;
  }

  runtimeEventBinding(
    session: BrowserSession,
    runtime: BrowserRuntime,
    value: { generation?: number; resourceId?: string; tabId?: string },
  ): BrowserBinding | null {
    const resourceId = String(value.resourceId || '');
    const binding = resourceId
      ? session.bindings.get(resourceId)
      : [...session.bindings.values()]
        .find(candidate => candidate.tabId === runtime.activeTabId)
        || session.bindings.get(session.activeResourceId);
    if (!binding) return null;
    if (
      value.generation !== undefined
      && value.generation !== binding.generation
    ) return null;
    if (value.tabId && binding.tabId && value.tabId !== binding.tabId) return null;
    return binding;
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
      const binding = this.runtimeEventBinding(session, runtime, metadata);
      if (binding) this.updateMetadata(binding, metadata);
    });
    runtime.on('loading', (event: BrowserLoadingEvent | boolean) => {
      const loading = typeof event === 'boolean' ? event : event.loading === true;
      const binding = this.runtimeEventBinding(
        session,
        runtime,
        typeof event === 'boolean' ? {} : event,
      );
      const current = binding ? this.store.get(binding.id) : null;
      if (!binding || !current || current.loading === loading) return;
      const next = this.store.update(binding.id, { loading });
      this.emitResource(next);
      this.broadcastRuntimeState(binding);
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
      const details = recordValue(error);
      const message = errorMessage(details.message || error) || 'Browser runtime failed';
      const binding = this.runtimeEventBinding(session, runtime, {
        generation: Number.isSafeInteger(Number(details.generation))
          ? Number(details.generation)
          : undefined,
        resourceId: String(details.resourceId || ''),
        tabId: String(details.tabId || ''),
      });
      const bindings = binding ? [binding] : [...session.bindings.values()];
      for (const currentBinding of bindings) {
        const current = this.store.get(currentBinding.id);
        if (
          current
          && current.browserSource === 'desktop'
          && current.generation === currentBinding.generation
          && current.error !== message
        ) {
          const next = this.store.update(currentBinding.id, { error: message });
          this.emitResource(next);
          this.broadcastRuntimeState(currentBinding);
        }
        for (const viewer of currentBinding.viewers) {
          if (viewer.readyState === 1) {
            viewer.send(JSON.stringify({ type: 'browser-error', message }));
          }
        }
      }
    });
    runtime.on('tab-exit', (event: unknown) => {
      void this.handleNativeTabExit(session, recordValue(event));
    });
    runtime.on('disconnected', (message: string) => {
      if (this.sessions.get(session.id) !== session || session.closing) return;
      for (const binding of session.bindings.values()) {
        const current = this.store.get(binding.id);
        if (
          !current
          || current.status !== 'running'
          || current.generation !== binding.generation
          || current.sessionId !== session.id
          || current.sessionGeneration !== session.generation
        ) continue;
        const reconnecting = this.store.update(binding.id, {
          status: 'reconnecting',
          error: message || 'Browser connection interrupted; reconnecting',
        });
        this.emitResource(reconnecting);
        this.broadcastRuntimeState(binding);
      }
    });
    runtime.on('connected', () => {
      if (this.sessions.get(session.id) !== session || session.closing) return;
      for (const binding of session.bindings.values()) {
        const current = this.store.get(binding.id);
        if (
          !current
          || current.status !== 'reconnecting'
          || current.generation !== binding.generation
          || current.sessionId !== session.id
          || current.sessionGeneration !== session.generation
        ) continue;
        const running = this.store.update(binding.id, {
          status: 'running',
          error: '',
        });
        this.emitResource(running);
        this.broadcastRuntimeState(binding);
      }
    });
    runtime.once('exit', (message: string) => {
      void this.handleRuntimeExit(session, message);
    });
  }

  async handleNativeTabExit(
    session: BrowserSession,
    event: Record<string, unknown>,
  ): Promise<void> {
    if (
      this.sessions.get(session.id) !== session
      || session.closing
      || !(session.runtime instanceof DesktopBrowserRuntime)
    ) return;
    const resourceId = String(event.resourceId || '');
    const generation = Number(event.generation);
    const binding = session.bindings.get(resourceId);
    if (
      !binding
      || !Number.isSafeInteger(generation)
      || binding.generation !== generation
    ) return;
    const current = this.store.get(binding.id);
    if (
      !current
      || current.generation !== binding.generation
      || current.sessionId !== session.id
      || current.sessionGeneration !== session.generation
    ) return;
    session.bindings.delete(binding.id);
    if (session.activeResourceId === binding.id) {
      session.activeResourceId = session.bindings.values().next().value?.id || '';
    }
    if (this.runtimes.get(binding.id) === binding) this.runtimes.delete(binding.id);
    const failed = this.store.update(binding.id, {
      controlEpoch: current.controlEpoch + 1,
      controlOwner: 'agent',
      error: String(event.message || 'Desktop Browser tab closed unexpectedly'),
      loading: false,
      status: 'failed',
      tabId: '',
    });
    this.emitResource(failed);
    this.broadcastRuntimeState(binding);
    this.releaseViewerState(binding);
    if (session.bindings.size > 0) return;
    session.closing = true;
    this.sessions.delete(session.id);
    try {
      await session.runtime.close();
    } catch {
      // The owned tab was already destroyed; the failed Resource remains explicit.
    }
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
        const ownerResource = (opener ? this.store.get(opener.id) : null)
          || this.store.list().find(resource => resource.sessionId === session.id);
        if (!ownerResource) {
          throw new Error(`Browser Session ${session.id} has no Agent-owned Resource`);
        }
        const created = this.store.createRunningTab({
          projectRootId: ownerResource.projectRootId,
          ownerAgentId: ownerResource.ownerAgentId,
          workspace: ownerResource.workspace,
          name: tabResourceName(tab),
          url: tab.url,
          title: tab.title,
          browserKind: session.browserKind,
          browserSource: ownerResource.browserSource,
          browserExecutablePath: ownerResource.browserExecutablePath,
          desktopAdapterId: ownerResource.desktopAdapterId,
          controlEpoch: tab.controlEpoch,
          controlOwner: tab.controlOwner === 'user' ? 'user' : 'agent',
          runtimeKind: ownerResource.runtimeKind,
          sessionId: session.id,
          sessionGeneration: session.generation,
          tabId: tab.tabId,
        });
        binding = this.createBinding(session, created);
        session.bindings.set(created.id, binding);
        this.runtimes.set(created.id, binding);
        await session.runtime.bindResourceTab?.(
          created.id,
          tab.tabId,
          binding.generation,
          created.controlEpoch,
          created.controlOwner,
        );
        byTabId.set(tab.tabId, binding);
        this.admitReservedNativeUserTabControl(session.id, tab.tabId, created.id);
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
    if (this.sessions.get(session.id) !== session || session.closing) return;
    const failedBindings = [...session.bindings.values()];
    for (const binding of failedBindings) {
      const current = this.store.get(binding.id);
      if (!current) continue;
      const failed = this.store.update(binding.id, {
        status: 'failed',
        error: current.browserKind === 'isolated-computer'
          ? 'Isolated Browser connection exited'
          : message || 'Browser connection exited',
        ...(current.runtimeKind === 'desktop-native' ? {
          controlEpoch: current.controlEpoch + 1,
          controlOwner: 'agent',
          loading: false,
          tabId: '',
        } : {}),
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
