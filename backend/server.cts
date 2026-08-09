import type { ClientMessage } from '../shared/browser-protocol.js';
import type { Dirent } from 'fs';
import type { AuthAccessMode } from './auth.cjs';
import type { AgentSession } from './agent-session-history.cjs';
import type { AgentSessionInventoryMetadata } from './agent-session-inventory.cjs';
import type { ForkMode, KillAgentResult } from './agent-manager-lifecycle-types.js';
import type { AcpConfigValue } from './agent-manager-provider-types.js';
import type { AgentRecord, ProjectMembershipPatch } from './agent-manager-record-types.js';

type ServerClientMessage = ClientMessage;

interface ServerRecord {
  [key: string]: unknown;
  absolutePath?: string;
  acpHistoryMode?: string;
  agentId?: string;
  agentRuntimeMode?: string;
  allowUnarchiveArchived?: boolean;
  archived?: boolean;
  asMain?: boolean;
  autoReadInitialAttention?: boolean;
  codex?: readonly ServerRecord[];
  customTitle?: string;
  displayPinned?: boolean;
  error?: string;
  fork?: boolean;
  id?: string;
  isDirectory?: () => boolean;
  isFile?: () => boolean;
  kind?: string;
  launchPermissionMode?: string;
  name?: string;
  projectLabel?: string;
  provider?: string;
  providerHomeId?: string;
  providerSessionKey?: string;
  readAttentionSeq?: number;
  readingAnchor?: string;
  readOutputEpoch?: string;
  readOutputSeq?: number;
  rememberMainPageSession?: boolean;
  restarted?: boolean;
  restartedAgentId?: string;
  sessionId?: string;
  switchFailed?: boolean;
  task?: string;
  warning?: string;
  workspace?: string;
}

type AgentStartCallback = NonNullable<Parameters<AgentManager['startAgent']>[2]>;
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function requiredString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function isAcpConfigValue(value: unknown): value is AcpConfigValue {
  return value === null
    || ['string', 'number', 'boolean'].includes(typeof value)
    || (Array.isArray(value) && value.every(item => typeof item === 'string'));
}

function isForkMode(value: string): value is ForkMode {
  return value === 'conversation' || value === 'same-worktree' || value === 'new-worktree';
}

interface HttpRequest {
  authAccessMode?: AuthAccessMode;
  body: ServerRecord;
  headers: Record<string, string | string[] | undefined>;
  originalUrl: string;
  method: string;
  params: Record<string, string>;
  path: string;
  protocol: string;
  query: ServerRecord;
  socket?: { remoteAddress?: string };
  url: string;
  get(name: string): string | undefined;
  off(event: string, listener: () => void): void;
  once(event: string, listener: () => void): void;
}

interface HttpResponse {
  destroyed: boolean;
  headersSent: boolean;
  writableEnded: boolean;
  cookie(name: string, value: string, options?: object): HttpResponse;
  json(value: unknown): HttpResponse;
  redirect(location: string): void;
  redirect(status: number, location: string): void;
  end(value?: unknown): void;
  off(event: string, listener: () => void): void;
  once(event: string, listener: () => void): void;
  send(...values: unknown[]): HttpResponse;
  sendFile(filePath: string, options?: object, callback?: (error?: Error) => void): void;
  set(name: string, value: string): HttpResponse;
  setHeader(name: string, value: string): void;
  status(code: number): HttpResponse;
  type(value: string): HttpResponse;
}

type HttpHandler = (request: HttpRequest, response: HttpResponse, next?: () => void) => unknown;

interface HttpApplication extends HttpHandler {
  delete(path: string | string[], ...handlers: HttpHandler[]): HttpApplication;
  get(path: string | string[], ...handlers: HttpHandler[]): HttpApplication;
  patch(path: string | string[], ...handlers: HttpHandler[]): HttpApplication;
  post(path: string | string[], ...handlers: HttpHandler[]): HttpApplication;
  use(pathOrHandler: string | HttpHandler | unknown, ...handlers: unknown[]): HttpApplication;
}

interface ExpressFactory {
  (): HttpApplication;
  json(options?: object): HttpHandler;
  raw(options?: object): HttpHandler;
  static(root: string, options?: object): HttpHandler;
}

interface WebSocketClient {
  accessMode?: AuthAccessMode;
  agentId?: string;
  agentActivityAllCheckpointPending?: boolean;
  agentActivityCheckpointPending?: boolean;
  agentActivityRecoveryTimer?: ReturnType<typeof setTimeout> | null;
  agentActivityResyncPending?: boolean;
  activityScope?: 'all' | 'focused' | 'none';
  activityScopeDeclared?: boolean;
  bufferedAmount: number;
  acpRevisionCheckpointPending?: boolean;
  acpRevisionSentRevision?: number;
  connectionId?: string;
  focusedAgentId?: string | null;
  previewHydrationPending?: boolean;
  previewHydrationTimer?: ReturnType<typeof setTimeout> | null;
  previewScope?: 'none' | 'focused' | 'all';
  previewScopeDeclared?: boolean;
  protocolVersion?: number;
  readyState: number;
  resourceSnapshotPending?: boolean;
  initialStateSnapshotSent?: boolean;
  initialStateSnapshotTimer?: ReturnType<typeof setTimeout> | null;
  stateSnapshotMessageBytes?: number;
  stateSnapshotMessages?: DeferredAgentStateMessage[];
  stateSnapshotInProgress?: boolean;
  stateSnapshotOverflowed?: boolean;
  stateSnapshotPending?: boolean;
  stateSnapshotRetryTimer?: ReturnType<typeof setTimeout> | null;
  stateScope?: 'all' | 'focused';
  streamScope?: 'focused' | 'all';
  close(code?: number, reason?: string): void;
  send(data: string): void;
  terminate(): void;
  off(event: string, listener: (...args: never[]) => void): WebSocketClient;
  on(event: string, listener: (...args: never[]) => void): WebSocketClient;
  once(event: string, listener: (...args: never[]) => void): WebSocketClient;
}

interface ServerError extends Error {
  code?: string;
  statusCode?: number;
  stderr?: string;
  uncertain?: boolean;
}

function caughtError(error: unknown): ServerError {
  if (error instanceof Error) return error as ServerError;
  const normalized = new Error(String(error)) as ServerError;
  if (error && typeof error === 'object') Object.assign(normalized, error);
  return normalized;
}

interface ResumeOptions {
  acpHistoryMode?: string;
  agentRuntimeMode?: string;
  allowUnarchiveArchived?: boolean;
  asMain?: boolean;
  autoReadInitialAttention?: boolean;
  customTitle?: string;
  fork?: boolean;
  providerHomeId?: string;
  rememberMainPageSession?: boolean;
}

interface ResumeAgentResult {
  agentId?: string;
  archived?: boolean;
  claimed?: boolean;
  error?: string;
  pending?: boolean;
  projectWorkspace?: string;
  reused?: boolean;
  status?: number;
}

interface WebSocketServer {
  clients: Set<WebSocketClient>;
  close(): void;
  on(event: 'connection', listener: (socket: WebSocketClient, request: HttpRequest) => void): void;
}

interface WebSocketModule {
  OPEN: number;
  Server: new(options: { server: unknown }) => WebSocketServer;
}

const express = require('express') as unknown as ExpressFactory;
const compression = require('compression');
const WebSocket = require('ws') as unknown as WebSocketModule;
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { URLSearchParams, pathToFileURL } = require('url');
import { AgentManager, type AgentManagerStateChange } from './agent-manager.cjs';
import { isAgentRuntimeModeRequest, runtimeKind } from './agent-runtime-binding.cjs';
import { ConfigManager } from './config-manager.cjs';
import { ThemeManager } from './theme-manager.cjs';
import { createThemeRouter } from './theme-router.cjs';
import { createQrShareRouter, entryPathWithQuery } from './qr-share-router.cjs';
import {
  createClientMessageRegistration,
  defineClientMessageDispatchTable,
  dispatchClientMessage,
} from './websocket-client-dispatch.cjs';
import { createWorkspaceFileWatchController } from './websocket-workspace-file-watch.cjs';
import { createWebSocketHandshakeHealthHandlers } from './websocket-handshake-health-handlers.cjs';
import { createWebSocketTerminalHandlers } from './websocket-terminal-handlers.cjs';
import { createWebSocketFocusScopeHandlers } from './websocket-focus-scope-handlers.cjs';
import { TokenAuth } from './auth.cjs';
import { readOnlyClientMessageAllowed } from './read-only-access.cjs';
import { getLocalIPs, getPrimaryLocalIP } from './network.cjs';
import { listAvailableAgents, resolveTerminalCodexExecutable } from './executable-discovery.cjs';
import { readClaudeSettingsSummary } from './claude-settings.cjs';
import { listCodexModelOptions } from './codex-models.cjs';
import { readProviderHomeConfiguration } from './provider-home-configuration.cjs';
import { applyProviderHomeEnvironment, getProviderAdapter, providerCapabilities, providerConversationForkCapability } from './provider-adapters.cjs';
import { listCodexSessions } from './codex-session-history.cjs';
import { buildAgentSessionResumeCommand, findAgentSession, isSafeSessionId, normalizeProvider, resolveCodexResumeModelProvider } from './agent-session-history.cjs';
import { findActiveAgentClaimingSession, mainPageAgentSessionKey, mainPageAgentSessionFromKey, mainPageAgentSessionsToAutoResume, resumedAgentSource } from './main-page-session.cjs';
import { discoverAgentWorkspaces } from './workspace-discovery.cjs';
import { inspectGitWorktree } from './git-worktree-info.cjs';
import { createWorkspaceDirectoryRouter } from './workspace-directory.cjs';
import { createWorkspacePickerRouter } from './workspace-picker-router.cjs';
import { createControlRouter } from './control-api.cjs';
import { createAcpTerminalResizeHandler } from './acp-terminal-resize-handler.cjs';
import { WorkspaceFileService, WorkspaceFileError } from './workspace-file-service.cjs';
import { createWorkspaceFileRouter, resolveWorkspaceRoot } from './workspace-file-router.cjs';
import { WorkspaceRootRegistry, rootIdForPath } from './workspace-root-registry.cjs';
import { BrowserResourceManager, createBrowserRouter } from '../extensions/browser/backend/index.cjs';
import {
  ComputerResourceManager,
  IsolatedBrowserProvider,
  createComputerRouter,
} from '../extensions/computer/backend/index.cjs';
import {
  LanguageServerService,
  ManagedLanguageServerManager,
  createLanguageServerRouter,
  type ManagedLanguageServerRefreshEvent,
} from '../extensions/language-server/backend/index.cjs';
import { UsageMonitor } from './usage-monitor.cjs';
import { createUsageRouter } from './usage-router.cjs';
import { CodexContextWindowReader } from './codex-context-window.cjs';
import { AsyncCache } from './async-cache.cjs';
import { getMainAgentSkillsCatalog } from './main-agent-skills.cjs';
import { AgentExtensionInventory } from './agent-extension-inventory.cjs';
import { AgentSessionInventory } from './agent-session-inventory.cjs';
import { createAgentSessionRouter } from './agent-session-router.cjs';
import { createSlashCommandDiscoveryCache } from './slash-command-cache.cjs';
import { agentExtensionInventoryCacheFile, agentSessionInventoryCacheFile } from './storage-layout.cjs';
import { FarmingUpdateService } from './update-service.cjs';
import { createUpdateRouter } from './update-router.cjs';
import { cleanupTerminalRuntime } from './terminal-runtime-cleanup.cjs';
import {
  advanceAgentStateBroadcast,
  advanceAgentStateMutation,
  agentStateClientDelivery,
  agentStateDeltaForScope,
  agentStateVisibleToInteractiveClients,
  agentStateBroadcastInventorySummary,
  agentStateBroadcastSnapshotForScope,
  agentStateBroadcastProjectSummaries,
  agentStateScopeIncludesAgent,
  agentStateSnapshotFrames,
  createAgentStateBroadcastTracker,
  normalizeAgentStateScope,
  type AgentStatePayload,
} from './agent-state-broadcast-protocol.cjs';
import {
  deferAgentStateMessageDuringSnapshot,
  deliverDeferredAgentStateMessage,
  type DeferredAgentStateMessage,
} from './agent-state-snapshot-delivery.cjs';
import { createWebSocketResourceBroadcastController } from './websocket-resource-broadcasts.cjs';
import {
  agentActivityClientDelivery,
  normalizeAgentActivityScope,
} from './agent-activity-delivery.cjs';
import { acpRevisionClientDelivery } from './acp-revision-delivery.cjs';
import {
  cancelSessionPreviewHydration,
  declareSessionPreviewScope,
  normalizeSessionPreviewScope,
  queueSessionPreviewHydration,
  sessionPreviewScopeIncludesAgent,
} from './session-preview-delivery.cjs';
import { QrShareTicketStore, SHARE_TICKET_TTL_MS } from './qr-share-tickets.cjs';
import { ReviewStateStore } from './review-state-store.cjs';
import { createReviewStateRouter } from './review-state-router.cjs';
import { ReviewDiffService } from './review-diff-service.cjs';
import { createReviewDiffRouter } from './review-diff-router.cjs';
import { ReviewSessionStore } from './review-session-store.cjs';
import { ReviewSessionService } from './review-session-service.cjs';
import { createReviewSessionRouter } from './review-session-router.cjs';
import { applyIndexHtmlAppearance, normalizeBasePath, routePath, rewriteIndexHtmlForBasePath, appendIndexHtmlAssetToken } from './index-html.cjs';
import { decodeAcpTranscriptMedia } from './acp-transcript.cjs';
import { deliverSessionStreamToClients } from './session-stream-protocol.cjs';
import {
  createWebSocketSessionStreamBroadcasts,
  type SessionStream,
} from './websocket-session-stream-broadcasts.cjs';
const {
  MIN_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
  sanitizeAgentUpdatePatch,
  validateClientMessage,
} = require('../shared/browser-protocol');
const {
  initializeWebSocketLiveness,
  startWebSocketLivenessMonitor,
} = require('../shared/websocket-liveness.js');
import { probeAgentManagerBusinessHealth } from './business-health.cjs';

if (require.main === module && process.env.NODE_ENV !== 'test') {
  console.error('Direct backend/server.cjs startup is unsupported; use `farming start` or `npm start`.');
  process.exit(1);
}

const BASE_PATH = normalizeBasePath(process.env.FARMING_BASE_PATH || '/');
const PORT = process.env.PORT || 3000;
const tokenAuth = new TokenAuth({ basePath: BASE_PATH || '/' });
const authEnabled = tokenAuth.isEnabled();
const WS_PATH = routePath(BASE_PATH, '/ws');
const SERVER_EPOCH = crypto.randomUUID();
const DEFAULT_TRANSCRIPT_MAX_TURNS = 240;
const MIN_TRANSCRIPT_TURNS = 5;
const MAX_TRANSCRIPT_TURNS = 1000;
const INTERACTIVE_REFRESH_CACHE_MAX_AGE_MS = 3_000;
const execFileAsync = promisify(execFile);

const app = express();
app.use(compression());
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const websocketLivenessTimer = startWebSocketLivenessMonitor(wss, { openState: WebSocket.OPEN });
server.on('close', () => clearInterval(websocketLivenessTimer));

const configManager = new ConfigManager();
configManager.init();
const agentSessionInventory = new AgentSessionInventory({
  cacheFile: agentSessionInventoryCacheFile(configManager.farmingDir),
});
const agentExtensionInventory = new AgentExtensionInventory({
  cacheFile: agentExtensionInventoryCacheFile(configManager.farmingDir),
});

function resolveCliBinDir() {
  if (process.env.FARMING_CLI_BIN_DIR) {
    return process.env.FARMING_CLI_BIN_DIR;
  }
  if (process.pkg || process.env.FARMING_PACKAGED_RUNTIME === '1') {
    return path.dirname(process.execPath);
  }
  return path.join(__dirname, '..', 'bin');
}

const computerResourceManager = new ComputerResourceManager({
  configDir: configManager.farmingDir,
  getSettings: () => configManager.getSettings(),
  isEnabled: () => configManager.getSettings().computerExtensionEnabled === true,
});
const isolatedBrowserProvider = new IsolatedBrowserProvider({
  configDir: configManager.farmingDir,
  computerResourceManager,
});
const browserResourceManager = new BrowserResourceManager({
  configDir: configManager.farmingDir,
  isEnabled: () => configManager.getSettings().browserExtensionEnabled === true,
  getBrowserSettings: () => configManager.getSettings(),
  saveBrowserSelection: selection => configManager.updateSettings({
    browserSource: selection.source,
    browserExecutablePath: selection.executablePath,
  }),
  isolatedBrowserProvider,
});

function broadcastLanguageServerRefresh(event: ManagedLanguageServerRefreshEvent) {
  const message = languageServerRefreshMessage(event);
  for (const client of wss.clients) {
    if (client.readyState !== WebSocket.OPEN || client.protocolVersion !== PROTOCOL_VERSION) continue;
    client.send(message);
  }
}

function languageServerRefreshMessage(event: ManagedLanguageServerRefreshEvent) {
  return JSON.stringify({
    type: 'language-server-refresh',
    serverEpoch: SERVER_EPOCH,
    rootId: rootIdForPath(event.workspaceRoot),
    workspace: event.workspaceRoot,
    kind: event.kind,
    revision: event.revision,
  });
}

const managedLanguageServerManager = new ManagedLanguageServerManager({
  configDir: configManager.farmingDir,
  onRefresh: broadcastLanguageServerRefresh,
});

function sendLanguageServerRefreshSnapshot(ws: WebSocketClient) {
  if (ws.readyState !== WebSocket.OPEN || ws.protocolVersion !== PROTOCOL_VERSION) return;
  managedLanguageServerManager.refreshSnapshot().forEach(event => {
    ws.send(languageServerRefreshMessage(event));
  });
}

const languageServerService = new LanguageServerService(managedLanguageServerManager);
server.on('close', () => {
  void languageServerService.dispose();
});

const agentManager = new AgentManager(
  configManager,
  {
  controlUrl: `http://127.0.0.1:${PORT}${BASE_PATH}`,
  tokenFile: tokenAuth.getTokenFile(),
  authDisabled: !authEnabled,
  cliBinDir: resolveCliBinDir(),
  transcriptMediaPathPrefix: agentId => routePath(
    BASE_PATH,
    `/api/agents/${encodeURIComponent(agentId)}/acp-media`,
  ),
  },
);

async function requireAgentRecoveryForHttp(res: HttpResponse) {
  try {
    await agentManager.whenRecovered();
    return true;
  } catch (caught) {
    const error = caughtError(caught);
    res.status(503).json({
      error: error?.message || 'Agent lifecycle recovery is unavailable',
      retryable: true,
    });
    return false;
  }
}

const themeManager = new ThemeManager({ configDir: configManager.farmingDir });
const workspaceFileService = new WorkspaceFileService();
const workspaceRootRegistry = new WorkspaceRootRegistry(
  agentManager,
);
const workspaceFileWatchController = createWorkspaceFileWatchController({
  openState: WebSocket.OPEN,
  resolveRoot: agentId => resolveWorkspaceRoot(agentManager, agentId),
  subscribe: (root, onEvent) => workspaceFileService.subscribe(root, event => onEvent({ ...event })),
  logCleanupError: error => {
    console.error('Failed to clear workspace file watch:', error);
  },
  watchErrorMessage: error => (
    error instanceof WorkspaceFileError ? caughtError(error).message : null
  ),
});
let agentResourceReconcileRequested = false;
let agentResourceReconcileRunning = false;
const reconcileAgentResourceLifecycle = () => {
  agentResourceReconcileRequested = true;
  if (agentResourceReconcileRunning) return;
  agentResourceReconcileRunning = true;
  void (async () => {
    try {
      while (agentResourceReconcileRequested) {
        agentResourceReconcileRequested = false;
        await agentManager.whenRecovered();
        const agents = agentManager.getState().agents;
        await browserResourceManager.reconcileAgentLifecycle(Array.isArray(agents) ? agents : []);
        await computerResourceManager.reconcileAgentLifecycle(Array.isArray(agents) ? agents : []);
      }
    } catch (error) {
      agentResourceReconcileRequested = false;
      const caught = caughtError(error);
      if (!caught.message.startsWith('Agent lifecycle recovery failed:')) {
        console.warn('Failed to reconcile Agent-owned resources:', caught.message || error);
      }
    } finally {
      agentResourceReconcileRunning = false;
      if (agentResourceReconcileRequested) reconcileAgentResourceLifecycle();
    }
  })();
};
const computerRuntimeRecoveryPromise = computerResourceManager.init().catch((error: unknown) => {
  console.warn('Failed to recover Computer runtimes:', caughtError(error).message || error);
  return null;
});
const browserRuntimeRecoveryPromise = computerRuntimeRecoveryPromise
  .then(() => isolatedBrowserProvider.recover())
  .then(() => browserResourceManager.init())
  .then(() => {
    agentManager.on('update', reconcileAgentResourceLifecycle);
    reconcileAgentResourceLifecycle();
  }).catch((error: unknown) => {
    console.warn('Failed to recover Browser runtimes:', caughtError(error).message || error);
    return null;
  });
