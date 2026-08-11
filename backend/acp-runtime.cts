import { EventEmitter } from 'events';
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, spawn } = require('child_process');
const { Readable, Writable } = require('stream');
const { createRequire } = require('module');
const { pathToFileURL } = require('url');
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
import { isSameOrDescendantPath } from './path-containment.cjs';
import { PACKAGED_CODEX_ACP_ARG } from './acp/packaged-codex-acp.cjs';
import { PACKAGED_CLAUDE_ACP_ARG } from './acp/packaged-claude-acp.cjs';
import { permissionSecurityWarnings } from './acp/permission-security.cjs';
import { patchBlock, rejectPatch } from './acp/patch-decisions.cjs';
import {
  getProviderAdapter,
  listProviderAdapters,
  normalizeProviderAcpExtensionNotification,
  providerSessionIdentityRollbackArgs,
  providerSupportsSharedAcpRuntime,
} from './provider-adapters.cjs';
import { isSafeProviderSessionId } from './provider-session-id.cjs';
import { configInstanceFingerprint as fingerprintConfigInstance } from './config-instance.cjs';
import {
  registerConfigProcessGroup,
  unregisterConfigProcessGroup,
} from './config-process-ownership.cjs';
import { readServerProcessIdentity } from './server-process-identity.cjs';
import {
  consumeCodexInlineVisualizationStream,
  createCodexInlineVisualizationStreamState,
  stripCodexInternalContextBlocks,
} from './codex-transcript-sanitizer.cjs';
import type { ProviderSessionIdentityResult } from './agent-manager-provider-types.js';

type UnknownRecord = Record<string, unknown>;
type PromptBlock = UnknownRecord & { type?: string; text?: string; path?: string };
type ConfigValue = string | number | boolean | null | string[];

interface ErrorLike {
  message?: string;
  code?: string | number;
  data?: { code?: string | number; details?: string };
  cause?: ErrorLike;
  adapterCleanupError?: ErrorLike;
  runtimeCleanupVerified?: boolean;
}
type AcpSdk = typeof import('@agentclientprotocol/sdk');
type AcpSingleRequestHandler = (request: UnknownRecord) => unknown;
type AcpExtensionNotificationHandler = (method: string, params: UnknownRecord) => unknown;
interface AcpClientHandlers {
  sessionUpdate: AcpSingleRequestHandler;
  extNotification: AcpExtensionNotificationHandler;
  requestPermission: AcpSingleRequestHandler;
  readTextFile: AcpSingleRequestHandler;
  writeTextFile: AcpSingleRequestHandler;
  createTerminal: AcpSingleRequestHandler;
  terminalOutput: AcpSingleRequestHandler;
  waitForTerminalExit: AcpSingleRequestHandler;
  killTerminal: AcpSingleRequestHandler;
  releaseTerminal: AcpSingleRequestHandler;
  unstable_createElicitation: AcpSingleRequestHandler;
  unstable_completeElicitation: AcpSingleRequestHandler;
}
type AcpSingleRequestHandlerName = Exclude<keyof AcpClientHandlers, 'extNotification'>;

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
  deferredConfigChanges?: unknown;
  deferredModeId?: unknown;
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
  _meta?: UnknownRecord & {
    steering?: UnknownRecord & { supported?: boolean };
  };
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
  agentId: string; provider: string; providerHomeId: string; providerHomePath: string;
  providerHomeIdentity: string; projectPath: string; cwd: string;
  capabilityRuntimeEpoch: string;
  sessionRequestOptions: AcpSessionRequestOptions; env: NodeJS.ProcessEnv; launch: AcpLaunch;
  restartOptions: PrepareAgentOptions; approvalMode: string; ownsProcessGroup: boolean;
  runtime: AcpRuntimeProcess | null;
  child: import('child_process').ChildProcessWithoutNullStreams | null;
  connection: AcpConnection; initializeResponse: InitializeResponse;
  sessionId: string; untrustedSessionId: string; state: string; error: string; stopReason: string;
  modes: SessionResponse['modes'] | null; configOptions: SessionConfigOption[];
  configOverrideWarnings: AcpConfigOverrideWarning[];
  pendingPermissions: Map<string, PermissionRequest>; permissionResolvers: Map<string, (value: unknown) => void>;
  pendingElicitations: Map<string, ElicitationRequest>; elicitationResolvers: Map<string, (value: unknown) => void>;
  activeElicitations: Map<string, ElicitationRequest>; subagentStates: Map<string, AcpSessionState>;
  subagentControls: Map<string, SubagentControl>; nextSubagentGeneration: number;
  ownedSessionKeys: Map<string, string>;
  interactionOrigins: Map<string, string>; activeTurn: AcpTurn | null; nextTurnId: number;
  supportsSteer: boolean; historyReplayActive: boolean; sessionState: AcpSessionState;
  transcriptProjectionRevision: number;
  authTerminal: UnknownRecord; patchDecisions: Map<string, string>;
  patchDecisionInFlight: Map<string, { decision: string; promise: Promise<unknown> }>;
  checkpointProof: unknown; sessionMutation: SessionMutation | null; configMutationTail: Promise<unknown> | null;
  deferredConfigChanges: Map<string, SessionConfigChange>;
  deferredConfigFlush: Promise<void> | null;
  deferredModeGeneration: number;
  deferredModeId: string;
  codexInlineVisualizationStreams: Map<string, ReturnType<typeof createCodexInlineVisualizationStreamState>>;
  stderr: string; exited: boolean; retryableReconnect: boolean; updatedAt: string;
}
interface AcpProcessOwner {
  ownsProcessGroup: boolean;
  child: import('child_process').ChildProcessWithoutNullStreams | null;
}
interface AcpRuntimeProcess extends AcpProcessOwner {
  key: string;
  shared: boolean;
  provider: string;
  providerHomePath: string;
  projectPath: string;
  launch: AcpLaunch;
  env: NodeJS.ProcessEnv;
  connection: AcpConnection;
  initializeResponse: InitializeResponse;
  processIdentity: ProcessIdentity | null;
  bindings: Map<string, AcpBinding>;
  handlers: Map<string, AcpClientHandlers>;
  sessionOwners: Map<string, AcpBinding>;
  openingBinding: AcpBinding | null;
  openTail: Promise<unknown>;
  stderr: string;
  exited: boolean;
  stopping: boolean;
}
interface AcpConfigOverrideWarning {
  configId: string;
  message: string;
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
  stopProcessAndWait?: (owner: AcpProcessOwner) => Promise<void>;
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
}
interface PrepareAgentOptions extends UnknownRecord {
  agentId?: string; provider?: string; providerHomeId?: string; providerHomePath?: string;
  projectWorkspace?: string; cwd?: string; sessionId?: string;
  capabilityRuntimeEpoch?: string;
  forkSourceSessionId?: string; forkSourceCheckpoint?: UnknownRecord | null; revisionBase?: number;
  approvalMode?: string; historyMode?: string; model?: string; reasoningEffort?: string;
  serviceTier?: string; identityOnly?: boolean;
  configOverrides?: SessionConfigChange[];
  executable?: string; env?: NodeJS.ProcessEnv; runtimeEnv?: NodeJS.ProcessEnv;
  additionalDirectories?: string[]; mcpServers?: UnknownRecord[]; farmingSystemPrompt?: string;
  requireLoad?: boolean; expectedRevision?: number; retainForCleanup?: boolean;
  onProcessStarted?: (identity: ProcessIdentity) => Promise<void> | void;
  onForkSessionCreated?: (sessionId: string) => Promise<void> | void;
  refreshMcpServersForRuntime?: (
    mcpServers: UnknownRecord[],
  ) => Promise<{ capabilityRuntimeEpoch: string; mcpServers: UnknownRecord[] }>
    | { capabilityRuntimeEpoch: string; mcpServers: UnknownRecord[] };
  onTurnAdmitted?: (admission?: { previousState: string }) => Promise<void> | void;
  onTurnSettled?: (settlement: { stopReason: string }) => Promise<void> | void;
  onSubmitted?: (submission?: { steered: boolean }) => Promise<void> | void; delivery?: string;
}
interface ProcessIdentity {
  pid: number;
  processGroupId: number;
  startedAt: string;
  configInstanceFingerprint?: string;
}
interface ProviderAdapterLike { id: string; acp?: { version: string } }
interface PersistedProcessIdentity {
  pid?: number;
  processGroupId?: number;
  startedAt?: string;
  configInstanceFingerprint?: string;
}
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
const SESSION_STEERING_METHOD = '_session/steering';
const CODEX_ACP_PACKAGE = '@agentclientprotocol/codex-acp';
const CODEX_ACP_VERSION = '1.1.14';
const CODEX_ACP_SHA256 = 'd6236cac607691766cec3c064a8d80daaa923ed527219aa5314dc488e37a52e2';
const CLAUDE_ACP_PACKAGE = '@agentclientprotocol/claude-agent-acp';
const CLAUDE_ACP_VERSION = '0.66.0';
const CLAUDE_ACP_SHA256 = '33e2379f1ed9e502f3442a19a0d575c2c6df912080db7fea197289e55b3fae2f';
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

function normalizeSessionConfigChanges(value: unknown): SessionConfigChange[] {
  const changes = new Map<string, SessionConfigChange>();
  for (const item of Array.isArray(value) ? value.slice(0, 64) : []) {
    if (!item || typeof item !== 'object' || typeof item.configId !== 'string') continue;
    const configId = item.configId;
    if (!configId.trim() || configId.length > 256) continue;
    const configValue = item.value;
    if (
      configValue !== null
      && !['string', 'number', 'boolean'].includes(typeof configValue)
      && !(Array.isArray(configValue) && configValue.every(entry => typeof entry === 'string'))
    ) continue;
    changes.set(configId, {
      configId,
      value: Array.isArray(configValue) ? [...configValue] : configValue as ConfigValue,
    });
  }
  return [...changes.values()];
}

function sessionConfigSelectValues(option: SessionConfigOption): string[] {
  if (option.type !== 'select') return [];
  return (Array.isArray(option.options) ? option.options : []).flatMap(entry => {
    const groupOptions = entry && typeof entry === 'object' && Array.isArray((entry as UnknownRecord).options)
      ? (entry as UnknownRecord).options as unknown[]
      : null;
    const candidates = groupOptions || [entry];
    return candidates.flatMap(candidate => (
      candidate && typeof candidate === 'object' && typeof (candidate as UnknownRecord).value === 'string'
        ? [String((candidate as UnknownRecord).value)]
        : []
    ));
  });
}

function sameSessionConfigChanges(left: SessionConfigChange[], right: SessionConfigChange[]) {
  return JSON.stringify(normalizeSessionConfigChanges(left)) === JSON.stringify(normalizeSessionConfigChanges(right));
}

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

