import { EventEmitter } from 'events';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');
const { Readable, Writable } = require('stream');
const { createRequire } = require('module');
const { promisify } = require('util');
const packageJson = require('../package.json');
import { AcpCheckpointStore } from './acp-checkpoint-store.cjs';
import {
  AcpSessionState,
  type AcpEntry as TranscriptEntry,
  type AcpSessionSnapshot,
  type SnapshotOptions,
  type TranscriptSliceOptions,
} from './acp-session-state.cjs';
import { AcpClientFileSystem, AcpClientTerminalManager } from './acp/client-services.cjs';
import { PACKAGED_CODEX_ACP_ARG } from './acp/packaged-codex-acp.cjs';
import { PACKAGED_CLAUDE_ACP_ARG } from './acp/packaged-claude-acp.cjs';
import { permissionSecurityWarnings } from './acp/permission-security.cjs';
import { patchBlock, rejectPatch } from './acp/patch-decisions.cjs';
import { getProviderAdapter, listProviderAdapters } from './provider-adapters.cjs';
import { isSafeProviderSessionId } from './provider-session-id.cjs';
import type { ProviderSessionIdentityResult } from './agent-manager-provider-types.js';

type UnknownRecord = Record<string, unknown>;
type PromptBlock = UnknownRecord & { type?: string; text?: string; path?: string };
type ConfigValue = string | number | boolean | null | string[];

interface ErrorLike {
  message?: string;
  code?: string | number;
  data?: { code?: string | number; details?: string };
  cause?: ErrorLike;
}
type AcpSdk = typeof import('@agentclientprotocol/sdk');
interface AcpClientHandlers { [key: string]: (request: UnknownRecord) => unknown }

interface PermissionOption { optionId: string; kind?: string }
interface PermissionRequest extends UnknownRecord { options: PermissionOption[]; sessionId?: string; toolCall?: UnknownRecord }
interface ElicitationRequest extends UnknownRecord { mode?: string; requestedSchema?: UnknownRecord; sessionId?: string }
interface SessionConfigOption extends UnknownRecord {
  id: string;
  type?: string;
  name?: string;
  category?: string;
  currentValue?: ConfigValue;
  options?: Array<{ value?: ConfigValue }>;
}
interface SessionConfigChange { configId: string; value: ConfigValue }
interface AcpCheckpoint extends UnknownRecord {
  version?: number; sessionState?: UnknownRecord; subagentStates?: unknown;
  patchDecisions?: unknown;
  providerProof?: UnknownRecord & { token?: string; cwd?: string };
  complete?: boolean;
}
interface AcpConnection {
  signal?: AbortSignal;
  closed: Promise<void>;
  close(): void;
  request(method: string, params: UnknownRecord): Promise<unknown>;
  initialize(params: UnknownRecord): Promise<InitializeResponse>;
  newSession(params: UnknownRecord): Promise<SessionResponse>;
  loadSession(params: UnknownRecord): Promise<SessionResponse>;
  resumeSession(params: UnknownRecord): Promise<SessionResponse>;
  unstable_forkSession(params: UnknownRecord): Promise<SessionResponse>;
  closeSession(params: UnknownRecord): Promise<unknown>;
  deleteSession(params: UnknownRecord): Promise<unknown>;
  listSessions(params: UnknownRecord): Promise<{
    sessions?: Array<UnknownRecord & { sessionId?: string; cwd?: string; checkpointRevision?: string; _meta?: UnknownRecord }>;
    nextCursor?: string;
  }>;
  prompt(params: UnknownRecord): Promise<UnknownRecord>;
  cancel(params: UnknownRecord): Promise<unknown>;
  authenticate(params: UnknownRecord): Promise<unknown>;
  logout(params: UnknownRecord): Promise<unknown>;
  setSessionMode(params: UnknownRecord): Promise<SessionResponse>;
  setSessionConfigOption(params: UnknownRecord): Promise<SessionResponse>;
}
interface InitializeResponse {
  protocolVersion: number;
  agentInfo?: unknown;
  authMethods?: Array<UnknownRecord & { id?: string; type?: string }>;
  agentCapabilities?: UnknownRecord & {
    loadSession?: boolean;
    sessionCapabilities?: UnknownRecord & { fork?: boolean; close?: boolean; resume?: boolean };
    promptCapabilities?: UnknownRecord;
    _meta?: UnknownRecord & { codex?: UnknownRecord & { steer?: UnknownRecord & { method?: string; version?: number } } };
  };
}
interface SessionResponse extends UnknownRecord {
  sessionId?: string;
  modes?: UnknownRecord & { currentModeId?: string };
  configOptions?: SessionConfigOption[];
}
interface AcpTurn {
  id: number;
  phase: string;
  completion: Promise<unknown>;
  resolveCompletion?: (result: unknown) => void;
  controlTail: Promise<unknown>;
  terminalResult?: unknown;
  [key: string]: unknown;
}
interface SessionMutation { action: string; generation?: number; [key: string]: unknown }
interface SubagentControl {
  sessionId: string; generation: number; phase: string; state?: string; error?: string;
  cancelPromise?: Promise<unknown> | null; [key: string]: unknown;
}
interface AcpBinding {
  agentId: string; provider: string; providerHomeId: string; cwd: string;
  sessionRequestOptions: AcpSessionRequestOptions; env: NodeJS.ProcessEnv; launch: AcpLaunch;
  restartOptions: PrepareAgentOptions; approvalMode: string; ownsProcessGroup: boolean;
  farmingBrowserApprovedSites: Set<string>;
  farmingBrowserApprovalScopes: Map<string, string>;
  child: import('child_process').ChildProcessWithoutNullStreams | null;
  connection: AcpConnection; initializeResponse: InitializeResponse;
  sessionId: string; untrustedSessionId: string; state: string; error: string; stopReason: string;
  modes: SessionResponse['modes'] | null; configOptions: SessionConfigOption[];
  pendingPermissions: Map<string, PermissionRequest>; permissionResolvers: Map<string, (value: unknown) => void>;
  pendingElicitations: Map<string, ElicitationRequest>; elicitationResolvers: Map<string, (value: unknown) => void>;
  activeElicitations: Map<string, ElicitationRequest>; subagentStates: Map<string, AcpSessionState>;
  subagentControls: Map<string, SubagentControl>; nextSubagentGeneration: number;
  interactionOrigins: Map<string, string>; activeTurn: AcpTurn | null; nextTurnId: number;
  supportsSteer: boolean; historyReplayActive: boolean; sessionState: AcpSessionState;
  authTerminal: UnknownRecord; patchDecisions: Map<string, string>;
  patchDecisionInFlight: Map<string, { decision: string; promise: Promise<unknown> }>;
  checkpointProof: unknown; sessionMutation: SessionMutation | null; configMutationTail: Promise<unknown> | null;
  stderr: string; exited: boolean; updatedAt: string;
}
interface AcpLaunch { command: string; args: string[]; version?: string }
interface AcpSessionRequestOptions extends UnknownRecord {
  cwd: string; additionalDirectories: string[]; mcpServers: UnknownRecord[];
}
interface AcpRuntimeOptions extends PrepareAgentOptions {
  spawn?: typeof spawn; createConnection?: (handlers: UnknownRecord, child: AcpBinding['child'], binding: AcpBinding) => Promise<AcpConnection>;
  resolveLaunch?: typeof resolveAcpLaunch; maxUpdates?: number; initializeTimeoutMs?: number;
  sessionSetupTimeoutMs?: number; requestTimeoutMs?: number; cancelTimeoutMs?: number;
  historyReplayMinWaitMs?: number; historyReplayQuietMs?: number; historyReplayMaxWaitMs?: number;
  deleteProviderSessionIdentity?: typeof deleteProviderSessionIdentity; describeAcpProcessGroup?: typeof describeAcpProcessGroup;
  checkpointStore?: Pick<
    AcpCheckpointStore,
    'dispose' | 'flush' | 'load' | 'markDirty' | 'schedule' | 'write'
  >;
  configDir?: string;
  checkpointOptions?: { writeDelayMs?: unknown };
  clientFileSystem?: Pick<AcpClientFileSystem, 'readTextFile' | 'writeTextFile'>;
  clientTerminals?: Pick<
    AcpClientTerminalManager,
    | 'cleanupAgent'
    | 'create'
    | 'display'
    | 'input'
    | 'kill'
    | 'output'
    | 'release'
    | 'resize'
    | 'waitForExit'
  >;
  terminalSpawn?: typeof spawn;
  browserPermissionDecision?: (
    agentId: string,
    tool: string,
    input: UnknownRecord,
  ) => { requiresApproval?: boolean; scopeKey?: string; site?: string } | null;
}
interface PrepareAgentOptions extends UnknownRecord {
  agentId?: string; provider?: string; providerHomeId?: string; cwd?: string; sessionId?: string;
  forkSourceSessionId?: string; forkSourceCheckpoint?: UnknownRecord | null; revisionBase?: number;
  approvalMode?: string; historyMode?: string; model?: string; reasoningEffort?: string;
  serviceTier?: string; identityOnly?: boolean;
  executable?: string; env?: NodeJS.ProcessEnv; runtimeEnv?: NodeJS.ProcessEnv;
  additionalDirectories?: string[]; mcpServers?: UnknownRecord[]; farmingSystemPrompt?: string;
  requireLoad?: boolean; expectedRevision?: number; retainForCleanup?: boolean;
  onProcessStarted?: (identity: ProcessIdentity) => Promise<void> | void;
  onForkSessionCreated?: (sessionId: string) => Promise<void> | void;
  onSubmitted?: () => Promise<void> | void; delivery?: string;
}
interface ProcessIdentity { pid: number; processGroupId: number; startedAt: string }
interface ProviderAdapterLike { id: string; acp?: { version: string } }
interface PersistedProcessIdentity { pid?: number; processGroupId?: number; startedAt?: string }
interface ProviderSessionIdentity extends UnknownRecord {
  provider?: string; executable?: string; env?: NodeJS.ProcessEnv; cwd?: string;
  sessionId?: string; producerStopped?: boolean;
}
interface SavedCheckpoint {
  state?: unknown;
  exact?: boolean;
  savedAt?: number;
  proof?: UnknownRecord & { token?: string; cwd?: string };
}
interface JsonSchemaProperty extends UnknownRecord {
  type?: string; minLength?: number; maxLength?: number; pattern?: string;
  minimum?: number; maximum?: number; minItems?: number; maxItems?: number;
  enum?: unknown[]; oneOf?: Array<{ const?: unknown }>;
  items?: { enum?: unknown[]; anyOf?: Array<{ const?: unknown }> };
}

function asErrorLike(error: unknown): ErrorLike {
  return error && typeof error === 'object' ? error as ErrorLike : {};
}

const ADAPTER_VERSIONS = Object.freeze(Object.fromEntries(
  listProviderAdapters()
    .filter(adapter => adapter.acp)
    .map(adapter => [adapter.id, adapter.acp!.version]),
));

const DEFAULT_INITIALIZE_TIMEOUT_MS = 15_000;
const DEFAULT_SESSION_SETUP_TIMEOUT_MS = 120_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_CANCEL_TIMEOUT_MS = 15_000;
const DEFAULT_HISTORY_REPLAY_MIN_WAIT_MS = 350;
const DEFAULT_HISTORY_REPLAY_QUIET_MS = 150;
const DEFAULT_HISTORY_REPLAY_MAX_WAIT_MS = 5_000;
const IDENTITY_ADAPTER_GRACEFUL_EXIT_MS = 3_000;
const IDENTITY_ADAPTER_TERMINATE_MS = 1_000;
const IDENTITY_ADAPTER_KILL_MS = 1_000;
const CODEX_SET_SESSION_MODEL_METHOD = 'session/set_model';
const CODEX_STEER_METHOD = '_codex/session/steer';
const CODEX_ACP_PACKAGE = '@agentclientprotocol/codex-acp';
const CODEX_ACP_VERSION = '1.1.4';
const CODEX_ACP_SHA256 = '7d9647ad2af49d47311a785bf5abd2d317d7c7438ae9d4eacfe785ba37191718';
const CLAUDE_ACP_PACKAGE = '@agentclientprotocol/claude-agent-acp';
const CLAUDE_ACP_VERSION = '0.59.0';
const CLAUDE_ACP_SHA256 = 'a6aa515dd02382617bf46d9eac47b8a1022c6835bcf7a8d61e2c63939be2e49c';
const CODEX_ACP_VENDOR_ENTRY = path.join(
  __dirname,
  '..',
  'dist',
  'acp',
  `codex-acp-${CODEX_ACP_VERSION}.mjs`,
);
const CLAUDE_ACP_VENDOR_ENTRY = path.join(
  __dirname,
  '..',
  'dist',
  'acp',
  `claude-agent-acp-${CLAUDE_ACP_VERSION}.mjs`,
);
const execFileAsync = promisify(execFile);

let sdkPromise: Promise<AcpSdk> | undefined;
const runtimeRequire = createRequire(__filename);
function loadAcpSdk() {
  if (!sdkPromise) sdkPromise = import('@agentclientprotocol/sdk');
  return sdkPromise!;
}

function fileSha256(filePath: string) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function verifiedCodexAcpEntry(entry: string) {
  const actualSha256 = fileSha256(entry);
  if (actualSha256 !== CODEX_ACP_SHA256) {
    throw new Error(
      `Codex ACP runtime failed integrity verification: expected ${CODEX_ACP_SHA256}, found ${actualSha256}`,
    );
  }
  return entry;
}

function adapterEntry(packageName: string) {
  if (packageName === CODEX_ACP_PACKAGE && fs.existsSync(CODEX_ACP_VENDOR_ENTRY)) {
    return verifiedCodexAcpEntry(CODEX_ACP_VENDOR_ENTRY);
  }
  if (packageName === CLAUDE_ACP_PACKAGE && fs.existsSync(CLAUDE_ACP_VENDOR_ENTRY)) {
    const actualSha256 = fileSha256(CLAUDE_ACP_VENDOR_ENTRY);
    if (actualSha256 !== CLAUDE_ACP_SHA256) {
      throw new Error(
        `Claude ACP runtime failed integrity verification: expected ${CLAUDE_ACP_SHA256}, found ${actualSha256}`,
      );
    }
    return CLAUDE_ACP_VENDOR_ENTRY;
  }
  let sdkDirectory;
  try {
    sdkDirectory = path.dirname(runtimeRequire.resolve('@agentclientprotocol/sdk'));
  } catch {
    throw new Error('ACP runtime packages are unavailable in this installation. Use the npm or app-bundle distribution.');
  }
  const entry = path.resolve(sdkDirectory, '..', '..', packageName.split('/').pop(), 'dist', 'index.js');
  if (!fs.existsSync(entry)) throw new Error(`ACP adapter is not installed: ${packageName}`);
  if (packageName === CODEX_ACP_PACKAGE) return verifiedCodexAcpEntry(entry);
  return entry;
}

function nodeAdapterLaunch(entry: string, env: NodeJS.ProcessEnv = process.env, packagedArg: string = '') {
  const runtimeEnv = env && typeof env === 'object' ? env : process.env;
  if ((process as NodeJS.Process & { pkg?: unknown }).pkg && packagedArg) {
    return { command: process.execPath, args: [packagedArg] };
  }
  const nodeBin = runtimeEnv.FARMING_NODE_BIN || process.execPath;
  const ldPath = runtimeEnv.FARMING_NODE_LD || '';
  const libraryPath = runtimeEnv.FARMING_NODE_LIBRARY_PATH || '';
  if (ldPath && libraryPath) {
    return {
      command: ldPath,
      args: ['--library-path', libraryPath, nodeBin, entry],
    };
  }
  return { command: nodeBin, args: [entry] };
}

function resolveAcpLaunch(provider: string, options: PrepareAgentOptions = {}) {
  const adapter = getProviderAdapter(provider);
  if (!adapter?.acp) throw new Error(`Unsupported ACP provider: ${provider}`);
  if (adapter.acp.launch) {
    return { ...adapter.acp.launch(options), version: adapter.acp.version };
  }
  if (adapter.acp.packageName) {
    const launch = nodeAdapterLaunch(
      adapterEntry(adapter.acp.packageName),
      options.runtimeEnv || process.env,
      adapter.acp.packageName === CODEX_ACP_PACKAGE
        ? PACKAGED_CODEX_ACP_ARG
        : adapter.acp.packageName === CLAUDE_ACP_PACKAGE
          ? PACKAGED_CLAUDE_ACP_ARG
          : '',
    );
    return { ...launch, version: adapter.acp.version };
  }
  throw new Error(`Unsupported ACP provider: ${provider}`);
}

function codexAcpEnvironment(options: PrepareAgentOptions = {}) {
  const adapter = getProviderAdapter('codex');
  if (!adapter?.prepareAcpEnvironment) {
    throw new Error('Codex ACP environment adapter is unavailable');
  }
  return adapter.prepareAcpEnvironment(options);
}