const updateService = new FarmingUpdateService({
  rootDir: path.join(__dirname, '..'),
  configDir: configManager.farmingDir,
  platform: process.platform,
  arch: process.arch,
  packagedRuntime: Boolean(process.pkg || process.env.FARMING_PACKAGED_RUNTIME === '1'),
});
const usageMonitor = new UsageMonitor({
  agentManager,
  configDir: configManager.farmingDir,
  getProviderHomes: configuredProviderHomes,
});
const codexContextWindowReader = new CodexContextWindowReader();
const usageSummaryCache = new AsyncCache(() => usageMonitor.getUsageSummary(), {
  ttlMs: 15_000,
  staleMs: 2 * 60_000,
});
const codexModelOptionsCache = new AsyncCache((homePath: string) => listCodexModelOptions({
  env: applyProviderHomeEnvironment({ ...process.env }, 'codex', homePath),
}), {
  ttlMs: 5 * 60_000,
  staleMs: 5 * 60_000,
});
function configuredProviderMetadata() {
  const result: Record<string, Array<{ id: string; path: string }>> = {};
  const settings = configManager.getSettings();
  const records = configManager.listAgentSessionRecords();
  const homeBindings = configManager.agentHomeBindings(records);
  const providers = Object.keys(settings.agentHomes || {});
  for (const provider of providers) {
    result[provider] = configManager.getKnownAgentHomes(provider, homeBindings).map(home => ({
      id: String(home.id || 'default'),
      path: String(home.path || ''),
    })).filter(home => home.id && home.path);
  }
  const providerSessionBindings = records.flatMap(record => {
    const provider = String(record.provider || '').trim().toLowerCase();
    const providerHomeId = String(record.providerHomeId || 'default').trim() || 'default';
    const providerHomePath = configManager.expandWorkspacePath(String(record.providerHomePath || ''));
    const providerSessionId = String(record.providerSessionId || '').trim();
    return provider && providerHomePath && providerSessionId && record.providerSessionTemporary !== true
      ? [{ provider, providerHomeId, providerHomePath, providerSessionId }]
      : [];
  });
  return { providerHomes: result, providerSessionBindings };
}

function configuredProviderHomes() {
  return configuredProviderMetadata().providerHomes;
}

function requestedProviderHome(provider: string, rawHomeId: unknown) {
  const homeId = typeof rawHomeId === 'string' && rawHomeId.trim()
    ? rawHomeId.trim()
    : 'default';
  if (!/^[A-Za-z0-9._-]+$/.test(homeId)) {
    return { error: 'Invalid Agent Home id', home: null, status: 400 };
  }
  const home = configManager.getKnownAgentHome(provider, homeId);
  return home
    ? { error: '', home, status: 200 }
    : { error: `Unknown ${provider} Agent Home: ${homeId}`, home: null, status: 404 };
}

function currentAgentSessions(): Promise<AgentSession[]> {
  return agentSessionInventory.list(
    () => configuredProviderMetadata() as AgentSessionInventoryMetadata,
  );
}

const qrShareTickets = new QrShareTicketStore({ ttlMs: SHARE_TICKET_TTL_MS });
const reviewStateStore = new ReviewStateStore(configManager.farmingDir, {
  seedReviews: {
    'review-fixture-553987': {
      patchsets: {
        'Patchset 20': { reviewedPaths: ['clis/dataflow.py', 'clis/fetch_instance_log.py'], revision: 0 },
        'Patchset 19': { reviewedPaths: ['clis/fetch_instance_log.py'], revision: 0 },
      },
    },
  },
});
const reviewDiffService = new ReviewDiffService(
  agentManager as ConstructorParameters<typeof ReviewDiffService>[0],
  workspaceFileService as ConstructorParameters<typeof ReviewDiffService>[1],
);
const reviewSessionStore = new ReviewSessionStore(configManager.farmingDir);
const reviewSessionService = new ReviewSessionService(workspaceFileService, reviewSessionStore, reviewStateStore, {
  resolveAgentRoot: (agentId: string) => agentManager.getAgentWorkspaceRoot(agentId),
  resolveAcpReviewChanges: (agentId: unknown, itemIds: unknown) => {
    if (typeof agentId !== 'string' || !Array.isArray(itemIds) || !itemIds.every(item => typeof item === 'string')) {
      throw new Error('ACP review request is invalid');
    }
    return agentManager.getAcpReviewChanges(agentId, itemIds);
  },
});
const workspaceDiscoveryCache = new AsyncCache((key: string) => {
  const request = JSON.parse(key);
  return discoverAgentWorkspaces({
    limit: request.limit,
    agent: request.agent,
  });
}, {
  ttlMs: 30_000,
  staleMs: 2 * 60_000,
});
const slashCommandDiscoveryCache = createSlashCommandDiscoveryCache({ ttlMs: 30_000 });

const frontendDir = path.join(__dirname, '../frontend');
const crtFrontendDir = path.join(frontendDir, 'skins', 'crt');
const distDir = path.join(__dirname, '../dist');
const staticAppDir = fs.existsSync(distDir) ? distDir : frontendDir;
const immutableAssetStaticOptions = {
  immutable: true,
  index: false,
  maxAge: '1y',
};
const xtermBrowserEntryPath = path.join(__dirname, '..', 'node_modules', '@xterm', 'xterm', 'lib', 'xterm.js');
const xtermFitEntryPath = path.join(__dirname, '..', 'node_modules', '@xterm', 'addon-fit', 'lib', 'addon-fit.js');
const xtermWebglEntryPath = path.join(__dirname, '..', 'node_modules', '@xterm', 'addon-webgl', 'lib', 'addon-webgl.js');
const xtermCssPath = path.join(__dirname, '..', 'node_modules', '@xterm', 'xterm', 'css', 'xterm.css');
const materialIconDir = path.join(__dirname, '..', 'node_modules', 'material-icon-theme', 'icons');

function getAvailableAgentsForRequest() {
  if (process.env.FARMING_E2E_FAKE_EXECUTABLES === '1') {
    return withLaunchCapabilities([
      {
        name: 'codex',
        command: 'codex',
        description: 'Codex CLI - OpenAI coding assistant',
        category: 'coding',
        supported: true,
        interactive: true,
      },
      {
        name: 'claude',
        command: 'claude',
        description: 'Claude CLI - Anthropic assistant',
        category: 'coding',
        supported: true,
        interactive: true,
      },
      {
        name: 'opencode',
        command: 'opencode',
        description: 'OpenCode - AI coding assistant',
        category: 'coding',
        supported: true,
        interactive: true,
      },
      {
        name: 'qoder',
        command: 'qodercli',
        description: 'Qoder - AI coding assistant',
        category: 'coding',
        supported: true,
        interactive: true,
      },
      {
        name: 'qwen',
        command: 'qwen',
        description: 'Qwen Code - AI coding assistant',
        category: 'coding',
        supported: true,
        interactive: true,
      },
      {
        name: 'bash',
        command: 'bash',
        description: 'Shell session',
        category: 'shell',
        supported: true,
        interactive: true,
      },
      {
        name: 'zsh',
        command: 'zsh',
        description: 'Z shell',
        category: 'shell',
        supported: true,
        interactive: true,
      },
    ]);
  }

  const shellEnv = agentManager.resolveAgentShellEnv('', { maxAgeMs: INTERACTIVE_REFRESH_CACHE_MAX_AGE_MS });
  const pathEnv = typeof shellEnv?.PATH === 'string' && shellEnv.PATH.trim()
    ? shellEnv.PATH
    : (process.env.PATH || '');
  return withLaunchCapabilities(listAvailableAgents(pathEnv));
}

function withLaunchCapabilities<T extends { name: string }>(agents: T[]) {
  return agents.map(agent => ({
    ...agent,
    capabilities: {
      supportsChat: providerCapabilities(agent.name).supportsChat === true,
    },
  }));
}

// iOS can fetch installed-web-app metadata outside the authenticated page
// request, without preserving its cookie or token query. These files contain
// only public product artwork and must remain available to that fetcher.
const publicProductAssetsDir = path.join(staticAppDir, 'farming-2');
app.use(routePath(BASE_PATH, '/farming-2'), express.static(publicProductAssetsDir, { index: false }));

const sendPublicProductAsset = (filename: string) => (_req: HttpRequest, res: HttpResponse) => {
  res.sendFile(path.join(publicProductAssetsDir, filename));
};

app.get(['/favicon.ico', routePath(BASE_PATH, '/favicon.ico')], sendPublicProductAsset('favicon-v2.ico'));
app.get([
  '/apple-touch-icon.png',
  '/apple-touch-icon-precomposed.png',
  '/apple-touch-icon-180x180.png',
  routePath(BASE_PATH, '/apple-touch-icon.png'),
  routePath(BASE_PATH, '/apple-touch-icon-precomposed.png'),
  routePath(BASE_PATH, '/apple-touch-icon-180x180.png'),
], sendPublicProductAsset('app-icon-v2-180.png'));

app.get(routePath(BASE_PATH, '/j/:code'), (req, res) => {
  if (req.method === 'HEAD') {
    res.status(204).end();
    return;
  }

  const ticket = qrShareTickets.consume(req.params.code);
  const ticketAccessMode = ticket ? tokenAuth.accessForToken(ticket.token) : 'none';
  if (!ticket || (authEnabled && ticketAccessMode === 'none')) {
    res.status(410).send('Farming share link expired.');
    return;
  }

  if (authEnabled) {
    tokenAuth.setAccessCookie(res, ticket.token);
  }
  res.redirect(302, entryPathWithQuery(ticket.targetQuery, {
    authEnabled,
    basePath: BASE_PATH,
  }));
});

// Token authentication middleware (before static files)
app.use(tokenAuth.middleware());

// Auth status endpoint (allowed without authentication via middleware)
app.get(routePath(BASE_PATH, '/api/auth/status'), (req, res) => {
  res.json({
    authRequired: authEnabled,
    accessMode: tokenAuth.accessForToken(tokenAuth.extractToken(req)),
  });
});

app.use(routePath(BASE_PATH, '/api/share/qr-ticket'), createQrShareRouter({
  createReadOnlyToken: options => tokenAuth.createReadOnlyToken(options),
  extractToken: request => tokenAuth.extractToken(request),
  getToken: () => tokenAuth.getToken(),
  readOnlyTokenExpiresAt: token => tokenAuth.readOnlyTokenExpiresAt(token),
}, {
  create: (token, options) => qrShareTickets.create(token, options),
  revoke: code => qrShareTickets.revoke(code),
}, {
  authEnabled,
  basePath: BASE_PATH,
  fallbackPort: PORT,
}));

// Terminal assets remain available to the standalone CRT skin when React is served from dist.
app.use(routePath(BASE_PATH, '/vendor'), express.static(path.join(frontendDir, 'vendor')));
app.get(routePath(BASE_PATH, '/vendor/xterm/xterm.js'), (_req, res) => {
  res.sendFile(xtermBrowserEntryPath);
});
app.get(routePath(BASE_PATH, '/vendor/xterm/addon-fit.js'), (_req, res) => {
  res.sendFile(xtermFitEntryPath);
});
app.get(routePath(BASE_PATH, '/vendor/xterm/addon-webgl.js'), (_req, res) => {
  res.sendFile(xtermWebglEntryPath);
});
app.get(routePath(BASE_PATH, '/vendor/xterm/xterm.css'), (_req, res) => {
  res.sendFile(xtermCssPath);
});
app.use(routePath(BASE_PATH, '/vendor/material-icons'), express.static(materialIconDir));
app.get(routePath(BASE_PATH, '/vendor/material-icons/:iconId.svg'), (req, res) => {
  const fallbackIcon = String(req.params.iconId || '').startsWith('folder-') ? 'folder.svg' : 'file.svg';
  res.sendFile(path.join(materialIconDir, fallbackIcon));
});
app.use(
  routePath(BASE_PATH, '/assets'),
  express.static(path.join(staticAppDir, 'assets'), immutableAssetStaticOptions),
);
if (BASE_PATH) {
  app.use('/assets', express.static(path.join(staticAppDir, 'assets'), immutableAssetStaticOptions));
  app.use('/farming-2', express.static(path.join(staticAppDir, 'farming-2'), { index: false }));
}
const crtEntryPath = routePath(BASE_PATH, '/crt');
app.get(crtEntryPath, (req, res) => {
  if (req.path.endsWith('/')) {
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(path.join(crtFrontendDir, 'index.html'));
    return;
  }
  const requestUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  res.redirect(308, `${crtEntryPath}/${requestUrl.search}`);
});
app.use(`${crtEntryPath}/shared`, express.static(frontendDir, { index: false }));
app.get(`${crtEntryPath}/crt-markdown-renderer.js`, (_req, res) => {
  res.sendFile(path.join(distDir, 'crt-markdown-renderer.js'));
});
app.get(`${crtEntryPath}/crt-markdown-renderer.css`, (_req, res) => {
  res.sendFile(path.join(distDir, 'crt-markdown-renderer.css'));
});
app.use(`${crtEntryPath}/crt-markdown-assets`, express.static(path.join(distDir, 'crt-markdown-assets'), { index: false }));
app.get(`${crtEntryPath}/crt-mermaid-renderer.js`, (_req, res) => {
  res.sendFile(path.join(distDir, 'crt-mermaid-renderer.js'));
});
app.use(`${crtEntryPath}/`, express.static(crtFrontendDir, { index: false }));
app.use(BASE_PATH || '/', express.static(staticAppDir, { index: false }));

app.use(routePath(BASE_PATH, '/api/files'), createWorkspaceFileRouter(
  agentManager as Parameters<typeof createWorkspaceFileRouter>[0],
  workspaceFileService,
  {
  rootRegistry: workspaceRootRegistry,
  },
));
app.use(routePath(BASE_PATH, '/api/browsers'), createBrowserRouter(
  browserResourceManager,
  workspaceRootRegistry,
  agentManager as Parameters<typeof createBrowserRouter>[2],
));
app.use(routePath(BASE_PATH, '/api/computers'), createComputerRouter(
  computerResourceManager,
  workspaceRootRegistry,
  agentManager as Parameters<typeof createComputerRouter>[2],
));
app.use(routePath(BASE_PATH, '/api/language-server'), createLanguageServerRouter(
  languageServerService,
  workspaceRootRegistry,
));

app.use(routePath(BASE_PATH, '/api/review-sessions'), createReviewSessionRouter(reviewSessionService));
app.use(routePath(BASE_PATH, '/api/reviews'), createReviewDiffRouter(reviewDiffService, reviewSessionService));
app.use(
  routePath(BASE_PATH, '/api/reviews'),
  createReviewStateRouter(reviewStateStore as Parameters<typeof createReviewStateRouter>[0]),
);

if (process.env.NODE_ENV === 'test' && process.env.FARMING_E2E_FAKE_EXECUTABLES === '1') {
  app.post(routePath(BASE_PATH, '/api/control/e2e/close-websockets'), express.json(), (_req, res) => {
    const clients = [...wss.clients].filter(client => client.readyState === WebSocket.OPEN);
    res.json({ closing: clients.length, code: 1013 });
    setImmediate(() => {
      clients.forEach(client => client.close(1013, 'terminal stream backpressure test'));
    });
  });
}

app.use(routePath(BASE_PATH, '/api/control'), createControlRouter(
  agentManager,
  {
  notifyUpdate: broadcastState,
  allowConcurrentTestControl: process.env.NODE_ENV === 'test'
    && process.env.FARMING_E2E_FAKE_EXECUTABLES === '1',
  },
));

app.get([
  BASE_PATH || '/',
  `${BASE_PATH || ''}/`,
  routePath(BASE_PATH, '/code'),
  routePath(BASE_PATH, '/code/'),
  routePath(BASE_PATH, '/error-preview'),
  routePath(BASE_PATH, '/review'),
].filter(Boolean), (req, res) => {
  const indexPath = path.join(staticAppDir, 'index.html');
  fs.readFile(indexPath, 'utf8', (error: unknown, html: string) => {
    if (error) {
      res.status(500).send('Farming frontend is not built');
      return;
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    const rewrittenHtml = applyIndexHtmlAppearance(
      rewriteIndexHtmlForBasePath(html, BASE_PATH),
      configManager.getSettings().appearance
    );
    const requestUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const requestToken = requestUrl.searchParams.has('token') ? tokenAuth.extractToken(req) : '';
    const htmlWithAssetToken = authEnabled && requestToken && tokenAuth.verify(requestToken)
      ? appendIndexHtmlAssetToken(rewrittenHtml, requestToken)
      : rewrittenHtml;
    res.send(htmlWithAssetToken);
  });
});

app.get(routePath(BASE_PATH, '/api/executables'), (req, res) => {
  const availableAgents = getAvailableAgentsForRequest();
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    agents: availableAgents,
    total: availableAgents.length
  });
});

app.use(routePath(BASE_PATH, '/api/workspaces'), createWorkspacePickerRouter({
  rememberWorkspace: workspace => configManager.rememberWorkspace(workspace),
}));

app.use(routePath(BASE_PATH, '/api/workspaces'), createWorkspaceDirectoryRouter());

app.get(routePath(BASE_PATH, '/api/skills'), (_req, res) => {
  res.json({ skills: getMainAgentSkillsCatalog() });
});

app.get(routePath(BASE_PATH, '/api/agent-extensions'), async (_req, res) => {
  try {
    const availableAgents = getAvailableAgentsForRequest()
      .filter(agent => agent.category === 'coding');
    const availableByProvider = new Map(availableAgents.map(agent => [
      String(agent.name || agent.command || '').trim().toLowerCase(),
      agent,
    ]));
    const configuredProviders = Object.keys(configManager.getSettings().agentHomes || {});
    const retainedHomes: Array<{ provider: string; path: string }> = [];
    const agents = await Promise.all(configuredProviders.map(async provider => {
      const agent = availableByProvider.get(provider);
      const configuredHomes = configManager.getAgentHomes(provider);
      const homes = configuredHomes.length > 0
        ? configuredHomes
        : [{
            id: 'default',
            path: '',
            order: Number.MAX_SAFE_INTEGER,
            acpRuntime: { mode: 'managed' as const, executable: '' },
            newAgentDefaults: { model: 'inherit', reasoning: 'inherit', fast: 'inherit' as const },
          }];
      return {
        id: provider,
        name: agent?.name || provider,
        description: agent?.description || '',
        available: Boolean(agent),
        discoverySupported: true,
        acpExecutablePolicy: getProviderAdapter(provider)?.acp.executablePolicy || 'system',
        homes: await Promise.all(homes.map(async home => {
          if (home.path) retainedHomes.push({ provider, path: home.path });
          const inventory = await agentExtensionInventory.get(provider, home.path);
          return {
            id: home.id,
            path: home.path,
            order: home.order,
            acpRuntime: home.acpRuntime,
            newAgentDefaults: home.newAgentDefaults,
            configuration: {
              rootId: rootIdForPath(home.path),
              ...inventory.configuration,
            },
            extensions: inventory.extensions.map(extension => ({
              ...extension,
              rootId: rootIdForPath(home.path),
            })),
          };
        })),
      };
    }));
    await agentExtensionInventory.retain(retainedHomes);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ agents });
  } catch (caught) {
    const error = caughtError(caught);
    console.error('Failed to read Agent extension inventory:', error);
    res.setHeader('Cache-Control', 'no-store');
    res.status(500).json({ error: error.message || 'Failed to read Agent extensions' });
  }
});

app.get(routePath(BASE_PATH, '/api/slash-commands'), async (req, res) => {
  const provider = typeof req.query.provider === 'string' ? req.query.provider : '';
  const workspace = typeof req.query.workspace === 'string' ? req.query.workspace : '';
  const requested = requestedProviderHome(provider, req.query.homeId);
  if (!requested.home) {
    res.status(requested.status).json({ error: requested.error });
    return;
  }
  try {
    const commands = await slashCommandDiscoveryCache.get({
      provider,
      providerHomePath: requested.home.path,
      workspace,
    });
    res.json({ commands });
  } catch (caught) {
    const error = caughtError(caught);
    console.error('Failed to discover slash commands:', error);
    res.status(500).json({ error: error.message || 'Failed to discover slash commands' });
  }
});

