import type { AgentStateRecord, ClientMessage } from '../shared/browser-protocol.js';
import type { AuthAccessMode } from './auth.cjs';
import type { AgentSession } from './agent-session-history.cjs';
import type { AgentSessionInventoryMetadata } from './agent-session-inventory.cjs';
import type { ForkMode, KillAgentResult } from './agent-manager-lifecycle-types.js';
import type { AcpConfigValue } from './agent-manager-provider-types.js';
import type { AgentRecord, ProjectMembershipPatch } from './agent-manager-record-types.js';
import type { WebSocket as NodeWebSocket } from 'ws';
import type { IncomingMessage as NodeIncomingMessage } from 'node:http';

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
  acpRevisionCheckpointPending?: Set<string>;
  acpRevisionInterest?: Set<string>;
  acpRevisionSentCursor?: Map<string, AcpTranscriptCursor>;
  connectionId?: string;
  focusedAgentId?: string | null;
  previewHydrationPending?: boolean;
  previewHydrationTimer?: ReturnType<typeof setTimeout> | null;
  previewScopeId?: string;
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

type AcpTranscriptCursor = {
  agentId: string;
  sessionId: string;
  runtimeEpoch: string;
  revision: number;
  updatedAt: string;
};

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
const { URLSearchParams } = require('url');
import { AgentManager } from './agent-manager.cjs';
import { runtimeKind } from './agent-runtime-binding.cjs';
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
import { createWebSocketAgentLifecycleHandlers } from './websocket-agent-lifecycle-handlers.cjs';
import { createWebSocketAcpHandlers } from './websocket-acp-handlers.cjs';
import { createWebSocketWorkspaceRequestHandlers } from './websocket-workspace-request-handlers.cjs';
import { TokenAuth, authenticatedAccessScopeId } from './auth.cjs';
import { readOnlyClientMessageAllowed } from './read-only-access.cjs';
import { getLocalIPs, getPrimaryLocalIP } from './network.cjs';
import { listAvailableAgents, resolveTerminalCodexExecutable } from './executable-discovery.cjs';
import { getAgentLaunchMetadata } from './cli-agents.cjs';
import { readClaudeSettingsSummary } from './claude-settings.cjs';
import { listCodexModelOptions } from './codex-models.cjs';
import { readProviderHomeConfiguration } from './provider-home-configuration.cjs';
import {
  applyProviderHomeEnvironment,
  getProviderAdapter,
  listProviderDescriptors,
  providerCapabilities,
  type ProviderId,
} from './provider-adapters.cjs';
import { listCodexSessions } from './codex-session-history.cjs';
import { findAgentSession } from './agent-session-history.cjs';
import { mainPageAgentSessionKey } from './main-page-session.cjs';
import { discoverAgentWorkspaces } from './workspace-discovery.cjs';
import { inspectGitWorktree } from './git-worktree-info.cjs';
import { createProjectWorkspaceCanonicalizer } from './project-workspace-canonicalizer.cjs';
import { AgentSessionResumeCoordinator } from './agent-session-resume-coordinator.cjs';
import { createWorkspaceDirectoryRouter } from './workspace-directory.cjs';
import { createWorkspacePickerRouter } from './workspace-picker-router.cjs';
import { createControlRouter } from './control-api.cjs';
import { createAcpTerminalResizeHandler } from './acp-terminal-resize-handler.cjs';
import { WorkspaceFileService, WorkspaceFileError } from './workspace-file-service.cjs';
import {
  createWorkspaceFileRouter,
  executeWorkspaceFileRequest,
  resolveWorkspaceRoot,
} from './workspace-file-router.cjs';
import { PreviewSessionManager } from './preview-session-manager.cjs';
import { WorkspaceRootRegistry, rootIdForPath } from './workspace-root-registry.cjs';
import { BrowserResourceManager, createBrowserRouter } from '../extensions/browser/backend/index.cjs';
import { BrowserExtensionRelay } from '../extensions/browser/backend/browser-extension-relay.cjs';
import {
  ComputerResourceManager,
  IsolatedBrowserProvider,
  createComputerRouter,
} from '../extensions/computer/backend/index.cjs';
import {
  LanguageServerService,
  ManagedLanguageServerManager,
  executeLanguageServerCapability,
  executeLanguageServerRequest,
  type ManagedLanguageServerRefreshEvent,
} from '../extensions/language-server/backend/index.cjs';
import {
  SharedConfigService,
  createSharedConfigRouter,
} from '../extensions/shared-config/backend/index.cjs';
import { UsageMonitor } from './usage-monitor.cjs';
import { createUsageRouter } from './usage-router.cjs';
import { CodexContextWindowReader } from './codex-context-window.cjs';
import { AsyncCache } from './async-cache.cjs';
import { getMainAgentSkillsCatalog } from './main-agent-skills.cjs';
import { AgentExtensionInventory } from './agent-extension-inventory.cjs';
import { createAgentExtensionRouter } from './agent-extension-router.cjs';
import { createProviderCatalogRouter } from './provider-catalog-router.cjs';
import { AgentSessionInventory } from './agent-session-inventory.cjs';
import { createAgentSessionRouter } from './agent-session-router.cjs';
import { createAgentMutationRouter, type AgentMutationRecord } from './agent-mutation-router.cjs';
import { createProjectMutationRouter } from './project-mutation-router.cjs';
import { createSettingsMutationRouter } from './settings-mutation-router.cjs';
import { AttachmentUploadStore, createAttachmentUploadHandler } from './attachment-upload.cjs';
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
  createAgentStateBroadcastTracker,
  normalizeAgentStateScope,
  type AgentStatePayload,
} from './agent-state-broadcast-protocol.cjs';
import {
  deferAgentStateMessageDuringSnapshot,
  type DeferredAgentStateMessage,
} from './agent-state-snapshot-delivery.cjs';
import { createWebSocketAgentStateSnapshotController } from './websocket-agent-state-snapshot-controller.cjs';
import { createWebSocketResourceBroadcastController } from './websocket-resource-broadcasts.cjs';
import { createWebSocketAgentChangeBroadcasts } from './websocket-agent-change-broadcasts.cjs';
import {
  createWebSocketAgentStateBroadcastScheduler,
  type AgentStateBroadcastSchedulerMutation,
} from './websocket-agent-state-broadcast-scheduler.cjs';
import { createWebSocketAgentActivityBroadcasts } from './websocket-agent-activity-broadcasts.cjs';
import { createWebSocketSessionPreviewBroadcasts } from './websocket-session-preview-broadcasts.cjs';
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
import { appendIndexHtmlAssetToken, appendWebAppManifestToken, applyIndexHtmlAppearance, normalizeBasePath, routePath, rewriteIndexHtmlForBasePath } from './index-html.cjs';
import { decodeAcpTranscriptMedia } from './acp-transcript.cjs';
import { deliverSessionStreamToClients } from './session-stream-protocol.cjs';
import {
  createWebSocketSessionStreamBroadcasts,
  type SessionStream,
} from './websocket-session-stream-broadcasts.cjs';
const {
  MAX_INLINE_WORKSPACE_MESSAGE_BYTES,
  MIN_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
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
const BROWSER_EXTENSION_WS_PATH = routePath(BASE_PATH, '/browser/extension');
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
let refreshBrowserExtensionCapability = () => {};
const browserExtensionRelay = new BrowserExtensionRelay({
  configDir: configManager.farmingDir,
  onStateChange: () => refreshBrowserExtensionCapability(),
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
  browserExtensionRelay,
});
refreshBrowserExtensionCapability = () => {
  void browserResourceManager.refreshCapability().catch((error: unknown) => {
    console.warn('Failed to refresh Farming Browser Connector:', caughtError(error).message || error);
  });
};
server.on('close', () => {
  void browserExtensionRelay.close();
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
  isEnabled: () => configManager.getSettings().languageServerEnabled !== false,
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

const sharedConfigService = new SharedConfigService({ configDir: configManager.farmingDir });

const agentManager = new AgentManager(
  configManager,
  {
  controlUrl: `http://127.0.0.1:${PORT}${BASE_PATH}`,
  tokenFile: tokenAuth.getTokenFile(),
  authDisabled: !authEnabled,
  cliBinDir: resolveCliBinDir(),
  transcriptMediaPathPrefix: (agentId, sessionId) => routePath(
    BASE_PATH,
    sessionId
      ? `/api/agents/${encodeURIComponent(agentId)}/acp-subagents/${encodeURIComponent(sessionId)}/acp-media`
      : `/api/agents/${encodeURIComponent(agentId)}/acp-media`,
  ),
  sharedConfigService,
  agentResourceOwnerReplacement: {
    begin: sourceAgentId => {
      browserResourceManager.beginAgentOwnerReplacement(sourceAgentId);
      computerResourceManager.beginAgentOwnerReplacement(sourceAgentId);
    },
    complete: (sourceAgentId, targetAgentId) => {
      const errors: string[] = [];
      try {
        computerResourceManager.completeAgentOwnerReplacement(sourceAgentId, targetAgentId);
      } catch (error) {
        errors.push(`Computer: ${caughtError(error).message}`);
      }
      try {
        browserResourceManager.completeAgentOwnerReplacement(sourceAgentId, targetAgentId);
      } catch (error) {
        errors.push(`Browser: ${caughtError(error).message}`);
      }
      if (errors.length > 0) throw new Error(errors.join('; '));
    },
    cancel: sourceAgentId => {
      browserResourceManager.cancelAgentOwnerReplacement(sourceAgentId);
      computerResourceManager.cancelAgentOwnerReplacement(sourceAgentId);
    },
  },
  },
);

async function requireAgentRecoveryForHttp(res: HttpResponse) {
  try {
    await agentManager.recoveryGate.wait();
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
const workspacePreviewSessionManager = new PreviewSessionManager();
const workspaceRootRegistry = new WorkspaceRootRegistry(
  agentManager,
);
const workspaceFileWatchController = createWorkspaceFileWatchController({
  openState: WebSocket.OPEN,
  resolveRoot: rootId => resolveWorkspaceRoot(agentManager, rootId),
  subscribe: (root, paths, onEvent) => workspaceFileService.subscribeExactFiles(root, paths, event => onEvent({ ...event })),
  logCleanupError: error => {
    console.error('Failed to clear workspace file watch:', error);
  },
  watchErrorMessage: error => (
    error instanceof WorkspaceFileError ? caughtError(error).message : null
  ),
});
const websocketWorkspaceRequestHandlers = createWebSocketWorkspaceRequestHandlers<WebSocketClient>({
  openState: WebSocket.OPEN,
  maxMessageBytes: MAX_INLINE_WORKSPACE_MESSAGE_BYTES,
  executeWorkspace: (request, accessMode, signal, previewScopeId) => executeWorkspaceFileRequest(
    agentManager as Parameters<typeof executeWorkspaceFileRequest>[0],
    workspaceFileService,
    request,
    {
      accessMode: accessMode === 'read-only' ? 'read-only' : 'owner',
      maxInlineResponseBytes: MAX_INLINE_WORKSPACE_MESSAGE_BYTES - 32 * 1024,
      previewSessionManager: workspacePreviewSessionManager,
      previewScopeId,
      rootRegistry: workspaceRootRegistry,
      signal,
    },
  ),
  executeLanguageServer: async request => {
    if (request.operation === 'capability') {
      return {
        result: await executeLanguageServerCapability(languageServerService, request.force === true),
        supported: true,
      };
    }
    return executeLanguageServerRequest(languageServerService, workspaceRootRegistry, request);
  },
  error: error => {
    const caught = caughtError(error);
    const record = error && typeof error === 'object' ? error as Record<string, unknown> : {};
    const explicitStatus = Number(record.statusCode || record.status) || 0;
    const status = explicitStatus || 500;
    const statusCode = status === 400 ? 'INVALID_REQUEST'
      : status === 403 ? 'FORBIDDEN'
        : status === 404 ? 'NOT_FOUND'
          : status === 409 ? 'CONFLICT'
            : status === 413 ? 'TOO_LARGE'
              : status === 504 ? 'TIMEOUT'
                : status === 503 ? 'UNAVAILABLE'
                  : 'INTERNAL';
    return {
      code: typeof record.code === 'string' ? record.code : statusCode,
      message: explicitStatus > 0 ? (caught.message || 'Workspace request failed') : 'Workspace request failed',
      status,
      ...(record.details !== undefined ? { details: record.details } : {}),
      ...(record.uncertain === true ? { uncertain: true } : {}),
    };
  },
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
        await agentManager.recoveryGate.wait();
        const agents = agentManager.getState().agents;
        const states = Array.isArray(agents) ? agents : [];
        const errors: string[] = [];
        try {
          await browserResourceManager.reconcileAgentLifecycle(states);
        } catch (error) {
          errors.push(`Browser: ${caughtError(error).message}`);
        }
        try {
          await computerResourceManager.reconcileAgentLifecycle(states);
        } catch (error) {
          errors.push(`Computer: ${caughtError(error).message}`);
        }
        if (errors.length > 0) throw new Error(errors.join('; '));
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
  .then(() => Promise.all([
    browserExtensionRelay.init(),
    isolatedBrowserProvider.recover(),
    browserResourceManager.init(),
  ]))
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

async function currentAgentSessions(): Promise<AgentSession[]> {
  const snapshot = await agentSessionInventory.snapshot(
    () => configuredProviderMetadata() as AgentSessionInventoryMetadata,
  );
  try {
    await agentManager.recoveryGate.wait();
    agentManager.reconcileAuthoritativeProviderSessions(
      snapshot.sessions,
      snapshot.authoritativeHomes,
    );
  } catch {
    // Provider history remains readable when lifecycle recovery is unavailable,
    // but uncertain Farming metadata must not be removed in that state.
  }
  return snapshot.sessions;
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

const FAKE_PROVIDER_DESCRIPTIONS: Readonly<Record<ProviderId, string>> = {
  codex: 'Codex CLI - OpenAI coding assistant',
  claude: 'Claude CLI - Anthropic assistant',
  opencode: 'OpenCode - AI coding assistant',
  qoder: 'Qoder - AI coding assistant',
  qwen: 'Qwen Code - AI coding assistant',
  pi: 'Pi - AI coding assistant',
};

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
      ...listProviderDescriptors().map(descriptor => ({
        name: descriptor.id,
        command: descriptor.executable,
        description: FAKE_PROVIDER_DESCRIPTIONS[descriptor.id],
        category: 'coding',
        supported: true,
        interactive: true,
      })),
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
  return agents.map(agent => {
    const profile = configManager.getAgentLaunchProfile(agent.name);
    const capabilities = providerCapabilities(agent.name);
    return {
      ...agent,
      ...getAgentLaunchMetadata(agent.name),
      ...(profile.homeId ? {
        launchDefaults: {
          homeId: String(profile.homeId),
          runtimeMode: profile.runtimeMode === 'chat' ? 'chat' : 'terminal',
        },
      } : {}),
      capabilities: {
        supportsChat: capabilities.supportsChat === true,
      },
    };
  });
}

// iOS can fetch installed-web-app metadata outside the authenticated page
// request, without preserving its cookie or token query. Product artwork stays
// public; only an explicit valid owner query personalizes the no-store manifest.
const publicProductAssetsDir = path.join(staticAppDir, 'farming-2');
const publicProductManifestPath = path.join(publicProductAssetsDir, 'site.webmanifest');
app.get(routePath(BASE_PATH, '/farming-2/site.webmanifest'), (req, res) => {
  const requestUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const requestToken = requestUrl.searchParams.get('token');
  if (!authEnabled || !requestToken || !tokenAuth.verify(requestToken)) {
    res.sendFile(publicProductManifestPath);
    return;
  }
  fs.readFile(publicProductManifestPath, 'utf8', (error: unknown, source: string) => {
    if (error) {
      res.status(500).send('Farming web app manifest is unavailable');
      return;
    }
    try {
      res.set('Cache-Control', 'no-store');
      res.set('Content-Type', 'application/manifest+json');
      res.json(appendWebAppManifestToken(JSON.parse(source), requestToken));
    } catch {
      res.status(500).send('Farming web app manifest is invalid');
    }
  });
});
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
  publicOrigin: process.env.FARMING_PUBLIC_ORIGIN,
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
    previewSessionManager: workspacePreviewSessionManager,
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

app.use(
  routePath(BASE_PATH, '/api/extensions/shared-config'),
  createSharedConfigRouter(sharedConfigService, { authDisabled: !authEnabled }),
);

app.use(routePath(BASE_PATH, '/api'), createAgentExtensionRouter({
  agentExtensionInventory,
  configuredProviders: () => Object.keys(configManager.getSettings().agentHomes || {}),
  getAgentLaunchProfile: provider => configManager.getAgentLaunchProfile(provider),
  getAgentHomes: provider => configManager.getAgentHomes(provider),
  getAvailableAgents: getAvailableAgentsForRequest,
  getMainAgentSkillsCatalog,
  getProviderAcpExecutablePolicy: provider => getProviderAdapter(provider)?.acp.executablePolicy || 'system',
  providerSupportsChat: provider => providerCapabilities(provider).supportsChat === true,
  requestedProviderHome,
  rootIdForPath,
  slashCommandDiscoveryCache,
}));

const attachmentUploadStore = new AttachmentUploadStore({
  attachmentsDir: path.join(configManager.farmingDir, 'attachments'),
});
void attachmentUploadStore.cleanupExpired({ force: true });

app.post(
  routePath(BASE_PATH, '/api/attachments/image'),
  express.raw({ type: 'image/*', limit: '12mb' }),
  createAttachmentUploadHandler({ kind: 'image', store: attachmentUploadStore })
);

app.post(
  routePath(BASE_PATH, '/api/attachments/audio'),
  express.raw({ type: 'audio/*', limit: '25mb' }),
  createAttachmentUploadHandler({ kind: 'audio', store: attachmentUploadStore })
);

app.use(routePath(BASE_PATH, '/api'), createProviderCatalogRouter({
  loadCodexModels: homePath => codexModelOptionsCache.get(homePath),
  readClaudeSettings: homePath => readClaudeSettingsSummary({
    settingsFile: path.join(homePath, 'settings.json'),
  }),
  resolveProviderHome: requestedProviderHome,
}));

app.use(routePath(BASE_PATH, '/api/usage'), createUsageRouter({
  getUsageDay: (date, options) => usageMonitor.getUsageDay(date, options),
  getUsageSummary: options => usageSummaryCache.get('summary', options),
  invalidateDailyCache: () => usageMonitor.invalidateDailyCache(),
}));

const readProviderContextWindows: HttpHandler = async (req, res) => {
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
    res.status(500).json({ error: error.message || 'Failed to read provider context windows' });
  }
};

app.post(routePath(BASE_PATH, '/api/provider-context-windows'), express.json(), readProviderContextWindows);
// Compatibility for clients from before provider context-window capability routing.
app.post(routePath(BASE_PATH, '/api/codex/context-windows'), express.json(), readProviderContextWindows);

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

app.use(routePath(BASE_PATH, '/api'), createAgentSessionRouter({
  archiveSession: (provider, sessionId, providerHomeId) => (
    agentManager.archiveProviderSessionByIdentity(provider, sessionId, {
      providerHomeId,
      providerHomes: configuredProviderHomes(),
      commitMainPageMembership: () => {
        configManager.removeMainPageSessionKeys([
          mainPageAgentSessionKey(provider, sessionId, providerHomeId),
        ]);
      },
    })
  ),
  unarchiveSession: async (provider, sessionId, providerHomeId, commitMainPageMembership) => {
    const result = await agentManager.unarchiveProviderSessionByIdentity(provider, sessionId, {
      providerHomeId,
      providerHomes: configuredProviderHomes(),
      commitMainPageMembership,
    });
    return result?.error ? { error: result.error, status: result.status } : {};
  },
  getMainPageSessionKeys: () => configManager.getMainPageSessionKeys(),
  getSettings: () => configManager.getSettings(),
  invalidate: () => agentSessionInventory.invalidate(),
  listDisplayRecords: () => configManager.listAgentSessionRecords(),
  listSessions: () => currentAgentSessions(),
  publishStateMetadata: state => stateBroadcastScheduler.queueMetadata(state),
  rememberMainPageSessionKey: (sessionKey, patch) => {
    configManager.rememberMainPageSessionKey(sessionKey, patch);
  },
  removeMainPageSessionKeys: sessionKeys => {
    configManager.removeMainPageSessionKeys([...sessionKeys]);
  },
  setProviderSessionDisplayState: (sessionKey, patch) => {
    configManager.setProviderSessionDisplayState(sessionKey, patch);
  },
}));

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
        includeEntries: req.query.includeEntries === '1',
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
    if (
      message === 'ACP Agent is still connecting'
      || message === 'ACP Transcript identity is unavailable'
      || message === 'ACP Transcript identity changed during read'
    ) {
      res.status(202).json({ pending: true });
      return;
    }
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

app.get(routePath(BASE_PATH, '/api/agents/:agentId/acp-subagents/:sessionId/acp-media/:entryId/:mediaId'), async (req, res) => {
  try {
    const media = await agentManager.getAcpTranscriptMedia(
      req.params.agentId,
      req.params.entryId,
      req.params.mediaId,
      req.params.sessionId,
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

app.use(routePath(BASE_PATH, '/api/agents'), createAgentMutationRouter({
  archiveAgent: (agentId, options) => agentManager.archiveAgent(agentId, options) as Promise<AgentMutationRecord>,
  publishAgentDelta: agentId => {
    stateBroadcastScheduler.queueChange({ agentIds: [agentId] });
  },
  renameAgent: (agentId, customTitle) => agentManager.renameAgent(agentId, customTitle) as AgentMutationRecord,
  restartAgentRuntimeMode: (agentId, mode) => agentManager.restartAgentRuntimeMode(
    agentId,
    mode,
  ) as Promise<AgentMutationRecord>,
  setAgentTask: (agentId, task) => agentManager.setAgentTask(agentId, task) as AgentMutationRecord,
  syncLaunchPermissionMode: (agentId, mode) => agentManager.syncCodexTerminalPermissionMode(
    agentId,
    mode,
  ) as Promise<AgentMutationRecord>,
  updateAgentFlags: (agentId, patch) => agentManager.updateAgentFlags(agentId, patch) as AgentMutationRecord,
  whenAgentLifecycleIdle: agentId => agentManager.whenAgentLifecycleIdle(agentId),
  whenRecovered: () => agentManager.recoveryGate.wait(),
}));

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
    stateBroadcastScheduler.queueMetadata(currentAgentListMetadata());
    broadcastState();
    const mountError = error.message || 'Failed to create Project';
    res.status(500).json({
      ...result,
      error: `${mountError}. Retry the same Fork request to reconcile Project membership.`,
      retryable: true,
    });
    return;
  }
  stateBroadcastScheduler.queueMetadata(currentAgentListMetadata());
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

app.use(routePath(BASE_PATH, '/api/projects'), createProjectMutationRouter({
  canonicalWorkspace: workspace => canonicalProjectWorkspace(workspace),
  gitWorkspaceForFile: filePath => gitProjectWorkspaceForFile(filePath),
  mountWorkspace: workspace => configManager.mountProjectWorkspace(workspace),
  removeWorkspace: workspace => configManager.removeProjectWorkspace(workspace),
  setWorkspacePinned: (workspace, pinned) => configManager.setProjectWorkspacePinned(workspace, pinned),
  reorderWorkspace: (workspace, position) => configManager.reorderProjectWorkspace(workspace, position),
  setWorkspaceName: (workspace, name) => configManager.setProjectName(workspace, name),
  publishMembershipChange: () => {
    stateBroadcastScheduler.queueMetadata(currentAgentListMetadata());
    broadcastState();
  },
  publishNameChange: () => {
    stateBroadcastScheduler.queueMetadata(currentAgentListMetadata());
  },
}));

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
    stateBroadcastScheduler.queueMetadata(currentAgentListMetadata());
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
    stateBroadcastScheduler.queueMetadata(currentAgentListMetadata());
    broadcastState();
    const status = result.requiresForce
      ? 409
      : (result.error === 'Workspace not found' || result.error === 'Workspace is required' ? 404 : 400);
    res.status(status).json(result);
    return;
  }
  stateBroadcastScheduler.queueMetadata(currentAgentListMetadata());
  broadcastState();
  res.json(result);
});

const canonicalProjectWorkspaceCandidate = createProjectWorkspaceCanonicalizer({
  inspectWorkspace: async candidate => (await inspectGitWorktree(candidate))?.workspace || '',
  realpath: candidate => fs.promises.realpath(path.resolve(candidate)),
  warnInspectFailure: (candidate, caught) => {
    const error = caughtError(caught);
    console.warn('Failed to resolve project worktree:', candidate, error?.message || error);
  },
});
async function canonicalProjectWorkspace(workspace: string | null) {
  const candidate = configManager.expandWorkspacePath(String(workspace || '').trim());
  return canonicalProjectWorkspaceCandidate(candidate);
}
async function gitProjectWorkspaceForFile(filePath: string | null) {
  const candidate = configManager.expandWorkspacePath(String(filePath || '').trim());
  if (!candidate) return '';
  try {
    const canonicalFile = await fs.promises.realpath(path.resolve(candidate));
    const stat = await fs.promises.stat(canonicalFile);
    if (!stat.isFile()) return '';
    return (await inspectGitWorktree(path.dirname(canonicalFile), { cacheMs: 0 }))?.workspace || '';
  } catch {
    return '';
  }
}
const agentSessionResumeCoordinator = new AgentSessionResumeCoordinator({
  archiveNewAgent: agentId => agentManager.archiveAgent(agentId, {
    reason: 'project-mount-failed',
    recordHistory: false,
    requireEngineExit: true,
    scheduleProviderArchive: false,
  }),
  canonicalProjectWorkspace,
  configuredProviderHomes,
  currentAgentSessions,
  ensureProviderSessionAvailable: (provider, sessionId, options) => (
    agentManager.ensureProviderSessionAvailable(provider, sessionId, options)
  ),
  findAgentSession: (provider, sessionId, options) => findAgentSession(provider, sessionId, options),
  getActiveAgents: () => agentManager.getState().agents,
  getMainPageSessionKeys: () => configManager.getMainPageSessionKeys(),
  getSavedAgentSession: (provider, sessionId, providerHomeId) => {
    if (typeof configManager.getAgentSessionRecordForProviderSessionKey !== 'function') return null;
    return configManager.getAgentSessionRecordForProviderSessionKey(
      mainPageAgentSessionKey(provider, sessionId, providerHomeId),
    );
  },
  getSettings: () => configManager.getSettings(),
  mountProjectWorkspace: workspace => configManager.mountProjectWorkspace(workspace),
  publishAgentState: () => {
    stateBroadcastScheduler.queueMetadata(currentAgentListMetadata());
    broadcastState();
  },
  rememberMainPageSession: (provider, sessionId, providerHomeId) => {
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
      mainPageSessionKeys: [sessionKey, ...currentKeys.filter((key: string) => key !== sessionKey)],
    });
  },
  removeMainPageSession: (provider, sessionId, providerHomeId) => {
    const sessionKey = mainPageAgentSessionKey(provider, sessionId, providerHomeId);
    if (typeof configManager.removeMainPageSessionKey === 'function') {
      configManager.removeMainPageSessionKey(sessionKey);
      return;
    }
    const currentKeys = typeof configManager.getMainPageSessionKeys === 'function'
      ? configManager.getMainPageSessionKeys()
      : (Array.isArray(configManager.getSettings().mainPageSessionKeys) ? configManager.getSettings().mainPageSessionKeys : []);
    if (!currentKeys.includes(sessionKey)) return;
    configManager.updateSettings({ mainPageSessionKeys: currentKeys.filter((key: string) => key !== sessionKey) });
  },
  runProviderSessionResumeAdmission: (provider, sessionId, providerHomeId, operation) => (
    agentManager.runProviderSessionResumeAdmission(
      provider,
      sessionId,
      providerHomeId,
      operation,
    )
  ),
  startAgent: (command, workspace, callback, options) => agentManager.startAgent(command, workspace, callback, options),
  waitForAgentRecovery: () => agentManager.recoveryGate.wait(),
  warn: (...args) => console.warn(...args),
});

app.post(routePath(BASE_PATH, '/api/codex/sessions/:sessionId/resume'), express.json(), async (req, res) => {
  const reply = await agentSessionResumeCoordinator.resumeHttp('codex', req.params.sessionId, req.body);
  res.status(reply.status).json(reply.body);
});

app.post(routePath(BASE_PATH, '/api/agent-sessions/:provider/:sessionId/resume'), express.json(), async (req, res) => {
  const reply = await agentSessionResumeCoordinator.resumeHttp(req.params.provider, req.params.sessionId, req.body);
  res.status(reply.status).json(reply.body);
});

app.use(routePath(BASE_PATH, '/api/settings'), createSettingsMutationRouter({
  getSettings: () => configManager.getSettings(),
  invalidateAgentExtensionInventory: () => agentExtensionInventory.invalidate(),
  invalidateAgentSessionInventory: () => agentSessionInventory.invalidate(),
  normalizeAgentHomes: value => configManager.normalizeAgentHomes(value),
  probeBrowser: settings => browserResourceManager.probeCapability(
    browserResourceManager.browserSelection(settings),
  ),
  probeComputer: settings => computerResourceManager.probeSettings(settings),
  publishSettingsMetadata: () => {
    stateBroadcastScheduler.queueMetadata(currentAgentListMetadata({ includeWorkspaceRoots: true }));
  },
  refreshBrowserCapability: () => browserResourceManager.refreshCapability(),
  refreshComputerCapability: async () => {
    computerResourceManager.capabilityCache = null;
    await computerResourceManager.capability(true);
  },
  resetAllComputerContainers: () => computerResourceManager.resetAllContainers(),
  stopAllBrowsers: () => browserResourceManager.stopAll(),
  stopAllComputers: () => computerResourceManager.stopAll(),
  stopAllLanguageServers: () => languageServerService.dispose(),
  updateSettings: patch => configManager.updateSettings(patch),
}));

app.use(routePath(BASE_PATH, '/api/themes'), createThemeRouter({
  getTheme: themeId => themeManager.getTheme(themeId),
  getThemeCSS: themeId => themeManager.getThemeCSS(themeId),
  getThemeSettings: themeId => themeManager.getThemeSettings(themeId),
  updateThemeSettings: (themeId, settings) => themeManager.updateThemeSettings(themeId, settings),
}, themeId => configManager.updateSettings({ theme: themeId })));

wss.on('connection', (ws, req) => {
  initializeWebSocketLiveness(ws);
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  if (url.pathname === BROWSER_EXTENSION_WS_PATH) {
    browserExtensionRelay.attachWebSocket(
      ws as unknown as NodeWebSocket,
      req as unknown as NodeIncomingMessage,
      BROWSER_EXTENSION_WS_PATH,
    );
    return;
  }
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
  ws.previewScopeId = authenticatedAccessScopeId(tokenAuth.extractToken(req), accessMode);
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
    websocketWorkspaceRequestHandlers.close(ws);
    cancelSessionPreviewHydration(ws);
    agentStateSnapshotController.dispose(ws);
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
    maxInlineWorkspaceMessageBytes: MAX_INLINE_WORKSPACE_MESSAGE_BYTES,
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

function watchAcpTranscripts(client: WebSocketClient, data: { agentIds: string[] }) {
  const previous = client.acpRevisionInterest ?? new Set<string>();
  const next = new Set(data.agentIds);
  client.acpRevisionInterest = next;
  for (const agentId of previous) {
    if (next.has(agentId) || client.focusedAgentId === agentId) continue;
    client.acpRevisionCheckpointPending?.delete(agentId);
    client.acpRevisionSentCursor?.delete(agentId);
  }
  for (const agentId of next) {
    if (previous.has(agentId)) continue;
    client.acpRevisionSentCursor?.delete(agentId);
    agentManager.prioritizeAcpPreparedTranscript(agentId);
    const revision = currentAcpSessionRevision(agentId);
    if (revision) deliverAcpSessionRevision(client, revision);
  }
}
const websocketAgentLifecycleHandlers = createWebSocketAgentLifecycleHandlers<WebSocketClient>({
  openState: WebSocket.OPEN,
  canonicalProjectWorkspace,
  startAgent: (command, workspace, callback, options) => (
    agentManager.startAgent(command, workspace, callback, options)
  ),
  mountProjectWorkspace: workspace => configManager.mountProjectWorkspace(workspace),
  archiveAgent: (agentId, options = {}) => agentManager.archiveAgent(agentId, options),
  interruptAgent: agentId => agentManager.interruptAgent(agentId),
  getAgentState: () => agentManager.getState(),
  killAgent: agentId => agentManager.killAgent(agentId),
  publishAgentState: () => {
    stateBroadcastScheduler.queueMetadata(currentAgentListMetadata());
    broadcastState();
  },
  revealAgentState: () => broadcastState(),
  warnStartCompletionFailure: (agentId, error) => {
    const normalized = caughtError(error);
    console.warn('Failed to finish started Agent transition:', agentId, normalized.message || error);
  },
});
const websocketAcpHandlers = createWebSocketAcpHandlers<WebSocketClient>({
  openState: WebSocket.OPEN,
  attachmentsRoot: path.resolve(attachmentUploadStore.attachmentsDir),
  readAttachment: filePath => fs.promises.readFile(filePath),
  agentRuntimeKind: agentId => agentManager.agentRuntimeKind(agentId),
  sendComposerMessage: (agentId, content, options) => (
    agentManager.sendComposerMessage(agentId, content, options)
  ),
  respondToAcpPermission: (agentId, requestId, optionId, cancelled) => (
    agentManager.respondToAcpPermission(agentId, requestId, optionId, cancelled)
  ),
});
const clientMessageDispatchTable = defineClientMessageDispatchTable<WebSocketClient>({
  'protocol-hello': registerClientMessage('protocol-hello', websocketHandshakeHealthHandlers.protocolHello),
  'business-health-probe': registerClientMessage('business-health-probe', websocketHandshakeHealthHandlers.businessHealthProbe),
  'terminal-checkpoint-request': registerClientMessage('terminal-checkpoint-request', websocketTerminalHandlers.terminalCheckpointRequest),
  'state-resync': registerClientMessage('state-resync', websocketFocusScopeHandlers.stateResync),
  'start-agent': registerClientMessage('start-agent', websocketAgentLifecycleHandlers.startAgent),
  input: registerClientMessage('input', websocketTerminalHandlers.input),
  'composer-input': registerClientMessage('composer-input', websocketAcpHandlers.composerInput),
  'acp-permission-response': registerClientMessage('acp-permission-response', websocketAcpHandlers.acpPermissionResponse),
  'interrupt-agent': registerClientMessage('interrupt-agent', websocketAgentLifecycleHandlers.interruptAgent),
  'focus-agent': registerClientMessage('focus-agent', websocketFocusScopeHandlers.focusAgent),
  'watch-acp-transcripts': registerClientMessage('watch-acp-transcripts', watchAcpTranscripts),
  'resize-agent': registerClientMessage('resize-agent', websocketTerminalHandlers.resizeAgent),
  'clear-terminal': registerClientMessage('clear-terminal', websocketTerminalHandlers.clearTerminal),
  'watch-workspace-files': registerClientMessage('watch-workspace-files', (ws, data) => {
    void workspaceFileWatchController.watch(ws, data.rootId, data.paths);
  }),
  'unwatch-workspace-files': registerClientMessage('unwatch-workspace-files', (ws, data) => {
    workspaceFileWatchController.unwatch(ws, data.rootId);
  }),
  'workspace-request': registerClientMessage('workspace-request', websocketWorkspaceRequestHandlers.workspaceRequest),
  'workspace-cancel': registerClientMessage('workspace-cancel', websocketWorkspaceRequestHandlers.cancel),
  'language-server-request': registerClientMessage('language-server-request', websocketWorkspaceRequestHandlers.languageServerRequest),
  'archive-agent': registerClientMessage('archive-agent', websocketAgentLifecycleHandlers.archiveAgent),
  'restart-main-agent': registerClientMessage('restart-main-agent', websocketAgentLifecycleHandlers.restartMainAgent),
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
  agentStateSnapshotController.sendState(ws);
}

function queueInitialStateSnapshot(ws: WebSocketClient) {
  agentStateSnapshotController.queueInitialSnapshot(ws);
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
  return agentManager.getAcpTranscriptCursor(agentId);
}

function deliverAcpSessionRevision(client: WebSocketClient, session: AcpTranscriptCursor) {
  if (client.readyState !== WebSocket.OPEN || client.protocolVersion !== PROTOCOL_VERSION) return;
  const sessionIsRelevant = () => Boolean(
    client.focusedAgentId === session.agentId
    || client.acpRevisionInterest?.has(session.agentId)
  );
  const sentCursor = client.acpRevisionSentCursor?.get(session.agentId);
  const delivery = acpRevisionClientDelivery(
    sessionIsRelevant(),
    sentCursor,
    client.stateSnapshotInProgress ? 0 : client.bufferedAmount,
    MAX_ACP_REVISION_CLIENT_BUFFERED_AMOUNT,
    session,
  );
  if (delivery === 'skip') return;
  if (delivery === 'defer') {
    (client.acpRevisionCheckpointPending ??= new Set()).add(session.agentId);
    return;
  }
  const message = JSON.stringify({ type: 'acp-session-revision', session });
  const markSent = () => {
    (client.acpRevisionSentCursor ??= new Map()).set(session.agentId, session);
    client.acpRevisionCheckpointPending?.delete(session.agentId);
  };
  const markDiscarded = () => {
    if (sessionIsRelevant()) (client.acpRevisionCheckpointPending ??= new Set()).add(session.agentId);
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
  const pending = client.acpRevisionCheckpointPending;
  if (!pending || pending.size === 0) return;
  for (const agentId of [...pending]) {
    if (client.focusedAgentId !== agentId && !client.acpRevisionInterest?.has(agentId)) {
      pending.delete(agentId);
      continue;
    }
    const revision = currentAcpSessionRevision(agentId);
    if (!revision) {
      pending.delete(agentId);
      continue;
    }
    deliverAcpSessionRevision(client, revision);
  }
}

const stateBroadcastTracker = createAgentStateBroadcastTracker();
const agentStateSnapshotController = createWebSocketAgentStateSnapshotController<WebSocketClient>({
  backpressureRetryMs: AGENT_STATE_SNAPSHOT_BACKPRESSURE_RETRY_MS,
  broadcastCheckpoint: client => broadcastState(client, true),
  cancelPreviewHydration: client => cancelSessionPreviewHydration(client),
  clearTimer: timer => clearTimeout(timer as ReturnType<typeof setTimeout>),
  initialFollowupDelayMs: INITIAL_AGENT_STATE_SNAPSHOT_FOLLOWUP_DELAY_MS,
  initialPageSize: INITIAL_AGENT_STATE_SNAPSHOT_PAGE_SIZE,
  maxBufferedAmount: MAX_STATE_CLIENT_BUFFERED_AMOUNT,
  onDeliveryFailure: (client, error) => {
    console.error('Agent state snapshot delivery failed', JSON.stringify({
      connectionId: client.connectionId,
      error: error instanceof Error ? error.message : String(error),
    }));
    try {
      if (client.readyState === WebSocket.OPEN) {
        client.close(1011, 'Agent state snapshot delivery failed');
      }
    } catch {
      // The transport is already unusable; the close handler owns cleanup.
    }
  },
  openState: WebSocket.OPEN,
  pageSize: AGENT_STATE_SNAPSHOT_PAGE_SIZE,
  previewHydrationWindowMs: PREVIEW_SCOPE_DECLARATION_WINDOW_MS,
  projectSummaries: () => agentStateBroadcastProjectSummaries(stateBroadcastTracker),
  queuePreviewHydration: (client, delayMs, callback) => (
    queueSessionPreviewHydration(client, delayMs, callback)
  ),
  recoverAcpSessionRevision: client => recoverAcpSessionRevisionIfReady(client),
  recoverAgentActivity: client => recoverAgentActivityIfReady(client),
  scopeDeclarationWindowMs: INITIAL_STATE_SCOPE_DECLARATION_WINDOW_MS,
  sendPreviewHydration: client => sendPreviewHydration(client),
  serverEpoch: SERVER_EPOCH,
  snapshotForScope: (stateScope, focusedAgentId) => agentStateBroadcastSnapshotForScope(
    stateBroadcastTracker,
    stateScope,
    focusedAgentId,
  ),
  snapshotSequence: () => stateBroadcastTracker.sequence,
  setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
});
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

type ResourceBroadcastDomain = 'browser' | 'computer';

function scheduleResourceUpdate(domain: ResourceBroadcastDomain, resource: unknown) {
  websocketResourceBroadcasts.scheduleUpdate(domain, resource);
}

function scheduleResourceDeletion(domain: ResourceBroadcastDomain, deletion: unknown) {
  websocketResourceBroadcasts.scheduleDeletion(domain, deletion);
}

const resourceBroadcastManagers = [
  { domain: 'browser', manager: browserResourceManager },
  { domain: 'computer', manager: computerResourceManager },
] as const;

for (const { domain, manager } of resourceBroadcastManagers) {
  manager.on('resource', (resource: unknown) => scheduleResourceUpdate(domain, resource));
  manager.on('deleted', (deletion: unknown) => scheduleResourceDeletion(domain, deletion));
}

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

const websocketAgentChangeBroadcasts = createWebSocketAgentChangeBroadcasts<WebSocketClient>({
  clients: () => wss.clients,
  deferUntilSnapshot: (client, message, isRelevant) => (
    deferUntilAgentStateSnapshotCompletes(client, message, isRelevant)
  ),
  openState: WebSocket.OPEN,
  scopeIncludesAgent: (client, agentId) => agentStateScopeIncludesAgent(
    normalizeAgentStateScope(client.stateScope),
    client.focusedAgentId,
    agentId,
  ),
  setTimer: setTimeout,
  updateDelayMs: AGENT_ACTIVITY_BROADCAST_DELAY_MS,
});

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
  agentStateSnapshotController.recoverSnapshotIfReady(client);
}

interface StateBroadcastContext {
  authoritativeCheckpoint: boolean;
  excludedClient: WebSocketClient | null;
}

function deliverStateBroadcast(
  mutation: AgentStateBroadcastSchedulerMutation<AgentStateRecord>,
  context: StateBroadcastContext | null,
) {
  const delta = context?.authoritativeCheckpoint === true
    ? advanceAgentStateBroadcast(
        stateBroadcastTracker,
        buildStatePayload() as AgentStatePayload,
      )
    : advanceAgentStateMutation(stateBroadcastTracker, mutation);
  if (!delta) return;
  const excludedClient = context?.excludedClient ?? null;
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

const stateBroadcastScheduler = createWebSocketAgentStateBroadcastScheduler<
  AgentStateRecord,
  StateBroadcastContext,
  ReturnType<typeof setTimeout>
>({
  clearTimer: clearTimeout,
  deliver: deliverStateBroadcast,
  intervalMs: STATE_BROADCAST_INTERVAL_MS,
  now: Date.now,
  projectAgent: (agentId, now) => {
    const agent = agentManager.getAgentState(agentId, now) as (ServerRecord & { id: string }) | null;
    if (!agent || !agentStateVisibleToInteractiveClients(agent)) return null;
    return projectAgentState(agent);
  },
  setTimer: setTimeout,
  stateMetadata: () => agentManager.getStateMetadata(),
});

function broadcastState(
  excludedClient: WebSocketClient | null = null,
  authoritativeCheckpoint = false,
) {
  stateBroadcastScheduler.flush({ authoritativeCheckpoint, excludedClient });
}

function broadcastSessionPreview(preview: ServerRecord) {
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) sendPreviewIfInScope(client, preview);
  });
}

const websocketSessionPreviewBroadcasts = createWebSocketSessionPreviewBroadcasts({
  clearTimer: clearTimeout,
  deliver: broadcastSessionPreview,
  intervalMs: PREVIEW_BROADCAST_INTERVAL_MS,
  now: Date.now,
  setTimer: setTimeout,
});

agentManager.onUpdate(stateBroadcastScheduler.queueChange);

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

const websocketAgentActivityBroadcasts = createWebSocketAgentActivityBroadcasts({
  delayMs: AGENT_ACTIVITY_BROADCAST_DELAY_MS,
  deliver: broadcastAgentActivity,
  setTimer: setTimeout,
});

agentManager.onAgentActivity(websocketAgentActivityBroadcasts.schedule);

agentManager.on('agent-update', websocketAgentChangeBroadcasts.scheduleAgentUpdate);

function scheduleAcpSessionRevision(session: unknown) {
  if (!isAgentScopedServerEvent(session)) return;
  if (pendingAcpSessionRevisions.has(session.agentId)) return;
  const agentId = session.agentId;
  const entry = {
    timer: setTimeout(() => {
      pendingAcpSessionRevisions.delete(agentId);
      const cursor = currentAcpSessionRevision(agentId);
      if (!cursor) return;
      wss.clients.forEach((client) => {
        deliverAcpSessionRevision(client, cursor);
      });
    }, AGENT_ACTIVITY_BROADCAST_DELAY_MS),
  };
  entry.timer.unref?.();
  pendingAcpSessionRevisions.set(agentId, entry);
}

agentManager.on('acp-session-revision', scheduleAcpSessionRevision);

agentManager.on('agent-read', websocketAgentChangeBroadcasts.broadcastAgentRead);

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
  if (isAgentScopedServerEvent(preview)) websocketSessionPreviewBroadcasts.schedule(preview);
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