function selectedPermission(option: PermissionOption) {
  return { outcome: { outcome: 'selected', optionId: option.optionId } };
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function acpErrorMessage(error: unknown) {
  const failure = asErrorLike(error);
  const message = failure.message || String(error || 'ACP request failed');
  const details = failure.data?.details;
  return typeof details === 'string' && details && details !== message
    ? `${message}: ${details}`
    : message;
}

function acpErrorKind(error: unknown) {
  const failure = asErrorLike(error);
  const message = (failure.message || String(error || '')).toLowerCase();
  const code = String(failure.code || failure.data?.code || '').toLowerCase();
  const text = `${code} ${message}`;
  if (/\b(401|unauthorized|authentication|authenticate|login|sign[ -]?in|invalid api key)\b/.test(text)) return 'authentication';
  if (/\b(402|payment|billing|credit|insufficient quota)\b/.test(text)) return 'payment';
  if (/context (?:window|length|limit)|too many tokens|max(?:imum)? tokens/.test(text)) return 'context';
  if (/\b(model_not_found|unknown model|model unavailable|unsupported model)\b/.test(text)) return 'model';
  if (/\b(429|rate[ -]?limit|too many requests)\b/.test(text)) return 'rate-limit';
  if (/\b(econn|enet|ehost|socket|network|connection|timed? out|timeout|dns)\b/.test(text)) return 'network';
  if (/\b(protocol|json-rpc|parse error|invalid request|method not found)\b/.test(text)) return 'protocol';
  return 'unknown';
}

function autoPermissionResponse(request: UnknownRecord, approvalMode: string) {
  const options = Array.isArray(request?.options) ? request.options : [];
  if (approvalMode === 'full') {
    const option = options.find(item => item.kind === 'allow_always')
      || options.find(item => item.kind === 'allow_once');
    return option ? selectedPermission(option) : { outcome: { outcome: 'cancelled' } };
  }
  if (approvalMode === 'ask') {
    const option = options.find(item => item.kind === 'reject_once')
      || options.find(item => item.kind === 'reject_always');
    return option ? selectedPermission(option) : { outcome: { outcome: 'cancelled' } };
  }
  return null;
}

const FARMING_BROWSER_SERVER_NAME = 'farming-browser';
const FARMING_BROWSER_RESOURCE_TOOLS = new Set([
  'browser_list',
  'browser_stop',
]);

function recordValue(value: unknown): UnknownRecord {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : {};
}

function browserApprovalSessionState(
  binding: AcpBinding,
  request: UnknownRecord,
): AcpSessionState | null {
  const requestSessionId = String(request.sessionId || '');
  if (!requestSessionId || requestSessionId === binding.sessionId) return binding.sessionState || null;
  return binding.subagentStates.get(requestSessionId) || null;
}

function farmingBrowserApprovalTarget(
  binding: AcpBinding,
  request: UnknownRecord,
): { arguments: UnknownRecord; tool: string } | null {
  const toolCall = recordValue(request.toolCall);
  const toolCallId = String(request.toolCallId || toolCall.toolCallId || '');
  const sessionState = browserApprovalSessionState(binding, request);
  const entry = toolCallId
    ? sessionState?.toolEntries?.get(toolCallId)
      || sessionState?.entries?.find(candidate => candidate.id === toolCallId)
    : null;
  const rawInput = recordValue(entry?.rawInput || toolCall.rawInput);
  if (rawInput.server !== FARMING_BROWSER_SERVER_NAME) return null;
  const tool = String(rawInput.tool || '');
  if (!tool.startsWith('browser_')) return null;
  return {
    tool,
    arguments: recordValue(rawInput.arguments),
  };
}

function browserSiteScope(value: unknown): { requiresApproval: boolean; scopeKey: string; site: string } {
  const text = String(value || '').trim();
  if (!text || text === 'about:blank') {
    return { requiresApproval: false, scopeKey: '', site: '' };
  }
  try {
    const url = new URL(/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(text) ? text : `https://${text}`);
    if (!['http:', 'https:'].includes(url.protocol) || !url.host) {
      return { requiresApproval: true, scopeKey: '', site: '' };
    }
    return {
      requiresApproval: true,
      scopeKey: `site:${url.origin.toLowerCase()}`,
      site: url.host.toLowerCase(),
    };
  } catch {
    return { requiresApproval: true, scopeKey: '', site: '' };
  }
}

function defaultBrowserPermissionDecision(
  target: { arguments: UnknownRecord; tool: string },
): { requiresApproval: boolean; scopeKey: string; site: string } {
  if (FARMING_BROWSER_RESOURCE_TOOLS.has(target.tool)) {
    return { requiresApproval: false, scopeKey: '', site: '' };
  }
  if (target.tool === 'browser_open' || target.tool === 'browser_navigate') {
    return browserSiteScope(target.arguments.url);
  }
  const browserId = String(target.arguments.browserId || '');
  return {
    requiresApproval: true,
    scopeKey: browserId ? `browser:${browserId}` : '',
    site: '',
  };
}

function shouldAutoApproveFarmingBrowser(
  binding: AcpBinding,
  decision: { requiresApproval?: boolean; scopeKey?: string },
): { approve: boolean; scopeKey: string } {
  const scopeKey = String(decision.scopeKey || '');
  if (decision.requiresApproval !== true) {
    return { approve: true, scopeKey };
  }
  return {
    approve: Boolean(scopeKey && binding.farmingBrowserApprovedSites.has(scopeKey)),
    scopeKey,
  };
}

function automaticBrowserPermissionResponse(request: UnknownRecord) {
  const options = Array.isArray(request.options) ? request.options : [];
  const option = options.find(item => item.kind === 'allow_once')
    || options.find(item => item.kind === 'allow_always');
  return option ? selectedPermission(option) : { outcome: { outcome: 'cancelled' } };
}

function automaticBrowserElicitationResponse(request: UnknownRecord) {
  const properties = recordValue(recordValue(request.requestedSchema).properties);
  return {
    action: 'accept',
    content: Object.prototype.hasOwnProperty.call(properties, 'persist')
      ? { persist: 'once' }
      : {},
  };
}

function validateElicitationContent(request: UnknownRecord, content: unknown) {
  if (request?.mode !== 'form') return undefined;
  const value = content && typeof content === 'object' && !Array.isArray(content) ? content : {};
  const schema: UnknownRecord = request.requestedSchema && typeof request.requestedSchema === 'object'
    ? request.requestedSchema as UnknownRecord
    : {};
  const properties: Record<string, JsonSchemaProperty> = schema.properties && typeof schema.properties === 'object'
    ? schema.properties as Record<string, JsonSchemaProperty>
    : {};
  for (const name of Array.isArray(schema.required) ? schema.required : []) {
    if (!Object.prototype.hasOwnProperty.call(value, name)) throw new Error(`ACP input is required: ${name}`);
  }
  for (const [name, fieldValue] of Object.entries(value)) {
    const property = properties[name];
    if (!property || typeof property !== 'object') throw new Error(`Unknown ACP input field: ${name}`);
    if (property.type === 'string' && typeof fieldValue !== 'string') throw new Error(`ACP input must be text: ${name}`);
    if (property.type === 'number' && (typeof fieldValue !== 'number' || !Number.isFinite(fieldValue))) {
      throw new Error(`ACP input must be a number: ${name}`);
    }
    if (property.type === 'integer' && !Number.isInteger(fieldValue)) throw new Error(`ACP input must be an integer: ${name}`);
    if (property.type === 'boolean' && typeof fieldValue !== 'boolean') throw new Error(`ACP input must be true or false: ${name}`);
    if (property.type === 'array' && (!Array.isArray(fieldValue) || fieldValue.some(item => typeof item !== 'string'))) {
      throw new Error(`ACP input must be a text selection: ${name}`);
    }
    if (typeof fieldValue === 'string') {
      if (typeof property.minLength === 'number' && Number.isFinite(property.minLength) && fieldValue.length < property.minLength) throw new Error(`ACP input is too short: ${name}`);
      if (typeof property.maxLength === 'number' && Number.isFinite(property.maxLength) && fieldValue.length > property.maxLength) throw new Error(`ACP input is too long: ${name}`);
      if (typeof property.pattern === 'string') {
        let pattern;
        try {
          pattern = new RegExp(property.pattern);
        } catch {
          throw new Error(`ACP input schema has an invalid pattern: ${name}`);
        }
        if (!pattern.test(fieldValue)) throw new Error(`ACP input has an invalid format: ${name}`);
      }
      const allowed = Array.isArray(property.enum)
        ? property.enum
        : Array.isArray(property.oneOf)
          ? property.oneOf.map(option => option?.const)
          : null;
      if (allowed && !allowed.includes(fieldValue)) throw new Error(`ACP input is not an allowed choice: ${name}`);
    }
    if (typeof fieldValue === 'number') {
      if (typeof property.minimum === 'number' && Number.isFinite(property.minimum) && fieldValue < property.minimum) throw new Error(`ACP input is below the minimum: ${name}`);
      if (typeof property.maximum === 'number' && Number.isFinite(property.maximum) && fieldValue > property.maximum) throw new Error(`ACP input is above the maximum: ${name}`);
    }
    if (Array.isArray(fieldValue)) {
      if (typeof property.minItems === 'number' && Number.isFinite(property.minItems) && fieldValue.length < property.minItems) throw new Error(`ACP input needs more selections: ${name}`);
      if (typeof property.maxItems === 'number' && Number.isFinite(property.maxItems) && fieldValue.length > property.maxItems) throw new Error(`ACP input has too many selections: ${name}`);
      const allowedItems = Array.isArray(property.items?.enum)
        ? property.items.enum
        : Array.isArray(property.items?.anyOf)
          ? property.items.anyOf.map(option => option?.const)
          : null;
      if (allowedItems && fieldValue.some(item => !allowedItems.includes(item))) {
        throw new Error(`ACP input contains an unknown selection: ${name}`);
      }
    }
  }
  return JSON.parse(JSON.stringify(value));
}

function interactiveRuntimeState(binding: AcpBinding, fallback: string = '') {
  if (binding.pendingPermissions.size > 0) return 'waiting-for-permission';
  if (binding.pendingElicitations.size > 0) return 'waiting-for-input';
  if (binding.activeTurn?.phase === 'running') return 'working';
  if (binding.activeTurn?.phase === 'cancelling') return 'interrupting';
  if (['connecting', 'idle', 'error'].includes(String(fallback || ''))) return fallback;
  return binding.sessionId ? 'idle' : 'connecting';
}

function clone<T>(value: T): T {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function acpSessionRequestOptions(options: PrepareAgentOptions = {}, cwd: string = process.cwd()): AcpSessionRequestOptions {
  const root = path.resolve(cwd || process.cwd());
  const additionalDirectories = Array.isArray(options.additionalDirectories)
    ? [...new Set(options.additionalDirectories
      .filter((directory: string) => typeof directory === 'string' && directory.trim())
      .map((directory: string) => path.resolve(root, directory)))]
    : [];
  const mcpServers = Array.isArray(options.mcpServers)
    ? clone(options.mcpServers.filter((server: UnknownRecord) => server && typeof server === 'object' && !Array.isArray(server)))
    : [];
  const result: AcpSessionRequestOptions & { _meta?: UnknownRecord } = { cwd: root, additionalDirectories, mcpServers };
  if (
    options.provider === 'claude'
    && typeof options.farmingSystemPrompt === 'string'
    && options.farmingSystemPrompt.trim()
  ) {
    result._meta = {
      systemPrompt: {
        type: 'preset',
        preset: 'claude_code',
        append: options.farmingSystemPrompt.trim(),
      },
    };
  }
  return result;
}

function promptContentForCapabilities(content: unknown, capabilities: InitializeResponse['agentCapabilities'] = {}) {
  const promptCapabilities = capabilities?.promptCapabilities || {};
  return (Array.isArray(content) ? content : []).flatMap((block: PromptBlock) => {
    if (!block || typeof block !== 'object') return [];
    if (!block.type || !['image', 'audio'].includes(block.type)) return [clone(block)];
    if (promptCapabilities[block.type] === true) return [clone(block)];

    const label = block.type === 'audio' ? 'audio' : 'image';
    const attachmentPath = typeof block.path === 'string' && block.path.trim()
      ? path.resolve(block.path)
      : '';
    const name = attachmentPath ? path.basename(attachmentPath) : `attached ${label}`;
    const detail = attachmentPath
      ? `${label.charAt(0).toUpperCase()}${label.slice(1)} path: ${attachmentPath}`
      : `[The ACP Agent does not accept native ${label} content]`;
    return [{ type: 'text', text: `Attached ${label}: ${name}\n\n${detail}` }];
  });
}

function supportsCodexSteer(capabilities: InitializeResponse['agentCapabilities'] = {} = {}) {
  const capability = capabilities?._meta?.codex?.steer;
  return capability?.method === CODEX_STEER_METHOD
    && Number.isFinite(Number(capability.version))
    && Number(capability.version) >= 1;
}

function isCodexSteerUnavailableError(error: unknown) {
  const failure = asErrorLike(error);
  const text = [
    failure.message,
    failure.data?.details,
    failure.cause?.message,
    failure.cause?.data?.details,
  ].filter(Boolean).join(' ').toLowerCase();
  return text.includes('no active codex turn to steer')
    || text.includes('no active turn to steer')
    || /expected active turn id .* but found/.test(text)
    || text.includes('cannot steer a review turn')
    || text.includes('cannot steer a compact turn');
}

function childHasExited(child: import('child_process').ChildProcessWithoutNullStreams | null | undefined) {
  return !child
    || (child.exitCode !== null && child.exitCode !== undefined)
    || (child.signalCode !== null && child.signalCode !== undefined);
}

function processGroupHasExited(binding: AcpBinding) {
  if (!binding?.ownsProcessGroup || !binding.child?.pid || process.platform === 'win32') {
    return childHasExited(binding?.child);
  }
  try {
    process.kill(-binding.child.pid, 0);
    return false;
  } catch (error) {
    return asErrorLike(error).code === 'ESRCH';
  }
}

async function waitForProcessTreeExit(binding: AcpBinding, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (processGroupHasExited(binding)) return true;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return processGroupHasExited(binding);
}

function signalProcessTree(binding: AcpBinding, signal: NodeJS.Signals) {
  if (!binding?.child || processGroupHasExited(binding)) return;
  if (binding.ownsProcessGroup && binding.child.pid && process.platform !== 'win32') {
    try {
      process.kill(-binding.child.pid, signal);
      return;
    } catch (error) {
      if (asErrorLike(error).code === 'ESRCH') return;
    }
  }
  binding.child.kill(signal);
}

async function stopBindingProcessAndWait(binding: AcpBinding) {
  if (await waitForProcessTreeExit(binding, IDENTITY_ADAPTER_GRACEFUL_EXIT_MS)) return;
  signalProcessTree(binding, 'SIGTERM');
  if (await waitForProcessTreeExit(binding, IDENTITY_ADAPTER_TERMINATE_MS)) return;
  signalProcessTree(binding, 'SIGKILL');
  if (await waitForProcessTreeExit(binding, IDENTITY_ADAPTER_KILL_MS)) return;
  throw new Error(`ACP identity adapter process tree ${binding.child?.pid || ''} did not exit`);
}

async function describeAcpProcessGroup(pid: number) {
  const processId = Number(pid);
  if (!Number.isSafeInteger(processId) || processId <= 0 || process.platform === 'win32') {
    return null;
  }
  let stdout;
  try {
    ({ stdout } = await execFileAsync(
      '/bin/ps',
      ['-p', String(processId), '-o', 'pid=', '-o', 'pgid=', '-o', 'lstart='],
      { encoding: 'utf8', timeout: 1_000, maxBuffer: 16_384 },
    ));
  } catch (error) {
    if (asErrorLike(error).code === 1 || asErrorLike(error).code === 'ESRCH') return null;
    throw error;
  }
  const match = String(stdout || '').trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
  if (!match || Number(match[1]) !== processId) {
    throw new Error(`Could not read ACP process identity for pid ${processId}`);
  }
  if (Number(match[2]) !== processId) {
    throw new Error(`ACP process ${processId} did not become its own process-group leader`);
  }
  return {
    pid: processId,
    processGroupId: Number(match[2]),
    startedAt: match[3].trim(),
  };
}

async function stopPersistedAcpProcessGroup(identity: PersistedProcessIdentity | null | undefined) {
  const expected = identity && typeof identity === 'object' ? identity : null;
  if (
    !expected
    || !Number.isSafeInteger(Number(expected.pid))
    || !Number.isSafeInteger(Number(expected.processGroupId))
    || !String(expected.startedAt || '').trim()
  ) {
    return { stopped: false, missingProof: true };
  }
  const processGroupId = Number(expected.processGroupId);
  const groupHasExited = () => {
    try {
      process.kill(-processGroupId, 0);
      return false;
    } catch (error) {
      return asErrorLike(error).code === 'ESRCH';
    }
  };
  const current = await describeAcpProcessGroup(Number(expected.pid));
  if (!current && groupHasExited()) return { stopped: true, alreadyExited: true };
  if (
    current
    && (
      current.processGroupId !== processGroupId
      || current.startedAt !== String(expected.startedAt)
    )
  ) {
    return { stopped: false, identityMismatch: true };
  }
  const waitForExit = async (timeoutMs: number) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() <= deadline) {
      if (groupHasExited()) return true;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    return groupHasExited();
  };
  const signal = (value: NodeJS.Signals) => {
    try {
      process.kill(-processGroupId, value);
    } catch (error) {
      if (asErrorLike(error).code !== 'ESRCH') throw error;
    }
  };

  signal('SIGTERM');
  if (await waitForExit(IDENTITY_ADAPTER_TERMINATE_MS)) return { stopped: true };
  signal('SIGKILL');
  if (await waitForExit(IDENTITY_ADAPTER_KILL_MS)) return { stopped: true };
  return { stopped: false, timedOut: true };
}

async function deleteProviderSessionIdentity(options: PrepareAgentOptions = {}) {
  const provider = String(options.provider || '').trim().toLowerCase();
  const sessionId = String(options.sessionId || '').trim();
  if (!isSafeProviderSessionId(sessionId)) {
    throw new Error('Provider session rollback requires a safe exact session id');
  }
  let args;
  if (provider === 'codex') args = ['delete', '--force', sessionId];
  else if (provider === 'opencode') args = ['session', 'delete', sessionId];
  else throw new Error(`${provider || 'Provider'} does not support identity rollback`);
  await execFileAsync(options.executable || getProviderAdapter(provider)?.executable, args, {
    cwd: options.cwd,
    env: options.env,
    timeout: 15_000,
    maxBuffer: 1024 * 1024,
  });
}

function attachProviderSessionIdentity(
  error: unknown,
  identity: ProviderSessionIdentity,
  rollbackError?: unknown,
) {
  const target = error instanceof Error ? error : new Error(String(error || 'Provider session identity failed'));
  Object.defineProperty(target, 'providerSessionIdentity', {
    value: identity,
    enumerable: false,
    configurable: true,
  });
  if (rollbackError) {
    Object.defineProperty(target, 'providerSessionRollbackError', {
      value: rollbackError,
      enumerable: false,
      configurable: true,
    });
  }
  return target;
}

class AcpRuntime extends EventEmitter {
  declare bindings: Map<string, AcpBinding>;
  declare spawn: typeof spawn;
  declare createConnection: NonNullable<AcpRuntimeOptions['createConnection']> | null;
  declare resolveLaunch: NonNullable<AcpRuntimeOptions['resolveLaunch']>;
  declare maxUpdates: number | undefined;
  declare initializeTimeoutMs: number;
  declare sessionSetupTimeoutMs: number;
  declare requestTimeoutMs: number;
  declare cancelTimeoutMs: number;
  declare historyReplayMinWaitMs: number;
  declare historyReplayQuietMs: number;
  declare historyReplayMaxWaitMs: number;
  declare deleteProviderSessionIdentity: NonNullable<AcpRuntimeOptions['deleteProviderSessionIdentity']>;
  declare describeProcessGroup: NonNullable<AcpRuntimeOptions['describeAcpProcessGroup']>;
  declare checkpointStore: Pick<
    AcpCheckpointStore,
    'dispose' | 'flush' | 'load' | 'markDirty' | 'schedule' | 'write'
  > | null;
  declare disposing: boolean;
  declare disposePromise: Promise<void> | null;
  declare disposed: boolean;
  declare clientFileSystem: Pick<AcpClientFileSystem, 'readTextFile' | 'writeTextFile'>;
  declare clientTerminals: Pick<
    AcpClientTerminalManager,
    | 'cleanupAgent'
    | 'create'
    | 'display'
    | 'input'
    | 'kill'
    | 'output'
    | 'release'
    | 'resize'
    | 'waitForExit'
  >;
  declare browserPermissionDecision: NonNullable<AcpRuntimeOptions['browserPermissionDecision']>;
  constructor(options: AcpRuntimeOptions = {}) {
    super();
    this.spawn = options.spawn || spawn;
    this.createConnection = options.createConnection || null;
    this.resolveLaunch = options.resolveLaunch || resolveAcpLaunch;
    this.maxUpdates = options.maxUpdates;
    this.initializeTimeoutMs = options.initializeTimeoutMs || DEFAULT_INITIALIZE_TIMEOUT_MS;
    this.sessionSetupTimeoutMs = options.sessionSetupTimeoutMs || DEFAULT_SESSION_SETUP_TIMEOUT_MS;
    this.requestTimeoutMs = options.requestTimeoutMs || DEFAULT_REQUEST_TIMEOUT_MS;
    this.cancelTimeoutMs = options.cancelTimeoutMs || DEFAULT_CANCEL_TIMEOUT_MS;
    this.historyReplayMinWaitMs = options.historyReplayMinWaitMs ?? DEFAULT_HISTORY_REPLAY_MIN_WAIT_MS;
    this.historyReplayQuietMs = options.historyReplayQuietMs ?? DEFAULT_HISTORY_REPLAY_QUIET_MS;
    this.historyReplayMaxWaitMs = options.historyReplayMaxWaitMs ?? DEFAULT_HISTORY_REPLAY_MAX_WAIT_MS;
    this.deleteProviderSessionIdentity = options.deleteProviderSessionIdentity || deleteProviderSessionIdentity;
    this.describeProcessGroup = options.describeAcpProcessGroup || describeAcpProcessGroup;
    this.checkpointStore = options.checkpointStore
      || (options.configDir ? new AcpCheckpointStore(options.configDir, options.checkpointOptions) : null);
    this.bindings = new Map<string, AcpBinding>();
    this.disposing = false;
    this.disposePromise = null;
    this.disposed = false;
    this.clientFileSystem = options.clientFileSystem || new AcpClientFileSystem();
    this.clientTerminals = options.clientTerminals || new AcpClientTerminalManager({ spawn: options.terminalSpawn });
    this.browserPermissionDecision = typeof options.browserPermissionDecision === 'function'
      ? options.browserPermissionDecision
      : (_agentId: string, tool: string, input: UnknownRecord) => (
          defaultBrowserPermissionDecision({ tool, arguments: input })
        );
  }

  /**
   * @param {{
   *   agentId?: string,
   *   provider?: string,
   *   forkSourceSessionId?: string,
   *   forkSourceCheckpoint?: unknown,
   *   onForkSessionCreated?: (sessionId: string) => Promise<void> | void,
   *   [key: string]: unknown,
   * }} [options]
   */
  async prepareAgent(options: PrepareAgentOptions = {}) {
    if (this.disposing || this.disposed) {
      throw new Error('ACP runtime is shutting down');
    }
    const agentId = String(options.agentId || '');
    if (!agentId) throw new Error('ACP Agent id is required');
    if (this.bindings.has(agentId)) throw new Error('ACP Agent is already registered');
    const provider = String(options.provider || '').trim().toLowerCase();
    const launch = this.resolveLaunch(provider, options);
    const cwd = path.resolve(options.cwd || process.cwd());
    const requestedSessionId = String(options.sessionId || '').trim();
    const forkSourceSessionId = String(options.forkSourceSessionId || '').trim();
    const forkSourceCheckpoint = options.forkSourceCheckpoint || null;
    const forkSourceSessionCheckpoint = (forkSourceCheckpoint?.version === 2
      ? forkSourceCheckpoint.sessionState
      : forkSourceCheckpoint) as (UnknownRecord & { cwd?: unknown; provider?: unknown; sessionId?: unknown }) | undefined;
    const revisionBase = Number.isFinite(Number(options.revisionBase))
      ? Math.max(0, Math.floor(Number(options.revisionBase)))
      : 0;
    let forkSourceCheckpointState = null;
    if (forkSourceSessionId) {
      if (requestedSessionId) {
        throw new Error('ACP fork startup cannot also load a target session');
      }
      if (!isSafeProviderSessionId(forkSourceSessionId)) {
        throw new Error('ACP fork startup requires a safe exact source session id');
      }
      if (!forkSourceCheckpoint) {
        throw new Error('ACP fork startup requires an exact source checkpoint');
      }
      const checkpointCwd = String(forkSourceSessionCheckpoint?.cwd || '').trim();
      if (
        String(forkSourceSessionCheckpoint?.provider || '') !== provider
        || String(forkSourceSessionCheckpoint?.sessionId || '') !== forkSourceSessionId
        || !checkpointCwd
        || path.resolve(checkpointCwd) !== cwd
      ) {
        throw new Error('ACP fork source checkpoint does not match the requested source');
      }
      forkSourceCheckpointState = AcpSessionState.fromCheckpoint(forkSourceSessionCheckpoint, {
        provider,
        sessionId: forkSourceSessionId,
        cwd,
        maxUpdates: this.maxUpdates,
      });
      if (!forkSourceCheckpointState) {
        throw new Error('ACP fork source checkpoint is invalid');
      }
    }
    const sessionRequestOptions = acpSessionRequestOptions(options, cwd);
    const binding: AcpBinding = {
      agentId,
      provider,
      providerHomeId: String(options.providerHomeId || 'default'),
      cwd,
      sessionRequestOptions,
      env: (getProviderAdapter(provider)?.prepareAcpEnvironment || ((value: PrepareAgentOptions) => value.env || process.env))(options),
      launch,
      restartOptions: { ...options, agentId, provider },
      approvalMode: options.approvalMode || 'approve',
      farmingBrowserApprovedSites: new Set(),
      farmingBrowserApprovalScopes: new Map(),
      ownsProcessGroup: process.platform !== 'win32',
      child: null,
      connection: null as unknown as AcpConnection,
      initializeResponse: null as unknown as InitializeResponse,
      sessionId: '',
      untrustedSessionId: '',
      state: 'connecting',
      error: '',
      stopReason: '',
      modes: null,
      configOptions: [],
      pendingPermissions: new Map(),
      permissionResolvers: new Map(),
      pendingElicitations: new Map(),
      elicitationResolvers: new Map(),
      activeElicitations: new Map(),
      subagentStates: new Map(),
      subagentControls: new Map(),
      nextSubagentGeneration: 1,
      interactionOrigins: new Map(),
      // One binding owns at most one Turn. All Turn controls and its terminal
      // commit are fenced by this object before they may mutate shared state.
      activeTurn: null,
      nextTurnId: 1,
      supportsSteer: false,
      historyReplayActive: false,
      sessionState: new AcpSessionState({
        provider,
        sessionId: '',
        cwd,
        maxUpdates: this.maxUpdates,
      }),
      authTerminal: null as unknown as UnknownRecord,
      patchDecisions: new Map(),
      patchDecisionInFlight: new Map(),
      checkpointProof: null,
      sessionMutation: null,
      configMutationTail: null,
      stderr: '',
      exited: false,
      updatedAt: new Date().toISOString(),
    };
    this.bindings.set(agentId, binding);
    this.emitRuntime(binding);

    try {
      const gatedLaunch = binding.ownsProcessGroup
        ? {
            command: '/bin/sh',
            args: [
              '-c',
              'IFS= read -r farming_acp_start || exit 0; exec "$@"',
              'farming-acp-start-gate',
              launch.command,
              ...launch.args,
            ],
          }
        : launch;
      const child = this.spawn(gatedLaunch.command, gatedLaunch.args, {
        cwd: binding.cwd,
        env: binding.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: binding.ownsProcessGroup,
      });
      binding.child = child;
      child.stderr.on('data', (chunk: Buffer) => {
        binding.stderr = `${binding.stderr}${chunk.toString('utf8')}`.slice(-16_000);
      });
      child.on('error', (error: unknown) => this.handleExit(binding, error));
      child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
        if (!binding.connection?.signal?.aborted) {
          const detail = binding.stderr.trim() || `ACP adapter exited with code ${code}${signal ? ` (${signal})` : ''}`;
          this.handleExit(binding, code === 0 ? null : new Error(detail));
        }
      });
      if (binding.ownsProcessGroup && typeof options.onProcessStarted === 'function') {
        const processIdentity = await this.describeProcessGroup(child.pid);
        if (!processIdentity) {
          throw new Error(`ACP process ${child.pid || ''} exited before its identity was persisted`);
        }
        await options.onProcessStarted(processIdentity);
      }
      if (binding.ownsProcessGroup) {
        await new Promise<void>((resolve, reject) => {
          child.stdin.write('start\n', (error: unknown) => {
            if (error) reject(error);
            else resolve();
          });
        });
      }

      const connection = this.createConnection
        ? await this.createConnection(this.clientHandlers(binding), child, binding)
        : await this.officialConnection(this.clientHandlers(binding), child);
      binding.connection = connection;
      this.requireOpenBinding(binding);
      connection.closed.catch((error: unknown) => this.handleExit(binding, error));
      const sdk = await loadAcpSdk();
      this.requireOpenBinding(binding);
      binding.initializeResponse = await withTimeout(connection.initialize({
        protocolVersion: sdk.PROTOCOL_VERSION,
        clientCapabilities: {
          fs: { readTextFile: true, writeTextFile: true },
          terminal: true,
          auth: { terminal: true },
          session: { configOptions: { boolean: {} } },
          plan: {},
          elicitation: { form: {}, url: {} },
          _meta: { terminal_output: true },
        },
        clientInfo: { name: 'farming', title: 'Farming', version: packageJson.version || '0.0.0' },
      }), this.initializeTimeoutMs, 'ACP initialize');
      this.requireOpenBinding(binding);
      if (binding.initializeResponse.protocolVersion !== sdk.PROTOCOL_VERSION) {
        throw new Error(`ACP protocol version mismatch: Agent selected ${binding.initializeResponse.protocolVersion}, Farming supports ${sdk.PROTOCOL_VERSION}`);
      }
      binding.supportsSteer = binding.provider === 'codex'
        && supportsCodexSteer(binding.initializeResponse.agentCapabilities);

      const sessionRequest = { sessionId: requestedSessionId, ...binding.sessionRequestOptions };
      let sessionResponse!: SessionResponse;
      let historyMode = 'new';
      if (forkSourceSessionId) {
        const capabilities = binding.initializeResponse.agentCapabilities || {};
        if (!capabilities.loadSession || !capabilities.sessionCapabilities?.fork) {
          throw new Error(`${provider} ACP Agent cannot create an owned fork`);
        }
        if (!capabilities.sessionCapabilities?.close) {
          throw new Error(`${provider} ACP Agent cannot release the loaded fork source`);
        }
        binding.sessionId = forkSourceSessionId;
        binding.sessionState = new AcpSessionState({
          provider,
          sessionId: forkSourceSessionId,
          cwd: binding.cwd,
          maxUpdates: this.maxUpdates,
          revisionBase,
        });
        binding.historyReplayActive = true;
        let loadedSource: SessionResponse;
        try {
          loadedSource = await withTimeout(
            connection.loadSession({ sessionId: forkSourceSessionId, ...binding.sessionRequestOptions }),
            this.sessionSetupTimeoutMs,
            'ACP fork source session/load',
          );
          this.requireOpenBinding(binding);
          if (provider === 'qoder') await this.waitForHistoryReplay(binding);
          this.requireOpenBinding(binding);
        } finally {
          binding.historyReplayActive = false;
        }
        binding.sessionState.finishHistoryReplay();
        const forked: SessionResponse = await withTimeout(
          connection.unstable_forkSession({
            sessionId: forkSourceSessionId,
            ...binding.sessionRequestOptions,
          }),
          this.sessionSetupTimeoutMs,
          'ACP owned session/fork',
        );
        const forkedSessionId = String(forked?.sessionId || '').trim();
        if (
          !isSafeProviderSessionId(forkedSessionId)
          || forkedSessionId === forkSourceSessionId
        ) {
          throw new Error('ACP owned session/fork returned an invalid new session id');
        }
        if (typeof options.onForkSessionCreated === 'function') {
          await options.onForkSessionCreated(forkedSessionId);
        }
        this.requireOpenBinding(binding);
        await withTimeout(
          connection.closeSession({ sessionId: forkSourceSessionId }),
          this.requestTimeoutMs,
          'ACP fork source session/close',
        );
        this.requireOpenBinding(binding);
        const forkUpdates = binding.subagentStates.get(forkedSessionId);
        const restoredForkSource = this.restoreBindingCheckpoint(binding, forkSourceCheckpoint, {
          sessionId: forkedSessionId,
        });
        if (!restoredForkSource) {
          throw new Error('ACP fork source checkpoint could not be restored');
        }
        binding.sessionId = forkedSessionId;
        binding.sessionState = restoredForkSource.sessionState;
        binding.subagentStates = restoredForkSource.subagentStates;
        this.resetSubagentControls(binding);
        binding.patchDecisions = restoredForkSource.patchDecisions;
        delete binding.restartOptions.forkSourceSessionId;
        delete binding.restartOptions.forkSourceCheckpoint;
        delete binding.restartOptions.onForkSessionCreated;
        if (forkUpdates?.updates?.some(
          item => recordValue(item?.update).sessionUpdate === 'available_commands_update',
        )) {
          binding.sessionState.availableCommands = clone(forkUpdates.availableCommands);
        }
        sessionResponse = {
          ...loadedSource,
          ...forked,
          sessionId: forkedSessionId,
          modes: forked?.modes || loadedSource?.modes,
          configOptions: forked?.configOptions || loadedSource?.configOptions,
        };
        historyMode = 'fork';
      } else if (requestedSessionId) {
        const capabilities = binding.initializeResponse.agentCapabilities || {};
        let opened = false;
        let restoredCheckpointState = null;
        let restoredCheckpoint = null;
        let saved = null;
        if (options.historyMode === 'checkpoint' && this.checkpointStore) {
          saved = await this.checkpointStore.load(
            this.checkpointIdentity(binding, requestedSessionId),
            { allowDirty: true },
          );
          this.requireOpenBinding(binding);
          restoredCheckpoint = this.restoreBindingCheckpoint(
            binding,
            recordValue(saved?.state) as AcpCheckpoint,
            { sessionId: requestedSessionId },
          );
          restoredCheckpointState = restoredCheckpoint?.sessionState || null;
        }
        if (capabilities.sessionCapabilities?.resume && restoredCheckpoint) {
          const providerStateMatches = restoredCheckpoint?.complete === true && saved?.exact === true
            ? await this.checkpointMatchesProviderSession(connection, capabilities, sessionRequest, saved)
            : false;
          this.requireOpenBinding(binding);
          if (providerStateMatches && restoredCheckpointState) {
            binding.sessionId = requestedSessionId;
            binding.sessionState = restoredCheckpointState;
            binding.subagentStates = restoredCheckpoint.subagentStates;
            this.resetSubagentControls(binding);
            binding.patchDecisions = restoredCheckpoint.patchDecisions;
            binding.checkpointProof = restoredCheckpoint.providerProof;
            try {
              sessionResponse = await withTimeout(
                connection.resumeSession(sessionRequest),
                this.sessionSetupTimeoutMs,
                'ACP session/resume'
              );
              this.requireOpenBinding(binding);
              historyMode = 'checkpoint';
              opened = true;
            } catch (error) {
              this.requireOpenBinding(binding);
              if (!capabilities.loadSession) throw error;
              console.warn(`ACP checkpoint resume failed for ${provider}; replaying history:`, asErrorLike(error).message || error);
            }
          }
        }
        if (!opened && options.historyMode !== 'resume' && capabilities.loadSession) {
          const replayRevisionBase = Math.max(revisionBase, Number(restoredCheckpointState?.revision || 0));
          binding.sessionId = requestedSessionId;
          binding.sessionState = new AcpSessionState({
            provider,
            sessionId: requestedSessionId,
            cwd: binding.cwd,
            maxUpdates: this.maxUpdates,
            revisionBase: replayRevisionBase,
            resetBeforeRevision: replayRevisionBase,
          });
          binding.historyReplayActive = true;
          try {
            sessionResponse = await withTimeout(
              connection.loadSession(sessionRequest),
              this.sessionSetupTimeoutMs,
              'ACP session/load'
            );
            this.requireOpenBinding(binding);
            if (provider === 'qoder') await this.waitForHistoryReplay(binding);
            this.requireOpenBinding(binding);
          } finally {
            binding.historyReplayActive = false;
          }
          binding.sessionState.finishHistoryReplay();
          this.restorePatchDecisions(binding, restoredCheckpoint?.patchDecisions);
          historyMode = 'load';
          opened = true;
        } else if (!opened && capabilities.sessionCapabilities?.resume) {
          binding.sessionId = requestedSessionId;
          binding.sessionState = new AcpSessionState({
            provider,
            sessionId: requestedSessionId,
            cwd: binding.cwd,
            maxUpdates: this.maxUpdates,
            revisionBase,
          });
          sessionResponse = await withTimeout(
            connection.resumeSession(sessionRequest),
            this.sessionSetupTimeoutMs,
            'ACP session/resume'
          );
          this.requireOpenBinding(binding);
          historyMode = 'resume';
          opened = true;
        } else {
          if (!opened) throw new Error(`${provider} ACP Agent cannot load or resume session ${requestedSessionId}`);
        }
      } else {
        sessionResponse = await withTimeout(
          connection.newSession(binding.sessionRequestOptions),
          this.sessionSetupTimeoutMs,
          'ACP session/new'
        );
        this.requireOpenBinding(binding);
        const returnedSessionId = String(sessionResponse.sessionId || '').trim();
        if (!isSafeProviderSessionId(returnedSessionId)) {
          binding.untrustedSessionId = returnedSessionId;
          throw new Error('ACP session/new returned an invalid resumable session id');
        }
        binding.sessionId = returnedSessionId;
        binding.sessionState = new AcpSessionState({ provider, sessionId: binding.sessionId, cwd: binding.cwd, maxUpdates: this.maxUpdates });
      }
      this.requireOpenBinding(binding);
      binding.modes = sessionResponse?.modes || null;
      binding.configOptions = sessionResponse?.configOptions || [];
      binding.sessionState.currentModeId = String(binding.modes?.currentModeId || '');
      binding.sessionState.configOptions = JSON.parse(JSON.stringify(binding.configOptions));
      if (provider === 'claude' && historyMode === 'new') {
        const changes: SessionConfigChange[] = [];
        if (options.model && options.model !== 'config') {
          const modelOption = binding.configOptions.find(option => (
            option.type === 'select'
            && (
              option.category === 'model'
              || /(^|[\s_-])model([\s_-]|$)/i.test(`${option.id} ${option.name || ''}`)
            )
          ));
          if (!modelOption) {
            throw new Error('Claude ACP Agent did not advertise a Model configuration option');
          }
          changes.push({ configId: modelOption.id, value: options.model });
        }
        if (options.reasoningEffort && options.reasoningEffort !== 'config') {
          const reasoningOption = binding.configOptions.find(option => (
            option.type === 'select'
            && (
              option.category === 'thought_level'
              || /(reasoning|thought|effort)/i.test(`${option.id} ${option.name || ''}`)
            )
          ));
          if (!reasoningOption) {
            throw new Error('Claude ACP Agent did not advertise a Reasoning configuration option');
          }
          changes.push({ configId: reasoningOption.id, value: options.reasoningEffort });
        }
        if (changes.length > 0) await this.applySessionConfigOptionsNow(binding, changes);
      }
      if (provider === 'codex' && options.serviceTier && options.serviceTier !== 'config') {
        const fastOption = binding.configOptions.find(option => (
          option.type === 'boolean'
          && /fast/i.test(`${option.id || ''} ${option.name || ''} ${option.category || ''}`)
        ));
        const fastEnabled = ['fast', 'priority'].includes(options.serviceTier);
        if (fastOption && fastOption.currentValue !== fastEnabled) {
          await this.applySessionConfigOption(binding, fastOption.id, fastEnabled, { emit: false });
        }
      }
      this.requireOpenBinding(binding);
      binding.state = 'idle';
      binding.updatedAt = new Date().toISOString();
      this.scheduleCheckpoint(binding, { exact: true });
      this.emitRuntime(binding);
      this.emitSession(binding);
      return {
        sessionId: binding.sessionId,
        historyMode,
        protocolVersion: binding.initializeResponse.protocolVersion,
        agentInfo: binding.initializeResponse.agentInfo || null,
        capabilities: binding.initializeResponse.agentCapabilities || {},
        adapter: launch,
      };
    } catch (error) {
      const runtimeError = new Error(acpErrorMessage(error), { cause: error });
      this.handleExit(binding, runtimeError);
      if (options.identityOnly === true) {
        const returnedIdentity = binding.sessionId || binding.untrustedSessionId;
        const identity = returnedIdentity
          ? {
              provider,
              executable: options.executable || getProviderAdapter(provider)?.executable,
              env: binding.env,
              cwd: binding.cwd,
              sessionId: returnedIdentity,
              producerStopped: false,
            }
          : null;
        let producerStopped = false;
        try {
          await this.unregisterAgentAndWait(agentId);
          producerStopped = true;
          if (identity) identity.producerStopped = true;
        } catch (cleanupError) {
          Object.defineProperty(runtimeError, 'adapterCleanupError', {
            value: cleanupError,
            enumerable: false,
            configurable: true,
          });
          if (identity) attachProviderSessionIdentity(runtimeError, identity);
        }
        if (identity && producerStopped && isSafeProviderSessionId(identity.sessionId)) {
          try {
            await this.deleteProviderSessionIdentity(identity);
          } catch (rollbackError) {
            attachProviderSessionIdentity(runtimeError, identity, rollbackError);
          }
        } else if (identity && producerStopped) {
          attachProviderSessionIdentity(runtimeError, identity);
        }
      } else {
        let runtimeCleanupVerified = false;
        try {
          if (this.isCurrentBinding(binding)) {
            runtimeCleanupVerified = await this.unregisterAgentAndWait(agentId, binding);
          } else {
            try {
              binding.connection?.close();
            } catch {
              // Process-tree cleanup below remains authoritative.
            }
            await stopBindingProcessAndWait(binding);
            runtimeCleanupVerified = true;
          }
        } catch (cleanupError) {
          Object.defineProperty(runtimeError, 'adapterCleanupError', {
            value: cleanupError,
            enumerable: false,
            configurable: true,
          });
        }
        Object.defineProperties(runtimeError, {
          runtimeCleanupAttempted: {
            value: true,
            enumerable: false,
            configurable: true,
          },
          runtimeCleanupVerified: {
            value: runtimeCleanupVerified === true,
            enumerable: false,
            configurable: true,
          },
        });
        if (!runtimeCleanupVerified && !this.isCurrentBinding(binding)) {
          try {
            binding.connection?.close();
          } catch {
            // The detached binding remains only as an error cleanup handle.
          }
        }
      }
      throw runtimeError;
    }
  }

  async createSessionIdentity(
    options: PrepareAgentOptions = {},
  ): Promise<ProviderSessionIdentityResult> {
    const agentId = `provider-session-${crypto.randomUUID()}`;
    let prepared = null;
    let result = null;
    let failure = null;
    let identity = null;
    try {
      prepared = await this.prepareAgent({
        ...options,
        agentId,
        identityOnly: true,
        sessionId: '',
      });
      const binding = this.requireBinding(agentId);
      identity = {
        provider: String(options.provider || '').trim().toLowerCase(),
        executable: options.executable || getProviderAdapter(options.provider)?.executable,
        env: binding.env,
        cwd: binding.cwd,
        sessionId: prepared.sessionId,
        producerStopped: false,
      };
      result = {
        ...prepared,
        sessionRequestOptions: this.getSessionRequestOptions(agentId),
      };
    } catch (error) {
      failure = error instanceof Error ? error : new Error(String(error || 'Provider session identity failed'));
    }

    if (prepared) {
      let producerStopped = false;
      try {
        await this.unregisterAgentAndWait(agentId);
        producerStopped = true;
        if (identity) identity.producerStopped = true;
      } catch (cleanupError) {
        if (!failure) {
          failure = cleanupError instanceof Error
            ? cleanupError
            : new Error(String(cleanupError || 'ACP identity adapter cleanup failed'));
        } else {
          Object.defineProperty(failure, 'adapterCleanupError', {
            value: cleanupError,
            enumerable: false,
            configurable: true,
          });
        }
        if (identity) failure = attachProviderSessionIdentity(failure, identity);
      }
      if (failure && identity?.sessionId && producerStopped) {
        try {
          await this.deleteProviderSessionIdentity(identity);
        } catch (rollbackError) {
          failure = attachProviderSessionIdentity(failure, identity, rollbackError);
        }
      }
    }
    if (failure) throw failure;
    if (!result) {
      throw new Error('Provider session identity completed without a result');
    }
    return result;
  }

  isCurrentBinding(binding: AcpBinding) {
    return Boolean(binding) && this.bindings.get(binding.agentId) === binding;
  }

  requireCurrentBinding(binding: AcpBinding) {
    if (!this.isCurrentBinding(binding)) {
      throw new Error('ACP Agent binding is no longer active');
    }
    return binding;
  }

  isOpenBinding(binding: AcpBinding) {
    return this.isCurrentBinding(binding) && binding.exited !== true;
  }

  requireOpenBinding(binding: AcpBinding) {
    if (this.disposing || this.disposed) throw new Error('ACP runtime is shutting down');
    this.requireCurrentBinding(binding);
    if (binding.exited) throw new Error('ACP Agent connection is closed');
    return binding;
  }

  isCurrentTurn(binding: AcpBinding, turn: AcpTurn | null) {
    return this.isOpenBinding(binding) && binding.activeTurn === turn;
  }

  requireCurrentTurn(
    binding: AcpBinding,
    turn: AcpTurn | null,
    phases: readonly string[] | null = null,
  ): asserts turn is AcpTurn {
    this.requireOpenBinding(binding);
    if (
      binding.activeTurn !== turn
      || (Array.isArray(phases) && !phases.includes(turn?.phase))
    ) {
      throw new Error('No active Codex turn to steer');
    }
  }

  beginTurn(binding: AcpBinding) {
    this.requireOpenBinding(binding);
    if (binding.activeTurn) throw new Error(`ACP Agent is not ready (${binding.state})`);
    let resolveCompletion;
    const completion = new Promise(resolve => {
      resolveCompletion = resolve;
    });
    const turn = {
      id: binding.nextTurnId++,
      phase: 'admitting',
      previousState: binding.state,
      providerSettled: false,
      controlTail: Promise.resolve(),
      cancelPromise: null,
      completion,
      resolveCompletion,
    };
    binding.activeTurn = turn;
    return turn;
  }

  finishTurn(binding: AcpBinding, turn: AcpTurn, result: unknown) {
    if (binding.activeTurn !== turn) return false;
    binding.activeTurn = null;
    turn.phase = 'completed';
    turn.resolveCompletion?.(result);
    return true;
  }

  cancelAdmittingTurn(binding: AcpBinding, turn: AcpTurn) {
    if (binding.activeTurn !== turn || turn.phase !== 'admitting') return false;
    binding.activeTurn = null;
    turn.phase = 'cancelled';
    binding.state = String(turn.previousState || 'idle');
    turn.resolveCompletion?.({ status: 'cancelled-before-submission' });
    this.emitRuntime(binding);
    return true;
  }

  async enqueueTurnControl<T>(turn: AcpTurn, operation: () => Promise<T> | T): Promise<T> {
    const previous = turn.controlTail || Promise.resolve();
    const pending = previous.catch(() => {}).then(operation);
    turn.controlTail = pending;
    try {
      return await pending;
    } finally {
      if (turn.controlTail === pending) turn.controlTail = Promise.resolve();
    }
  }

  ensureSubagentControl(binding: AcpBinding, sessionId: string) {
    const id = String(sessionId || '');
    if (!id) throw new Error('ACP subagent control requires a session id');
    let control = binding.subagentControls.get(id);
    if (!control) {
      control = {
        sessionId: id,
        generation: binding.nextSubagentGeneration++,
        phase: 'active',
        error: '',
        cancelPromise: null,
      };
      binding.subagentControls.set(id, control);
    }
    return control;
  }

  resetSubagentControls(binding: AcpBinding) {
    binding.subagentControls.clear();
    for (const sessionId of binding.subagentStates.keys()) {
      const control = this.ensureSubagentControl(binding, sessionId);
      const parentTool = binding.sessionState?.entries.find((entry: TranscriptEntry) => (
        entry?.type === 'tool'
        && String(entry?._meta?.subagent_session_info?.session_id || '') === sessionId
      ));
      if (parentTool) {
        this.updateSubagentControlFromParent(binding, parentTool);
      } else {
        // Restored evidence without a parent Tool cannot prove that a child
        // from the previous adapter process is still active.
        control.phase = 'completed';
      }
    }
  }

  activeSubagentSessionIds(binding: AcpBinding) {
    return [...binding.subagentStates.keys()].filter((sessionId: string) => {
      const control = this.ensureSubagentControl(binding, sessionId);
      if (control?.cancelPromise || ['active', 'cancelling'].includes(control?.phase)) return true;
      const hasInteraction = [...binding.pendingPermissions.values(), ...binding.pendingElicitations.values()]
        .some((request: UnknownRecord) => String(request?.sessionId || '') === sessionId);
      if (hasInteraction) return true;
      const parentTool = binding.sessionState?.entries.find((entry: TranscriptEntry) => (
        entry?.type === 'tool'
        && String(entry?._meta?.subagent_session_info?.session_id || '') === sessionId
      ));
      return ['pending', 'in_progress', 'in-progress', 'running']
        .includes(String(parentTool?.status || '').toLowerCase());
    });
  }

  updateSubagentControlFromParent(binding: AcpBinding, update: TranscriptEntry) {
    const sessionId = String(update?._meta?.subagent_session_info?.session_id || '');
    if (!sessionId || !binding.subagentStates.has(sessionId)) return;
    const control = this.ensureSubagentControl(binding, sessionId);
    const status = String(update?.status || '').toLowerCase();
    if (['cancelled', 'canceled'].includes(status)) {
      control.phase = 'cancelled';
      control.error = '';
    } else if (['completed', 'complete'].includes(status)) {
      control.phase = 'completed';
      control.error = '';
    } else if (['failed', 'error'].includes(status)) {
      control.phase = 'error';
      control.error = String(update?.title || 'Subagent failed');
    } else if (
      ['pending', 'in_progress', 'in-progress', 'running'].includes(status)
      && !['cancelling', 'cancelled', 'completed', 'error'].includes(control.phase)
    ) {
      control.phase = 'active';
      control.error = '';
    }
  }

  beginSessionMutation(binding: AcpBinding, action: string) {
    this.requireOpenBinding(binding);
    if (
      binding.sessionMutation
      || binding.configMutationTail
      || binding.patchDecisionInFlight.size > 0
      || binding.activeTurn
      || !['idle', 'error'].includes(binding.state)
    ) {
      throw new Error(`ACP Agent is not ready for ${action} (${binding.state})`);
    }
    const mutation = { action };
    binding.sessionMutation = mutation;
    return mutation;
  }

  endSessionMutation(binding: AcpBinding, mutation: SessionMutation) {
    if (binding.sessionMutation === mutation) binding.sessionMutation = null;
  }

  requireConfigMutationReady(binding: AcpBinding) {
    this.requireOpenBinding(binding);
    if (
      binding.sessionMutation
      || binding.patchDecisionInFlight.size > 0
      || binding.activeTurn
      || !['idle', 'error'].includes(binding.state)
    ) {
      throw new Error(`ACP Agent is not ready for configuration changes (${binding.state})`);
    }
  }

  checkpointIdentity(binding: AcpBinding, sessionId: string = binding?.sessionId) {
    if (!binding || !sessionId) return null;
    return {
      provider: binding.provider,
      providerHomeId: binding.providerHomeId || 'default',
      sessionId,
      cwd: binding.cwd,
    };
  }

  scheduleCheckpoint(binding: AcpBinding, _options: PrepareAgentOptions = {}) {
    if (!this.isOpenBinding(binding)) return;
    const identity = this.checkpointIdentity(binding);
    if (!this.checkpointStore || !identity || !binding.sessionState) return;
    // ACP currently has no conditional resume or provider-owned revision
    // token. A timestamp/list check has a TOCTOU window, so runtime snapshots
    // remain dirty and are used only as revision/reset fences. Full history
    // load is the authoritative recovery path until such a proof is available.
    this.checkpointStore.schedule(identity, this.bindingCheckpoint(binding), { exact: false });
  }

  async markCheckpointDirty(binding: AcpBinding) {
    this.requireOpenBinding(binding);
    const identity = this.checkpointIdentity(binding);
    if (!this.checkpointStore || !identity) return;
    await this.checkpointStore.markDirty(identity);
    this.requireOpenBinding(binding);
  }

  async writeCheckpoint(binding: AcpBinding, _options: PrepareAgentOptions = {}) {
    this.requireOpenBinding(binding);
    const identity = this.checkpointIdentity(binding);
    if (!this.checkpointStore || !identity || !binding.sessionState) return;
    await this.checkpointStore.write(identity, this.bindingCheckpoint(binding), { exact: false });
    this.requireOpenBinding(binding);
  }

  bindingCheckpoint(binding: AcpBinding) {
    return {
      exportCheckpoint: () => ({
        version: 2,
        complete: false,
        sessionState: binding.sessionState?.exportCheckpoint() || null,
        subagentStates: [...binding.subagentStates.entries()].map(([sessionId, state]) => ({
          sessionId,
          state: state.exportCheckpoint(),
        })),
        patchDecisions: [...binding.patchDecisions.entries()],
        providerProof: binding.checkpointProof ? clone(binding.checkpointProof) : null,
      }),
    };
  }

  restoreBindingCheckpoint(binding: AcpBinding, checkpoint: AcpCheckpoint | null, options: PrepareAgentOptions = {}) {
    if (!checkpoint) return null;
    const mainCheckpoint = checkpoint.version === 2
      ? checkpoint.sessionState
      : checkpoint;
    const sessionState = AcpSessionState.fromCheckpoint(mainCheckpoint, {
      provider: binding.provider,
      sessionId: options.sessionId || binding.sessionId,
      cwd: binding.cwd,
      maxUpdates: this.maxUpdates,
    });
    if (!sessionState) return null;
    const subagentStates = new Map();
    if (checkpoint.version === 2 && Array.isArray(checkpoint.subagentStates)) {
      for (const item of checkpoint.subagentStates.slice(0, 32)) {
        const sessionId = String(item?.sessionId || '');
        if (!sessionId) continue;
        const state = AcpSessionState.fromCheckpoint(item?.state, {
          provider: binding.provider,
          sessionId,
          cwd: binding.cwd,
          maxUpdates: this.maxUpdates,
        });
        if (state) subagentStates.set(sessionId, state);
      }
    }
    const patchDecisions = new Map();
    if (checkpoint.version === 2 && Array.isArray(checkpoint.patchDecisions)) {
      for (const item of checkpoint.patchDecisions) {
        if (!Array.isArray(item) || item.length !== 2) continue;
        const key = String(item[0] || '');
        const decision = String(item[1] || '');
        if (key && ['kept', 'reverted'].includes(decision)) patchDecisions.set(key, decision);
      }
    }
    return {
      sessionState,
      subagentStates,
      patchDecisions,
      providerProof: checkpoint.version === 2 ? clone(checkpoint.providerProof) : null,
      complete: checkpoint.version === 2 && checkpoint.complete === true,
    };
  }

  restorePatchDecisions(binding: AcpBinding, decisions: unknown) {
    if (!(decisions instanceof Map) || !binding.sessionState) return;
    for (const [key, decision] of decisions) {
      const separator = key.indexOf('\n');
      if (separator <= 0) continue;
      const toolCallId = key.slice(0, separator);
      const requestedPath = key.slice(separator + 1);
      const entry = binding.sessionState.toolEntries.get(toolCallId);
      if (!entry || binding.sessionState.isInternalEntry(entry)) continue;
      try {
        patchBlock(entry, binding.cwd, requestedPath);
      } catch {
        continue;
      }
      binding.patchDecisions.set(key, decision);
      entry._meta = { ...(entry._meta || {}) };
      entry._meta.farming_patch_decisions = {
        ...(entry._meta.farming_patch_decisions || {}),
        [requestedPath]: decision,
      };
    }
  }

  async checkpointMatchesProviderSession(connection: AcpConnection, capabilities: InitializeResponse['agentCapabilities'] = {}, request: UnknownRecord, saved: SavedCheckpoint) {
    const proof = recordValue(recordValue(saved?.state).providerProof);
    if (
      !capabilities?.sessionCapabilities?.list
      || !proof
      || typeof proof.token !== 'string'
      || !proof.token
    ) return false;
    let cursor = '';
    try {
      for (let page = 0; page < 10; page += 1) {
        const response = await withTimeout(connection.listSessions({
          cwd: request.cwd,
          ...(cursor ? { cursor } : {}),
        }), this.requestTimeoutMs, 'ACP session/list checkpoint validation');
        const session = (response?.sessions || []).find(item => item?.sessionId === request.sessionId);
        if (session) {
          const sessionCwd = path.resolve(String(session.cwd || ''));
          const token = String(session?._meta?.checkpointRevision || session?.checkpointRevision || '');
          return sessionCwd === path.resolve(request.cwd)
            && token === proof.token
            && path.resolve(String(proof.cwd || '')) === path.resolve(request.cwd);
        }
        cursor = String(response?.nextCursor || '');
        if (!cursor) return false;
      }
    } catch (error) {
      console.warn('Failed to validate ACP checkpoint against provider session metadata:', asErrorLike(error).message || error);
    }
    return false;
  }

  async officialConnection(handlers: AcpClientHandlers, child: import('child_process').ChildProcessWithoutNullStreams) {
    const sdk = await loadAcpSdk();
    const stream = sdk.ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout));
    return new sdk.ClientSideConnection(() => handlers as never, stream) as unknown as AcpConnection;
  }

  async waitForHistoryReplay(binding: AcpBinding) {
    const startedAt = Date.now();
    let lastUpdateCount = binding.sessionState?.updates.length || 0;
    let lastChangedAt = startedAt;
    while (Date.now() - startedAt < this.historyReplayMaxWaitMs) {
      await new Promise(resolve => setTimeout(resolve, 50));
      if (!this.isOpenBinding(binding)) return;
      const now = Date.now();
      const updateCount = binding.sessionState?.updates.length || 0;
      if (updateCount !== lastUpdateCount) {
        lastUpdateCount = updateCount;
        lastChangedAt = now;
      }
      if (
        now - startedAt >= this.historyReplayMinWaitMs
        && now - lastChangedAt >= this.historyReplayQuietMs
      ) return;
    }
  }

  clientHandlers(binding: AcpBinding) {
    const openClientRequest = (handler: (request: UnknownRecord) => Promise<unknown> | unknown) => async (request: UnknownRecord) => {
      this.requireOpenBinding(binding);
      if (binding.state === 'closed') throw new Error('ACP session is closed');
      const response = await handler(request);
      this.requireOpenBinding(binding);
      if (binding.state === 'closed') throw new Error('ACP session is closed');
      return response;
    };
    return {
      sessionUpdate: (notification: UnknownRecord) => {
        if (!this.isOpenBinding(binding) || binding.state === 'closed') return;
        const notificationSessionId = String(notification?.sessionId || '');
        const isPrimarySession = !binding.sessionId || !notificationSessionId || notificationSessionId === binding.sessionId;
        let targetState = isPrimarySession ? binding.sessionState : binding.subagentStates.get(notificationSessionId);
        if (!targetState && notificationSessionId && binding.subagentStates.size < 32) {
          targetState = new AcpSessionState({
            provider: binding.provider,
            sessionId: notificationSessionId,
            cwd: binding.cwd,
            maxUpdates: this.maxUpdates,
          });
          binding.subagentStates.set(notificationSessionId, targetState);
        }
        if (!isPrimarySession && targetState) {
          this.ensureSubagentControl(binding, notificationSessionId);
          const parentTool = binding.sessionState?.entries.find((entry: TranscriptEntry) => (
            entry?.type === 'tool'
            && String(entry?._meta?.subagent_session_info?.session_id || '') === notificationSessionId
          ));
          if (parentTool) this.updateSubagentControlFromParent(binding, parentTool);
        }
        if (targetState?.apply(notification)) {
          const update = notification.update as TranscriptEntry | undefined;
          if (isPrimarySession && update) this.updateSubagentControlFromParent(binding, update);
          if (isPrimarySession && update?.sessionUpdate === 'current_mode_update' && binding.modes) {
            binding.modes = { ...binding.modes, currentModeId: String(update.currentModeId || '') };
          }
          if (isPrimarySession && update?.sessionUpdate === 'config_option_update') {
            binding.configOptions = JSON.parse(JSON.stringify(update.configOptions || []));
          }
          if (!isPrimarySession && binding.sessionState) {
            const parentTool = binding.sessionState.entries.find((entry: TranscriptEntry) => (
              entry?.type === 'tool'
              && String(entry?._meta?.subagent_session_info?.session_id || '') === notificationSessionId
            ));
            if (parentTool) binding.sessionState.touchEntry(parentTool);
          }
          binding.updatedAt = new Date().toISOString();
          if (isPrimarySession && !binding.historyReplayActive && !binding.activeTurn) {
            this.scheduleCheckpoint(binding, { exact: true });
          }
          // A loaded history can contain hundreds of ordered updates. Applying
          // them one by one is necessary, but broadcasting every replay step
          // makes clients repeatedly abort/refetch and remount rich content.
          // prepareAgent emits one complete snapshot after the replay settles.
          if (!binding.historyReplayActive) this.emitSession(binding);
        }
      },
      requestPermission: (request: UnknownRecord) => this.requestPermission(binding, request),
      readTextFile: openClientRequest((request: UnknownRecord) => this.clientFileSystem.readTextFile(binding, request)),
      writeTextFile: openClientRequest((request: UnknownRecord) => this.clientFileSystem.writeTextFile(binding, request)),
      createTerminal: openClientRequest((request: UnknownRecord) => this.clientTerminals.create(binding, request)),
      terminalOutput: openClientRequest((request: UnknownRecord) => this.clientTerminals.output(binding, request)),
      waitForTerminalExit: openClientRequest((request: UnknownRecord) => this.clientTerminals.waitForExit(binding, request)),
      killTerminal: openClientRequest((request: UnknownRecord) => this.clientTerminals.kill(binding, request)),
      releaseTerminal: openClientRequest((request: UnknownRecord) => this.clientTerminals.release(binding, request)),
      unstable_createElicitation: (request: UnknownRecord) => this.requestElicitation(binding, request),
      unstable_completeElicitation: (notification: UnknownRecord) => this.completeElicitation(binding, notification),
    };
  }

  requestPermission(binding: AcpBinding, request: UnknownRecord) {
    if (!this.isOpenBinding(binding) || binding.state === 'closed') {
      return { outcome: { outcome: 'cancelled' } };
    }
    const requestSessionId = String(request?.sessionId || '');
    if (
      !requestSessionId
      || (
        requestSessionId !== binding.sessionId
        && !binding.subagentStates.has(requestSessionId)
      )
    ) {
      return { outcome: { outcome: 'cancelled' } };
    }
    const browserTarget = farmingBrowserApprovalTarget(binding, request);
    const browserDecision = browserTarget
      ? this.browserPermissionDecisionFor(binding, browserTarget)
      : null;
    const browserAutomatic = browserDecision
      ? shouldAutoApproveFarmingBrowser(binding, browserDecision)
      : null;
    if (browserAutomatic?.approve) {
      return automaticBrowserPermissionResponse(request);
    }
    const automatic = autoPermissionResponse(request, binding.approvalMode);
    if (automatic) return automatic;
    const requestId = `acp-permission-${crypto.randomUUID()}`;
    binding.interactionOrigins.set(requestId, binding.state);
    binding.state = 'waiting-for-permission';
    const pending = { ...JSON.parse(JSON.stringify(request)), requestId };
    pending.origin = String(request?.sessionId || '') && String(request.sessionId) !== binding.sessionId
      ? 'subagent'
      : 'agent';
    pending.securityWarnings = permissionSecurityWarnings(pending);
    binding.pendingPermissions.set(requestId, pending);
    if (browserAutomatic?.scopeKey) {
      binding.farmingBrowserApprovalScopes.set(requestId, browserAutomatic.scopeKey);
    }
    this.emitRuntime(binding);
    return new Promise(resolve => binding.permissionResolvers.set(requestId, resolve));
  }

  respondPermission(agentId: string, requestId: string, optionId: string, cancelled: boolean = false) {
    const binding = this.requireBinding(agentId);
    const pending = binding.pendingPermissions.get(String(requestId || ''));
    const resolve = binding.permissionResolvers.get(String(requestId || ''));
    if (!pending || pending.requestId !== requestId || !resolve) throw new Error('ACP permission request is no longer pending');
    let response = { outcome: { outcome: 'cancelled' } };
    if (!cancelled) {
      const option = pending.options.find((item: PermissionOption) => item.optionId === optionId);
      if (!option) throw new Error('Unknown ACP permission option');
      response = selectedPermission(option);
      const scopeKey = binding.farmingBrowserApprovalScopes.get(requestId);
      if (option.kind === 'allow_always' && scopeKey) {
        binding.farmingBrowserApprovedSites.add(scopeKey);
      }
    }
    binding.farmingBrowserApprovalScopes.delete(requestId);
    binding.permissionResolvers.delete(requestId);
    binding.pendingPermissions.delete(requestId);
    const origin = binding.interactionOrigins.get(requestId);
    binding.interactionOrigins.delete(requestId);
    binding.state = interactiveRuntimeState(binding, origin);
    resolve(response);
    this.emitRuntime(binding);
    return response;
  }

  requestElicitation(binding: AcpBinding, request: UnknownRecord) {
    if (!this.isOpenBinding(binding) || binding.state === 'closed') return { action: 'cancel' };
    const hasSessionScope = typeof request?.sessionId === 'string' && request.sessionId.length > 0;
    const requestSessionId = hasSessionScope ? String(request.sessionId) : '';
    const isPrimarySession = hasSessionScope && requestSessionId === binding.sessionId;
    const isRequestScoped = !hasSessionScope;
    if (!isRequestScoped && !isPrimarySession && !binding.subagentStates.has(requestSessionId)) {
      throw new Error('ACP elicitation does not match an active session');
    }
    if (!['form', 'url'].includes(String(request?.mode || ''))) {
      return { action: 'cancel' };
    }
    const browserTarget = farmingBrowserApprovalTarget(binding, request);
    const browserDecision = browserTarget
      ? this.browserPermissionDecisionFor(binding, browserTarget)
      : null;
    const browserAutomatic = browserDecision
      ? shouldAutoApproveFarmingBrowser(binding, browserDecision)
      : null;
    if (browserAutomatic?.approve || (browserTarget && binding.approvalMode === 'full')) {
      return automaticBrowserElicitationResponse(request);
    }
    if (browserTarget && binding.approvalMode === 'ask') return { action: 'cancel' };
    const requestId = `acp-elicitation-${crypto.randomUUID()}`;
    const cloned = JSON.parse(JSON.stringify(request));
    const protocolRequestId = Object.prototype.hasOwnProperty.call(cloned, 'requestId')
      ? cloned.requestId
      : undefined;
    delete cloned.requestId;
    const pending = {
      ...cloned,
      ...(protocolRequestId !== undefined ? { protocolRequestId } : {}),
      requestId,
      origin: isRequestScoped ? 'request' : isPrimarySession ? 'agent' : 'subagent',
    };
    binding.interactionOrigins.set(requestId, binding.state);
    binding.pendingElicitations.set(requestId, pending);
    if (browserAutomatic?.scopeKey) {
      binding.farmingBrowserApprovalScopes.set(requestId, browserAutomatic.scopeKey);
    }
    binding.state = 'waiting-for-input';
    this.emitRuntime(binding);
    return new Promise(resolve => binding.elicitationResolvers.set(requestId, resolve));
  }

  respondElicitation(agentId: string, requestId: string, action: string, content: unknown) {
    const binding = this.requireBinding(agentId);
    const id = String(requestId || '');
    const pending = binding.pendingElicitations.get(id);
    const resolve = binding.elicitationResolvers.get(id);
    if (!pending || !resolve) throw new Error('ACP input request is no longer pending');
    const normalizedAction = String(action || 'cancel');
    if (!['accept', 'decline', 'cancel'].includes(normalizedAction)) throw new Error('Unknown ACP input action');
    const response = normalizedAction === 'accept'
      ? { action: 'accept', ...(pending.mode === 'form' ? { content: validateElicitationContent(pending, content) } : {}) }
      : { action: normalizedAction };
    const scopeKey = binding.farmingBrowserApprovalScopes.get(id);
    const persist = String(recordValue(response.content).persist || '');
    if (normalizedAction === 'accept' && scopeKey && ['session', 'always'].includes(persist)) {
      binding.farmingBrowserApprovedSites.add(scopeKey);
    }
    binding.farmingBrowserApprovalScopes.delete(id);
    binding.elicitationResolvers.delete(id);
    binding.pendingElicitations.delete(id);
    if (pending.mode === 'url' && normalizedAction === 'accept') {
      binding.activeElicitations.set(String(pending.elicitationId || id), { ...pending, status: 'accepted' });
    }
    const origin = binding.interactionOrigins.get(id);
    binding.interactionOrigins.delete(id);
    binding.state = interactiveRuntimeState(binding, origin);
    resolve(response);
    this.emitRuntime(binding);
    return response;
  }

  browserPermissionDecisionFor(
    binding: AcpBinding,
    target: { arguments: UnknownRecord; tool: string },
  ) {
    try {
      return this.browserPermissionDecision(binding.agentId, target.tool, target.arguments)
        || defaultBrowserPermissionDecision(target);
    } catch {
      return { requiresApproval: true, scopeKey: '', site: '' };
    }
  }

  completeElicitation(binding: AcpBinding, notification: UnknownRecord) {
    if (!this.isOpenBinding(binding) || binding.state === 'closed') return;
    const elicitationId = String(notification?.elicitationId || '');
    if (elicitationId) binding.activeElicitations.delete(elicitationId);
    this.emitRuntime(binding);
  }

  async submitMessage(agentId: string, prompt: PromptBlock[], options: PrepareAgentOptions = {}) {
    const binding = this.requireBinding(agentId);
    const delivery = options.delivery === 'prompt' || options.delivery === 'steer'
      ? options.delivery
      : 'auto';
    if (delivery === 'steer') {
      this.requireOpenBinding(binding);
      const turn = binding.activeTurn;
      if (
        turn?.phase !== 'running'
        || turn.providerSettled === true
        || binding.provider !== 'codex'
        || binding.supportsSteer !== true
      ) {
        throw new Error('No active Codex turn to steer');
      }
      const result = await this.steer(agentId, prompt);
      options.onSubmitted?.();
      return { steered: true, ...result };
    }
    while (true) {
      this.requireOpenBinding(binding);
      const turn = binding.activeTurn;
      if (turn?.phase === 'blocked') {
        throw new Error(`ACP Agent is not ready (${binding.state})`);
      }
      if (
        delivery === 'auto'
        && turn?.phase === 'running'
        && turn.providerSettled !== true
        && binding.provider === 'codex'
        && binding.supportsSteer === true
      ) {
        try {
          const result = await this.steer(agentId, prompt);
          options.onSubmitted?.();
          return { steered: true, ...result };
        } catch (error) {
          if (!isCodexSteerUnavailableError(error)) throw error;
          this.requireOpenBinding(binding);
        }
      }
      if (binding.activeTurn === turn && turn) {
        await turn.completion;
        continue;
      }
      if (binding.activeTurn) continue;
      return this.prompt(agentId, prompt, options);
    }
  }

  async prompt(agentId: string, prompt: PromptBlock[], options: PrepareAgentOptions = {}) {
    const binding = this.requireBinding(agentId);
    if (
      binding.exited
      || binding.sessionMutation
      || binding.activeTurn
      || !['idle', 'error'].includes(binding.state)
    ) {
      throw new Error(`ACP Agent is not ready (${binding.state})`);
    }
    const rawContent = Array.isArray(prompt) ? prompt : [{ type: 'text', text: String(prompt || '') }];
    const content = promptContentForCapabilities(
      rawContent,
      binding.initializeResponse?.agentCapabilities || {},
    );
    const turn = this.beginTurn(binding);
    try {
      const configMutation = binding.configMutationTail;
      const patchDecisions = [...binding.patchDecisionInFlight.values()].map(item => item.promise);
      await Promise.allSettled([
        ...(configMutation ? [configMutation] : []),
        ...patchDecisions,
      ]);
      if (!this.isCurrentTurn(binding, turn) || turn.phase !== 'admitting') {
        throw new Error('ACP prompt was cancelled before submission');
      }
      await this.markCheckpointDirty(binding);
      if (!this.isCurrentTurn(binding, turn) || turn.phase !== 'admitting') {
        throw new Error('ACP prompt was cancelled before submission');
      }
    } catch (error) {
      if (this.isCurrentTurn(binding, turn)) {
        binding.state = turn.previousState;
        this.finishTurn(binding, turn, { status: 'admission-failed' });
      }
      throw error;
    }
    binding.sessionState.beginPrompt(content);
    turn.phase = 'running';
    binding.state = 'working';
    binding.error = '';
    binding.stopReason = '';
    this.emitRuntime(binding);
    this.emitSession(binding);
    let response;
    try {
      const responsePromise = binding.connection.prompt({ sessionId: binding.sessionId, prompt: content });
      try {
        options.onSubmitted?.();
      } catch {
        // Submission is already owned by the provider; admission callbacks cannot roll it back.
      }
      response = await responsePromise;
      turn.providerSettled = true;
    } catch (error) {
      turn.providerSettled = true;
      const runtimeError = new Error(acpErrorMessage(error), { cause: error });
      if (!this.isCurrentTurn(binding, turn)) throw runtimeError;
      await this.enqueueTurnControl(turn, async () => {
        if (!this.isCurrentTurn(binding, turn)) return;
        binding.stopReason = 'error';
        // JSON-RPC implementations commonly move the actionable provider text
        // into error.data.details. Classify the normalized message so the
        // ordered transcript and runtime snapshot cannot disagree.
        binding.sessionState.recordError(runtimeError.message, acpErrorKind(runtimeError));
        binding.sessionState.completePrompt();
        binding.state = 'error';
        binding.error = runtimeError.message;
        binding.updatedAt = new Date().toISOString();
        this.finishTurn(binding, turn, { status: 'error', error: runtimeError });
        this.scheduleCheckpoint(binding, { exact: true });
        this.emitSession(binding);
        this.emitRuntime(binding);
      });
      throw runtimeError;
    }
    return this.enqueueTurnControl(turn, async () => {
      this.requireCurrentTurn(binding, turn);
      binding.stopReason = String(response?.stopReason || '');
      binding.sessionState.completePrompt();
      binding.state = 'idle';
      binding.error = '';
      binding.updatedAt = new Date().toISOString();
      this.finishTurn(binding, turn, { status: 'completed', stopReason: binding.stopReason });
      this.scheduleCheckpoint(binding, { exact: true });
      this.emitSession(binding);
      this.emitRuntime(binding);
      return { sessionId: binding.sessionId, stopReason: binding.stopReason };
    });
  }

  canSteer(agentId: string) {
    const binding = this.bindings.get(agentId);
    return binding?.provider === 'codex'
      && binding.supportsSteer === true
      && binding.activeTurn?.phase === 'running'
      && binding.activeTurn?.providerSettled !== true
      && Boolean(binding.sessionId)
      && Boolean(binding.connection);
  }

  async steer(agentId: string, prompt: PromptBlock[]) {
    const binding = this.requireBinding(agentId);
    if (binding.provider !== 'codex' || binding.supportsSteer !== true) {
      throw new Error(`${binding.provider} ACP Agent does not support steer`);
    }
    const rawContent = Array.isArray(prompt) ? prompt : [{ type: 'text', text: String(prompt || '') }];
    const content = promptContentForCapabilities(
      rawContent,
      binding.initializeResponse?.agentCapabilities || {},
    );
    const turn = binding.activeTurn;
    this.requireCurrentTurn(binding, turn, ['running']);
    const clientMessageId = `farming-steer-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const operation = async () => {
      this.requireCurrentTurn(binding, turn, ['running']);
      if (turn.providerSettled) throw new Error('No active Codex turn to steer');
      await this.markCheckpointDirty(binding);
      this.requireCurrentTurn(binding, turn, ['running']);
      if (turn.providerSettled) throw new Error('No active Codex turn to steer');
      const insertionIndex = binding.sessionState.entries.length;
      const response = await withTimeout(
        binding.connection.request(CODEX_STEER_METHOD, {
          sessionId: binding.sessionId,
          prompt: content,
          clientMessageId,
        }),
        this.requestTimeoutMs,
        'Codex ACP steer',
      );
      this.requireCurrentTurn(binding, turn, ['running']);
      const turnId = String((response as UnknownRecord | null)?.turnId || '');
      if (binding.sessionState.recordAcceptedSteer(content, {
        messageId: clientMessageId,
        turnId,
        insertionIndex,
      })) {
        this.emitSession(binding);
      }
      return {
        sessionId: binding.sessionId,
        turnId,
        clientMessageId,
      };
    };
    return this.enqueueTurnControl(turn, operation);
  }

  async cancel(agentId: string) {
    const binding = this.requireBinding(agentId);
    this.requireOpenBinding(binding);
    if (binding.state === 'closed') throw new Error('ACP session is closed');
    if (!binding.sessionId) return false;
    const turn = binding.activeTurn;
    if (turn?.phase === 'admitting') {
      this.cancelAdmittingTurn(binding, turn);
      return true;
    }
    if (!turn && (
      binding.sessionMutation
      || binding.configMutationTail
      || binding.patchDecisionInFlight.size > 0
    )) {
      throw new Error(`ACP Agent is not ready for cancellation (${binding.state})`);
    }
    if (turn?.cancelPromise) return turn.cancelPromise;

    const stateBeforeCancellation = binding.state;
    let cancelAcknowledged = false;
    const cancelOperation = async () => {
      const activeSubagentSessionIds = this.activeSubagentSessionIds(binding);
      if (turn) {
        this.requireCurrentTurn(binding, turn, ['running']);
        if (turn.providerSettled) throw new Error('No active turn to cancel');
        turn.phase = 'cancelling';
      }
      binding.state = 'interrupting';
      for (const resolve of binding.permissionResolvers.values()) {
        resolve({ outcome: { outcome: 'cancelled' } });
      }
      for (const resolve of binding.elicitationResolvers.values()) resolve({ action: 'cancel' });
      binding.permissionResolvers.clear();
      binding.pendingPermissions.clear();
      binding.elicitationResolvers.clear();
      binding.pendingElicitations.clear();
      binding.farmingBrowserApprovalScopes.clear();
      binding.activeElicitations.clear();
      binding.interactionOrigins.clear();
      this.emitRuntime(binding);
      await Promise.all([
        withTimeout(
          binding.connection.cancel({ sessionId: binding.sessionId }),
          this.cancelTimeoutMs,
          'ACP session/cancel'
        ),
        ...activeSubagentSessionIds.map((sessionId: string) => this.cancelSubagentControl(binding, sessionId)),
      ]);
      this.requireOpenBinding(binding);
      cancelAcknowledged = true;
      return true;
    };
    const cancellation = (async () => {
      try {
        if (turn) await this.enqueueTurnControl(turn, cancelOperation);
        else await cancelOperation();
        if (!turn) {
          if (binding.state === 'interrupting') {
            binding.state = ['idle', 'error'].includes(stateBeforeCancellation)
              ? stateBeforeCancellation
              : 'idle';
          }
          binding.updatedAt = new Date().toISOString();
          this.emitRuntime(binding);
          return true;
        }
        await withTimeout(turn.completion, this.cancelTimeoutMs, 'ACP turn cancellation');
        return true;
      } catch (error) {
        const runtimeError = new Error(acpErrorMessage(error), { cause: error });
        if (!this.isOpenBinding(binding)) throw runtimeError;
        const markBlocked = () => {
          if (turn && binding.activeTurn !== turn) return;
          if (turn) turn.phase = 'blocked';
          binding.state = 'error';
          binding.error = runtimeError.message;
          binding.stopReason = turn && cancelAcknowledged ? 'cancel_timeout' : 'cancel_error';
          binding.updatedAt = new Date().toISOString();
          this.emitSession(binding);
          this.emitRuntime(binding);
        };
        if (turn) await this.enqueueTurnControl(turn, markBlocked);
        else markBlocked();
        throw runtimeError;
      }
    })();
    if (turn) turn.cancelPromise = cancellation;
    try {
      return await cancellation;
    } finally {
      if (turn?.cancelPromise === cancellation) turn.cancelPromise = null;
    }
  }

  cancelSubagentControl(binding: AcpBinding, targetSessionId: string) {
    const control = this.ensureSubagentControl(binding, targetSessionId);
    if (control.cancelPromise) return control.cancelPromise;
    if (['cancelled', 'completed'].includes(control.phase)) {
      return Promise.resolve({ cancelled: true, sessionId: targetSessionId });
    }
    control.phase = 'cancelling';
    control.error = '';
    for (const [requestId, pending] of binding.pendingPermissions.entries()) {
      if (String(pending?.sessionId || '') !== targetSessionId) continue;
      binding.permissionResolvers.get(requestId)?.({ outcome: { outcome: 'cancelled' } });
      binding.permissionResolvers.delete(requestId);
      binding.pendingPermissions.delete(requestId);
      binding.farmingBrowserApprovalScopes.delete(requestId);
      binding.interactionOrigins.delete(requestId);
    }
    for (const [requestId, pending] of binding.pendingElicitations.entries()) {
      if (String(pending?.sessionId || '') !== targetSessionId) continue;
      binding.elicitationResolvers.get(requestId)?.({ action: 'cancel' });
      binding.elicitationResolvers.delete(requestId);
      binding.pendingElicitations.delete(requestId);
      binding.farmingBrowserApprovalScopes.delete(requestId);
      binding.interactionOrigins.delete(requestId);
    }
    for (const [elicitationId, active] of binding.activeElicitations.entries()) {
      if (String(active?.sessionId || '') === targetSessionId) binding.activeElicitations.delete(elicitationId);
    }
    binding.state = interactiveRuntimeState(binding, binding.state);
    this.emitRuntime(binding);
    const cancellation = (async () => {
      try {
        await withTimeout(
          binding.connection.cancel({ sessionId: targetSessionId }),
          this.cancelTimeoutMs,
          'ACP subagent session/cancel'
        );
        this.requireOpenBinding(binding);
        if (binding.subagentControls.get(targetSessionId) !== control) {
          throw new Error('ACP subagent control is no longer active');
        }
        control.phase = 'cancelled';
        control.error = '';
        binding.updatedAt = new Date().toISOString();
        this.emitSession(binding);
        this.emitRuntime(binding);
        return { cancelled: true, sessionId: targetSessionId };
      } catch (error) {
        if (this.isOpenBinding(binding) && binding.subagentControls.get(targetSessionId) === control) {
          control.phase = 'error';
          control.error = acpErrorMessage(error);
          binding.updatedAt = new Date().toISOString();
          this.emitSession(binding);
          this.emitRuntime(binding);
        }
        throw error;
      }
    })();
    control.cancelPromise = cancellation;
    void cancellation.finally(() => {
      if (binding.subagentControls.get(targetSessionId) === control && control.cancelPromise === cancellation) {
        control.cancelPromise = null;
      }
    }).catch(() => {});
    return cancellation;
  }

  async cancelSubagent(agentId: string, sessionId: string) {
    const binding = this.requireBinding(agentId);
    this.requireOpenBinding(binding);
    const targetSessionId = String(sessionId || '');
    if (!targetSessionId || targetSessionId === binding.sessionId || !binding.subagentStates.has(targetSessionId)) {
      throw new Error('ACP subagent session not found');
    }
    return this.cancelSubagentControl(binding, targetSessionId);
  }

  async listSessions(agentId: string, options: PrepareAgentOptions = {}) {
    const binding = this.requireBinding(agentId);
    this.requireOpenBinding(binding);
    const capabilities = binding.initializeResponse?.agentCapabilities?.sessionCapabilities;
    if (!capabilities?.list) throw new Error(`${binding.provider} ACP Agent does not support session/list`);
    const response = await withTimeout(binding.connection.listSessions({
      ...(options.cwd ? { cwd: path.resolve(options.cwd) } : {}),
      ...(Array.isArray(options.additionalDirectories)
        ? { additionalDirectories: acpSessionRequestOptions(options, options.cwd || binding.cwd).additionalDirectories }
        : {}),
      ...(options.cursor ? { cursor: String(options.cursor) } : {}),
    }), this.requestTimeoutMs, 'ACP session/list');
    this.requireOpenBinding(binding);
    return response;
  }

  getSessionRequestOptions(agentId: string) {
    const binding = this.requireBinding(agentId);
    return clone(binding.sessionRequestOptions);
  }

  async authenticate(agentId: string, methodId: string) {
    const binding = this.requireBinding(agentId);
    this.requireOpenBinding(binding);
    if (binding.state === 'closed') throw new Error('ACP session is closed');
    const mutation = this.beginSessionMutation(binding, 'authentication');
    const method = binding.initializeResponse?.authMethods?.find(
      (item: UnknownRecord & { id?: string }) => item.id === methodId,
    );
    let terminalReservationTransferred = false;
    try {
      if (!method) throw new Error('Unknown ACP authentication method');
      if (
        method.type === 'terminal'
        || recordValue(method._meta).type === 'terminal'
        || recordValue(method._meta)['terminal-auth']
      ) {
        const result = await this.startTerminalAuthentication(binding, method, mutation);
        terminalReservationTransferred = true;
        return result;
      }
      await withTimeout(
        binding.connection.authenticate({ methodId }),
        this.requestTimeoutMs,
        'ACP authenticate'
      );
      this.requireOpenBinding(binding);
      binding.error = '';
      binding.stopReason = '';
      binding.state = interactiveRuntimeState(binding, 'idle');
      binding.updatedAt = new Date().toISOString();
      this.emitRuntime(binding);
      this.emitSession(binding);
      return { authenticated: true, methodId };
    } finally {
      if (!terminalReservationTransferred) this.endSessionMutation(binding, mutation);
    }
  }

  async logout(agentId: string) {
    const binding = this.requireBinding(agentId);
    this.requireOpenBinding(binding);
    const mutation = this.beginSessionMutation(binding, 'logout');
    try {
      if (recordValue(binding.initializeResponse?.agentCapabilities?.auth).logout == null) {
        throw new Error(`${binding.provider} ACP Agent does not support logout`);
      }
      await withTimeout(binding.connection.logout({}), this.requestTimeoutMs, 'ACP logout');
      this.requireOpenBinding(binding);
      binding.error = '';
      binding.stopReason = '';
      binding.updatedAt = new Date().toISOString();
      this.emitRuntime(binding);
      this.emitSession(binding);
      return { loggedOut: true };
    } finally {
      this.endSessionMutation(binding, mutation);
    }
  }

  terminalAuthenticationLaunch(binding: AcpBinding, method: UnknownRecord & { id?: string; type?: string; command?: string; args?: string[] }) {
    const metadata = method._meta && typeof method._meta === 'object' ? method._meta as UnknownRecord : {};
    const legacy = metadata['terminal-auth'] as UnknownRecord | undefined;
    if (legacy && typeof legacy === 'object' && legacy.command) {
      return {
        command: String(legacy.command),
        args: Array.isArray(legacy.args) ? legacy.args.map(String) : [],
        env: legacy.env && typeof legacy.env === 'object' ? legacy.env : {},
      };
    }
    const terminalMethod = method.type === 'terminal'
      ? method
      : metadata.type === 'terminal'
        ? metadata
        : null;
    if (!terminalMethod) throw new Error('ACP authentication method is not terminal based');
    return {
      command: binding.launch.command,
      args: [
        ...binding.launch.args,
        ...(Array.isArray(terminalMethod.args) ? terminalMethod.args.map(String) : []),
      ],
      env: terminalMethod.env && typeof terminalMethod.env === 'object' ? terminalMethod.env : {},
    };
  }

  async startTerminalAuthentication(binding: AcpBinding, method: UnknownRecord & { id?: string; type?: string; command?: string; args?: string[] }, mutation: SessionMutation) {
    this.requireOpenBinding(binding);
    if (binding.sessionMutation !== mutation) throw new Error('ACP authentication reservation is no longer active');
    if (binding.authTerminal?.state === 'running') throw new Error('ACP terminal authentication is already running');
    const launch = this.terminalAuthenticationLaunch(binding, method);
    const created = await this.clientTerminals.create(binding, {
      sessionId: binding.sessionId,
      command: launch.command,
      args: launch.args,
      cwd: binding.cwd,
      env: Object.entries(launch.env).map(([name, value]) => ({ name, value: String(value) })),
      outputByteLimit: 2 * 1024 * 1024,
    });
    try {
      this.requireOpenBinding(binding);
    } catch (error) {
      try {
        this.clientTerminals.release(binding, {
          sessionId: binding.sessionId,
          terminalId: created.terminalId,
        });
      } catch {
        // Binding teardown may already have removed the terminal.
      }
      throw error;
    }
    binding.authTerminal = {
      terminalId: created.terminalId,
      methodId: String(method.id || ''),
      name: String(method.name || 'Sign in'),
      state: 'running',
      error: '',
    };
    binding.updatedAt = new Date().toISOString();
    this.emitRuntime(binding);
    this.emitSession(binding);
    void Promise.resolve(this.clientTerminals.waitForExit(binding, {
      sessionId: binding.sessionId,
      terminalId: created.terminalId,
    })).then(async (exit) => {
      if (!this.isOpenBinding(binding) || binding.sessionMutation !== mutation) return;
      if (exit.exitCode !== 0) {
        binding.authTerminal.state = 'failed';
        binding.authTerminal.error = `Sign-in command exited ${exit.exitCode ?? exit.signal ?? ''}`.trim();
        this.endSessionMutation(binding, mutation);
        binding.updatedAt = new Date().toISOString();
        this.emitRuntime(binding);
        this.emitSession(binding);
        return;
      }
      binding.authTerminal.state = 'completed';
      binding.updatedAt = new Date().toISOString();
      this.emitSession(binding);
      await this.restartAgentConnection(binding.agentId, mutation).catch((error: unknown) => {
        const current = this.bindings.get(binding.agentId);
        if (current !== binding || current.exited) return;
        this.endSessionMutation(current, mutation);
        current.state = 'error';
        current.error = acpErrorMessage(error);
        current.updatedAt = new Date().toISOString();
        this.emitRuntime(current);
      });
    }).catch((error: unknown) => {
      if (!this.isOpenBinding(binding) || binding.sessionMutation !== mutation) return;
      binding.authTerminal.state = 'failed';
      binding.authTerminal.error = acpErrorMessage(error);
      this.endSessionMutation(binding, mutation);
      binding.updatedAt = new Date().toISOString();
      this.emitRuntime(binding);
      this.emitSession(binding);
    });
    return { authenticated: false, methodId: method.id, terminalId: created.terminalId };
  }

  async restartAgentConnection(agentId: string, mutation: SessionMutation | null = null) {
    const binding = this.requireBinding(agentId);
    this.requireOpenBinding(binding);
    if (binding.activeTurn || (binding.sessionMutation && binding.sessionMutation !== mutation)) {
      throw new Error(`ACP Agent is not ready for restart (${binding.state})`);
    }
    if (mutation && binding.sessionMutation !== mutation) {
      throw new Error('ACP restart reservation is no longer active');
    }
    const revisionBase = Number(binding.sessionState?.revision || 0);
    const options = {
      ...binding.restartOptions,
      agentId: binding.agentId,
      provider: binding.provider,
      cwd: binding.cwd,
      env: binding.env,
      approvalMode: binding.approvalMode,
      ...(binding.sessionId ? { sessionId: binding.sessionId } : {}),
      ...(revisionBase > 0 ? { revisionBase } : {}),
      ...(binding.sessionId ? { historyMode: 'checkpoint' } : {}),
    };
    if (binding.sessionState && !binding.activeTurn) {
      await this.writeCheckpoint(binding, { exact: true });
    }
    this.requireOpenBinding(binding);
    await this.unregisterAgentAndWait(agentId, binding);
    return this.prepareAgent(options);
  }

  async forkSession(agentId: string, options: PrepareAgentOptions = {}) {
    return this.runWithForkReservation(agentId, options, async (binding: AcpBinding) => {
      const sessionOptions = acpSessionRequestOptions({
        additionalDirectories: options.additionalDirectories ?? binding.sessionRequestOptions.additionalDirectories,
        mcpServers: options.mcpServers ?? binding.sessionRequestOptions.mcpServers,
      }, options.cwd || binding.cwd);
      const response = await withTimeout(binding.connection.unstable_forkSession({
        sessionId: options.sessionId || binding.sessionId,
        ...sessionOptions,
      }), this.sessionSetupTimeoutMs, 'ACP session/fork');
      this.requireOpenBinding(binding);
      const sessionId = String(response?.sessionId || '').trim();
      if (!isSafeProviderSessionId(sessionId) || sessionId === binding.sessionId) {
        throw new Error('ACP session/fork returned an invalid new session id');
      }
      return { ...response, sessionId };
    });
  }

  async runWithForkReservation<T>(
    agentId: string,
    options: PrepareAgentOptions,
    operation: (binding: AcpBinding) => Promise<T> | T,
  ): Promise<T> {
    const binding = this.requireBinding(agentId);
    const mutation = this.beginSessionMutation(binding, 'fork');
    try {
      const capabilities = binding.initializeResponse?.agentCapabilities?.sessionCapabilities;
      if (!capabilities?.fork) throw new Error(`${binding.provider} ACP Agent does not support session/fork`);
      if (options.requireLoad === true && !binding.initializeResponse?.agentCapabilities?.loadSession) {
        throw new Error(`${binding.provider} ACP Agent cannot load a forked conversation`);
      }
      if (
        typeof options.expectedRevision === 'number'
        && Number.isFinite(options.expectedRevision)
        && Number(binding.sessionState?.revision || 0) !== Math.floor(options.expectedRevision)
      ) {
        throw new Error('ACP conversation changed before it could be forked. Try again from the latest answer.');
      }
      if (typeof operation !== 'function') throw new Error('ACP fork operation is required');
      return await operation(binding);
    } finally {
      this.endSessionMutation(binding, mutation);
    }
  }

  async deleteSession(agentId: string, sessionId: string) {
    const binding = this.requireBinding(agentId);
    const mutation = this.beginSessionMutation(binding, 'session deletion');
    try {
      const capabilities = binding.initializeResponse?.agentCapabilities?.sessionCapabilities;
      if (!capabilities?.delete) throw new Error(`${binding.provider} ACP Agent does not support session/delete`);
      await withTimeout(
        binding.connection.deleteSession({ sessionId: String(sessionId || '') }),
        this.requestTimeoutMs,
        'ACP session/delete'
      );
      this.requireOpenBinding(binding);
      return { deleted: true, sessionId: String(sessionId || '') };
    } finally {
      this.endSessionMutation(binding, mutation);
    }
  }

  async closeSession(agentId: string) {
    const binding = this.requireBinding(agentId);
    const mutation = this.beginSessionMutation(binding, 'session close');
    try {
      const capabilities = binding.initializeResponse?.agentCapabilities?.sessionCapabilities;
      if (!capabilities?.close) throw new Error(`${binding.provider} ACP Agent does not support session/close`);
      await withTimeout(
        binding.connection.closeSession({ sessionId: binding.sessionId }),
        this.requestTimeoutMs,
        'ACP session/close'
      );
      this.requireOpenBinding(binding);
      binding.state = 'closed';
      this.emitRuntime(binding);
      return { closed: true, sessionId: binding.sessionId };
    } finally {
      this.endSessionMutation(binding, mutation);
    }
  }

  async setSessionMode(agentId: string, modeId: string) {
    const binding = this.requireBinding(agentId);
    this.requireConfigMutationReady(binding);
    return this.enqueueSessionConfigMutation(binding, () => (
      this.setSessionModeNow(binding, modeId)
    ));
  }

  async setSessionModeNow(binding: AcpBinding, modeId: string) {
    this.requireOpenBinding(binding);
    await withTimeout(
      binding.connection.setSessionMode({ sessionId: binding.sessionId, modeId: String(modeId || '') }),
      this.requestTimeoutMs,
      'ACP session/set_mode'
    );
    this.requireOpenBinding(binding);
    binding.sessionState.currentModeId = String(modeId || '');
    if (binding.modes) binding.modes = { ...binding.modes, currentModeId: binding.sessionState.currentModeId };
    this.scheduleCheckpoint(binding, { exact: true });
    this.emitSession(binding);
    return { sessionId: binding.sessionId, modeId: binding.sessionState.currentModeId };
  }

  async setSessionConfigOption(agentId: string, configId: string, value: ConfigValue) {
    const binding = this.requireBinding(agentId);
    this.requireConfigMutationReady(binding);
    return this.enqueueSessionConfigMutation(binding, () => (
      this.setSessionConfigOptionNow(binding, configId, value)
    ));
  }

  async setSessionConfigOptionNow(binding: AcpBinding, configId: string, value: ConfigValue) {
    this.requireOpenBinding(binding);
    const option = binding.configOptions?.find(candidate => candidate.id === String(configId || ''));
    if (
      binding.provider === 'codex'
      && option?.type === 'select'
      && /(^|[\s_-])model([\s_-]|$)/i.test(`${option.id} ${option.name || ''} ${option.category || ''}`)
    ) {
      // Let the adapter choose a supported fallback effort from its current
      // snapshot first. The refresh extension requires an explicit effort and
      // would otherwise reject a valid model change (for example ultra -> a
      // model that tops out at max).
      await this.applySessionConfigOption(binding, configId, value, { emit: false });
      const reasoning = binding.configOptions?.find(candidate => (
        candidate.type === 'select'
        && /(reasoning|thought)/i.test(`${candidate.id} ${candidate.name || ''} ${candidate.category || ''}`)
      ));
      if (typeof reasoning?.currentValue === 'string' && reasoning.currentValue) {
        await this.refreshCodexSessionModel(binding, String(value ?? ''), reasoning.currentValue);
        return this.applySessionConfigOption(binding, configId, value, { force: true });
      }
      this.emitSession(binding);
      return { sessionId: binding.sessionId, configOptions: binding.configOptions };
    }
    return this.applySessionConfigOption(binding, configId, value);
  }

  async setSessionConfigOptions(agentId: string, changes: SessionConfigChange[]) {
    const binding = this.requireBinding(agentId);
    this.requireConfigMutationReady(binding);
    return this.enqueueSessionConfigMutation(binding, () => (
      this.setSessionConfigOptionsNow(binding, changes)
    ));
  }

  async setSessionConfigOptionsNow(binding: AcpBinding, changes: SessionConfigChange[]) {
    this.requireOpenBinding(binding);
    const normalized = Array.isArray(changes)
      ? changes.filter(change => change && typeof change.configId === 'string' && Object.prototype.hasOwnProperty.call(change, 'value'))
      : [];
    if (normalized.length === 0) throw new Error('ACP config options are required');

    const originalValues = new Map();
    for (const change of normalized) {
      if (originalValues.has(change.configId)) continue;
      const option = binding.configOptions?.find(candidate => candidate.id === change.configId);
      if (option && Object.prototype.hasOwnProperty.call(option, 'currentValue')) {
        originalValues.set(change.configId, option.currentValue);
      }
    }
    try {
      return await this.applySessionConfigOptionsNow(binding, normalized);
    } catch (error) {
      const rollbackErrors = [];
      for (const [configId, value] of [...originalValues.entries()].reverse()) {
        const current = binding.configOptions?.find(candidate => candidate.id === configId);
        if (current?.currentValue === value) continue;
        try {
          await this.setSessionConfigOptionNow(binding, configId, value);
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
      }
      if (rollbackErrors.length > 0 && error && typeof error === 'object') {
        Object.defineProperty(error, 'configRollbackError', {
          value: new AggregateError(rollbackErrors, 'ACP config rollback failed'),
          enumerable: false,
          configurable: true,
        });
      }
      throw error;
    }
  }

  async applySessionConfigOptionsNow(binding: AcpBinding, normalized: SessionConfigChange[]) {
    const configById = new Map<string, SessionConfigOption>(
      (binding.configOptions || []).map(option => [option.id, option]),
    );
    const modelChange = normalized.find(change => {
      const option = configById.get(change.configId);
      return option?.type === 'select'
        && /(^|[\s_-])model([\s_-]|$)/i.test(`${option.id} ${option.name || ''} ${option.category || ''}`);
    });
    const reasoningChange = normalized.find(change => {
      const option = configById.get(change.configId);
      return option?.type === 'select'
        && /(reasoning|thought)/i.test(`${option.id} ${option.name || ''} ${option.category || ''}`);
    });

    let response;
    const handled = new Set();
    if (binding.provider === 'codex' && modelChange && reasoningChange) {
      await this.applySessionConfigOption(binding, modelChange.configId, modelChange.value, { emit: false });
      await this.applySessionConfigOption(binding, reasoningChange.configId, reasoningChange.value, { emit: false });
      const currentReasoning = binding.configOptions?.find(candidate => (
        candidate.type === 'select'
        && /(reasoning|thought)/i.test(`${candidate.id} ${candidate.name || ''} ${candidate.category || ''}`)
      ));
      await this.refreshCodexSessionModel(
        binding,
        String(modelChange.value ?? ''),
        String(currentReasoning?.currentValue || reasoningChange.value || '')
      );
      response = await this.applySessionConfigOption(binding, modelChange.configId, modelChange.value, { force: true });
      handled.add(modelChange);
      handled.add(reasoningChange);
    }
    for (const change of normalized) {
      if (handled.has(change)) continue;
      response = await this.setSessionConfigOptionNow(binding, change.configId, change.value);
    }
    return response;
  }

  async enqueueSessionConfigMutation<T>(binding: AcpBinding, operation: () => Promise<T> | T): Promise<T> {
    const previous = binding.configMutationTail || Promise.resolve();
    const pending = previous.catch(() => {}).then(operation);
    binding.configMutationTail = pending;
    try {
      return await pending;
    } finally {
      if (binding.configMutationTail === pending) binding.configMutationTail = null;
    }
  }

  async refreshCodexSessionModel(binding: AcpBinding, model: string, effort: string) {
    this.requireOpenBinding(binding);
    await withTimeout(
      binding.connection.request(CODEX_SET_SESSION_MODEL_METHOD, {
        sessionId: binding.sessionId,
        modelId: `${model}[${effort}]`,
      }),
      this.requestTimeoutMs,
      'Codex ACP session/set_model capability refresh'
    );
    this.requireOpenBinding(binding);
  }

  async applySessionConfigOption(binding: AcpBinding, configId: string, value: ConfigValue, options: PrepareAgentOptions = {}) {
    this.requireOpenBinding(binding);
    const normalizedConfigId = String(configId || '');
    const currentOption = binding.configOptions?.find(candidate => candidate.id === normalizedConfigId);
    if (options.force !== true && currentOption?.currentValue === value) {
      if (options.emit !== false) this.emitSession(binding);
      return { sessionId: binding.sessionId, configOptions: binding.configOptions };
    }
    const request = typeof value === 'boolean'
      ? { sessionId: binding.sessionId, configId: normalizedConfigId, type: 'boolean', value }
      : { sessionId: binding.sessionId, configId: normalizedConfigId, value: String(value ?? '') };
    let response;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      response = await withTimeout(
        binding.connection.setSessionConfigOption(request),
        this.requestTimeoutMs,
        'ACP session/set_config_option'
      );
      this.requireOpenBinding(binding);
      binding.configOptions = response?.configOptions || binding.configOptions;
      const confirmed = binding.configOptions?.find(candidate => candidate.id === normalizedConfigId);
      if (confirmed?.currentValue === request.value) break;
      if (attempt === 1) {
        throw new Error(`ACP Agent did not confirm config option ${normalizedConfigId}`);
      }
    }
    binding.sessionState.configOptions = JSON.parse(JSON.stringify(binding.configOptions));
    this.scheduleCheckpoint(binding, { exact: true });
    if (options.emit !== false) this.emitSession(binding);
    return { sessionId: binding.sessionId, configOptions: binding.configOptions };
  }

  getSession(
    agentId: string,
    options: SnapshotOptions = {},
  ): AcpSessionSnapshot {
    const binding = this.requireBinding(agentId);
    const runtimeState = {
      state: binding.state,
      error: binding.error,
      errorKind: binding.error ? acpErrorKind(binding.error) : '',
      stopReason: binding.stopReason,
      supportsSteer: binding.supportsSteer === true,
      supportsFork: Boolean(
        binding.initializeResponse?.agentCapabilities?.sessionCapabilities?.fork != null
        && binding.initializeResponse?.agentCapabilities?.loadSession
      ),
      protocolVersion: binding.initializeResponse?.protocolVersion || null,
      agentInfo: binding.initializeResponse?.agentInfo || null,
      capabilities: binding.initializeResponse?.agentCapabilities || {},
      authMethods: binding.initializeResponse?.authMethods || [],
      modes: binding.modes,
      configOptions: binding.configOptions,
      pendingPermission: binding.pendingPermissions.values().next().value || null,
      pendingPermissions: [...binding.pendingPermissions.values()],
      pendingElicitation: binding.pendingElicitations.values().next().value || null,
      pendingElicitations: [...binding.pendingElicitations.values()],
      activeElicitations: [...binding.activeElicitations.values()],
      adapter: binding.launch,
      authTerminal: binding.authTerminal
        ? { ...binding.authTerminal, terminal: this.clientTerminals.display(binding.authTerminal.terminalId) }
        : null,
      updatedAt: binding.updatedAt,
    };
    if (!binding.sessionState) {
      return {
        version: 1,
        protocol: 'acp',
        provider: binding.provider,
        sessionId: binding.sessionId,
        cwd: binding.cwd,
        title: '',
        truncated: false,
        entries: [],
        usage: null,
        availableCommands: [],
        currentModeId: '',
        ...runtimeState,
      };
    }
    return binding.sessionState.snapshot(runtimeState, options);
  }

  getTranscriptSession(agentId: string, options: TranscriptSliceOptions = {}) {
    const binding = this.requireBinding(agentId);
    const slice = binding.sessionState
      ? binding.sessionState.transcriptSlice(options)
      : { entries: [], revision: 0, delta: false, hasMoreBefore: false };
    return {
      version: 2,
      protocol: 'acp',
      provider: binding.provider,
      sessionId: binding.sessionId,
      cwd: binding.cwd,
      title: binding.sessionState?.title || '',
      updatedAt: binding.updatedAt,
      truncated: binding.sessionState?.truncated === true,
      state: binding.state,
      error: binding.error,
      errorKind: binding.error ? acpErrorKind(binding.error) : '',
      stopReason: binding.stopReason,
      plan: binding.sessionState?.plan == null
        ? null
        : JSON.parse(JSON.stringify(binding.sessionState.plan)),
      ...slice,
    };
  }

  getToolEntry(agentId: string, toolCallId: string) {
    const binding = this.requireBinding(agentId);
    const entry = binding.sessionState?.toolEntries.get(String(toolCallId || ''));
    if (!entry || binding.sessionState.isInternalEntry(entry)) return null;
    const visible = JSON.parse(JSON.stringify(entry));
    visible.content = (Array.isArray(visible.content) ? visible.content : []).map((block: PromptBlock) => {
      if (block?.type !== 'terminal') return block;
      const terminal = this.clientTerminals.display(block.terminalId);
      return terminal ? { ...block, terminal } : block;
    });
    return visible;
  }

  getTranscriptEntry(agentId: string, entryId: string) {
    const binding = this.requireBinding(agentId);
    const entries = (binding.sessionState?.entries || []).filter((candidate: TranscriptEntry) => (
      String(candidate?.id || '') === String(entryId || '')
    ));
    if (entries.length !== 1) return null;
    const [entry] = entries;
    if (!entry || binding.sessionState.isInternalEntry(entry)) return null;
    return entry;
  }

  getPatchDecision(agentId: string, toolCallId: string, requestedPath: string) {
    const binding = this.requireBinding(agentId);
    return binding.patchDecisions.get(`${String(toolCallId || '')}\n${String(requestedPath || '')}`) || '';
  }

  async decidePatch(agentId: string, toolCallId: string, requestedPath: string, decision: 'keep' | 'revert') {
    const binding = this.requireBinding(agentId);
    this.requireOpenBinding(binding);
    if (
      binding.sessionMutation
      || binding.configMutationTail
      || binding.activeTurn
      || !['idle', 'error'].includes(binding.state)
    ) {
      throw new Error('Wait for the Agent to finish before deciding a patch');
    }
    const entry = binding.sessionState?.toolEntries.get(String(toolCallId || ''));
    if (entry && binding.sessionState.isInternalEntry(entry)) throw new Error('ACP tool call not found');
    if (!entry) throw new Error('ACP tool call not found');
    const normalizedDecision = String(decision || '').trim().toLowerCase();
    if (!['keep', 'revert'].includes(normalizedDecision)) throw new Error('ACP patch decision is invalid');
    const key = `${String(toolCallId || '')}\n${String(requestedPath || '')}`;
    const expectedAction = normalizedDecision === 'keep' ? 'kept' : 'reverted';
    const existing = binding.patchDecisionInFlight.get(key);
    if (existing) {
      if (existing.decision !== normalizedDecision) {
        throw new Error('ACP patch file already has a different decision in progress');
      }
      return existing.promise;
    }
    const committed = binding.patchDecisions.get(key);
    if (committed) {
      if (committed !== expectedAction) throw new Error('ACP patch file already has a different decision');
      const operation = (async () => {
        await this.writeCheckpoint(binding, { exact: true });
        return {
          action: committed,
          path: String(requestedPath || ''),
          toolCallId: String(toolCallId || ''),
        };
      })();
      const pending = { decision: normalizedDecision, promise: operation };
      binding.patchDecisionInFlight.set(key, pending);
      try {
        return await operation;
      } finally {
        if (binding.patchDecisionInFlight.get(key) === pending) {
          binding.patchDecisionInFlight.delete(key);
        }
      }
    }
    const operation = (async () => {
      let result = { action: 'kept', path: String(requestedPath || '') };
      if (normalizedDecision === 'revert') {
        result = await rejectPatch({ entry, root: binding.cwd, requestedPath });
        this.requireOpenBinding(binding);
      }
      binding.patchDecisions.set(key, result.action);
      entry._meta = { ...(entry._meta || {}) };
      entry._meta.farming_patch_decisions = {
        ...(entry._meta.farming_patch_decisions || {}),
        [String(requestedPath || '')]: result.action,
      };
      binding.sessionState?.touchEntry(entry);
      binding.updatedAt = new Date().toISOString();
      await this.writeCheckpoint(binding, { exact: true });
      this.emitSession(binding);
      return { ...result, toolCallId: String(toolCallId || '') };
    })();
    const pending = { decision: normalizedDecision, promise: operation };
    binding.patchDecisionInFlight.set(key, pending);
    try {
      return await operation;
    } finally {
      if (binding.patchDecisionInFlight.get(key) === pending) {
        binding.patchDecisionInFlight.delete(key);
      }
    }
  }

  killTerminal(agentId: string, terminalId: string) {
    const binding = this.requireBinding(agentId);
    this.requireOpenBinding(binding);
    this.clientTerminals.kill(binding, {
      sessionId: binding.sessionId,
      terminalId: String(terminalId || ''),
    });
    return { killed: true, terminalId: String(terminalId || '') };
  }

  inputTerminal(agentId: string, terminalId: string, input: string) {
    const binding = this.requireBinding(agentId);
    this.requireOpenBinding(binding);
    return this.clientTerminals.input(binding, {
      sessionId: binding.sessionId,
      terminalId,
      input,
    });
  }

  resizeTerminal(agentId: string, terminalId: string, cols: number, rows: number) {
    const binding = this.requireBinding(agentId);
    this.requireOpenBinding(binding);
    return this.clientTerminals.resize(binding, {
      sessionId: binding.sessionId,
      terminalId,
      cols,
      rows,
    });
  }

  getSubagentTranscriptSession(
    agentId: string,
    sessionId: string,
    options: TranscriptSliceOptions = {},
  ) {
    const binding = this.requireBinding(agentId);
    const id = String(sessionId || '');
    const state = binding.subagentStates.get(id);
    if (!state) return null;
    const parentTool = binding.sessionState?.entries.find((entry: TranscriptEntry) => (
      entry?.type === 'tool'
      && String(entry?._meta?.subagent_session_info?.session_id || '') === id
    ));
    const status = String(parentTool?.status || '').toLowerCase();
    const pendingPermission = [...binding.pendingPermissions.values()]
      .some((request: UnknownRecord) => String(request?.sessionId || '') === id);
    const pendingElicitation = [...binding.pendingElicitations.values()]
      .some((request: UnknownRecord) => String(request?.sessionId || '') === id);
    const control = this.ensureSubagentControl(binding, id);
    const active = ['pending', 'in_progress', 'in-progress', 'running'].includes(status);
    const failed = ['failed', 'error'].includes(status);
    const stateName = pendingPermission
      ? 'waiting-for-permission'
      : pendingElicitation
        ? 'waiting-for-input'
        : control.phase === 'cancelling'
          ? 'interrupting'
          : control.phase === 'error'
            ? 'error'
            : ['cancelled', 'completed'].includes(control.phase)
              ? 'idle'
              : active
                ? 'working'
                : failed
                  ? 'error'
                  : 'idle';
    const controlFailed = control.phase === 'error';
    const cancelled = control.phase === 'cancelled';
    return {
      version: 2,
      protocol: 'acp',
      provider: binding.provider,
      sessionId: id,
      cwd: binding.cwd,
      title: state.title || '',
      updatedAt: binding.updatedAt,
      truncated: state.truncated === true,
      state: stateName,
      error: controlFailed ? control.error : failed ? String(parentTool?.title || 'Subagent failed') : '',
      errorKind: controlFailed || failed ? 'agent' : '',
      stopReason: controlFailed || failed ? 'error' : cancelled ? 'cancelled' : active ? '' : 'end_turn',
      ...state.transcriptSlice(options),
    };
  }

  hasBinding(agentId: string) {
    return this.bindings.has(agentId);
  }

  requireBinding(agentId: string) {
    const binding = this.bindings.get(agentId);
    if (!binding) throw new Error('ACP Agent is not registered');
    return binding;
  }

  emitRuntime(binding: AcpBinding) {
    if (!this.isCurrentBinding(binding)) return false;
    this.emit('agent-runtime', {
      agentId: binding.agentId,
      provider: binding.provider,
      sessionId: binding.sessionId,
      state: binding.state,
      error: binding.error,
      errorKind: binding.error ? acpErrorKind(binding.error) : '',
      stopReason: binding.stopReason,
      supportsSteer: binding.supportsSteer === true,
      supportsFork: Boolean(
        binding.initializeResponse?.agentCapabilities?.sessionCapabilities?.fork != null
        && binding.initializeResponse?.agentCapabilities?.loadSession
      ),
      pendingPermission: binding.pendingPermissions.values().next().value || null,
      pendingPermissions: [...binding.pendingPermissions.values()],
      pendingElicitation: binding.pendingElicitations.values().next().value || null,
      pendingElicitations: [...binding.pendingElicitations.values()],
      activeElicitations: [...binding.activeElicitations.values()],
      updatedAt: binding.updatedAt,
    });
    return true;
  }

  emitSession(binding: AcpBinding) {
    if (!this.isCurrentBinding(binding)) return false;
    this.emit('session', {
      agentId: binding.agentId,
      updatedAt: binding.updatedAt,
      revision: binding.sessionState?.revision || 0,
      title: binding.sessionState?.title || '',
    });
    return true;
  }

  handleExit(binding: AcpBinding, error: unknown) {
    if (!this.isCurrentBinding(binding) || binding.exited) return;
    binding.exited = true;
    const turn = binding.activeTurn;
    const promptWasActive = Boolean(turn && turn.phase !== 'admitting');
    binding.activeTurn = null;
    if (error) {
      binding.state = 'error';
      binding.error = acpErrorMessage(error);
      binding.stopReason = 'error';
    } else if (binding.state !== 'error') {
      binding.state = 'stopped';
      binding.stopReason = promptWasActive ? 'stopped' : binding.stopReason;
    }
    if (promptWasActive && binding.sessionState) {
      if (error) binding.sessionState.recordError(binding.error, acpErrorKind(error));
      binding.sessionState.completePrompt();
    }
    if (turn) {
      turn.phase = 'completed';
      turn.resolveCompletion?.({ status: 'connection-closed', error: error || null });
    }
    for (const resolve of binding.permissionResolvers.values()) {
      resolve({ outcome: { outcome: 'cancelled' } });
    }
    for (const resolve of binding.elicitationResolvers.values()) resolve({ action: 'cancel' });
    binding.permissionResolvers.clear();
    binding.pendingPermissions.clear();
    binding.elicitationResolvers.clear();
    binding.pendingElicitations.clear();
    binding.farmingBrowserApprovalScopes.clear();
    binding.activeElicitations.clear();
    binding.interactionOrigins.clear();
    binding.subagentStates.clear();
    binding.subagentControls.clear();
    this.clientTerminals.cleanupAgent(binding.agentId);
    if (promptWasActive) this.emitSession(binding);
    this.emitRuntime(binding);
  }

  detachAgentBinding(binding: AcpBinding, options: PrepareAgentOptions = {}) {
    if (!binding || this.bindings.get(binding.agentId) !== binding) return false;
    if (binding.sessionState && !binding.activeTurn) this.scheduleCheckpoint(binding, { exact: true });
    if (options.retainForCleanup !== true) this.bindings.delete(binding.agentId);
    binding.exited = true;
    const turn = binding.activeTurn;
    binding.activeTurn = null;
    if (turn) {
      turn.phase = 'completed';
      turn.resolveCompletion?.({ status: 'binding-detached' });
    }
    for (const resolve of binding.permissionResolvers.values()) resolve({ outcome: { outcome: 'cancelled' } });
    for (const resolve of binding.elicitationResolvers.values()) resolve({ action: 'cancel' });
    binding.permissionResolvers.clear();
    binding.pendingPermissions.clear();
    binding.elicitationResolvers.clear();
    binding.pendingElicitations.clear();
    binding.farmingBrowserApprovalScopes.clear();
    binding.activeElicitations.clear();
    binding.interactionOrigins.clear();
    binding.subagentStates.clear();
    binding.subagentControls.clear();
    this.clientTerminals.cleanupAgent(binding.agentId);
    try {
      binding.connection?.close();
    } catch {
      // Process cleanup below remains authoritative if transport cleanup races.
    }
    if (binding.child?.stdin?.writable && !binding.child.stdin.destroyed) {
      try {
        binding.child.stdin.end();
      } catch {
        // Process cleanup below remains authoritative if stdin already closed.
      }
    }
    return true;
  }

  unregisterAgent(agentId: string, expectedBinding: AcpBinding | null = null) {
    const binding = this.bindings.get(agentId);
    if (expectedBinding && binding !== expectedBinding) return;
    if (!binding || !this.detachAgentBinding(binding)) return;
    signalProcessTree(binding, 'SIGTERM');
  }

  async unregisterAgentAndWait(agentId: string, expectedBinding: AcpBinding | null = null) {
    const binding = this.bindings.get(agentId);
    if (expectedBinding && binding !== expectedBinding) return false;
    if (!binding || !this.detachAgentBinding(binding, { retainForCleanup: true })) return false;
    await stopBindingProcessAndWait(binding);
    if (this.bindings.get(agentId) === binding) this.bindings.delete(agentId);
    return true;
  }

  dispose() {
    if (this.disposed) return Promise.resolve();
    if (this.disposePromise) return this.disposePromise;

    this.disposing = true;
    const disposePromise = this.performDispose();
    this.disposePromise = disposePromise;
    void disposePromise.finally(() => {
      if (this.disposePromise === disposePromise) this.disposePromise = null;
      if (!this.disposed) this.disposing = false;
    }).catch(() => {});
    return disposePromise;
  }

  resumeAfterDisposeAbort() {
    this.disposed = false;
    this.disposing = false;
  }

  async performDispose() {
    for (const binding of this.bindings.values()) {
      if (binding.sessionState && !binding.activeTurn) this.scheduleCheckpoint(binding, { exact: true });
    }
    if (this.checkpointStore) await this.checkpointStore.flush();
    const failures = [];
    for (const agentId of [...this.bindings.keys()]) {
      try {
        await this.unregisterAgentAndWait(agentId);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, 'One or more ACP Agent process trees did not exit');
    }
    if (this.checkpointStore) await this.checkpointStore.dispose();
    this.disposed = true;
  }
}

export {
  AcpRuntime,
  ADAPTER_VERSIONS,
  acpSessionRequestOptions,
  acpErrorKind,
  autoPermissionResponse,
  codexAcpEnvironment,
  describeAcpProcessGroup,
  promptContentForCapabilities,
  resolveAcpLaunch,
  stopPersistedAcpProcessGroup,
  supportsCodexSteer,
  isCodexSteerUnavailableError,
  CODEX_STEER_METHOD,
  deleteProviderSessionIdentity,
};