const IMAGE_ATTACHMENT_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};
const AUDIO_ATTACHMENT_EXTENSIONS: Record<string, string> = {
  'audio/aac': 'aac',
  'audio/flac': 'flac',
  'audio/mp4': 'm4a',
  'audio/mpeg': 'mp3',
  'audio/ogg': 'ogg',
  'audio/wav': 'wav',
  'audio/wave': 'wav',
  'audio/webm': 'webm',
  'audio/x-wav': 'wav',
};
const IMAGE_ATTACHMENT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const IMAGE_ATTACHMENT_GC_INTERVAL_MS = 60 * 60 * 1000;
const IMAGE_ATTACHMENT_FILENAME_RE = /^pasted-image-\d+-[a-f0-9]{8}\.(?:png|jpg|gif|webp)$/;
const AUDIO_ATTACHMENT_FILENAME_RE = /^pasted-audio-\d+-[a-f0-9]{8}\.(?:aac|flac|m4a|mp3|ogg|wav|webm)$/;
let lastImageAttachmentGcAt = 0;

function imageAttachmentExtension(contentType: string) {
  const normalized = String(contentType || '').split(';')[0].trim().toLowerCase();
  return IMAGE_ATTACHMENT_EXTENSIONS[normalized] || '';
}

function audioAttachmentExtension(contentType: string) {
  const normalized = String(contentType || '').split(';')[0].trim().toLowerCase();
  return AUDIO_ATTACHMENT_EXTENSIONS[normalized] || '';
}

function imageAttachmentsDir() {
  return path.join(configManager.farmingDir, 'attachments');
}

async function cleanupExpiredImageAttachments(options: { force?: boolean } = {}) {
  const now = Date.now();
  if (!options.force && now - lastImageAttachmentGcAt < IMAGE_ATTACHMENT_GC_INTERVAL_MS) return;
  lastImageAttachmentGcAt = now;

  const attachmentsDir = imageAttachmentsDir();
  let entries: Dirent[] = [];
  try {
    entries = await fs.promises.readdir(attachmentsDir, { withFileTypes: true });
  } catch (caught) {
    const error = caughtError(caught);
    if (error && error.code !== 'ENOENT') {
      console.warn('Failed to scan image attachments:', error.message || error);
    }
    return;
  }

  const cutoff = now - IMAGE_ATTACHMENT_RETENTION_MS;
  await Promise.all(entries.map(async (entry) => {
    if (!entry.isFile() || (!IMAGE_ATTACHMENT_FILENAME_RE.test(entry.name) && !AUDIO_ATTACHMENT_FILENAME_RE.test(entry.name))) return;

    const filePath = path.join(attachmentsDir, entry.name);
    try {
      const stat = await fs.promises.stat(filePath);
      if (stat.mtimeMs < cutoff) {
        await fs.promises.unlink(filePath);
      }
    } catch (caught) {
    const error = caughtError(caught);
      if (!error || error.code !== 'ENOENT') {
        console.warn('Failed to remove expired image attachment:', error && (error.message || error));
      }
    }
  }));
}

void cleanupExpiredImageAttachments({ force: true });

app.post(
  routePath(BASE_PATH, '/api/attachments/image'),
  express.raw({ type: 'image/*', limit: '12mb' }),
  (req, res) => {
    const contentType = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    const extension = imageAttachmentExtension(contentType);
    if (!extension) {
      res.status(415).json({ error: 'unsupported image type' });
      return;
    }

    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      res.status(400).json({ error: 'empty image attachment' });
      return;
    }

    const attachmentsDir = imageAttachmentsDir();
    fs.mkdirSync(attachmentsDir, { recursive: true });
    const filename = `pasted-image-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${extension}`;
    const filePath = path.join(attachmentsDir, filename);
    fs.writeFileSync(filePath, req.body);
    void cleanupExpiredImageAttachments();

    res.status(201).json({
      path: filePath,
      name: filename,
      type: contentType,
      size: req.body.length,
    });
  }
);

app.post(
  routePath(BASE_PATH, '/api/attachments/audio'),
  express.raw({ type: 'audio/*', limit: '25mb' }),
  (req, res) => {
    const contentType = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    const extension = audioAttachmentExtension(contentType);
    if (!extension) {
      res.status(415).json({ error: 'unsupported audio type' });
      return;
    }
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      res.status(400).json({ error: 'empty audio attachment' });
      return;
    }
    const attachmentsDir = imageAttachmentsDir();
    fs.mkdirSync(attachmentsDir, { recursive: true });
    const filename = `pasted-audio-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${extension}`;
    const filePath = path.join(attachmentsDir, filename);
    fs.writeFileSync(filePath, req.body);
    void cleanupExpiredImageAttachments();
    res.status(201).json({ path: filePath, name: filename, type: contentType, size: req.body.length });
  }
);

app.get(routePath(BASE_PATH, '/api/codex/models'), async (req, res) => {
  const requested = requestedProviderHome('codex', req.query.homeId);
  if (!requested.home) {
    res.status(requested.status).json({ error: requested.error });
    return;
  }
  try {
    const catalog = await codexModelOptionsCache.get(requested.home.path);
    res.json(catalog);
  } catch (caught) {
    const error = caughtError(caught);
    const timedOut = error && error.code === 'CODEX_MODELS_TIMEOUT';
    res.status(timedOut ? 504 : 502).json({
      error: error && error.message ? error.message : 'Failed to load Codex model catalog',
      code: error && error.code ? error.code : 'CODEX_MODELS_FAILED',
    });
  }
});

app.get(routePath(BASE_PATH, '/api/claude/settings'), (req, res) => {
  const requested = requestedProviderHome('claude', req.query.homeId);
  if (!requested.home) {
    res.status(requested.status).json({ error: requested.error });
    return;
  }
  res.json({
    settings: readClaudeSettingsSummary({
      settingsFile: path.join(requested.home.path, 'settings.json'),
    }),
  });
});

app.use(routePath(BASE_PATH, '/api/usage'), createUsageRouter({
  getUsageDay: (date, options) => usageMonitor.getUsageDay(date, options),
  getUsageSummary: options => usageSummaryCache.get('summary', options),
  invalidateDailyCache: () => usageMonitor.invalidateDailyCache(),
}));

app.post(routePath(BASE_PATH, '/api/codex/context-windows'), express.json(), async (req, res) => {
  try {
    const requestedIds = Array.isArray(req.body?.agentIds)
      ? req.body.agentIds
        .map((value: unknown) => String(value || '').trim())
        .filter(Boolean)
        .slice(0, 20)
      : [];
    const requestedIdSet = new Set(requestedIds);
    const agents = agentManager.getState().agents.filter(agent => requestedIdSet.has(agent.id));
    const contextWindows = await codexContextWindowReader.readForAgents(agents);
    res.json({ contextWindows });
  } catch (caught) {
    const error = caughtError(caught);
    res.status(500).json({ error: error.message || 'Failed to read Codex context windows' });
  }
});

app.use(routePath(BASE_PATH, '/api/update'), createUpdateRouter(updateService));

function warmCodexExecutableVersionCache() {
  const startedAt = Date.now();
  try {
    const result = resolveTerminalCodexExecutable('');
    if (result.path) {
      console.log(`Codex executable ready: ${result.version || 'unknown version'} (${Date.now() - startedAt}ms)`);
    }
  } catch (caught) {
    const error = caughtError(caught);
    console.warn('Failed to warm Codex executable version cache:', error.message || error);
  }
}

app.get(routePath(BASE_PATH, '/api/codex/sessions'), async (req, res) => {
  const requested = requestedProviderHome('codex', req.query.homeId);
  if (!requested.home) {
    res.status(requested.status).json({ error: requested.error });
    return;
  }
  const requestedLimit = Number(req.query.limit);
  const limit = Number.isFinite(requestedLimit) ? Math.max(0, Math.min(1000, requestedLimit)) : 40;
  const requestedScanLimit = Number(req.query.scanLimit);
  const scanLimit = Number.isFinite(requestedScanLimit) ? Math.max(limit, Math.min(5000, requestedScanLimit)) : undefined;
  const sessions = await listCodexSessions({ codexHome: requested.home.path, limit, scanLimit });
  res.json({ sessions });
});

app.use(routePath(BASE_PATH, '/api/agent-sessions'), createAgentSessionRouter({
  getSettings: () => configManager.getSettings(),
  invalidate: () => agentSessionInventory.invalidate(),
  listDisplayRecords: () => configManager.listAgentSessionRecords(),
  listSessions: () => currentAgentSessions(),
}));

app.patch(routePath(BASE_PATH, '/api/agent-sessions/:provider/:sessionId'), express.json(), (req, res) => {
  const provider = normalizeProvider(req.params.provider);
  const sessionId = String(req.params.sessionId || '').trim();
  const providerHomeId = String(req.body?.providerHomeId || 'default').trim() || 'default';
  if (!provider || !isSafeSessionId(sessionId) || !/^[A-Za-z0-9._-]+$/.test(providerHomeId)) {
    res.status(400).json({ error: 'Invalid Agent session' });
    return;
  }
  if (typeof req.body?.pinned !== 'boolean') {
    res.status(400).json({ error: 'Pinned state is required' });
    return;
  }
  const sessionKey = mainPageAgentSessionKey(provider, sessionId, providerHomeId);
  configManager.setProviderSessionDisplayState(sessionKey, { pinned: req.body.pinned });
  res.json({ sessionKey, pinned: req.body.pinned });
});

app.post(routePath(BASE_PATH, '/api/main-page-agent-sessions'), express.json(), (req, res) => {
  const operation = typeof req.body?.operation === 'string' ? req.body.operation : '';
  const requestedKeys = Array.isArray(req.body?.sessionKeys) ? req.body.sessionKeys : [];
  const sessionKeys = [...new Set(requestedKeys.map(key => String(key || '').trim()).filter(Boolean))];
  if (
    !['add', 'remove'].includes(operation)
    || sessionKeys.length === 0
    || sessionKeys.length > 50
    || sessionKeys.some(key => !mainPageAgentSessionFromKey(key))
  ) {
    res.status(400).json({ error: 'A valid main-page Agent session mutation is required' });
    return;
  }

  if (operation === 'add') {
    [...sessionKeys].reverse().forEach(sessionKey => {
      const session = mainPageAgentSessionFromKey(sessionKey);
      if (!session) return;
      configManager.rememberMainPageSessionKey(sessionKey, {
        provider: session.provider,
        providerSessionId: session.sessionId,
        providerSessionKey: sessionKey,
        providerHomeId: session.providerHomeId || 'default',
      });
    });
  } else {
    configManager.removeMainPageSessionKeys(sessionKeys);
  }

  const mainPageSessionKeys = configManager.getMainPageSessionKeys();
  agentSessionInventory.invalidate();
  res.json({ success: true, mainPageSessionKeys });
  queueStateMetadata({ mainPageSessionKeys });
});

app.get(routePath(BASE_PATH, '/api/themes'), (req, res) => {
  const currentTheme = configManager.getSettings().theme || 'terminal';
  res.json({
    themes: themeManager.getAllThemes(),
    current: currentTheme
  });
});

app.get(routePath(BASE_PATH, '/api/settings'), (req, res) => {
  res.json({
    settings: configManager.getSettings()
  });
});

app.get(routePath(BASE_PATH, '/api/workspaces/discovered'), (req, res) => {
  const requestedLimit = Number(req.query.limit);
  const limit = Number.isFinite(requestedLimit) ? Math.max(0, Math.min(20, requestedLimit)) : 12;
  const agent = typeof req.query.agent === 'string' ? req.query.agent : '';
  const cacheToken = JSON.stringify({ limit, agent });
  workspaceDiscoveryCache.get(cacheToken)
    .then(workspaces => {
      res.json({ workspaces });
    })
    .catch((error: unknown) => {
      const message = caughtError(error).message;
      console.error('Failed to discover workspaces:', error);
      res.status(500).json({ error: message || 'Failed to discover workspaces' });
    });
});

app.get(routePath(BASE_PATH, '/api/agents/:agentId/session-text'), async (req, res) => {
  const text = await agentManager.getAgentSessionText(req.params.agentId);
  if (text === null) {
    res.status(404).json({ error: 'Agent not found' });
    return;
  }

  res.type('text/plain');
  res.send(text);
});

app.get(routePath(BASE_PATH, '/api/agents/:agentId/acp-session'), async (req, res) => {
  try {
    res.json({
      session: await agentManager.getAcpSessionForRead(req.params.agentId, {
        includeUpdates: req.query.includeUpdates === '1',
        includeEntries: req.query.includeEntries !== '0',
      }),
    });
  } catch (caught) {
    const error = caughtError(caught);
    const message = error && error.message ? error.message : 'Failed to read ACP session';
    res.status(message === 'Agent not found' ? 404 : 409).json({ error: message });
  }
});

app.get(routePath(BASE_PATH, '/api/agents/:agentId/acp-transcript'), async (req, res) => {
  try {
    const requestedMaxTurns = Number.parseInt(String(req.query.maxTurns || ''), 10);
    const maxTurns = Number.isFinite(requestedMaxTurns)
      ? Math.min(MAX_TRANSCRIPT_TURNS, Math.max(MIN_TRANSCRIPT_TURNS, requestedMaxTurns))
      : DEFAULT_TRANSCRIPT_MAX_TURNS;
    const requestedRevision = Number.parseInt(String(req.query.sinceRevision || ''), 10);
    const externalMedia = req.query.media === 'external-v1';
    const serialized = await agentManager.getAcpTranscriptSerialized(req.params.agentId, {
      maxTurns,
      ...(externalMedia
        ? {
            mediaPathPrefix: routePath(
              BASE_PATH,
              `/api/agents/${encodeURIComponent(req.params.agentId)}/acp-media`
            ),
          }
        : {}),
      ...(Number.isFinite(requestedRevision) && requestedRevision >= 0
        ? { sinceRevision: requestedRevision }
        : {}),
    });
    res.type('application/json').send(serialized);
  } catch (caught) {
    const error = caughtError(caught);
    const message = error && error.message ? error.message : 'Failed to read ACP transcript';
    res.status(message === 'Agent not found' ? 404 : 409).json({ error: message });
  }
});

app.post(routePath(BASE_PATH, '/api/agents/:agentId/acp-transcript/prepare'), async (req, res) => {
  try {
    res.status(202).json(agentManager.prepareAcpTranscript(req.params.agentId));
  } catch (caught) {
    const error = caughtError(caught);
    const message = error && error.message ? error.message : 'Failed to prepare ACP transcript';
    res.status(message === 'Agent not found' ? 404 : 409).json({ error: message });
  }
});

app.get(routePath(BASE_PATH, '/api/agents/:agentId/acp-media/:entryId/:mediaId'), async (req, res) => {
  try {
    const media = await agentManager.getAcpTranscriptMedia(
      req.params.agentId,
      req.params.entryId,
      req.params.mediaId
    );
    const decoded = decodeAcpTranscriptMedia(media);
    if (!decoded) {
      res.status(415).json({ error: 'unsupported ACP transcript media' });
      return;
    }
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.type(decoded.mimeType).send(decoded.content);
  } catch (caught) {
    const error = caughtError(caught);
    const message = error && error.message ? error.message : 'Failed to read ACP transcript media';
    const status = message === 'Agent not found'
      || message === 'ACP transcript entry not found'
      || message === 'ACP transcript media not found'
      ? 404
      : 409;
    res.status(status).json({ error: message });
  }
});

app.get(routePath(BASE_PATH, '/api/agents/:agentId/acp-tool-details/:toolCallId'), async (req, res) => {
  try {
    res.json(await agentManager.getAcpToolDetail(req.params.agentId, req.params.toolCallId));
  } catch (caught) {
    const error = caughtError(caught);
    const message = error && error.message ? error.message : 'Failed to read ACP tool details';
    const status = message === 'Agent not found' || message === 'ACP tool call not found' ? 404 : 409;
    res.status(status).json({ error: message });
  }
});

app.post(routePath(BASE_PATH, '/api/agents/:agentId/acp-terminals/:terminalId/kill'), (req, res) => {
  try {
    res.json(agentManager.killAcpTerminal(req.params.agentId, req.params.terminalId));
  } catch (caught) {
    const error = caughtError(caught);
    const message = error && error.message ? error.message : 'Failed to stop ACP terminal';
    const status = message === 'Agent not found' || message === 'Unknown ACP terminal' ? 404 : 409;
    res.status(status).json({ error: message });
  }
});

app.post(routePath(BASE_PATH, '/api/agents/:agentId/acp-terminals/:terminalId/input'), express.json({ limit: '96kb' }), async (req, res) => {
  try {
    res.json(await agentManager.inputAcpTerminal(
      req.params.agentId,
      req.params.terminalId,
      requiredString(req.body?.input),
      typeof req.body?.requestId === 'string' ? req.body.requestId : undefined,
    ));
  } catch (caught) {
    const error = caughtError(caught);
    const message = error && error.message ? error.message : 'Failed to write ACP terminal input';
    const status = message === 'Agent not found' || message === 'Unknown ACP terminal' ? 404 : 409;
    res.status(status).json({ error: message });
  }
});

app.post(routePath(BASE_PATH, '/api/agents/:agentId/acp-terminals/:terminalId/resize'), express.json(), createAcpTerminalResizeHandler(agentManager));

app.post(routePath(BASE_PATH, '/api/agents/:agentId/acp-subagents/:sessionId/cancel'), async (req, res) => {
  try {
    res.json(await agentManager.cancelAcpSubagent(req.params.agentId, req.params.sessionId));
  } catch (caught) {
    const error = caughtError(caught);
    const message = error && error.message ? error.message : 'Failed to stop ACP subagent';
    const status = message === 'Agent not found' || message === 'ACP subagent session not found' ? 404 : 409;
    res.status(status).json({ error: message });
  }
});

app.post(routePath(BASE_PATH, '/api/agents/:agentId/acp-patches/:toolCallId/decision'), express.json({ limit: '16kb' }), async (req, res) => {
  try {
    const requestedDecision = req.body?.decision;
    const decision = requestedDecision === 'accept'
      ? 'keep'
      : requestedDecision === 'reject'
        ? 'revert'
        : requestedDecision;
    if (decision !== 'keep' && decision !== 'revert') {
      throw new Error('ACP patch decision is invalid');
    }
    res.json(await agentManager.decideAcpPatch(
      req.params.agentId,
      req.params.toolCallId,
      requiredString(req.body?.path),
      decision,
    ));
  } catch (caught) {
    const error = caughtError(caught);
    const message = error && error.message ? error.message : 'Failed to decide ACP patch';
    const status = Number(error?.statusCode) || (message === 'Agent not found' || message === 'ACP tool call not found' ? 404 : 409);
    res.status(status).json({ error: message });
  }
});

app.get(routePath(BASE_PATH, '/api/agents/:agentId/acp-sessions'), async (req, res) => {
  try {
    const result = await agentManager.listAcpSessions(req.params.agentId, {
      cwd: typeof req.query.cwd === 'string' ? req.query.cwd : '',
      cursor: typeof req.query.cursor === 'string' ? req.query.cursor : '',
    });
    res.json(result);
  } catch (caught) {
    const error = caughtError(caught);
    const message = error && error.message ? error.message : 'Failed to list ACP sessions';
    res.status(message === 'Agent not found' ? 404 : 409).json({ error: message });
  }
});

app.post(routePath(BASE_PATH, '/api/agents/:agentId/acp-permission'), express.json(), (req, res) => {
  try {
    const result = agentManager.respondToAcpPermission(
      req.params.agentId,
      requiredString(req.body?.requestId),
      requiredString(req.body?.optionId),
      req.body?.cancelled === true
    );
    res.json(result);
  } catch (caught) {
    const error = caughtError(caught);
    const message = error && error.message ? error.message : 'Failed to respond to ACP permission';
    res.status(message === 'Agent not found' ? 404 : 409).json({ error: message });
  }
});

app.post(routePath(BASE_PATH, '/api/agents/:agentId/acp-elicitation'), express.json(), (req, res) => {
  try {
    const result = agentManager.respondToAcpElicitation(
      req.params.agentId,
      requiredString(req.body?.requestId),
      requiredString(req.body?.action),
      req.body?.content
    );
    res.json(result);
  } catch (caught) {
    const error = caughtError(caught);
    const message = error && error.message ? error.message : 'Failed to respond to ACP input request';
    res.status(message === 'Agent not found' ? 404 : 409).json({ error: message });
  }
});

app.post(routePath(BASE_PATH, '/api/agents/:agentId/acp-session/authenticate'), express.json(), async (req, res) => {
  try {
    res.json(await agentManager.authenticateAcpAgent(req.params.agentId, requiredString(req.body?.methodId)));
  } catch (caught) {
    const error = caughtError(caught);
    const message = error && error.message ? error.message : 'Failed to authenticate ACP Agent';
    res.status(message === 'Agent not found' ? 404 : 409).json({ error: message });
  }
});

app.post(routePath(BASE_PATH, '/api/agents/:agentId/acp-session/logout'), async (req, res) => {
  try {
    res.json(await agentManager.logoutAcpAgent(req.params.agentId));
  } catch (caught) {
    const error = caughtError(caught);
    const message = error && error.message ? error.message : 'Failed to log out ACP Agent';
    res.status(message === 'Agent not found' ? 404 : 409).json({ error: message });
  }
});