function isStructuredReconnectableFailure(binding: AcpBinding, error: unknown) {
  if (binding.connection?.signal?.aborted === true) return true;
  const failure = asErrorLike(error);
  const code = String(failure.code || failure.data?.code || '').toUpperCase();
  return new Set([
    'ACP_TRANSPORT_CLOSED',
    'ECONNABORTED',
    'ECONNRESET',
    'EPIPE',
    'ERR_STREAM_PREMATURE_CLOSE',
  ]).has(code);
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

function recordValue(value: unknown): UnknownRecord {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : {};
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

const ACP_SESSION_ENV_KEYS = [
  'FARMING_AGENT_ID',
  'FARMING_CAPABILITIES_COMMAND',
  'FARMING_CLI_BIN_DIR',
  'FARMING_CONFIG_DIR',
  'FARMING_CONTROL_URL',
  'FARMING_DISABLE_AUTH',
  'FARMING_IS_MAIN_AGENT',
  'FARMING_MAIN_WORKSPACE',
  'FARMING_PARENT_AGENT_ID',
  'FARMING_PROJECT_WORKSPACE',
  'FARMING_SKILLS_COMMAND',
  'FARMING_SKILLS_FILE',
  'FARMING_STARTUP_PROMPT_FILE',
  'FARMING_TOKEN_FILE',
] as const;

const ACP_SHARED_PROCESS_EXCLUDED_ENV_KEYS = [
  'FARMING_AGENT_ID',
  'FARMING_AGENT_TITLE_TOKEN',
  'FARMING_BROWSER_TOKEN',
  'FARMING_CAPABILITY_RUNTIME_EPOCH',
  'FARMING_COMPUTER_TOKEN',
  'FARMING_IS_MAIN_AGENT',
  'FARMING_MAIN_WORKSPACE',
  'FARMING_PARENT_AGENT_ID',
  'FARMING_PROJECT_WORKSPACE',
  'FARMING_SKILLS_FILE',
] as const;

function acpSessionEnvironment(env: NodeJS.ProcessEnv = {}) {
  return Object.fromEntries(ACP_SESSION_ENV_KEYS.flatMap(key => (
    typeof env[key] === 'string' ? [[key, String(env[key])]] : []
  )));
}

function canonicalAcpHomePath(provider: string, options: PrepareAgentOptions, env: NodeJS.ProcessEnv) {
  const adapter = getProviderAdapter(provider);
  const configured = String(
    options.providerHomePath
    || (adapter?.homeEnvKey ? env[adapter.homeEnvKey] : '')
    || '',
  ).trim();
  if (!configured) return '';
  const resolved = path.resolve(configured);
  let canonical = resolved;
  try {
    canonical = fs.realpathSync.native(resolved);
  } catch {
    // The binding must enter connecting synchronously. Its owned startup path
    // creates and canonicalizes a missing Home before acquiring a process.
  }
  return process.platform === 'win32' ? canonical.toLowerCase() : canonical;
}

async function prepareAcpHomePath(provider: string, configured: string) {
  if (!configured) return '';
  try {
    await fs.promises.mkdir(configured, { recursive: true, mode: 0o700 });
    const canonical = await fs.promises.realpath(configured);
    return process.platform === 'win32' ? canonical.toLowerCase() : canonical;
  } catch (caught) {
    throw new Error(
      `Failed to prepare ${provider} Agent Home ${configured}: ${caught instanceof Error ? caught.message : caught}`,
      { cause: caught },
    );
  }
}

async function canonicalAcpProjectPath(options: PrepareAgentOptions, cwd: string) {
  const configured = String(options.projectWorkspace || cwd || '').trim();
  const resolved = path.resolve(configured || process.cwd());
  let canonical = resolved;
  try {
    canonical = await fs.promises.realpath(resolved);
  } catch {
    // The owning Project workspace is validated by Agent Manager. Preserve a
    // stable resolved identity for direct runtime callers and recovery races.
  }
  return process.platform === 'win32' ? canonical.toLowerCase() : canonical;
}

function sharedAcpProcessEnvironment(
  provider: string,
  options: PrepareAgentOptions,
) {
  const env = { ...(options.env || process.env) };
  for (const key of ACP_SHARED_PROCESS_EXCLUDED_ENV_KEYS) delete env[key];
  delete env.INITIAL_AGENT_MODE;
  const prepare = getProviderAdapter(provider)?.prepareAcpEnvironment;
  return prepare
    ? prepare({
        env,
        executable: options.executable,
        farmingSystemPrompt: options.farmingSystemPrompt,
      })
    : env;
}

function providerAcpConfigPolicy(provider: string) {
  return getProviderAdapter(provider)?.acp.config;
}

function providerAcpHistoryReplayPolicy(provider: string) {
  return getProviderAdapter(provider)?.acp.historyReplay;
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
  const sessionEnv = acpSessionEnvironment(options.env);
  if (Object.keys(sessionEnv).length > 0) {
    result._meta = { farming: { env: sessionEnv } };
  }
  const farmingSystemPrompt = typeof options.farmingSystemPrompt === 'string'
    ? options.farmingSystemPrompt.trim()
    : '';
  const providerMetadata = getProviderAdapter(options.provider)?.acp.sessionMetadata?.({
    farmingSystemPrompt,
    sessionEnv,
  });
  if (providerMetadata && Object.keys(providerMetadata).length > 0) {
    result._meta = {
      ...(result._meta || {}),
      ...providerMetadata,
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

const MAX_CODEX_INLINE_VISUALIZATION_BYTES = 2 * 1024 * 1024;
const trustedInlineVisualizationNotifications = new WeakSet<object>();

function codexVisualizationThreadDirectory(binding: Pick<AcpBinding, 'env' | 'sessionId' | 'sessionRequestOptions'>, sessionId: string) {
  const codexHome = path.resolve(String(binding.env?.CODEX_HOME || path.join(os.homedir(), '.codex')));
  const visualizationsDirectory = path.join(codexHome, 'visualizations');
  const threadId = String(sessionId || binding.sessionId || '');
  const uuid = threadId.match(/^([0-9a-f]{8})-([0-9a-f]{4})-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  if (!uuid) return { threadDirectory: '', visualizationsDirectory };
  const grantedThreadDirectories = (binding.sessionRequestOptions?.additionalDirectories || [])
    .map(directory => path.resolve(String(directory || '')))
    .filter(directory => {
      const relative = path.relative(visualizationsDirectory, directory);
      const parts = relative.split(path.sep);
      return isSameOrDescendantPath(visualizationsDirectory, directory)
        && parts.length === 4 && parts[3] === threadId;
    });
  if (grantedThreadDirectories.length === 1) {
    return { threadDirectory: grantedThreadDirectories[0], visualizationsDirectory };
  }
  const timestamp = Number.parseInt(`${uuid[1]}${uuid[2]}`, 16);
  const createdAt = new Date(timestamp);
  if (!Number.isFinite(createdAt.getTime())) return { threadDirectory: '', visualizationsDirectory };
  const year = String(createdAt.getUTCFullYear()).padStart(4, '0');
  const month = String(createdAt.getUTCMonth() + 1).padStart(2, '0');
  const day = String(createdAt.getUTCDate()).padStart(2, '0');
  return {
    threadDirectory: path.join(visualizationsDirectory, year, month, day, threadId),
    visualizationsDirectory,
  };
}

async function resolveCodexInlineVisualization(binding: AcpBinding, sessionId: string, requestedFile: string) {
  const file = String(requestedFile || '').trim();
  if (!file || path.basename(file) !== file || path.extname(file) !== '.html') return '';
  const { threadDirectory, visualizationsDirectory } = codexVisualizationThreadDirectory(binding, sessionId);
  if (!threadDirectory) return '';
  try {
    const [canonicalVisualizations, canonicalThread] = await Promise.all([
      fs.promises.realpath(visualizationsDirectory),
      fs.promises.realpath(threadDirectory),
    ]);
    if (!canonicalThread.startsWith(`${canonicalVisualizations}${path.sep}`)) return '';
    const candidate = await fs.promises.realpath(path.join(canonicalThread, file));
    if (!candidate.startsWith(`${canonicalThread}${path.sep}`)) return '';
    const metadata = await fs.promises.stat(candidate);
    if (!metadata.isFile() || metadata.size > MAX_CODEX_INLINE_VISUALIZATION_BYTES) return '';
    const source = await fs.promises.readFile(candidate);
    new TextDecoder('utf-8', { fatal: true }).decode(source);
    return candidate;
  } catch {
    return '';
  }
}

async function normalizeCodexHostMessageUpdate(binding: AcpBinding, notification: UnknownRecord) {
  const update = notification.update as UnknownRecord | undefined;
  const content = update?.content as UnknownRecord | undefined;
  if (update?.sessionUpdate !== 'agent_message_chunk' || content?.type !== 'text') {
    return [notification];
  }
  const messageId = String(update.messageId || '');
  const streamKey = `${String(notification.sessionId || binding.sessionId)}\0${messageId}`;
  const streaming = binding.codexInlineVisualizationStreams instanceof Map && Boolean(messageId);
  const stream = streaming
    ? binding.codexInlineVisualizationStreams.get(streamKey) || createCodexInlineVisualizationStreamState()
    : createCodexInlineVisualizationStreamState();
  if (streaming) binding.codexInlineVisualizationStreams.set(streamKey, stream);
  const consumed = consumeCodexInlineVisualizationStream(stream, content.text, !streaming);
  const directives = consumed.directives;
  const normalized: UnknownRecord[] = [];
  const visibleText = streaming ? consumed.text : stripCodexInternalContextBlocks(consumed.text);
  if (visibleText) {
    normalized.push({ ...notification, update: { ...update, content: { ...content, text: visibleText } } });
  }
  for (const directive of directives.slice(0, 8)) {
    const resolved = await resolveCodexInlineVisualization(binding, String(notification.sessionId || ''), directive.file);
    const normalizedNotification = {
      ...notification,
      update: {
        ...update,
        content: {
          type: 'resource_link',
          name: directive.file,
          uri: resolved ? pathToFileURL(resolved).toString() : `farming-unavailable:${directive.file}`,
          mimeType: 'text/html',
          _meta: {
            codex: { kind: 'inline-visualization', available: Boolean(resolved) },
            farming: { presentation: 'inline-visualization', source: 'codex-host-directive', version: 1 },
          },
        },
      },
    };
    trustedInlineVisualizationNotifications.add(normalizedNotification);
    normalized.push(normalizedNotification);
  }
  return normalized;
}

function normalizeReservedPresentationMetadata(notification: UnknownRecord) {
  const update = notification.update as UnknownRecord | undefined;
  const content = update?.content as UnknownRecord | undefined;
  const contentMeta = content?._meta as UnknownRecord | undefined;
  const trusted = trustedInlineVisualizationNotifications.has(notification);
  if (!content || (!trusted && !contentMeta?.farming)) return notification;
  const nextMeta = { ...(contentMeta || {}) };
  delete nextMeta.farming;
  if (trusted) {
    nextMeta.farming = {
      presentation: 'inline-visualization',
      source: 'codex-host-directive',
      version: 1,
    };
  }
  const nextContent = { ...content };
  delete nextContent._meta;
  if (Object.keys(nextMeta).length > 0) nextContent._meta = nextMeta;
  return {
    ...notification,
    update: {
      ...update,
      content: nextContent,
    },
  };
}

function restoreMissingHistoryMedia(replayedState: AcpSessionState, checkpointState: AcpSessionState) {
  const userEntries = (state: AcpSessionState) => state.entries.filter(entry => (
    entry?.type === 'message' && entry.role === 'user'
  ));
  const entryText = (entry: UnknownRecord) => (Array.isArray(entry.content) ? entry.content : [])
    .filter((block: UnknownRecord) => block?.type === 'text')
    .map((block: UnknownRecord) => String(block.text || ''))
    .join('');
  const replayedUsers = userEntries(replayedState);
  const checkpointUsers = userEntries(checkpointState);
  let restored = 0;
  for (let index = 0; index < Math.min(replayedUsers.length, checkpointUsers.length); index += 1) {
    const target = replayedUsers[index] as UnknownRecord;
    const source = checkpointUsers[index] as UnknownRecord;
    if (entryText(target) !== entryText(source)) continue;
    const targetContent = Array.isArray(target.content) ? target.content as UnknownRecord[] : [];
    const sourceMedia = (Array.isArray(source.content) ? source.content as UnknownRecord[] : [])
      .filter(block => block?.type === 'image' || block?.type === 'audio');
    for (const block of sourceMedia) {
      const duplicate = targetContent.some(candidate => (
        candidate?.type === block.type
        && candidate?.mimeType === block.mimeType
        && candidate?.data === block.data
        && candidate?.path === block.path
      ));
      if (duplicate) continue;
      targetContent.push(clone(block));
      restored += 1;
    }
    target.content = targetContent;
  }
  return restored;
}

function supportsCodexSteer(capabilities: InitializeResponse['agentCapabilities'] = {}) {
  const capability = capabilities?._meta?.codex?.steer;
  return capability?.method === CODEX_STEER_METHOD
    && Number.isFinite(Number(capability.version))
    && Number(capability.version) >= 1;
}

function steeringMethod(response: InitializeResponse | null | undefined) {
  if (response?._meta?.steering?.supported === true) return SESSION_STEERING_METHOD;
  return supportsCodexSteer(response?.agentCapabilities) ? CODEX_STEER_METHOD : '';
}

function isSteerUnavailableError(error: unknown) {
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

function processGroupHasExited(owner: AcpProcessOwner) {
  if (!owner?.ownsProcessGroup || !owner.child?.pid || process.platform === 'win32') {
    return childHasExited(owner?.child);
  }
  try {
    process.kill(-owner.child.pid, 0);
    return false;
  } catch (error) {
    return asErrorLike(error).code === 'ESRCH';
  }
}

async function waitForProcessTreeExit(owner: AcpProcessOwner, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (processGroupHasExited(owner)) return true;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return processGroupHasExited(owner);
}

function signalProcessTree(owner: AcpProcessOwner, signal: NodeJS.Signals) {
  if (!owner?.child || processGroupHasExited(owner)) return;
  if (owner.ownsProcessGroup && owner.child.pid && process.platform !== 'win32') {
    try {
      process.kill(-owner.child.pid, signal);
      return;
    } catch (error) {
      if (asErrorLike(error).code === 'ESRCH') return;
    }
  }
  owner.child.kill(signal);
}

async function stopProcessAndWait(owner: AcpProcessOwner) {
  if (await waitForProcessTreeExit(owner, IDENTITY_ADAPTER_GRACEFUL_EXIT_MS)) return;
  signalProcessTree(owner, 'SIGTERM');
  if (await waitForProcessTreeExit(owner, IDENTITY_ADAPTER_TERMINATE_MS)) return;
  signalProcessTree(owner, 'SIGKILL');
  if (await waitForProcessTreeExit(owner, IDENTITY_ADAPTER_KILL_MS)) return;
  throw new Error(`ACP adapter process tree ${owner.child?.pid || ''} did not exit`);
}

async function describeAcpProcessGroup(pid: number) {
  const processId = Number(pid);
  if (!Number.isSafeInteger(processId) || processId <= 0 || process.platform === 'win32') {
    return null;
  }
  const identity = readServerProcessIdentity(processId);
  if (!identity) return null;
  if (identity.processGroupId !== processId) {
    throw new Error(`ACP process ${processId} did not become its own process-group leader`);
  }
  return identity;
}

async function readAcpProcessConfigFingerprint(pid: number) {
  const processId = Number(pid);
  if (!Number.isSafeInteger(processId) || processId <= 0) {
    return { available: false, fingerprint: '' };
  }
  if (process.platform !== 'win32') {
    try {
      const environment = fs.readFileSync(`/proc/${processId}/environ`, 'utf8')
        .split('\0')
        .filter(Boolean);
      const configEntry = environment.find((entry: string) => entry.startsWith('FARMING_CONFIG_DIR='));
      const configDir = configEntry?.slice('FARMING_CONFIG_DIR='.length) || '';
      return {
        available: true,
        fingerprint: configDir ? fingerprintConfigInstance(configDir) : '',
      };
    } catch {
      // macOS and other systems without procfs fall through to ps.
    }
  }
  try {
    const { stdout } = await execFileAsync(
      '/bin/ps',
      ['eww', '-p', String(processId), '-o', 'command='],
      { encoding: 'utf8', timeout: 1_000, maxBuffer: 1024 * 1024 },
    );
    const match = String(stdout || '').match(/(?:^|\s)FARMING_CONFIG_DIR=([^\s]+)/);
    return {
      available: true,
      fingerprint: match?.[1] ? fingerprintConfigInstance(match[1]) : '',
    };
  } catch {
    return { available: false, fingerprint: '' };
  }
}

async function stopPersistedAcpProcessGroup(
  identity: PersistedProcessIdentity | null | undefined,
  currentConfigInstanceFingerprint?: string,
) {
  const expected = identity && typeof identity === 'object' ? identity : null;
  const currentConfigFingerprint = String(currentConfigInstanceFingerprint || '').trim();
  if (!currentConfigFingerprint) {
    return { stopped: false, missingConfigScope: true };
  }
  if (
    !expected
    || !Number.isSafeInteger(Number(expected.pid))
    || !Number.isSafeInteger(Number(expected.processGroupId))
    || !String(expected.startedAt || '').trim()
  ) {
    return { stopped: false, missingProof: true };
  }
  const persistedConfigFingerprint = String(expected.configInstanceFingerprint || '').trim();
  if (
    persistedConfigFingerprint
    && persistedConfigFingerprint !== currentConfigFingerprint
  ) {
    return { stopped: false, configScopeMismatch: true };
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
  if (!persistedConfigFingerprint) {
    const observedConfig = await readAcpProcessConfigFingerprint(Number(expected.pid));
    if (!observedConfig.available || !observedConfig.fingerprint) {
      return { stopped: false, missingConfigScope: true };
    }
    if (observedConfig.fingerprint !== currentConfigFingerprint) {
      return { stopped: false, configScopeMismatch: true };
    }
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
  const args = providerSessionIdentityRollbackArgs(provider, sessionId);
  if (!args) throw new Error(`${provider || 'Provider'} does not support identity rollback`);
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
  declare runtimeProcesses: Map<string, AcpRuntimeProcess>;
  declare runtimeStarts: Map<string, Promise<AcpRuntimeProcess>>;
  declare activeSessionOwners: Map<string, AcpBinding>;
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
  declare stopProcessTreeAndWait: NonNullable<AcpRuntimeOptions['stopProcessAndWait']>;
  declare configInstanceFingerprint: string;
  declare configDir: string;
  declare checkpointStore: Pick<
    AcpCheckpointStore,
    'dispose' | 'flush' | 'load' | 'markDirty' | 'schedule' | 'write'
  > | null;
  declare reconnectOperations: Map<string, Promise<Record<string, unknown>>>;
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
    this.stopProcessTreeAndWait = options.stopProcessAndWait || stopProcessAndWait;
    this.configDir = options.configDir || '';
    this.configInstanceFingerprint = options.configDir
      ? fingerprintConfigInstance(options.configDir)
      : '';
    this.checkpointStore = options.checkpointStore
      || (options.configDir ? new AcpCheckpointStore(options.configDir, options.checkpointOptions) : null);
    this.bindings = new Map<string, AcpBinding>();
    this.runtimeProcesses = new Map();
    this.runtimeStarts = new Map();
    this.activeSessionOwners = new Map();
    this.reconnectOperations = new Map();
    this.disposing = false;
    this.disposePromise = null;
    this.disposed = false;
    this.clientFileSystem = options.clientFileSystem || new AcpClientFileSystem();
    this.clientTerminals = options.clientTerminals || new AcpClientTerminalManager({ spawn: options.terminalSpawn });
  }

  runtimeKey(binding: AcpBinding) {
    const shared = providerSupportsSharedAcpRuntime(binding.provider)
      && Boolean(binding.providerHomePath);
    return {
      key: JSON.stringify([
        binding.provider,
        ...(shared
          ? [
              binding.providerHomePath,
              binding.projectPath,
              binding.launch.command,
              binding.launch.args,
              binding.launch.version || '',
            ]
          : [`agent:${binding.agentId}`]),
      ]),
      shared,
    };
  }

  attachBindingToRuntime(binding: AcpBinding, runtime: AcpRuntimeProcess) {
    if (runtime.exited || runtime.stopping) throw new Error('ACP runtime process is not available');
    runtime.bindings.set(binding.agentId, binding);
    runtime.handlers.set(binding.agentId, this.clientHandlers(binding));
    binding.runtime = runtime;
    binding.child = runtime.child;
    binding.connection = runtime.connection;
    binding.initializeResponse = runtime.initializeResponse;
    binding.ownsProcessGroup = runtime.ownsProcessGroup;
    binding.supportsSteer = Boolean(steeringMethod(runtime.initializeResponse));
  }

  async persistRuntimeIdentity(runtime: AcpRuntimeProcess, options: PrepareAgentOptions) {
    if (!runtime.ownsProcessGroup || typeof options.onProcessStarted !== 'function') return;
    if (!runtime.processIdentity) {
      throw new Error(`ACP process ${runtime.child?.pid || ''} has no persisted identity`);
    }
    await options.onProcessStarted(runtime.processIdentity);
  }

  async startRuntimeProcess(
    binding: AcpBinding,
    options: PrepareAgentOptions,
    key: string,
    shared: boolean,
  ) {
    const runtime: AcpRuntimeProcess = {
      key,
      shared,
      provider: binding.provider,
      providerHomePath: binding.providerHomePath,
      projectPath: binding.projectPath,
      launch: binding.launch,
      env: shared
        ? sharedAcpProcessEnvironment(binding.provider, options)
        : binding.env,
      ownsProcessGroup: process.platform !== 'win32',
      child: null,
      connection: null as unknown as AcpConnection,
      initializeResponse: null as unknown as InitializeResponse,
      processIdentity: null,
      bindings: new Map(),
      handlers: new Map(),
      sessionOwners: new Map(),
      openingBinding: null,
      openTail: Promise.resolve(),
      stderr: '',
      exited: false,
      stopping: false,
    };
    binding.runtime = runtime;
    runtime.bindings.set(binding.agentId, binding);
    runtime.handlers.set(binding.agentId, this.clientHandlers(binding));
    try {
      const gatedLaunch = runtime.ownsProcessGroup
        ? {
            command: '/bin/sh',
            args: [
              '-c',
              'IFS= read -r farming_acp_start || exit 0; exec "$@"',
              'farming-acp-start-gate',
              runtime.launch.command,
              ...runtime.launch.args,
            ],
          }
        : runtime.launch;
      const child = this.spawn(gatedLaunch.command, gatedLaunch.args, {
        cwd: binding.cwd,
        env: runtime.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: runtime.ownsProcessGroup,
      });
      runtime.child = child;
      binding.child = child;
      child.stderr.on('data', (chunk: Buffer) => {
        runtime.stderr = `${runtime.stderr}${chunk.toString('utf8')}`.slice(-16_000);
      });
      child.on('error', (error: unknown) => this.handleRuntimeExit(runtime, error));
      child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
        if (!runtime.connection?.signal?.aborted) {
          const detail = runtime.stderr.trim()
            || `ACP adapter exited with code ${code}${signal ? ` (${signal})` : ''}`;
          this.handleRuntimeExit(runtime, code === 0 ? null : new Error(detail));
        }
      });
      if (runtime.ownsProcessGroup) {
        const processIdentity = await this.describeProcessGroup(child.pid);
        if (!processIdentity) {
          throw new Error(`ACP process ${child.pid || ''} exited before its identity was persisted`);
        }
        runtime.processIdentity = {
          ...processIdentity,
          ...(this.configInstanceFingerprint
            ? { configInstanceFingerprint: this.configInstanceFingerprint }
            : {}),
        };
        await this.persistRuntimeIdentity(runtime, options);
        if (this.configDir) {
          registerConfigProcessGroup(this.configDir, 'acp-provider', runtime.processIdentity);
        }
        await new Promise<void>((resolve, reject) => {
          child.stdin.write('start\n', (error: unknown) => {
            if (error) reject(error);
            else resolve();
          });
        });
      }

      const handlers = this.sharedClientHandlers(runtime);
      const connection = this.createConnection
        ? await this.createConnection(handlers, child, binding)
        : await this.officialConnection(handlers, child);
      runtime.connection = connection;
      binding.connection = connection;
      connection.closed.catch((error: unknown) => this.handleRuntimeExit(runtime, error));
      const sdk = await loadAcpSdk();
      if (runtime.exited || runtime.stopping) throw new Error('ACP runtime process closed during initialization');
      runtime.initializeResponse = await withTimeout(connection.initialize({
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
      if (runtime.initializeResponse.protocolVersion !== sdk.PROTOCOL_VERSION) {
        throw new Error(`ACP protocol version mismatch: Agent selected ${runtime.initializeResponse.protocolVersion}, Farming supports ${sdk.PROTOCOL_VERSION}`);
      }
      binding.initializeResponse = runtime.initializeResponse;
      binding.supportsSteer = Boolean(steeringMethod(runtime.initializeResponse));
      return runtime;
    } catch (error) {
      const startupError = error instanceof Error
        ? error
        : new Error(acpErrorMessage(error), { cause: error });
      runtime.stopping = true;
      try {
        runtime.connection?.close();
      } catch {
        // Process cleanup below remains authoritative.
      }
      if (runtime.child?.stdin?.writable && !runtime.child.stdin.destroyed) {
        try {
          runtime.child.stdin.end();
        } catch {
          // Process cleanup below remains authoritative.
        }
      }
      try {
        await this.stopProcessTreeAndWait(runtime);
        runtime.exited = true;
        if (this.configDir && runtime.processIdentity) {
          unregisterConfigProcessGroup(this.configDir, 'acp-provider', runtime.processIdentity);
        }
      } catch (cleanupError) {
        if (!this.runtimeProcesses.has(runtime.key)) {
          this.runtimeProcesses.set(runtime.key, runtime);
        }
        Object.defineProperty(startupError, 'adapterCleanupError', {
          value: cleanupError,
          enumerable: false,
          configurable: true,
        });
      }
      throw startupError;
    }
  }

  async acquireRuntimeProcess(binding: AcpBinding, options: PrepareAgentOptions) {
    const { key, shared } = this.runtimeKey(binding);
    const existing = this.runtimeProcesses.get(key);
    if (existing && !existing.exited && existing.stopping) {
      throw new Error('ACP runtime process cleanup is not verified; retry after exact process exit');
    }
    if (existing && !existing.exited && !existing.stopping) {
      this.attachBindingToRuntime(binding, existing);
      await this.persistRuntimeIdentity(existing, options);
      return existing;
    }
    const starting = this.runtimeStarts.get(key);
    if (starting) {
      const runtime = await starting;
      this.attachBindingToRuntime(binding, runtime);
      await this.persistRuntimeIdentity(runtime, options);
      return runtime;
    }
    const operation = this.startRuntimeProcess(binding, options, key, shared);
    this.runtimeStarts.set(key, operation);
    try {
      const runtime = await operation;
      this.runtimeProcesses.set(key, runtime);
      return runtime;
    } finally {
      if (this.runtimeStarts.get(key) === operation) this.runtimeStarts.delete(key);
    }
  }

  claimRuntimeSession(binding: AcpBinding, sessionId: string) {
    const runtime = binding.runtime;
    const id = String(sessionId || '').trim();
    if (!runtime || !id) return;
    const ownershipKey = this.sessionOwnershipKey(binding, id);
    const activeOwner = this.activeSessionOwners.get(ownershipKey);
    if (activeOwner && activeOwner !== binding && this.isOpenBinding(activeOwner)) {
      throw new Error(`ACP session ${id} is already active in another Agent`);
    }
    const owner = runtime.sessionOwners.get(id);
    if (owner && owner !== binding && this.isOpenBinding(owner)) {
      throw new Error(`ACP session ${id} is already active in another Agent`);
    }
    this.activeSessionOwners.set(ownershipKey, binding);
    binding.ownedSessionKeys.set(id, ownershipKey);
    runtime.sessionOwners.set(id, binding);
  }

  sessionOwnershipKey(binding: AcpBinding, sessionId: string) {
    return JSON.stringify([
      binding.provider,
      binding.providerHomeIdentity
        ? `home:${binding.providerHomeIdentity}`
        : `runtime:${binding.runtime?.key || binding.agentId}`,
      sessionId,
    ]);
  }

  releaseRuntimeSessions(binding: AcpBinding) {
    for (const [sessionId, ownershipKey] of binding.ownedSessionKeys) {
      if (this.activeSessionOwners.get(ownershipKey) === binding) {
        this.activeSessionOwners.delete(ownershipKey);
      }
      binding.ownedSessionKeys.delete(sessionId);
    }
    const runtime = binding.runtime;
    if (!runtime) return;
    for (const [sessionId, owner] of runtime.sessionOwners) {
      if (owner !== binding) continue;
      runtime.sessionOwners.delete(sessionId);
    }
    if (runtime.openingBinding === binding) runtime.openingBinding = null;
  }

  bindingForRuntimeSession(runtime: AcpRuntimeProcess, sessionId: string) {
    const id = String(sessionId || '').trim();
    if (id) {
      const owner = runtime.sessionOwners.get(id);
      if (owner && this.isOpenBinding(owner)) return owner;
      const subagentOwners = [...runtime.bindings.values()].filter(binding => (
        this.isOpenBinding(binding)
        && (
          binding.subagentStates.has(id)
          || binding.sessionState?.entries.some((entry: TranscriptEntry) => (
            String(entry?._meta?.subagent_session_info?.session_id || '') === id
          ))
        )
      ));
      if (subagentOwners.length === 1) return subagentOwners[0];
    }
    if (runtime.openingBinding && this.isOpenBinding(runtime.openingBinding)) {
      return runtime.openingBinding;
    }
    if (id && runtime.shared) return null;
    const openBindings = [...runtime.bindings.values()].filter(binding => this.isOpenBinding(binding));
    return openBindings.length === 1 ? openBindings[0] : null;
  }

  assertRuntimeSessionMutationOwner(binding: AcpBinding, sessionId: string, action: string) {
    const id = String(sessionId || '').trim();
    if (!isSafeProviderSessionId(id)) {
      throw new Error(`ACP ${action} requires a safe exact session id`);
    }
    const activeOwner = this.activeSessionOwners.get(this.sessionOwnershipKey(binding, id));
    const runtimeOwner = binding.runtime?.sessionOwners.get(id);
    if (
      (activeOwner && activeOwner !== binding && this.isOpenBinding(activeOwner))
      || (runtimeOwner && runtimeOwner !== binding && this.isOpenBinding(runtimeOwner))
    ) {
      throw new Error(`ACP Agent does not own session ${id}`);
    }
    return id;
  }

  async openUnknownRuntimeSession<T>(
    runtime: AcpRuntimeProcess,
    binding: AcpBinding,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = runtime.openTail;
    const pending = previous.catch(() => {}).then(async () => {
      this.requireOpenBinding(binding);
      if (runtime.exited || runtime.stopping) throw new Error('ACP runtime process is closed');
      runtime.openingBinding = binding;
      try {
        return await operation();
      } finally {
        if (runtime.openingBinding === binding) runtime.openingBinding = null;
      }
    });
    runtime.openTail = pending;
    try {
      return await pending;
    } finally {
      if (runtime.openTail === pending) runtime.openTail = Promise.resolve();
    }
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
    const capabilityRuntimeEpoch = String(options.capabilityRuntimeEpoch || '').trim();
    if (capabilityRuntimeEpoch && !/^[A-Za-z0-9._:-]{1,160}$/.test(capabilityRuntimeEpoch)) {
      throw new Error('ACP capability runtime epoch is invalid');
    }
    const launch = this.resolveLaunch(provider, options);
    const cwd = path.resolve(options.cwd || process.cwd());
    const projectPath = path.resolve(String(options.projectWorkspace || cwd).trim() || cwd);
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
    const prepareEnvironment = getProviderAdapter(provider)?.prepareAcpEnvironment
      || ((value: PrepareAgentOptions) => value.env || process.env);
    const bindingEnv = prepareEnvironment(options);
    // An owned fork temporarily opens the source Session. Keep that startup on
    // an isolated connection so it cannot collide with an already-live source
    // in the shared Home runtime. The resulting child Session joins the shared
    // pool on its next reconnect.
    const providerHomeIdentity = canonicalAcpHomePath(provider, options, bindingEnv);
    const providerHomePath = forkSourceSessionId
      ? ''
      : providerHomeIdentity;
    const sessionRequestOptions = acpSessionRequestOptions({
      ...options,
      provider,
      env: bindingEnv,
    }, cwd);
    const configOverrides = normalizeSessionConfigChanges(options.configOverrides);
    const restartOptions = {
      ...options,
      agentId,
      provider,
      providerHomePath,
      configOverrides,
    };
    delete restartOptions.forkSourceSessionId;
    delete restartOptions.forkSourceCheckpoint;
    delete restartOptions.onForkSessionCreated;
    const binding: AcpBinding = {
      agentId,
      capabilityRuntimeEpoch,
      provider,
      providerHomeId: String(options.providerHomeId || 'default'),
      providerHomePath,
      providerHomeIdentity,
      projectPath,
      cwd,
      sessionRequestOptions,
      env: bindingEnv,
      launch,
      restartOptions,
      approvalMode: options.approvalMode || 'approve',
      ownsProcessGroup: process.platform !== 'win32',
      runtime: null,
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
      configOverrideWarnings: [],
      pendingPermissions: new Map(),
      permissionResolvers: new Map(),
      pendingElicitations: new Map(),
      elicitationResolvers: new Map(),
      activeElicitations: new Map(),
      subagentStates: new Map(),
      subagentControls: new Map(),
      nextSubagentGeneration: 1,
      ownedSessionKeys: new Map(),
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
      transcriptProjectionRevision: 0,
      authTerminal: null as unknown as UnknownRecord,
      patchDecisions: new Map(),
      patchDecisionInFlight: new Map(),
      checkpointProof: null,
      sessionMutation: null,
      configMutationTail: null,
      deferredConfigChanges: new Map(),
      deferredConfigFlush: null,
      deferredModeGeneration: 0,
      deferredModeId: '',
      codexInlineVisualizationStreams: new Map(),
      stderr: '',
      exited: false,
      retryableReconnect: false,
      updatedAt: new Date().toISOString(),
    };
    this.bindings.set(agentId, binding);

    this.emitRuntime(binding);

    try {
      binding.projectPath = await canonicalAcpProjectPath(options, cwd);
      this.requireOpenBinding(binding);
      binding.providerHomeIdentity = await prepareAcpHomePath(provider, binding.providerHomeIdentity);
      if (binding.providerHomePath) {
        binding.providerHomePath = binding.providerHomeIdentity;
        binding.restartOptions.providerHomePath = binding.providerHomePath;
      }
      this.requireOpenBinding(binding);
      const runtime = await this.acquireRuntimeProcess(binding, options);
      this.requireOpenBinding(binding);
      binding.initializeResponse = runtime.initializeResponse;
      const connection = binding.connection;

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
        this.claimRuntimeSession(binding, forkSourceSessionId);
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
          if (providerAcpHistoryReplayPolicy(provider)?.waitForNotifications) {
            await this.waitForHistoryReplay(binding);
          }
          this.requireOpenBinding(binding);
        } finally {
          binding.historyReplayActive = false;
        }
        binding.sessionState.finishHistoryReplay();
        binding.codexInlineVisualizationStreams.clear();
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
        this.releaseRuntimeSessions(binding);
        this.claimRuntimeSession(binding, forkedSessionId);
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
        this.claimRuntimeSession(binding, requestedSessionId);
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
          if (restoredCheckpoint?.deferredConfigChanges instanceof Map) {
            binding.deferredConfigChanges = restoredCheckpoint.deferredConfigChanges;
          }
          binding.deferredModeId = String(restoredCheckpoint?.deferredModeId || '');
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
            if (providerAcpHistoryReplayPolicy(provider)?.waitForNotifications) {
              await this.waitForHistoryReplay(binding);
            }
            this.requireOpenBinding(binding);
          } finally {
            binding.historyReplayActive = false;
          }
          binding.sessionState.finishHistoryReplay();
          binding.codexInlineVisualizationStreams.clear();
          if (providerAcpHistoryReplayPolicy(provider)?.restoreMissingCheckpointMedia && restoredCheckpointState) {
            restoreMissingHistoryMedia(binding.sessionState, restoredCheckpointState);
          }
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
        sessionResponse = await this.openUnknownRuntimeSession(runtime, binding, () => withTimeout(
          connection.newSession(binding.sessionRequestOptions),
          this.sessionSetupTimeoutMs,
          'ACP session/new'
        ));
        this.requireOpenBinding(binding);
        const returnedSessionId = String(sessionResponse.sessionId || '').trim();
        if (!isSafeProviderSessionId(returnedSessionId)) {
          binding.untrustedSessionId = returnedSessionId;
          throw new Error('ACP session/new returned an invalid resumable session id');
        }
        binding.sessionId = returnedSessionId;
        this.claimRuntimeSession(binding, returnedSessionId);
        binding.sessionState = new AcpSessionState({ provider, sessionId: binding.sessionId, cwd: binding.cwd, maxUpdates: this.maxUpdates });
      }
      this.requireOpenBinding(binding);
      const normalizeModes = getProviderAdapter(provider)?.acp.normalizeModes;
      binding.modes = (normalizeModes
        ? normalizeModes(sessionResponse?.modes || null, recordValue(binding.initializeResponse.agentInfo))
        : sessionResponse?.modes) as SessionResponse['modes'] || null;
      binding.configOptions = sessionResponse?.configOptions || [];
      const initializedSessionState = this.requireSessionState(binding);
      initializedSessionState.currentModeId = String(binding.modes?.currentModeId || '');
      initializedSessionState.configOptions = JSON.parse(JSON.stringify(binding.configOptions));
      const configPolicy = providerAcpConfigPolicy(provider);
      if (configPolicy?.launchModelAndReasoning) {
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
            throw new Error(`${provider} ACP Agent did not advertise a Model configuration option`);
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
            throw new Error(`${provider} ACP Agent did not advertise a Reasoning configuration option`);
          }
          changes.push({ configId: reasoningOption.id, value: options.reasoningEffort });
        }
        if (changes.length > 0) await this.applySessionConfigOptionsNow(binding, changes);
      }
      if (configPolicy?.approvalModes) {
        const modeId = configPolicy.approvalModes[binding.approvalMode];
        const availableModes = Array.isArray(binding.modes?.availableModes)
          ? binding.modes.availableModes
          : [];
        if (
          modeId
          && String(binding.modes?.currentModeId || '') !== modeId
          && availableModes.some(mode => String(recordValue(mode).id || '') === modeId)
        ) {
          await this.setSessionModeNow(binding, modeId);
        }
      }
      if (configPolicy?.serviceTier && options.serviceTier && options.serviceTier !== 'config') {
        const fastOption = binding.configOptions.find(option => (
          option.type === 'boolean'
          && /fast/i.test(`${option.id || ''} ${option.name || ''} ${option.category || ''}`)
        ));
        const fastEnabled = configPolicy.serviceTier.enabledValues.includes(options.serviceTier);
        if (fastOption && fastOption.currentValue !== fastEnabled) {
          await this.applySessionConfigOption(binding, fastOption.id, fastEnabled, { emit: false });
        }
      }
      if (configOverrides.length > 0) await this.restoreSessionConfigOverrides(binding, configOverrides);
      this.requireOpenBinding(binding);
      binding.state = 'idle';
      binding.updatedAt = new Date().toISOString();
      this.scheduleCheckpoint(binding, { exact: true });
      this.emitRuntime(binding);
      this.emitSession(binding);
      void this.flushDeferredSessionChanges(binding);
      return {
        sessionId: binding.sessionId,
        historyMode,
        protocolVersion: binding.initializeResponse.protocolVersion,
        agentInfo: binding.initializeResponse.agentInfo || null,
        capabilities: binding.initializeResponse.agentCapabilities || {},
        adapter: launch,
        configOverrides: normalizeSessionConfigChanges(binding.restartOptions.configOverrides),
      };
    } catch (error) {
      const runtimeError = new Error(acpErrorMessage(error), { cause: error });
      const startupCleanupError = asErrorLike(error).adapterCleanupError;
      if (startupCleanupError) {
        Object.defineProperty(runtimeError, 'adapterCleanupError', {
          value: startupCleanupError,
          enumerable: false,
          configurable: true,
        });
      }
      if (binding.runtime?.shared && !binding.runtime.exited) {
        binding.state = 'error';
        binding.error = runtimeError.message;
        binding.stopReason = 'error';
        binding.updatedAt = new Date().toISOString();
        this.emitRuntime(binding);
      } else {
        this.handleExit(binding, runtimeError);
      }
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
            if (!binding.runtime) {
              this.bindings.delete(agentId);
              runtimeCleanupVerified = true;
            } else {
              runtimeCleanupVerified = await this.unregisterAgentAndWait(agentId, binding);
            }
          } else {
            const detachedRuntime = binding.runtime;
            this.releaseRuntimeSessions(binding);
            detachedRuntime?.bindings.delete(binding.agentId);
            detachedRuntime?.handlers.delete(binding.agentId);
            if (!detachedRuntime || detachedRuntime.bindings.size === 0) {
              try {
                binding.connection?.close();
              } catch {
                // Process-tree cleanup below remains authoritative.
              }
              await this.stopProcessTreeAndWait(detachedRuntime || binding);
            }
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
      throw new Error('No active ACP turn to steer');
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
    binding.codexInlineVisualizationStreams.clear();
    turn.phase = 'completed';
    turn.resolveCompletion?.(result);
    void this.flushDeferredSessionChanges(binding);
    return true;
  }

  async flushDeferredSessionChanges(binding: AcpBinding) {
    if (
      !this.isOpenBinding(binding)
      || binding.activeTurn
      || binding.deferredConfigFlush
      || (!binding.deferredModeId && binding.deferredConfigChanges.size === 0)
    ) return;
    const modeId = binding.deferredModeId;
    const modeGeneration = binding.deferredModeGeneration;
    const originalModeId = String(binding.sessionState?.currentModeId || binding.modes?.currentModeId || '');
    const changes = [...binding.deferredConfigChanges.values()];
    const flush = this.enqueueSessionConfigMutation(binding, async () => {
      let modeApplied = false;
      try {
        if (modeId) {
          await this.setSessionModeNow(binding, modeId);
          modeApplied = true;
        }
        if (changes.length > 0) await this.setSessionConfigOptionsNow(binding, changes);
      } catch (error) {
        if (modeApplied && originalModeId && originalModeId !== modeId) {
          try {
            await this.setSessionModeNow(binding, originalModeId);
          } catch (rollbackError) {
            if (error && typeof error === 'object') {
              Object.defineProperty(error, 'modeRollbackError', {
                value: rollbackError,
                enumerable: false,
                configurable: true,
              });
            }
          }
        }
        throw error;
      }
    })
      .then(() => {
        if (binding.deferredModeGeneration === modeGeneration) binding.deferredModeId = '';
        for (const change of changes) {
          if (binding.deferredConfigChanges.get(change.configId) === change) {
            binding.deferredConfigChanges.delete(change.configId);
          }
        }
        if (changes.length > 0) this.rememberSessionConfigOverrides(binding, changes);
        this.clearDeferredSessionError(binding);
      }, error => {
        if (binding.deferredModeGeneration === modeGeneration) binding.deferredModeId = '';
        for (const change of changes) {
          if (binding.deferredConfigChanges.get(change.configId) === change) {
            binding.deferredConfigChanges.delete(change.configId);
          }
        }
        const rollbackError = recordValue(error).modeRollbackError;
        const configRollbackError = recordValue(error).configRollbackError;
        binding.error = `Deferred session change was not applied: ${acpErrorMessage(error)}${
          configRollbackError ? ` Configuration rollback also failed: ${acpErrorMessage(configRollbackError)}` : ''
        }${
          rollbackError ? ` Permission mode rollback also failed: ${acpErrorMessage(rollbackError)}` : ''
        }`;
      })
      .finally(() => {
        if (binding.deferredConfigFlush === flush) binding.deferredConfigFlush = null;
        if (!this.isOpenBinding(binding)) return;
        binding.updatedAt = new Date().toISOString();
        this.scheduleCheckpoint(binding, { exact: true });
        this.emitRuntime(binding);
        void this.flushDeferredSessionChanges(binding);
      });
    binding.deferredConfigFlush = flush;
  }

  clearDeferredSessionError(binding: AcpBinding) {
    if (!binding.error.startsWith('Deferred session change was not applied:')) return false;
    binding.error = '';
    return true;
  }

  cancelAdmittingTurn(binding: AcpBinding, turn: AcpTurn) {
    if (binding.activeTurn !== turn || turn.phase !== 'admitting') return false;
    binding.activeTurn = null;
    turn.phase = 'cancelled';
    binding.state = String(turn.previousState || 'idle');
    turn.resolveCompletion?.({ status: 'cancelled-before-submission' });
    this.emitRuntime(binding);
    void this.flushDeferredSessionChanges(binding);
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
        deferredConfigChanges: [...binding.deferredConfigChanges.entries()].map(([configId, change]) => [
          configId,
          clone(change.value),
        ]),
        deferredModeId: binding.deferredModeId,
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
    const deferredConfigChanges = new Map<string, SessionConfigChange>();
    if (checkpoint.version === 2 && Array.isArray(checkpoint.deferredConfigChanges)) {
      for (const item of checkpoint.deferredConfigChanges.slice(0, 32)) {
        if (!Array.isArray(item) || item.length !== 2) continue;
        const configId = String(item[0] || '');
        const value = item[1] as ConfigValue;
        if (!configId || !['string', 'boolean', 'number'].includes(typeof value)) continue;
        deferredConfigChanges.set(configId, { configId, value });
      }
    }
    const deferredModeId = checkpoint.version === 2 && typeof checkpoint.deferredModeId === 'string'
      ? checkpoint.deferredModeId
      : '';
    return {
      sessionState,
      subagentStates,
      patchDecisions,
      deferredConfigChanges,
      deferredModeId,
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

  sharedClientHandlers(runtime: AcpRuntimeProcess) {
    const handler = (name: AcpSingleRequestHandlerName, request: UnknownRecord) => {
      const binding = this.bindingForRuntimeSession(runtime, String(request?.sessionId || ''));
      return binding ? runtime.handlers.get(binding.agentId)?.[name] : null;
    };
    const request = (name: AcpSingleRequestHandlerName) => async (params: UnknownRecord) => {
      const target = handler(name, params);
      if (!target) throw new Error('ACP request does not match an active Session');
      return target(params);
    };
    return {
      sessionUpdate: (notification: UnknownRecord) => handler('sessionUpdate', notification)?.(notification),
      extNotification: (method: string, params: UnknownRecord) => {
        const binding = this.bindingForRuntimeSession(runtime, String(params?.sessionId || ''));
        return binding ? runtime.handlers.get(binding.agentId)?.extNotification(method, params) : undefined;
      },
      requestPermission: async (params: UnknownRecord) => {
        const target = handler('requestPermission', params);
        return target ? target(params) : { outcome: { outcome: 'cancelled' } };
      },
      readTextFile: request('readTextFile'),
      writeTextFile: request('writeTextFile'),
      createTerminal: request('createTerminal'),
      terminalOutput: request('terminalOutput'),
      waitForTerminalExit: request('waitForTerminalExit'),
      killTerminal: request('killTerminal'),
      releaseTerminal: request('releaseTerminal'),
      unstable_createElicitation: async (params: UnknownRecord) => {
        const target = handler('unstable_createElicitation', params);
        return target ? target(params) : { action: 'cancel' };
      },
      unstable_completeElicitation: (notification: UnknownRecord) => (
        handler('unstable_completeElicitation', notification)?.(notification)
      ),
    };
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
        const applyNotification = (normalizedNotification: UnknownRecord) => {
          if (!this.isOpenBinding(binding) || binding.state === 'closed') return;
          notification = normalizeReservedPresentationMetadata(normalizedNotification);
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
        };
        const update = notification.update as UnknownRecord | undefined;
        const content = update?.content as UnknownRecord | undefined;
        const shouldNormalizeHostMessage = getProviderAdapter(binding.provider)?.acp.normalizeHostMessageChunks === true
          && update?.sessionUpdate === 'agent_message_chunk'
          && content?.type === 'text';
        if (!shouldNormalizeHostMessage) return applyNotification(notification);
        return normalizeCodexHostMessageUpdate(binding, notification).then(normalized => {
          for (const item of normalized) applyNotification(item);
        });
      },
      extNotification: (method: string, params: UnknownRecord) => {
        if (!this.isOpenBinding(binding) || binding.state === 'closed') return;
        const event = normalizeProviderAcpExtensionNotification(binding.provider, method, params);
        if (
          !event
          || event.kind !== 'prompt-suggestion'
          || event.sessionId !== binding.sessionId
          || !binding.sessionState?.setPromptSuggestion({
            text: event.text,
            promptId: event.promptId,
          })
        ) {
          return;
        }
        binding.updatedAt = new Date().toISOString();
        this.emitSession(binding);
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

  async requestPermission(binding: AcpBinding, request: UnknownRecord) {
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
    }
    binding.permissionResolvers.delete(requestId);
    binding.pendingPermissions.delete(requestId);
    const origin = binding.interactionOrigins.get(requestId);
    binding.interactionOrigins.delete(requestId);
    binding.state = interactiveRuntimeState(binding, origin);
    resolve(response);
    this.emitRuntime(binding);
    return response;
  }

  async requestElicitation(binding: AcpBinding, request: UnknownRecord) {
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
        || binding.supportsSteer !== true
      ) {
        throw new Error('No active ACP turn to steer');
      }
      const result = await this.steer(agentId, prompt);
      options.onSubmitted?.({ steered: true });
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
        && binding.supportsSteer === true
      ) {
        try {
          const result = await this.steer(agentId, prompt);
          options.onSubmitted?.({ steered: true });
          return { steered: true, ...result };
        } catch (error) {
          if (!isSteerUnavailableError(error)) throw error;
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
      options.onTurnAdmitted?.({ previousState: String(turn.previousState || 'idle') });
    } catch (error) {
      if (this.isCurrentTurn(binding, turn)) {
        binding.state = turn.previousState;
        this.finishTurn(binding, turn, { status: 'admission-failed' });
      }
      throw error;
    }
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
    this.requireSessionState(binding).beginPrompt(content);
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
        options.onSubmitted?.({ steered: false });
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
        const sessionState = this.requireSessionState(binding);
        sessionState.recordError(runtimeError.message, acpErrorKind(runtimeError));
        sessionState.completePrompt();
        binding.state = 'error';
        binding.error = runtimeError.message;
        binding.retryableReconnect = isStructuredReconnectableFailure(binding, error)
          && isSafeProviderSessionId(binding.sessionId);
        binding.updatedAt = new Date().toISOString();
        try {
          options.onTurnSettled?.({ stopReason: 'error' });
        } catch {
          // Turn evidence is already authoritative; observers cannot roll it back.
        }
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
      this.requireSessionState(binding).completePrompt();
      binding.state = 'idle';
      binding.error = '';
      binding.updatedAt = new Date().toISOString();
      try {
        options.onTurnSettled?.({ stopReason: binding.stopReason });
      } catch {
        // Turn evidence is already authoritative; observers cannot roll it back.
      }
      this.finishTurn(binding, turn, { status: 'completed', stopReason: binding.stopReason });
      this.scheduleCheckpoint(binding, { exact: true });
      this.emitSession(binding);
      this.emitRuntime(binding);
      return { sessionId: binding.sessionId, stopReason: binding.stopReason };
    });
  }

  canSteer(agentId: string) {
    const binding = this.bindings.get(agentId);
    return binding?.supportsSteer === true
      && binding.activeTurn?.phase === 'running'
      && binding.activeTurn?.providerSettled !== true
      && Boolean(binding.sessionId)
      && Boolean(binding.connection);
  }

  async steer(agentId: string, prompt: PromptBlock[]) {
    const binding = this.requireBinding(agentId);
    const method = steeringMethod(binding.initializeResponse);
    if (!method || binding.supportsSteer !== true) {
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
      if (turn.providerSettled) throw new Error('No active ACP turn to steer');
      await this.markCheckpointDirty(binding);
      this.requireCurrentTurn(binding, turn, ['running']);
      if (turn.providerSettled) throw new Error('No active ACP turn to steer');
      const sessionState = this.requireSessionState(binding);
      const insertionIndex = sessionState.entries.length;
      const response = await withTimeout(
        binding.connection.request(method, {
          sessionId: binding.sessionId,
          prompt: content,
          clientMessageId,
          ...(method === SESSION_STEERING_METHOD
            ? { _meta: { steering: { idleBehavior: 'promptRequired' } } }
            : {}),
        }),
        this.requestTimeoutMs,
        'ACP steer',
      );
      this.requireCurrentTurn(binding, turn, ['running']);
      const turnId = String((response as UnknownRecord | null)?.turnId || '');
      if (sessionState.recordAcceptedSteer(content, {
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
      binding.interactionOrigins.delete(requestId);
    }
    for (const [requestId, pending] of binding.pendingElicitations.entries()) {
      if (String(pending?.sessionId || '') !== targetSessionId) continue;
      binding.elicitationResolvers.get(requestId)?.({ action: 'cancel' });
      binding.elicitationResolvers.delete(requestId);
      binding.pendingElicitations.delete(requestId);
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
      if (!recordValue(binding.initializeResponse?.agentCapabilities?.auth).logout) {
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

  async refreshRuntimeMcpServers(
    binding: AcpBinding,
    options: PrepareAgentOptions,
  ): Promise<PrepareAgentOptions> {
    const refresh = options.refreshMcpServersForRuntime;
    if (typeof refresh !== 'function') return options;
    const refreshed = await refresh(
      binding.sessionRequestOptions.mcpServers.filter(
        (server: UnknownRecord) => server && typeof server === 'object' && !Array.isArray(server),
      ),
    );
    const capabilityRuntimeEpoch = String(refreshed?.capabilityRuntimeEpoch || '').trim();
    if (!/^[A-Za-z0-9._:-]{1,160}$/.test(capabilityRuntimeEpoch)) {
      throw new Error('ACP capability runtime refresh returned an invalid epoch');
    }
    if (!Array.isArray(refreshed?.mcpServers)) {
      throw new Error('ACP capability runtime refresh returned invalid MCP servers');
    }
    return {
      ...options,
      capabilityRuntimeEpoch,
      mcpServers: refreshed.mcpServers.filter(
        (server: UnknownRecord) => server && typeof server === 'object' && !Array.isArray(server),
      ),
    };
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
    let options: PrepareAgentOptions = {
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
    options = await this.refreshRuntimeMcpServers(binding, options);
    return this.prepareAgent(options);
  }

  reconnectAgent(agentId: string, options: PrepareAgentOptions = {}): Promise<Record<string, unknown>> {
    const existing = this.reconnectOperations.get(agentId);
    if (existing) return existing;
    const operation = this.performReconnectAgent(agentId, options);
    this.reconnectOperations.set(agentId, operation);
    void operation.finally(() => {
      if (this.reconnectOperations.get(agentId) === operation) {
        this.reconnectOperations.delete(agentId);
      }
    }).catch(() => {});
    return operation;
  }

  async performReconnectAgent(agentId: string, options: PrepareAgentOptions = {}) {
    const binding = this.requireBinding(agentId);
    const recoverableFailure = binding.state === 'error'
      && binding.stopReason === 'error'
      && binding.retryableReconnect === true;
    if (!recoverableFailure) {
      return { reconnected: false, sessionId: binding.sessionId, state: binding.state };
    }
    if (!isSafeProviderSessionId(binding.sessionId)) {
      throw new Error('ACP Agent reconnect requires a safe exact provider session id');
    }
    if (binding.activeTurn) throw new Error('ACP Agent cannot reconnect while a turn is active');

    const revisionBase = Number(binding.sessionState?.revision || 0);
    let restartOptions: PrepareAgentOptions = {
      ...binding.restartOptions,
      agentId: binding.agentId,
      provider: binding.provider,
      cwd: binding.cwd,
      sessionId: binding.sessionId,
      historyMode: 'checkpoint',
      revisionBase,
    };
    delete restartOptions.forkSourceSessionId;
    delete restartOptions.forkSourceCheckpoint;
    delete restartOptions.onForkSessionCreated;

    binding.state = 'reconnecting';
    binding.error = '';
    binding.retryableReconnect = false;
    binding.updatedAt = new Date().toISOString();
    this.emitRuntime(binding);
    let oldProcessStopped = false;
    try {
      const identity = this.checkpointIdentity(binding);
      if (this.checkpointStore && identity && binding.sessionState) {
        await this.checkpointStore.write(identity, this.bindingCheckpoint(binding), { exact: false });
      }
      if (!this.isCurrentBinding(binding)) {
        throw new Error('ACP Agent binding changed before reconnect');
      }
      oldProcessStopped = await this.unregisterAgentAndWait(agentId, binding);
      if (!oldProcessStopped) throw new Error('ACP Agent reconnect could not stop the previous process');
      if (typeof options.onProcessStopped === 'function') await options.onProcessStopped();
      restartOptions = await this.refreshRuntimeMcpServers(binding, restartOptions);
      const prepared = await this.prepareAgent(restartOptions);
      return { reconnected: true, ...prepared };
    } catch (error) {
      const failure = asErrorLike(error);
      if (oldProcessStopped && failure.runtimeCleanupVerified === true && typeof options.onProcessStopped === 'function') {
        await options.onProcessStopped();
      }
      let failedBinding = this.bindings.get(agentId);
      if (!failedBinding) {
        failedBinding = binding;
        this.bindings.set(agentId, failedBinding);
      }
      failedBinding.exited = true;
      failedBinding.state = 'error';
      failedBinding.error = `ACP reconnect failed: ${acpErrorMessage(error)}`;
      failedBinding.stopReason = 'error';
      failedBinding.retryableReconnect = oldProcessStopped
        && isSafeProviderSessionId(failedBinding.sessionId);
      failedBinding.updatedAt = new Date().toISOString();
      this.emitRuntime(failedBinding);
      throw error;
    }
  }

  async forkSession(agentId: string, options: PrepareAgentOptions = {}) {
    return this.runWithForkReservation(agentId, options, async (binding: AcpBinding) => {
      const sourceSessionId = this.assertRuntimeSessionMutationOwner(
        binding,
        options.sessionId || binding.sessionId,
        'session/fork',
      );
      if (sourceSessionId !== binding.sessionId) {
        throw new Error(`ACP Agent does not own session ${sourceSessionId}`);
      }
      const sessionOptions = acpSessionRequestOptions({
        provider: binding.provider,
        env: binding.env,
        farmingSystemPrompt: binding.restartOptions.farmingSystemPrompt,
        additionalDirectories: options.additionalDirectories ?? binding.sessionRequestOptions.additionalDirectories,
        mcpServers: options.mcpServers ?? binding.sessionRequestOptions.mcpServers,
      }, options.cwd || binding.cwd);
      const response = await withTimeout(binding.connection.unstable_forkSession({
        sessionId: sourceSessionId,
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
      const targetSessionId = this.assertRuntimeSessionMutationOwner(binding, sessionId, 'session/delete');
      await withTimeout(
        binding.connection.deleteSession({ sessionId: targetSessionId }),
        this.requestTimeoutMs,
        'ACP session/delete'
      );
      this.requireOpenBinding(binding);
      return { deleted: true, sessionId: targetSessionId };
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
    const normalizedModeId = String(modeId || '');
    const advertisedModes = Array.isArray(binding.modes?.availableModes)
      ? binding.modes.availableModes
      : [];
    if (!normalizedModeId || !advertisedModes.some(mode => String(recordValue(mode).id || '') === normalizedModeId)) {
      throw new Error(`ACP Agent did not advertise mode ${normalizedModeId}`);
    }
    if (binding.activeTurn || binding.deferredConfigFlush) {
      const previousModeId = binding.deferredModeId;
      const previousGeneration = binding.deferredModeGeneration;
      const generation = binding.deferredModeGeneration + 1;
      binding.deferredModeGeneration = generation;
      binding.deferredModeId = normalizedModeId;
      try {
        await this.writeCheckpoint(binding);
      } catch (error) {
        if (binding.deferredModeGeneration === generation) {
          binding.deferredModeGeneration = previousGeneration;
          binding.deferredModeId = previousModeId;
        }
        throw error;
      }
      binding.updatedAt = new Date().toISOString();
      this.emitRuntime(binding);
      return {
        sessionId: binding.sessionId,
        deferred: true,
        modeId: normalizedModeId,
        deferredModeId: normalizedModeId,
      };
    }
    this.requireConfigMutationReady(binding);
    const result = await this.enqueueSessionConfigMutation(binding, () => (
      this.setSessionModeNow(binding, normalizedModeId)
    ));
    if (this.clearDeferredSessionError(binding)) {
      binding.updatedAt = new Date().toISOString();
      this.emitRuntime(binding);
    }
    return result;
  }

  async setSessionModeNow(binding: AcpBinding, modeId: string) {
    this.requireOpenBinding(binding);
    await withTimeout(
      binding.connection.setSessionMode({ sessionId: binding.sessionId, modeId: String(modeId || '') }),
      this.requestTimeoutMs,
      'ACP session/set_mode'
    );
    this.requireOpenBinding(binding);
    const sessionState = this.requireSessionState(binding);
    sessionState.currentModeId = String(modeId || '');
    if (binding.modes) binding.modes = { ...binding.modes, currentModeId: sessionState.currentModeId };
    this.scheduleCheckpoint(binding, { exact: true });
    this.emitSession(binding);
    return { sessionId: binding.sessionId, modeId: sessionState.currentModeId };
  }

  async setSessionConfigOption(agentId: string, configId: string, value: ConfigValue) {
    const binding = this.requireBinding(agentId);
    if (binding.activeTurn || binding.deferredConfigFlush) {
      const changes = [{ configId: String(configId || ''), value }];
      return this.deferSessionConfigChanges(binding, changes);
    }
    this.requireConfigMutationReady(binding);
    const result = await this.enqueueSessionConfigMutation(binding, () => (
      this.setSessionConfigOptionNow(binding, configId, value)
    ));
    this.rememberSessionConfigOverrides(binding, [{ configId: String(configId || ''), value }]);
    if (this.clearDeferredSessionError(binding)) {
      binding.updatedAt = new Date().toISOString();
      this.emitRuntime(binding);
    }
    return result;
  }

  async setSessionConfigOptionNow(
    binding: AcpBinding,
    configId: string,
    value: ConfigValue,
    options: PrepareAgentOptions = {},
  ) {
    this.requireOpenBinding(binding);
    const option = binding.configOptions?.find(candidate => candidate.id === String(configId || ''));
    if (
      providerAcpConfigPolicy(binding.provider)?.coupleModelAndReasoning === true
      && option?.type === 'select'
      && /(^|[\s_-])model([\s_-]|$)/i.test(`${option.id} ${option.name || ''} ${option.category || ''}`)
    ) {
      // Let the adapter choose a supported fallback effort from its current
      // snapshot first. The refresh extension requires an explicit effort and
      // would otherwise reject a valid model change (for example ultra -> a
      // model that tops out at max).
      await this.applySessionConfigOption(binding, configId, value, { ...options, emit: false });
      const reasoning = binding.configOptions?.find(candidate => (
        candidate.type === 'select'
        && /(reasoning|thought)/i.test(`${candidate.id} ${candidate.name || ''} ${candidate.category || ''}`)
      ));
      if (typeof reasoning?.currentValue === 'string' && reasoning.currentValue) {
        await this.refreshCodexSessionModel(binding, String(value ?? ''), reasoning.currentValue);
        return this.applySessionConfigOption(binding, configId, value, { ...options, force: true });
      }
      this.emitSession(binding);
      return { sessionId: binding.sessionId, configOptions: binding.configOptions };
    }
    return this.applySessionConfigOption(binding, configId, value, options);
  }

  async setSessionConfigOptions(agentId: string, changes: SessionConfigChange[]) {
    const binding = this.requireBinding(agentId);
    if (binding.activeTurn || binding.deferredConfigFlush) {
      return this.deferSessionConfigChanges(binding, changes);
    }
    this.requireConfigMutationReady(binding);
    const result = await this.enqueueSessionConfigMutation(binding, () => (
      this.setSessionConfigOptionsNow(binding, changes)
    ));
    this.rememberSessionConfigOverrides(binding, changes);
    if (this.clearDeferredSessionError(binding)) {
      binding.updatedAt = new Date().toISOString();
      this.emitRuntime(binding);
    }
    return result;
  }

  rememberSessionConfigOverrides(binding: AcpBinding, changes: SessionConfigChange[]) {
    const merged = new Map<string, SessionConfigChange>();
    for (const change of normalizeSessionConfigChanges(binding.restartOptions.configOverrides)) {
      merged.set(change.configId, change);
    }
    for (const change of normalizeSessionConfigChanges(changes)) {
      merged.set(change.configId, change);
    }
    const configOverrides = [...merged.values()];
    binding.restartOptions = { ...binding.restartOptions, configOverrides };
    const changedIds = new Set(normalizeSessionConfigChanges(changes).map(change => change.configId));
    binding.configOverrideWarnings = binding.configOverrideWarnings.filter(warning => !changedIds.has(warning.configId));
    this.emit('config-overrides', {
      agentId: binding.agentId,
      sessionId: binding.sessionId,
      configOverrides: configOverrides.map(change => ({
        configId: change.configId,
        value: Array.isArray(change.value) ? [...change.value] : change.value,
      })),
    });
  }

  sessionConfigOverrideCompatibility(binding: AcpBinding, change: SessionConfigChange) {
    const option = binding.configOptions?.find(candidate => candidate.id === change.configId);
    const displayName = String(option?.name || change.configId);
    const displayValue = JSON.stringify(change.value);
    if (!option) return `Saved ACP setting “${displayName}” (${displayValue}) is no longer available`;
    if (option.type === 'boolean' && typeof change.value !== 'boolean') {
      return `Saved ACP setting “${displayName}” no longer accepts ${displayValue}`;
    }
    if (option.type === 'select') {
      if (typeof change.value !== 'string') {
        return `Saved ACP setting “${displayName}” no longer accepts ${displayValue}`;
      }
      if (!sessionConfigSelectValues(option).includes(change.value)) {
        return `Saved ACP setting “${displayName}” value ${displayValue} is no longer available`;
      }
    }
    return '';
  }

  async restoreSessionConfigOverrides(binding: AcpBinding, overrides: SessionConfigChange[]) {
    const normalized = normalizeSessionConfigChanges(overrides);
    const modelOverrides: SessionConfigChange[] = [];
    const remainingOverrides: SessionConfigChange[] = [];
    for (const change of normalized) {
      const option = binding.configOptions?.find(candidate => candidate.id === change.configId);
      const isModel = option?.type === 'select' && (
        option.category === 'model'
        || (
          providerAcpConfigPolicy(binding.provider)?.matchModelByName === true
          && /(^|[\s_-])model([\s_-]|$)/i.test(`${option.id} ${option.name || ''}`)
        )
      );
      (isModel ? modelOverrides : remainingOverrides).push(change);
    }

    const retained: SessionConfigChange[] = [];
    const warnings: AcpConfigOverrideWarning[] = [];
    for (const change of [...modelOverrides, ...remainingOverrides]) {
      const incompatibility = this.sessionConfigOverrideCompatibility(binding, change);
      if (incompatibility) {
        warnings.push({ configId: change.configId, message: incompatibility });
        continue;
      }
      try {
        await this.setSessionConfigOptionNow(binding, change.configId, change.value, { maxAttempts: 1 });
        retained.push(change);
      } catch (error) {
        const option = binding.configOptions?.find(candidate => candidate.id === change.configId);
        const displayName = String(option?.name || change.configId);
        retained.push(change);
        warnings.push({
          configId: change.configId,
          message: `Saved ACP setting “${displayName}” (${JSON.stringify(change.value)}) could not be restored: ${acpErrorMessage(error)}`,
        });
      }
    }

    binding.configOverrideWarnings = warnings;
    binding.restartOptions = { ...binding.restartOptions, configOverrides: retained };
    if (!sameSessionConfigChanges(normalized, retained)) {
      this.emit('config-overrides', {
        agentId: binding.agentId,
        sessionId: binding.sessionId,
        configOverrides: retained.map(change => ({
          configId: change.configId,
          value: Array.isArray(change.value) ? [...change.value] : change.value,
        })),
      });
    }
    if (warnings.length > 0) {
      console.warn(
        `ACP config override recovery for Agent ${binding.agentId}:`,
        warnings.map(warning => warning.message).join('; '),
      );
    }
  }

  async deferSessionConfigChanges(binding: AcpBinding, changes: SessionConfigChange[]) {
    const normalized = Array.isArray(changes)
      ? changes.filter(change => change && typeof change.configId === 'string' && change.configId)
      : [];
    if (normalized.length === 0) throw new Error('ACP config options are required');
    for (const change of normalized) {
      this.requireSessionConfigOption(binding, change.configId, change.value);
    }
    const accepted = normalized.map(change => ({ configId: change.configId, value: change.value }));
    const previous = new Map<string, SessionConfigChange | undefined>();
    for (const change of accepted) {
      if (!previous.has(change.configId)) previous.set(change.configId, binding.deferredConfigChanges.get(change.configId));
      binding.deferredConfigChanges.set(change.configId, change);
    }
    try {
      await this.writeCheckpoint(binding);
    } catch (error) {
      for (const change of accepted) {
        if (binding.deferredConfigChanges.get(change.configId) !== change) continue;
        const previousChange = previous.get(change.configId);
        if (previousChange) binding.deferredConfigChanges.set(change.configId, previousChange);
        else binding.deferredConfigChanges.delete(change.configId);
      }
      throw error;
    }
    binding.updatedAt = new Date().toISOString();
    this.emitRuntime(binding);
    return {
      sessionId: binding.sessionId,
      deferred: true,
      configOptions: binding.configOptions,
      deferredConfigOptions: [...binding.deferredConfigChanges.values()],
      deferredModeId: binding.deferredModeId,
    };
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
    for (const change of normalized) {
      this.requireSessionConfigOption(binding, change.configId, change.value);
    }
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
    if (providerAcpConfigPolicy(binding.provider)?.coupleModelAndReasoning && modelChange && reasoningChange) {
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
    const currentOption = this.requireSessionConfigOption(binding, normalizedConfigId, value);
    if (options.force !== true && currentOption?.currentValue === value) {
      if (options.emit !== false) this.emitSession(binding);
      return { sessionId: binding.sessionId, configOptions: binding.configOptions };
    }
    const request = typeof value === 'boolean'
      ? { sessionId: binding.sessionId, configId: normalizedConfigId, type: 'boolean', value }
      : { sessionId: binding.sessionId, configId: normalizedConfigId, value: String(value ?? '') };
    let response;
    const maxAttempts = options.maxAttempts === 1 ? 1 : 2;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      response = await withTimeout(
        binding.connection.setSessionConfigOption(request),
        this.requestTimeoutMs,
        'ACP session/set_config_option'
      );
      this.requireOpenBinding(binding);
      binding.configOptions = response?.configOptions || binding.configOptions;
      const confirmed = binding.configOptions?.find(candidate => candidate.id === normalizedConfigId);
      if (confirmed?.currentValue === request.value) break;
      if (attempt === maxAttempts - 1) {
        throw new Error(`ACP Agent did not confirm config option ${normalizedConfigId}`);
      }
    }
    this.requireSessionState(binding).configOptions = JSON.parse(JSON.stringify(binding.configOptions));
    this.scheduleCheckpoint(binding, { exact: true });
    if (options.emit !== false) this.emitSession(binding);
    return { sessionId: binding.sessionId, configOptions: binding.configOptions };
  }

  requireSessionConfigOption(binding: AcpBinding, configId: string, value: ConfigValue) {
    const option = binding.configOptions?.find(candidate => candidate.id === configId);
    if (!option) throw new Error(`ACP Agent did not advertise config option ${configId}`);
    if (option.type === 'boolean' && typeof value !== 'boolean') {
      throw new Error(`ACP config option ${configId} requires a boolean value`);
    }
    if (option.type === 'select' && typeof value !== 'string') {
      throw new Error(`ACP config option ${configId} requires a string value`);
    }
    return option;
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
      retryableReconnect: binding.retryableReconnect === true,
      stopReason: binding.stopReason,
      supportsSteer: binding.supportsSteer === true,
      supportsFork: Boolean(
        binding.initializeResponse?.agentCapabilities?.sessionCapabilities?.fork
        && binding.initializeResponse?.agentCapabilities?.loadSession
      ),
      protocolVersion: binding.initializeResponse?.protocolVersion || null,
      agentInfo: binding.initializeResponse?.agentInfo || null,
      capabilities: binding.initializeResponse?.agentCapabilities || {},
      authMethods: binding.initializeResponse?.authMethods || [],
      modes: binding.modes,
      configOptions: binding.configOptions,
      configOverrideWarnings: binding.configOverrideWarnings,
      deferredConfigOptions: [...binding.deferredConfigChanges.values()],
      deferredModeId: binding.deferredModeId,
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
    return binding.sessionState.snapshot(runtimeState, options);
  }

  async getSessionForRead(
    agentId: string,
    options: SnapshotOptions = {},
  ): Promise<AcpSessionSnapshot> {
    return this.getSession(agentId, options);
  }

  getTranscriptSession(agentId: string, options: TranscriptSliceOptions = {}) {
    const binding = this.requireBinding(agentId);
    const slice = binding.sessionState.transcriptSlice(options);
    return {
      version: 2,
      protocol: 'acp',
      provider: binding.provider,
      sessionId: binding.sessionId,
      cwd: binding.cwd,
      title: binding.sessionState.title,
      updatedAt: binding.updatedAt,
      truncated: binding.sessionState.truncated === true,
      state: binding.state,
      error: binding.error,
      errorKind: binding.error ? acpErrorKind(binding.error) : '',
      retryableReconnect: binding.retryableReconnect === true,
      stopReason: binding.stopReason,
      plan: binding.sessionState.plan == null
        ? null
        : JSON.parse(JSON.stringify(binding.sessionState.plan)),
      ...slice,
    };
  }

  transcriptSessionFromState(
    binding: AcpBinding,
    state: AcpSessionState,
    options: TranscriptSliceOptions = {},
  ) {
    const slice = state.transcriptSlice(options);
    return {
      version: 2,
      protocol: 'acp',
      provider: binding.provider,
      sessionId: binding.sessionId,
      cwd: binding.cwd,
      title: state.title,
      updatedAt: binding.updatedAt,
      truncated: state.truncated === true,
      state: binding.state,
      error: binding.error,
      errorKind: binding.error ? acpErrorKind(binding.error) : '',
      retryableReconnect: binding.retryableReconnect === true,
      stopReason: binding.stopReason,
      plan: state.plan == null ? null : JSON.parse(JSON.stringify(state.plan)),
      ...slice,
    };
  }

  async getTranscriptSessionForRead(agentId: string, options: TranscriptSliceOptions = {}) {
    return this.getTranscriptSession(agentId, options);
  }

  getToolEntry(agentId: string, toolCallId: string) {
    const binding = this.requireBinding(agentId);
    const state = binding.sessionState;
    const entry = state?.toolEntries.get(String(toolCallId || ''));
    if (!entry || !state || state.isInternalEntry(entry)) return null;
    const visible = JSON.parse(JSON.stringify(entry));
    visible.content = (Array.isArray(visible.content) ? visible.content : []).map((block: PromptBlock) => {
      if (block?.type !== 'terminal') return block;
      const terminal = this.clientTerminals.display(block.terminalId);
      return terminal ? { ...block, terminal } : block;
    });
    return visible;
  }

  async getToolEntryForRead(agentId: string, toolCallId: string) {
    return this.getToolEntry(agentId, toolCallId);
  }

  getTranscriptEntry(agentId: string, entryId: string) {
    const binding = this.requireBinding(agentId);
    const state = binding.sessionState;
    const entries = (state?.entries || []).filter((candidate: TranscriptEntry) => (
      String(candidate?.id || '') === String(entryId || '')
    ));
    if (entries.length !== 1) return null;
    const [entry] = entries;
    if (!entry || !state || state.isInternalEntry(entry)) return null;
    return entry;
  }

  async getTranscriptEntryForRead(agentId: string, entryId: string) {
    return this.getTranscriptEntry(agentId, entryId);
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
    const state = this.requireSessionState(binding);
    const entry = state.toolEntries.get(String(toolCallId || ''));
    if (entry && state.isInternalEntry(entry)) throw new Error('ACP tool call not found');
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

  async getSubagentTranscriptSessionForRead(
    agentId: string,
    sessionId: string,
    options: TranscriptSliceOptions = {},
  ) {
    return this.getSubagentTranscriptSession(agentId, sessionId, options);
  }

  hasBinding(agentId: string) {
    return this.bindings.has(agentId);
  }

  bindingEpoch(agentId: string): string {
    return String(this.bindings.get(agentId)?.capabilityRuntimeEpoch || '');
  }

  transcriptProjectionRevision(agentId: string): number {
    return Number(this.bindings.get(agentId)?.transcriptProjectionRevision || 0);
  }

  transcriptSettled(agentId: string): boolean {
    const binding = this.bindings.get(agentId);
    return Boolean(
      binding
      && !binding.historyReplayActive
      && binding.state !== 'connecting'
      && binding.state !== 'reconnecting'
    );
  }

  requireBinding(agentId: string) {
    const binding = this.bindings.get(agentId);
    if (!binding) throw new Error('ACP Agent is not registered');
    return binding;
  }

  requireSessionState(binding: AcpBinding) {
    if (!binding.sessionState) throw new Error('ACP session reducer is not loaded');
    return binding.sessionState;
  }

  emitRuntime(binding: AcpBinding) {
    if (!this.isCurrentBinding(binding)) return false;
    binding.transcriptProjectionRevision += 1;
    this.emit('agent-runtime', {
      agentId: binding.agentId,
      provider: binding.provider,
      sessionId: binding.sessionId,
      state: binding.state,
      error: binding.error,
      errorKind: binding.error ? acpErrorKind(binding.error) : '',
      retryableReconnect: binding.retryableReconnect === true,
      stopReason: binding.stopReason,
      supportsSteer: binding.supportsSteer === true,
      supportsFork: Boolean(
        binding.initializeResponse?.agentCapabilities?.sessionCapabilities?.fork
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
    binding.transcriptProjectionRevision += 1;
    this.emit('session', {
      agentId: binding.agentId,
      updatedAt: binding.updatedAt,
      revision: binding.sessionState.revision,
      title: binding.sessionState.title,
    });
    return true;
  }

  handleRuntimeExit(runtime: AcpRuntimeProcess, error: unknown) {
    if (!runtime || runtime.exited) return;
    runtime.exited = true;
    if (this.runtimeProcesses.get(runtime.key) === runtime) {
      this.runtimeProcesses.delete(runtime.key);
    }
    for (const binding of runtime.bindings.values()) this.handleExit(binding, error);
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
      binding.retryableReconnect = isSafeProviderSessionId(binding.sessionId);
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
    const runtime = binding.runtime;
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
    binding.activeElicitations.clear();
    binding.interactionOrigins.clear();
    binding.subagentStates.clear();
    binding.subagentControls.clear();
    this.clientTerminals.cleanupAgent(binding.agentId);
    this.releaseRuntimeSessions(binding);
    if (runtime) {
      runtime.bindings.delete(binding.agentId);
      runtime.handlers.delete(binding.agentId);
    }
    return true;
  }

  unregisterAgent(agentId: string, expectedBinding: AcpBinding | null = null) {
    const binding = this.bindings.get(agentId);
    if (expectedBinding && binding !== expectedBinding) return;
    if (!binding) return;
    const runtime = binding.runtime;
    if (runtime && !runtime.exited && !runtime.stopping && runtime.bindings.size > 1) {
      const connection = binding.connection;
      const sessionId = binding.sessionId;
      const closeSession = sessionId
        && binding.state !== 'closed'
        && Boolean(binding.initializeResponse?.agentCapabilities?.sessionCapabilities?.close);
      if (!this.detachAgentBinding(binding)) return;
      void (async () => {
        if (closeSession) {
          await withTimeout(
            connection.closeSession({ sessionId }),
            this.requestTimeoutMs,
            'ACP shared session/close',
          );
        }
      })().catch(() => {});
      return;
    }
    if (!this.detachAgentBinding(binding)) return;
    if (!runtime || runtime.bindings.size > 0) return;
    runtime.stopping = true;
    this.runtimeStarts.delete(runtime.key);
    if (this.runtimeProcesses.get(runtime.key) === runtime) this.runtimeProcesses.delete(runtime.key);
    try {
      runtime.connection?.close();
    } catch {
      // Process signaling below remains authoritative.
    }
    if (runtime.child?.stdin?.writable && !runtime.child.stdin.destroyed) {
      try {
        runtime.child.stdin.end();
      } catch {
        // Process signaling below remains authoritative.
      }
    }
    signalProcessTree(runtime, 'SIGTERM');
  }

  async unregisterAgentAndWait(agentId: string, expectedBinding: AcpBinding | null = null) {
    const binding = this.bindings.get(agentId);
    if (expectedBinding && binding !== expectedBinding) return false;
    if (!binding) return false;
    const runtime = binding.runtime;
    if (!runtime) return false;
    if (!runtime.exited && !runtime.stopping && runtime.bindings.size > 1) {
      if (binding.activeTurn) await this.cancel(agentId);
      if (binding.sessionId && binding.state !== 'closed') {
        const capabilities = binding.initializeResponse?.agentCapabilities?.sessionCapabilities;
        if (capabilities?.close) {
          await withTimeout(
            binding.connection.closeSession({ sessionId: binding.sessionId }),
            this.requestTimeoutMs,
            'ACP shared session/close',
          );
          if (!this.isOpenBinding(binding)) {
            throw new Error('ACP Agent binding closed before shared Session release completed');
          }
        }
      }
      if (!this.detachAgentBinding(binding, { retainForCleanup: true })) return false;
      if (this.bindings.get(agentId) === binding) this.bindings.delete(agentId);
      return true;
    }
    runtime.stopping = true;
    this.runtimeStarts.delete(runtime.key);
    if (!this.detachAgentBinding(binding, { retainForCleanup: true })) return false;
    try {
      runtime.connection?.close();
    } catch {
      // Process cleanup below remains authoritative.
    }
    if (runtime.child?.stdin?.writable && !runtime.child.stdin.destroyed) {
      try {
        runtime.child.stdin.end();
      } catch {
        // Process cleanup below remains authoritative.
      }
    }
    await this.stopProcessTreeAndWait(runtime);
    runtime.exited = true;
    if (this.configDir && runtime.processIdentity) {
      unregisterConfigProcessGroup(this.configDir, 'acp-provider', runtime.processIdentity);
    }
    if (this.runtimeProcesses.get(runtime.key) === runtime) {
      this.runtimeProcesses.delete(runtime.key);
    }
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
  steeringMethod,
  isSteerUnavailableError,
  normalizeCodexHostMessageUpdate,
  CODEX_STEER_METHOD,
  SESSION_STEERING_METHOD,
  deleteProviderSessionIdentity,
};