app.post(routePath(BASE_PATH, '/api/agents/:agentId/acp-session/reconnect'), async (req, res) => {
  try {
    const result = await agentManager.reconnectAcpAgent(req.params.agentId);
    res.json(result);
  } catch (error) {
    res.status(409).json({ error: caughtError(error).message || 'Failed to reconnect ACP Agent' });
  }
});

app.post(routePath(BASE_PATH, '/api/agents/:agentId/acp-session/fork'), express.json(), async (req, res) => {
  try {
    res.json(await agentManager.forkAcpSession(req.params.agentId, req.body || {}));
  } catch (caught) {
    const error = caughtError(caught);
    const message = error && error.message ? error.message : 'Failed to fork ACP session';
    res.status(message === 'Agent not found' ? 404 : 409).json({ error: message });
  }
});

app.delete(routePath(BASE_PATH, '/api/agents/:agentId/acp-sessions/:sessionId'), async (req, res) => {
  try {
    res.json(await agentManager.deleteAcpSession(req.params.agentId, req.params.sessionId));
  } catch (caught) {
    const error = caughtError(caught);
    const message = error && error.message ? error.message : 'Failed to delete ACP session';
    res.status(message === 'Agent not found' ? 404 : 409).json({ error: message });
  }
});

app.post(routePath(BASE_PATH, '/api/agents/:agentId/acp-session/close'), async (req, res) => {
  try {
    res.json(await agentManager.closeAcpSession(req.params.agentId));
  } catch (caught) {
    const error = caughtError(caught);
    const message = error && error.message ? error.message : 'Failed to close ACP session';
    res.status(message === 'Agent not found' ? 404 : 409).json({ error: message });
  }
});

app.patch(routePath(BASE_PATH, '/api/agents/:agentId/acp-session'), express.json(), async (req, res) => {
  try {
    if (typeof req.body?.modeId === 'string') {
      res.json(await agentManager.setAcpSessionMode(req.params.agentId, req.body.modeId));
      return;
    }
    if (Array.isArray(req.body?.configOptions)) {
      res.json(await agentManager.setAcpSessionConfigOptions(req.params.agentId, req.body.configOptions));
      return;
    }
    if (
      typeof req.body?.configId === 'string'
      && Object.prototype.hasOwnProperty.call(req.body, 'value')
      && isAcpConfigValue(req.body.value)
    ) {
      res.json(await agentManager.setAcpSessionConfigOption(
        req.params.agentId,
        req.body.configId,
        req.body.value
      ));
      return;
    }
    res.status(400).json({ error: 'ACP modeId, configOptions, or configId/value is required' });
  } catch (caught) {
    const error = caughtError(caught);
    const message = error && error.message ? error.message : 'Failed to update ACP session';
    res.status(message === 'Agent not found' ? 404 : 409).json({ error: message });
  }
});

app.post(routePath(BASE_PATH, '/api/agents/:agentId/codex-terminal-profile'), express.json(), async (req, res) => {
  const requestAbort = new globalThis.AbortController();
  const abortRequest = () => requestAbort.abort(new Error('Terminal profile request was canceled'));
  const abortClosedResponse = () => {
    if (!res.writableEnded) abortRequest();
  };
  req.once('aborted', abortRequest);
  res.once('close', abortClosedResponse);
  try {
    const profile = await agentManager.setCodexTerminalProfile(req.params.agentId, {
      model: optionalString(req.body?.model),
      effort: optionalString(req.body?.effort),
      serviceTier: optionalString(req.body?.serviceTier),
    }, {
      signal: requestAbort.signal,
      timeoutMs: 44_000,
    });
    res.json({ profile });
  } catch (caught) {
    const error = caughtError(caught);
    const message = error && error.message ? error.message : 'Failed to update Codex Terminal profile';
    const status = message === 'Agent not found'
      ? 404
      : /^A valid Codex /.test(message)
        ? 400
        : 409;
    if (!res.headersSent && !res.destroyed) res.status(status).json({ error: message });
  } finally {
    req.off('aborted', abortRequest);
    res.off('close', abortClosedResponse);
  }
});

app.patch(routePath(BASE_PATH, '/api/agents/:agentId'), express.json(), async (req, res) => {
  if (!await requireAgentRecoveryForHttp(res)) return;
  const body = req.body || {};
  const updates: Record<string, unknown> = {};
  const providedPatchFields = [
    'customTitle',
    'task',
    'pinned',
    'unread',
    'archived',
    'acknowledgeUnprovenAcpExit',
    'readAttentionSeq',
    'readOutputEpoch',
    'readOutputSeq',
    'launchPermissionMode',
    'agentRuntimeMode',
  ].filter(field => Object.prototype.hasOwnProperty.call(body, field));
  const lifecyclePatchFields = providedPatchFields.filter(field => (
    field === 'launchPermissionMode'
    || field === 'agentRuntimeMode'
    || (field === 'archived' && body.archived === true)
  ));
  if (body.acknowledgeUnprovenAcpExit === true && body.archived !== true) {
    res.status(400).json({ error: 'Process-exit acknowledgement is only valid for Archive' });
    return;
  }
  const archivePatchFields = new Set(['archived', 'acknowledgeUnprovenAcpExit']);
  const hasMixedLifecyclePatch = body.archived === true
    ? providedPatchFields.some(field => !archivePatchFields.has(field))
    : lifecyclePatchFields.length > 0 && providedPatchFields.length > 1;
  if (hasMixedLifecyclePatch) {
    res.status(400).json({
      error: 'Archive, permission restart, and runtime switch must be requested separately from other Agent updates',
    });
    return;
  }
  const ordinaryPatchGroups = [
    providedPatchFields.includes('customTitle') ? 'customTitle' : '',
    providedPatchFields.includes('task') ? 'task' : '',
    providedPatchFields.some(field => [
      'pinned',
      'unread',
      'archived',
      'readAttentionSeq',
      'readOutputEpoch',
      'readOutputSeq',
    ].includes(field)) ? 'flags' : '',
  ].filter(Boolean);
  if (ordinaryPatchGroups.length > 1) {
    res.status(400).json({
      error: 'Agent title, task, and flags must be updated in separate requests',
    });
    return;
  }

  await agentManager.whenAgentLifecycleIdle(req.params.agentId);

  if (typeof body.customTitle === 'string') {
    const result = agentManager.renameAgent(req.params.agentId, body.customTitle) as ServerRecord;
    if (result.error) {
      const status = result.error === 'Agent not found'
        ? 404
        : (result.error.startsWith('Failed to ') ? 500 : 409);
      res.status(status).json({ error: result.error });
      return;
    }
    updates.customTitle = result.customTitle;
  }

  if (typeof body.task === 'string') {
    const result = agentManager.setAgentTask(req.params.agentId, body.task) as ServerRecord;
    if (result.error) {
      const status = result.error === 'Agent not found'
        ? 404
        : (result.error.startsWith('Failed to ') ? 500 : 409);
      res.status(status).json({ error: result.error });
      return;
    }
    updates.task = result.task;
  }

  const flagPatch: Record<string, unknown> = {};
  ['pinned', 'unread', 'archived'].forEach((flagName) => {
    if (typeof body[flagName] === 'boolean') {
      flagPatch[flagName] = body[flagName];
    }
  });
  if (typeof body.readAttentionSeq === 'number' && Number.isFinite(body.readAttentionSeq)) {
    flagPatch.readAttentionSeq = body.readAttentionSeq;
  }
  if (
    typeof body.readOutputEpoch === 'string'
    && body.readOutputEpoch
    && typeof body.readOutputSeq === 'number'
    && Number.isFinite(body.readOutputSeq)
  ) {
    flagPatch.readOutputEpoch = body.readOutputEpoch;
    flagPatch.readOutputSeq = body.readOutputSeq;
  }

  if (flagPatch.archived === true) {
    const result = await agentManager.archiveAgent(req.params.agentId, {
      acknowledgeUnprovenAcpExit: body.acknowledgeUnprovenAcpExit === true,
    }) as ServerRecord;
    if (result.error) {
      const status = result.stopped === true
        ? 409
        : (result.error === 'Agent not found' ? 404 : 400);
      res.status(status).json(result);
      return;
    }
    Object.assign(updates, result);
    delete updates.agentId;
    delete flagPatch.archived;
  }

  let flagUpdateRequiresState = false;
  if (Object.keys(flagPatch).length > 0) {
    const result = agentManager.updateAgentFlags(req.params.agentId, flagPatch) as ServerRecord;
    if (result.error) {
      const status = result.error === 'Agent not found'
        ? 404
        : (result.error.startsWith('Failed to ') ? 500 : 409);
      res.status(status).json({ error: result.error });
      return;
    }
    Object.assign(updates, result);
    delete updates.agentId;
    flagUpdateRequiresState = 'requiresState' in result && result.requiresState === true;
  }

  if (typeof body.launchPermissionMode === 'string') {
    const result = await agentManager.syncCodexTerminalPermissionMode(req.params.agentId, body.launchPermissionMode) as ServerRecord;
    if (result.error) {
      const status = result.error === 'Agent not found' ? 404 : 400;
      res.status(status).json({ error: result.error });
      return;
    }
    updates.launchPermissionMode = result.launchPermissionMode;
    if (result.restarted === true) updates.restarted = true;
    if (result.restartedAgentId) updates.restartedAgentId = result.restartedAgentId;
  }

  if (typeof body.agentRuntimeMode === 'string') {
    if (!isAgentRuntimeModeRequest(body.agentRuntimeMode)) {
      res.status(400).json({ error: 'Unsupported Agent runtime mode' });
      return;
    }
    const result = await agentManager.restartAgentRuntimeMode(req.params.agentId, body.agentRuntimeMode) as ServerRecord;
    if (result.error) {
      const status = result.error === 'Agent not found' ? 404 : 400;
      res.status(status).json({ error: result.error });
      return;
    }
    updates.agentRuntimeMode = result.agentRuntimeMode;
    if (result.restarted === true) updates.restarted = true;
    if (result.restartedAgentId) updates.restartedAgentId = result.restartedAgentId;
    if (result.switchFailed === true) updates.switchFailed = true;
    if (result.warning) updates.warning = result.warning;
  }

  if (Object.keys(updates).length === 0) {
    res.status(400).json({ error: 'customTitle, task, pinned, unread, archived, readAttentionSeq, readOutputEpoch/readOutputSeq, launchPermissionMode, or agentRuntimeMode is required' });
    return;
  }

  if (flagUpdateRequiresState || typeof body.task === 'string' || typeof body.customTitle === 'string' || typeof body.launchPermissionMode === 'string' || typeof body.agentRuntimeMode === 'string') {
    queueAgentStateChange({ agentIds: [req.params.agentId] });
  }
  res.json({ agentId: req.params.agentId, ...updates });
});

app.post(routePath(BASE_PATH, '/api/agents/:agentId/reorder'), express.json(), async (req, res) => {
  if (!await requireAgentRecoveryForHttp(res)) return;
  await agentManager.whenAgentLifecycleIdle(req.params.agentId);
  const result = agentManager.reorderAgent(req.params.agentId, {
    beforeAgentId: optionalString(req.body?.beforeAgentId),
    afterAgentId: optionalString(req.body?.afterAgentId),
  });
  if (result.error) {
    const status = result.error === 'Agent not found'
      ? 404
      : (result.error.startsWith('Failed to ') ? 500 : 409);
    res.status(status).json({ error: result.error });
    return;
  }
  res.json(result);
});

app.post(routePath(BASE_PATH, '/api/agents/:agentId/fork'), express.json(), async (req, res) => {
  if (!await requireAgentRecoveryForHttp(res)) return;
  const mode = req.body && typeof req.body.mode === 'string' ? req.body.mode : 'same-worktree';
  if (!isForkMode(mode)) {
    res.status(400).json({ error: 'Unsupported Fork mode' });
    return;
  }
  const targetRuntime = req.body && typeof req.body.targetRuntime === 'string'
    ? req.body.targetRuntime
    : '';
  if (targetRuntime && targetRuntime !== 'chat') {
    res.status(400).json({ error: 'Unsupported Fork target runtime' });
    return;
  }
  const requestId = typeof req.body?.requestId === 'string' ? req.body.requestId.trim() : '';
  if (!/^[A-Za-z0-9._:-]{1,160}$/.test(requestId)) {
    res.status(400).json({ error: 'Fork requires a valid requestId' });
    return;
  }
  const result = await agentManager.forkAgent(req.params.agentId, mode, {
    requestId,
    ...(targetRuntime === 'chat' ? { targetRuntime: 'chat' } : {}),
    ...(Number.isSafeInteger(req.body?.expectedRevision)
      ? { expectedRevision: optionalNumber(req.body.expectedRevision) }
      : {}),
  });
  if (result.error) {
    const status = result.error === 'Agent not found' ? 404 : 400;
    res.status(status).json(result);
    return;
  }

  try {
    const membership = configManager.mountProjectWorkspace(result.workspace);
    result.projectWorkspaces = membership.projectWorkspaces;
    result.pinnedProjectWorkspaces = membership.pinnedProjectWorkspaces;
  } catch (caught) {
    const error = caughtError(caught);
    queueStateMetadata(currentAgentListMetadata());
    broadcastState();
    const mountError = error.message || 'Failed to create Project';
    res.status(500).json({
      ...result,
      error: `${mountError}. Retry the same Fork request to reconcile Project membership.`,
      retryable: true,
    });
    return;
  }
  queueStateMetadata(currentAgentListMetadata());
  broadcastState();
  res.status(201).json(result);
});

function resolveProjectActionRoot(rootId: string) {
  const root = workspaceRootRegistry.resolve(rootId);
  if (!root || root.kind === 'global') {
    throw new WorkspaceFileError('project workspace is required', 400);
  }
  return root;
}

app.post(routePath(BASE_PATH, '/api/projects/reveal'), express.json(), async (req, res) => {
  try {
    const root = resolveProjectActionRoot(typeof req.body?.rootId === 'string' ? req.body.rootId : '');
    const command = process.platform === 'darwin'
      ? 'open'
      : process.platform === 'win32'
        ? 'explorer'
        : 'xdg-open';
    await execFileAsync(command, [root.canonicalPath], {
      timeout: 15000,
      maxBuffer: 1024 * 1024,
    });
    res.json({ revealed: true, workspace: root.canonicalPath });
  } catch (caught) {
    const error = caughtError(caught);
    const status = error instanceof WorkspaceFileError ? (error.statusCode || 500) : 500;
    res.status(status).json({ error: error.message || 'Failed to reveal project workspace' });
  }
});

app.post(routePath(BASE_PATH, '/api/projects/mount'), express.json(), async (req, res) => {
  try {
    const workspace = await canonicalProjectWorkspace(typeof req.body?.workspace === 'string' ? req.body.workspace : '');
    const membership = configManager.mountProjectWorkspace(workspace);
    queueStateMetadata(currentAgentListMetadata());
    broadcastState();
    res.json(membership);
  } catch (caught) {
    const error = caughtError(caught);
    res.status(400).json({ error: error.message || 'Failed to create Project' });
  }
});

app.post(routePath(BASE_PATH, '/api/projects/remove'), express.json(), (req, res) => {
  try {
    const membership = configManager.removeProjectWorkspace(req.body?.workspace);
    queueStateMetadata(currentAgentListMetadata());
    broadcastState();
    res.json(membership);
  } catch (caught) {
    const error = caughtError(caught);
    res.status(400).json({ error: error.message || 'Failed to remove Project' });
  }
});

app.post(routePath(BASE_PATH, '/api/projects/pin'), express.json(), (req, res) => {
  try {
    const membership = configManager.setProjectWorkspacePinned(
      req.body?.workspace,
      req.body?.pinned === true
    );
    queueStateMetadata(currentAgentListMetadata());
    broadcastState();
    res.json(membership);
  } catch (caught) {
    const error = caughtError(caught);
    res.status(400).json({ error: error.message || 'Failed to update Project pin' });
  }
});

app.post(routePath(BASE_PATH, '/api/projects/reorder'), express.json(), (req, res) => {
  try {
    const membership = configManager.reorderProjectWorkspace(req.body?.workspace, {
      beforeWorkspace: optionalString(req.body?.beforeWorkspace),
      afterWorkspace: optionalString(req.body?.afterWorkspace),
    });
    queueStateMetadata(currentAgentListMetadata());
    broadcastState();
    res.json(membership);
  } catch (caught) {
    const error = caughtError(caught);
    const status = error.message === 'Project does not exist' ? 404 : 409;
    res.status(status).json({ error: error.message || 'Failed to reorder Project' });
  }
});

app.patch(routePath(BASE_PATH, '/api/projects/name'), express.json(), (req, res) => {
  try {
    const result = configManager.setProjectName(req.body?.workspace, req.body?.name);
    queueStateMetadata(currentAgentListMetadata());
    res.json(result);
  } catch (caught) {
    const error = caughtError(caught);
    res.status(400).json({ error: error.message || 'Failed to rename Project' });
  }
});

app.post(routePath(BASE_PATH, '/api/projects/create-worktree'), express.json(), async (req, res) => {
  const requestId = typeof req.body?.requestId === 'string' ? req.body.requestId.trim() : '';
  if (!/^[A-Za-z0-9._:-]{1,160}$/.test(requestId)) {
    res.status(400).json({ error: 'Project worktree creation requires a valid requestId' });
    return;
  }
  try {
    const root = resolveProjectActionRoot(typeof req.body?.rootId === 'string' ? req.body.rootId : '');
    const created = await agentManager.createPermanentWorktree(root.canonicalPath, { requestId });
    if (!isRecord(created)) throw new Error('Project worktree creation returned an invalid result');
    queueStateMetadata(currentAgentListMetadata());
    broadcastState();
    res.status(201).json({
      ...created,
    });
  } catch (caught) {
    const error = caughtError(caught);
    const status = error instanceof WorkspaceFileError ? (error.statusCode || 400) : 400;
    const operation = configManager.getProjectOperation?.(requestId);
    res.status(status).json({
      error: error.message || 'Failed to create permanent worktree',
      requestId,
      ...(operation?.state === 'pending' ? { retryable: true } : {}),
      ...(['unknown', 'blocked'].includes(operation?.state || '') ? { uncertain: true } : {}),
    });
  }
});

app.post(routePath(BASE_PATH, '/api/projects/delete-worktree'), express.json(), async (req, res) => {
  if (!await requireAgentRecoveryForHttp(res)) return;
  const body = req.body || {};
  const workspace = typeof body.workspace === 'string' ? body.workspace : '';
  const requestId = typeof body.requestId === 'string' ? body.requestId.trim() : '';
  if (!/^[A-Za-z0-9._:-]{1,160}$/.test(requestId)) {
    res.status(400).json({ error: 'Project worktree deletion requires a valid requestId' });
    return;
  }

  const result = await agentManager.deleteForkWorktreeProject(workspace, {
    force: body.force === true,
    requestId,
  });
  if (result.error) {
    queueStateMetadata(currentAgentListMetadata());
    broadcastState();
    const status = result.requiresForce
      ? 409
      : (result.error === 'Workspace not found' || result.error === 'Workspace is required' ? 404 : 400);
    res.status(status).json(result);
    return;
  }
  queueStateMetadata(currentAgentListMetadata());
  broadcastState();
  res.json(result);
});

app.post(routePath(BASE_PATH, '/api/codex/sessions/:sessionId/resume'), express.json(), async (req, res) => {
  await startResumedAgentSession(req, res, 'codex', req.params.sessionId);
});

app.post(routePath(BASE_PATH, '/api/agent-sessions/:provider/:sessionId/resume'), express.json(), async (req, res) => {
  await startResumedAgentSession(req, res, req.params.provider, req.params.sessionId);
});

const pendingResumeStarts = new Map<string, Promise<ResumeAgentResult>>();
const pendingProjectWorkspaceResolutions = new Map<string, Promise<string>>();

function resumedAgentStartKey(provider: string, sessionId: string, options: ResumeOptions = {}) {
  return [
    provider,
    options.providerHomeId || 'default',
    sessionId,
    options.fork === true ? 'fork' : 'resume',
    options.asMain === true ? 'main' : 'agent',
  ].join(':');
}

function findResumedAgent(provider: string, sessionId: string, providerHomeId = '') {
  return findActiveAgentClaimingSession(agentManager.getState().agents, provider, { id: sessionId, providerHomeId });
}

function isMainAgentSessionWorkspace(session: AgentSession | null) {
  const values = [session?.cwd, session?.workspace];
  return values.some(value => {
    const normalized = String(value || '').trim().replace(/[\\/]+$/, '');
    return normalized === '~/.farming' || /(^|[/\\])\.farming$/.test(normalized);
  });
}

function rememberMainPageAgentSession(provider: string, sessionId: string, providerHomeId = '') {
  const sessionKey = mainPageAgentSessionKey(provider, sessionId, providerHomeId);
  if (typeof configManager.rememberMainPageSessionKey === 'function') {
    configManager.rememberMainPageSessionKey(sessionKey, {
      provider,
      providerSessionId: sessionId,
      providerSessionKey: sessionKey,
      providerHomeId: providerHomeId || 'default',
      source: 'resume',
    });
    return;
  }
  const currentKeys = typeof configManager.getMainPageSessionKeys === 'function'
    ? configManager.getMainPageSessionKeys()
    : (Array.isArray(configManager.getSettings().mainPageSessionKeys) ? configManager.getSettings().mainPageSessionKeys : []);
  configManager.updateSettings({
    mainPageSessionKeys: [
      sessionKey,
      ...currentKeys.filter((key: string) => key !== sessionKey),
    ],
  });
}

function forgetMainPageAgentSession(provider: string, sessionId: string, providerHomeId = '') {
  const sessionKey = mainPageAgentSessionKey(provider, sessionId, providerHomeId);
  if (typeof configManager.removeMainPageSessionKey === 'function') {
    configManager.removeMainPageSessionKey(sessionKey);
    return;
  }
  const currentKeys = typeof configManager.getMainPageSessionKeys === 'function'
    ? configManager.getMainPageSessionKeys()
    : (Array.isArray(configManager.getSettings().mainPageSessionKeys) ? configManager.getSettings().mainPageSessionKeys : []);
  if (!currentKeys.includes(sessionKey)) return;
  configManager.updateSettings({
    mainPageSessionKeys: currentKeys.filter((key: string) => key !== sessionKey),
  });
}

function savedFarmingAgentSession(provider: string, sessionId: string, providerHomeId = '') {
  if (typeof configManager.getAgentSessionRecordForProviderSessionKey !== 'function') return null;
  const sessionKey = mainPageAgentSessionKey(provider, sessionId, providerHomeId);
  return sessionKey
    ? configManager.getAgentSessionRecordForProviderSessionKey(sessionKey)
    : null;
}

async function resumeAgentSessionById(
  provider: string,
  rawSessionId: string,
  options: ResumeOptions = {},
): Promise<ResumeAgentResult> {
  const normalizedProvider = normalizeProvider(provider);
  const sessionId = String(rawSessionId || '').trim();
  const providerHomeId = typeof options.providerHomeId === 'string' && options.providerHomeId.trim() ? options.providerHomeId.trim() : 'default';
  if (!normalizedProvider || !isSafeSessionId(sessionId)) {
    return { error: 'invalid session id', status: 400 };
  }

  const shouldFork = options.fork === true;
  if (shouldFork && providerConversationForkCapability(normalizedProvider, 'terminal').supported !== true) {
    return { error: `${normalizedProvider} does not support session Fork`, status: 400 };
  }
  const requestedAsMain = options.asMain === true && !shouldFork;
  const shouldRememberMainPageSession = options.rememberMainPageSession !== false && !shouldFork && !requestedAsMain;
  const pendingResumeId = resumedAgentStartKey(normalizedProvider, sessionId, {
    fork: shouldFork,
    asMain: requestedAsMain,
    providerHomeId,
  });
  if (!shouldFork) {
    const existingAgent = findResumedAgent(normalizedProvider, sessionId, providerHomeId);
    if (existingAgent) {
      if (shouldRememberMainPageSession) rememberMainPageAgentSession(normalizedProvider, sessionId, providerHomeId);
      const projectWorkspace = requestedAsMain
        ? ''
        : await canonicalProjectWorkspace(
          existingAgent.gitWorktree?.workspace || existingAgent.projectWorkspace || existingAgent.cwd || null
        );
      return { agentId: existingAgent.id, projectWorkspace, reused: true };
    }
  }
  const pendingStart = pendingResumeStarts.get(pendingResumeId);
  if (pendingStart) {
    const result = await pendingStart;
    if (result.error) {
      return result;
    }
    if (shouldRememberMainPageSession) rememberMainPageAgentSession(normalizedProvider, sessionId, providerHomeId);
    return {
      agentId: result.agentId,
      projectWorkspace: result.projectWorkspace || '',
      reused: true,
      pending: true,
      ...(result.claimed ? { claimed: true } : {}),
    };
  }

  const startPromise: Promise<ResumeAgentResult> = (async (): Promise<ResumeAgentResult> => {
    let session = await findAgentSession(normalizedProvider, sessionId, {
      limit: 1000,
      providerLimit: 1000,
      scanLimit: 5000,
      providerHomeId,
      providerHomes: configuredProviderHomes(),
    });
    if (
      options.allowUnarchiveArchived === true
      && normalizedProvider === 'codex'
      && !requestedAsMain
    ) {
      const providerHomes = configuredProviderHomes();
      const configuredHomePath = (providerHomes.codex || [])
        .find((home: { id: string; path: string }) => home.id === providerHomeId)?.path || '';
      const unarchiveResult = await agentManager.ensureCodexSessionAvailable(sessionId, {
        providerHomeId,
        providerHomePath: session?.providerHomePath || configuredHomePath,
        providerHomes,
        cwd: session?.cwd || session?.workspace || '',
      });
      if (unarchiveResult?.error) return unarchiveResult;
      session = await findAgentSession(normalizedProvider, sessionId, {
        limit: 1000,
        providerLimit: 1000,
        scanLimit: 5000,
        providerHomeId,
        providerHomes,
      }) || (session ? { ...session, archived: false } : session);
    }
    if (session && session.archived && !shouldFork) {
      forgetMainPageAgentSession(normalizedProvider, sessionId, providerHomeId);
      return {
        error: `${session.providerName || normalizedProvider} session is archived. Unarchive it before resuming.`,
        status: 409,
        archived: true,
      };
    }
    if (!shouldFork && !requestedAsMain) {
      const claimingAgent = findActiveAgentClaimingSession(agentManager.getState().agents, normalizedProvider, {
        id: sessionId,
        providerHomeId,
        ...(session || {}),
      });
      if (claimingAgent) {
        if (shouldRememberMainPageSession) rememberMainPageAgentSession(normalizedProvider, sessionId, providerHomeId);
        const projectWorkspace = await canonicalProjectWorkspace(
          claimingAgent.gitWorktree?.workspace || claimingAgent.projectWorkspace || claimingAgent.cwd || null
        );
        return { agentId: claimingAgent.id, projectWorkspace, reused: true, claimed: true };
      }
    }

    const resumeAsMain = requestedAsMain && isMainAgentSessionWorkspace(session);
    if (requestedAsMain && !resumeAsMain) {
      return { error: 'session is not a Main Agent session', status: 400 };
    }

    const savedSession = shouldFork
      ? null
      : savedFarmingAgentSession(normalizedProvider, sessionId, session
        ? (session.providerHomeId || providerHomeId)
        : providerHomeId);
    const hasRequestedCustomTitle = Object.prototype.hasOwnProperty.call(options, 'customTitle');
    const savedAttentionSeq = Number(savedSession?.attentionSeq) || 0;
    const savedReadAttentionSeq = Number(savedSession?.readAttentionSeq) || 0;
    const workingDirectory = session?.cwd || session?.workspace || null;
    const projectWorkspace = resumeAsMain
      ? ''
      : await canonicalProjectWorkspace(
        String(savedSession?.projectWorkspace || (session ? (session.workspace || session.cwd || '') : workingDirectory) || '')
      );
    const command = buildAgentSessionResumeCommand(normalizedProvider, sessionId, {
      fork: shouldFork,
      cwd: workingDirectory,
      modelProvider: normalizedProvider === 'codex'
        ? resolveCodexResumeModelProvider(session?.providerHomePath || '')
        : '',
    });

    if (!command) {
      return { error: 'invalid session id', status: 400 };
    }

    return new Promise<ResumeAgentResult>((resolve) => {
      const resolvedProviderHomeId = session ? (session.providerHomeId || providerHomeId) : providerHomeId;
      const resumeSource = resumedAgentSource(normalizedProvider, sessionId, resolvedProviderHomeId);
      const startResult = agentManager.startAgent(command, workingDirectory, (agentId, error) => {
        if (error) {
          resolve({ error, status: 400 });
          return;
        }

        if (!agentId) {
          resolve({ error: 'failed to resume agent session', status: 500 });
          return;
        }

        resolve({ agentId, projectWorkspace });
      }, {
        wantsMain: resumeAsMain,
        task: savedSession?.task || (session ? session.title : ''),
        workflowTemplate: savedSession?.workflowTemplate || '',
        customTitle: hasRequestedCustomTitle
          ? (typeof options.customTitle === 'string' ? options.customTitle : '')
          : (savedSession?.customTitle || ''),
        customTitleExplicit: hasRequestedCustomTitle,
        requiredCliVersion: normalizedProvider === 'codex' && session ? session.cliVersion : '',
        projectWorkspace,
        source: shouldFork ? resumeSource.replace('-history:', '-history-fork:') : resumeSource,
        agentRuntimeMode: typeof options.agentRuntimeMode === 'string' && ['chat', 'acp'].includes(options.agentRuntimeMode) ? 'chat' : 'terminal',
        acpHistoryMode: options.acpHistoryMode === 'resume' ? 'resume' : 'load',
        providerHomeId: resolvedProviderHomeId,
        providerHomePath: session ? (session.providerHomePath || '') : '',
        providerSessionTitle: session?.title || savedSession?.providerSessionTitle || '',
        persistentSessionId: savedSession?.id || '',
        pinned: savedSession?.pinned === true,
        projectOrder: savedSession?.projectOrder,
        pinnedOrder: savedSession?.pinnedOrder,
        attentionSeq: savedAttentionSeq,
        readAttentionSeq: savedReadAttentionSeq,
        attentionUpdatedAt: savedSession?.attentionUpdatedAt,
        readAttentionAt: savedSession?.readAttentionAt,
        attentionReason: savedSession?.attentionReason,
        attentionOutputEpoch: savedSession?.attentionOutputEpoch,
        attentionOutputSeq: savedSession?.attentionOutputSeq,
        readOutputEpoch: savedSession?.readOutputEpoch,
        readOutputSeq: savedSession?.readOutputSeq,
        autoReadInitialAttention: options.autoReadInitialAttention === true
          && savedAttentionSeq <= savedReadAttentionSeq,
        preserveProviderSessionProfile: normalizedProvider === 'codex' || normalizedProvider === 'claude',
      });
      Promise.resolve(startResult).catch((error) => {
        resolve({ error: error.message || 'failed to resume agent session', status: 500 });
      });
    });
  })();
  pendingResumeStarts.set(pendingResumeId, startPromise);

  const result = await startPromise;
  if (pendingResumeStarts.get(pendingResumeId) === startPromise) {
    pendingResumeStarts.delete(pendingResumeId);
  }

  if (result.error) {
    return result;
  }

  if (shouldRememberMainPageSession) rememberMainPageAgentSession(normalizedProvider, sessionId, providerHomeId);
  if (result.reused) {
    return {
      agentId: result.agentId,
      projectWorkspace: result.projectWorkspace || '',
      reused: true,
      ...(result.claimed ? { claimed: true } : {}),
    };
  }
  return {
    agentId: result.agentId,
    projectWorkspace: result.projectWorkspace || '',
  };
}

async function canonicalProjectWorkspace(workspace: string | null) {
  const candidate = configManager.expandWorkspacePath(String(workspace || '').trim());
  if (!candidate) return '';
  const pending = pendingProjectWorkspaceResolutions.get(candidate);
  if (pending) return pending;

  const resolution = (async () => {
    try {
      const worktree = await inspectGitWorktree(candidate);
      if (worktree?.workspace) return worktree.workspace;
    } catch (caught) {
    const error = caughtError(caught);
      console.warn('Failed to resolve project worktree:', candidate, error?.message || error);
    }
    try {
      return fs.realpathSync(path.resolve(candidate));
    } catch {
      return candidate;
    }
  })();
  pendingProjectWorkspaceResolutions.set(candidate, resolution);
  try {
    return await resolution;
  } finally {
    if (pendingProjectWorkspaceResolutions.get(candidate) === resolution) {
      pendingProjectWorkspaceResolutions.delete(candidate);
    }
  }
}

async function startResumedAgentSession(req: HttpRequest, res: HttpResponse, provider: string, rawSessionId: string) {
  const shouldFork = req.body && req.body.fork === true;
  const requestedAsMain = req.body && req.body.asMain === true && !shouldFork;
  const allowUnarchiveArchived = req.body && req.body.unarchiveArchived === true && !shouldFork && !requestedAsMain;
  const providerHomeId = req.body && typeof req.body.providerHomeId === 'string'
    ? req.body.providerHomeId
    : '';
  const sessionKey = mainPageAgentSessionKey(provider, rawSessionId, providerHomeId);
  const mainPageSessionWasRemembered = !shouldFork
    && !requestedAsMain
    && configManager.getMainPageSessionKeys().includes(sessionKey);
  if (
    req.body
    && Object.prototype.hasOwnProperty.call(req.body, 'customTitle')
    && typeof req.body.customTitle !== 'string'
  ) {
    res.status(400).json({ error: 'customTitle must be a string' });
    return;
  }
  const result = await resumeAgentSessionById(provider, rawSessionId, {
    fork: shouldFork,
    asMain: requestedAsMain,
    allowUnarchiveArchived,
    providerHomeId,
    ...(req.body && Object.prototype.hasOwnProperty.call(req.body, 'customTitle')
      ? { customTitle: req.body.customTitle }
      : {}),
    agentRuntimeMode: typeof req.body?.agentRuntimeMode === 'string' && ['chat', 'acp'].includes(req.body.agentRuntimeMode) ? 'chat' : 'terminal',
    acpHistoryMode: req.body && req.body.acpHistoryMode === 'resume' ? 'resume' : 'load',
  });

  if (result.error) {
    res.status(result.status || 400).json({ error: result.error });
    return;
  }
  if (!result.agentId) {
    res.status(500).json({ error: 'Agent session resume returned no Agent identity' });
    return;
  }

  let projectMembership = {
    projectWorkspaces: configManager.getSettings().projectWorkspaces || [],
    pinnedProjectWorkspaces: configManager.getSettings().pinnedProjectWorkspaces || [],
  };
  try {
    if (!requestedAsMain && result.projectWorkspace) {
      projectMembership = configManager.mountProjectWorkspace(result.projectWorkspace);
    }
  } catch (caught) {
    const error = caughtError(caught);
    let rollbackError = '';
    if (!result.reused) {
      try {
        const rollback = await agentManager.archiveAgent(result.agentId, {
          reason: 'project-mount-failed',
          recordHistory: false,
          requireEngineExit: true,
          scheduleProviderArchive: false,
        });
        if (rollback?.error) rollbackError = rollback.error;
      } catch (cleanupError) {
        rollbackError = caughtError(cleanupError).message || String(cleanupError);
      }
    }
    if (!mainPageSessionWasRemembered && !rollbackError) {
      forgetMainPageAgentSession(provider, rawSessionId, providerHomeId || 'default');
    }
    queueStateMetadata(currentAgentListMetadata());
    broadcastState();
    const mountError = error.message || 'Failed to create Project';
    res.status(500).json({
      error: rollbackError
        ? `${mountError}. Rollback failed: ${rollbackError}`
        : mountError,
      ...(rollbackError ? { rollbackError } : {}),
    });
    return;
  }
  queueStateMetadata(currentAgentListMetadata());
  broadcastState();
  if (result.reused) {
    res.status(200).json({
      agentId: result.agentId,
      ...(result.projectWorkspace ? { projectWorkspace: result.projectWorkspace } : {}),
      projectWorkspaces: projectMembership.projectWorkspaces,
      pinnedProjectWorkspaces: projectMembership.pinnedProjectWorkspaces,
      reused: true,
      ...(result.claimed ? { claimed: true } : {}),
      ...(result.pending ? { pending: true } : {}),
    });
    return;
  }

  res.status(201).json({
    agentId: result.agentId,
    ...(result.projectWorkspace ? { projectWorkspace: result.projectWorkspace } : {}),
    projectWorkspaces: projectMembership.projectWorkspaces,
    pinnedProjectWorkspaces: projectMembership.pinnedProjectWorkspaces,
  });
}

async function autoResumeMainPageAgentSessions() {
  if (typeof agentManager.whenRecovered === 'function') {
    await agentManager.whenRecovered();
  }

  const sessions = mainPageAgentSessionsToAutoResume(configManager.getSettings());
  if (sessions.length === 0) return;

  let knownSessions: AgentSession[];
  try {
    knownSessions = await currentAgentSessions();
  } catch (caught) {
    const error = caughtError(caught);
    console.warn('Failed to load Agent session catalog for auto-resume:', error && (error.message || error));
    return;
  }
  const knownSessionByKey = new Map(knownSessions.map(session => [
    mainPageAgentSessionKey(session.provider, session.id, session.providerHomeId || 'default'),
    session,
  ]));

  let resumedCount = 0;
  for (const session of sessions) {
    try {
      const sessionDetails = knownSessionByKey.get(mainPageAgentSessionKey(
        session.provider,
        session.sessionId,
        session.providerHomeId || 'default'
      ));
      if (!sessionDetails) {
        console.warn('Dropping stale main-page session from auto-resume:', session.provider, session.sessionId);
        forgetMainPageAgentSession(session.provider, session.sessionId, session.providerHomeId || 'default');
        continue;
      }

      const claimingAgent = findActiveAgentClaimingSession(agentManager.getState().agents, session.provider, {
        id: session.sessionId,
        ...(sessionDetails || {}),
      });
      if (claimingAgent) {
        continue;
      }

      const result = await resumeAgentSessionById(session.provider, session.sessionId, {
        rememberMainPageSession: false,
        providerHomeId: session.providerHomeId || 'default',
        autoReadInitialAttention: true,
      });
      if (result.error) {
        const message = String(result.error || '').toLowerCase();
        if (session.provider === 'qoder' && message.includes('invalid session identifier')) {
          console.warn('Dropping stale qoder session from auto-resume:', session.provider, session.sessionId, result.error);
          forgetMainPageAgentSession(session.provider, session.sessionId, session.providerHomeId || 'default');
          continue;
        }
        console.warn('Failed to auto-resume main page agent session:', session.provider, session.sessionId, result.error);
      } else {
        resumedCount += 1;
      }
    } catch (caught) {
    const error = caughtError(caught);
      const message = error instanceof Error ? error.message : String(error);
      console.warn('Failed to auto-resume main page agent session:', session.provider, session.sessionId, message);
    }
  }

  if (resumedCount > 0) {
    queueStateMetadata(currentAgentListMetadata());
    broadcastState();
  }
}

app.post(routePath(BASE_PATH, '/api/settings'), express.json(), async (req, res) => {
  const settingsPatch = { ...(req.body || {}) };
  delete settingsPatch.mainPageSessionKeys;
  delete settingsPatch.projectWorkspaces;
  delete settingsPatch.pinnedProjectWorkspaces;
  const browserConfigurationKeys = [
    'browserSource',
    'browserExecutablePath',
    'browserExternalCdpUrl',
  ];
  const computerConfigurationKeys = [
    'computerImage',
    'computerCompatibilityMode',
  ];
  const currentSettings = configManager.getSettings();
  const requestsIsolatedBrowser = (
    Object.prototype.hasOwnProperty.call(settingsPatch, 'browserExtensionEnabled')
      ? settingsPatch.browserExtensionEnabled === true
      : currentSettings.browserExtensionEnabled === true
  ) && (
    optionalString(settingsPatch.browserSource) ?? currentSettings.browserSource
  ) === 'isolated';
  if (requestsIsolatedBrowser) {
    settingsPatch.computerExtensionEnabled = true;
  }
  const changesAgentHomes = Object.prototype.hasOwnProperty.call(settingsPatch, 'agentHomes');
  if (changesAgentHomes) {
    try {
      const normalizedHomes = configManager.normalizeAgentHomes(settingsPatch.agentHomes);
      for (const [provider, homes] of Object.entries(normalizedHomes)) {
        for (const home of homes) {
          if (home.acpRuntime.mode !== 'custom') continue;
          const executable = configManager.expandWorkspacePath(home.acpRuntime.executable);
          if (!path.isAbsolute(executable)) {
            const error = new Error(`${provider} Agent Home "${home.id}" custom ACP executable must be an absolute path`) as Error & { code?: string; status?: number };
            error.code = 'AGENT_HOME_ACP_RUNTIME_INVALID';
            error.status = 400;
            throw error;
          }
          try {
            await fs.promises.access(executable, fs.constants.X_OK);
          } catch (cause) {
            const error = new Error(
              `${provider} Agent Home "${home.id}" custom ACP executable is not executable: ${executable}`,
              { cause },
            ) as Error & { code?: string; status?: number };
            error.code = 'AGENT_HOME_ACP_RUNTIME_INVALID';
            error.status = 400;
            throw error;
          }
        }
      }
    } catch (caught) {
      const error = caughtError(caught);
      res.status(Number(error.status) || 400).json({
        error: error.message || 'Agent Home ACP runtime configuration is invalid',
        code: error.code || 'AGENT_HOME_ACP_RUNTIME_INVALID',
      });
      return;
    }
  }
  const changesBrowserExtension = Object.prototype.hasOwnProperty.call(settingsPatch, 'browserExtensionEnabled');
  const changesBrowserConfiguration = browserConfigurationKeys.some(key =>
    Object.prototype.hasOwnProperty.call(settingsPatch, key)
  );
  let changesComputerExtension = Object.prototype.hasOwnProperty.call(settingsPatch, 'computerExtensionEnabled');
  const changesComputerConfiguration = computerConfigurationKeys.some(key =>
    Object.prototype.hasOwnProperty.call(settingsPatch, key)
  );
  const browserExtensionEnabled = settingsPatch.browserExtensionEnabled === true;
  const desiredBrowserEnabled = changesBrowserExtension
    ? browserExtensionEnabled
    : currentSettings.browserExtensionEnabled === true;
  let computerExtensionEnabled = settingsPatch.computerExtensionEnabled === true;
  let desiredComputerEnabled = changesComputerExtension
    ? computerExtensionEnabled
    : currentSettings.computerExtensionEnabled === true;
  if ((changesBrowserExtension && browserExtensionEnabled) || changesBrowserConfiguration) {
    const desiredSelection = browserResourceManager.browserSelection({
      browserSource: optionalString(settingsPatch.browserSource) ?? currentSettings.browserSource,
      browserExecutablePath:
        optionalString(settingsPatch.browserExecutablePath) ?? currentSettings.browserExecutablePath,
      browserExternalCdpUrl:
        optionalString(settingsPatch.browserExternalCdpUrl) ?? currentSettings.browserExternalCdpUrl,
    });
    const probe = await browserResourceManager.probeCapability(desiredSelection);
    if (
      (changesBrowserConfiguration || desiredBrowserEnabled)
      && (!probe.runtimeCapability || probe.runtimeCapability.error)
    ) {
      res.status(400).json({
        error: probe.runtimeCapability?.error
          || 'Choose a local Chromium browser or prepare the isolated Browser runtime',
        code: 'BROWSER_EXECUTABLE_NOT_FOUND',
      });
      return;
    }
    if (
      desiredBrowserEnabled
      && probe.runtimeCapability?.kind === 'isolated-computer'
    ) {
      settingsPatch.computerExtensionEnabled = true;
      changesComputerExtension = true;
      computerExtensionEnabled = true;
      desiredComputerEnabled = true;
    }
  }
  if (
    currentSettings.browserExtensionEnabled === true
    && (
      (changesBrowserExtension && !browserExtensionEnabled)
      || changesBrowserConfiguration
    )
  ) {
    try {
      await browserResourceManager.stopAll();
    } catch (caught) {
    const error = caughtError(caught);
      res.status(Number(error?.status) || 500).json({
        error: error?.message || 'Browser extension could not be disabled',
        code: error?.code || 'BROWSER_DISABLE_FAILED',
      });
      return;
    }
  }
  if ((changesComputerExtension && computerExtensionEnabled) || changesComputerConfiguration) {
    try {
      const probe = await computerResourceManager.probeSettings({
        ...currentSettings,
        ...settingsPatch,
      });
      if (desiredComputerEnabled && !probe.imageReady) {
        res.status(400).json({
          error: probe.error || 'Prepare the pinned Computer runtime before enabling this plugin',
          code: probe.dockerAvailable ? 'COMPUTER_IMAGE_NOT_READY' : 'COMPUTER_DOCKER_NOT_AVAILABLE',
        });
        return;
      }
    } catch (caught) {
      const error = caughtError(caught);
      res.status(Number(error?.status) || 400).json({
        error: error?.message || 'Computer configuration is invalid',
        code: error?.code || 'COMPUTER_CONFIGURATION_INVALID',
      });
      return;
    }
  }
  if (
    currentSettings.computerExtensionEnabled === true
    && (
      (changesComputerExtension && !computerExtensionEnabled)
      || changesComputerConfiguration
    )
  ) {
    try {
      if (changesComputerConfiguration) {
        await computerResourceManager.resetAllContainers();
      } else {
        await computerResourceManager.stopAll();
      }
    } catch (caught) {
      const error = caughtError(caught);
      res.status(Number(error?.status) || 500).json({
        error: error?.message || 'Computer extension could not be disabled',
        code: error?.code || 'COMPUTER_DISABLE_FAILED',
      });
      return;
    }
  }
  try {
    configManager.updateSettings(settingsPatch);
  } catch (caught) {
    const error = caughtError(caught);
    if (error?.code && String(error.code).startsWith('AGENT_HOME_')) {
      res.status(Number(error.status) || 409).json({
        error: error.message || 'Agent Home configuration conflicts with persisted Agent metadata',
        code: error.code,
      });
      return;
    }
    throw caught;
  }
  if (changesBrowserExtension || changesBrowserConfiguration) {
    await browserResourceManager.refreshCapability();
  }
  if (changesComputerExtension || changesComputerConfiguration) {
    computerResourceManager.capabilityCache = null;
    await computerResourceManager.capability(true);
  }
  if (changesAgentHomes) {
    agentSessionInventory.invalidate();
    agentExtensionInventory.invalidate();
  }
  res.json({
    success: true,
    settings: configManager.getSettings()
  });
  queueStateMetadata(currentAgentListMetadata({ includeWorkspaceRoots: true }));
});

app.use(routePath(BASE_PATH, '/api/themes'), createThemeRouter({
  getTheme: themeId => themeManager.getTheme(themeId),
  getThemeCSS: themeId => themeManager.getThemeCSS(themeId),
  getThemeSettings: themeId => themeManager.getThemeSettings(themeId),
  updateThemeSettings: (themeId, settings) => themeManager.updateThemeSettings(themeId, settings),
}, themeId => configManager.updateSettings({ theme: themeId })));

wss.on('connection', (ws, req) => {
  initializeWebSocketLiveness(ws);
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const accessMode = tokenAuth.webSocketAccess(req);
  const computerViewerPrefix = routePath(BASE_PATH, '/api/computers/');
  if (url.pathname.startsWith(computerViewerPrefix) && url.pathname.endsWith('/viewer-websocket')) {
    if (accessMode === 'none') {
      ws.close(4001, 'Authentication required');
      return;
    }
    if (accessMode === 'read-only') {
      ws.close(4003, 'Computer Viewer is unavailable in read-only shares');
      return;
    }
    const encodedId = url.pathname.slice(
      computerViewerPrefix.length,
      -'/viewer-websocket'.length,
    );
    try {
      computerResourceManager.attachViewer(decodeURIComponent(encodedId), ws);
    } catch (caught) {
      const error = caughtError(caught);
      ws.close(4004, error?.message || 'Computer Resource not found');
    }
    return;
  }
  const viewerPrefix = routePath(BASE_PATH, '/api/browsers/');
  if (url.pathname.startsWith(viewerPrefix) && url.pathname.endsWith('/viewer')) {
    if (accessMode === 'none') {
      ws.close(4001, 'Authentication required');
      return;
    }
    const encodedId = url.pathname.slice(viewerPrefix.length, -'/viewer'.length);
    try {
      browserResourceManager.attachViewer(decodeURIComponent(encodedId), ws, {
        readOnly: accessMode === 'read-only',
      });
    } catch (caught) {
    const error = caughtError(caught);
      ws.close(4004, error?.message || 'Browser resource not found');
    }
    return;
  }
  if (url.pathname !== WS_PATH) {
    ws.close(1008, 'Invalid path');
    return;
  }

  // Verify token for WebSocket connections when auth is enabled.
  if (accessMode === 'none') {
    ws.close(4001, 'Authentication required');
    return;
  }

  ws.accessMode = accessMode;
  ws.connectionId = crypto.randomUUID();
  const connectedAt = Date.now();
  const remoteAddress = String(req.socket?.remoteAddress || 'unknown');
  const origin = String(req.headers.origin || '').slice(0, 200);
  const userAgent = String(req.headers['user-agent'] || '').slice(0, 200);
  console.log('Client connected', JSON.stringify({
    connectionId: ws.connectionId,
    remoteAddress,
    path: url.pathname,
    origin,
    userAgent,
  }));

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      const validation = validateClientMessage(data);
      if (validation.ok === false) {
        ws.send(JSON.stringify({
          type: 'protocol-error',
          protocolVersion: PROTOCOL_VERSION,
          requestId: typeof data?.requestId === 'string' ? data.requestId : '',
          message: validation.error,
        }));
        return;
      }
      if (rejectReadOnlyClientMutation(ws, validation.value as ServerClientMessage)) return;
      handleMessage(ws, validation.value as ServerClientMessage);
    } catch (e) {
      console.error('Failed to parse message:', e);
      ws.send(JSON.stringify({
        type: 'protocol-error',
        protocolVersion: PROTOCOL_VERSION,
        requestId: '',
        message: 'message must be valid JSON',
      }));
    }
  });
  
  ws.on('close', (code: number, reason: Buffer) => {
    workspaceFileWatchController.close(ws);
    cancelSessionPreviewHydration(ws);
    if (ws.initialStateSnapshotTimer) clearTimeout(ws.initialStateSnapshotTimer);
    if (ws.stateSnapshotRetryTimer) clearTimeout(ws.stateSnapshotRetryTimer);
    ws.stateSnapshotMessageBytes = 0;
    ws.stateSnapshotMessages = [];
    ws.stateSnapshotRetryTimer = null;
    ws.initialStateSnapshotTimer = null;
    ws.stateSnapshotInProgress = false;
    ws.stateSnapshotOverflowed = false;
    console.log('Client disconnected', JSON.stringify({
      connectionId: ws.connectionId,
      remoteAddress,
      durationMs: Date.now() - connectedAt,
      code,
      reason: reason?.toString('utf8').slice(0, 200) || '',
      protocolVersion: ws.protocolVersion ?? null,
    }));
  });
  
  ws.send(JSON.stringify({
    type: 'protocol-hello',
    protocolVersion: PROTOCOL_VERSION,
    minProtocolVersion: MIN_PROTOCOL_VERSION,
    accessMode,
  }));
  queueInitialStateSnapshot(ws);
});

function rejectReadOnlyClientMutation(ws: WebSocketClient, data: ServerClientMessage) {
  if (ws.accessMode !== 'read-only' || readOnlyClientMessageAllowed(data.type)) return false;
  ws.send(JSON.stringify({
    type: 'error',
    message: 'This Farming share is read-only.',
  }));
  return true;
}

const MAIN_AGENT_RESTART_COMMANDS = new Set(['codex', 'claude', 'opencode', 'qoder', 'qwen', 'bash', 'zsh']);

function normalizeMainAgentRestartCommand(command: string) {
  const normalized = String(command || '').trim();
  return MAIN_AGENT_RESTART_COMMANDS.has(normalized) ? normalized : '';
}

function restartMainAgent(ws: WebSocketClient, command: string) {
  const normalizedCommand = normalizeMainAgentRestartCommand(command);
  if (!normalizedCommand) {
    ws.send(JSON.stringify({ type: 'error', message: 'Unsupported Main Agent restart command' }));
    return;
  }

  void (async () => {
    try {
      const state = agentManager.getState();
      const currentMain = state.agents.find((agent: ServerRecord) => (
        agent.id === state.mainAgentId || agent.isMain === true
      ));
      if (currentMain) {
        const killed = await agentManager.killAgent(currentMain.id);
        if (killed?.error) {
          ws.send(JSON.stringify({ type: 'error', message: killed.error }));
          return;
        }
      }

      await agentManager.startAgent(normalizedCommand, null, (agentId, error) => {
        if (error) {
          ws.send(JSON.stringify({ type: 'error', message: error }));
        } else if (agentId) {
          ws.agentId = agentId;
          queueStateMetadata(currentAgentListMetadata());
          broadcastState();
          ws.send(JSON.stringify({ type: 'agent-started', agentId }));
        }
      }, {
        wantsMain: true
      });
    } catch (caught) {
    const error = caughtError(caught);
      const message = error instanceof Error ? error.message : 'Failed to restart Main Agent';
      ws.send(JSON.stringify({ type: 'error', message }));
      queueStateMetadata(currentAgentListMetadata());
      broadcastState();
    }
  })();
}

async function archiveAgentFromMessage(ws: WebSocketClient, agentId: string) {
  try {
    const result = await agentManager.archiveAgent(agentId) as ServerRecord;
    if (result?.error) {
      ws.send(JSON.stringify({ type: 'error', message: result.error }));
    }
  } catch (caught) {
    const error = caughtError(caught);
    ws.send(JSON.stringify({
      type: 'error',
      message: error instanceof Error ? error.message : 'Failed to archive Agent',
    }));
  } finally {
    queueStateMetadata(currentAgentListMetadata());
    broadcastState();
  }
}

async function sendComposerInputMessage(
  ws: WebSocketClient,
  data: Extract<ClientMessage, { type: 'composer-input' }>,
) {
  const targetAgentId = resolveInputTargetAgentId(ws, data);
  const requestId = typeof data.requestId === 'string' ? data.requestId.trim() : '';
  const delivery = data.delivery === 'steer' || data.delivery === 'prompt'
    ? data.delivery
    : 'auto';
  const responseAgentId = targetAgentId || (typeof data.agentId === 'string' ? data.agentId : '');
  const respond = (accepted: boolean, message = '', uncertain = false) => {
    if (!requestId || !responseAgentId) return;
    ws.send(JSON.stringify({
      type: 'composer-input-result',
      requestId,
      agentId: responseAgentId,
      accepted,
      ...(message ? { message } : {}),
      ...(uncertain ? { uncertain: true } : {}),
    }));
  };
  const message = typeof data.message === 'string' ? data.message : '';
  if (!/^[A-Za-z0-9._:-]{1,160}$/.test(requestId)) {
    if (responseAgentId) {
      ws.send(JSON.stringify({
        type: 'composer-input-result',
        requestId: requestId || 'invalid-request',
        agentId: responseAgentId,
        accepted: false,
        message: 'Structured Composer input requires a valid requestId',
      }));
    }
    return;
  }
  const content = [];
  if (message.trim()) content.push({ type: 'text', text: message });
  const attachmentsRoot = path.resolve(imageAttachmentsDir());
  const attachments = Array.isArray(data.attachments) ? data.attachments.slice(0, 8) : [];
  for (const attachment of attachments) {
    if (!['image', 'audio'].includes(attachment?.kind) || typeof attachment.path !== 'string') continue;
    const filePath = path.resolve(attachment.path);
    if (!filePath.startsWith(`${attachmentsRoot}${path.sep}`)) continue;
    const mimeType = typeof attachment.type === 'string' && attachment.kind === 'image' && /^image\/(?:png|jpe?g|gif|webp)$/i.test(attachment.type)
      ? attachment.type.toLowerCase()
      : (typeof attachment.type === 'string' && attachment.kind === 'audio' && Object.hasOwn(AUDIO_ATTACHMENT_EXTENSIONS, attachment.type.toLowerCase())
        ? attachment.type.toLowerCase()
        : '');
    if (!mimeType) continue;
    try {
      const data = await fs.promises.readFile(filePath);
      if (data.length === 0 || data.length > 12 * 1024 * 1024) continue;
      content.push({
        type: attachment.kind,
        data: data.toString('base64'),
        mimeType,
        path: filePath,
        uri: pathToFileURL(filePath).href,
      });
    } catch {
      // The text fallback already explains failed or unavailable uploads.
    }
  }
  if (!targetAgentId || content.length === 0) {
    respond(false, 'Composer message is empty');
    return;
  }
  const structuredRuntime = agentManager.agentRuntimeKind(targetAgentId) === 'acp';
  if (!structuredRuntime) {
    const error = 'Terminal Composer input requires the active terminal owner';
    if (requestId) respond(false, error);
    else ws.send(JSON.stringify({ type: 'error', message: error }));
    return;
  }
  try {
    await agentManager.sendComposerMessage(targetAgentId, content, { requestId, delivery });
    respond(true);
  } catch (caught) {
    const error = caughtError(caught);
    const message = error && error.message ? error.message : 'Failed to send Composer message';
    if (requestId) respond(false, message, error?.uncertain === true);
    else ws.send(JSON.stringify({ type: 'error', message }));
  }
}

async function sendBusinessHealthResult(ws: WebSocketClient, requestId: string) {
  const health = await probeAgentManagerBusinessHealth(agentManager);
  if (ws.readyState !== WebSocket.OPEN) return;
  recoverStateSnapshotIfReady(ws);
  recoverResourceSnapshotIfReady(ws);
  recoverAgentActivityIfReady(ws);
  recoverAcpSessionRevisionIfReady(ws);
  ws.send(JSON.stringify({
    type: 'business-health-result',
    requestId,
    serverEpoch: SERVER_EPOCH,
    protocolVersion: PROTOCOL_VERSION,
    ...health,
  }));
}

const registerClientMessage = createClientMessageRegistration<WebSocketClient>();
const websocketHandshakeHealthHandlers = createWebSocketHandshakeHealthHandlers({
  sendState,
  sendResourceSnapshots,
  sendLanguageServerRefreshSnapshot,
  sendBusinessHealthResult,
});
const websocketTerminalHandlers = createWebSocketTerminalHandlers({
  openState: WebSocket.OPEN,
  getAgentSessionView: agentId => agentManager.getAgentSessionView(agentId),
  sendInput: (agentId, inputParts) => agentManager.sendInput(agentId, inputParts),
  requestResize: (agentId, cols, rows) => agentManager.requestAgentSessionResize(agentId, cols, rows),
  clearBuffer: agentId => agentManager.clearAgentSessionBuffer(agentId),
  checkpointErrorMessage: caught => {
    const error = caughtError(caught);
    return error.message || 'Failed to read terminal checkpoint';
  },
});
const websocketFocusScopeHandlers = createWebSocketFocusScopeHandlers<WebSocketClient>({
  declarePreviewScope: client => declareSessionPreviewScope(client),
  prioritizeTranscript: agentId => agentManager.prioritizeAcpPreparedTranscript(agentId),
  sendAcpRevision: (client, agentId) => {
    const revision = currentAcpSessionRevision(agentId);
    if (revision) deliverAcpSessionRevision(client, revision);
  },
  sendFocusedActivity: (client, agentId) => {
    const activity = currentAgentActivity(agentId);
    if (activity) deliverAgentActivity(client, activity);
  },
  sendState,
  sendAllActivitySnapshot: sendAgentActivitySnapshot,
  sendPreviewHydration,
});
const clientMessageDispatchTable = defineClientMessageDispatchTable<WebSocketClient>({
  'protocol-hello': registerClientMessage('protocol-hello', websocketHandshakeHealthHandlers.protocolHello),
  'business-health-probe': registerClientMessage('business-health-probe', websocketHandshakeHealthHandlers.businessHealthProbe),
  'terminal-checkpoint-request': registerClientMessage('terminal-checkpoint-request', websocketTerminalHandlers.terminalCheckpointRequest),
  'state-resync': registerClientMessage('state-resync', websocketFocusScopeHandlers.stateResync),
  'start-agent': registerClientMessage('start-agent', (ws, data) => {
    const workspace = typeof data.workspace === 'string' ? data.workspace : null;
    const revealChatAgentWhileConnecting = data.agentRuntimeMode === 'chat';
    void (async () => {
      const projectWorkspace = data.asMain === true
        ? ''
        : await canonicalProjectWorkspace(
          typeof data.projectWorkspace === 'string' && data.projectWorkspace.trim()
            ? data.projectWorkspace
            : workspace
        );
      agentManager.startAgent(data.command, workspace, (agentId, error) => {
        if (error) {
          ws.send(JSON.stringify({ type: 'error', message: error }));
        } else if (agentId) {
          void (async () => {
            try {
              if (projectWorkspace) configManager.mountProjectWorkspace(projectWorkspace);
            } catch (mountError) {
              let rollbackError = '';
              try {
                const rollback = await agentManager.archiveAgent(agentId, {
                  reason: 'project-mount-failed',
                  recordHistory: false,
                  requireEngineExit: true,
                  scheduleProviderArchive: false,
                });
                if (rollback?.error) rollbackError = rollback.error;
              } catch (cleanupError) {
                rollbackError = caughtError(cleanupError).message || String(cleanupError);
              }
              queueStateMetadata(currentAgentListMetadata());
              broadcastState();
              const errorMessage = caughtError(mountError).message || 'Failed to create Project';
              ws.send(JSON.stringify({
                type: 'error',
                message: rollbackError
                  ? `${errorMessage}. Rollback failed: ${rollbackError}`
                  : errorMessage,
              }));
              return;
            }
            ws.agentId = agentId;
            queueStateMetadata(currentAgentListMetadata());
            broadcastState();
            ws.send(JSON.stringify({ type: 'agent-started', agentId }));
          })().catch((callbackError: unknown) => {
            console.warn('Failed to finish started Agent transition:', agentId, caughtError(callbackError).message || callbackError);
          });
        }
      }, {
        wantsMain: data.asMain === true,
        projectWorkspace,
        task: typeof data.task === 'string' ? data.task : '',
        workflowTemplate: typeof data.workflowTemplate === 'string' ? data.workflowTemplate : '',
        customTitle: typeof data.customTitle === 'string' ? data.customTitle : '',
        createRequestId: typeof data.requestId === 'string' ? data.requestId : '',
        codexApprovalMode: typeof data.codexApprovalMode === 'string' ? data.codexApprovalMode : undefined,
        agentRuntimeMode: typeof data.agentRuntimeMode === 'string' && ['acp', 'chat'].includes(data.agentRuntimeMode) ? data.agentRuntimeMode : 'terminal',
        acpHistoryMode: data.acpHistoryMode === 'resume' ? 'resume' : 'load',
        providerHomeId: typeof data.providerHomeId === 'string' ? data.providerHomeId : '',
        ...(revealChatAgentWhileConnecting ? {
          onAgentRegistered: (agentId: string) => {
            ws.agentId = agentId;
            broadcastState();
            ws.send(JSON.stringify({ type: 'agent-started', agentId }));
          },
        } : {}),
        ...(Array.isArray(data.additionalDirectories) ? { additionalDirectories: data.additionalDirectories } : {}),
        ...(Array.isArray(data.mcpServers) ? { mcpServers: data.mcpServers } : {}),
        ...(data.dangerouslySkipPermissions === true ? { dangerouslySkipPermissions: true } : {}),
      });
    })().catch((error: unknown) => {
      ws.send(JSON.stringify({
        type: 'error',
        message: caughtError(error).message || 'Failed to resolve Project workspace',
      }));
    });
  }),
  input: registerClientMessage('input', websocketTerminalHandlers.input),
  'composer-input': registerClientMessage('composer-input', (ws, data) => {
    void sendComposerInputMessage(ws, data);
  }),
  'acp-permission-response': registerClientMessage('acp-permission-response', (ws, data) => {
    try {
      agentManager.respondToAcpPermission(
        data.agentId,
        data.requestId,
        data.optionId,
        data.cancelled === true
      );
    } catch (caught) {
      const error = caughtError(caught);
      ws.send(JSON.stringify({
        type: 'error',
        message: error && error.message ? error.message : 'Failed to respond to ACP permission',
      }));
    }
  }),
  'interrupt-agent': registerClientMessage('interrupt-agent', (_ws, data) => {
    if (data.agentId) {
      void agentManager.interruptAgent(data.agentId);
    }
  }),
  'focus-agent': registerClientMessage('focus-agent', websocketFocusScopeHandlers.focusAgent),
  'resize-agent': registerClientMessage('resize-agent', websocketTerminalHandlers.resizeAgent),
  'clear-terminal': registerClientMessage('clear-terminal', websocketTerminalHandlers.clearTerminal),
  'watch-workspace-files': registerClientMessage('watch-workspace-files', (ws, data) => {
    void workspaceFileWatchController.watch(ws, data.agentId);
  }),
  'unwatch-workspace-files': registerClientMessage('unwatch-workspace-files', (ws, data) => {
    workspaceFileWatchController.unwatch(ws, data.agentId);
  }),
  'archive-agent': registerClientMessage('archive-agent', (ws, data) => {
    void archiveAgentFromMessage(ws, data.agentId);
  }),
  'restart-main-agent': registerClientMessage('restart-main-agent', (ws, data) => {
    restartMainAgent(ws, data.command);
  }),
});

function handleMessage(ws: WebSocketClient, data: ServerClientMessage) {
  dispatchClientMessage(clientMessageDispatchTable, ws, data);
}

import { resolveInputTargetAgentId } from './input-routing.cjs';

function projectAgentState(agent: ServerRecord & { id: string }) {
  return {
    ...agent,
    workspaceRootId: rootIdForPath(String(agent.projectWorkspace || (agent.gitWorktree as ServerRecord | undefined)?.workspace || agent.cwd || '')),
  };
}

function buildStatePayload() {
  const state = agentManager.getState();
  return {
    ...state,
    agents: state.agents
      .filter(agent => agentStateVisibleToInteractiveClients(agent as ServerRecord & { id: string }))
      .map(agent => projectAgentState(agent as ServerRecord & { id: string })),
    ...currentAgentListMetadata({ includeWorkspaceRoots: true }),
  };
}

function currentAgentListMetadata(options: { includeWorkspaceRoots?: boolean } = {}) {
  const settings = configManager.getSettings();
  return {
    mainPageSessionKeys: typeof configManager.getMainPageSessionKeys === 'function'
      ? configManager.getMainPageSessionKeys()
      : (Array.isArray(settings.mainPageSessionKeys) ? settings.mainPageSessionKeys : []),
    projectWorkspaces: settings.projectWorkspaces || [],
    pinnedProjectWorkspaces: settings.pinnedProjectWorkspaces || [],
    ...(options.includeWorkspaceRoots === true
      ? { workspaceRoots: workspaceRootRegistry.list() }
      : {}),
  };
}

function sendState(ws: WebSocketClient) {
  ws.initialStateSnapshotSent = true;
  if (ws.initialStateSnapshotTimer) clearTimeout(ws.initialStateSnapshotTimer);
  ws.initialStateSnapshotTimer = null;
  if (ws.stateSnapshotInProgress) {
    ws.stateSnapshotPending = true;
    return;
  }
  cancelSessionPreviewHydration(ws);
  broadcastState(ws, true);
  const stateScope = normalizeAgentStateScope(ws.stateScope);
  const state = agentStateBroadcastSnapshotForScope(
    stateBroadcastTracker,
    stateScope,
    ws.focusedAgentId,
  );
  const summaries = agentStateBroadcastProjectSummaries(stateBroadcastTracker);
  if (!state || !summaries) {
    ws.stateSnapshotPending = true;
    ws.send(JSON.stringify({
      type: 'error',
      message: 'Agent state snapshot is temporarily unavailable; Farming will retry',
    }));
    return;
  }
  const snapshotId = `${SERVER_EPOCH}:${stateBroadcastTracker.sequence}:${++stateSnapshotSerial}`;
  const forceSinglePage = ws.stateSnapshotOverflowed === true;
  ws.stateSnapshotOverflowed = false;
  const frames = agentStateSnapshotFrames(
    {
      ...state,
      projectAgentSummaries: summaries,
    },
    snapshotId,
    forceSinglePage ? Math.max(1, state.agents.length) : INITIAL_AGENT_STATE_SNAPSHOT_PAGE_SIZE,
    forceSinglePage ? Math.max(1, state.agents.length) : AGENT_STATE_SNAPSHOT_PAGE_SIZE,
  )[Symbol.iterator]();
  const sequence = stateBroadcastTracker.sequence;
  ws.stateSnapshotInProgress = true;
  ws.stateSnapshotPending = false;
  ws.stateSnapshotMessageBytes = 0;
  ws.stateSnapshotMessages = [];
  const activityScope = normalizeAgentActivityScope(ws.activityScope);
  const agentSnapshotCoversActivity = activityScope === 'none'
    || stateScope === 'all'
    || (activityScope === 'focused' && Boolean(ws.focusedAgentId));
  if (agentSnapshotCoversActivity) {
    ws.agentActivityAllCheckpointPending = false;
    ws.agentActivityCheckpointPending = false;
    ws.agentActivityResyncPending = false;
  } else if (ws.agentActivityResyncPending) {
    if (activityScope === 'all') ws.agentActivityAllCheckpointPending = true;
    else if (activityScope === 'focused') ws.agentActivityCheckpointPending = true;
  }

  const queueNextPage = (delayMs: number, callback: () => void = deliverNextPage) => {
    if (ws.stateSnapshotRetryTimer) clearTimeout(ws.stateSnapshotRetryTimer);
    ws.stateSnapshotRetryTimer = setTimeout(callback, delayMs);
    ws.stateSnapshotRetryTimer.unref?.();
  };
  const finishSnapshotDelivery = () => {
    ws.stateSnapshotInProgress = false;
    ws.stateSnapshotRetryTimer = null;
    recoverAgentActivityIfReady(ws);
    recoverAcpSessionRevisionIfReady(ws);
    queueSessionPreviewHydration(
      ws,
      PREVIEW_SCOPE_DECLARATION_WINDOW_MS,
      () => {
        if (ws.readyState === WebSocket.OPEN) sendPreviewHydration(ws);
      },
    );
  };
  const restartPendingSnapshot = () => {
    if (!ws.stateSnapshotPending) return false;
    ws.stateSnapshotMessages?.forEach(queued => queued.onDiscard?.());
    ws.stateSnapshotMessageBytes = 0;
    ws.stateSnapshotMessages = [];
    ws.stateSnapshotInProgress = false;
    sendState(ws);
    return true;
  };
  const drainSnapshotDeltas = () => {
    ws.stateSnapshotRetryTimer = null;
    if (ws.readyState !== WebSocket.OPEN) {
      ws.stateSnapshotInProgress = false;
      return;
    }
    if (restartPendingSnapshot()) return;
    if (ws.bufferedAmount > MAX_STATE_CLIENT_BUFFERED_AMOUNT) {
      queueNextPage(AGENT_STATE_SNAPSHOT_BACKPRESSURE_RETRY_MS, drainSnapshotDeltas);
      return;
    }
    const queued = ws.stateSnapshotMessages?.[0];
    if (!queued) {
      ws.stateSnapshotMessageBytes = 0;
      finishSnapshotDelivery();
      return;
    }
    if (
      Number.isFinite(queued.maxBufferedAmount)
      && ws.bufferedAmount > Number(queued.maxBufferedAmount)
    ) {
      queueNextPage(AGENT_STATE_SNAPSHOT_BACKPRESSURE_RETRY_MS, drainSnapshotDeltas);
      return;
    }
    ws.stateSnapshotMessages?.shift();
    ws.stateSnapshotMessageBytes = Math.max(
      0,
      (ws.stateSnapshotMessageBytes || 0) - Buffer.byteLength(queued.message),
    );
    deliverDeferredAgentStateMessage(queued, message => ws.send(message));
    queueNextPage(0, drainSnapshotDeltas);
  };
  const completeSnapshot = () => {
    ws.stateSnapshotRetryTimer = null;
    if (forceSinglePage) {
      // The overflow fallback is emitted synchronously as one complete frame,
      // so no post-cut message can exist yet. Release the barrier immediately;
      // later sends remain ordered behind that frame by the WebSocket transport.
      finishSnapshotDelivery();
      return;
    }
    drainSnapshotDeltas();
  };
  let sentPages = 0;
  function deliverNextPage() {
    ws.stateSnapshotRetryTimer = null;
    if (ws.readyState !== WebSocket.OPEN) {
      ws.stateSnapshotInProgress = false;
      return;
    }
    if (restartPendingSnapshot()) return;
    if (sentPages > 0 && ws.bufferedAmount > MAX_STATE_CLIENT_BUFFERED_AMOUNT) {
      queueNextPage(AGENT_STATE_SNAPSHOT_BACKPRESSURE_RETRY_MS);
      return;
    }
    const next = frames.next();
    if (next.done) {
      completeSnapshot();
      return;
    }
    ws.send(JSON.stringify({
      type: 'state',
      generation: SERVER_EPOCH,
      sequence,
      ...next.value,
    }));
    sentPages += 1;
    if (next.value.snapshot.complete) {
      completeSnapshot();
      return;
    }
    queueNextPage(sentPages === 1 ? INITIAL_AGENT_STATE_SNAPSHOT_FOLLOWUP_DELAY_MS : 0);
  }
  deliverNextPage();
}

function queueInitialStateSnapshot(ws: WebSocketClient) {
  if (ws.initialStateSnapshotSent === true || ws.initialStateSnapshotTimer) return;
  ws.initialStateSnapshotTimer = setTimeout(() => {
    ws.initialStateSnapshotTimer = null;
    if (ws.readyState === WebSocket.OPEN && ws.initialStateSnapshotSent !== true) sendState(ws);
  }, INITIAL_STATE_SCOPE_DECLARATION_WINDOW_MS);
  ws.initialStateSnapshotTimer.unref?.();
}

function sendResourceSnapshots(ws: WebSocketClient) {
  if (ws.readyState !== WebSocket.OPEN || ws.protocolVersion !== PROTOCOL_VERSION) return;
  ws.send(JSON.stringify({
    type: 'browser-resource-snapshot',
    snapshot: browserResourceManager.stateSnapshot(),
  }));
  ws.send(JSON.stringify({
    type: 'computer-resource-snapshot',
    snapshot: computerResourceManager.stateSnapshot(),
  }));
  ws.resourceSnapshotPending = false;
}

function previewForClient(preview: ServerRecord, client: WebSocketClient) {
  if (!preview || !client || client.focusedAgentId !== preview.agentId || !preview.previewSnapshot) {
    return preview;
  }
  // The active terminal is hydrated from its authoritative checkpoint and
  // receives live session-output. Sending its sidebar snapshot again adds a
  // large, unrelated React update to every keystroke in a full-screen TUI.
  return {
    ...preview,
    previewSnapshot: null,
  };
}

let missingPreviewAgentIdWarningSent = false;

function sendPreviewIfInScope(ws: WebSocketClient, preview: ServerRecord) {
  const previewAgentId = typeof preview.agentId === 'string' ? preview.agentId : '';
  if (!previewAgentId) {
    if (!missingPreviewAgentIdWarningSent) {
      missingPreviewAgentIdWarningSent = true;
      console.warn('Ignoring Session preview without an exact Agent identity');
    }
    return false;
  }
  if (
    ws.previewScopeDeclared !== true
    && (ws.stateSnapshotInProgress || ws.previewHydrationPending === true)
  ) return false;
  if (!sessionPreviewScopeIncludesAgent(ws.previewScope, ws.focusedAgentId, previewAgentId)) return false;
  if (ws.stateSnapshotInProgress) {
    // Preview is an absolute replaceable projection. Snapshot completion
    // hydrates the latest value for the then-current Preview scope.
    return true;
  }
  ws.send(JSON.stringify({
    type: 'session-preview',
    preview: previewForClient(preview, ws),
  }));
  return true;
}

function sendPreviewHydration(ws: WebSocketClient) {
  const scope = normalizeSessionPreviewScope(ws.previewScope);
  if (scope === 'none') return;
  if (scope === 'focused') {
    if (!ws.focusedAgentId) return;
    const preview = agentManager.getPreviewPayload(ws.focusedAgentId) as ServerRecord | null;
    if (preview) sendPreviewIfInScope(ws, preview);
    return;
  }
  agentManager.getPreviewPayloads().forEach((preview: ServerRecord) => {
    sendPreviewIfInScope(ws, preview);
  });
}

const STATE_BROADCAST_INTERVAL_MS = 120;
const INITIAL_AGENT_STATE_SNAPSHOT_PAGE_SIZE = 32;
const AGENT_STATE_SNAPSHOT_PAGE_SIZE = 128;
const INITIAL_AGENT_STATE_SNAPSHOT_FOLLOWUP_DELAY_MS = 200;
const INITIAL_STATE_SCOPE_DECLARATION_WINDOW_MS = 100;
const AGENT_STATE_SNAPSHOT_BACKPRESSURE_RETRY_MS = 25;
const MAX_AGENT_STATE_SNAPSHOT_MESSAGE_COUNT = 256;
const MAX_AGENT_STATE_SNAPSHOT_MESSAGE_BYTES = 1024 * 1024;
const AGENT_STATE_SNAPSHOT_MESSAGE_LIMITS = {
  maxBytes: MAX_AGENT_STATE_SNAPSHOT_MESSAGE_BYTES,
  maxCount: MAX_AGENT_STATE_SNAPSHOT_MESSAGE_COUNT,
};
const PREVIEW_BROADCAST_INTERVAL_MS = 500;
const PREVIEW_SCOPE_DECLARATION_WINDOW_MS = 100;
const SESSION_STREAM_BROADCAST_INTERVAL_MS = 33;
const AGENT_ACTIVITY_BROADCAST_DELAY_MS = SESSION_STREAM_BROADCAST_INTERVAL_MS;
const MAX_SESSION_STREAM_CLIENT_BUFFERED_AMOUNT = 4 * 1024 * 1024;
const MAX_STATE_CLIENT_BUFFERED_AMOUNT = 512 * 1024;
const MAX_AGENT_ACTIVITY_CLIENT_BUFFERED_AMOUNT = 256 * 1024;
const MAX_ACP_REVISION_CLIENT_BUFFERED_AMOUNT = 256 * 1024;
const RESOURCE_BROADCAST_INTERVAL_MS = 100;
const MAX_RESOURCE_CLIENT_BUFFERED_AMOUNT = 512 * 1024;

type AgentScopedServerEvent = Record<string, unknown> & { agentId: string };

function isAgentScopedServerEvent(value: unknown): value is AgentScopedServerEvent {
  return isRecord(value) && typeof value.agentId === 'string' && value.agentId.length > 0;
}

function currentAgentActivity(agentId: string): AgentScopedServerEvent | null {
  return agentManager.getAgentActivityPayload(agentId, Date.now()) as AgentScopedServerEvent | null;
}

function sendAgentActivitySnapshot(client: WebSocketClient) {
  if (
    client.readyState !== WebSocket.OPEN
    || client.protocolVersion !== PROTOCOL_VERSION
    || client.activityScopeDeclared !== true
    || normalizeAgentActivityScope(client.activityScope) !== 'all'
  ) return;
  if (client.stateSnapshotInProgress) {
    // Agent-state and Activity scopes are independent. Defer the absolute
    // Activity checkpoint until the progressive Agent snapshot is complete.
    client.agentActivityAllCheckpointPending = true;
    queueAgentActivityRecovery(client);
    return;
  }
  if (client.bufferedAmount > MAX_AGENT_ACTIVITY_CLIENT_BUFFERED_AMOUNT) {
    client.agentActivityAllCheckpointPending = true;
    queueAgentActivityRecovery(client);
    return;
  }
  const activities = agentManager.getAgentActivityPayloads(Date.now());
  client.send(JSON.stringify({ type: 'agent-activity-snapshot', activities }));
  client.agentActivityAllCheckpointPending = false;
  client.agentActivityResyncPending = false;
}

function sendCompatibleAgentActivityCheckpoint(client: WebSocketClient) {
  if (client.readyState !== WebSocket.OPEN) return;
  agentManager.getAgentActivityPayloads(Date.now()).forEach((activity: AgentScopedServerEvent) => {
    client.send(JSON.stringify({ type: 'agent-activity', activity }));
  });
  client.agentActivityAllCheckpointPending = false;
  client.agentActivityResyncPending = false;
}

function deliverAgentActivity(
  client: WebSocketClient,
  activity: AgentScopedServerEvent,
  message = JSON.stringify({ type: 'agent-activity', activity }),
) {
  if (client.readyState !== WebSocket.OPEN) return;
  const activityIsRelevant = () => {
    if (client.activityScopeDeclared !== true) return true;
    const currentScope = normalizeAgentActivityScope(client.activityScope);
    return currentScope !== 'none'
      && (currentScope !== 'focused' || client.focusedAgentId === activity.agentId);
  };
  if (client.activityScopeDeclared !== true) {
    if (client.stateSnapshotInProgress) {
      client.agentActivityAllCheckpointPending = true;
      queueAgentActivityRecovery(client);
      return;
    }
    client.send(message);
    return;
  }
  if (client.protocolVersion !== PROTOCOL_VERSION) {
    client.agentActivityResyncPending = true;
    return;
  }
  const scope = normalizeAgentActivityScope(client.activityScope);
  if (!activityIsRelevant()) {
    client.agentActivityResyncPending = true;
    return;
  }
  if (client.stateSnapshotInProgress) {
    if (scope === 'all') client.agentActivityAllCheckpointPending = true;
    else client.agentActivityCheckpointPending = true;
    queueAgentActivityRecovery(client);
    return;
  }
  const delivery = agentActivityClientDelivery(
    scope,
    client.focusedAgentId,
    client.agentActivityAllCheckpointPending === true,
    client.bufferedAmount,
    MAX_AGENT_ACTIVITY_CLIENT_BUFFERED_AMOUNT,
    activity.agentId,
  );
  if (delivery === 'skip') return;
  if (delivery === 'defer') {
    if (scope === 'all') client.agentActivityAllCheckpointPending = true;
    else client.agentActivityCheckpointPending = true;
    queueAgentActivityRecovery(client);
    return;
  }
  client.send(message);
  if (scope === 'focused') client.agentActivityCheckpointPending = false;
}

function recoverAgentActivityIfReady(client: WebSocketClient) {
  if (client.stateSnapshotInProgress) {
    if (client.agentActivityAllCheckpointPending || client.agentActivityCheckpointPending) {
      queueAgentActivityRecovery(client);
    }
    return;
  }
  const scope = normalizeAgentActivityScope(client.activityScope);
  if (client.agentActivityAllCheckpointPending === true) {
    if (scope === 'all' && client.bufferedAmount <= MAX_AGENT_ACTIVITY_CLIENT_BUFFERED_AMOUNT) {
      if (client.activityScopeDeclared === true) sendAgentActivitySnapshot(client);
      else sendCompatibleAgentActivityCheckpoint(client);
    } else if (scope !== 'all') {
      client.agentActivityAllCheckpointPending = false;
      client.agentActivityResyncPending = true;
    }
  }
  if (client.agentActivityCheckpointPending === true) {
    if (scope !== 'focused' || !client.focusedAgentId) {
      client.agentActivityResyncPending = true;
      client.agentActivityCheckpointPending = false;
    } else if (client.bufferedAmount <= MAX_AGENT_ACTIVITY_CLIENT_BUFFERED_AMOUNT) {
      const activity = currentAgentActivity(client.focusedAgentId);
      if (activity) deliverAgentActivity(client, activity);
      else client.agentActivityCheckpointPending = false;
    }
  }
  if (client.agentActivityAllCheckpointPending || client.agentActivityCheckpointPending) {
    queueAgentActivityRecovery(client);
  }
}

function queueAgentActivityRecovery(client: WebSocketClient) {
  if (client.agentActivityRecoveryTimer || client.readyState !== WebSocket.OPEN) return;
  client.agentActivityRecoveryTimer = setTimeout(() => {
    client.agentActivityRecoveryTimer = null;
    if (client.readyState === WebSocket.OPEN) recoverAgentActivityIfReady(client);
  }, 250);
  client.agentActivityRecoveryTimer.unref?.();
}

function currentAcpSessionRevision(agentId: string) {
  const agent = agentManager.getAgentState(agentId, Date.now()) as ServerRecord | null;
  const runtimeBinding = isRecord(agent?.runtimeBinding) ? agent.runtimeBinding : null;
  const revision = Number(runtimeBinding?.sessionRevision);
  const updatedAt = typeof runtimeBinding?.sessionUpdatedAt === 'string'
    ? runtimeBinding.sessionUpdatedAt
    : '';
  if (runtimeBinding?.kind !== 'acp' || !Number.isInteger(revision) || revision < 0 || !updatedAt) return null;
  return { agentId, revision, updatedAt };
}

function deliverAcpSessionRevision(client: WebSocketClient, session: AgentScopedServerEvent) {
  if (client.readyState !== WebSocket.OPEN || client.protocolVersion !== PROTOCOL_VERSION) return;
  const sessionIsRelevant = () => Boolean(
    client.focusedAgentId
    && client.focusedAgentId === session.agentId
  );
  const delivery = acpRevisionClientDelivery(
    client.focusedAgentId,
    client.acpRevisionSentRevision,
    client.stateSnapshotInProgress ? 0 : client.bufferedAmount,
    MAX_ACP_REVISION_CLIENT_BUFFERED_AMOUNT,
    { agentId: session.agentId, revision: Number(session.revision) },
  );
  if (delivery === 'skip') return;
  if (delivery === 'defer') {
    client.acpRevisionCheckpointPending = true;
    return;
  }
  const message = JSON.stringify({ type: 'acp-session-revision', session });
  const markSent = () => {
    client.acpRevisionSentRevision = Number(session.revision);
    client.acpRevisionCheckpointPending = false;
  };
  const markDiscarded = () => {
    if (sessionIsRelevant()) client.acpRevisionCheckpointPending = true;
  };
  if (deferUntilAgentStateSnapshotCompletes(
    client,
    message,
    sessionIsRelevant,
    markSent,
    markDiscarded,
    MAX_ACP_REVISION_CLIENT_BUFFERED_AMOUNT,
  )) return;
  client.send(message);
  markSent();
}

function recoverAcpSessionRevisionIfReady(client: WebSocketClient) {
  if (client.acpRevisionCheckpointPending !== true || !client.focusedAgentId) return;
  const revision = currentAcpSessionRevision(client.focusedAgentId);
  if (!revision) {
    client.acpRevisionCheckpointPending = false;
    return;
  }
  deliverAcpSessionRevision(client, revision);
}

let stateBroadcastTimer: ReturnType<typeof setTimeout> | null = null;
let lastStateBroadcastAt = 0;
const stateBroadcastTracker = createAgentStateBroadcastTracker();
let stateSnapshotSerial = 0;
const pendingStateAgentIds = new Set<string>();
let pendingMainAgentIdState = false;
let pendingTaskHistoryState = false;
let pendingStateMetadata: Record<string, unknown> = {};
const pendingPreviewBroadcasts = new Map();
const pendingAgentActivityBroadcasts = new Map();
const pendingAgentUpdates = new Map();
const pendingAcpSessionRevisions = new Map();
const websocketResourceBroadcasts = createWebSocketResourceBroadcastController<WebSocketClient>({
  clients: () => wss.clients,
  intervalMs: RESOURCE_BROADCAST_INTERVAL_MS,
  maxBufferedAmount: MAX_RESOURCE_CLIENT_BUFFERED_AMOUNT,
  openState: WebSocket.OPEN,
  protocolVersion: PROTOCOL_VERSION,
  sendResourceSnapshots,
  setTimer: setTimeout,
});

function recoverResourceSnapshotIfReady(client: WebSocketClient) {
  websocketResourceBroadcasts.recoverSnapshotIfReady(client);
}

function scheduleResourceUpdate(domain: 'browser' | 'computer', resource: unknown) {
  websocketResourceBroadcasts.scheduleUpdate(domain, resource);
}

function scheduleResourceDeletion(domain: 'browser' | 'computer', deletion: unknown) {
  websocketResourceBroadcasts.scheduleDeletion(domain, deletion);
}

browserResourceManager.on('resource', (resource: unknown) => scheduleResourceUpdate('browser', resource));
browserResourceManager.on('deleted', (deletion: unknown) => scheduleResourceDeletion('browser', deletion));
computerResourceManager.on('resource', (resource: unknown) => scheduleResourceUpdate('computer', resource));
computerResourceManager.on('deleted', (deletion: unknown) => scheduleResourceDeletion('computer', deletion));

function deferUntilAgentStateSnapshotCompletes(
  client: WebSocketClient,
  message: string,
  isRelevant?: () => boolean,
  onSent?: () => void,
  onDiscard?: () => void,
  maxBufferedAmount?: number,
) {
  return deferAgentStateMessageDuringSnapshot(
    client,
    {
      message,
      ...(isRelevant ? { isRelevant } : {}),
      ...(onSent ? { onSent } : {}),
      ...(onDiscard ? { onDiscard } : {}),
      ...(Number.isFinite(maxBufferedAmount) ? { maxBufferedAmount } : {}),
    },
    AGENT_STATE_SNAPSHOT_MESSAGE_LIMITS,
  );
}

function deliverStateDelta(client: WebSocketClient, message: string) {
  if (deferUntilAgentStateSnapshotCompletes(client, message)) return;
  const delivery = agentStateClientDelivery(
    client.bufferedAmount,
    client.stateSnapshotPending === true,
    MAX_STATE_CLIENT_BUFFERED_AMOUNT,
  );
  if (delivery === 'defer') {
    client.stateSnapshotPending = true;
    return;
  }
  if (delivery === 'snapshot') {
    sendState(client);
    return;
  }
  client.send(message);
}

function recoverStateSnapshotIfReady(client: WebSocketClient) {
  if (
    client.readyState !== WebSocket.OPEN
    || client.stateSnapshotInProgress
    || client.stateSnapshotPending !== true
  ) return;
  if (client.bufferedAmount <= MAX_STATE_CLIENT_BUFFERED_AMOUNT) sendState(client);
}

function pendingAgentStateMutation() {
  const upserts = [];
  const removedAgentIds = [];
  const now = Date.now();
  for (const agentId of pendingStateAgentIds) {
    const agent = agentManager.getAgentState(agentId, now) as (ServerRecord & { id: string }) | null;
    if (agent && agentStateVisibleToInteractiveClients(agent)) upserts.push(projectAgentState(agent));
    else removedAgentIds.push(agentId);
  }
  const managerMetadata = agentManager.getStateMetadata();
  const state = {
    ...pendingStateMetadata,
    ...(pendingMainAgentIdState ? { mainAgentId: managerMetadata.mainAgentId } : {}),
    ...(pendingTaskHistoryState ? { taskHistory: managerMetadata.taskHistory } : {}),
  };
  pendingStateAgentIds.clear();
  pendingMainAgentIdState = false;
  pendingTaskHistoryState = false;
  pendingStateMetadata = {};
  return {
    upserts,
    removedAgentIds,
    ...(Object.keys(state).length > 0 ? { state } : {}),
  };
}

function broadcastState(
  excludedClient: WebSocketClient | null = null,
  authoritativeCheckpoint = false,
) {
  lastStateBroadcastAt = Date.now();
  if (stateBroadcastTimer) clearTimeout(stateBroadcastTimer);
  stateBroadcastTimer = null;
  const mutation = pendingAgentStateMutation();
  const delta = authoritativeCheckpoint
    ? advanceAgentStateBroadcast(
        stateBroadcastTracker,
        buildStatePayload() as AgentStatePayload,
      )
    : advanceAgentStateMutation(stateBroadcastTracker, mutation);
  if (!delta) return;
  const inventorySummary = agentStateBroadcastInventorySummary(stateBroadcastTracker);
  const allDelta = inventorySummary
    ? {
        ...delta,
        state: {
          ...(delta.state || {}),
          agentInventoryScope: 'all',
          ...inventorySummary,
        },
      }
    : delta;
  const allClientMessage = JSON.stringify({
    type: 'state-delta',
    generation: SERVER_EPOCH,
    ...allDelta,
  });
  wss.clients.forEach(client => {
    if (client === excludedClient || client.readyState !== WebSocket.OPEN) return;
    const scopedDelta = agentStateDeltaForScope(
      delta,
      normalizeAgentStateScope(client.stateScope),
      client.focusedAgentId,
    );
    const focusedScope = normalizeAgentStateScope(client.stateScope) === 'focused';
    const clientDelta = focusedScope
      ? (inventorySummary ? {
          ...scopedDelta,
          state: {
            ...(scopedDelta.state || {}),
            agentInventoryScope: 'focused',
            ...inventorySummary,
          },
        } : scopedDelta)
      : allDelta;
    const message = clientDelta === allDelta
      ? allClientMessage
      : JSON.stringify({
          type: 'state-delta',
          generation: SERVER_EPOCH,
          ...clientDelta,
        });
    deliverStateDelta(client, message);
  });
}

function queueAgentStateChange(change: AgentManagerStateChange) {
  change.agentIds?.forEach(agentId => pendingStateAgentIds.add(agentId));
  change.removedAgentIds?.forEach(agentId => pendingStateAgentIds.add(agentId));
  if (change.mainAgentIdChanged === true) pendingMainAgentIdState = true;
  if (change.taskHistoryChanged === true) pendingTaskHistoryState = true;
  scheduleBroadcastState();
}

function queueStateMetadata(state: Record<string, unknown>) {
  Object.assign(pendingStateMetadata, state);
  scheduleBroadcastState();
}

function scheduleBroadcastState() {
  const now = Date.now();
  const elapsed = now - lastStateBroadcastAt;

  if (elapsed >= STATE_BROADCAST_INTERVAL_MS) {
    broadcastState();
    return;
  }

  if (stateBroadcastTimer) {
    return;
  }

  stateBroadcastTimer = setTimeout(() => {
    broadcastState();
  }, STATE_BROADCAST_INTERVAL_MS - elapsed);
}

function broadcastSessionPreview(preview: ServerRecord) {
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) sendPreviewIfInScope(client, preview);
  });
}

function schedulePreviewBroadcast(preview: ServerRecord) {
  const agentId = preview && preview.agentId;
  if (!agentId) {
    broadcastSessionPreview(preview);
    return;
  }

  const now = Date.now();
  const entry = pendingPreviewBroadcasts.get(agentId) || {
    lastAt: 0,
    timer: null,
    preview: null,
  };
  entry.preview = preview;

  const elapsed = now - entry.lastAt;
  if (elapsed >= PREVIEW_BROADCAST_INTERVAL_MS) {
    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
    entry.lastAt = now;
    const latest = entry.preview;
    entry.preview = null;
    pendingPreviewBroadcasts.set(agentId, entry);
    broadcastSessionPreview(latest);
    return;
  }

  if (!entry.timer) {
    entry.timer = setTimeout(() => {
      entry.timer = null;
      entry.lastAt = Date.now();
      const latest = entry.preview;
      entry.preview = null;
      pendingPreviewBroadcasts.set(agentId, entry);
      if (latest) {
        broadcastSessionPreview(latest);
      }
    }, PREVIEW_BROADCAST_INTERVAL_MS - elapsed);
  }

  pendingPreviewBroadcasts.set(agentId, entry);
}

agentManager.onUpdate(queueAgentStateChange);

agentManager.on('provider-session-updated', () => {
  agentSessionInventory.invalidate();
});

function broadcastAgentActivity(activity: AgentScopedServerEvent) {
  const message = JSON.stringify({
    type: 'agent-activity',
    activity,
  });
  wss.clients.forEach((client) => {
    deliverAgentActivity(client, activity, message);
  });
}

function scheduleAgentActivityBroadcast(activity: unknown) {
  if (!isAgentScopedServerEvent(activity)) return;
  const agentId = activity.agentId;
  const existing = pendingAgentActivityBroadcasts.get(agentId);
  if (existing) {
    existing.activity = activity;
    return;
  }
  const entry = {
    activity,
    timer: setTimeout(() => {
      pendingAgentActivityBroadcasts.delete(agentId);
      broadcastAgentActivity(entry.activity);
    }, AGENT_ACTIVITY_BROADCAST_DELAY_MS),
  };
  entry.timer.unref?.();
  pendingAgentActivityBroadcasts.set(agentId, entry);
}

agentManager.onAgentActivity(scheduleAgentActivityBroadcast);

function scheduleAgentUpdate(update: unknown) {
  if (!isAgentScopedServerEvent(update)) return;
  const patch = sanitizeAgentUpdatePatch(update?.patch);
  if (!patch) return;
  const existing = pendingAgentUpdates.get(update.agentId);
  if (existing) {
    Object.assign(existing.patch, patch);
    return;
  }
  const entry = {
    patch,
    timer: setTimeout(() => {
      pendingAgentUpdates.delete(update.agentId);
      const message = JSON.stringify({
        type: 'agent-update',
        update: { agentId: update.agentId, patch: entry.patch },
      });
      wss.clients.forEach((client) => {
        if (
          client.readyState === WebSocket.OPEN
          && agentStateScopeIncludesAgent(
            normalizeAgentStateScope(client.stateScope),
            client.focusedAgentId,
            update.agentId,
          )
        ) {
          const stillRelevant = () => agentStateScopeIncludesAgent(
            normalizeAgentStateScope(client.stateScope),
            client.focusedAgentId,
            update.agentId,
          );
          if (!deferUntilAgentStateSnapshotCompletes(client, message, stillRelevant)) {
            client.send(message);
          }
        }
      });
    }, AGENT_ACTIVITY_BROADCAST_DELAY_MS),
  };
  entry.timer.unref?.();
  pendingAgentUpdates.set(update.agentId, entry);
}

agentManager.on('agent-update', scheduleAgentUpdate);

function scheduleAcpSessionRevision(session: unknown) {
  if (
    !isAgentScopedServerEvent(session)
    || !Number.isFinite(Number(session.revision))
    || typeof session.updatedAt !== 'string'
  ) return;
  const previous = pendingAcpSessionRevisions.get(session.agentId);
  if (previous) {
    if (Number(session.revision) >= Number(previous.session.revision)) {
      previous.session = session;
    }
    return;
  }
  const entry = {
    session,
    timer: setTimeout(() => {
      pendingAcpSessionRevisions.delete(session.agentId);
      wss.clients.forEach((client) => {
        deliverAcpSessionRevision(client, entry.session);
      });
    }, AGENT_ACTIVITY_BROADCAST_DELAY_MS),
  };
  entry.timer.unref?.();
  pendingAcpSessionRevisions.set(session.agentId, entry);
}

agentManager.on('acp-session-revision', scheduleAcpSessionRevision);

function broadcastAgentRead(read: unknown) {
  if (!isAgentScopedServerEvent(read)) return;
  const message = JSON.stringify({ type: 'agent-read', read });
  wss.clients.forEach((client) => {
    if (
      client.readyState === WebSocket.OPEN
      && agentStateScopeIncludesAgent(
        normalizeAgentStateScope(client.stateScope),
        client.focusedAgentId,
        read.agentId,
      )
    ) {
      const stillRelevant = () => agentStateScopeIncludesAgent(
        normalizeAgentStateScope(client.stateScope),
        client.focusedAgentId,
        read.agentId,
      );
      if (!deferUntilAgentStateSnapshotCompletes(client, message, stillRelevant)) {
        client.send(message);
      }
    }
  });
}

agentManager.on('agent-read', broadcastAgentRead);

function broadcastSessionStream(stream: SessionStream) {
  const message = JSON.stringify({
    type: 'session-output',
    stream
  });
  deliverSessionStreamToClients(Array.from(wss.clients), stream, {
    openState: WebSocket.OPEN,
    maxBufferedAmount: MAX_SESSION_STREAM_CLIENT_BUFFERED_AMOUNT,
    message,
  });
}

const websocketSessionStreamBroadcasts = createWebSocketSessionStreamBroadcasts({
  deliver: broadcastSessionStream,
  intervalMs: SESSION_STREAM_BROADCAST_INTERVAL_MS,
  now: Date.now,
  setTimer: setTimeout,
});

agentManager.onSessionStream((stream) => {
  websocketSessionStreamBroadcasts.schedule(stream);
});

agentManager.onSessionPreview((preview) => {
  if (isAgentScopedServerEvent(preview)) schedulePreviewBroadcast(preview);
});

agentManager.onSystemStats((systemStats) => {
  if (!isRecord(systemStats)) return;
  const usageSnapshot = agentManager.getAgentUsageSnapshots();
  const message = JSON.stringify({ 
    type: 'system-stats', 
    stats: {
      ...systemStats,
      ip: getPrimaryLocalIP(),
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone
    },
    uptime: agentManager.getUptime(),
    usageRate: {
      windowMs: usageSnapshot.windowMs,
      estimatedTokensPerMinute: usageSnapshot.estimatedTokensPerMinute,
      source: usageSnapshot.source,
    }
  });
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
});

let serverStarted = false;
let terminalRuntimeCleanupPromise: Promise<unknown> | null = null;

function runTerminalRuntimeStartupCleanup() {
  if (!terminalRuntimeCleanupPromise) {
    terminalRuntimeCleanupPromise = cleanupTerminalRuntime({ configDir: configManager.farmingDir })
      .catch((error: unknown) => {
        console.warn('Failed to clean terminal runtime leftovers:', caughtError(error).message || error);
        return null;
      });
  }
  return terminalRuntimeCleanupPromise;
}

function startServer() {
  if (serverStarted) return server;
  serverStarted = true;

  void Promise.all([
    runTerminalRuntimeStartupCleanup(),
    browserRuntimeRecoveryPromise,
    computerRuntimeRecoveryPromise,
  ]).finally(() => {
    server.listen(PORT, () => {
      const token = tokenAuth.getToken();
      const localIPs = getLocalIPs();
      const entryPath = BASE_PATH || '/';
      const entrySuffix = authEnabled ? `${entryPath}?token=${token}` : entryPath;

      console.log('');
      console.log('  Farming server running on:');
      console.log('');
      console.log(`  Local:   http://localhost:${PORT}${entrySuffix}`);
      localIPs.forEach((ip: string) => {
        console.log(`  Network: http://${ip}:${PORT}${entrySuffix}`);
      });
      console.log('');
      if (authEnabled) {
        console.log(`  Token: ${token}`);
        const tokenInfo = tokenAuth.getTokenInfo();
        if (tokenInfo) {
          console.log(`  Token style: ${tokenInfo.style} (${tokenInfo.source}, ~${tokenInfo.entropyBits} bits)`);
        }
      } else {
        console.log('  Token auth: disabled');
      }
      console.log('');
      setTimeout(warmCodexExecutableVersionCache, 100);
      void autoResumeMainPageAgentSessions();
    });
  });

  return server;
}

if (require.main === module) {
  startServer();
}

export {
  app,
  server,
  wss,
  agentManager,
  browserResourceManager,
  computerResourceManager,
  workspaceFileService,
  handleMessage,
  resolveCliBinDir,
  resolveInputTargetAgentId,
  rewriteIndexHtmlForBasePath,
  appendIndexHtmlAssetToken,
  startServer,
  runTerminalRuntimeStartupCleanup,
};
