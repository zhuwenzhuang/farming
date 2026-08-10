import { EventEmitter } from 'events';
import type {
  AcpConfigChange,
  AcpConfigOverridesEvent,
  AcpConfigValue,
  AcpTranscriptEntry,
  AcpBindingContract,
  AcpForkOptions,
  AcpPrepareResult,
  AcpPromptBlock,
  AcpProcessIdentity,
  AcpRuntimeEvent,
  AcpSessionListOptions,
  AcpSessionRequestOptions,
  AcpSessionEvent,
  AgentProviderSessionPlan,
  AgentForkResult,
  AgentHistorySession,
  AgentRestartResult,
  AcpRuntimeContract as DeclaredAcpRuntimeContract,
  ArchiveCodexSessionContract,
  BuildAgentProviderSessionPlanContract,
  ExactResumeSession,
  AgentDisposeOptions,
  AgentShellEnvOptions,
  AgentStartAdmission,
  AgentStartOutcome,
  AgentStartReservation,
  CreateRequestAdmission,
  CreateProviderSessionIdentityContract,
  DeleteProviderSessionIdentityContract,
  ProviderSessionIdentityRequest,
  ProviderSessionIdentity,
  ProviderSessionRollbackIdentity,
  ProviderResumeOptions,
  ProviderStartOptions,
  RuntimeBindingRegistry,
  RuntimeLifecycleEntry,
  SessionFromExactResumeSourceContract,
  StopPersistedAcpProcessResult,
  StopPersistedAcpProcessGroupContract,
  TargetProcessAcpForkOptions,
  UnarchiveCodexSessionContract,
} from './agent-manager-provider-types.js';
import type {
  TerminalSessionActivityEvent,
  TerminalSessionBusyStateEvent,
  TerminalSessionErrorEvent,
  TerminalSessionExitEvent,
  TerminalSessionNotificationEvent,
  TerminalSessionOutputEvent,
  TerminalSessionPreviewEvent,
  TerminalSessionSnapshotEvent,
  TerminalSessionStateEvent,
  TerminalSessionTitleEvent,
  TerminalSessionTransitionEvent,
  SessionEngineBridgeContract as DeclaredSessionEngineBridgeContract,
  RecoveredEngineSession,
  RuntimeEngineMetadata,
  RuntimeRotationRecord,
  SessionEngineContract,
  SessionEngineResolutionContract,
  SerializedTerminalStateEntry,
  TerminalAttachCheckpoint,
  TerminalClearResult,
  TerminalEngineLaunch,
  TerminalInputResult,
  TerminalResizeResult,
  TerminalSessionState,
} from './agent-manager-engine-types.js';
import type {
  AcpRuntimeBinding,
  AgentManagerConfig,
  AgentRecord as TypedAgentRecord,
  CreatePermanentWorktreeOptions,
  CreatePermanentWorktreeResult,
  DeleteProjectWorktreeOptions,
  DeleteProjectWorktreeResult,
  ProjectMembershipPatch,
  ProjectOperation,
  ProjectOperationRequest,
  ProjectOperationResult,
  ProjectOperationState,
  ProjectOperationType,
  ProjectOperationAdmission,
  ProjectWorkspaceDeleteAdmission,
  CodexSessionMutationAdmission,
  PersistedAgentPrivateMetadata,
  RecoveredEngineSessionMetadata,
  StructuredRuntimeProcessIdentity,
  TerminalRecoveryCandidate,
  WorktreeListEntry,
} from './agent-manager-record-types.js';
import type { AgentHome } from './config-manager.cjs';
import type {
  ErrorLike,
  ArchiveAgentOptions,
  ArchiveAgentResult,
  ForkAgentOptions,
  KillAgentOptions,
  KillAgentResult,
  DeleteAgentOptions,
  LifecycleJournal,
  LifecycleOperation,
  LifecycleOperationRequest,
  LifecycleOperationResult,
  LifecycleOperationState,
  LifecycleOperationType,
  LifecyclePreviousState,
} from './agent-manager-lifecycle-types.js';

const PREPARED_ACP_TRANSCRIPT_TURN_LIMIT = 5;
const PREPARED_ACP_TRANSCRIPT_QUIET_MS = 60;
const AGENT_WORKTREE_REFRESH_CONCURRENCY = 4;

const { execFile } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { promisify } = require('util');
import { SystemMonitor } from './system-monitor.cjs';
import { SessionEngineBridge } from './session-engine-bridge.cjs';
import { isSupportedHistoryAgent, parseCommand, resolveLaunchCommand } from './cli-agents.cjs';
import { buildAgentSessionResumeCommand, findAgentSession } from './agent-session-history.cjs';
import { archiveCodexSession, unarchiveCodexSession } from './codex-session-archive.cjs';
import { buildAgentProviderSessionPlan, sessionFromExactResumeSource } from './agent-provider-session.cjs';
import {
  getFarmingOwnedExecutableCandidates,
  resolveAgentExecutable,
  resolveFarmingOwnedExecutable,
  resolveTerminalCodexExecutable,
  resolveTerminalExecutable,
  validatePersistedAcpExecutable,
} from './executable-discovery.cjs';
import { ensureMainAgentSkillFiles, renderMainAgentBootstrap } from './main-agent-skills.cjs';
import {
  renderFarmingAgentBootstrap,
} from './farming-agent-bootstrap.cjs';
import { canonicalProviderSessionKey, mainPageAgentSessionKey, resumedAgentSource } from './main-page-session.cjs';
import * as storageLayout from './storage-layout.cjs';
import { isSafeProviderSessionId, isTemporaryProviderSessionId } from './provider-session-id.cjs';
import {
  ProviderSessionService,
  type ProviderSessionChange,
} from './provider-session-service.cjs';
import {
  isAgentRuntimeModeRequest,
  legacyRuntimeMetadata,
  publicRuntimeBinding,
  replaceRuntimeBinding,
  RuntimeAgentMap,
  runtimeBindingFor,
  runtimeBindingOf,
  runtimeKind,
  type AgentRuntimeModeRequest,
} from './agent-runtime-binding.cjs';
import {
  deriveRuntimeObservation,
  type TerminalObservationStatus,
} from './runtime-observation.cjs';
import {
  applyProviderLaunchEnvironment,
  clearProviderHomeEnvironment,
  getProviderAdapter,
  isFreshAcpSessionSource,
  providerCapabilities,
  providerConversationForkCapability,
  providerForProgram,
  providerSupportsRuntime,
  providerTerminalStartupPolicy,
} from './provider-adapters.cjs';
import { deriveTerminalStatus } from './terminal-status.cjs';
import { AcpRuntime, stopPersistedAcpProcessGroup } from './acp-runtime.cjs';
import { AcpRuntimeHostRuntime } from './acp-runtime-host-runtime.cjs';
import { AcpPreparedTranscriptCache } from './acp-prepared-transcript-cache.cjs';
import { chatRuntimeForProvider, isChatMode } from './chat-runtime.cjs';
import { acpTranscriptEntries, acpTranscriptMedia, acpToolChanges, acpToolDetail, acpToolReviewChanges } from './acp-transcript.cjs';
import {
  applyCodexTerminalProfile,
  codexTerminalProfileFromOutput,
  codexTerminalProfileFromPreview,
  codexTerminalSessionIdFromStatus,
  isCodexTerminalComposerPreview,
  resolveCodexTerminalSessionId,
} from './codex-terminal-profile.cjs';
import { AgentOrderAllocator, finiteOrder, reorderedPinnedAgentOrders, reorderedProjectAgentOrders } from './agent-order.cjs';
import { commitAgentOrderTransaction } from './agent-order-transaction.cjs';
import { buildInteractiveAgentBaseEnv, normalizeInteractiveTerminalEnv, resolveUserShellEnvSync } from './agent-env.cjs';
import { inspectGitWorktree } from './git-worktree-info.cjs';
import { isSameOrDescendantPath } from './path-containment.cjs';
import { AgentWorktreeRefreshQueue } from './agent-worktree-refresh-queue.cjs';
import { AgentAdaptiveTitlePersistenceCoordinator } from './agent-adaptive-title-persistence.cjs';
import {
  WorktreeGitService,
  type TemporaryWorktreeIdentity,
  type WorktreeGitServicePort,
} from './worktree-git-service.cjs';
import { ForkOperationCoordinator, settleForkChildStart } from './fork-operation-coordinator.cjs';
import {
  AgentInputCoordinator,
  type InputOperation,
  type InputQueueOptions,
  type ReleasedInputOperation,
} from './agent-input-coordinator.cjs';
import { TerminalStartupCoordinator } from './terminal-startup-coordinator.cjs';
import { TerminalResizeCoordinator } from './terminal-resize-coordinator.cjs';
import {
  AgentComposerAdmissionCoordinator,
  composerAdmissionError,
  normalizedComposerCommands,
  normalizedComposerPrompt,
} from './agent-composer-admission.cjs';
import {
  AGENT_USAGE_RATE_WINDOW_MS,
  agentUsageRateWindowMs,
} from './agent-usage-rate.cjs';
import type {
  AgentUsageRate,
  UsageRateOptions,
} from './agent-usage-rate.cjs';
import { AgentUsageRateTracker } from './agent-usage-rate-tracker.cjs';
import {
  AgentAttentionTracker,
  agentAttentionUnread,
} from './agent-attention.cjs';
import { deserializeTerminalState } from './terminal-state-serialization.cjs';
import type { TranscriptBuildOptions } from './codex-transcript.cjs';
import { compareNativePtyRuntimeEpochs } from './native-pty-controller-generation.cjs';
import { canonicalWorkspacePath } from './workspace-root-registry.cjs';
import { configInstanceFingerprint as fingerprintConfigInstance } from './config-instance.cjs';
import { stripLegacyFarmingCapabilityMcpServers } from './provider-mcp-sanitizer.cjs';
import { acpLastAssistantNotificationSummary, acpTurnHandleIsNewer, agentNotificationSummary } from './acp-turn-summary.cjs';
import { TERMINAL_OPERATION_STATES, activeLifecycleOperation, beginLifecycleOperation, latestLifecycleOperation, lifecycleJournal, setLifecycleOperationResult, transitionLifecycleOperation } from './agent-lifecycle-journal.cjs';

type UnknownRecord = Record<string, unknown>;
type AgentRecord = TypedAgentRecord;

type AgentId = string;
type TerminalInput = string | readonly unknown[];
type RuntimeKind = 'terminal' | 'acp';
type ErrorRecord = Omit<ErrorLike, 'code'> & Record<string, unknown> & {
  code?: string | number;
};
type MutableError = Error & { code?: string | number };
type RecoveredSessionStateInput = Partial<Omit<TerminalSessionState, 'status'>> & {
  status: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isAcpTranscriptEntry(value: unknown): value is AcpTranscriptEntry {
  return isRecord(value);
}

interface LifecycleJournalContract {
  entries: LifecycleOperation[];
}

interface RuntimeBindingContract {
  kind: RuntimeKind;
  state?: string;
  error?: string;
}

interface AgentStartOptions extends UnknownRecord {
  createRequestId?: string;
  lifecycleToken?: symbol;
  onAgentRegistered?: (agentId: AgentId) => void;
  projectWorkspace?: string;
  providerSessionId?: string;
  providerSessionProvider?: string;
  skipRecoveryWait?: boolean;
  startAdmissionToken?: symbol;
  wantsMain?: boolean;
}

type AgentStartCallback = (
  agentId: AgentId | null,
  error?: string | null,
  metadata?: UnknownRecord,
) => void;

interface TerminalInputOptions extends UnknownRecord {
  expectedRuntimeEpoch?: string;
  markUserInput?: boolean;
  throwOnUncertain?: boolean;
}

interface ComposerMessageOptions extends UnknownRecord {
  delivery?: 'auto' | 'prompt' | 'steer';
  requestId?: string;
  retryDefinitiveFailure?: boolean;
}

interface InterruptOptions extends UnknownRecord {
  expectedRuntimeEpoch?: string;
}

interface ClearTerminalOptions extends UnknownRecord {
  expectedRuntimeEpoch?: string;
}

interface ComposerSubmissionResult extends Record<string, unknown> {
  kind: RuntimeKind;
  sessionId?: string;
}

interface ComposerSendOptions extends ComposerMessageOptions {
  assertDeliveryOwner?: () => void;
  expectedTerminalAgent?: AgentRecord;
  expectedTerminalRuntimeEpoch?: string;
  onSubmitted?: (result: ComposerSubmissionResult) => void;
  requireConfirmedTerminalDelivery?: boolean;
  releaseInput?: () => void;
}

interface CodexTerminalProfileRequest extends Record<string, unknown> {
  model?: string;
  reasoningEffort?: string;
  serviceTier?: string;
}

interface CodexTerminalProfileOptions {
  onInputSafe?: () => void;
  signal?: AbortSignal;
  timeoutMs?: number;
}

type PersistentAgentUpdateAdmission =
  | {
      conflict?: LifecycleOperation;
      error: string;
      operation?: never;
      deduplicated?: never;
      joined?: never;
    }
  | {
      error?: undefined;
      operation: LifecycleOperation;
      deduplicated?: boolean;
      joined?: boolean;
    };

interface AgentOrderNeighbors {
  afterAgentId?: string;
  beforeAgentId?: string;
}

type AgentOrderField = 'pinnedOrder' | 'projectOrder';
type AgentOrderUpdates = Map<string, number>;

interface AgentLifecycleEntry<Result = unknown> {
  agentIds: Set<AgentId>;
  key: string;
  kind: string;
  label: string;
  promise: Promise<Result>;
  token: symbol;
}

interface RuntimeReplacementResult {
  error: string;
  restartedAgentId: string;
}

interface ProviderSessionContract {
  provider: string;
  sessionId: string;
  providerHomeId?: string;
  providerHomePath?: string;
  runtimeBinding?: RuntimeBindingContract | null;
  sessionKey?: string;
  source?: string;
  temporary?: boolean;
  title?: string;
}

interface AgentSessionViewContract extends UnknownRecord {
  agentId: AgentId;
  previewCols?: number;
  previewRows?: number;
  previewSnapshot?: unknown;
  previewText?: string;
  runtimeEpoch?: string;
  outputSeq?: number | null;
  stateRevision?: number | null;
  terminalStatus?: TerminalObservationStatus;
}

interface ComposerContentPart extends UnknownRecord {
  type: string;
  text?: string;
}

function normalizeAcpConfigOverrides(value: unknown): AcpConfigChange[] {
  const overrides = new Map<string, AcpConfigChange>();
  for (const item of Array.isArray(value) ? value.slice(0, 64) : []) {
    if (!isRecord(item) || typeof item.configId !== 'string') continue;
    const configId = item.configId;
    if (!configId.trim() || configId.length > 256) continue;
    const configValue = item.value;
    if (
      configValue !== null
      && !['string', 'number', 'boolean'].includes(typeof configValue)
      && !(Array.isArray(configValue) && configValue.every(entry => typeof entry === 'string'))
    ) continue;
    overrides.set(configId, {
      configId,
      value: Array.isArray(configValue) ? [...configValue] : configValue as AcpConfigValue,
    });
  }
  return [...overrides.values()];
}

function cloneAcpConfigOverrides(value: unknown): AcpConfigChange[] {
  return normalizeAcpConfigOverrides(value).map(change => ({
    configId: change.configId,
    value: Array.isArray(change.value) ? [...change.value] : change.value,
  }));
}

interface AcpSessionOptionsRecord {
  additionalDirectories: string[];
  configOverrides: AcpConfigChange[];
  mcpServers: UnknownRecord[];
}

export interface AgentPublicState extends UnknownRecord {
  id: AgentId;
}

export interface AgentManagerState {
  agents: AgentPublicState[];
  mainAgentId: AgentId | null;
  taskHistory: UnknownRecord[];
}

export interface AgentManagerStateChange {
  agentIds?: AgentId[];
  mainAgentIdChanged?: boolean;
  removedAgentIds?: AgentId[];
  taskHistoryChanged?: boolean;
}

interface TerminalStatusOverrides extends Record<string, unknown> {
  cwd?: string;
  previewText?: string;
  shellCommand?: string;
  shellCommandStartedAt?: number | null;
  shellLastCommand?: string;
  shellLastCommandDurationMs?: number | null;
  shellLastCommandFinishedAt?: number | null;
  shellLastCommandStartedAt?: number | null;
  status?: string;
  terminalBusy?: boolean | null;
  title?: string;
}

interface TerminalStateCursor {
  runtimeEpoch: string;
  outputSeq: number;
  stateRevision: number;
}

type TerminalStateDisposition =
  | 'current'
  | 'new-epoch'
  | 'duplicate'
  | 'stale'
  | 'unversioned';

interface ProviderSessionDeleteOptions {
  provider?: string;
  sessionId?: string;
  executable?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

interface AgentManagerOptions extends UnknownRecord {
  acpRuntime?: AcpRuntimeContract;
  agentShellEnvProvider?: (shell: string) => NodeJS.ProcessEnv | null;
  allowUnprovenLegacyAcpRecovery?: boolean;
  archiveCodexSession?: ArchiveCodexSessionContract;
  authDisabled?: boolean;
  cliBinDir?: string;
  controlUrl?: string;
  createProviderSessionIdentity?: CreateProviderSessionIdentityContract;
  deleteProviderSessionIdentity?: DeleteProviderSessionIdentityContract;
  skipExecutablePreflight?: boolean;
  stopPersistedAcpProcessGroup?: StopPersistedAcpProcessGroupContract;
  tokenFile?: string;
  transcriptMediaPathPrefix?: (agentId: string) => string;
  unarchiveCodexSession?: UnarchiveCodexSessionContract;
  worktreeGitService?: WorktreeGitServicePort;
}

interface AgentResourceBinding {
  agentId: string;
  workspace: string;
}

interface AcceptedKillAgentResult {
  accepted: true;
  agentId: AgentId;
  operationId: string;
  operationState: string;
  operationType: string;
}

interface KillAgentAdmission {
  completion: Promise<KillAgentResult>;
  result: KillAgentResult | AcceptedKillAgentResult;
}

interface AgentManagerConfigContract extends AgentManagerConfig {
  appendTaskHistory?(entry: UnknownRecord): void;
  getAgentHome(provider: string, homeId?: string): AgentHome | null;
  getAgentSessionRecordForProviderSessionKey(sessionKey: string): PersistedAgentPrivateMetadata | null;
  getAgentLaunchProfileForHome(provider: string, homeId?: string): UnknownRecord;
  getAgentLaunchProfiles(): UnknownRecord;
  getCodexApprovalMode(): string;
  getCodexModel(): string;
  getCodexModelPreset(): string;
  getCodexReasoningEffort(): string;
  getCodexServiceTier(): string;
  getDangerouslySkipAgentPermissionsByDefault(): boolean;
  getHeartbeatInterval(): number;
  getTaskHistory?(): UnknownRecord[];
  getWorkspace(): string;
}

interface AgentShellEnvCacheEntry {
  env: NodeJS.ProcessEnv | null;
  initialized: boolean;
  resolvedAt: number;
}

type AcpRuntimeContract = DeclaredAcpRuntimeContract;
type SessionEngineBridgeContract = DeclaredSessionEngineBridgeContract;

interface ProviderSessionServiceRuntimeContract {
  activate(agentId: string): void;
  bindConfirmed(agentId: string, provider: unknown, sessionId: string): void;
  confirm(agentId: string, session: {
    provider: string;
    sessionId: string;
    source?: string;
    title?: string;
    workspace?: string;
  }): boolean;
  dispose(): void;
  observe(agentId: string, options?: { force?: boolean }): void;
  stop(agentId: string): void;
}

const SESSION_OUTPUT_LIMIT = 10000;
const ACTIVITY_UPDATE_INTERVAL_MS = 1000;
const ACTIVITY_HOT_SEC = 30 * 60;
const ACTIVITY_WARM_SEC = 3 * 60 * 60;
const ACTIVITY_COOL_SEC = 12 * 60 * 60;
const ZOMBIE_IDLE_MS = 72 * 60 * 60 * 1000;
const ZOMBIE_SWEEP_INTERVAL_MS = 60 * 1000;
const MISSING_ENGINE_SESSION_STARTUP_GRACE_MS = 5000;
const MIN_TERMINAL_RESIZE_COLS = 40;
const MIN_TERMINAL_RESIZE_ROWS = 10;
const AGENT_DISCOVERY_CACHE_MAX_AGE_MS = 3_000;
const UNCERTAIN_TERMINAL_STOP_TIMEOUT_MS = 5_000;
const TERMINAL_STOP_STATE_READ_TIMEOUT_MS = 1_000;
const TERMINAL_STOP_POLL_MS = 50;
const CODEX_TERMINAL_STATUS_TIMEOUT_MS = 5_000;
const WORKTREE_DELETE_START_DRAIN_TIMEOUT_MS = 30_000;
const TERMINAL_NOTIFICATION_COMPLETION_SUPPRESS_MS = 10_000;
const ACP_ATTENTION_STOP_REASONS = new Set([
  'end_turn',
  'max_tokens',
  'max_turn_requests',
  'refusal',
]);
const SHELL_PROMPT_ENV_KEYS: string[] = [
  'PS1',
  'PS2',
  'PS3',
  'PS4',
  'PROMPT',
  'RPROMPT',
  'RPS1',
  'PROMPT_COMMAND',
];
const FARMING_LAUNCH_OWNED_ENV_KEYS: string[] = [
  'FARMING_AGENT_ID',
  'FARMING_AGENT_TITLE_TOKEN',
  'FARMING_BROWSER_TOKEN',
  'FARMING_CAPABILITIES_COMMAND',
  'FARMING_CAPABILITY_RUNTIME_EPOCH',
  'FARMING_CLI_BIN_DIR',
  'FARMING_COMPUTER_TOKEN',
  'FARMING_CONFIG_DIR',
  'FARMING_CONTROL_URL',
  'FARMING_DISABLE_AUTH',
  'FARMING_IS_MAIN_AGENT',
  'FARMING_MAIN_WORKSPACE',
  'FARMING_PARENT_AGENT_ID',
  'FARMING_PROJECT_WORKSPACE',
  'FARMING_RUN_NATIVE_PTY_HOST',
  'FARMING_RUN_SERVER',
  'FARMING_SKILLS_COMMAND',
  'FARMING_SKILLS_FILE',
  'FARMING_STARTUP_PROMPT_FILE',
  'FARMING_TOKEN',
  'FARMING_TOKEN_FILE',
  'OPENTUI_NOTIFICATION_PROTOCOL',
];
const CREATE_ROLLBACK_FIELDS: string[] = [
  'runtimeAgentId',
  'command',
  'forkCommand',
  'cwd',
  'projectWorkspace',
  'mainWorkspace',
  'source',
  'providerHomePath',
  'acpRuntimeMode',
  'acpRuntimeExecutable',
  'providerSessionTemporary',
  'providerSessionSource',
  'providerSessionResolvedAt',
  'providerSessionTitle',
  'providerSessionWorkspace',
  'terminalInputReceived',
  'structuredRuntimeProcess',
  'legacyAcpProcessExitAcknowledgedAt',
  'acpAdditionalDirectories',
  'acpConfigOverrides',
  'acpMcpServers',
  'agentRuntimeMode',
  'acpState',
  'acpError',
  'acpStopReason',
  'acpPendingPermission',
  'acpPendingPermissions',
  'acpPendingElicitation',
  'acpPendingElicitations',
  'acpActiveElicitations',
  'acpSessionUpdatedAt',
  'acpSessionRevision',
  'acpFinalizedTurnHandle',
  'jsonCliState',
  'jsonCliError',
  'jsonCliTranscriptUpdatedAt',
  'engine',
  'category',
  'task',
  'workflowTemplate',
  'wantsMain',
  'pinned',
  'projectOrder',
  'pinnedOrder',
  'attentionSeq',
  'readAttentionSeq',
  'attentionUpdatedAt',
  'readAttentionAt',
  'attentionReason',
  'attentionOutputEpoch',
  'attentionOutputSeq',
  'readOutputEpoch',
  'readOutputSeq',
  'archived',
  'archivedAt',
  'visibleOnMainPage',
  'customTitle',
  'adaptiveTitle',
  'title',
  'startedAt',
];
const execFileAsync = promisify(execFile);

function createRollbackState(
  record: AgentRecord | null | undefined,
): LifecyclePreviousState | undefined {
  if (!record || typeof record !== 'object') return undefined;
  const state: LifecycleOperationRequest = {};
  for (const field of CREATE_ROLLBACK_FIELDS) {
    const value = Object.prototype.hasOwnProperty.call(record, field)
      ? record[field]
      : null;
    state[field] = value === undefined ? null : JSON.parse(JSON.stringify(value));
  }
  state.runtimeAgentId = String(record.runtimeAgentId || '');
  state.visibleOnMainPage = record.visibleOnMainPage === true;
  state.archived = record.archived === true;
  state.customTitle = typeof record.customTitle === 'string' ? record.customTitle : '';
  return {
    ...state,
    runtimeAgentId: String(state.runtimeAgentId || ''),
    visibleOnMainPage: state.visibleOnMainPage === true,
    archived: state.archived === true,
    customTitle: typeof state.customTitle === 'string' ? state.customTitle : '',
  };
}

function createFailurePatch(
  operation: LifecycleOperation | null | undefined,
  fallbackRuntimeAgentId = '',
): UnknownRecord {
  const request = operation?.request;
  const previousState = request?.previousState;
  if (previousState && typeof previousState === 'object') {
    return JSON.parse(JSON.stringify(previousState));
  }
  return {
    visibleOnMainPage: Boolean(fallbackRuntimeAgentId),
    runtimeAgentId: String(fallbackRuntimeAgentId || ''),
  };
}

function withBoundedWait<T>(promise: PromiseLike<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const ACP_SESSION_RECOVERY_CONCURRENCY = 8;

async function runWithBoundedConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  operation: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let nextIndex = 0;
  const workerCount = Math.min(items.length, Math.max(1, Math.floor(concurrency)));
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      await operation(items[index], index);
    }
  }));
}

function sameStructuredRuntimeProcess(
  left: StructuredRuntimeProcessIdentity | null | undefined,
  right: StructuredRuntimeProcessIdentity | null | undefined,
): boolean {
  return Boolean(
    left
    && right
    && left.pid === right.pid
    && left.processGroupId === right.processGroupId
    && left.startedAt === right.startedAt,
  );
}

async function deletePrecreatedProviderSession(options: ProviderSessionDeleteOptions = {}): Promise<void> {
  const provider = String(options.provider || '').trim().toLowerCase();
  const sessionId = String(options.sessionId || '').trim();
  if (!isSafeProviderSessionId(sessionId)) throw new Error('Invalid pre-created provider session id');
  let args: string[] = [];
  if (provider === 'codex') args = ['delete', '--force', sessionId];
  else if (provider === 'opencode') args = ['session', 'delete', sessionId];
  else throw new Error(`${provider || 'Provider'} does not support pre-created session rollback`);
  await execFileAsync(options.executable, args, {
    cwd: options.cwd,
    env: options.env,
    timeout: 15_000,
    maxBuffer: 1024 * 1024,
  });
}

function trimSessionOutput(output: unknown): string {
  const text = typeof output === 'string' ? output : '';
  return text.length > SESSION_OUTPUT_LIMIT ? text.slice(-SESSION_OUTPUT_LIMIT) : text;
}

function terminalStateUpdateDisposition(
  agent: AgentRecord,
  runtimeEpoch: unknown,
  outputSeq: unknown,
  stateRevision: unknown,
): TerminalStateDisposition {
  const currentEpoch = typeof agent.runtimeEpoch === 'string' ? agent.runtimeEpoch : '';
  const nextEpoch = typeof runtimeEpoch === 'string' ? runtimeEpoch : '';
  if (currentEpoch && nextEpoch && currentEpoch !== nextEpoch) {
    const relation = compareNativePtyRuntimeEpochs(nextEpoch, currentEpoch);
    return relation === 1 ? 'new-epoch' : 'stale';
  }
  if (currentEpoch && !nextEpoch) return 'unversioned';
  if (!currentEpoch || !nextEpoch) return 'current';

  const currentRevision = Number(agent.stateRevision);
  const nextRevision = Number(stateRevision);
  if (Number.isFinite(currentRevision) && Number.isFinite(nextRevision)) {
    if (nextRevision < currentRevision) return 'stale';
    if (nextRevision === currentRevision) {
      const currentOutputSeq = Number(agent.lastOutputSeq);
      const nextOutputSeq = Number(outputSeq);
      return Number.isFinite(nextOutputSeq)
        && Number.isFinite(currentOutputSeq)
        && nextOutputSeq === currentOutputSeq
        ? 'duplicate'
        : 'stale';
    }
  }
  const currentOutputSeq = Number(agent.lastOutputSeq);
  const nextOutputSeq = Number(outputSeq);
  if (Number.isFinite(currentOutputSeq) && Number.isFinite(nextOutputSeq) && nextOutputSeq < currentOutputSeq) {
    return 'stale';
  }
  return 'current';
}

function terminalRuntimeEventMatches(agent: AgentRecord, runtimeEpoch: unknown): boolean {
  const currentEpoch = typeof agent?.runtimeEpoch === 'string' ? agent.runtimeEpoch : '';
  if (!currentEpoch) return true;
  return typeof runtimeEpoch === 'string' && runtimeEpoch === currentEpoch;
}

function setPendingTerminalStartSyncCut(
  agent: AgentRecord,
  runtimeEpoch: unknown,
  outputSeq: unknown,
  stateRevision: unknown,
): void {
  if (
    typeof runtimeEpoch !== 'string' || !runtimeEpoch ||
    !Number.isFinite(outputSeq) ||
    !Number.isFinite(stateRevision)
  ) {
    delete agent.pendingTerminalStartSyncCut;
    return;
  }
  agent.pendingTerminalStartSyncCut = {
    runtimeEpoch,
    outputSeq,
    stateRevision,
  };
}

function consumesPendingTerminalStartSyncCut(
  agent: AgentRecord,
  runtimeEpoch: unknown,
  outputSeq: unknown,
  stateRevision: unknown,
): boolean {
  const pending = isRecord(agent?.pendingTerminalStartSyncCut)
    ? agent.pendingTerminalStartSyncCut
    : null;
  return Boolean(
    pending &&
    pending.runtimeEpoch === runtimeEpoch &&
    pending.outputSeq === outputSeq &&
    pending.stateRevision === stateRevision &&
    agent.runtimeEpoch === runtimeEpoch &&
    agent.lastOutputSeq === outputSeq &&
    agent.stateRevision === stateRevision
  );
}

function clearPendingTerminalStartSyncCut(agent: AgentRecord | null | undefined): void {
  if (agent) delete agent.pendingTerminalStartSyncCut;
}

function applyTerminalStateCursor(
  agent: AgentRecord,
  runtimeEpoch: unknown,
  outputSeq: unknown,
  stateRevision: unknown,
  disposition: TerminalStateDisposition,
): boolean {
  if (disposition === 'stale' || disposition === 'duplicate' || disposition === 'unversioned') return false;
  if (disposition === 'new-epoch') {
    agent.lastOutputSeq = 0;
    agent.stateRevision = 0;
  }
  if (typeof runtimeEpoch === 'string' && runtimeEpoch) agent.runtimeEpoch = runtimeEpoch;
  if (Number.isFinite(outputSeq)) agent.lastOutputSeq = Number(outputSeq);
  if (Number.isFinite(stateRevision)) agent.stateRevision = Number(stateRevision);
  return true;
}

function providerCommandContinuesSession(command: string): boolean {
  const parts = parseCommand(command);
  const provider = agentHomeProviderForProgram(parts[0] || '');
  const args = parts.slice(1);
  if (provider === 'codex') {
    return args.some((arg: string) => arg === 'resume' || arg === 'fork');
  }
  if (provider === 'claude') {
    return args.some((arg: string) => (
      arg === '--resume'
      || arg.startsWith('--resume=')
      || arg === '--continue'
      || arg === '-c'
      || arg === '--fork-session'
    ));
  }
  return false;
}

function preserveCodexSessionProfileOptions() {
  return {
    preserveProviderSessionProfile: true,
  };
}

function resumedSessionFromSource(source: string): ExactResumeSession | null {
  return sessionFromExactResumeSource(source);
}

function agentProgramName(command?: string): string {
  const executable = String(command || '')
    .trim()
    .split(/\s+/)
    .find((token: string) => token !== 'env' && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(token));
  return path.basename(executable || '');
}

function agentHomeProviderForProgram(command: string): string {
  return providerForProgram(agentProgramName(command));
}

function isAcpAgent(agent: TypedAgentRecord): boolean {
  return runtimeKind(agent) === 'acp';
}

function forkTargetRuntime(
  agent: TypedAgentRecord,
  requestedTargetRuntime?: ForkAgentOptions['targetRuntime'],
): 'terminal' | 'chat' {
  if (requestedTargetRuntime === 'chat' || requestedTargetRuntime === 'terminal') {
    return requestedTargetRuntime;
  }
  return runtimeKind(agent) === 'acp' ? 'chat' : 'terminal';
}

function isShellProgram(command: string) {
  return ['bash', 'zsh', 'sh', 'fish'].includes(agentProgramName(command).toLowerCase());
}

function isEphemeralShellAgent(agent: TypedAgentRecord): boolean {
  return agent && isShellProgram(agent.forkCommand || agent.command || '');
}

function hasSubmittedTerminalInput(input: TerminalInput) {
  const parts = Array.isArray(input) ? input : [input];
  return parts.some((part: unknown) => {
    // Composer paste parts carry draft text separately from the trailing Enter.
    // Newlines inside that draft must not independently materialize a session.
    if (isRecord(part) && part.type === 'paste') return false;
    const text = String(part || '');
    // xterm wraps native paste payloads so embedded newlines remain draft text.
    // Remove complete bracketed-paste spans before looking for a submission.
    const withoutBracketedPaste = text.replace(/\x1b\[200~[\s\S]*?\x1b\[201~/g, '');
    return /[\r\n]/.test(withoutBracketedPaste);
  });
}

function hasTerminalDraftInput(input: TerminalInput) {
  const parts = Array.isArray(input) ? input : [input];
  return parts.some((part: unknown) => {
    if (isRecord(part) && part.type === 'paste') {
      return String(part.text || '').length > 0;
    }
    const text = String(part || '')
      .replace(/\x1b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '')
      .replace(/[\u0000-\u001f\u007f-\u009f]/g, '');
    return text.length > 0;
  });
}

function activeCodexTerminalProfile(agent: TypedAgentRecord, previewText: string) {
  if (!agent) return null;
  const provider = agent.providerSessionProvider
    || agentHomeProviderForProgram(agent.forkCommand || agent.command || '');
  if (
    provider !== 'codex'
    || runtimeKind(agent) !== 'terminal'
  ) {
    return null;
  }

  const outputProfile = codexTerminalProfileFromOutput(agent.output || '');
  const parsed = outputProfile || codexTerminalProfileFromPreview(previewText);
  if (!parsed) return agent.codexTerminalProfile || null;
  const previousServiceTier = isRecord(agent.codexTerminalProfile)
    ? agent.codexTerminalProfile.serviceTier
    : undefined;
  const profile: UnknownRecord = {
    model: parsed.model,
    reasoningEffort: parsed.effort,
    serviceTier: typeof parsed.fast === 'boolean'
      ? (parsed.fast ? 'priority' : 'default')
      : (previousServiceTier || 'default'),
    source: outputProfile ? 'terminal-output' : 'terminal-footer',
  };
  agent.codexTerminalProfile = profile;
  return profile;
}

function terminalMetadataPatch(agent: TypedAgentRecord) {
  const terminalStatus = deriveAgentTerminalStatus(agent);
  return {
    terminalBusy: typeof agent.terminalBusy === 'boolean' ? agent.terminalBusy : null,
    shellCwd: agent.shellCwd || '',
    shellLastExitCode: agent.shellLastExitCode ?? null,
    shellLastEvent: agent.shellLastEvent || '',
    shellCommand: agent.shellCommand || '',
    shellLastCommand: agent.shellLastCommand || '',
    shellCommandStartedAt: agent.shellCommandStartedAt ?? null,
    shellLastCommandStartedAt: agent.shellLastCommandStartedAt ?? null,
    shellLastCommandFinishedAt: agent.shellLastCommandFinishedAt ?? null,
    shellLastCommandDurationMs: agent.shellLastCommandDurationMs ?? null,
    terminalStatus,
    runtimeObservation: deriveRuntimeObservation({ ...agent, terminalStatus }),
  };
}

function terminalStatusEqual(
  left: ReturnType<typeof deriveAgentTerminalStatus>,
  right: ReturnType<typeof deriveAgentTerminalStatus>,
) {
  if (left === right) return true;
  const leftKeys = Object.keys(left) as Array<keyof typeof left>;
  if (leftKeys.length !== Object.keys(right).length) return false;
  return leftKeys.every(key => (
    Object.prototype.hasOwnProperty.call(right, key)
    && Object.is(left[key], right[key])
  ));
}

function codexTerminalProfileEqual(left: unknown, right: unknown) {
  if (left === right) return true;
  if (!isRecord(left) || !isRecord(right)) return false;
  return left.model === right.model
    && left.reasoningEffort === right.reasoningEffort
    && left.serviceTier === right.serviceTier
    && left.source === right.source;
}

function terminalRuntimeStatus(agentStatus: unknown) {
  return agentStatus === 'stopped' || agentStatus === 'dead' ? 'exited' : agentStatus;
}

function finiteNumberOrNull(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function finiteNonNegativeInteger(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : 0;
}

function deriveAgentTerminalStatus(agent: TypedAgentRecord, overrides: TerminalStatusOverrides = {}) {
  const terminalBusy = Object.prototype.hasOwnProperty.call(overrides, 'terminalBusy')
    ? overrides.terminalBusy
    : agent.terminalBusy;
  return deriveTerminalStatus({
    command: agent.forkCommand || agent.command,
    cwd: overrides.cwd || agent.shellCwd || agent.cwd,
    status: overrides.status || terminalRuntimeStatus(agent.status),
    title: Object.prototype.hasOwnProperty.call(overrides, 'title')
      ? overrides.title
      : (agent.sessionTitle || ''),
    previewText: Object.prototype.hasOwnProperty.call(overrides, 'previewText')
      ? overrides.previewText
      : (agent.previewText || agent.output || ''),
    terminalBusy: typeof terminalBusy === 'boolean' ? terminalBusy : null,
    shellLastExitCode: typeof agent.shellLastExitCode === 'number' ? agent.shellLastExitCode : null,
    shellLastEvent: agent.shellLastEvent || '',
    shellCommand: Object.prototype.hasOwnProperty.call(overrides, 'shellCommand')
      ? overrides.shellCommand
      : (agent.shellCommand || ''),
    shellLastCommand: Object.prototype.hasOwnProperty.call(overrides, 'shellLastCommand')
      ? overrides.shellLastCommand
      : (agent.shellLastCommand || ''),
    shellCommandStartedAt: Object.prototype.hasOwnProperty.call(overrides, 'shellCommandStartedAt')
      ? overrides.shellCommandStartedAt
      : finiteNumberOrNull(agent.shellCommandStartedAt),
    shellLastCommandStartedAt: Object.prototype.hasOwnProperty.call(overrides, 'shellLastCommandStartedAt')
      ? overrides.shellLastCommandStartedAt
      : finiteNumberOrNull(agent.shellLastCommandStartedAt),
    shellLastCommandFinishedAt: Object.prototype.hasOwnProperty.call(overrides, 'shellLastCommandFinishedAt')
      ? overrides.shellLastCommandFinishedAt
      : finiteNumberOrNull(agent.shellLastCommandFinishedAt),
    shellLastCommandDurationMs: Object.prototype.hasOwnProperty.call(overrides, 'shellLastCommandDurationMs')
      ? overrides.shellLastCommandDurationMs
      : finiteNumberOrNull(agent.shellLastCommandDurationMs),
  });
}

function setAgentRecordId(agent: TypedAgentRecord, agentRecordId: unknown) {
  if (!agent || typeof agentRecordId !== 'string' || !agentRecordId) return;
  agent.agentRecordId = agentRecordId;
  agent.persistentSessionId = agentRecordId;
}

function shouldRestoreAgentFromMetadata(record: TypedAgentRecord, mainPageSessionKeys: ReadonlySet<string>) {
  if (!record || record.archived === true) return false;
  const latestOperation = latestLifecycleOperation(record);
  if (latestOperation?.type === 'delete' && latestOperation.state === 'succeeded') return false;
  if (
    latestOperation?.type === 'create'
    && latestOperation.state === 'succeeded'
    && record.visibleOnMainPage === true
  ) {
    return true;
  }
  if (record.wantsMain === true) return true;
  if (
    record.providerSessionTemporary === true
    || isTemporaryProviderSessionId(record.providerSessionId)
  ) {
    return record.visibleOnMainPage === true;
  }
  const provider = String(record.providerSessionProvider || record.provider || '').trim();
  const sessionKey = canonicalProviderSessionKey(record.providerSessionKey) || mainPageAgentSessionKey(
    provider,
    record.providerSessionId,
    record.providerHomeId || 'default'
  );
  if (sessionKey) return mainPageSessionKeys.has(sessionKey);
  return record.visibleOnMainPage === true;
}

function lifecycleOperationBlocksRuntimeStart(record: TypedAgentRecord) {
  const operation = activeLifecycleOperation(record);
  return operation && ['create', 'delete', 'archive', 'runtime-switch', 'fork'].includes(operation.type)
    ? operation
    : null;
}

function publicActiveLifecycleOperation(agent: TypedAgentRecord) {
  const operation = activeLifecycleOperation(agent);
  if (!operation) return null;
  return {
    id: operation.id,
    type: operation.type,
    state: operation.state,
    error: operation.error || '',
    startedAt: operation.startedAt || null,
    updatedAt: operation.updatedAt || null,
  };
}

function recoveredEngineSessionId(
  entry: RecoveredEngineSession | null | undefined,
  metadata: RuntimeEngineMetadata = {},
): string {
  return String(entry?.sessionId || entry?.agentId || metadata.agentId || '');
}

function agentDisplayName(command?: string): string {
  const program = agentProgramName(command).toLowerCase();
  return getProviderAdapter(providerForProgram(program))?.displayName || program;
}

function stableJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableJsonValue);
  if (!value || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  return Object.keys(record).sort().reduce((result: UnknownRecord, key: string) => {
    const child = record[key];
    if (!['function', 'symbol', 'undefined'].includes(typeof child)) {
      result[key] = stableJsonValue(child);
    }
    return result;
  }, {});
}

function createOperationSignature(command: unknown, customWorkspace: string | null, options: UnknownRecord = {}) {
  const semanticOptions: UnknownRecord = { ...options };
  [
    'createRequestId',
    'lifecycleToken',
    'skipRecoveryWait',
    'startAdmissionToken',
  ].forEach((field: string) => delete semanticOptions[field]);
  return crypto.createHash('sha256').update(JSON.stringify(stableJsonValue({
    command: String(command || '').trim(),
    workspace: String(customWorkspace || ''),
    options: semanticOptions,
  }))).digest('hex');
}

function titleComparisonKey(title: string) {
  return String(title || '')
    .trim()
    .replace(/^[\s*＊✳✱✲✶·•:.\u2800-\u28FF]+/u, '')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function isFarmingAgentSessionContext(title: string): boolean {
  return String(title || '').trim().toLowerCase().startsWith('<farming-agent-context>');
}

function agentWorkspaceTitleKeys(agent: TypedAgentRecord): string[] {
  return [agent && agent.cwd, agent && agent.projectWorkspace]
    .filter((value: unknown) => typeof value === 'string' && value.trim().length > 0)
    .map((value: unknown) => path.basename(String(value).replace(/[\\/]+$/, '')))
    .filter(Boolean)
    .map(titleComparisonKey);
}

function isGenericSessionTitle(agent: TypedAgentRecord, title: string): boolean {
  if (isFarmingAgentSessionContext(title)) return true;
  const normalizedTitle = titleComparisonKey(title);
  if (!normalizedTitle) return true;

  const program = agentProgramName(agent && agent.command).toLowerCase();
  const displayName = agentDisplayName(agent && agent.command);
  const genericTitles = new Set([
    program,
    displayName,
    `${program} session`,
    `${displayName} session`,
    'main agent',
    'farming',
  ].filter(Boolean));

  if (genericTitles.has(normalizedTitle)) return true;
  return agentWorkspaceTitleKeys(agent).includes(normalizedTitle);
}

function interruptInputForAgent(agent: TypedAgentRecord) {
  const provider = agent?.providerSessionProvider || agentHomeProviderForProgram(agent?.command || '');
  return getProviderAdapter(provider)?.interruptInput || '\x03';
}

function normalizePathValue(value: unknown) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed || trimmed === path.sep) return trimmed;
  return trimmed.replace(/[\\/]+$/, '');
}

function effectiveAgentWorkspaceRoot(agent: TypedAgentRecord): string {
  if (agent && agent.gitWorktree && agent.gitWorktree.workspace) {
    return agent.gitWorktree.workspace;
  }
  return agent && (agent.projectWorkspace || agent.cwd) || '';
}

function publicAgentGitWorktree(agent: TypedAgentRecord) {
  const worktree = agent && agent.gitWorktree;
  if (!worktree || !worktree.workspace) return null;
  return {
    workspace: worktree.workspace,
    commonDir: worktree.commonDir || '',
    mainWorkspace: worktree.mainWorkspace || '',
    linked: worktree.linked === true,
    branch: worktree.branch || '',
    head: worktree.head || '',
    detached: worktree.detached === true,
    locked: worktree.locked === true,
    lockReason: worktree.lockReason || '',
    prunable: worktree.prunable === true,
    pruneReason: worktree.pruneReason || '',
    worktrees: Array.isArray(worktree.worktrees)
      ? worktree.worktrees.map((item: WorktreeListEntry) => ({
        workspace: item.workspace || '',
        head: item.head || '',
        branch: item.branch || '',
        bare: item.bare === true,
        detached: item.detached === true,
        locked: item.locked === true,
        lockReason: item.lockReason || '',
        prunable: item.prunable === true,
        pruneReason: item.pruneReason || '',
        current: item.current === true,
        main: item.main === true,
      }))
      : [],
  };
}

function normalizePositiveInteger(value: unknown, fallback: number, min: number, max: number) {
  const parsed = Math.floor(Number(value));
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function executableOwnershipEnvironment(configDir: string): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  if (configDir) environment.FARMING_CONFIG_DIR = configDir;
  else delete environment.FARMING_CONFIG_DIR;
  return environment;
}

function isSessionNotAvailableError(error: unknown) {
  const message = String(isRecord(error) && typeof error.message === 'string' ? error.message : error);
  return /Session not available/i.test(message) ||
    /Native PTY host (?:failed to start or connect|is not reachable)/i.test(message);
}

function isRunningAgentRuntimeStatus(status: unknown) {
  return String(status || '').toLowerCase() === 'running';
}

function isLiveEngineSessionState(sessionState: unknown) {
  return Boolean(isRecord(sessionState) && sessionState.status && sessionState.status !== 'exited');
}

function projectOperationSignature(value: unknown) {
  return crypto.createHash('sha256')
    .update(JSON.stringify(stableJsonValue(value)))
    .digest('hex');
}

class AgentManager extends EventEmitter {
  declare acpRuntime: AcpRuntimeContract;
  declare engineBridge: SessionEngineBridgeContract;
  declare configManager: AgentManagerConfigContract | null | undefined;
  declare controlUrl: string;
  declare tokenFile: string;
  declare authDisabled: boolean;
  declare skipExecutablePreflight: boolean;
  declare cliBinDir: string;
  declare agentShellEnvProvider: (shell: string) => NodeJS.ProcessEnv | null;
  declare agentShellEnvCache: Map<string, AgentShellEnvCacheEntry>;
  declare agentShellEnvCacheMs: number;
  declare agents: Map<AgentId, TypedAgentRecord>;
  declare agentOrderAllocator: AgentOrderAllocator;
  declare mainAgentId: AgentId | null;
  declare mainAgentStartReservation: AgentStartReservation | null;
  declare lastActivity: Map<AgentId, number>;
  declare lastActivityUpdate: Map<AgentId, number>;
  declare terminalStatusProjections: WeakMap<
    TypedAgentRecord,
    ReturnType<typeof deriveAgentTerminalStatus>
  >;
  declare codexTerminalProfileProjections: WeakMap<TypedAgentRecord, object | null>;
  declare usageRateTracker: AgentUsageRateTracker;
  declare terminalResizeCoordinator: TerminalResizeCoordinator;
  declare inputCoordinator: AgentInputCoordinator;
  declare composerAdmissionCoordinator: AgentComposerAdmissionCoordinator;
  declare codexTerminalProfileQueues: Map<AgentId, Promise<unknown>>;
  declare codexTerminalIdentityAttempts: Map<AgentId, string>;
  declare codexTerminalIdentityPromises: Map<AgentId, Promise<boolean>>;
  declare terminalStartupCoordinator: TerminalStartupCoordinator;
  declare agentWorktreeResolveGeneration: Map<AgentId, number>;
  declare agentWorktreeRefreshQueue: AgentWorktreeRefreshQueue;
  declare worktreeGitService: WorktreeGitServicePort;
  declare forkOperationCoordinator: ForkOperationCoordinator;
  declare agentLifecycleOperations: Map<AgentId, AgentLifecycleEntry<unknown>>;
  declare agentStartAdmissions: Map<symbol, AgentStartAdmission>;
  declare createRequestAdmissions: Map<string, CreateRequestAdmission>;
  declare projectOperationAdmissions: Map<string, ProjectOperationAdmission<unknown>>;
  declare projectWorkspaceDeleteAdmissions: Map<
    string,
    ProjectWorkspaceDeleteAdmission<DeleteProjectWorktreeResult | UnknownRecord>
  >;
  declare verifiedStoppedAgentIds: Set<AgentId>;
  declare codexSessionMutationQueues: Map<string, CodexSessionMutationAdmission<unknown>>;
  declare adaptiveTitlePersistence: AgentAdaptiveTitlePersistenceCoordinator;
  declare acpFinalizedTurns: Map<string, string>;
  declare acpTurnFinalizationTails: Map<string, Promise<void>>;
  declare activeAcpTurnFinalizations: Set<Promise<void>>;
  declare attentionTracker: AgentAttentionTracker;
  declare acpSessionOptionsByKey: Map<string, AcpSessionOptionsRecord>;
  declare acpPreparedTranscriptCache: AcpPreparedTranscriptCache;
  declare acpTranscriptReads: Map<string, Promise<{ payload?: UnknownRecord; serialized?: string }>>;
  declare transcriptMediaPathPrefix: (agentId: string) => string;
  declare permissionRestartSuppressedAgentIds: Set<AgentId>;
  declare createProviderSessionIdentity: CreateProviderSessionIdentityContract;
  declare deleteProviderSessionIdentity: DeleteProviderSessionIdentityContract;
  declare archiveCodexSession: ArchiveCodexSessionContract;
  declare unarchiveCodexSession: UnarchiveCodexSessionContract;
  declare stopPersistedAcpProcessGroup: StopPersistedAcpProcessGroupContract;
  declare configInstanceFingerprint: string;
  declare allowUnprovenLegacyAcpRecovery: boolean;
  declare heartbeatInterval: ReturnType<typeof setInterval> | null;
  declare disposing: boolean;
  declare disposeFrozen: boolean;
  declare disposePromise: Promise<void> | null;
  declare disposed: boolean;
  declare systemMonitor: SystemMonitor;
  declare startTime: number;
  declare providerSessionService: ProviderSessionServiceRuntimeContract;
  declare recoveryPromise: Promise<void>;
  declare recoveryComplete: boolean;
  declare recoveryError: unknown;
  declare taskHistory: UnknownRecord[];
  declare lastZombieSweepAt: number;

  registerAgentRecord(agentId: AgentId, agent: TypedAgentRecord): void {
    const previous = this.agents.get(agentId);
    if (previous && previous !== agent) this.agentOrderAllocator.remove(previous);
    this.agentOrderAllocator.ensure(agent);
    this.agents.set(agentId, agent);
  }

  deleteAgentRecord(agentId: AgentId): boolean {
    const agent = this.agents.get(agentId);
    this.cancelQwenTerminalIdleCandidate(agentId);
    const deleted = this.agents.delete(agentId);
    if (deleted) {
      this.agentOrderAllocator.remove(agent);
      this.agentWorktreeResolveGeneration.delete(agentId);
      this.agentWorktreeRefreshQueue.cancelPending(agentId);
    }
    return deleted;
  }

  constructor(
    configManager: AgentManagerConfigContract | null | undefined,
    options: AgentManagerOptions = {},
  ) {
    super();
    this.configManager = configManager;
    this.controlUrl = options.controlUrl || '';
    this.tokenFile = options.tokenFile || '';
    this.authDisabled = options.authDisabled === true;
    this.skipExecutablePreflight = options.skipExecutablePreflight === true;
    this.cliBinDir = options.cliBinDir || path.join(__dirname, '..', 'bin');
    this.agentShellEnvProvider = typeof options.agentShellEnvProvider === 'function'
      ? options.agentShellEnvProvider
      : (shell: string) => resolveUserShellEnvSync({ processEnv: process.env, shell });
    this.agentShellEnvCache = new Map();
    this.agentShellEnvCacheMs = normalizePositiveInteger(
      process.env.FARMING_AGENT_SHELL_ENV_CACHE_MS,
      5 * 60 * 1000,
      0,
      60 * 60 * 1000
    );
    this.agents = new RuntimeAgentMap();
    this.agentOrderAllocator = new AgentOrderAllocator();
    this.mainAgentId = null;
    this.mainAgentStartReservation = null;
    this.lastActivity = new Map();
    this.lastActivityUpdate = new Map();
    this.terminalStatusProjections = new WeakMap();
    this.codexTerminalProfileProjections = new WeakMap();
    this.usageRateTracker = new AgentUsageRateTracker();
    this.terminalResizeCoordinator = new TerminalResizeCoordinator({
      isShuttingDown: () => this.disposing,
      resize: (agentId, { cols, rows }) => this.resizeAgentSession(agentId, cols, rows),
    });
    this.inputCoordinator = new AgentInputCoordinator({
      isShuttingDown: () => this.disposing,
    });
    this.composerAdmissionCoordinator = new AgentComposerAdmissionCoordinator({
      captureDeliveryOwner: agent => {
        const expectedAgent = agent;
        const expectedRuntimeKind = runtimeKind(agent);
        const expectedRuntimeBinding = agent.runtimeBinding;
        const expectedRuntimeEpoch = String(agent.runtimeEpoch || '');
        return {
          assertCurrent: () => {
            const current = this.agents.get(agent.id);
            if (current !== expectedAgent || runtimeKind(current) !== expectedRuntimeKind) {
              throw Object.assign(
                new Error('Agent record was replaced before Composer message delivery'),
                {
                  code: 'COMPOSER_DELIVERY_OWNER_CHANGED',
                  composerRecordExact: false,
                  uncertain: true,
                },
              );
            }
            // ACP Host recovery rebinds the same record after an abrupt Host
            // loss, so a new binding or binding epoch is not an ownership
            // change. A Chat/Terminal switch waits for admission completion
            // through the lifecycle interlock and changes the runtime kind.
            if (expectedRuntimeKind === 'acp') return;
            if (
              current.runtimeBinding !== expectedRuntimeBinding
              || String(current.runtimeEpoch || '') !== expectedRuntimeEpoch
            ) {
              throw Object.assign(
                new Error('Agent runtime changed before Terminal message delivery'),
                {
                  code: 'COMPOSER_TERMINAL_RUNTIME_REPLACED',
                  composerRecordExact: true,
                  composerZeroEffect: true,
                },
              );
            }
          },
        };
      },
      deliver: ({
        agent,
        assertCurrentOwner,
        delivery,
        onSubmitted,
        prompt,
        requestId,
        retryDefinitiveFailure,
      }) => {
        const persistentTerminalDelivery = runtimeKind(agent) === 'terminal';
        const terminalRuntimeEpoch = persistentTerminalDelivery
          ? String(agent.runtimeEpoch || '')
          : '';
        if (!persistentTerminalDelivery) {
          if (delivery === 'steer') {
            return this.sendComposerMessageNow(agent.id, prompt, {
              assertDeliveryOwner: assertCurrentOwner,
              delivery,
              requestId,
              retryDefinitiveFailure,
              onSubmitted: () => onSubmitted({ kind: 'acp' }),
            });
          }
          return this.enqueueInputOperationUntilReleased(
            agent.id,
            (releaseInput: () => void) => this.sendComposerMessageNow(agent.id, prompt, {
              assertDeliveryOwner: assertCurrentOwner,
              delivery,
              requestId,
              retryDefinitiveFailure,
              onSubmitted: () => {
                try {
                  onSubmitted({ kind: 'acp' });
                } finally {
                  releaseInput();
                }
              },
            }),
          );
        }
        return this.enqueueInputOperation(
          agent.id,
          () => this.sendComposerMessageNow(agent.id, prompt, {
            assertDeliveryOwner: assertCurrentOwner,
            expectedTerminalAgent: agent,
            expectedTerminalRuntimeEpoch: terminalRuntimeEpoch,
            onSubmitted: result => onSubmitted(result),
            requireConfirmedTerminalDelivery: true,
          }),
        );
      },
      persistAgent: agent => this.ensurePersistentAgentSession(agent),
      persistenceRequired: () => typeof this.configManager?.ensureAgentSessionRecord === 'function',
      runtimeKind: agent => runtimeKind(agent),
    });
    this.codexTerminalProfileQueues = new Map();
    this.codexTerminalIdentityAttempts = new Map();
    this.codexTerminalIdentityPromises = new Map();
    this.terminalStartupCoordinator = new TerminalStartupCoordinator();
    this.agentWorktreeResolveGeneration = new Map();
    this.agentWorktreeRefreshQueue = new AgentWorktreeRefreshQueue(
      AGENT_WORKTREE_REFRESH_CONCURRENCY,
    );
    this.worktreeGitService = options.worktreeGitService || new WorktreeGitService();
    this.forkOperationCoordinator = new ForkOperationCoordinator({
      begin: (source, requestKey, request) => {
        const admission = this.beginPersistentAgentOperation(
          source as TypedAgentRecord,
          'fork',
          requestKey,
          request,
        );
        return admission.operation
          ? { accepted: true, operation: admission.operation }
          : { accepted: false, error: admission.error || 'Failed to admit Fork operation' };
      },
      complete: (source, operationId, result) => {
        this.completePersistentAgentOperation(source as TypedAgentRecord, operationId, result);
      },
      checkpointWorktree: (source, operationId, identity) => {
        this.checkpointPersistentAgentOperationRequest(
          source as TypedAgentRecord,
          operationId,
          { forkWorktreeIdentity: identity },
        );
      },
      execute: (agentId, mode, forkOptions, context) => this.forkAgentUntracked(
        agentId,
        mode,
        forkOptions,
        context,
      ),
      getSource: agentId => this.agents.get(agentId),
      listChildren: () => (
        typeof this.configManager?.listAgentSessionRecords === 'function'
          ? this.configManager.listAgentSessionRecords().map(record => {
              const runtimeAgentId = String(record.runtimeAgentId || '').trim();
              const currentChild = runtimeAgentId ? this.agents.get(runtimeAgentId) : null;
              return {
                ...record,
                ...(currentChild
                  ? {
                      runtimeOwnerRecordIds: [
                        currentChild.agentRecordId,
                        currentChild.persistentSessionId,
                      ].map(value => String(value || '').trim()).filter(Boolean),
                    }
                  : {}),
              };
            })
          : []
      ),
      rollbackWorktree: identity => this.rollbackTemporaryForkWorktree(identity),
      runExclusive: (agentId, key, operation) => this.runAgentLifecycleOperation(
        agentId,
        key,
        'fork',
        'fork',
        operation,
      ),
      stabilizeSourceIdentity: (agentId, forkOptions) => this.stabilizeForkSourceIdentity(
        agentId,
        forkOptions,
      ),
      transitionBlocked: (source, operationId, error, requestPatch) => {
        this.transitionPersistentAgentOperation(
          source as TypedAgentRecord,
          operationId,
          'blocked',
          error,
          {},
          requestPatch,
        );
      },
      transitionFailed: (source, operationId, error) => {
        this.transitionPersistentAgentOperation(
          source as TypedAgentRecord,
          operationId,
          'failed',
          error,
        );
      },
      waitForRecovery: () => this.whenRecovered(),
    });
    this.agentLifecycleOperations = new Map();
    this.agentStartAdmissions = new Map();
    this.createRequestAdmissions = new Map();
    this.projectOperationAdmissions = new Map();
    this.projectWorkspaceDeleteAdmissions = new Map();
    this.verifiedStoppedAgentIds = new Set();
    this.codexSessionMutationQueues = new Map();
    this.adaptiveTitlePersistence = new AgentAdaptiveTitlePersistenceCoordinator({
      getAgent: (agentId: AgentId) => this.agents.get(agentId),
      persistAdaptiveTitle: async (agent: TypedAgentRecord, adaptiveTitle: string) => {
        if (!this.configManager) throw new Error('Agent session storage is unavailable');
        return this.configManager.persistAgentAdaptiveTitle(agent, adaptiveTitle);
      },
      publishAgentPatch: (agentId: AgentId, patch: UnknownRecord) => {
        this.emit('agent-update', { agentId, patch });
      },
      setRecordId: setAgentRecordId,
      updateProviderMetadata: (agent: TypedAgentRecord) => {
        this.updateEngineProviderSessionMetadata(agent);
      },
    });
    this.acpFinalizedTurns = new Map();
    this.acpTurnFinalizationTails = new Map();
    this.activeAcpTurnFinalizations = new Set();
    this.attentionTracker = new AgentAttentionTracker({
      getAgent: (agentId: AgentId) => this.agents.get(agentId),
      isDisposed: () => this.disposed,
      isMainAgent: (agentId: AgentId, agent: TypedAgentRecord) => (
        this.isMainAgentRecord(agentId, agent)
      ),
      isTurnActive: (agent: TypedAgentRecord) => this.isAgentAttentionTurnActive(agent),
      persistAgent: (agent: TypedAgentRecord) => {
        this.ensurePersistentAgentSession(agent);
      },
      providerForAgent: (agent: TypedAgentRecord) => this.agentAttentionProvider(agent),
      publishReadState: payload => {
        this.emit('agent-read', payload);
      },
      updateProviderMetadata: (agent: TypedAgentRecord) => {
        this.updateEngineProviderSessionMetadata(agent);
      },
    });
    // Standard ACP session inputs may contain MCP credentials. Keep the live
    // copy outside browser-facing Agent records; crash recovery persists it
    // only through the private Farming session store.
    this.acpSessionOptionsByKey = new Map();
    this.acpTranscriptReads = new Map();
    this.transcriptMediaPathPrefix = typeof options.transcriptMediaPathPrefix === 'function'
      ? options.transcriptMediaPathPrefix
      : (agentId: string) => `/api/agents/${encodeURIComponent(agentId)}/acp-media`;
    this.permissionRestartSuppressedAgentIds = new Set();
    this.acpRuntime = options.acpRuntime || (this.configManager?.farmingDir
      ? new AcpRuntimeHostRuntime({
          configDir: this.configManager.farmingDir,
          forceReplaceActiveHost: process.env.FARMING_FORCE_ACP_HOST_RESTART === '1',
        })
      : new AcpRuntime());
    this.acpPreparedTranscriptCache = new AcpPreparedTranscriptCache({
      prepare: identity => this.buildAcpTranscriptEnvelope(identity.agentId, {
        maxTurns: PREPARED_ACP_TRANSCRIPT_TURN_LIMIT,
        mediaPathPrefix: this.transcriptMediaPathPrefix(identity.agentId),
      }),
      validate: identity => {
        const agent = this.agents.get(identity.agentId);
        const runtime = runtimeBindingOf(agent, 'acp');
        return Boolean(
          agent
          && runtime
          && String(agent.providerSessionId || '') === identity.sessionId
          && this.acpRuntime.bindingEpoch(identity.agentId) === identity.runtimeEpoch
          && Number(runtime.sessionRevision || 0) === identity.revision
          && runtime.state === 'idle'
        );
      },
      quietMs: PREPARED_ACP_TRANSCRIPT_QUIET_MS,
    });
    this.createProviderSessionIdentity = typeof options.createProviderSessionIdentity === 'function'
      ? options.createProviderSessionIdentity
      : (createOptions: ProviderSessionIdentityRequest) => this.acpRuntime.createSessionIdentity(createOptions);
    this.deleteProviderSessionIdentity = typeof options.deleteProviderSessionIdentity === 'function'
      ? options.deleteProviderSessionIdentity
      : deletePrecreatedProviderSession;
    this.archiveCodexSession = options.archiveCodexSession || archiveCodexSession;
    this.unarchiveCodexSession = options.unarchiveCodexSession || unarchiveCodexSession;
    this.configInstanceFingerprint = this.configManager?.farmingDir
      ? fingerprintConfigInstance(this.configManager.farmingDir)
      : '';
    this.stopPersistedAcpProcessGroup = options.stopPersistedAcpProcessGroup
      || ((identity) => stopPersistedAcpProcessGroup(identity, this.configInstanceFingerprint));
    // Upgrade compatibility is the product default: records created before
    // ACP process identities existed must still resume their provider Session.
    // Strict callers may opt out explicitly for cleanup-safety diagnostics.
    this.allowUnprovenLegacyAcpRecovery = options.allowUnprovenLegacyAcpRecovery !== false;
    this.heartbeatInterval = null;
    this.disposing = false;
    this.disposeFrozen = false;
    this.disposePromise = null;
    this.disposed = false;
    this.systemMonitor = new SystemMonitor();
    this.startTime = Date.now();
    this.engineBridge = new SessionEngineBridge(configManager);
    this.providerSessionService = new ProviderSessionService({
      agents: this.agents,
      getProviderHomes: () => this.configManager?.getSettings?.()?.agentHomes,
      commit: (agent: TypedAgentRecord, change: ProviderSessionChange = {}) => {
        if (change.kind === 'session-updated') this.ensurePersistentAgentSession(agent);
        this.updateEngineProviderSessionMetadata(agent);
        this.rememberMainPageProviderSession(agent);
        if (change.event) {
          this.emit('provider-session-updated', change.event);
          const providerTitle = typeof change.event.title === 'string'
            ? change.event.title
            : '';
          if (providerTitle && this.updateAgentSessionTitle(agent, providerTitle)) {
            this.emit('agent-update', {
              agentId: agent.id,
              patch: { sessionTitle: agent.sessionTitle || '' },
            });
          }
          if (Object.prototype.hasOwnProperty.call(change.event, 'previousSessionId')) {
            this.emitStateChange({ agentIds: [agent.id] });
          }
        }
        if (change.refreshWorkspace) {
          void this.refreshAgentWorktree(agent.id, change.refreshWorkspace);
        }
      },
    });
    this.recoveryPromise = Promise.resolve();
    this.recoveryComplete = !(this.configManager && this.configManager.farmingDir);
    this.recoveryError = null;
    this.taskHistory = (this.configManager && this.configManager.getTaskHistory)
      ? [...this.configManager.getTaskHistory()]
      : [];
    this.lastZombieSweepAt = 0;
    this.startHeartbeat();
    this.bindEngineEvents();
    this.bindAcpRuntimeEvents();
    if (this.configManager && this.configManager.farmingDir) {
      this.recoveryPromise = this.recoverEngineSessions()
        .then(() => {
          this.recoveryComplete = true;
        })
        .catch((error: unknown) => {
          this.recoveryError = error;
          console.warn('Failed to recover engine sessions:', error instanceof Error ? error.message : String(error));
        });
    }
  }

  bindAcpRuntimeEvents() {
    if (!this.acpRuntime || typeof this.acpRuntime.on !== 'function') return;
    this.acpRuntime.on('agent-runtime', ({ agentId, state, error, sessionId, stopReason, supportsSteer, supportsFork, pendingPermission, pendingPermissions, pendingElicitation, pendingElicitations, activeElicitations, updatedAt, lastSettledTurnHandle, lastSettledTurnSummary }: AcpRuntimeEvent) => {
      const agent = this.agents.get(agentId);
      if (!agent) return;
      const runtime = runtimeBindingOf(agent, 'acp');
      if (!runtime) return;
      const previousRuntime = publicRuntimeBinding(agent);
      const previousState = runtime.state;
      const previousError = runtime.error;
      const sessionIdentityChanged = Boolean(
        sessionId
        && (
          agent.providerSessionId !== sessionId
          || agent.providerSessionTemporary === true
          || !agent.providerSessionKey
        )
      );
      runtime.state = state || '';
      runtime.error = error || '';
      runtime.stopReason = stopReason || '';
      runtime.supportsSteer = supportsSteer === true;
      runtime.supportsFork = supportsFork === true;
      runtime.pendingPermission = pendingPermission || null;
      runtime.pendingPermissions = Array.isArray(pendingPermissions) ? pendingPermissions : [];
      runtime.pendingElicitation = pendingElicitation || null;
      runtime.pendingElicitations = Array.isArray(pendingElicitations) ? pendingElicitations : [];
      runtime.activeElicitations = Array.isArray(activeElicitations) ? activeElicitations : [];
      runtime.sessionUpdatedAt = updatedAt || '';
      if (sessionIdentityChanged && sessionId) {
        this.providerSessionService.bindConfirmed(agentId, agent.providerSessionProvider, sessionId);
      }
      if (
        sessionIdentityChanged
        || (stopReason === 'interrupted' && previousState !== state)
        || (state === 'error' && !sessionId && (previousState !== state || previousError !== runtime.error))
      ) {
        this.ensurePersistentAgentSession(agent);
      }
      if (state === 'working' || state === 'waiting-for-permission' || state === 'waiting-for-input') this.lastActivity.set(agentId, Date.now());
      this.refreshAcpPreparedTranscript(agentId);
      const nextRuntime = publicRuntimeBinding(agent);
      if (JSON.stringify(previousRuntime) !== JSON.stringify(nextRuntime)) {
        this.emit('agent-update', {
          agentId,
          patch: {
            runtimeBinding: nextRuntime,
            runtimeObservation: deriveRuntimeObservation(agent),
          },
        });
      }
      if (sessionIdentityChanged) this.emitStateChange({ agentIds: [agentId] });
      const settledTurnHandle = String(lastSettledTurnHandle || '');
      const finalizedTurnHandle = String(
        this.acpFinalizedTurns.get(agentId)
        || agent.acpFinalizedTurnHandle
        || '',
      );
      if (
        settledTurnHandle
        && acpTurnHandleIsNewer(settledTurnHandle, finalizedTurnHandle)
      ) {
        this.acpFinalizedTurns.set(agentId, settledTurnHandle);
        const runtimeEpoch = this.acpRuntime.bindingEpoch(agentId);
        const exactTurnSummary = typeof lastSettledTurnSummary === 'string'
          ? lastSettledTurnSummary
          : null;
        const previous = this.acpTurnFinalizationTails.get(agentId) || Promise.resolve();
        const finalization = previous.catch(() => {}).then(() => (
          this.finalizeAcpTurn(
            agentId,
            runtimeEpoch,
            settledTurnHandle,
            String(stopReason || ''),
            exactTurnSummary,
          )
        ));
        this.acpTurnFinalizationTails.set(agentId, finalization);
        this.activeAcpTurnFinalizations.add(finalization);
        void finalization.catch(finalizeError => {
          if (this.acpFinalizedTurns.get(agentId) === settledTurnHandle) {
            this.acpFinalizedTurns.delete(agentId);
            const current = this.agents.get(agentId);
            if (current?.acpFinalizedTurnHandle === settledTurnHandle) current.acpFinalizedTurnHandle = '';
          }
          console.warn('Failed to finalize ACP Turn:', finalizeError);
        }).finally(() => {
          this.activeAcpTurnFinalizations.delete(finalization);
          if (this.acpTurnFinalizationTails.get(agentId) === finalization) {
            this.acpTurnFinalizationTails.delete(agentId);
          }
        });
      }
    });
    this.acpRuntime.on('session', ({ agentId, revision, title }: AcpSessionEvent) => {
      const agent = this.agents.get(agentId);
      if (!agent) return;
      const runtime = runtimeBindingOf(agent, 'acp');
      if (!runtime) return;
      const currentRevision = Number(runtime.sessionRevision) || 0;
      const nextRevision = Number.isFinite(Number(revision))
        ? Number(revision)
        : currentRevision + 1;
      const recoversMissingTitle = nextRevision === currentRevision
        && typeof title === 'string'
        && isGenericSessionTitle(agent, agent.sessionTitle || '')
        && !isGenericSessionTitle(agent, title);
      if (nextRevision < currentRevision || (nextRevision === currentRevision && !recoversMissingTitle)) return;
      if (nextRevision > currentRevision) {
        runtime.sessionUpdatedAt = new Date().toISOString();
        runtime.sessionRevision = nextRevision;
      }
      const titleChanged = typeof title === 'string'
        ? this.updateAgentSessionTitle(agent, title)
        : false;
      if (nextRevision > currentRevision) {
        this.emit('acp-session-revision', {
          agentId,
          revision: runtime.sessionRevision,
          updatedAt: runtime.sessionUpdatedAt,
        });
      }
      if (titleChanged) {
        this.emit('agent-update', { agentId, patch: { sessionTitle: agent.sessionTitle || '' } });
      }
      if (nextRevision > currentRevision) this.refreshAcpPreparedTranscript(agentId);
    });
    this.acpRuntime.on('config-overrides', ({ agentId, sessionId, configOverrides }: AcpConfigOverridesEvent) => {
      const agent = this.agents.get(String(agentId || ''));
      if (!agent || runtimeKind(agent) !== 'acp') return;
      if (sessionId && String(agent.providerSessionId || '') !== String(sessionId)) return;
      const sessionKey = String(agent.providerSessionKey || '');
      if (!sessionKey) return;
      let current = this.acpSessionOptionsByKey.get(sessionKey);
      if (!current) {
        try {
          const requestOptions = this.acpRuntime.getSessionRequestOptions(agent.id);
          current = {
            additionalDirectories: [...requestOptions.additionalDirectories],
            configOverrides: [],
            mcpServers: JSON.parse(JSON.stringify(requestOptions.mcpServers)),
          };
        } catch {
          current = { additionalDirectories: [], configOverrides: [], mcpServers: [] };
        }
      }
      this.acpSessionOptionsByKey.set(sessionKey, {
        additionalDirectories: [...current.additionalDirectories],
        configOverrides: cloneAcpConfigOverrides(configOverrides),
        mcpServers: JSON.parse(JSON.stringify(current.mcpServers)),
      });
      this.ensurePersistentAgentSession(agent);
    });
  }

  async finalizeAcpTurn(
    agentId: AgentId,
    runtimeEpoch: string,
    settledTurnHandle: string,
    stopReason: string,
    exactTurnSummary: string | null,
  ) {
    const agent = this.agents.get(agentId);
    if (!agent || runtimeKind(agent) !== 'acp') return;
    const runtime = runtimeBindingOf(agent, 'acp');
    if (!runtime || this.acpRuntime.bindingEpoch(agentId) !== runtimeEpoch) return;
    const effectiveStopReason = stopReason || runtime.stopReason || '';
    let attentionSummary = exactTurnSummary || '';
    if (ACP_ATTENTION_STOP_REASONS.has(effectiveStopReason) && exactTurnSummary === null) {
      try {
        attentionSummary = acpLastAssistantNotificationSummary(
          await this.acpRuntime.getTranscriptSessionForRead(agentId, { maxTurns: 1 }),
        );
      } catch {
        attentionSummary = '';
      }
    }
    if (this.agents.get(agentId) !== agent || this.acpRuntime.bindingEpoch(agentId) !== runtimeEpoch) return;
    const attentionInputSignature = () => JSON.stringify([
      agent.attentionAutoReadNext === true,
      agent.attentionOutputEpoch || '',
      finiteNumberOrNull(agent.attentionOutputSeq),
      agent.attentionReason || '',
      finiteNonNegativeInteger(agent.attentionSeq),
      finiteNumberOrNull(agent.attentionUpdatedAt),
      finiteNumberOrNull(agent.readAttentionAt),
      finiteNonNegativeInteger(agent.readAttentionSeq),
      agent.readOutputEpoch || '',
      finiteNumberOrNull(agent.readOutputSeq),
      agent.runtimeEpoch || '',
      agent.unread === true,
    ]);
    const stageFinalizedAgent = (currentRuntime: AcpRuntimeBinding) => {
      const staged = {
        ...agent,
        runtimeBinding: { ...currentRuntime },
        acpFinalizedTurnHandle: settledTurnHandle,
      } as TypedAgentRecord;
      let attentionUpdate: UnknownRecord | null = null;
      if (ACP_ATTENTION_STOP_REASONS.has(effectiveStopReason)) {
        staged.attentionSummary = attentionSummary;
        attentionUpdate = this.recordAgentAttentionEvent(staged, 'turn-complete', {
          persist: false,
          publish: false,
        });
      }
      return { attentionUpdate, staged };
    };
    const publishFinalizedAgent = (
      staged: TypedAgentRecord,
      attentionUpdate: UnknownRecord | null,
    ) => {
      Object.assign(agent, {
        acpFinalizedTurnHandle: staged.acpFinalizedTurnHandle,
        attentionAutoReadNext: staged.attentionAutoReadNext,
        attentionOutputEpoch: staged.attentionOutputEpoch,
        attentionOutputSeq: staged.attentionOutputSeq,
        attentionReason: staged.attentionReason,
        attentionSeq: staged.attentionSeq,
        attentionSummary: staged.attentionSummary,
        attentionUpdatedAt: staged.attentionUpdatedAt,
        readAttentionAt: staged.readAttentionAt,
        readAttentionSeq: staged.readAttentionSeq,
        unread: staged.unread,
      });
      if (attentionUpdate) {
        this.updateEngineProviderSessionMetadata(agent);
        this.emitAgentReadState(agent);
      }
      this.providerSessionService.observe(agentId, { force: true });
    };
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const currentRuntime = runtimeBindingOf(agent, 'acp');
      if (
        this.agents.get(agentId) !== agent
        || !currentRuntime
        || this.acpRuntime.bindingEpoch(agentId) !== runtimeEpoch
      ) return;
      const inputSignature = attentionInputSignature();
      let { attentionUpdate, staged } = stageFinalizedAgent(currentRuntime);
      const statePatch = {
        // The runtime event stored this stop reason before scheduling the
        // finalization. If a newer Turn has since changed it, do not restore
        // the older settled-Turn reason over the current runtime state.
        ...(currentRuntime.stopReason === effectiveStopReason
          ? { acpStopReason: effectiveStopReason }
          : {}),
        acpFinalizedTurnHandle: settledTurnHandle,
        attentionSeq: finiteNonNegativeInteger(staged.attentionSeq),
        readAttentionSeq: finiteNonNegativeInteger(staged.readAttentionSeq),
        attentionUpdatedAt: finiteNumberOrNull(staged.attentionUpdatedAt),
        readAttentionAt: finiteNumberOrNull(staged.readAttentionAt),
        attentionReason: staged.attentionReason || '',
        attentionOutputEpoch: staged.attentionOutputEpoch || '',
        attentionOutputSeq: finiteNumberOrNull(staged.attentionOutputSeq),
        readOutputEpoch: staged.readOutputEpoch || '',
        readOutputSeq: finiteNumberOrNull(staged.readOutputSeq),
        unread: staged.unread === true,
      };
      const beforeCommit = () => Boolean(
        this.agents.get(agentId) === agent
        && this.acpRuntime.bindingEpoch(agentId) === runtimeEpoch
        && attentionInputSignature() === inputSignature
      );

      if (typeof this.configManager?.persistAgentStatePatch === 'function') {
        this.assertPersistentAgentRuntimeOwner(agent);
        const result = await this.configManager.persistAgentStatePatch(agent, statePatch, { beforeCommit });
        if (result.status === 'fenced') {
          if (
            this.agents.get(agentId) !== agent
            || this.acpRuntime.bindingEpoch(agentId) !== runtimeEpoch
          ) return;
          await new Promise<void>(resolve => setImmediate(resolve));
          continue;
        }
        if (result.status === 'owner-mismatch') {
          throw new Error(`Agent ${agentId} state owner changed before Turn finalization commit`);
        }
        if (result.status === 'record-missing') {
          throw new Error(`Agent ${agentId} state record disappeared before Turn finalization commit`);
        }
        if (result.status === 'legacy-record') {
          // Legacy fsess records do not have a split Agent state file. Preserve
          // the existing synchronous durable barrier for that bounded path,
          // but re-stage from live state after the asynchronous capability
          // check so unrelated fields cannot be written from a stale snapshot.
          const legacyRuntime = runtimeBindingOf(agent, 'acp');
          if (
            this.agents.get(agentId) !== agent
            || !legacyRuntime
            || this.acpRuntime.bindingEpoch(agentId) !== runtimeEpoch
          ) return;
          ({ attentionUpdate, staged } = stageFinalizedAgent(legacyRuntime));
          this.assertPersistentAgentRuntimeOwner(agent);
          const agentRecordId = this.ensurePersistentAgentSession(staged);
          if (agentRecordId) setAgentRecordId(agent, agentRecordId);
        } else {
          // A newer read/output mutation can land after the atomic rename but
          // before this async continuation resumes. A full synchronous state
          // write can also supersede the durable patch without changing those
          // live attention inputs. Require both the store generation token and
          // the caller fence before publishing the staged state.
          const durableCommitIsCurrent = typeof this.configManager.isAgentStateCommitCurrent === 'function'
            && this.configManager.isAgentStateCommitCurrent(agent, result.id, result.commit);
          if (!durableCommitIsCurrent || !beforeCommit()) {
            await new Promise<void>(resolve => setImmediate(resolve));
            continue;
          }
          setAgentRecordId(agent, result.id);
        }
      } else {
        const agentRecordId = this.ensurePersistentAgentSession(staged);
        if (agentRecordId) setAgentRecordId(agent, agentRecordId);
      }

      if (this.agents.get(agentId) !== agent) return;
      publishFinalizedAgent(staged, attentionUpdate);
      return;
    }
    // Repeated user read mutations can keep invalidating the small async
    // publication window. After the bounded async retries, converge once with
    // the existing synchronous durable barrier so disk and live state cannot
    // remain permanently split. This is a pathological conflict fallback, not
    // the normal Turn-finalization path.
    const currentRuntime = runtimeBindingOf(agent, 'acp');
    if (
      this.agents.get(agentId) !== agent
      || !currentRuntime
      || this.acpRuntime.bindingEpoch(agentId) !== runtimeEpoch
    ) return;
    const { attentionUpdate, staged } = stageFinalizedAgent(currentRuntime);
    this.assertPersistentAgentRuntimeOwner(agent);
    const agentRecordId = this.ensurePersistentAgentSession(staged);
    if (agentRecordId) setAgentRecordId(agent, agentRecordId);
    publishFinalizedAgent(staged, attentionUpdate);
  }

  bindEngineEvents() {
    this.engineBridge.on('session-started', ({
      sessionId,
      status,
      startedAt,
      runtimeEpoch,
      outputSeq,
      stateRevision,
    }: TerminalSessionStateEvent) => {
        const agent = this.agents.get(sessionId);
        if (!agent) return;

        const disposition = terminalStateUpdateDisposition(agent, runtimeEpoch, outputSeq, stateRevision);
        if (!applyTerminalStateCursor(agent, runtimeEpoch, outputSeq, stateRevision, disposition)) return;
        setPendingTerminalStartSyncCut(agent, runtimeEpoch, outputSeq, stateRevision);

        agent.engineStarted = true;
        agent.engineStatus = status || 'running';
        agent.startedAt = startedAt || Date.now();
        this.observeAgentAttentionState(sessionId);
        this.providerSessionService.observe(sessionId, { force: true });
        this.emitStateChange({ agentIds: [sessionId] });
      });

    this.engineBridge.on('session-output', ({
      sessionId,
      data,
      engineName,
      runtimeEpoch,
      outputSeq,
      stateRevision,
    }: TerminalSessionOutputEvent & { engineName: string }) => {
        const agent = this.agents.get(sessionId);
        if (!agent) return;

        const disposition = terminalStateUpdateDisposition(agent, runtimeEpoch, outputSeq, stateRevision);
        if (!applyTerminalStateCursor(agent, runtimeEpoch, outputSeq, stateRevision, disposition)) return;
        clearPendingTerminalStartSyncCut(agent);

        this.reviveAgentRuntime(agent);
        agent.output = trimSessionOutput(agent.output + data);
        this.terminalStartupCoordinator.appendOutput(sessionId, data);
        const outputAt = Date.now();
        agent.lastEngineOutputAt = outputAt;
        this.lastActivity.set(sessionId, outputAt);

        this.recordAgentOutputActivity(
          sessionId,
          Buffer.byteLength(String(data), 'utf8'),
          outputAt,
        );
        this.getAgentUsageRate(sessionId, { now: outputAt });

        this.observeAgentAttentionState(sessionId);
        const sessionSource = this.getEngineSessionSource(engineName);
        const stream: UnknownRecord = {
          agentId: sessionId,
          data,
          sessionSource,
        };
        if (Number.isFinite(outputSeq)) {
          stream.outputSeq = outputSeq;
        }
        if (Number.isFinite(stateRevision)) {
          stream.stateRevision = stateRevision;
        }
        if (typeof runtimeEpoch === 'string' && runtimeEpoch) {
          stream.runtimeEpoch = runtimeEpoch;
        }
        this.emit('session-stream', stream);
      });

    this.engineBridge.on('session-transition', ({
      sessionId,
      engineName,
      kind,
      data = '',
      runtimeEpoch,
      outputSeq,
      stateRevision,
      cols,
      rows,
    }: TerminalSessionTransitionEvent & { engineName: string }) => {
      const agent = this.agents.get(sessionId);
      if (!agent) return;
      const disposition = terminalStateUpdateDisposition(agent, runtimeEpoch, outputSeq, stateRevision);
      if (!applyTerminalStateCursor(agent, runtimeEpoch, outputSeq, stateRevision, disposition)) return;
      clearPendingTerminalStartSyncCut(agent);
      this.reviveAgentRuntime(agent);
      if (kind === 'clear') {
        agent.output = '';
        agent.previewText = '';
        agent.previewSnapshot = null;
        this.usageRateTracker.forget(sessionId);
      }
      if (Number.isFinite(cols) && cols > 0) agent.previewCols = cols;
      if (Number.isFinite(rows) && rows > 0) agent.previewRows = rows;
      this.lastActivity.set(sessionId, Date.now());
      this.emit('session-stream', {
        agentId: sessionId,
        sessionSource: this.getEngineSessionSource(engineName),
        kind,
        data,
        runtimeEpoch,
        outputSeq,
        stateRevision,
        cols,
        rows,
      });
      this.observeAgentAttentionState(sessionId);
      this.emitStateChange({ agentIds: [sessionId] });
    });

    this.engineBridge.on('session-sync', ({
      sessionId,
      output,
      engineName,
      replaceLive = true,
      runtimeEpoch,
      outputSeq,
      stateRevision,
      textOutput,
      cols,
      rows,
    }: TerminalSessionSnapshotEvent & { engineName: string }) => {
        const agent = this.agents.get(sessionId);
        if (!agent) return;

        const hydratesStartedCut = consumesPendingTerminalStartSyncCut(
          agent,
          runtimeEpoch,
          outputSeq,
          stateRevision,
        );
        const disposition = terminalStateUpdateDisposition(agent, runtimeEpoch, outputSeq, stateRevision);
        if (
          !hydratesStartedCut &&
          !applyTerminalStateCursor(agent, runtimeEpoch, outputSeq, stateRevision, disposition)
        ) return;
        clearPendingTerminalStartSyncCut(agent);

        this.reviveAgentRuntime(agent);
        agent.output = trimSessionOutput(typeof textOutput === 'string' ? textOutput : output);
        agent.previewText = agent.output.slice(-2000);
        this.lastActivity.set(sessionId, Date.now());

        if (replaceLive) {
          const sessionSource = this.getEngineSessionSource(engineName);
          const stream: UnknownRecord = {
            agentId: sessionId,
            data: output,
            sessionSource,
            replace: true,
          };
          if (Number.isFinite(outputSeq)) {
            stream.outputSeq = outputSeq;
          }
          if (Number.isFinite(stateRevision)) {
            stream.stateRevision = stateRevision;
          }
          if (typeof runtimeEpoch === 'string' && runtimeEpoch) {
            stream.runtimeEpoch = runtimeEpoch;
          }
          if (typeof cols === 'number' && Number.isFinite(cols) && cols > 0) {
            stream.cols = cols;
          }
          if (typeof rows === 'number' && Number.isFinite(rows) && rows > 0) {
            stream.rows = rows;
          }
          this.emit('session-stream', stream);
        }
        void this.resolveCodexTerminalIdentityFromPreview(sessionId, agent.previewText);
        this.observeAgentAttentionState(sessionId);
        this.emitStateChange({ agentIds: [sessionId] });
      });

    this.engineBridge.on('session-preview', ({ sessionId, previewText, cols, rows, previewSnapshot, title, runtimeEpoch }: TerminalSessionPreviewEvent) => {
        const agent = this.agents.get(sessionId);
        if (
          !agent
          || runtimeKind(agent) !== 'terminal'
          || !terminalRuntimeEventMatches(agent, runtimeEpoch)
        ) return;

        const previousTerminalStatus = this.terminalStatusProjections.get(agent)
          || deriveAgentTerminalStatus(agent, {
            previewText: agent.previewText || '',
            title: agent.sessionTitle || '',
            terminalBusy: typeof agent.terminalBusy === 'boolean' ? agent.terminalBusy : null,
          });
        const previousCodexTerminalProfile = this.codexTerminalProfileProjections.has(agent)
          ? this.codexTerminalProfileProjections.get(agent) ?? null
          : (isRecord(agent.codexTerminalProfile) ? agent.codexTerminalProfile : null);
        const titleChanged = typeof title === 'string'
          ? this.updateAgentSessionTitle(agent, title)
          : false;
        agent.previewText = previewText || '';
        agent.previewSnapshot = previewSnapshot || null;
        if (Number.isFinite(cols) && cols > 0) {
          agent.previewCols = cols;
        }
        if (Number.isFinite(rows) && rows > 0) {
          agent.previewRows = rows;
        }
        const terminalStatus = deriveAgentTerminalStatus(agent, {
          previewText: agent.previewText,
          title: agent.sessionTitle || '',
          terminalBusy: typeof agent.terminalBusy === 'boolean' ? agent.terminalBusy : null,
        });
        const runtimeObservation = deriveRuntimeObservation({ ...agent, terminalStatus });
        const codexTerminalProfile = activeCodexTerminalProfile(agent, agent.previewText) || null;
        this.terminalStatusProjections.set(agent, terminalStatus);
        this.codexTerminalProfileProjections.set(agent, codexTerminalProfile);
        this.emit('session-preview-update', {
          agentId: sessionId,
          previewText: agent.previewText,
          cols: agent.previewCols || 80,
          rows: agent.previewRows || 30,
          previewSnapshot: agent.previewSnapshot,
          codexTerminalProfile,
          terminalStatus,
          runtimeObservation,
        });
        const patch: UnknownRecord = {};
        if (!titleChanged && !terminalStatusEqual(previousTerminalStatus, terminalStatus)) {
          patch.terminalStatus = terminalStatus;
          patch.runtimeObservation = runtimeObservation;
        }
        if (!titleChanged && !codexTerminalProfileEqual(previousCodexTerminalProfile, codexTerminalProfile)) {
          patch.codexTerminalProfile = codexTerminalProfile;
        }
        if (Object.keys(patch).length > 0) {
          this.emit('agent-update', {
            agentId: sessionId,
            patch,
          });
        }
        void this.resolveCodexTerminalIdentityFromPreview(sessionId, agent.previewText);
        this.observeAgentAttentionState(sessionId);
        if (titleChanged) {
          this.emitStateChange({ agentIds: [sessionId] });
        }
      });

    this.engineBridge.on('session-title', ({ sessionId, title, runtimeEpoch }: TerminalSessionTitleEvent) => {
        const agent = this.agents.get(sessionId);
        if (!agent || !terminalRuntimeEventMatches(agent, runtimeEpoch)) return;

        if (this.updateAgentSessionTitle(agent, title)) {
          this.observeAgentAttentionState(sessionId);
          this.emitStateChange({ agentIds: [sessionId] });
        }
      });

    this.engineBridge.on('session-activity', ({ sessionId, lastActivityAt, runtimeEpoch }: TerminalSessionActivityEvent) => {
        const agent = this.agents.get(sessionId);
        if (!agent || !terminalRuntimeEventMatches(agent, runtimeEpoch)) return;
        this.lastActivity.set(sessionId, lastActivityAt || Date.now());
        this.observeAgentAttentionState(sessionId);
        this.emitActivityUpdate(sessionId, lastActivityAt || Date.now());
      });

    this.engineBridge.on('session-busy-state', (payload: TerminalSessionBusyStateEvent) => {
        const {
          sessionId,
          terminalBusy,
          cwd,
          lastExitCode,
          shellEvent,
          shellCommand,
          shellLastCommand,
          shellCommandStartedAt,
          shellLastCommandStartedAt,
          shellLastCommandFinishedAt,
          shellLastCommandDurationMs,
          statusMarkerSeen,
          busyMarkerSeen,
          runtimeEpoch,
        } = payload;
        const agent = this.agents.get(sessionId);
        if (!agent || !terminalRuntimeEventMatches(agent, runtimeEpoch)) return;
        const previousShellCwd = agent.shellCwd || '';

        const previousState = JSON.stringify({
          terminalBusy: agent.terminalBusy,
          shellCwd: agent.shellCwd || '',
          shellLastExitCode: agent.shellLastExitCode ?? null,
          shellLastEvent: agent.shellLastEvent || '',
          shellCommand: agent.shellCommand || '',
          shellLastCommand: agent.shellLastCommand || '',
          shellCommandStartedAt: agent.shellCommandStartedAt ?? null,
          shellLastCommandStartedAt: agent.shellLastCommandStartedAt ?? null,
          shellLastCommandFinishedAt: agent.shellLastCommandFinishedAt ?? null,
          shellLastCommandDurationMs: agent.shellLastCommandDurationMs ?? null,
          shellStatusMarkerSeen: agent.shellStatusMarkerSeen === true,
          shellBusyMarkerSeen: agent.shellBusyMarkerSeen === true,
        });
        if (typeof terminalBusy === 'boolean') {
          agent.terminalBusy = terminalBusy;
        }
        if (typeof cwd === 'string' && cwd) {
          agent.shellCwd = cwd;
        }
        if (Object.prototype.hasOwnProperty.call(payload, 'lastExitCode')) {
          agent.shellLastExitCode = typeof lastExitCode === 'number' ? lastExitCode : null;
        }
        if (shellEvent === 'start' || shellEvent === 'finish') {
          agent.shellLastEvent = shellEvent;
        }
        if (Object.prototype.hasOwnProperty.call(payload, 'shellCommand')) {
          agent.shellCommand = typeof shellCommand === 'string' ? shellCommand : '';
        }
        if (Object.prototype.hasOwnProperty.call(payload, 'shellLastCommand')) {
          agent.shellLastCommand = typeof shellLastCommand === 'string' ? shellLastCommand : '';
        } else if (shellEvent === 'finish' && agent.shellCommand) {
          agent.shellLastCommand = agent.shellCommand;
          agent.shellCommand = '';
        }
        if (Object.prototype.hasOwnProperty.call(payload, 'shellCommandStartedAt')) {
          agent.shellCommandStartedAt = finiteNumberOrNull(shellCommandStartedAt);
        }
        if (Object.prototype.hasOwnProperty.call(payload, 'shellLastCommandStartedAt')) {
          agent.shellLastCommandStartedAt = finiteNumberOrNull(shellLastCommandStartedAt);
        }
        if (Object.prototype.hasOwnProperty.call(payload, 'shellLastCommandFinishedAt')) {
          agent.shellLastCommandFinishedAt = finiteNumberOrNull(shellLastCommandFinishedAt);
        }
        if (Object.prototype.hasOwnProperty.call(payload, 'shellLastCommandDurationMs')) {
          agent.shellLastCommandDurationMs = finiteNumberOrNull(shellLastCommandDurationMs);
        }
        if (statusMarkerSeen === true) {
          agent.shellStatusMarkerSeen = true;
        }
        if (busyMarkerSeen === true) {
          agent.shellBusyMarkerSeen = true;
        }
        const nextState = JSON.stringify({
          terminalBusy: agent.terminalBusy,
          shellCwd: agent.shellCwd || '',
          shellLastExitCode: agent.shellLastExitCode ?? null,
          shellLastEvent: agent.shellLastEvent || '',
          shellCommand: agent.shellCommand || '',
          shellLastCommand: agent.shellLastCommand || '',
          shellCommandStartedAt: agent.shellCommandStartedAt ?? null,
          shellLastCommandStartedAt: agent.shellLastCommandStartedAt ?? null,
          shellLastCommandFinishedAt: agent.shellLastCommandFinishedAt ?? null,
          shellLastCommandDurationMs: agent.shellLastCommandDurationMs ?? null,
          shellStatusMarkerSeen: agent.shellStatusMarkerSeen === true,
          shellBusyMarkerSeen: agent.shellBusyMarkerSeen === true,
        });
        if (previousState === nextState) return;
        if (agent.shellCwd && agent.shellCwd !== previousShellCwd) {
          void this.refreshAgentWorktree(sessionId, agent.shellCwd);
        }
        this.observeAgentAttentionState(sessionId);
        const patch = terminalMetadataPatch(agent);
        this.terminalStatusProjections.set(agent, patch.terminalStatus);
        this.emit('agent-update', { agentId: sessionId, patch });
      });

    this.engineBridge.on('session-notification', ({
      sessionId,
      runtimeEpoch,
      message,
      title,
    }: TerminalSessionNotificationEvent) => {
      const agent = this.agents.get(sessionId);
      if (!agent || !terminalRuntimeEventMatches(agent, runtimeEpoch)) return;
      const summary = agentNotificationSummary(message || title);
      const provider = agent.providerSessionProvider
        || agentHomeProviderForProgram(agent.forkCommand || agent.command || '');
      if (
        provider === 'qwen'
        && (
          this.isAgentAttentionTurnActive(agent)
          || this.attentionTracker.hasQwenTerminalIdleCandidate(agent.id)
        )
      ) {
        agent.pendingTerminalNotificationSummary = summary;
        return;
      }
      agent.attentionSummary = summary;
      if (this.isAgentAttentionTurnActive(agent)) {
        agent.terminalNotificationAttentionUntil = Date.now() + TERMINAL_NOTIFICATION_COMPLETION_SUPPRESS_MS;
      }
      this.recordAgentAttentionEvent(agent, 'terminal-notification');
    });

    this.engineBridge.on('session-exited', ({
      sessionId,
      code,
      exitedAt,
      runtimeEpoch,
      stateProofAvailable,
    }: TerminalSessionExitEvent) => {
        const agent = this.agents.get(sessionId);
        if (!agent || !terminalRuntimeEventMatches(agent, runtimeEpoch)) return;
        clearPendingTerminalStartSyncCut(agent);
        if (this.permissionRestartSuppressedAgentIds.has(sessionId)) return;

        if (stateProofAvailable === false) {
          this.providerSessionService.stop(sessionId);
          agent.status = 'dead';
          agent.engineStatus = 'dead';
          agent.terminalBusy = false;
          agent.exitedAt = exitedAt || Date.now();
          const proofError = 'Terminal exited without an authoritative final checkpoint';
          if (!String(agent.output || '').includes(proofError)) {
            agent.output = trimSessionOutput(`${agent.output || ''}\n${proofError}`);
          }
          this.observeAgentAttentionState(sessionId);
          this.providerSessionService.observe(sessionId, { force: true });
          this.emitStateChange({ agentIds: [sessionId] });
          return;
        }

        if (!agent.validated) {
          const removedMainAgent = this.mainAgentId === sessionId;
          this.providerSessionService.stop(sessionId);
          this.deleteAgentRecord(sessionId);
          this.lastActivity.delete(sessionId);
          this.lastActivityUpdate.delete(sessionId);
          this.usageRateTracker.forget(sessionId);

          if (this.mainAgentId === sessionId) {
            this.mainAgentId = null;
          }

          this.emitStateChange({
            removedAgentIds: [sessionId],
            ...(removedMainAgent ? { mainAgentIdChanged: true } : {}),
          });
          return;
        }

        this.providerSessionService.stop(sessionId);
        agent.status = sessionId === this.mainAgentId ? 'dead' : 'stopped';
        agent.exitedAt = exitedAt || Date.now();
        agent.output = trimSessionOutput(`${agent.output}\nProcess exited with code ${code}`);
        this.observeAgentAttentionState(sessionId);
        this.providerSessionService.observe(sessionId, { force: true });
        if (sessionId !== this.mainAgentId) {
          this.recordTaskHistory(agent, {
            reason: 'process-exit',
            archivedAt: Date.now(),
          });
        }
        this.emitStateChange({
          agentIds: [sessionId],
          ...(sessionId !== this.mainAgentId ? { taskHistoryChanged: true } : {}),
        });
      });

    this.engineBridge.on('session-error', ({ sessionId, error, fatal = true, runtimeEpoch }: TerminalSessionErrorEvent) => {
        const agent = this.agents.get(sessionId);
        if (!agent || !terminalRuntimeEventMatches(agent, runtimeEpoch)) return;
        if (this.permissionRestartSuppressedAgentIds.has(sessionId)) return;

        if (fatal === false) {
          return;
        }
        if (isSessionNotAvailableError(error) && this.shouldDeferMissingEngineSession(agent)) {
          return;
        }

        this.markAgentSessionDead(sessionId, error);
      });
  }

  async recoverEngineSessions() {
    if (!this.engineBridge || typeof this.engineBridge.recoverSessions !== 'function') {
      return;
    }

    const recovered = await this.engineBridge.recoverSessions();
    const recordStore = this.configManager;
    const listPersistedRecords = recordStore && typeof recordStore.listAgentSessionRecords === 'function'
      ? () => recordStore.listAgentSessionRecords()
      : () => [] as PersistedAgentPrivateMetadata[];
    let persistedRecords = listPersistedRecords();
    // Durable Fork convergence happens at this shared boundary, before the
    // Terminal/ACP split, so both runtimes consume one already-blocked truth.
    if (this.blockInterruptedPersistedForkOperations(persistedRecords)) {
      persistedRecords = listPersistedRecords();
    }
    const mainPageSessionKeys = new Set(this.getMainPageSessionKeys());
    const persistedByRuntimeAgentId = new Map<string, PersistedAgentPrivateMetadata>(persistedRecords
      .filter((record: PersistedAgentPrivateMetadata) => typeof record.runtimeAgentId === 'string' && Boolean(record.runtimeAgentId))
      .map((record: PersistedAgentPrivateMetadata) => [record.runtimeAgentId as string, record]));
    const recoveredRuntimeAgentIds = new Set<string>((recovered || [])
      .map((entry: RecoveredEngineSession) => recoveredEngineSessionId(entry, entry.metadata))
      .filter((id: string): id is string => Boolean(id)));
    let changed = false;

    for (const entry of recovered || []) {
      const engineMetadata = entry.metadata || {};
      const state = entry.state || {};
      const agentId = recoveredEngineSessionId(entry, engineMetadata);
      const persisted = persistedByRuntimeAgentId.get(agentId);
      const desiredMetadata = persisted || engineMetadata;
      const persistedLifecycleOperation = activeLifecycleOperation(desiredMetadata);
      const hasRecoverableLifecycleOperation = persistedLifecycleOperation
        && ['create', 'delete', 'archive', 'fork'].includes(persistedLifecycleOperation.type);
      if (
        !hasRecoverableLifecycleOperation
        && !shouldRestoreAgentFromMetadata({
          ...desiredMetadata,
          id: String(desiredMetadata.id || agentId || ''),
          lifecycleJournal: lifecycleJournal(desiredMetadata) as LifecycleJournal,
          providerSessionResolvedAt: typeof desiredMetadata.providerSessionResolvedAt === 'number'
            ? desiredMetadata.providerSessionResolvedAt
            : null,
        }, mainPageSessionKeys)
      ) {
        await this.killRecoveredEngineSession(entry, engineMetadata, agentId);
        continue;
      }
      // The persisted runtime mode is authoritative. A PTY can outlive the
      // server long enough to appear in native-host recovery after the Agent
      // has already switched to ACP. Recovering that stale PTY first would
      // overwrite the persisted record back to `terminal` before
      // recoverAcpSessions() gets a chance to read it.
      if (runtimeKind(persisted) === 'acp') {
        await this.killRecoveredEngineSession(entry, engineMetadata, agentId);
        continue;
      }
      const persistedProvider = String(persisted?.providerSessionProvider || persisted?.provider || '').trim();
      const metadata = persisted ? {
        ...engineMetadata,
        // The native host owns the live PTY/reducer state, but the Farming
        // session record owns stable product identity. Legacy hosts can omit
        // these fields during recovery; projecting that incomplete metadata
        // even briefly makes Chat/Terminal switching disappear until a later
        // provider resolver update happens to repair it.
        source: persisted.source || engineMetadata.source,
        forkRequestId: typeof persisted.forkRequestId === 'string'
          ? persisted.forkRequestId
          : engineMetadata.forkRequestId,
        forkRequestSignature: typeof persisted.forkRequestSignature === 'string'
          ? persisted.forkRequestSignature
          : engineMetadata.forkRequestSignature,
        persistentSessionId: persisted.id || persisted.persistentSessionId || engineMetadata.persistentSessionId,
        projectWorkspace: persisted.projectWorkspace || engineMetadata.projectWorkspace,
        provider: persistedProvider || engineMetadata.provider,
        providerSessionProvider: persistedProvider || engineMetadata.providerSessionProvider,
        providerHomeId: persisted.providerHomeId || engineMetadata.providerHomeId,
        providerHomePath: persisted.providerHomePath || engineMetadata.providerHomePath,
        providerSessionId: persisted.providerSessionId || engineMetadata.providerSessionId,
        providerSessionKey: persisted.providerSessionKey || engineMetadata.providerSessionKey,
        providerSessionTemporary: Object.prototype.hasOwnProperty.call(persisted, 'providerSessionTemporary')
          ? persisted.providerSessionTemporary === true
          : engineMetadata.providerSessionTemporary,
        providerSessionSource: persisted.providerSessionSource || engineMetadata.providerSessionSource,
        providerSessionMaterialized: persisted.providerSessionMaterialized !== false,
        providerSessionResolvedAt: persisted.providerSessionResolvedAt || engineMetadata.providerSessionResolvedAt,
        providerSessionTitle: persisted.providerSessionTitle || engineMetadata.providerSessionTitle,
        providerSessionWorkspace: persisted.providerSessionWorkspace || engineMetadata.providerSessionWorkspace,
        terminalInputReceived: Object.prototype.hasOwnProperty.call(persisted, 'terminalInputReceived')
          ? persisted.terminalInputReceived === true
          : engineMetadata.terminalInputReceived,
        composerCommands: normalizedComposerCommands(persisted.composerCommands),
        customTitle: Object.prototype.hasOwnProperty.call(persisted, 'customTitle')
          ? persisted.customTitle
          : engineMetadata.customTitle,
        adaptiveTitle: Object.prototype.hasOwnProperty.call(persisted, 'adaptiveTitle')
          ? persisted.adaptiveTitle
          : engineMetadata.adaptiveTitle,
        lifecycleJournal: lifecycleJournal(persisted),
        ...legacyRuntimeMetadata(persisted),
        pinned: persisted.pinned === true,
        projectOrder: finiteOrder(persisted.projectOrder) ?? finiteOrder(engineMetadata.projectOrder),
        pinnedOrder: finiteOrder(persisted.pinnedOrder) ?? finiteOrder(engineMetadata.pinnedOrder),
      } : engineMetadata;
      if (!agentId || this.agents.has(agentId)) continue;

      const agentRecord = this.recoveredAgentRecord(agentId, entry.engineName || metadata.engineName || 'native', metadata, state);
      agentRecord.lastObservedTurnActive = this.isAgentAttentionTurnActive(agentRecord);
      this.registerAgentRecord(agentId, agentRecord);
      const recoveredLifecycleOperation = activeLifecycleOperation(agentRecord);
      if (
        recoveredLifecycleOperation?.type === 'create'
        && ['pending', 'membership-pending'].includes(recoveredLifecycleOperation.state)
      ) {
        try {
          if (recoveredLifecycleOperation.state === 'membership-pending') {
            this.rememberMainPageProviderSession(agentRecord);
          }
          this.transitionPersistentAgentOperation(
            agentRecord,
            recoveredLifecycleOperation.id,
            'succeeded',
            '',
            { visibleOnMainPage: true, archived: false },
          );
        } catch (caughtError: unknown) {
      const error = caughtError as ErrorRecord;
          this.markRecoveredAgentLifecycleBlocked(agentRecord, recoveredLifecycleOperation, error);
        }
      } else if (
        recoveredLifecycleOperation?.type === 'delete'
        || recoveredLifecycleOperation?.type === 'archive'
      ) {
        const result = recoveredLifecycleOperation.type === 'delete'
          ? await this.killAgent(agentId, {
              reason: 'delete-recovery',
              skipRecoveryWait: true,
            })
          : await this.archiveAgent(agentId, {
              reason: 'archive-recovery',
              skipRecoveryWait: true,
            });
        if (result?.error) {
          console.warn(
            `Failed to resume Agent ${recoveredLifecycleOperation.type} ${agentId}: ${result.error}`,
          );
        }
        changed = true;
        continue;
      } else if (recoveredLifecycleOperation) {
        this.markRecoveredAgentLifecycleBlocked(agentRecord, recoveredLifecycleOperation);
      } else {
        this.ensurePersistentAgentSession(agentRecord, {
          visibleOnMainPage: true,
          archived: false,
        });
      }
      const recoveredUpdate = this.reconcilePersistedAgentUpdate(agentRecord);
      if (recoveredUpdate?.error) {
        console.warn(`Failed to reconcile Agent update ${agentId}: ${recoveredUpdate.error}`);
      }
      void this.refreshAgentWorktree(agentId);
      this.lastActivity.set(agentId, state.lastActivityAt || metadata.lastActivityAt || Date.now());
      if (agentRecord.wantsMain && !this.mainAgentId) {
        this.mainAgentId = agentId;
      }
      if (
        recoveredLifecycleOperation?.type !== 'fork'
        || shouldRestoreAgentFromMetadata(agentRecord, mainPageSessionKeys)
      ) {
        this.rememberMainPageProviderSession(agentRecord);
        this.providerSessionService.activate(agentId);
        void this.resolveCodexTerminalIdentityFromCurrentView(agentId);
      }
      changed = true;
    }

    if (await this.reconcileMissingTerminalLifecycleOperations(
      persistedRecords,
      recoveredRuntimeAgentIds,
    )) {
      changed = true;
    }

    if (changed) {
      this.emitStateChange({
        agentIds: [...this.agents.keys()],
        mainAgentIdChanged: true,
        taskHistoryChanged: true,
      });
    }

    const runtimeRotations = this.engineBridge && typeof this.engineBridge.consumeRuntimeRotations === 'function'
      ? this.engineBridge.consumeRuntimeRotations()
      : [];
    if (runtimeRotations.length > 0) {
      await this.restoreTerminalSessionsAfterRuntimeRotation(persistedRecords, runtimeRotations);
    }

    await this.recoverAcpSessions();
    if (this.reconcileDetachedPersistedAgentUpdates()) {
      this.emitStateChange({ agentIds: [...this.agents.keys()] });
    }
  }

  markRecoveredAgentLifecycleBlocked(
    agent: TypedAgentRecord,
    operation: LifecycleOperation,
    cause: ErrorRecord | null = null,
  ): void {
    const reason = cause
      ? `Agent ${operation.type} operation ${operation.id} recovery could not be committed: ${cause.message || cause}`
      : `Agent ${operation.type} operation ${operation.id} must be resolved before restart`;
    agent.status = 'error';
    agent.engineStatus = 'lifecycle-blocked';
    const runtime = runtimeBindingOf(agent);
    if (runtime && Object.prototype.hasOwnProperty.call(runtime, 'state')) {
      runtime.state = 'error';
      runtime.error = reason;
    }
  }

  private blockInterruptedPersistedForkOperations(records: PersistedAgentPrivateMetadata[]): boolean {
    let changed = false;
    for (const record of Array.isArray(records) ? records : []) {
      const operation = activeLifecycleOperation(record);
      if (operation?.type !== 'fork' || operation.state === 'blocked') continue;
      const agentId = String(record.runtimeAgentId || '').trim();
      if (!agentId) {
        // Without an exact runtime Agent identity there is no staged record to
        // persist through and no runtime start to block; the operation keeps
        // its pending truth instead of being committed against a guess.
        console.warn(
          `Persisted Fork operation ${operation.id} on record ${record.id || record.persistentSessionId || 'unknown'} has no exact runtime Agent identity; keeping its pending journal truth`,
        );
        continue;
      }
      const staged = this.recoveredAgentRecord(
        agentId,
        record.engine || 'native',
        { ...record, persistentSessionId: record.id || record.persistentSessionId || '' },
        { status: String(record.status || 'exited') },
      );
      setAgentRecordId(staged, record.id || record.persistentSessionId || '');
      try {
        this.transitionPersistentAgentOperation(
          staged,
          operation.id,
          'blocked',
          `Fork operation ${operation.id} was interrupted by a restart before its outcome was recorded; `
          + 'retry the same Fork request to reconcile it, or archive or delete this Agent',
        );
        changed = true;
      } catch (caughtError: unknown) {
        const error = caughtError as ErrorRecord;
        console.warn(
          `Failed to persist blocked Fork operation ${operation.id} for Agent ${agentId}:`,
          error && (error.message || error),
        );
      }
    }
    return changed;
  }

  async reconcileMissingTerminalLifecycleOperations(
    records: PersistedAgentPrivateMetadata[],
    recoveredRuntimeAgentIds: Set<string>,
  ) {
    let changed = false;
    for (const record of Array.isArray(records) ? records : []) {
      const agentId = String(record?.runtimeAgentId || '').trim();
      const operation = activeLifecycleOperation(record);
      if (
        !agentId
        || recoveredRuntimeAgentIds.has(agentId)
        || runtimeKind(record) !== 'terminal'
        || !operation
      ) {
        continue;
      }
      if (operation.type === 'fork') {
        // The shared recovery prepass owns the durable blocked transition.
        // Here the source only needs a fail-closed row so the blocked Fork
        // stays reachable for same-request reconcile or archive/delete.
        if (this.agents.has(agentId)) continue;
        const blockedAgent = this.recoveredAgentRecord(
          agentId,
          record.engine || 'native',
          { ...record, persistentSessionId: record.id || record.persistentSessionId || '' },
          { status: 'exited' },
        );
        setAgentRecordId(blockedAgent, record.id || record.persistentSessionId || '');
        this.markRecoveredAgentLifecycleBlocked(blockedAgent, operation);
        this.registerAgentRecord(agentId, blockedAgent);
        this.lastActivity.set(agentId, Date.now());
        changed = true;
        continue;
      }
      if (!['create', 'delete', 'archive'].includes(operation.type)) {
        continue;
      }

      const recoveredAgent = this.recoveredAgentRecord(
        agentId,
        record.engine || 'native',
        { ...record, persistentSessionId: record.id || record.persistentSessionId || '' },
        { status: 'exited' },
      );
      setAgentRecordId(recoveredAgent, record.id || record.persistentSessionId || '');
      try {
        if (operation.type === 'create') {
          this.transitionPersistentAgentOperation(
            recoveredAgent,
            operation.id,
            'failed',
            'Create runtime was not present in the authoritative native-host recovery set',
            createFailurePatch(
              operation,
              operation.request?.previousRuntimeAgentId,
            ),
          );
        } else if (operation.type === 'delete') {
          this.transitionPersistentAgentOperation(
            recoveredAgent,
            operation.id,
            'succeeded',
            '',
            {
              visibleOnMainPage: false,
              archived: true,
              archivedAt: Date.now(),
              runtimeAgentId: '',
            },
          );
          this.removeMainPageProviderSessionsForAgents([recoveredAgent]);
        } else {
          this.transitionPersistentAgentOperation(
            recoveredAgent,
            operation.id,
            'provider-archive-pending',
            '',
            {
              visibleOnMainPage: false,
              archived: true,
              archivedAt: Date.now(),
              runtimeAgentId: '',
            },
          );
          this.removeMainPageProviderSessionsForAgents([recoveredAgent]);
          const providerArchive = await this.archiveCodexProviderSession(recoveredAgent);
          this.transitionPersistentAgentOperation(
            recoveredAgent,
            operation.id,
            providerArchive?.error ? 'blocked' : 'succeeded',
            providerArchive?.error || '',
          );
        }
        changed = true;
      } catch (caughtError: unknown) {
      const error = caughtError as ErrorRecord;
        console.warn(
          `Failed to reconcile missing Terminal Agent ${agentId} ${operation.type}:`,
          error && (error.message || error),
        );
      }
    }
    return changed;
  }

  async restoreTerminalSessionsAfterRuntimeRotation(
    records: PersistedAgentPrivateMetadata[],
    rotations: RuntimeRotationRecord[],
  ) {
    const mainPageOrder = new Map(this.getMainPageSessionKeys().map((key: string, index: number) => [key, index]));
    const mainPageSessionKeys = new Set(mainPageOrder.keys());
    const liveProviderSessions = new Set(
      [...this.agents.values()]
        .filter((agent: TypedAgentRecord) => agent?.providerSessionProvider && agent?.providerSessionId)
        .map((agent: TypedAgentRecord) => mainPageAgentSessionKey(
          agent.providerSessionProvider,
          agent.providerSessionId,
          agent.providerHomeId || 'default'
        ))
        .filter(Boolean)
    );
    const recordList = Array.isArray(records) ? records : [];
    const recordByRuntimeAgentId = new Map<string, PersistedAgentPrivateMetadata>(recordList
      .filter(record => typeof record.runtimeAgentId === 'string' && Boolean(record.runtimeAgentId))
      .map(record => [record.runtimeAgentId as string, record]));
    const serializedStates: SerializedTerminalStateEntry[] = [];
    for (const rotation of Array.isArray(rotations) ? rotations : []) {
      if (!rotation || typeof rotation.serializedTerminalState !== 'string' || !rotation.serializedTerminalState) continue;
      try {
        const decoded: unknown = deserializeTerminalState(rotation.serializedTerminalState);
        if (Array.isArray(decoded)) {
          serializedStates.push(...decoded.filter((state): state is SerializedTerminalStateEntry => (
            isRecord(state) && typeof state.id === 'string'
          )));
        }
      } catch (caughtError: unknown) {
      const error = caughtError as ErrorRecord;
        console.warn(
          'Ignoring invalid serialized terminal state after native PTY runtime rotation:',
          error && (error.message || error)
        );
      }
    }
    const serializedByRuntimeAgentId = new Map<string, SerializedTerminalStateEntry>(serializedStates.map(state => [state.id, state]));
    const candidateKeys = new Set<string>();
    const fallbackCandidates: TerminalRecoveryCandidate[] = recordList
      .filter(record => {
        if (!record || record.archived === true) return false;
        if (runtimeKind(record) !== 'terminal') return false;
        const provider = String(record.providerSessionProvider || record.provider || '').trim();
        if (!getProviderAdapter(provider)) return false;
        if (!isSafeProviderSessionId(record.providerSessionId)) return false;
        const sessionKey = canonicalProviderSessionKey(record.providerSessionKey) || mainPageAgentSessionKey(
          provider,
          record.providerSessionId,
          record.providerHomeId || 'default'
        );
        if (!sessionKey || liveProviderSessions.has(sessionKey)) return false;
        if (record.wantsMain === true) return !this.mainAgentId;
        return mainPageOrder.has(sessionKey);
      })
      .sort((left, right) => {
        if (left.wantsMain === true && right.wantsMain !== true) return -1;
        if (right.wantsMain === true && left.wantsMain !== true) return 1;
        const leftProvider = String(left.providerSessionProvider || left.provider || '').trim();
        const rightProvider = String(right.providerSessionProvider || right.provider || '').trim();
        const leftKey = canonicalProviderSessionKey(left.providerSessionKey) || mainPageAgentSessionKey(
          leftProvider,
          left.providerSessionId,
          left.providerHomeId || 'default'
        );
        const rightKey = canonicalProviderSessionKey(right.providerSessionKey) || mainPageAgentSessionKey(
          rightProvider,
          right.providerSessionId,
          right.providerHomeId || 'default'
        );
        const orderDelta = Number(mainPageOrder.get(leftKey) ?? Number.MAX_SAFE_INTEGER) -
          Number(mainPageOrder.get(rightKey) ?? Number.MAX_SAFE_INTEGER);
        if (orderDelta !== 0) return orderDelta;
        return (Number(right.updatedAt) || 0) - (Number(left.updatedAt) || 0);
      })
      .filter(record => {
        const provider = String(record.providerSessionProvider || record.provider || '').trim();
        const sessionKey = canonicalProviderSessionKey(record.providerSessionKey) || mainPageAgentSessionKey(
          provider,
          record.providerSessionId,
          record.providerHomeId || 'default'
        );
        if (candidateKeys.has(sessionKey)) return false;
        candidateKeys.add(sessionKey);
        return true;
      })
      .map(record => ({
        ...record,
        id: record.id,
        runtimeAgentId: record.runtimeAgentId as string,
      }));
    const candidates: TerminalRecoveryCandidate[] = serializedByRuntimeAgentId.size > 0
      ? [...serializedByRuntimeAgentId.values()]
        .map((serializedState): TerminalRecoveryCandidate => ({
          ...(serializedState.metadata || {}),
          ...(recordByRuntimeAgentId.get(serializedState.id) || {}),
          id: recordByRuntimeAgentId.get(serializedState.id)?.id || serializedState.id,
          lifecycleJournal: lifecycleJournal(
            recordByRuntimeAgentId.get(serializedState.id) || serializedState.metadata || {},
          ) as LifecycleJournal,
          providerSessionResolvedAt: typeof (
            recordByRuntimeAgentId.get(serializedState.id)?.providerSessionResolvedAt
            ?? serializedState.metadata?.providerSessionResolvedAt
          ) === 'number'
            ? Number(
                recordByRuntimeAgentId.get(serializedState.id)?.providerSessionResolvedAt
                ?? serializedState.metadata?.providerSessionResolvedAt,
              )
            : null,
          runtimeAgentId: serializedState.id,
          serializedState,
        }))
        .filter(record => {
          if (!record || record.archived === true) return false;
          return runtimeKind(record) === 'terminal';
        })
        .sort((left, right) => {
          if (left.wantsMain === true && right.wantsMain !== true) return -1;
          if (right.wantsMain === true && left.wantsMain !== true) return 1;
          return (Number(right.updatedAt) || 0) - (Number(left.updatedAt) || 0);
        })
      : fallbackCandidates;
    const desiredCandidates = candidates.filter(record => shouldRestoreAgentFromMetadata(record, mainPageSessionKeys));

    if (desiredCandidates.length > 0) {
      const rotationSummary = rotations.map(rotation => {
        const { serializedTerminalState, ...rest } = rotation || {};
        return {
          ...rest,
          serializedTerminalStateBytes: typeof serializedTerminalState === 'string'
            ? Buffer.byteLength(serializedTerminalState, 'utf8')
            : 0,
        };
      });
      console.warn(
        `Restoring ${desiredCandidates.length} Terminal session(s) after native PTY runtime rotation`,
        rotationSummary
      );
    }

    let changed = false;
    for (const record of desiredCandidates) {
      if (record.wantsMain === true && this.mainAgentId) continue;
      const provider = String(record.providerSessionProvider || record.provider || '').trim();
      const sessionId = record.providerSessionId;
      const sessionKey = canonicalProviderSessionKey(record.providerSessionKey) || mainPageAgentSessionKey(
        provider,
        sessionId,
        record.providerHomeId || 'default'
      );
      if (sessionKey && liveProviderSessions.has(sessionKey)) continue;
      if (
        provider === 'codex'
        && record.terminalInputReceived === true
        && (
          record.providerSessionTemporary === true
          || isTemporaryProviderSessionId(sessionId)
        )
      ) {
        console.warn(
          `Refusing to replace Codex Terminal ${record.runtimeAgentId || sessionId} after native PTY runtime rotation without an exact resume id`
        );
        continue;
      }
      const canResumeProvider = Boolean(getProviderAdapter(provider))
        && isSafeProviderSessionId(sessionId);
      const command = canResumeProvider
        ? buildAgentSessionResumeCommand(provider, sessionId, {
            cwd: record.cwd || record.projectWorkspace || '',
            providerHomePath: record.providerHomePath || '',
          })
        : (
            record.forkCommand ||
            record.command ||
            record.serializedState?.processLaunchConfig?.command ||
            ''
          );
      if (!command) continue;

      const options: UnknownRecord = {
        wantsMain: record.wantsMain === true,
        skipRecoveryWait: true,
        task: record.task || record.providerSessionTitle || '',
        workflowTemplate: record.workflowTemplate || '',
        projectWorkspace: record.projectWorkspace || record.cwd || '',
        source: canResumeProvider
          ? resumedAgentSource(provider, sessionId, record.providerHomeId || 'default')
          : (record.source || 'terminal-revive'),
        providerHomeId: record.providerHomeId || '',
        providerHomePath: record.providerHomePath || '',
        providerSessionTitle: record.providerSessionTitle || '',
        providerSessionMaterialized: record.providerSessionMaterialized !== false,
        restartedFromAgentId: record.restartedFromAgentId || '',
        restartedFromAgentIds: Array.isArray(record.restartedFromAgentIds)
          ? record.restartedFromAgentIds
          : [],
        projectOrder: finiteOrder(record.projectOrder),
        pinnedOrder: finiteOrder(record.pinnedOrder),
        customTitle: record.customTitle || '',
        adaptiveTitle: record.adaptiveTitle || '',
        pinned: record.pinned === true,
        attentionSeq: finiteNonNegativeInteger(record.attentionSeq),
        readAttentionSeq: finiteNonNegativeInteger(record.readAttentionSeq),
        attentionUpdatedAt: finiteNumberOrNull(record.attentionUpdatedAt),
        readAttentionAt: finiteNumberOrNull(record.readAttentionAt),
        attentionReason: record.attentionReason || '',
        attentionOutputEpoch: record.attentionOutputEpoch || '',
        attentionOutputSeq: finiteNumberOrNull(record.attentionOutputSeq),
        readOutputEpoch: record.readOutputEpoch || '',
        readOutputSeq: finiteNumberOrNull(record.readOutputSeq),
        persistentSessionId: record.id || '',
        runtimeAgentId: record.runtimeAgentId || '',
        reviveTerminalState: record.serializedState || null,
        composerCommands: normalizedComposerCommands(record.composerCommands),
        ...(provider === 'codex'
          ? {
              codexApprovalMode: record.launchPermissionMode || undefined,
              ...preserveCodexSessionProfileOptions(),
            }
          : {}),
        ...(provider === 'claude'
          ? { claudePermissionMode: record.launchPermissionMode || undefined }
          : {}),
      };

      let restartedAgentId = null;
      try {
        restartedAgentId = await this.startAgent(
          command,
          record.cwd || record.projectWorkspace || null,
          null,
          options
        );
      } catch (caughtError: unknown) {
      const error = caughtError as ErrorRecord;
        console.warn(
          `Failed to restore Terminal session ${record.runtimeAgentId || sessionId} after native PTY runtime rotation:`,
          error && (error.message || error)
        );
        continue;
      }
      const replacement = restartedAgentId ? this.agents.get(restartedAgentId) : null;
      if (!replacement) {
        console.warn(
          `Failed to restore Terminal session ${record.runtimeAgentId || sessionId} after native PTY runtime rotation`
        );
        continue;
      }

      replacement.pinned = record.pinned === true;
      replacement.projectOrder = finiteOrder(record.projectOrder);
      replacement.pinnedOrder = finiteOrder(record.pinnedOrder);
      replacement.customTitle = record.customTitle || replacement.customTitle || '';
      replacement.terminalInputReceived = record.terminalInputReceived === true;
      replacement.attentionSeq = finiteNonNegativeInteger(record.attentionSeq);
      replacement.readAttentionSeq = finiteNonNegativeInteger(record.readAttentionSeq);
      replacement.attentionUpdatedAt = finiteNumberOrNull(record.attentionUpdatedAt);
      replacement.readAttentionAt = finiteNumberOrNull(record.readAttentionAt);
      replacement.attentionReason = record.attentionReason || '';
      replacement.attentionOutputEpoch = record.attentionOutputEpoch || '';
      replacement.attentionOutputSeq = finiteNumberOrNull(record.attentionOutputSeq);
      replacement.readOutputEpoch = record.readOutputEpoch || '';
      replacement.readOutputSeq = finiteNumberOrNull(record.readOutputSeq);
      replacement.unread = agentAttentionUnread(replacement);
      this.ensurePersistentAgentSession(replacement);
      if (sessionKey) liveProviderSessions.add(sessionKey);
      changed = true;
    }
    if (changed) this.emitStateChange({ agentIds: [...this.agents.keys()] });
  }

  async recoverAcpSessions() {
    if (!this.acpRuntime || !this.configManager || typeof this.configManager.listAgentSessionRecords !== 'function') return;
    let persistedRecords = this.configManager.listAgentSessionRecords();
    if (!persistedRecords.some((record: PersistedAgentPrivateMetadata) => runtimeKind(record) === 'acp')) return;
    try {
      await this.acpRuntime.initialize?.();
    } catch (caughtError: unknown) {
      const error = caughtError as ErrorRecord;
      const mainPageSessionKeys = new Set(this.getMainPageSessionKeys());
      const affectedAgentIds: string[] = [];
      for (const record of persistedRecords) {
        if (
          runtimeKind(record) !== 'acp'
          || (
            !shouldRestoreAgentFromMetadata(record, mainPageSessionKeys)
            && !lifecycleOperationBlocksRuntimeStart(record)
          )
        ) continue;
        const agentId = String(record.runtimeAgentId || '').trim();
        if (!agentId) continue;
        const agent = this.agents.get(agentId)
          || this.recoveredAgentRecord(agentId, record.engine || 'native', record, { status: 'running' });
        if (!this.agents.has(agentId)) {
          setAgentRecordId(agent, record.id || '');
          this.registerAgentRecord(agentId, agent);
        }
        const runtime = replaceRuntimeBinding(agent, 'acp', runtimeBindingOf(agent, 'acp'));
        runtime.state = 'error';
        runtime.error = `ACP runtime Host unavailable: ${error.message || error}`;
        agent.status = 'stopped';
        agent.engineStatus = 'stopped';
        agent.engineStarted = false;
        agent.exitedAt = Date.now();
        this.ensurePersistentAgentSession(agent);
        affectedAgentIds.push(agentId);
      }
      if (affectedAgentIds.length > 0) this.emitStateChange({ agentIds: affectedAgentIds });
      console.warn('ACP runtime Host recovery is unavailable:', error.message || error);
      return;
    }
    const liveHostBindingIds = new Set([...this.acpRuntime.bindings.keys()]);
    await this.reconcilePersistedAcpLifecycleOperations(
      persistedRecords,
      liveHostBindingIds,
    );
    // Reconciliation commits terminal lifecycle outcomes to the authoritative
    // store. Never materialize Agents from the pre-reconciliation snapshot:
    // a completed Delete would otherwise be resurrected and a failed Create
    // could remain visible until another restart.
    persistedRecords = this.configManager.listAgentSessionRecords();
    const mainPageOrder = new Map(this.getMainPageSessionKeys().map((key: string, index: number) => [key, index]));
    const mainPageSessionKeys = new Set(mainPageOrder.keys());
    const records = persistedRecords
      .filter((record: PersistedAgentPrivateMetadata) => (
        (
          shouldRestoreAgentFromMetadata(record, mainPageSessionKeys)
          || lifecycleOperationBlocksRuntimeStart(record)
        )
        && runtimeKind(record) === 'acp'
      ))
      .sort((left: PersistedAgentPrivateMetadata, right: PersistedAgentPrivateMetadata) => {
        const leftOrder = mainPageOrder.get(canonicalProviderSessionKey(left.providerSessionKey));
        const rightOrder = mainPageOrder.get(canonicalProviderSessionKey(right.providerSessionKey));
        return Number(leftOrder ?? Number.MAX_SAFE_INTEGER) - Number(rightOrder ?? Number.MAX_SAFE_INTEGER);
      });

    // Materialize every recoverable row before loading provider transcripts. Large
    // Codex histories can take tens of seconds each; creating rows one by one
    // after every await temporarily leaves later main-page sessions invisible
    // in both Projects and History.
    for (const record of records) {
      const agentId = String(record.runtimeAgentId || '').trim();
      const provider = String(record.providerSessionProvider || record.provider || '').trim();
      const sessionId = String(record.providerSessionId || '').trim();
      const blockedOperation = lifecycleOperationBlocksRuntimeStart(record);
      if (
        !agentId
        || !providerSupportsRuntime(provider, 'acp')
        || (!sessionId && !blockedOperation)
      ) {
        continue;
      }
      const agent = this.agents.get(agentId);
      if (!agent) {
        const recoveredAgent = this.recoveredAgentRecord(agentId, record.engine || 'native', record, { status: 'running' });
        setAgentRecordId(recoveredAgent, record.id || '');
        recoveredAgent.engineStarted = false;
        if (blockedOperation) {
          recoveredAgent.status = 'error';
          recoveredAgent.engineStatus = 'lifecycle-blocked';
          const runtime = replaceRuntimeBinding(
            recoveredAgent,
            'acp',
            runtimeBindingOf(recoveredAgent, 'acp'),
          );
          runtime.state = 'error';
          runtime.error = `Agent ${blockedOperation.type} operation ${blockedOperation.id} must be resolved before restart`;
        } else {
          const runtime = replaceRuntimeBinding(
            recoveredAgent,
            'acp',
            runtimeBindingOf(recoveredAgent, 'acp'),
          );
          runtime.state = 'connecting';
        }
        this.registerAgentRecord(agentId, recoveredAgent);
        void this.refreshAgentWorktree(agentId);
        this.lastActivity.set(agentId, Date.now());
      }
    }
    this.emitStateChange({ agentIds: records.map(record => String(record.runtimeAgentId || '')).filter(Boolean) });
    this.acpRuntime.publishRecoveredBindings?.();

    for (const record of records) {
      const agentId = String(record.runtimeAgentId || '').trim();
      const agent = this.agents.get(agentId);
      if (!agent) continue;
      const recoveredUpdate = this.reconcilePersistedAgentUpdate(agent);
      if (recoveredUpdate?.error) {
        console.warn(`Failed to reconcile Agent update ${agentId}: ${recoveredUpdate.error}`);
      }
    }

    // A compatible Server-only restart may reconnect bindings that survived in
    // the ACP Host. Reconcile those cheap, already-live bindings in persisted
    // order before starting cold work so lifecycle membership remains
    // deterministic. A full Farming stop leaves this list empty.
    const coldRecords: PersistedAgentPrivateMetadata[] = [];
    for (const record of records) {
      const agentId = String(record.runtimeAgentId || '').trim();
      const provider = String(record.providerSessionProvider || record.provider || '').trim();
      const sessionId = String(record.providerSessionId || '').trim();
      const agent = this.agents.get(agentId);
      const liveHostBinding = this.acpRuntime.hasBinding(agentId);
      if (!agent || (!sessionId && !liveHostBinding) || !providerSupportsRuntime(provider, 'acp')) continue;
      if (lifecycleOperationBlocksRuntimeStart(record) && !liveHostBinding) continue;
      if (!liveHostBinding) {
        coldRecords.push(record);
        continue;
      }
      try {
        const recoveryEnv = this.buildAgentEnv(agentId, agent);
        const snapshot = this.acpRuntime.getSession(agentId, { maxEntries: 0 });
        const hostSessionId = String(snapshot.sessionId || '');
        if (hostSessionId && hostSessionId !== sessionId) {
          throw new Error('ACP runtime Host binding does not match the persisted provider Session');
        }
        const requestOptions = this.acpRuntime.getSessionRequestOptions(agentId);
        this.acpSessionOptionsByKey.set(String(agent.providerSessionKey || ''), {
          additionalDirectories: [...requestOptions.additionalDirectories],
          configOverrides: cloneAcpConfigOverrides(requestOptions.configOverrides),
          mcpServers: JSON.parse(JSON.stringify(requestOptions.mcpServers)),
        });
        this.acpRuntime.registerBindingCallbacks?.(agentId, {
          refreshMcpServersForRuntime: mcpServers => (
            this.projectAcpMcpServersForRuntime(mcpServers.filter(isRecord), recoveryEnv)
          ),
          onProcessStarted: async (processIdentity: AcpProcessIdentity) => {
            agent.structuredRuntimeProcess = {
              kind: 'acp-process-group',
              ...processIdentity,
              ...(this.configInstanceFingerprint
                ? { configInstanceFingerprint: this.configInstanceFingerprint }
                : {}),
            };
            this.ensurePersistentAgentSession(agent);
          },
          onProcessStopped: () => {
            agent.structuredRuntimeProcess = null;
            this.ensurePersistentAgentSession(agent);
          },
        });
        const createOperation = activeLifecycleOperation(agent);
        if (createOperation?.type === 'create') {
          agent.status = 'running';
          agent.engineStatus = 'running';
          this.transitionPersistentAgentOperation(
            agent,
            createOperation.id,
            'membership-pending',
            '',
            { visibleOnMainPage: true, archived: false },
          );
          this.rememberMainPageProviderSession(agent);
          this.transitionPersistentAgentOperation(
            agent,
            createOperation.id,
            'succeeded',
            '',
            { visibleOnMainPage: true, archived: false },
          );
        }
        this.ensurePersistentAgentSession(agent);
      } catch (caughtError: unknown) {
        const error = caughtError as ErrorRecord;
        const runtime = replaceRuntimeBinding(
          agent,
          'acp',
          runtimeBindingOf(agent, 'acp'),
        );
        runtime.state = 'error';
        runtime.error = `ACP recovery failed: ${error && (error.message || error)}`;
        agent.status = 'stopped';
        agent.engineStatus = 'stopped';
        agent.engineStarted = false;
        agent.exitedAt = Date.now();
        this.ensurePersistentAgentSession(agent);
      }
    }

    const cleanupByProcess = new Map<string, Promise<StopPersistedAcpProcessResult>>();
    const recoveredAgentIds = new Set<string>();
    await runWithBoundedConcurrency(
      coldRecords,
      ACP_SESSION_RECOVERY_CONCURRENCY,
      async (record) => {
        const agentId = String(record.runtimeAgentId || '').trim();
        const provider = String(record.providerSessionProvider || record.provider || '').trim();
        const sessionId = String(record.providerSessionId || '').trim();
        const agent = this.agents.get(agentId);
        if (!agent || !sessionId || !providerSupportsRuntime(provider, 'acp')) return;
        try {
          if (
            !record.structuredRuntimeProcess
            && !this.allowUnprovenLegacyAcpRecovery
            && !record.legacyAcpProcessExitAcknowledgedAt
          ) {
            const cleanupError: MutableError = new Error(
              'Legacy ACP process exit cannot be proven after restart; automatic recovery is blocked',
            );
            cleanupError.code = 'ACP_PROCESS_CLEANUP_UNCERTAIN';
            throw cleanupError;
          }
          if (
            record.structuredRuntimeProcess
            && !this.hasLiveAcpProcessPeer(
              agentId,
              record.structuredRuntimeProcess,
              records,
              liveHostBindingIds,
            )
          ) {
            let cleanup: StopPersistedAcpProcessResult;
            try {
              const cleanupKey = [
                record.structuredRuntimeProcess.pid,
                record.structuredRuntimeProcess.processGroupId,
                record.structuredRuntimeProcess.startedAt,
              ].join('\u0000');
              let cleanupPromise = cleanupByProcess.get(cleanupKey);
              if (!cleanupPromise) {
                cleanupPromise = this.stopPersistedAcpProcessGroup(record.structuredRuntimeProcess);
                cleanupByProcess.set(cleanupKey, cleanupPromise);
              }
              cleanup = await cleanupPromise;
            } catch (caughtCause: unknown) {
              const cause = caughtCause as ErrorRecord;
              const cleanupError: MutableError = new Error(
                `Persisted ACP process exit proof failed: ${cause.message || cause}`,
                { cause },
              );
              cleanupError.code = 'ACP_PROCESS_CLEANUP_UNCERTAIN';
              throw cleanupError;
            }
            if (cleanup.stopped !== true) {
              const cleanupError: MutableError = new Error('Persisted ACP process identity could not be safely stopped');
              cleanupError.code = 'ACP_PROCESS_CLEANUP_UNCERTAIN';
              throw cleanupError;
            }
            agent.structuredRuntimeProcess = null;
            this.ensurePersistentAgentSession(agent);
          }
        const providerAdapter = getProviderAdapter(provider);
        if (!providerAdapter) throw new Error(`Unsupported Agent provider: ${provider}`);
        const acpRuntimeMode = record.acpRuntimeMode === 'custom' ? 'custom' : 'managed';
        const executableResolution = validatePersistedAcpExecutable(
          provider,
          record.acpRuntimeExecutable,
          {
            environment: executableOwnershipEnvironment(this.configManager?.farmingDir || ''),
            requireFarmingOwned: acpRuntimeMode === 'managed'
              && providerAdapter.acp.executablePolicy === 'managed',
          },
        );
        if (executableResolution.error) throw new Error(executableResolution.error);
        const executable = executableResolution.path;
        agent.acpRuntimeMode = acpRuntimeMode;
        agent.acpRuntimeExecutable = executable;
        const approvalMode = agent.launchPermissionMode || (
          provider === 'codex' && this.configManager?.getCodexApprovalMode
            ? this.configManager.getCodexApprovalMode()
            : 'approve'
        );
        const launchEnv = this.buildAgentEnv(agentId, agent);
        const recoveryMcpSource = Array.isArray(record.acpMcpServers)
          ? record.acpMcpServers.filter(isRecord)
          : [];
        const recoveryProjection = this.projectAcpMcpServersForRuntime(
          recoveryMcpSource,
          launchEnv,
        );
        const recoveryMcpServers = recoveryProjection.mcpServers;
        const recoveryConfigOverrides = cloneAcpConfigOverrides(record.acpConfigOverrides);
        const prepared = await this.acpRuntime.prepareAgent({
          agentId,
          provider,
          executable,
          env: launchEnv,
          cwd: agent.cwd,
          projectWorkspace: effectiveAgentWorkspaceRoot(agent),
          sessionId,
          historyMode: 'checkpoint',
          providerHomeId: agent.providerHomeId || record.providerHomeId || 'default',
          providerHomePath: agent.providerHomePath || record.providerHomePath || '',
          approvalMode,
          // Let Codex resolve its selected Home config and existing session
          // state instead of applying today's Farming launch defaults.
          model: 'config',
          reasoningEffort: 'config',
          serviceTier: 'config',
          farmingSystemPrompt: renderFarmingAgentBootstrap(),
          additionalDirectories: Array.isArray(record.acpAdditionalDirectories) ? record.acpAdditionalDirectories : [],
          configOverrides: recoveryConfigOverrides,
          capabilityRuntimeEpoch: recoveryProjection.capabilityRuntimeEpoch,
          mcpServers: recoveryMcpServers,
          refreshMcpServersForRuntime: mcpServers => (
            this.projectAcpMcpServersForRuntime(mcpServers.filter(isRecord), launchEnv)
          ),
          onProcessStarted: async (processIdentity: AcpProcessIdentity) => {
            agent.structuredRuntimeProcess = {
              kind: 'acp-process-group',
              ...processIdentity,
              ...(this.configInstanceFingerprint
                ? { configInstanceFingerprint: this.configInstanceFingerprint }
                : {}),
            };
            this.ensurePersistentAgentSession(agent);
          },
        });
        agent.providerSessionId = prepared.sessionId;
        agent.providerSessionKey = mainPageAgentSessionKey(
          provider,
          prepared.sessionId,
          agent.providerHomeId || record.providerHomeId || 'default'
        );
        const restoredConfigOverrides = Array.isArray(prepared.configOverrides)
          ? cloneAcpConfigOverrides(prepared.configOverrides)
          : recoveryConfigOverrides;
        let recoveredSessionOptions: AcpSessionOptionsRecord = {
          additionalDirectories: Array.isArray(record.acpAdditionalDirectories)
            ? record.acpAdditionalDirectories
            : [],
          configOverrides: restoredConfigOverrides,
          mcpServers: recoveryMcpServers,
        };
        try {
          const requestOptions = this.acpRuntime.getSessionRequestOptions(agentId);
          recoveredSessionOptions = {
            additionalDirectories: [...requestOptions.additionalDirectories],
            configOverrides: restoredConfigOverrides,
            mcpServers: JSON.parse(JSON.stringify(requestOptions.mcpServers)),
          };
        } catch {
          // The live binding already validated these options. Retain the
          // projected copy for custom runtimes that do not expose it.
        }
        this.acpSessionOptionsByKey.set(String(agent.providerSessionKey || ''), {
          additionalDirectories: [...recoveredSessionOptions.additionalDirectories],
          configOverrides: cloneAcpConfigOverrides(recoveredSessionOptions.configOverrides),
          mcpServers: JSON.parse(JSON.stringify(recoveredSessionOptions.mcpServers)),
        });
        agent.providerSessionTemporary = false;
        agent.providerSessionSource = `acp-${prepared.historyMode}`;
        const runtime = replaceRuntimeBinding(agent, 'acp', runtimeBindingOf(agent, 'acp'));
        runtime.state = 'idle';
        runtime.stopReason = '';
        runtime.error = '';
        agent.status = 'running';
        agent.engineStatus = 'running';
        agent.engineStarted = false;
        agent.requiresProcessExitAcknowledgement = false;
        this.ensurePersistentAgentSession(agent);
        recoveredAgentIds.add(agentId);
      } catch (caughtError: unknown) {
        const error = caughtError as ErrorRecord;
        const runtime = replaceRuntimeBinding(
          agent,
          'acp',
          runtimeBindingOf(agent, 'acp'),
        );
        runtime.state = 'error';
        runtime.error = `ACP recovery failed: ${error && (error.message || error)}`;
        const cleanupUncertain = error?.code === 'ACP_PROCESS_CLEANUP_UNCERTAIN';
        agent.status = cleanupUncertain ? 'error' : 'stopped';
        agent.engineStatus = cleanupUncertain ? 'cleanup-uncertain' : 'stopped';
        agent.requiresProcessExitAcknowledgement = cleanupUncertain
          && !record.structuredRuntimeProcess
          && !record.legacyAcpProcessExitAcknowledgedAt;
        agent.engineStarted = false;
        agent.exitedAt = Date.now();
        this.ensurePersistentAgentSession(agent);
      }
      },
    );

    // Most recovered Sessions are already present in the authoritative main
    // page index. Repair only missing memberships, in reverse persisted order,
    // so parallel completion timing cannot reorder the user's Agent list.
    const indexedSessionKeys = new Set(this.getMainPageSessionKeys());
    for (let index = coldRecords.length - 1; index >= 0; index -= 1) {
      const agentId = String(coldRecords[index].runtimeAgentId || '').trim();
      if (!recoveredAgentIds.has(agentId)) continue;
      const agent = this.agents.get(agentId);
      const sessionKey = agent
        ? mainPageAgentSessionKey(
            agent.providerSessionProvider,
            agent.providerSessionId,
            agent.providerHomeId || '',
          )
        : '';
      if (!agent || !sessionKey || indexedSessionKeys.has(sessionKey)) continue;
      this.rememberMainPageProviderSession(agent);
      indexedSessionKeys.add(sessionKey);
    }
    this.emitStateChange({ agentIds: records.map(record => String(record.runtimeAgentId || '')).filter(Boolean) });
  }

  hasLiveAcpProcessPeer(
    agentId: AgentId,
    identity: StructuredRuntimeProcessIdentity | null | undefined,
    records: Iterable<PersistedAgentPrivateMetadata | TypedAgentRecord>,
    liveBindingIds: ReadonlySet<string>,
  ): boolean {
    if (!identity) return false;
    for (const record of records) {
      const otherAgentId = String(record.runtimeAgentId || record.id || '').trim();
      if (
        otherAgentId
        && otherAgentId !== agentId
        && liveBindingIds.has(otherAgentId)
        && sameStructuredRuntimeProcess(record.structuredRuntimeProcess, identity)
      ) return true;
    }
    return false;
  }

  async reconcilePersistedAcpLifecycleOperations(
    records: PersistedAgentPrivateMetadata[],
    liveHostBindingIds: ReadonlySet<string> = new Set(),
  ) {
    for (const record of Array.isArray(records) ? records : []) {
      const operation = activeLifecycleOperation(record);
      if (
        runtimeKind(record) !== 'acp'
        || !operation
        || !['create', 'delete', 'archive'].includes(operation.type)
      ) {
        continue;
      }

      const agentId = String(
        operation.type === 'create'
          ? operation.request?.agentId || record.runtimeAgentId || ''
          : record.runtimeAgentId || '',
      ).trim();
      if (!agentId) continue;
      if (liveHostBindingIds.has(agentId)) {
        if (operation.type === 'create') {
          if (operation.state !== 'membership-pending') continue;
        } else {
          try {
            if (await this.acpRuntime.unregisterAgentAndWait(agentId) !== true) continue;
          } catch {
            continue;
          }
        }
      }

      const processProofRequired = operation.request?.structuredProcessProofRequired === true
        || Boolean(record.structuredRuntimeProcess);
      if (!liveHostBindingIds.has(agentId) && processProofRequired && !record.legacyAcpProcessExitAcknowledgedAt) {
        if (!record.structuredRuntimeProcess) continue;
        if (!this.hasLiveAcpProcessPeer(agentId, record.structuredRuntimeProcess, records, liveHostBindingIds)) {
          try {
            const cleanup = await this.stopPersistedAcpProcessGroup(record.structuredRuntimeProcess);
            if (
              cleanup.stopped !== true
              && !(
                cleanup.missingProof === true
                && operation.request?.structuredProcessStartGated === true
              )
            ) {
              continue;
            }
          } catch (caughtError: unknown) {
      const error = caughtError as ErrorRecord;
            console.warn(
              `Could not prove persisted ACP process exit for ${record.runtimeAgentId || operation.id}:`,
              error && (error.message || error),
            );
            continue;
          }
        }
      }

      const staged = this.recoveredAgentRecord(
        agentId,
        record.engine || 'native',
        { ...record, persistentSessionId: record.id || '' },
        { status: 'exited' },
      );
      setAgentRecordId(staged, record.id || '');
      staged.structuredRuntimeProcess = null;
      try {
        if (operation.type === 'create' && operation.state === 'membership-pending') {
          this.rememberMainPageProviderSession(staged);
          this.transitionPersistentAgentOperation(
            staged,
            operation.id,
            'succeeded',
            '',
            { archived: false },
          );
        } else if (operation.type === 'create') {
          this.transitionPersistentAgentOperation(
            staged,
            operation.id,
            'failed',
            'Create ACP process was stopped during restart recovery',
            createFailurePatch(operation, operation.request?.previousRuntimeAgentId),
          );
        } else if (operation.type === 'delete') {
          this.transitionPersistentAgentOperation(
            staged,
            operation.id,
            'succeeded',
            '',
            {
              visibleOnMainPage: false,
              archived: true,
              archivedAt: Date.now(),
              runtimeAgentId: '',
              structuredRuntimeProcess: null,
            },
          );
          this.removeMainPageProviderSessionsForAgents([staged]);
        } else {
          this.transitionPersistentAgentOperation(
            staged,
            operation.id,
            'provider-archive-pending',
            '',
            {
              visibleOnMainPage: false,
              archived: true,
              archivedAt: Date.now(),
              runtimeAgentId: '',
              structuredRuntimeProcess: null,
            },
          );
          this.removeMainPageProviderSessionsForAgents([staged]);
          const providerArchive = await this.archiveCodexProviderSession(staged);
          this.transitionPersistentAgentOperation(
            staged,
            operation.id,
            providerArchive?.error ? 'blocked' : 'succeeded',
            providerArchive?.error || '',
          );
        }
      } catch (caughtError: unknown) {
      const error = caughtError as ErrorRecord;
        console.warn(
          `Failed to reconcile ACP Agent ${agentId} ${operation.type}:`,
          error && (error.message || error),
        );
      }
    }
  }

  reconcileDetachedPersistedAgentUpdates() {
    if (!this.configManager || typeof this.configManager.listAgentSessionRecords !== 'function') {
      return false;
    }
    let changed = false;
    for (const record of this.configManager.listAgentSessionRecords()) {
      const operation = activeLifecycleOperation(record);
      const agentId = String(record?.runtimeAgentId || '').trim();
      if (
        operation?.type !== 'update'
        || !agentId
        || this.agents.has(agentId)
      ) {
        continue;
      }

      const staged = this.recoveredAgentRecord(
        agentId,
        record.engine || 'native',
        record,
        { status: 'stopped' },
      );
      setAgentRecordId(staged, record.id || '');
      const request = operation.request || {};
      if (Object.prototype.hasOwnProperty.call(request, 'customTitle')) {
        staged.customTitle = String(request.customTitle || '').trim().slice(0, 80);
      }
      if (Object.prototype.hasOwnProperty.call(request, 'task')) {
        staged.task = String(request.task || '').trim().slice(0, 240);
      }
      if (typeof request.pinned === 'boolean') {
        staged.pinned = request.pinned;
        if (!staged.pinned) staged.pinnedOrder = null;
      }
      if (request.archived === false) {
        staged.archived = false;
        staged.archivedAt = null;
      }
      if (typeof request.readAttentionSeq === 'number') {
        staged.readAttentionSeq = Math.min(
          finiteNonNegativeInteger(staged.attentionSeq),
          Math.max(
            finiteNonNegativeInteger(staged.readAttentionSeq),
            finiteNonNegativeInteger(request.readAttentionSeq),
          ),
        );
        staged.unread = agentAttentionUnread(staged);
      }
      if (
        typeof request.readOutputEpoch === 'string'
        && typeof request.readOutputSeq === 'number'
      ) {
        staged.readOutputEpoch = request.readOutputEpoch;
        staged.readOutputSeq = finiteNonNegativeInteger(request.readOutputSeq);
      }
      transitionLifecycleOperation(staged, operation.id, 'succeeded');
      try {
        this.ensurePersistentAgentSession(staged);
        changed = true;
      } catch (caughtError: unknown) {
      const error = caughtError as ErrorRecord;
        console.warn(
          `Failed to reconcile detached Agent update ${operation.id}:`,
          error && (error.message || error),
        );
      }
    }
    return changed;
  }

  async killRecoveredEngineSession(
    entry: RecoveredEngineSession,
    metadata: RuntimeEngineMetadata,
    agentId: AgentId,
  ): Promise<void> {
    if (!this.engineBridge || typeof this.engineBridge.killSession !== 'function') return;
    const engineName = entry.engineName || metadata.engineName || 'native';
    try {
      await this.engineBridge.killSession(engineName, agentId);
    } catch (caughtError: unknown) {
      const error = caughtError as ErrorRecord;
      console.warn('Failed to kill unrecovered engine session:', agentId, error && (error.message || error));
    }
  }

  async whenRecovered() {
    await this.recoveryPromise;
    if (this.recoveryError) {
      const message = this.recoveryError instanceof Error
        ? this.recoveryError.message
        : String(this.recoveryError);
      throw new Error(
        `Agent lifecycle recovery failed: ${message}`,
        { cause: this.recoveryError },
      );
    }
  }

  recoveredAgentRecord(
    agentId: AgentId,
    engineName: string,
    metadata: RecoveredEngineSessionMetadata,
    state: RecoveredSessionStateInput,
  ): TypedAgentRecord {
    const wantsMain = metadata.wantsMain === true;
    const providerSessionProvider = String(metadata.providerSessionProvider || metadata.provider || '');
    const providerSessionId = String(metadata.providerSessionId || '');
    const runtimeBinding = runtimeBindingFor(runtimeKind(metadata), metadata);
    const agentRecordId = metadata.agentRecordId || metadata.persistentSessionId || metadata.id || '';
    const structuredRuntimeProcess = isRecord(metadata.structuredRuntimeProcess)
      && Number.isSafeInteger(Number(metadata.structuredRuntimeProcess.pid))
      && Number.isSafeInteger(Number(metadata.structuredRuntimeProcess.processGroupId))
      && typeof metadata.structuredRuntimeProcess.startedAt === 'string'
      ? {
          kind: 'acp-process-group' as const,
          pid: Number(metadata.structuredRuntimeProcess.pid),
          processGroupId: Number(metadata.structuredRuntimeProcess.processGroupId),
          startedAt: metadata.structuredRuntimeProcess.startedAt,
          ...(typeof metadata.structuredRuntimeProcess.configInstanceFingerprint === 'string'
            && metadata.structuredRuntimeProcess.configInstanceFingerprint.trim()
            ? {
                configInstanceFingerprint:
                  metadata.structuredRuntimeProcess.configInstanceFingerprint.trim(),
              }
            : {}),
        }
      : null;
    const lifecycleOperation = activeLifecycleOperation(metadata);
    const requiresProcessExitAcknowledgement = runtimeKind(metadata) === 'acp'
      && !structuredRuntimeProcess
      && !metadata.legacyAcpProcessExitAcknowledgedAt
      && (
        metadata.requiresProcessExitAcknowledgement === true
        || Boolean(lifecycleOperation && ['delete', 'archive'].includes(lifecycleOperation.type))
      );
    return {
      id: agentId,
      command: metadata.forkCommand || metadata.command || '',
      forkCommand: metadata.forkCommand || metadata.command || '',
      cwd: metadata.cwd || '',
      output: typeof state.output === 'string' ? trimSessionOutput(state.output) : '',
      previewText: typeof state.previewText === 'string' ? state.previewText : '',
      previewSnapshot: state.previewSnapshot || null,
      previewCols: state.previewCols || 80,
      previewRows: state.previewRows || 30,
      sessionTitle: String(state.title || metadata.sessionTitle || ''),
      status: state.status === 'exited' ? 'stopped' : 'running',
      engineName,
      wantsMain,
      mainWorkspace: metadata.mainWorkspace || '',
      projectWorkspace: metadata.projectWorkspace || metadata.cwd || '',
      category: metadata.category || 'coding',
      launchPermissionMode: metadata.launchPermissionMode || '',
      parentAgentId: metadata.parentAgentId || '',
      forkRequestId: metadata.forkRequestId || '',
      forkRequestSignature: metadata.forkRequestSignature || '',
      task: metadata.task || '',
      workflowTemplate: metadata.workflowTemplate || '',
      source: metadata.source || 'recovered',
      providerSessionProvider,
      providerHomeId: metadata.providerHomeId || '',
      providerHomePath: metadata.providerHomePath || '',
      acpRuntimeMode: metadata.acpRuntimeMode === 'custom' ? 'custom' : 'managed',
      acpRuntimeExecutable: typeof metadata.acpRuntimeExecutable === 'string'
        ? metadata.acpRuntimeExecutable
        : '',
      providerSessionId,
      providerSessionKey: metadata.providerSessionKey || (
        providerSessionProvider && providerSessionId
          ? mainPageAgentSessionKey(providerSessionProvider, providerSessionId, metadata.providerHomeId || '')
          : ''
      ),
      providerSessionTemporary: metadata.providerSessionTemporary === true || isTemporaryProviderSessionId(providerSessionId),
      providerSessionSource: metadata.providerSessionSource || '',
      providerSessionMaterialized: metadata.providerSessionMaterialized !== false,
      providerSessionResolvedAt: metadata.providerSessionResolvedAt || null,
      providerSessionTitle: metadata.providerSessionTitle || '',
      providerSessionWorkspace: metadata.providerSessionWorkspace || '',
      terminalInputReceived: metadata.terminalInputReceived === true,
      structuredRuntimeProcess,
      legacyAcpProcessExitAcknowledgedAt:
        typeof metadata.legacyAcpProcessExitAcknowledgedAt === 'number'
          ? metadata.legacyAcpProcessExitAcknowledgedAt
          : null,
      requiresProcessExitAcknowledgement,
      // Legacy App Server records normalize to ACP at the runtime-binding
      // boundary. Codex thread ids are valid ACP session ids, so the existing
      // conversation remains recoverable without restarting App Server.
      runtimeBinding,
      forkedFromProviderSessionId: metadata.forkedFromProviderSessionId || '',
      restartedFromAgentId: metadata.restartedFromAgentId || '',
      restartedFromAgentIds: Array.isArray(metadata.restartedFromAgentIds)
        ? metadata.restartedFromAgentIds.filter((id: string) => typeof id === 'string' && id)
        : [],
      agentRecordId,
      persistentSessionId: agentRecordId,
      lifecycleJournal: lifecycleJournal(metadata),
      composerCommands: normalizedComposerCommands(metadata.composerCommands),
      customTitle: metadata.customTitle || '',
      adaptiveTitle: metadata.adaptiveTitle || '',
      capabilityRuntimeEpoch: typeof metadata.capabilityRuntimeEpoch === 'string'
        ? metadata.capabilityRuntimeEpoch
        : '',
      terminalBusy: typeof state.terminalBusy === 'boolean' ? state.terminalBusy : null,
      shellCwd: state.shellCwd || metadata.cwd || '',
      shellLastExitCode: typeof state.shellLastExitCode === 'number' ? state.shellLastExitCode : null,
      shellLastEvent: state.shellLastEvent || '',
      shellCommand: typeof state.shellCommand === 'string' ? state.shellCommand : '',
      shellLastCommand: typeof state.shellLastCommand === 'string' ? state.shellLastCommand : '',
      shellCommandStartedAt: finiteNumberOrNull(state.shellCommandStartedAt),
      shellLastCommandStartedAt: finiteNumberOrNull(state.shellLastCommandStartedAt),
      shellLastCommandFinishedAt: finiteNumberOrNull(state.shellLastCommandFinishedAt),
      shellLastCommandDurationMs: finiteNumberOrNull(state.shellLastCommandDurationMs),
      pinned: metadata.pinned === true,
      projectOrder: finiteOrder(metadata.projectOrder),
      pinnedOrder: finiteOrder(metadata.pinnedOrder),
      attentionSeq: finiteNonNegativeInteger(metadata.attentionSeq),
      readAttentionSeq: finiteNonNegativeInteger(metadata.readAttentionSeq),
      attentionUpdatedAt: finiteNumberOrNull(metadata.attentionUpdatedAt),
      readAttentionAt: finiteNumberOrNull(metadata.readAttentionAt),
      attentionReason: metadata.attentionReason || '',
      attentionOutputEpoch: metadata.attentionOutputEpoch || '',
      attentionOutputSeq: finiteNumberOrNull(metadata.attentionOutputSeq),
      readOutputEpoch: metadata.readOutputEpoch || '',
      readOutputSeq: finiteNumberOrNull(metadata.readOutputSeq),
      unread: finiteNonNegativeInteger(metadata.attentionSeq) > finiteNonNegativeInteger(metadata.readAttentionSeq),
      archived: false,
      archivedAt: null,
      canForkNewWorktree: this.canCreateForkWorktree(metadata.projectWorkspace || metadata.cwd || ''),
      validated: true,
      engineStarted: true,
      engineStatus: state.status || 'running',
      startedAt: state.startedAt || metadata.startedAt || Date.now(),
      runtimeEpoch: typeof state.runtimeEpoch === 'string' ? state.runtimeEpoch : '',
      stateRevision: finiteNumberOrNull(state.stateRevision),
      lastEngineOutputAt: Date.now(),
      lastOutputSeq: finiteNumberOrNull(state.outputSeq),
      attentionRequiresNewOutput: true,
      attentionBaselineOutputSeq: finiteNumberOrNull(state.outputSeq),
      attentionBaselineOutputAt: Date.now(),
      attentionTrackingReady: true,
      lastObservedTurnActive: false,
      attentionSuppressUntil: 0,
    };
  }

  reviveAgentRuntime(agent: TypedAgentRecord, sessionState: RecoveredSessionStateInput | null = null): boolean {
    if (!agent) return false;
    if (sessionState && !isLiveEngineSessionState(sessionState)) return false;
    if (!['dead', 'stopped', 'pending'].includes(agent.status || '')) {
      if (sessionState && sessionState.status) {
        agent.engineStatus = sessionState.status;
      }
      return false;
    }

    agent.status = 'running';
    agent.engineStatus = sessionState && sessionState.status ? sessionState.status : 'running';
    agent.exitedAt = null;
    agent.terminalBusy = typeof agent.terminalBusy === 'boolean' ? agent.terminalBusy : null;
    return true;
  }

  shouldDeferMissingEngineSession(agent: TypedAgentRecord) {
    if (!agent || !isRunningAgentRuntimeStatus(agent.status || '')) return false;
    if (agent.engineStarted === false) return true;
    const startedAt = Number(agent.startedAt);
    return Number.isFinite(startedAt) && Date.now() - startedAt < MISSING_ENGINE_SESSION_STARTUP_GRACE_MS;
  }

  getMainPageSessionKeys(): string[] {
    const persistedKeys: string[] = (() => {
      if (this.configManager && typeof this.configManager.getMainPageSessionKeys === 'function') {
        return this.configManager.getMainPageSessionKeys();
      }
      if (this.configManager && typeof this.configManager.getSettings === 'function') {
        const settings = this.configManager.getSettings();
        return Array.isArray(settings.mainPageSessionKeys)
          ? settings.mainPageSessionKeys.filter((key: unknown): key is string => typeof key === 'string')
          : [];
      }
      return [];
    })();
    return persistedKeys
      .map((key: string) => canonicalProviderSessionKey(key))
      .filter((key: string) => Boolean(key));
  }

  setMainPageSessionKeys(keys: string[]): string[] {
    if (this.configManager && typeof this.configManager.setMainPageSessionKeys === 'function') {
      return this.configManager.setMainPageSessionKeys(keys);
    }
    if (this.configManager && typeof this.configManager.updateSettings === 'function') {
      this.configManager.updateSettings({ mainPageSessionKeys: keys });
      return keys;
    }
    return [];
  }

  ensurePersistentAgentSession(
    agent: TypedAgentRecord,
    patch: Partial<PersistedAgentPrivateMetadata> = {},
  ): string {
    if (!agent || !this.configManager || typeof this.configManager.ensureAgentSessionRecord !== 'function') {
      return '';
    }
    this.assertPersistentAgentRuntimeOwner(agent);
    const previousAgentRecordId = agent.agentRecordId || agent.persistentSessionId || '';
    const sessionOptions = agent.providerSessionKey
      ? this.acpSessionOptionsByKey.get(agent.providerSessionKey)
      : null;
    const agentRecordId = this.configManager.ensureAgentSessionRecord(agent, {
      ...(sessionOptions ? {
        acpAdditionalDirectories: [...sessionOptions.additionalDirectories],
        acpConfigOverrides: cloneAcpConfigOverrides(sessionOptions.configOverrides),
        acpMcpServers: JSON.parse(JSON.stringify(sessionOptions.mcpServers)),
      } : {}),
      ...patch,
    });
    if (agentRecordId) {
      setAgentRecordId(agent, agentRecordId);
    }
    if (
      agentRecordId
      && previousAgentRecordId
      && agentRecordId !== previousAgentRecordId
      && agent.providerSessionKey
      && typeof this.configManager.getAgentSessionRecordForProviderSessionKey === 'function'
    ) {
      const record = this.configManager.getAgentSessionRecordForProviderSessionKey(agent.providerSessionKey);
      if (record) {
        agent.projectWorkspace = record.projectWorkspace || agent.projectWorkspace || '';
        agent.task = typeof record.task === 'string' ? record.task : (agent.task || '');
        agent.workflowTemplate = typeof record.workflowTemplate === 'string'
          ? record.workflowTemplate
          : (agent.workflowTemplate || '');
        agent.customTitle = typeof record.customTitle === 'string' ? record.customTitle : '';
        agent.adaptiveTitle = typeof record.adaptiveTitle === 'string' ? record.adaptiveTitle : '';
        agent.pinned = record.pinned === true;
        agent.projectOrder = finiteOrder(record.projectOrder);
        agent.pinnedOrder = finiteOrder(record.pinnedOrder);
        agent.attentionSeq = finiteNonNegativeInteger(record.attentionSeq);
        agent.readAttentionSeq = finiteNonNegativeInteger(record.readAttentionSeq);
        agent.attentionUpdatedAt = finiteNumberOrNull(record.attentionUpdatedAt);
        agent.readAttentionAt = finiteNumberOrNull(record.readAttentionAt);
        agent.attentionReason = record.attentionReason || '';
        agent.attentionOutputEpoch = record.attentionOutputEpoch || '';
        agent.attentionOutputSeq = finiteNumberOrNull(record.attentionOutputSeq);
        agent.readOutputEpoch = record.readOutputEpoch || '';
        agent.readOutputSeq = finiteNumberOrNull(record.readOutputSeq);
        agent.unread = agentAttentionUnread(agent);
      }
    }
    const liveAgent = this.agents.get(agent.id);
    if (liveAgent === agent) this.agentOrderAllocator.observe(agent);
    else if (liveAgent) this.agentOrderAllocator.reserve(agent);
    return agentRecordId;
  }

  assertPersistentAgentRuntimeOwner(agent: TypedAgentRecord) {
    if (
      !agent?.providerSessionKey
      || typeof this.configManager?.getAgentSessionRecordForProviderSessionKey !== 'function'
    ) {
      return;
    }
    const canonical = this.configManager.getAgentSessionRecordForProviderSessionKey(
      agent.providerSessionKey,
    );
    const currentOwner = String(canonical?.runtimeAgentId || '').trim();
    const requestedOwner = String(agent.id || '').trim();
    if (!currentOwner || currentOwner === requestedOwner) return;

    const ownerAgent = this.agents.get(currentOwner);
    if (!ownerAgent && !this.recoveryComplete) {
      throw new Error(
        `Agent session ${agent.providerSessionKey} ownership cannot be changed before recovery completes`,
      );
    }
    const ownerIsStopped = !ownerAgent
      || this.verifiedStoppedAgentIds.has(currentOwner)
      || ['dead', 'stopped'].includes(String(ownerAgent.status || ''))
      || ownerAgent.engineStatus === 'exited';
    if (ownerIsStopped) return;

    throw new Error(
      `Agent session ${agent.providerSessionKey} is owned by Runtime ${currentOwner}, not ${requestedOwner}`,
    );
  }

  beginPersistentAgentOperation(
    agent: TypedAgentRecord,
    type: LifecycleOperationType,
    requestKey: string,
    request: LifecycleOperationRequest = {},
  ): PersistentAgentUpdateAdmission {
    const previousJournal = agent.lifecycleJournal
      ? JSON.parse(JSON.stringify(agent.lifecycleJournal))
      : null;
    const result = beginLifecycleOperation(agent, type, requestKey, request);
    if (result.conflict) {
      return {
        error: `Agent operation ${result.conflict.id} (${result.conflict.type}) has not reached a terminal state`,
        conflict: result.conflict,
      };
    }
    if (result.joined && result.operation.state === 'blocked') {
      transitionLifecycleOperation(agent, result.operation.id, 'pending');
    }
    try {
      const persistentSessionId = this.ensurePersistentAgentSession(agent);
      if (
        typeof this.configManager?.ensureAgentSessionRecord === 'function'
        && !persistentSessionId
      ) {
        throw new Error('Agent session store did not return a persistent id');
      }
    } catch (caughtError: unknown) {
      const error = caughtError as ErrorRecord;
      if (previousJournal) agent.lifecycleJournal = previousJournal;
      else delete agent.lifecycleJournal;
      return { error: `Failed to persist Agent ${type} intent: ${error.message || error}` };
    }
    return {
      operation: activeLifecycleOperation(agent) ?? result.operation,
      joined: result.joined,
    };
  }

  transitionPersistentAgentOperation(
    agent: TypedAgentRecord,
    operationId: string,
    state: LifecycleOperationState,
    error = '',
    patch: UnknownRecord = {},
    requestPatch: LifecycleOperationRequest = {},
  ) {
    const previousJournal = agent.lifecycleJournal
      ? JSON.parse(JSON.stringify(agent.lifecycleJournal))
      : null;
    const operation = transitionLifecycleOperation(agent, operationId, state, error);
    if (!operation) throw new Error(`Agent operation ${operationId} was not found`);
    operation.request = { ...(operation.request || {}), ...requestPatch };
    try {
      const persistentSessionId = this.ensurePersistentAgentSession(agent, patch);
      if (
        typeof this.configManager?.ensureAgentSessionRecord === 'function'
        && !persistentSessionId
      ) {
        throw new Error('Agent session store did not return a persistent id');
      }
    } catch (caughtPersistError: unknown) {
      const persistError = caughtPersistError as ErrorRecord;
      if (previousJournal) agent.lifecycleJournal = previousJournal;
      else delete agent.lifecycleJournal;
      throw persistError;
    }
    return operation;
  }

  checkpointPersistentAgentOperationRequest(
    agent: TypedAgentRecord,
    operationId: string,
    requestPatch: LifecycleOperationRequest,
  ) {
    const previousJournal = agent.lifecycleJournal
      ? JSON.parse(JSON.stringify(agent.lifecycleJournal))
      : null;
    const journal = lifecycleJournal(agent);
    const operation = journal.entries.find(candidate => candidate.id === operationId);
    if (!operation) throw new Error(`Agent operation ${operationId} was not found`);
    operation.request = { ...(operation.request || {}), ...requestPatch };
    operation.updatedAt = Date.now();
    agent.lifecycleJournal = journal;
    try {
      const persistentSessionId = this.ensurePersistentAgentSession(agent);
      if (typeof this.configManager?.ensureAgentSessionRecord === 'function' && !persistentSessionId) {
        throw new Error('Agent session store did not return a persistent id');
      }
    } catch (error) {
      if (previousJournal) agent.lifecycleJournal = previousJournal;
      else delete agent.lifecycleJournal;
      throw error;
    }
    return operation;
  }

  completePersistentAgentOperation(
    agent: TypedAgentRecord,
    operationId: string,
    result: LifecycleOperationResult,
    patch: Partial<PersistedAgentPrivateMetadata> = {},
  ) {
    const staged: TypedAgentRecord = {
      ...agent,
      lifecycleJournal: lifecycleJournal(agent) as LifecycleJournal,
    };
    const operation = setLifecycleOperationResult(staged, operationId, result);
    if (!operation) throw new Error(`Agent operation ${operationId} was not found`);
    transitionLifecycleOperation(staged, operationId, 'succeeded');
    const persistentSessionId = this.ensurePersistentAgentSession(staged, patch);
    if (
      typeof this.configManager?.ensureAgentSessionRecord === 'function'
      && !persistentSessionId
    ) {
      throw new Error('Agent session store did not return a persistent id');
    }
    agent.lifecycleJournal = staged.lifecycleJournal;
    setAgentRecordId(agent, staged.agentRecordId || staged.persistentSessionId || '');
    return operation;
  }

  beginPersistentAgentUpdate(
    agent: TypedAgentRecord,
    requestKey: string,
    request: LifecycleOperationRequest,
  ) {
    const latest = latestLifecycleOperation(agent);
    if (
      latest?.type === 'update'
      && latest.state === 'succeeded'
      && latest.requestKey === requestKey
    ) {
      return { operation: latest, deduplicated: true };
    }
    return this.beginPersistentAgentOperation(agent, 'update', requestKey, request);
  }

  reconcilePersistedAgentUpdate(agent: TypedAgentRecord) {
    const operation = activeLifecycleOperation(agent);
    if (operation?.type !== 'update') return null;
    const request = operation.request || {};
    if (Object.prototype.hasOwnProperty.call(request, 'customTitle')) {
      return this.renameAgent(agent.id, String(request.customTitle || ''));
    }
    if (Object.prototype.hasOwnProperty.call(request, 'task')) {
      return this.setAgentTask(agent.id, String(request.task || ''));
    }
    return this.updateAgentFlags(agent.id, request);
  }

  async replayPersistentCreateRequest(
    createRequestId: unknown,
    requestSignature: unknown = '',
  ): Promise<Record<string, unknown> | null> {
    if (!this.configManager || typeof this.configManager.listAgentSessionRecords !== 'function') {
      return null;
    }
    const requestKey = `create-request:${String(createRequestId || '').trim().slice(0, 160)}`;
    if (requestKey === 'create-request:') return null;
    const records: PersistedAgentPrivateMetadata[] = this.configManager.listAgentSessionRecords();
    const matches = records
      .flatMap((record: PersistedAgentPrivateMetadata) => {
        const entries = lifecycleJournal(record).entries as LifecycleOperation[];
        return entries.map((operation, index) => ({ record, entries, operation, index }));
      })
      .filter(item => item.operation.type === 'create' && item.operation.requestKey === requestKey)
      .sort((left, right) => (
        (Number(right.operation.updatedAt) || 0) - (Number(left.operation.updatedAt) || 0)
      ));
    const match = matches[0];
    if (!match) return null;
    if (
      match.operation.request?.signature
      && match.operation.request.signature !== requestSignature
    ) {
      return {
        error: `Create request ${createRequestId} was already used for different Agent parameters`,
      };
    }

    const agentId = String(
      match.operation.request?.agentId
      || match.record.runtimeAgentId
      || '',
    ).trim();
    const inFlight = agentId ? this.agentLifecycleOperations.get(agentId) : null;
    if (inFlight && !TERMINAL_OPERATION_STATES.has(match.operation.state)) {
      await inFlight.promise.catch(() => {});
      return this.replayPersistentCreateRequest(createRequestId, requestSignature);
    }

    const removedLater = match.entries.slice(match.index + 1).some(operation => (
      ['delete', 'archive'].includes(operation.type)
      && operation.state === 'succeeded'
    ));
    if (removedLater) {
      return {
        error: `Create request ${createRequestId} already completed, but its Agent was later removed`,
      };
    }
    if (match.operation.state === 'succeeded') {
      if (agentId && this.agents.has(agentId)) {
        return {
          agentId,
          deduplicated: true,
          createResult: match.operation.result,
        };
      }
      return {
        error: `Create request ${createRequestId} already succeeded, but its Runtime is not available`,
      };
    }
    if (TERMINAL_OPERATION_STATES.has(match.operation.state)) {
      return {
        error: match.operation.error
          || `Create request ${createRequestId} already finished with state ${match.operation.state}`,
      };
    }
    return {
      agentId,
      error: match.operation.error
        || `Create request ${createRequestId} is awaiting lifecycle recovery`,
    };
  }

  recordCreateRequestResult(agentId: AgentId, createRequestId: unknown, result: LifecycleOperationResult) {
    const agent = this.agents.get(agentId);
    if (!agent) return { error: 'Agent not found' };
    const requestKey = `create-request:${String(createRequestId || '').trim().slice(0, 160)}`;
    const entries = lifecycleJournal(agent).entries as LifecycleOperation[];
    const operation = entries.find(candidate => (
      candidate.type === 'create'
      && candidate.requestKey === requestKey
      && candidate.state === 'succeeded'
    ));
    if (!operation) return { error: 'Create operation was not found' };
    const staged: TypedAgentRecord = {
      ...agent,
      lifecycleJournal: lifecycleJournal(agent),
    };
    setLifecycleOperationResult(staged, operation.id, result);
    try {
      this.ensurePersistentAgentSession(staged);
    } catch (caughtError: unknown) {
      const error = caughtError as ErrorRecord;
      return { error: `Failed to persist Create result: ${error.message || error}` };
    }
    agent.lifecycleJournal = staged.lifecycleJournal;
    setAgentRecordId(agent, staged.agentRecordId || staged.persistentSessionId || '');
    return { agentId, operationId: operation.id, result };
  }

  rememberMainPageProviderSession(agent: TypedAgentRecord) {
    if (!agent || agent.wantsMain) return;
    if (!agent.providerSessionProvider || !agent.providerSessionId || agent.providerSessionTemporary === true) return;
    if (!this.configManager) {
      return;
    }
    this.assertPersistentAgentRuntimeOwner(agent);

    const sessionKey = mainPageAgentSessionKey(agent.providerSessionProvider, agent.providerSessionId, agent.providerHomeId || '');
    if (!sessionKey) return;
    const currentKeys = this.getMainPageSessionKeys();
    if (currentKeys[0] === sessionKey) {
      this.ensurePersistentAgentSession(agent, { visibleOnMainPage: true, archived: false });
      return;
    }
    if (typeof this.configManager.rememberAgentSessionRecord === 'function') {
      const persistentSessionId = this.configManager.rememberAgentSessionRecord(agent);
      setAgentRecordId(agent, persistentSessionId);
      return;
    }
    this.setMainPageSessionKeys([
      sessionKey,
      ...currentKeys.filter((key: string) => key !== sessionKey),
    ]);
  }

  updateEngineProviderSessionMetadata(agent: TypedAgentRecord) {
    if (!agent || !agent.engineName || agent.engineStarted !== true) return;
    const engine = this.engineBridge.getEngine(agent.engineName);
    if (!engine || typeof engine.updateSessionMetadata !== 'function') return;
    Promise.resolve(engine.updateSessionMetadata(agent.id, {
      providerSessionProvider: agent.providerSessionProvider || '',
      providerHomeId: agent.providerHomeId || '',
      providerHomePath: agent.providerHomePath || '',
      providerSessionId: agent.providerSessionId || '',
      providerSessionKey: agent.providerSessionKey || '',
      providerSessionTemporary: agent.providerSessionTemporary === true,
      providerSessionSource: agent.providerSessionSource || '',
      providerSessionResolvedAt: agent.providerSessionResolvedAt || null,
      providerSessionTitle: agent.providerSessionTitle || '',
      terminalInputReceived: agent.terminalInputReceived === true,
      ...legacyRuntimeMetadata(agent),
      forkedFromProviderSessionId: agent.forkedFromProviderSessionId || '',
      forkRequestId: agent.forkRequestId || '',
      forkRequestSignature: agent.forkRequestSignature || '',
      launchPermissionMode: agent.launchPermissionMode || '',
      attentionSeq: finiteNonNegativeInteger(agent.attentionSeq),
      readAttentionSeq: finiteNonNegativeInteger(agent.readAttentionSeq),
      attentionUpdatedAt: finiteNumberOrNull(agent.attentionUpdatedAt),
      readAttentionAt: finiteNumberOrNull(agent.readAttentionAt),
      attentionReason: agent.attentionReason || '',
      attentionOutputEpoch: agent.attentionOutputEpoch || '',
      attentionOutputSeq: finiteNumberOrNull(agent.attentionOutputSeq),
      readOutputEpoch: agent.readOutputEpoch || '',
      readOutputSeq: finiteNumberOrNull(agent.readOutputSeq),
      projectOrder: finiteOrder(agent.projectOrder),
      pinnedOrder: finiteOrder(agent.pinnedOrder),
      customTitle: agent.customTitle || '',
      adaptiveTitle: agent.adaptiveTitle || '',
    })).catch((caught: unknown) => {
      const error = caught as ErrorRecord;
      console.warn('Failed to update provider session metadata:', error && (error.message || error));
    });
  }

  isAgentAttentionTurnActive(agent: TypedAgentRecord) {
    if (!agent) return false;
    if (agent.status === 'pending') return true;
    if (agent.status !== 'running') return false;
    const terminalStatus = deriveAgentTerminalStatus(agent);
    return terminalStatus.activity === 'busy';
  }

  agentAttentionProvider(agent: TypedAgentRecord) {
    return agent.providerSessionProvider
      || agentHomeProviderForProgram(agent.forkCommand || agent.command || '');
  }

  cancelQwenTerminalIdleCandidate(agentId: AgentId) {
    return this.attentionTracker.cancelQwenTerminalIdleCandidate(agentId);
  }

  scheduleQwenTerminalIdleCandidate(agent: TypedAgentRecord) {
    this.attentionTracker.scheduleQwenTerminalIdleCandidate(agent);
  }

  completeAgentAttentionTransition(agent: TypedAgentRecord) {
    return this.attentionTracker.completeAgentAttentionTransition(agent);
  }

  observeAgentAttentionState(agentId: AgentId) {
    return this.attentionTracker.observeAgentAttentionState(agentId);
  }

  recordAgentAttentionEvent(
    agent: TypedAgentRecord,
    reason: string = 'turn-complete',
    options: { persist?: boolean; publish?: boolean } = {},
  ) {
    return this.attentionTracker.recordAgentAttentionEvent(agent, reason, options);
  }

  markAgentReadCursor(agentId: AgentId, readAttentionSeq?: number, options: UnknownRecord = {}) {
    return this.attentionTracker.markAgentReadCursor(agentId, readAttentionSeq, options);
  }

  markAgentReadOutputCut(agentId: AgentId, runtimeEpoch: string, outputSeq: number) {
    const agent = this.agents.get(agentId);
    if (!agent) {
      return { error: 'Agent not found' };
    }

    const currentRuntimeEpoch = typeof agent.runtimeEpoch === 'string' ? agent.runtimeEpoch : '';
    const requestedRuntimeEpoch = typeof runtimeEpoch === 'string' ? runtimeEpoch : '';
    const currentOutputSeq = finiteNumberOrNull(agent.lastOutputSeq);
    if (
      !currentRuntimeEpoch
      || requestedRuntimeEpoch !== currentRuntimeEpoch
      || currentOutputSeq === null
      || !Number.isFinite(outputSeq)
    ) {
      return {
        agentId,
        readOutputEpoch: typeof agent.readOutputEpoch === 'string' ? agent.readOutputEpoch : '',
        readOutputSeq: finiteNumberOrNull(agent.readOutputSeq),
        changed: false,
      };
    }

    const requestedOutputSeq = Math.max(0, Math.floor(outputSeq));
    const nextOutputSeq = Math.min(currentOutputSeq, requestedOutputSeq);
    const previousOutputSeq = agent.readOutputEpoch === currentRuntimeEpoch
      ? finiteNumberOrNull(agent.readOutputSeq)
      : null;
    const readOutputSeq = previousOutputSeq === null
      ? nextOutputSeq
      : Math.max(previousOutputSeq, nextOutputSeq);
    const changed = agent.readOutputEpoch !== currentRuntimeEpoch || previousOutputSeq !== readOutputSeq;
    agent.readOutputEpoch = currentRuntimeEpoch;
    agent.readOutputSeq = readOutputSeq;
    return {
      agentId,
      readOutputEpoch: agent.readOutputEpoch,
      readOutputSeq: agent.readOutputSeq,
      changed,
    };
  }

  markAgentUnreadCursor(agentId: AgentId) {
    return this.attentionTracker.markAgentUnreadCursor(agentId);
  }

  emitAgentReadState(agent: TypedAgentRecord) {
    this.attentionTracker.emitAgentReadState(agent);
  }

  async refreshAgentWorktree(agentId: AgentId, workspaceCandidate: unknown = ''): Promise<boolean> {
    const agent = this.agents.get(agentId);
    if (!agent || agent.isMain || agent.wantsMain) return false;
    const candidate = normalizePathValue(
      workspaceCandidate
      || agent.providerSessionWorkspace
      || agent.shellCwd
      || agent.projectWorkspace
      || agent.cwd
    );
    if (!candidate) return false;

    const generation = (this.agentWorktreeResolveGeneration.get(agentId) || 0) + 1;
    this.agentWorktreeResolveGeneration.set(agentId, generation);
    const baseWorkspace = normalizePathValue(agent.projectWorkspace || agent.cwd);
    return this.agentWorktreeRefreshQueue.enqueue(agentId, async () => {
      if (this.disposing || this.disposed) return false;
      const [info, baseInfo] = await Promise.all([
        inspectGitWorktree(candidate),
        inspectGitWorktree(baseWorkspace),
      ]);
      if (
        this.disposing
        || this.disposed
        || this.agentWorktreeResolveGeneration.get(agentId) !== generation
      ) return false;

      const current = this.agents.get(agentId);
      if (!current || current !== agent) return false;
      const nextWorktree = info
        && baseInfo
        && info.commonDir === baseInfo.commonDir
        ? info
        : null;
      const previousProjection = JSON.stringify(publicAgentGitWorktree(current));
      current.gitWorktree = nextWorktree;
      const nextProjection = JSON.stringify(publicAgentGitWorktree(current));
      if (previousProjection === nextProjection) return false;
      this.emitStateChange({ agentIds: [agentId] });
      return true;
    });
  }

  getAgentActivityPayload(sessionId: string, now = Date.now()) {
    const agent = this.agents.get(sessionId);
    if (!agent) return null;
    const isMain = this.isMainAgentRecord(sessionId, agent);
    const lastActivity = this.lastActivity.get(sessionId) || now;
    return {
      agentId: sessionId,
      lastActivity,
      activityLevel: isMain ? 'warm' : this.calculateActivityLevel(lastActivity, now),
      attentionScore: isMain ? 0 : this.calculateAttentionScore(sessionId, now),
      isZombie: isMain ? false : this.isZombie(sessionId, now),
      usageRate: this.getAgentUsageRate(sessionId, { now }),
    };
  }

  getAgentActivityPayloads(now = Date.now()) {
    return Array.from(this.agents.keys())
      .map(agentId => this.getAgentActivityPayload(agentId, now))
      .filter(activity => activity !== null);
  }

  emitActivityUpdate(sessionId: string, activityAt: number) {
    const now = Number.isFinite(activityAt) ? activityAt : Date.now();
    const lastEmittedAt = this.lastActivityUpdate.get(sessionId) || 0;
    if (now - lastEmittedAt < ACTIVITY_UPDATE_INTERVAL_MS) {
      return;
    }

    this.lastActivityUpdate.set(sessionId, now);
    const activity = this.getAgentActivityPayload(sessionId, now);
    if (activity) this.emit('agent-activity', activity);
  }

  updateAgentSessionTitle(agent: TypedAgentRecord, title: string) {
    const sessionTitle = String(title || '').trim().slice(0, 160);
    if (isFarmingAgentSessionContext(sessionTitle)) {
      if (isFarmingAgentSessionContext(agent.sessionTitle || '')) {
        agent.sessionTitle = '';
        return true;
      }
      return false;
    }
    if ((agent.task || resumedSessionFromSource(agent.source || '')) && isGenericSessionTitle(agent, sessionTitle)) {
      if (agent.sessionTitle && isGenericSessionTitle(agent, agent.sessionTitle)) {
        agent.sessionTitle = '';
        return true;
      }
      return false;
    }
    if (agent.sessionTitle === sessionTitle) {
      return false;
    }

    agent.sessionTitle = sessionTitle;
    return true;
  }

  getEngineSessionSource(engineName: unknown) {
    const engine = this.engineBridge.getEngine(engineName);
    if (engine && typeof engine.getSessionSource === 'function') {
      return engine.getSessionSource();
    }
    return 'buffer';
  }

  resolveAgentShellEnv(shell: string = '', options: AgentShellEnvOptions = {}) {
    const now = Date.now();
    const cacheKey = String(shell || '').trim() || '__default__';
    const cached = this.agentShellEnvCache.get(cacheKey);
    const hasMaxAgeOverride = typeof options.maxAgeMs === 'number' && Number.isFinite(options.maxAgeMs);
    const maxAgeMs = hasMaxAgeOverride
      ? Math.max(0, options.maxAgeMs!)
      : this.agentShellEnvCacheMs;
    if (
      options.force !== true &&
      cached &&
      ((!hasMaxAgeOverride && maxAgeMs === 0) || now - cached.resolvedAt < maxAgeMs)
    ) {
      return cached.env;
    }

    let shellEnv = null;
    try {
      shellEnv = this.agentShellEnvProvider(shell) || null;
    } catch (caughtError: unknown) {
      const error = caughtError as ErrorRecord;
      console.warn('Failed to resolve user shell environment for agent:', error && (error.message || error));
    }

    this.agentShellEnvCache.set(cacheKey, {
      initialized: true,
      resolvedAt: now,
      env: shellEnv,
    });
    return shellEnv;
  }

  buildAgentBaseEnv(agent: TypedAgentRecord) {
    const command = agent?.forkCommand || agent?.command || '';
    const shell = agent?.category === 'other' && isShellProgram(command)
      ? (resolveAgentExecutable(command) || command)
      : '';
    return buildInteractiveAgentBaseEnv({
      processEnv: process.env,
      shellEnv: this.resolveAgentShellEnv(shell),
    });
  }

  resolveAgentResourceBinding(agentId: AgentId): AgentResourceBinding | null {
    const agent = this.agents.get(String(agentId || '').trim());
    if (!agent || agent.archived === true || agent.status !== 'running') return null;
    if (runtimeKind(agent) === 'acp') {
      const state = String(runtimeBindingOf(agent, 'acp')?.state || '');
      if (
        !this.acpRuntime.hasBinding(agent.id)
        || ['closed', 'error', 'stopped'].includes(state)
      ) return null;
    }
    const workspace = canonicalWorkspacePath(effectiveAgentWorkspaceRoot(agent));
    if (!workspace) return null;
    return {
      agentId: agent.id,
      workspace,
    };
  }

  buildAgentEnv(
    agentId: AgentId,
    agent: TypedAgentRecord,
  ) {
    const env = this.buildAgentBaseEnv(agent);
    for (const key of FARMING_LAUNCH_OWNED_ENV_KEYS) delete env[key];
    clearProviderHomeEnvironment(env);
    if (agent.category === 'coding') {
      // Prompt policy is meaningful only for shell sessions. Never pass a
      // shell presentation toggle into a directly launched coding CLI.
      delete env.FARMING_ANONYMIZE_SHELL_PROMPT;
      delete env.FARMING_SHELL_CONTROLLED_PROMPT;
      delete env.FARMING_PRESERVE_SHELL_PROMPT;
    }
    if (agent.category === 'other' && isShellProgram(agent.forkCommand || agent.command || '')) {
      // Like VS Code, the launched shell's own startup files own its prompt.
      // Never let a different shell's captured prompt leak into this process.
      for (const key of SHELL_PROMPT_ENV_KEYS) delete env[key];
    }
    const pathEntries = [this.cliBinDir, env.PATH || ''].filter(Boolean);

    env.PATH = pathEntries.join(path.delimiter);
    normalizeInteractiveTerminalEnv(env, {
      stripRuntimeShims: process.env.FARMING_STRIP_AGENT_LD_LIBRARY_PATH !== '0',
      stripNodeOptions: process.env.FARMING_STRIP_AGENT_NODE_OPTIONS !== '0',
    });
    env.FARMING_CLI_BIN_DIR = this.cliBinDir;
    env.FARMING_AGENT_ID = agentId;
    env.FARMING_IS_MAIN_AGENT = agent.wantsMain ? '1' : '0';
    env.FARMING_SKILLS_COMMAND = 'farming skills';
    env.FARMING_CAPABILITIES_COMMAND = 'farming capabilities';
    env.FARMING_MAIN_WORKSPACE = agent.mainWorkspace || '';
    env.FARMING_PROJECT_WORKSPACE = canonicalWorkspacePath(effectiveAgentWorkspaceRoot(agent));

    if (agent.parentAgentId) {
      env.FARMING_PARENT_AGENT_ID = agent.parentAgentId;
    }
    if (this.controlUrl) {
      env.FARMING_CONTROL_URL = this.controlUrl;
    }
    if (this.tokenFile) {
      env.FARMING_TOKEN_FILE = this.tokenFile;
    }
    if (this.authDisabled) {
      env.FARMING_DISABLE_AUTH = '1';
    }
    if (this.configManager && this.configManager.farmingDir) {
      env.FARMING_CONFIG_DIR = this.configManager.farmingDir;
      env.FARMING_STARTUP_PROMPT_FILE = storageLayout.farmingAgentBootstrapFile(this.configManager.farmingDir);
    }
    if (agent.mainWorkspace) {
      env.FARMING_SKILLS_FILE = path.join(agent.mainWorkspace, 'FARMING_MAIN_AGENT_SKILLS.md');
    }
    const provider = agent.providerSessionProvider || agentHomeProviderForProgram(agent.forkCommand || agent.command || '');
    applyProviderLaunchEnvironment(env, provider, {
      homePath: agent.providerHomePath || '',
      runtime: runtimeKind(agent) === 'acp' ? 'acp' : 'terminal',
      startupPromptFile: env.FARMING_STARTUP_PROMPT_FILE || '',
    });

    return env;
  }

  projectAcpMcpServers(
    mcpServers: Record<string, unknown>[],
    _agentEnv: NodeJS.ProcessEnv,
    _runtimeEpoch = '',
  ): Record<string, unknown>[] {
    // Browser and Computer are exposed only through the instance-exact Farming
    // CLI. Preserve provider/user MCP configuration, while removing Farming
    // capability entries persisted by older releases.
    return stripLegacyFarmingCapabilityMcpServers(mcpServers);
  }

  projectAcpMcpServersForRuntime(
    mcpServers: Record<string, unknown>[],
    agentEnv: NodeJS.ProcessEnv,
  ): { capabilityRuntimeEpoch: string; mcpServers: Record<string, unknown>[] } {
    const capabilityRuntimeEpoch = crypto.randomUUID();
    return {
      capabilityRuntimeEpoch,
      mcpServers: this.projectAcpMcpServers(mcpServers, agentEnv, capabilityRuntimeEpoch),
    };
  }

  expandWorkspacePath(workspace: string) {
    if (typeof workspace !== 'string') return '';
    const value = workspace.trim();
    if (!value) return '';
    if (value === '~') return process.env.HOME || os.homedir();
    if (value.startsWith('~/')) return path.join(process.env.HOME || os.homedir(), value.slice(2));
    return value;
  }

  expandExecutablePath(executable: string) {
    if (typeof executable !== 'string' || executable.trim() === '') return '';
    if (executable === '~') return process.env.HOME || os.homedir();
    if (executable.startsWith('~/')) {
      return path.join(process.env.HOME || os.homedir(), executable.slice(2));
    }
    return executable;
  }

  canCreateForkWorktree(workspace: string) {
    const sourceWorkspace = this.expandWorkspacePath(workspace);
    if (!sourceWorkspace) return false;
    let current = path.resolve(sourceWorkspace);
    while (true) {
      if (fs.existsSync(path.join(current, '.git'))) return true;
      const parent = path.dirname(current);
      if (parent === current) return false;
      current = parent;
    }
  }

  resolveMainAgentWorkspace(requestedWorkspace: string) {
    const expanded = this.expandWorkspacePath(requestedWorkspace);
    const baseWorkspace = expanded || (this.configManager ? this.configManager.getWorkspace() : process.env.HOME);
    const resolvedBase = path.resolve(baseWorkspace);
    const mainWorkspace = path.basename(resolvedBase) === '.farming'
      ? resolvedBase
      : path.join(resolvedBase, '.farming');
    const projectWorkspace = path.basename(resolvedBase) === '.farming'
      ? (expanded ? path.dirname(resolvedBase) : resolvedBase)
      : resolvedBase;

    return {
      workspace: mainWorkspace,
      projectWorkspace,
      selectedWorkspace: resolvedBase,
    };
  }

  findActiveMainAgentStart() {
    const isActive = (agent: TypedAgentRecord | null | undefined): agent is TypedAgentRecord => (
      Boolean(agent) && !['dead', 'stopped'].includes(agent?.status || '')
    );
    const currentMain = this.mainAgentId ? this.agents.get(this.mainAgentId) : null;
    if (isActive(currentMain)) {
      return currentMain;
    }

    for (const agent of this.agents.values()) {
      if (agent.wantsMain && isActive(agent)) {
        return agent;
      }
    }

    return null;
  }

  isMainAgentRecord(agentId: AgentId, agent: TypedAgentRecord) {
    if (agentId === this.mainAgentId) {
      return true;
    }

    if (agent.wantsMain !== true || ['dead', 'stopped'].includes(agent.status || '')) {
      return false;
    }

    const currentMain = this.mainAgentId ? this.agents.get(this.mainAgentId) : null;
    const hasDifferentActiveMain = currentMain
      && currentMain.id !== agentId
      && !['dead', 'stopped'].includes(currentMain.status || '');
    return !hasDifferentActiveMain;
  }
  
  startHeartbeat() {
    const interval = this.configManager ? this.configManager.getHeartbeatInterval() : 1000;
    console.log('Starting heartbeat with interval:', interval, 'ms');
    
    this.heartbeatInterval = setInterval(async () => {
      if (this.disposed) return;
      const now = Date.now();
      if (now - this.lastZombieSweepAt >= ZOMBIE_SWEEP_INTERVAL_MS) {
        this.lastZombieSweepAt = now;
        await this.cleanupZombieAgents();
      }

      if (this.mainAgentId) {
        const mainAgent = this.agents.get(this.mainAgentId);
        if (mainAgent && mainAgent.status === 'dead') {
          this.emitStateChange({ agentIds: [mainAgent.id] });
        }
      }
      
      try {
        const systemStats = await this.systemMonitor.getSystemStats();
        this.emit('system-stats', systemStats);
      } catch (caughtError: unknown) {
      const error = caughtError as ErrorRecord;
        console.error('Failed to get system stats:', error);
      }
    }, interval);
  }

  dispose(options: AgentDisposeOptions = {}) {
    if (this.disposed) return Promise.resolve();
    if (this.disposePromise) return this.disposePromise;

    this.disposing = true;
    this.agentWorktreeRefreshQueue.cancelAllPending();
    const disposePromise = this.performDispose(options);
    this.disposePromise = disposePromise;
    void disposePromise.finally(() => {
      if (this.disposePromise === disposePromise) this.disposePromise = null;
      if (!this.disposed && !this.disposeFrozen) this.disposing = false;
    }).catch(() => {});
    return disposePromise;
  }

  async performDispose(options: AgentDisposeOptions = {}) {
    await this.recoveryPromise;
    await this.drainAcceptedAgentOperations();

    const acpBindingIds = new Set<string>(
      [...(this.acpRuntime?.bindings?.keys?.() || [])]
        .filter((id: unknown): id is string => typeof id === 'string'),
    );
    const runtimeCleanupFailures: unknown[] = [];
    let acpCleanupFailed = false;
    if (this.acpRuntime && typeof this.acpRuntime.dispose === 'function') {
      try {
        await this.acpRuntime.dispose();
      } catch (caughtError: unknown) {
      const error = caughtError as ErrorRecord;
        acpCleanupFailed = true;
        runtimeCleanupFailures.push(error);
      }
    }
    // Runtime shutdown can surface a final settled Turn after the initial
    // operation drain. Keep the Agent owner alive until that accepted durable
    // state commit has finished or failed explicitly.
    await this.drainAcceptedAgentOperations();

    let agentStateChanged = false;
    const forgetStoppedStructuredAgents = (
      agentIds: Set<string>,
      runtime: RuntimeBindingRegistry,
      kind: RuntimeKind,
    ) => {
      for (const agentId of agentIds) {
        if (runtime?.bindings?.has?.(agentId)) continue;
        const agent = this.agents.get(agentId);
        if (!agent || runtimeKind(agent) !== kind) continue;
        this.forgetStoppedAgentRecord(agentId, { emitUpdate: false });
        agentStateChanged = true;
      }
    };
    forgetStoppedStructuredAgents(acpBindingIds, this.acpRuntime, 'acp');
    const markUncertainStructuredAgents = (
      agentIds: Set<string>,
      runtime: RuntimeBindingRegistry,
      kind: RuntimeKind,
      failed: boolean,
    ) => {
      if (!failed) return;
      for (const agentId of agentIds) {
        if (!runtime?.bindings?.has?.(agentId)) continue;
        if (runtimeKind(this.agents.get(agentId)) !== kind) continue;
        this.markStructuredAgentCleanupUncertain(
          agentId,
          kind,
          `${kind.toUpperCase()} runtime cleanup could not prove process exit`,
          { emitUpdate: false },
        );
        agentStateChanged = true;
      }
    };
    markUncertainStructuredAgents(acpBindingIds, this.acpRuntime, 'acp', acpCleanupFailed);
    if (agentStateChanged) this.emitStateChange({ agentIds: [...this.agents.keys()] });

    if (runtimeCleanupFailures.length > 0) {
      this.acpRuntime?.resumeAfterDisposeAbort?.();
      throw new AggregateError(runtimeCleanupFailures, 'Agent runtime cleanup could not be verified');
    }

    this.disposeFrozen = true;
    if (this.engineBridge && typeof this.engineBridge.dispose === 'function') {
      await this.engineBridge.dispose({
        preserveHost: options.preserveTerminalHost === true,
      });
    }

    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    this.providerSessionService.dispose();
    this.acpPreparedTranscriptCache.dispose();
    this.acpTranscriptReads.clear();
    this.agentWorktreeResolveGeneration.clear();
    this.agentLifecycleOperations.clear();
    this.agentStartAdmissions.clear();
    this.inputCoordinator.dispose();
    this.verifiedStoppedAgentIds.clear();
    this.permissionRestartSuppressedAgentIds.clear();
    this.terminalResizeCoordinator.dispose();
    this.codexTerminalProfileQueues.clear();
    this.codexTerminalIdentityAttempts.clear();
    this.codexTerminalIdentityPromises.clear();
    this.terminalStartupCoordinator.dispose();
    this.adaptiveTitlePersistence.clearPending();
    this.activeAcpTurnFinalizations.clear();
    this.acpSessionOptionsByKey.clear();
    this.attentionTracker.cancelAllQwenTerminalIdleCandidates();
    this.disposed = true;
  }

  async drainAcceptedAgentOperations() {
    while (true) {
      const pending = new Set();
      for (const entry of new Set<RuntimeLifecycleEntry>(
        this.agentLifecycleOperations.values() as Iterable<RuntimeLifecycleEntry>,
      )) {
        if (entry?.promise) pending.add(entry.promise);
      }
      for (const entry of this.agentStartAdmissions.values()) {
        if (entry?.promise) pending.add(entry.promise);
      }
      for (const operation of this.inputCoordinator.pendingOperations()) pending.add(operation);
      for (const operation of this.terminalResizeCoordinator.pendingOperations()) pending.add(operation);
      const adaptiveTitleDrain = this.adaptiveTitlePersistence.activeDrain();
      if (adaptiveTitleDrain) pending.add(adaptiveTitleDrain);
      for (const finalization of this.activeAcpTurnFinalizations) pending.add(finalization);
      if (pending.size === 0) return;
      await Promise.allSettled([...pending]);
    }
  }

  async cleanupZombieAgents() {
    const now = Date.now();
    const zombieIds: AgentId[] = [];
    for (const [agentId] of this.agents) {
      if (this.isZombie(agentId, now)) {
        zombieIds.push(agentId);
      }
    }
    for (const zombieId of zombieIds) {
      await this.killAgent(zombieId, { reason: 'zombie-cleanup' });
    }
  }

  engineSessionMetadata(agent: TypedAgentRecord) {
    return {
      agentId: agent.id,
      command: agent.command,
      forkCommand: agent.forkCommand,
      cwd: agent.cwd,
      projectWorkspace: agent.projectWorkspace || '',
      gitWorktree: publicAgentGitWorktree(agent),
      mainWorkspace: agent.mainWorkspace || '',
      wantsMain: agent.wantsMain === true,
      category: agent.category,
      launchPermissionMode: agent.launchPermissionMode,
      parentAgentId: agent.parentAgentId || '',
      forkRequestId: agent.forkRequestId || '',
      forkRequestSignature: agent.forkRequestSignature || '',
      task: agent.task,
      workflowTemplate: agent.workflowTemplate,
      source: agent.source,
      providerSessionProvider: agent.providerSessionProvider,
      providerHomeId: agent.providerHomeId || '',
      providerHomePath: agent.providerHomePath || '',
      acpRuntimeMode: agent.acpRuntimeMode === 'custom' ? 'custom' : 'managed',
      acpRuntimeExecutable: agent.acpRuntimeExecutable || '',
      providerSessionId: agent.providerSessionId,
      providerSessionKey: agent.providerSessionKey,
      providerSessionTemporary: agent.providerSessionTemporary,
      providerSessionSource: agent.providerSessionSource,
      providerSessionResolvedAt: agent.providerSessionResolvedAt,
      providerSessionTitle: agent.providerSessionTitle,
      providerSessionWorkspace: agent.providerSessionWorkspace || '',
      terminalInputReceived: agent.terminalInputReceived === true,
      ...legacyRuntimeMetadata(agent),
      forkedFromProviderSessionId: agent.forkedFromProviderSessionId,
      restartedFromAgentId: agent.restartedFromAgentId,
      restartedFromAgentIds: agent.restartedFromAgentIds,
      persistentSessionId: agent.persistentSessionId,
      customTitle: agent.customTitle,
      adaptiveTitle: agent.adaptiveTitle,
      capabilityRuntimeEpoch: agent.capabilityRuntimeEpoch || '',
      pinned: agent.pinned,
      projectOrder: finiteOrder(agent.projectOrder),
      pinnedOrder: finiteOrder(agent.pinnedOrder),
      startedAt: agent.startedAt,
      attentionSeq: agent.attentionSeq,
      readAttentionSeq: agent.readAttentionSeq,
      attentionUpdatedAt: agent.attentionUpdatedAt,
      readAttentionAt: agent.readAttentionAt,
      attentionReason: agent.attentionReason,
      attentionOutputEpoch: agent.attentionOutputEpoch,
      attentionOutputSeq: agent.attentionOutputSeq,
      readOutputEpoch: agent.readOutputEpoch,
      readOutputSeq: agent.readOutputSeq,
    };
  }

  async createAgentEngineSession(
    agent: TypedAgentRecord,
    engine: SessionEngineContract,
    launch: Omit<TerminalEngineLaunch, 'reviveState'> & { reviveState?: unknown },
  ) {
    await engine.createSession({
      agentId: agent.id,
      command: launch.command,
      args: launch.args,
      cwd: launch.cwd,
      env: this.buildAgentEnv(agent.id, agent),
      category: launch.category,
      metadata: this.engineSessionMetadata(agent),
      reviveState: launch.reviveState || null,
    });
  }

  async stopUncertainTerminalSession(engine: SessionEngineContract, agentId: AgentId) {
    if (typeof engine?.killSession !== 'function' || typeof engine?.getSessionState !== 'function') {
      throw new Error('Session engine cannot prove an uncertain Terminal start has stopped');
    }
    await withBoundedWait(
      Promise.resolve(engine.killSession(agentId)),
      UNCERTAIN_TERMINAL_STOP_TIMEOUT_MS,
      'Terminal kill request',
    );
    const deadline = Date.now() + UNCERTAIN_TERMINAL_STOP_TIMEOUT_MS;
    while (Date.now() <= deadline) {
      const state = await withBoundedWait(
        Promise.resolve(engine.getSessionState(agentId)),
        TERMINAL_STOP_STATE_READ_TIMEOUT_MS,
        'Terminal stop-state read',
      );
      if (!state || ['dead', 'exited', 'stopped'].includes(String(state.status || ''))) return;
      await new Promise<void>(resolve => setTimeout(resolve, TERMINAL_STOP_POLL_MS));
    }
    throw new Error(`Terminal ${agentId} did not reach an exited state after kill`);
  }

  startAgent(
    command: string,
    customWorkspace: string | null,
    callback: AgentStartCallback | null,
    options: AgentStartOptions = {},
  ): Promise<AgentId | null> {
    const lifecycleEntries = this.agentLifecycleOperations.values() as Iterable<RuntimeLifecycleEntry>;
    const lifecycleEntry = options.lifecycleToken
      ? [...new Set(lifecycleEntries)]
          .find(entry => entry.token === options.lifecycleToken)
      : null;
    if (this.disposing && !lifecycleEntry) {
      const error = 'Farming is shutting down; new Agents are not accepted';
      if (callback) callback(null, error);
      return Promise.resolve(null);
    }

    const createRequestId = typeof options.createRequestId === 'string'
      ? options.createRequestId.trim().slice(0, 160)
      : '';
    const createRequestSignature = createOperationSignature(command, customWorkspace, options);
    const existingCreateRequest = createRequestId
      ? this.createRequestAdmissions.get(createRequestId)
      : null;
    if (existingCreateRequest) {
      if (existingCreateRequest.signature !== createRequestSignature) {
        const error = `Create request ${createRequestId} is already in progress with different Agent parameters`;
        if (callback) callback(null, error);
        return Promise.resolve(null);
      }
      return (existingCreateRequest as CreateRequestAdmission).promise.then((outcome: AgentStartOutcome) => {
        if (callback) {
          callback(
            outcome.agentId || null,
            outcome.error || null,
            {
              ...(outcome.metadata || {}),
              deduplicated: true,
            },
          );
        }
        return outcome.agentId || null;
      });
    }

    let resolveAdmission!: () => void;
    const token = Symbol('agent-start-admission');
    const promise = new Promise<void>(resolve => {
      resolveAdmission = resolve;
    });
    const requestedProjectWorkspace = options.wantsMain === true
      ? ''
      : (typeof options.projectWorkspace === 'string' && options.projectWorkspace.trim()
        ? options.projectWorkspace
        : customWorkspace);
    const admission: AgentStartAdmission = {
      token,
      promise,
      workspaceKey: requestedProjectWorkspace
        ? canonicalWorkspacePath(this.expandWorkspacePath(requestedProjectWorkspace))
        : '',
    };
    this.agentStartAdmissions.set(token, admission);
    let callbackOutcome: AgentStartOutcome | null = null;
    const reportStart: AgentStartCallback = (agentId, error, metadata = {}) => {
      callbackOutcome = {
        agentId: agentId || null,
        error: error || null,
        metadata,
      };
      if (callback) callback(agentId, error, metadata);
    };
    const startPromise = this.startAgentAdmitted(command, customWorkspace, reportStart, {
      ...options,
      startAdmissionToken: token,
    });
    const admittedPromise = Promise.resolve(startPromise).finally(() => {
      if (this.agentStartAdmissions.get(token) === admission) {
        this.agentStartAdmissions.delete(token);
      }
      resolveAdmission();
    });
    if (!createRequestId) return admittedPromise;

    const outcomePromise = admittedPromise.then((agentId: AgentId | null) => (
      callbackOutcome || {
        agentId: agentId || null,
        error: agentId ? null : 'Failed to start Agent',
      }
    ));
    const requestAdmission: CreateRequestAdmission = {
      signature: createRequestSignature,
      promise: outcomePromise,
    };
    this.createRequestAdmissions.set(createRequestId, requestAdmission);
    void outcomePromise.finally(() => {
      if (this.createRequestAdmissions.get(createRequestId) === requestAdmission) {
        this.createRequestAdmissions.delete(createRequestId);
      }
    }).catch(() => {});
    return outcomePromise.then((outcome: AgentStartOutcome) => outcome.agentId || null);
  }

  async startAgentAdmitted(
    command: string,
    customWorkspace: string | null,
    callback: AgentStartCallback | null,
    options: AgentStartOptions & ProviderStartOptions = {},
  ): Promise<AgentId | null> {
    const createRequestId = typeof options.createRequestId === 'string'
      ? options.createRequestId.trim().slice(0, 160)
      : '';
    if (options.skipRecoveryWait !== true) {
      try {
        await this.whenRecovered();
      } catch (caughtError: unknown) {
      const error = caughtError as ErrorRecord;
        if (callback) callback(null, error.message || String(error));
        return null;
      }
    }
    const createRequestSignature = createOperationSignature(command, customWorkspace, options);
    if (createRequestId) {
      const replay = await this.replayPersistentCreateRequest(
        createRequestId,
        createRequestSignature,
      );
      if (replay) {
        const replayAgentId = typeof replay.agentId === 'string' ? replay.agentId : null;
        const replayError = typeof replay.error === 'string' ? replay.error : null;
        if (callback) {
          callback(
            replayAgentId,
            replayError,
            {
              deduplicated: replay.deduplicated === true,
              createResult: replay.createResult || null,
            },
          );
        }
        return replayAgentId;
      }
    }

    const wantsMain = options.wantsMain === true || (options.wantsMain !== false && !this.mainAgentId);
    if (!wantsMain) {
      return this.startAgentUnreserved(command, customWorkspace, callback, {
        ...options,
        wantsMain: false,
        skipRecoveryWait: true,
      });
    }

    if (this.mainAgentStartReservation) {
      const outcome = await this.mainAgentStartReservation.promise;
      if (callback) callback(outcome.agentId, outcome.error);
      return outcome.agentId;
    }

    const existingMainStart = this.findActiveMainAgentStart();
    if (existingMainStart) {
      if (this.mainAgentId !== existingMainStart.id) {
        const previousMainAgentId = this.mainAgentId;
        this.mainAgentId = existingMainStart.id;
        this.emitStateChange({
          agentIds: [previousMainAgentId, existingMainStart.id].filter(
            (value): value is string => typeof value === 'string' && value.length > 0,
          ),
          mainAgentIdChanged: true,
        });
      }
      console.log('Main Agent already starting or running:', existingMainStart.id);
      if (callback) callback(existingMainStart.id);
      return existingMainStart.id;
    }

    let resolveReservation: (value: AgentStartOutcome) => void = () => {};
    const reservation: AgentStartReservation = {
      promise: new Promise<AgentStartOutcome>(resolve => {
        resolveReservation = resolve;
      }),
    };
    this.mainAgentStartReservation = reservation;
    let outcome = null;
    let callbackCalled = false;
    const reservedCallback: AgentStartCallback = (agentId, error) => {
      callbackCalled = true;
      outcome = { agentId: agentId || null, error: error || null };
      if (callback) callback(agentId, error);
    };
    try {
      const agentId = await this.startAgentUnreserved(command, customWorkspace, reservedCallback, {
        ...options,
        wantsMain: true,
        skipRecoveryWait: true,
      });
      if (!callbackCalled) {
        outcome = { agentId: agentId || null, error: null };
        if (callback) callback(agentId);
      }
      return agentId;
    } catch (caughtError: unknown) {
      const error = caughtError as ErrorRecord;
      if (!callbackCalled) {
        outcome = { agentId: null, error: error && (error.message || String(error)) };
        if (callback) callback(null, outcome.error);
      }
      throw error;
    } finally {
      resolveReservation(outcome || { agentId: null, error: 'Main Agent failed to start' });
      if (this.mainAgentStartReservation === reservation) {
        this.mainAgentStartReservation = null;
      }
    }
  }

  async startAgentUnreserved(
    command: string,
    customWorkspace: string | null,
    callback: AgentStartCallback | null,
    options: AgentStartOptions & ProviderStartOptions = {},
  ): Promise<AgentId | null> {
    if (options.wantsMain !== false && options.skipRecoveryWait !== true) {
      await this.whenRecovered();
    }

    const wantsMain = options.wantsMain === true || (options.wantsMain !== false && !this.mainAgentId);
    if (wantsMain) {
      const existingMainStart = this.findActiveMainAgentStart();
      if (existingMainStart) {
        if (this.mainAgentId !== existingMainStart.id) {
          const previousMainAgentId = this.mainAgentId;
          this.mainAgentId = existingMainStart.id;
          this.emitStateChange({
            agentIds: [previousMainAgentId, existingMainStart.id].filter(
              (value): value is string => typeof value === 'string' && value.length > 0,
            ),
            mainAgentIdChanged: true,
          });
        }
        console.log('Main Agent already starting or running:', existingMainStart.id);
        if (callback) callback(existingMainStart.id);
        return existingMainStart.id;
      }
    }

    const dangerouslySkipPermissions = options.dangerouslySkipPermissions === true
      || (
        options.dangerouslySkipPermissions !== false
        && this.configManager
        && this.configManager.getDangerouslySkipAgentPermissionsByDefault()
      );
    const preserveProviderSessionProfile = options.preserveProviderSessionProfile === true
      || providerCommandContinuesSession(command);
    const launchProvider = agentHomeProviderForProgram(command);
    const requestedLaunchHomeId = typeof options.providerHomeId === 'string' && options.providerHomeId.trim()
      ? options.providerHomeId.trim()
      : 'default';
    const homeLaunchProfile = launchProvider
      && this.configManager
      && typeof this.configManager.getAgentLaunchProfileForHome === 'function'
      ? this.configManager.getAgentLaunchProfileForHome(launchProvider, requestedLaunchHomeId)
      : {};
    const configuredLaunchProfiles = this.configManager && this.configManager.getAgentLaunchProfiles
      ? this.configManager.getAgentLaunchProfiles()
      : {};
    if (launchProvider) {
      configuredLaunchProfiles[launchProvider] = preserveProviderSessionProfile && launchProvider === 'claude'
        ? { ...homeLaunchProfile, model: 'config', effort: 'config' }
        : homeLaunchProfile;
    }
    const codexModel = preserveProviderSessionProfile
      ? 'config'
      : (typeof options.codexModel === 'string'
        ? options.codexModel
        : (typeof homeLaunchProfile.model === 'string' ? homeLaunchProfile.model : 'config'));
    const codexReasoningEffort = preserveProviderSessionProfile
      ? 'config'
      : (typeof options.codexReasoningEffort === 'string'
        ? options.codexReasoningEffort
        : (typeof homeLaunchProfile.reasoningEffort === 'string'
          ? homeLaunchProfile.reasoningEffort
          : 'config'));
    const codexServiceTier = preserveProviderSessionProfile
      ? 'config'
      : (typeof options.codexServiceTier === 'string'
        ? options.codexServiceTier
        : (typeof homeLaunchProfile.serviceTier === 'string'
          ? homeLaunchProfile.serviceTier
          : 'config'));
    const launch = resolveLaunchCommand(command, {
      dangerouslySkipPermissions: dangerouslySkipPermissions === true,
      agentLaunchProfiles: configuredLaunchProfiles,
      codexApprovalMode: options.codexApprovalMode || (
        dangerouslySkipPermissions
          ? undefined
          : (typeof homeLaunchProfile.approvalMode === 'string'
            ? homeLaunchProfile.approvalMode
            : 'approve')
      ),
      claudePermissionMode: typeof options.claudePermissionMode === 'string' ? options.claudePermissionMode : undefined,
      codexModelPreset: typeof homeLaunchProfile.modelPreset === 'string'
        ? homeLaunchProfile.modelPreset
        : 'config',
      codexModel,
      codexReasoningEffort,
      codexServiceTier,
      farmingSystemPrompt: renderFarmingAgentBootstrap(),
      mainAgentSystemPrompt: wantsMain ? renderMainAgentBootstrap() : '',
    });
    const program = launch.program;
    const resolvedSource = typeof options.source === 'string' ? options.source : 'ui';
    let providerSessionPlan = buildAgentProviderSessionPlan({
      command,
      program,
      args: launch.args,
      source: resolvedSource,
    });

    const hasResumeSource = Boolean(resumedSessionFromSource(resolvedSource));
    const commandProviderSessionPlan = hasResumeSource
      ? buildAgentProviderSessionPlan({
          command,
          program,
          args: launch.args,
          source: 'ui',
        })
      : null;
    const commandContinuesProviderSession = commandProviderSessionPlan
      && commandProviderSessionPlan.temporary !== true
      && commandProviderSessionPlan.provider === providerSessionPlan.provider
      && commandProviderSessionPlan.id === providerSessionPlan.id;
    if (
      providerSessionPlan.source === 'resume-source'
      && hasResumeSource
      && !commandContinuesProviderSession
    ) {
      providerSessionPlan = commandProviderSessionPlan as AgentProviderSessionPlan;
    }
    if (providerSessionPlan.error) {
      if (callback) callback(null, providerSessionPlan.error);
      return null;
    }

    let args = providerSessionPlan.args;
    let launchPathEnv = process.env.PATH || '';

    const parentAgentId = typeof options.parentAgentId === 'string' ? options.parentAgentId : '';
    const parentAgent = parentAgentId ? this.agents.get(parentAgentId) : null;
    const defaultWorkspace = wantsMain
      ? (this.configManager ? this.configManager.getWorkspace() : process.env.HOME)
      : ((parentAgent && (parentAgent.projectWorkspace || parentAgent.cwd)) || process.env.PWD || process.cwd() || process.env.HOME);
    let workspace = this.expandWorkspacePath(customWorkspace || defaultWorkspace || process.cwd());
    const explicitProjectWorkspace = !wantsMain && typeof options.projectWorkspace === 'string' && options.projectWorkspace.trim()
      ? this.expandWorkspacePath(options.projectWorkspace)
      : '';
    let projectWorkspace = '';

    if (wantsMain) {
      const resolvedMain = this.resolveMainAgentWorkspace(customWorkspace || '');
      const selectedParent = path.basename(resolvedMain.selectedWorkspace) === '.farming'
        ? path.dirname(resolvedMain.selectedWorkspace)
        : resolvedMain.selectedWorkspace;
      let selectedParentExists = false;
      try {
        selectedParentExists = fs.statSync(selectedParent).isDirectory();
      } catch {
        selectedParentExists = false;
      }
      if (!selectedParentExists) {
        console.log('Workspace does not exist:', selectedParent);
        if (callback) callback(null, `Workspace does not exist: ${selectedParent}`);
        return null;
      }
      workspace = resolvedMain.workspace;
      projectWorkspace = resolvedMain.projectWorkspace;
      fs.mkdirSync(workspace, { recursive: true });
      ensureMainAgentSkillFiles(workspace);
    } else {
      projectWorkspace = workspace;
      if (explicitProjectWorkspace) {
        const resolvedProjectWorkspace = path.resolve(explicitProjectWorkspace);
        const resolvedWorkspace = path.resolve(workspace);
        try {
          if (fs.statSync(resolvedProjectWorkspace).isDirectory() && isSameOrDescendantPath(resolvedProjectWorkspace, resolvedWorkspace)) {
            projectWorkspace = explicitProjectWorkspace;
          }
        } catch {
          projectWorkspace = workspace;
        }
      }
    }

    const projectWorkspaceKey = canonicalWorkspacePath(projectWorkspace);
    const startAdmission = options.startAdmissionToken
      ? this.agentStartAdmissions.get(options.startAdmissionToken)
      : undefined;
    if (startAdmission) startAdmission.workspaceKey = projectWorkspaceKey;
    const deletingProjectWorkspace = projectWorkspaceKey
      ? [...this.projectWorkspaceDeleteAdmissions.keys()]
          .find((candidate: string) => isSameOrDescendantPath(candidate, projectWorkspaceKey))
      : '';
    if (deletingProjectWorkspace) {
      if (callback) callback(null, `Project worktree is being deleted: ${projectWorkspace}`);
      return null;
    }
    
    if (!fs.existsSync(workspace)) {
      console.log('Workspace does not exist:', workspace);
      if (callback) callback(null, `Workspace does not exist: ${workspace}`);
      return null;
    }

    let resolution: SessionEngineResolutionContract;
    try {
      resolution = this.engineBridge.resolve(command);
    } catch (caughtError: unknown) {
      const error = caughtError as ErrorRecord;
      if (callback) callback(null, error.message);
      return null;
    }
    const resolutionSpec = isRecord(resolution.spec) ? resolution.spec : null;
    
    const requestedRuntimeAgentId = typeof options.runtimeAgentId === 'string'
      ? options.runtimeAgentId.trim()
      : '';
    if (requestedRuntimeAgentId && !/^agent-[A-Za-z0-9_-]+$/.test(requestedRuntimeAgentId)) {
      if (callback) callback(null, 'Invalid runtime Agent id');
      return null;
    }
    if (requestedRuntimeAgentId && this.agents.has(requestedRuntimeAgentId)) {
      if (callback) callback(null, `Runtime Agent id is already active: ${requestedRuntimeAgentId}`);
      return null;
    }
    const agentId = requestedRuntimeAgentId ||
      `agent-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const homeProvider = providerSessionPlan.provider || agentHomeProviderForProgram(program);
    const providerHomeId = typeof options.providerHomeId === 'string' && options.providerHomeId.trim()
      ? options.providerHomeId.trim()
      : (providerSessionPlan.providerHomeId || '');
    let providerHome = homeProvider && providerHomeId && this.configManager && this.configManager.getAgentHome
      ? this.configManager.getAgentHome(homeProvider, providerHomeId)
      : null;
    if (
      homeProvider
      && providerHomeId
      && !providerHome
      && !options.providerHomePath
      && this.configManager
      && typeof this.configManager.getAgentHome === 'function'
    ) {
      if (callback) callback(null, `Unknown ${homeProvider} agent home: ${providerHomeId}`);
      return null;
    }
    let providerHomePath = typeof options.providerHomePath === 'string' && options.providerHomePath.trim()
      ? this.expandWorkspacePath(options.providerHomePath)
      : (providerHome ? providerHome.path : '');
    let resolvedProviderHomeId = providerHome ? providerHome.id : (providerHomeId || '');
    if (
      homeProvider === 'codex'
      && !providerHomePath
      && this.configManager
      && typeof this.configManager.getAgentHome === 'function'
    ) {
      const defaultCodexHome = this.configManager.getAgentHome('codex', 'default');
      if (defaultCodexHome) {
        providerHome = defaultCodexHome;
        providerHomePath = defaultCodexHome.path;
        resolvedProviderHomeId = defaultCodexHome.id || 'default';
      }
    }
    const requestedRuntimeModeValue = (options as Record<string, unknown>).agentRuntimeMode;
    const requestedRuntimeMode = typeof requestedRuntimeModeValue === 'string'
      ? requestedRuntimeModeValue
      : '';
    if (requestedRuntimeMode === 'json') {
      if (callback) callback(null, 'JSON CLI runtime is no longer supported. Use Chat (ACP) or Terminal.');
      return null;
    }
    const requestedAgentRuntimeMode = ['acp', 'chat'].includes(requestedRuntimeMode)
      ? requestedRuntimeMode
      : 'terminal';
    // A fresh structured runtime does not need a provider CLI resume id yet:
    // ACP creates the provider session and writes the resulting id back after
    // connecting. Fresh Terminal sessions are handled separately below.
    const structuredRuntimeProvider = ['acp', 'chat'].includes(requestedAgentRuntimeMode)
      ? String(homeProvider || '')
      : providerSessionPlan.provider;
    // `chat` is the only browser-facing structured-runtime request. Treat the
    // retired Codex ACP launch request as that intent too, so an old client
    // cannot create a second Codex Chat implementation.
    const requestedChatRuntime = isChatMode(requestedAgentRuntimeMode)
      || (requestedAgentRuntimeMode === 'acp' && homeProvider === 'codex');
    const resolvedChatRuntime = requestedChatRuntime
      ? chatRuntimeForProvider(homeProvider)
      : (requestedAgentRuntimeMode === 'acp' ? 'acp' : '');
    const useAcp = resolvedChatRuntime === 'acp'
      && providerSupportsRuntime(structuredRuntimeProvider, 'acp')
      && (
        process.env.FARMING_E2E_FAKE_EXECUTABLES !== '1'
        || process.env.FARMING_E2E_FAKE_ACP_AGENT === '1'
      );
    const structuredRuntimeAdapter = getProviderAdapter(structuredRuntimeProvider);
    const existingProviderSessionKey = useAcp
      && providerSessionPlan.id
      && providerSessionPlan.temporary !== true
      ? mainPageAgentSessionKey(
          structuredRuntimeProvider,
          providerSessionPlan.id,
          resolvedProviderHomeId || 'default',
        )
      : '';
    const existingProviderSessionRecord = existingProviderSessionKey
      && typeof this.configManager?.getAgentSessionRecordForProviderSessionKey === 'function'
      ? this.configManager.getAgentSessionRecordForProviderSessionKey(existingProviderSessionKey)
      : null;
    const configuredAcpRuntime = existingProviderSessionRecord
      ? {
          mode: existingProviderSessionRecord.acpRuntimeMode === 'custom' ? 'custom' : 'managed',
          executable: typeof existingProviderSessionRecord.acpRuntimeExecutable === 'string'
            ? existingProviderSessionRecord.acpRuntimeExecutable
            : '',
        }
      : {
          mode: providerHome?.acpRuntime?.mode === 'custom' ? 'custom' : 'managed',
          executable: providerHome?.acpRuntime?.mode === 'custom'
            ? String(providerHome.acpRuntime.executable || '')
            : '',
        };
    const usesManagedAcpExecutable = useAcp
      && configuredAcpRuntime.mode === 'managed'
      && structuredRuntimeAdapter?.acp.executablePolicy === 'managed';
    if (!usesManagedAcpExecutable && configuredAcpRuntime.mode !== 'custom') {
      const userShellEnv = this.resolveAgentShellEnv('', { maxAgeMs: AGENT_DISCOVERY_CACHE_MAX_AGE_MS });
      launchPathEnv = typeof userShellEnv?.PATH === 'string' && userShellEnv.PATH.trim()
        ? userShellEnv.PATH
        : launchPathEnv;
    }
    let resolvedExecutable = '';
    if (useAcp && existingProviderSessionRecord) {
      const executableResolution = validatePersistedAcpExecutable(
        structuredRuntimeProvider,
        existingProviderSessionRecord.acpRuntimeExecutable,
        {
          environment: executableOwnershipEnvironment(this.configManager?.farmingDir || ''),
          requireFarmingOwned: configuredAcpRuntime.mode === 'managed'
            && structuredRuntimeAdapter?.acp.executablePolicy === 'managed',
        },
      );
      if (executableResolution.error) {
        if (callback) callback(null, executableResolution.error);
        return null;
      }
      resolvedExecutable = executableResolution.path;
    } else if (useAcp && configuredAcpRuntime.mode === 'custom') {
      resolvedExecutable = this.expandExecutablePath(configuredAcpRuntime.executable);
      if (!path.isAbsolute(resolvedExecutable)) {
        if (callback) callback(null, `${structuredRuntimeProvider} custom ACP executable must be an absolute path.`);
        return null;
      }
      try {
        fs.accessSync(resolvedExecutable, fs.constants.X_OK);
      } catch {
        if (callback) callback(null, `${structuredRuntimeProvider} custom ACP executable is not executable: ${resolvedExecutable}`);
        return null;
      }
    } else if (usesManagedAcpExecutable) {
      const ownershipEnvironment = executableOwnershipEnvironment(this.configManager?.farmingDir || '');
      resolvedExecutable = resolveFarmingOwnedExecutable(structuredRuntimeProvider, {
        farmingCandidates: getFarmingOwnedExecutableCandidates(
          structuredRuntimeProvider,
          ownershipEnvironment,
        ),
      });
    } else if (!useAcp && path.basename(program) === 'codex') {
      if (
        process.env.FARMING_E2E_FAKE_EXECUTABLES === '1'
        && process.env.FARMING_CODEX_BIN
      ) {
        resolvedExecutable = process.env.FARMING_CODEX_BIN;
      } else {
        const codexResolution = resolveTerminalCodexExecutable(options.requiredCliVersion || '', launchPathEnv);
        if (!codexResolution.compatible) {
          if (callback) callback(null, codexResolution.error || 'Codex CLI is not compatible with this session');
          return null;
        }
        resolvedExecutable = codexResolution.path;
      }
    } else {
      resolvedExecutable = useAcp
        ? resolveAgentExecutable(program, launchPathEnv)
        : resolveTerminalExecutable(program, launchPathEnv).path;
    }
    const spawnProgram = resolvedExecutable || program;
    if (
      useAcp
      && structuredRuntimeAdapter?.acp.executablePolicy === 'managed'
      && configuredAcpRuntime.mode === 'managed'
      && !resolvedExecutable
    ) {
      if (callback) {
        callback(null, `${structuredRuntimeProvider} ACP requires a Farming-owned executable, but none is available.`);
      }
      return null;
    }
    if (
      launch.spec
      && path.basename(program) === program
      && !resolvedExecutable
      && !this.skipExecutablePreflight
      && process.env.FARMING_E2E_FAKE_EXECUTABLES !== '1'
    ) {
      const displayName = launch.spec.name === 'opencode'
        ? 'OpenCode'
        : launch.spec.name.charAt(0).toUpperCase() + launch.spec.name.slice(1);
      if (callback) {
        callback(
          null,
          `${displayName} executable "${program}" was not found in the user shell PATH. Install it or refresh the Agent list, then try again.`
        );
      }
      return null;
    }
    const acpGeneratedFreshSession = useAcp
      && isFreshAcpSessionSource(structuredRuntimeProvider, providerSessionPlan.source);
    const agentRecord = {
      id: agentId,
      command: launch.program,
      forkCommand: String(command || '').trim() || launch.program,
      cwd: workspace,
      output: '',
      previewText: '',
      previewSnapshot: null,
      previewCols: 80,
      previewRows: 30,
      sessionTitle: '',
      status: 'pending',
      engineName: resolution.engineName,
      wantsMain,
      mainWorkspace: wantsMain ? workspace : '',
      projectWorkspace,
      category: typeof resolutionSpec?.category === 'string' ? resolutionSpec.category : 'other',
      launchPermissionMode: launch.permissionMode || '',
      parentAgentId,
      forkRequestId: typeof options.forkRequestId === 'string' ? options.forkRequestId : '',
      forkRequestSignature: typeof options.forkRequestSignature === 'string'
        ? options.forkRequestSignature
        : '',
      task: typeof options.task === 'string' ? options.task : '',
      workflowTemplate: typeof options.workflowTemplate === 'string' ? options.workflowTemplate : '',
      source: typeof options.source === 'string' ? options.source : 'ui',
      providerSessionProvider: useAcp ? structuredRuntimeProvider : (providerSessionPlan.provider || ''),
      providerHomeId: resolvedProviderHomeId,
      providerHomePath,
      acpRuntimeMode: useAcp ? configuredAcpRuntime.mode : 'managed',
      acpRuntimeExecutable: useAcp ? resolvedExecutable : '',
      providerSessionId: acpGeneratedFreshSession ? '' : (providerSessionPlan.id || ''),
      providerSessionKey: acpGeneratedFreshSession
        ? ''
        : mainPageAgentSessionKey(
          providerSessionPlan.provider,
          providerSessionPlan.id,
          providerHome ? providerHome.id : providerHomeId,
        ),
      providerSessionTemporary: acpGeneratedFreshSession || providerSessionPlan.temporary === true,
      providerSessionSource: providerSessionPlan.source || '',
      providerSessionMaterialized: options.providerSessionMaterialized === false
        ? false
        : (!acpGeneratedFreshSession && providerSessionPlan.temporary !== true),
      providerSessionResolvedAt: acpGeneratedFreshSession || providerSessionPlan.temporary === true
        ? null
        : Date.now(),
      providerSessionTitle: typeof options.providerSessionTitle === 'string' ? options.providerSessionTitle.trim().slice(0, 160) : '',
      providerSessionWorkspace: '',
      terminalInputReceived: false,
      structuredRuntimeProcess: null,
      runtimeBinding: useAcp
        ? runtimeBindingFor('acp', { state: 'connecting' })
        : runtimeBindingFor('terminal'),
      forkedFromProviderSessionId: typeof options.forkedFromProviderSessionId === 'string'
        ? options.forkedFromProviderSessionId
        : (providerSessionPlan.forkedFromProviderSessionId || ''),
      restartedFromAgentId: typeof options.restartedFromAgentId === 'string' ? options.restartedFromAgentId : '',
      restartedFromAgentIds: Array.isArray(options.restartedFromAgentIds)
        ? Array.from(new Set(options.restartedFromAgentIds.filter((id: string) => typeof id === 'string' && id)))
        : [],
      runtimeSwitchVerifiedSessionId: typeof options.runtimeSwitchVerifiedSessionId === 'string'
        ? options.runtimeSwitchVerifiedSessionId
        : '',
      agentRecordId: typeof options.agentRecordId === 'string'
        ? options.agentRecordId
        : (typeof options.persistentSessionId === 'string' ? options.persistentSessionId : ''),
      persistentSessionId: typeof options.agentRecordId === 'string'
        ? options.agentRecordId
        : (typeof options.persistentSessionId === 'string' ? options.persistentSessionId : ''),
      composerCommands: normalizedComposerCommands(options.composerCommands),
      customTitle: typeof options.customTitle === 'string' ? options.customTitle.trim().slice(0, 80) : '',
      adaptiveTitle: typeof options.adaptiveTitle === 'string' ? options.adaptiveTitle.trim().slice(0, 80) : '',
      capabilityRuntimeEpoch: '',
      terminalBusy: null,
      shellCwd: '',
      shellLastExitCode: null,
      shellLastEvent: '',
      shellCommand: '',
      shellLastCommand: '',
      shellCommandStartedAt: null,
      shellLastCommandStartedAt: null,
      shellLastCommandFinishedAt: null,
      shellLastCommandDurationMs: null,
      pinned: options.pinned === true,
      projectOrder: finiteOrder(options.projectOrder),
      pinnedOrder: finiteOrder(options.pinnedOrder),
      attentionSeq: finiteNonNegativeInteger(options.attentionSeq),
      readAttentionSeq: finiteNonNegativeInteger(options.readAttentionSeq),
      attentionUpdatedAt: finiteNumberOrNull(options.attentionUpdatedAt),
      readAttentionAt: finiteNumberOrNull(options.readAttentionAt),
      attentionReason: typeof options.attentionReason === 'string' ? options.attentionReason : '',
      attentionOutputEpoch: typeof options.attentionOutputEpoch === 'string' ? options.attentionOutputEpoch : '',
      attentionOutputSeq: finiteNumberOrNull(options.attentionOutputSeq),
      readOutputEpoch: typeof options.readOutputEpoch === 'string' ? options.readOutputEpoch : '',
      readOutputSeq: finiteNumberOrNull(options.readOutputSeq),
      unread: finiteNonNegativeInteger(options.attentionSeq) > finiteNonNegativeInteger(options.readAttentionSeq),
      archived: false,
      archivedAt: null,
      canForkNewWorktree: this.canCreateForkWorktree(projectWorkspace || workspace),
      validated: true,
      engineStarted: false,
      startedAt: Date.now(),
      lastOutputSeq: null,
      attentionAutoReadNext: options.autoReadInitialAttention === true,
      attentionTrackingReady: false,
      lastObservedTurnActive: false,
      attentionSuppressUntil: 0
    } as TypedAgentRecord;

    let previousPersistentRuntimeAgentId = '';
    let previousPersistentRecord = null;
    if (
      agentRecord.providerSessionKey
      && typeof this.configManager?.getAgentSessionRecordForProviderSessionKey === 'function'
    ) {
      const existingRecord = this.configManager.getAgentSessionRecordForProviderSessionKey(
        agentRecord.providerSessionKey,
      );
      if (existingRecord) {
        previousPersistentRecord = existingRecord;
        agentRecord.lifecycleJournal = lifecycleJournal(existingRecord);
        previousPersistentRuntimeAgentId = String(existingRecord.runtimeAgentId || '').trim();
      }
    }

    let finishStartLifecycle: () => void = () => {};
    if (
      options.lifecycleToken
      && !this.adoptAgentLifecycleOperation(agentId, options.lifecycleToken)
    ) {
      if (callback) callback(null, 'Agent lifecycle operation is no longer active');
      return null;
    }
    if (!options.lifecycleToken) {
      if (typeof options.startAdmissionToken !== 'symbol') {
        if (callback) callback(null, 'Agent start admission is unavailable');
        return null;
      }
      const lifecycleFinish = this.beginAgentStartLifecycleOperation(agentId, options.startAdmissionToken);
      if (!lifecycleFinish) {
        if (callback) callback(null, 'Agent lifecycle operation already in progress');
        return null;
      }
      finishStartLifecycle = lifecycleFinish;
    }

    const createAdmission = this.beginPersistentAgentOperation(
      agentRecord,
      'create',
      options.createRequestId
        ? `create-request:${String(options.createRequestId).trim().slice(0, 160)}`
        : `create:${agentId}`,
      {
        agentId,
        previousRuntimeAgentId: (
          typeof options.restoreRuntimeAgentIdOnFailure === 'string'
          && options.restoreRuntimeAgentIdOnFailure
        )
          ? options.restoreRuntimeAgentIdOnFailure
          : previousPersistentRuntimeAgentId,
        previousState: createRollbackState(previousPersistentRecord),
        signature: createOperationSignature(command, customWorkspace, options),
        command: agentRecord.command,
        cwd: agentRecord.cwd,
        runtimeKind: runtimeKind(agentRecord),
        structuredProcessProofRequired: useAcp,
        structuredProcessStartGated: useAcp && process.platform !== 'win32',
      },
    );
    if ('error' in createAdmission) {
      finishStartLifecycle();
      if (callback) callback(null, createAdmission.error);
      return null;
    }
    const createOperationId = createAdmission.operation.id;
    const rollbackCreatePatch = () => createFailurePatch(
      createAdmission.operation,
      options.restoreRuntimeAgentIdOnFailure,
    );
    const restoreCreateSessionOptions = () => {
      const previousState = createAdmission.operation.request?.previousState;
      const sessionKey = previousPersistentRecord?.providerSessionKey
        || agentRecord.providerSessionKey;
      if (!sessionKey) return;
      if (
        previousState
        && Array.isArray(previousState.acpAdditionalDirectories)
        && Array.isArray(previousState.acpMcpServers)
      ) {
        this.acpSessionOptionsByKey.set(sessionKey, {
          additionalDirectories: [...previousState.acpAdditionalDirectories],
          configOverrides: cloneAcpConfigOverrides(previousState.acpConfigOverrides),
          mcpServers: JSON.parse(JSON.stringify(previousState.acpMcpServers)),
        });
      } else {
        this.acpSessionOptionsByKey.delete(sessionKey);
      }
    };

    let precreatedProviderSession: ProviderSessionRollbackIdentity | null = null;
    if (
      providerSessionPlan.precreate === true
      && !useAcp
    ) {
      const adapter = getProviderAdapter(providerSessionPlan.provider);
      if (typeof adapter?.terminalResumeArgs !== 'function') {
        const message = `${providerSessionPlan.provider} cannot resume a pre-created Terminal session`;
        try {
          this.transitionPersistentAgentOperation(
            agentRecord,
            createOperationId,
            'failed',
            message,
            rollbackCreatePatch(),
          );
          restoreCreateSessionOptions();
        } catch (caughtPersistError: unknown) {
      const persistError = caughtPersistError as ErrorRecord;
          console.error('Failed to persist Create failure:', persistError);
        }
        finishStartLifecycle();
        if (callback) callback(null, message);
        return null;
      }
      try {
        const requestedIdentityWorkspace = this.expandWorkspacePath(providerSessionPlan.identityWorkspace || '');
        const identityWorkspace = requestedIdentityWorkspace
          ? (path.isAbsolute(requestedIdentityWorkspace)
            ? path.resolve(requestedIdentityWorkspace)
            : path.resolve(workspace, requestedIdentityWorkspace))
          : workspace;
        let identityWorkspaceExists = false;
        try {
          identityWorkspaceExists = fs.statSync(identityWorkspace).isDirectory();
        } catch {
          identityWorkspaceExists = false;
        }
        if (!identityWorkspaceExists) {
          throw new Error(`Workspace does not exist: ${identityWorkspace}`);
        }
        const identityEnv = this.buildAgentEnv(agentId, agentRecord);
        const requestedAdditionalDirectories = Array.isArray(options.additionalDirectories)
          ? options.additionalDirectories
          : [];
        const requestedMcpServers = this.projectAcpMcpServers(
          Array.isArray(options.mcpServers) ? options.mcpServers : [],
          identityEnv,
        );
        const created = await this.createProviderSessionIdentity({
          provider: providerSessionPlan.provider,
          executable: spawnProgram,
          env: identityEnv,
          cwd: identityWorkspace,
          projectWorkspace: effectiveAgentWorkspaceRoot(agentRecord),
          providerHomeId: agentRecord.providerHomeId || 'default',
          providerHomePath: agentRecord.providerHomePath || '',
          approvalMode: agentRecord.launchPermissionMode || 'approve',
          model: codexModel,
          reasoningEffort: codexReasoningEffort,
          serviceTier: codexServiceTier,
          farmingSystemPrompt: renderFarmingAgentBootstrap(),
          additionalDirectories: requestedAdditionalDirectories,
          mcpServers: requestedMcpServers,
        });
        const providerSessionId = String(created?.sessionId || '').trim();
        if (!isSafeProviderSessionId(providerSessionId)) {
          throw new Error(`${providerSessionPlan.provider} ACP session/new returned an invalid session id`);
        }
        const normalizedSessionOptions = created?.sessionRequestOptions || {
          additionalDirectories: requestedAdditionalDirectories.map((directory: string) => path.resolve(identityWorkspace, directory)),
          mcpServers: JSON.parse(JSON.stringify(requestedMcpServers)),
        };
        args = adapter.terminalResumeArgs(args, providerSessionId);
        providerSessionPlan = {
          ...providerSessionPlan,
          id: providerSessionId,
          precreate: false,
          temporary: false,
          source: 'acp-precreated',
          args,
        };
        agentRecord.providerSessionId = providerSessionId;
        agentRecord.providerSessionKey = mainPageAgentSessionKey(
          providerSessionPlan.provider,
          providerSessionId,
          agentRecord.providerHomeId || 'default'
        );
        agentRecord.providerSessionTemporary = false;
        agentRecord.providerSessionSource = providerSessionPlan.source;
        agentRecord.providerSessionResolvedAt = Date.now();
        this.acpSessionOptionsByKey.set(String(agentRecord.providerSessionKey || ''), {
          additionalDirectories: Array.isArray(normalizedSessionOptions.additionalDirectories)
            ? [...normalizedSessionOptions.additionalDirectories]
            : [],
          configOverrides: [],
          mcpServers: Array.isArray(normalizedSessionOptions.mcpServers)
            ? JSON.parse(JSON.stringify(normalizedSessionOptions.mcpServers))
            : [],
        });
        precreatedProviderSession = {
          provider: providerSessionPlan.provider,
          executable: spawnProgram,
          env: identityEnv,
          cwd: identityWorkspace,
          sessionId: providerSessionId,
          sessionKey: agentRecord.providerSessionKey || '',
        };
      } catch (caughtError: unknown) {
      const error = caughtError as ErrorRecord;
        let identityRollbackError = null;
        let identityRetainedReason = '';
        const orphanedIdentityRecord = isRecord(error.providerSessionIdentity)
          ? error.providerSessionIdentity
          : null;
        const orphanedIdentity: ProviderSessionIdentity | null = orphanedIdentityRecord
          && typeof orphanedIdentityRecord.sessionId === 'string'
          ? { ...orphanedIdentityRecord, sessionId: orphanedIdentityRecord.sessionId }
          : null;
        if (
          orphanedIdentity
          && orphanedIdentity.producerStopped === true
          && isSafeProviderSessionId(orphanedIdentity.sessionId)
        ) {
          try {
            await this.deleteProviderSessionIdentity(orphanedIdentity);
          } catch (caughtCleanupError: unknown) {
      const cleanupError = caughtCleanupError as ErrorRecord;
            identityRollbackError = cleanupError;
          }
        } else if (orphanedIdentity && !isSafeProviderSessionId(orphanedIdentity.sessionId)) {
          identityRetainedReason = 'provider returned an unsafe session id; it was retained without invoking CLI rollback';
        } else if (orphanedIdentity) {
          identityRetainedReason = 'provider session retained because ACP producer shutdown could not be proven';
        }
        const baseMessage = error && error.message
          ? error.message
          : `Failed to create ${providerSessionPlan.provider} session identity`;
        let message = baseMessage;
        if (identityRollbackError) {
          message = `${baseMessage}; provider session rollback failed: ${identityRollbackError.message || identityRollbackError}`;
        } else if (identityRetainedReason) {
          message = `${baseMessage}; ${identityRetainedReason}`;
        }
        console.error('Failed to create provider session identity:', error);
        try {
          this.transitionPersistentAgentOperation(
            agentRecord,
            createOperationId,
            identityRetainedReason || identityRollbackError ? 'blocked' : 'failed',
            message,
            identityRetainedReason || identityRollbackError
              ? { visibleOnMainPage: true, archived: false }
              : rollbackCreatePatch(),
          );
          if (!(identityRetainedReason || identityRollbackError)) {
            restoreCreateSessionOptions();
          }
        } catch (caughtPersistError: unknown) {
      const persistError = caughtPersistError as ErrorRecord;
          message = `${message}; failed to persist Create failure: ${persistError.message || persistError}`;
        }
        finishStartLifecycle();
        if (callback) callback(null, message);
        return null;
      }
    }

    const logArgs = args.map((arg: string, index: number) => (
      index > 0 && args[index - 1] === '--append-system-prompt'
        ? '<farming-main-agent-bootstrap>'
        : arg
    ));
    console.log('Starting agent:', program, logArgs, 'workspace:', workspace, spawnProgram !== program ? `resolved: ${spawnProgram}` : '');

    let structuredRuntimeRegistered = false;

    try {
      this.registerAgentRecord(agentId, agentRecord);
      void this.refreshAgentWorktree(agentId);
      this.lastActivity.set(agentId, Date.now());
      this.emitStateChange({ agentIds: [agentId] });
      // A Chat view can safely attach as soon as this authoritative record
      // exists. ACP initialization continues below and reports any failure on
      // this same record, rather than requiring a speculative second launch.
      if (useAcp && typeof options.onAgentRegistered === 'function') {
        try {
          options.onAgentRegistered(agentId);
        } catch (registrationError) {
          const error = registrationError as ErrorRecord;
          console.warn(
            'Failed to publish registered Agent:',
            agentId,
            error.message || registrationError,
          );
        }
      }

      if (useAcp) {
        const acpRuntime = runtimeBindingOf(agentRecord, 'acp');
        if (!acpRuntime) throw new Error('ACP runtime binding was not installed');
        const sessionOptionsKey = agentRecord.providerSessionId && !agentRecord.providerSessionTemporary
          ? mainPageAgentSessionKey(
              structuredRuntimeProvider,
              agentRecord.providerSessionId,
              agentRecord.providerHomeId || 'default'
            )
          : '';
        const persistedSessionOptions: AcpSessionOptionsRecord = (
          sessionOptionsKey
          && previousPersistentRecord?.providerSessionKey === sessionOptionsKey
        ) ? {
            additionalDirectories: Array.isArray(previousPersistentRecord.acpAdditionalDirectories)
              ? [...previousPersistentRecord.acpAdditionalDirectories]
              : [],
            configOverrides: cloneAcpConfigOverrides(previousPersistentRecord.acpConfigOverrides),
            mcpServers: Array.isArray(previousPersistentRecord.acpMcpServers)
              ? JSON.parse(JSON.stringify(previousPersistentRecord.acpMcpServers))
              : [],
          }
          : { additionalDirectories: [], configOverrides: [], mcpServers: [] };
        const rememberedSessionOptions: AcpSessionOptionsRecord = sessionOptionsKey
          ? this.acpSessionOptionsByKey.get(sessionOptionsKey) || persistedSessionOptions
          : persistedSessionOptions;
        const additionalDirectories = Array.isArray(options.additionalDirectories)
          ? options.additionalDirectories
          : rememberedSessionOptions.additionalDirectories || [];
        const configOverrides = Array.isArray(options.acpConfigOverrides)
          ? cloneAcpConfigOverrides(options.acpConfigOverrides)
          : cloneAcpConfigOverrides(rememberedSessionOptions.configOverrides);
        const requestedMcpServers = Array.isArray(options.mcpServers)
          ? options.mcpServers
          : rememberedSessionOptions.mcpServers || [];
        const acpEnv = this.buildAgentEnv(agentId, agentRecord);
        const capabilityProjection = this.projectAcpMcpServersForRuntime(
          requestedMcpServers.filter(isRecord),
          acpEnv,
        );
        const mcpServers = capabilityProjection.mcpServers;
        const prepared = await this.acpRuntime.prepareAgent({
          agentId,
          capabilityRuntimeEpoch: capabilityProjection.capabilityRuntimeEpoch,
          provider: structuredRuntimeProvider,
          executable: spawnProgram,
          env: acpEnv,
          cwd: workspace,
          projectWorkspace: effectiveAgentWorkspaceRoot(agentRecord),
          sessionId: options.acpStartFresh === true || agentRecord.providerSessionTemporary || acpGeneratedFreshSession
            ? ''
            : (typeof agentRecord.providerSessionId === 'string' ? agentRecord.providerSessionId : ''),
          historyMode: options.acpHistoryMode === 'resume'
            ? 'resume'
            : (options.acpHistoryMode === 'load' ? 'load' : 'checkpoint'),
          providerHomeId: agentRecord.providerHomeId || 'default',
          providerHomePath: agentRecord.providerHomePath || '',
          approvalMode: agentRecord.launchPermissionMode || 'approve',
          model: codexModel,
          reasoningEffort: !preserveProviderSessionProfile
            && structuredRuntimeProvider === 'claude'
            && typeof homeLaunchProfile.effort === 'string'
            ? homeLaunchProfile.effort
            : codexReasoningEffort,
          serviceTier: codexServiceTier,
          farmingSystemPrompt: renderFarmingAgentBootstrap(),
          additionalDirectories,
          configOverrides,
          mcpServers,
          refreshMcpServersForRuntime: currentMcpServers => (
            this.projectAcpMcpServersForRuntime(currentMcpServers.filter(isRecord), acpEnv)
          ),
          forkSourceSessionId: options.acpForkSourceSessionId || '',
          forkSourceCheckpoint: options.acpForkSourceCheckpoint || null,
          onForkSessionCreated: async (sessionId: string) => {
            const exactSessionId = String(sessionId || '').trim();
            if (!isSafeProviderSessionId(exactSessionId)) {
              throw new Error('ACP fork startup returned an unsafe provider session id');
            }
            agentRecord.providerSessionId = exactSessionId;
            agentRecord.providerSessionKey = mainPageAgentSessionKey(
              structuredRuntimeProvider,
              exactSessionId,
              agentRecord.providerHomeId || 'default'
            );
            agentRecord.providerSessionTemporary = false;
            agentRecord.providerSessionSource = 'acp-fork';
            agentRecord.providerSessionResolvedAt = Date.now();
            let normalizedSessionOptions: AcpSessionOptionsRecord = {
              additionalDirectories,
              configOverrides: [],
              mcpServers,
            };
            try {
              const requestOptions = this.acpRuntime.getSessionRequestOptions(agentId);
              normalizedSessionOptions = {
                additionalDirectories: [...requestOptions.additionalDirectories],
                configOverrides: [],
                mcpServers: JSON.parse(JSON.stringify(requestOptions.mcpServers)),
              };
            } catch {
              // The live binding already validated the scope. Retain the caller
              // copy only for custom runtimes that do not expose it.
            }
            this.acpSessionOptionsByKey.set(String(agentRecord.providerSessionKey || ''), {
              additionalDirectories: [...normalizedSessionOptions.additionalDirectories],
              configOverrides: [],
              mcpServers: JSON.parse(JSON.stringify(normalizedSessionOptions.mcpServers)),
            });
            if (typeof options.onAcpForkSessionCreated === 'function') {
              await options.onAcpForkSessionCreated(exactSessionId);
            }
            this.ensurePersistentAgentSession(agentRecord);
          },
          onProcessStarted: async (processIdentity: AcpProcessIdentity) => {
            agentRecord.structuredRuntimeProcess = {
              kind: 'acp-process-group',
              ...processIdentity,
              ...(this.configInstanceFingerprint
                ? { configInstanceFingerprint: this.configInstanceFingerprint }
                : {}),
            };
            this.ensurePersistentAgentSession(agentRecord);
          },
        });
        if (typeof options.onAcpSessionPrepared === 'function') {
          await options.onAcpSessionPrepared(prepared);
        }
        structuredRuntimeRegistered = true;
        agentRecord.providerSessionId = prepared.sessionId;
        agentRecord.providerSessionKey = mainPageAgentSessionKey(
          structuredRuntimeProvider,
          prepared.sessionId,
          agentRecord.providerHomeId || 'default'
        );
        agentRecord.providerSessionTemporary = false;
        agentRecord.providerSessionSource = `acp-${prepared.historyMode}`;
        agentRecord.providerSessionResolvedAt = Date.now();
        const restoredConfigOverrides = Array.isArray(prepared.configOverrides)
          ? cloneAcpConfigOverrides(prepared.configOverrides)
          : configOverrides;
        let normalizedSessionOptions: AcpSessionOptionsRecord = {
          additionalDirectories,
          configOverrides: restoredConfigOverrides,
          mcpServers,
        };
        try {
          const requestOptions = this.acpRuntime.getSessionRequestOptions(agentId);
          normalizedSessionOptions = {
            additionalDirectories: [...requestOptions.additionalDirectories],
            configOverrides: restoredConfigOverrides,
            mcpServers: JSON.parse(JSON.stringify(requestOptions.mcpServers)),
          };
        } catch {
          // prepareAgent already validated the request; retain the caller copy
          // only for custom runtimes that do not expose the normalized scope.
        }
        this.acpSessionOptionsByKey.set(String(agentRecord.providerSessionKey || ''), {
          additionalDirectories: [...normalizedSessionOptions.additionalDirectories],
          configOverrides: cloneAcpConfigOverrides(normalizedSessionOptions.configOverrides),
          mcpServers: JSON.parse(JSON.stringify(normalizedSessionOptions.mcpServers)),
        });
        acpRuntime.state = 'idle';
        acpRuntime.error = '';
      }

      if (!useAcp) {
        const terminalStartupPolicy = resolution.engineName === 'native'
          ? providerTerminalStartupPolicy(agentRecord.providerSessionProvider)
          : null;
        const startTerminal = async () => {
          const engineLaunch: Omit<TerminalEngineLaunch, 'reviveState'> & { reviveState?: unknown } = {
            command: spawnProgram,
            args,
            cwd: workspace,
            category: typeof resolutionSpec?.category === 'string' ? resolutionSpec.category : 'shell',
            reviveState: options.reviveTerminalState || null,
          };
          await this.createAgentEngineSession(agentRecord, resolution.engine, engineLaunch);
        };
        if (terminalStartupPolicy) {
          const startupResourceKey = terminalStartupPolicy.serialization === 'provider-home'
            ? providerHomePath || resolvedProviderHomeId || 'default'
            : resolvedProviderHomeId || 'default';
          await this.terminalStartupCoordinator.run({
            agentId,
            observe: () => {
              const current = this.agents.get(agentId);
              return current
                ? {
                  engineStatus: current.engineStatus,
                  output: current.output,
                  previewText: current.previewText,
                  status: current.status,
                }
                : null;
            },
            policy: terminalStartupPolicy,
            resourceKey: startupResourceKey,
            start: startTerminal,
          });
        } else {
          await startTerminal();
        }
      }
      this.transitionPersistentAgentOperation(agentRecord, createOperationId, 'membership-pending', '', {
        visibleOnMainPage: true,
        archived: false,
        ...(options.customTitleExplicit === true
          ? { customTitle: agentRecord.customTitle }
          : {}),
      });
      this.rememberMainPageProviderSession(agentRecord);
      this.transitionPersistentAgentOperation(agentRecord, createOperationId, 'succeeded', '', {
        visibleOnMainPage: true,
        archived: false,
      });
      if (
        previousPersistentRuntimeAgentId
        && previousPersistentRuntimeAgentId !== agentId
      ) {
        this.forgetStoppedAgentRecord(previousPersistentRuntimeAgentId, { emitUpdate: false });
      }

      const agent = this.agents.get(agentId);
      const previousMainAgentId = this.mainAgentId;
      if (agent && agent.status === 'pending') {
        agent.status = 'running';

        const currentMainAgent = this.mainAgentId ? this.agents.get(this.mainAgentId) : null;
        const canBecomeMain = !this.mainAgentId || !currentMainAgent || currentMainAgent.status === 'dead';
        if (agent.wantsMain && canBecomeMain) {
          this.mainAgentId = agentId;
        }
      }

      this.providerSessionService.activate(agentId);
      void this.resolveCodexTerminalIdentityFromCurrentView(agentId);
      finishStartLifecycle();
      if (callback) callback(agentId);
      this.emitStateChange({
        agentIds: [agentId, previousMainAgentId].filter(
          (value): value is string => typeof value === 'string' && value.length > 0,
        ),
        ...(this.mainAgentId !== previousMainAgentId ? { mainAgentIdChanged: true } : {}),
        ...(previousPersistentRuntimeAgentId && previousPersistentRuntimeAgentId !== agentId
          ? { removedAgentIds: [previousPersistentRuntimeAgentId] }
          : {}),
      });
      return agentId;
    } catch (caughtError: unknown) {
      const error = caughtError as ErrorRecord;
      console.error('Failed to start agent:', error);
      let runtimeCleanupError = null;
      if (
        useAcp
        && error?.runtimeCleanupVerified !== true
        && (structuredRuntimeRegistered || error?.runtimeCleanupAttempted === true)
      ) {
        try {
          const stopped = await this.acpRuntime.unregisterAgentAndWait(agentId);
          if (stopped !== true) {
            throw error?.adapterCleanupError
              || new Error('ACP runtime binding disappeared before exit was verified', { cause: error });
          }
        } catch (caughtCleanupError: unknown) {
      const cleanupError = caughtCleanupError as ErrorRecord;
          runtimeCleanupError = cleanupError;
        }
      } else if (!useAcp) {
        try {
          await this.stopUncertainTerminalSession(resolution.engine, agentId);
        } catch (caughtEngineCleanupError: unknown) {
      const engineCleanupError = caughtEngineCleanupError as ErrorRecord;
          runtimeCleanupError = engineCleanupError;
          console.error(
            'Failed to stop partially started Agent runtime:',
            engineCleanupError && (engineCleanupError.message || engineCleanupError)
          );
        }
      }
      if (runtimeCleanupError) {
        console.error(
          'Failed to stop partially started Agent runtime:',
          runtimeCleanupError.message || runtimeCleanupError
        );
      }
      let rollbackError = null;
      if (precreatedProviderSession && !runtimeCleanupError) {
        try {
          await this.deleteProviderSessionIdentity(precreatedProviderSession);
        } catch (caughtCleanupError: unknown) {
      const cleanupError = caughtCleanupError as ErrorRecord;
          rollbackError = cleanupError;
          console.error(
            'Failed to roll back pre-created provider session:',
            cleanupError && (cleanupError.message || cleanupError)
          );
        }
        this.acpSessionOptionsByKey.delete(precreatedProviderSession.sessionKey);
      } else if (precreatedProviderSession) {
        this.acpSessionOptionsByKey.delete(precreatedProviderSession.sessionKey);
      }
      const startupError = error && (error.message || String(error));
      const cleanupSuffix = rollbackError
        ? `; provider session rollback failed: ${rollbackError.message || rollbackError}`
        : '';
      const runtimeCleanupSuffix = runtimeCleanupError
        ? `; runtime cleanup could not be verified and Agent ${agentId} was retained for retry: ${runtimeCleanupError.message || runtimeCleanupError}`
        : '';
      if (runtimeCleanupError) {
        agentRecord.status = 'error';
        agentRecord.engineStatus = 'cleanup-uncertain';
        const runtime = runtimeBindingOf(agentRecord);
        if (runtime && Object.prototype.hasOwnProperty.call(runtime, 'state')) {
          runtime.state = 'error';
          runtime.error = runtimeCleanupError.message || String(runtimeCleanupError);
        }
        try {
          this.transitionPersistentAgentOperation(
            agentRecord,
            createOperationId,
            'blocked',
            runtimeCleanupError.message || String(runtimeCleanupError),
          );
        } catch (caughtPersistError: unknown) {
      const persistError = caughtPersistError as ErrorRecord;
          runtimeCleanupError = new Error(
            `${runtimeCleanupError.message || runtimeCleanupError}; failed to persist blocked Create: ${persistError.message || persistError}`,
          );
        }
        finishStartLifecycle();
        this.emitStateChange({ agentIds: [agentId] });
        if (callback) callback(agentId, `${startupError}${runtimeCleanupSuffix}${cleanupSuffix}`);
        return null;
      }
      try {
        this.transitionPersistentAgentOperation(
          agentRecord,
          createOperationId,
          'failed',
          startupError,
          rollbackCreatePatch(),
        );
        restoreCreateSessionOptions();
      } catch (caughtPersistError: unknown) {
      const persistError = caughtPersistError as ErrorRecord;
        agentRecord.status = 'error';
        agentRecord.engineStatus = 'metadata-commit-uncertain';
        const message = `${startupError}; failed to persist Create failure: ${persistError.message || persistError}`;
        finishStartLifecycle();
        this.emitStateChange({ agentIds: [agentId] });
        if (callback) callback(agentId, message);
        return null;
      }
      this.deleteAgentRecord(agentId);
      this.acpFinalizedTurns.delete(agentId);
      this.acpTurnFinalizationTails.delete(agentId);
      this.lastActivity.delete(agentId);
      this.lastActivityUpdate.delete(agentId);
      this.usageRateTracker.forget(agentId);
      this.codexTerminalIdentityAttempts.delete(agentId);
      this.codexTerminalIdentityPromises.delete(agentId);
      this.providerSessionService.stop(agentId);
      if (this.acpRuntime) this.acpRuntime.unregisterAgent(agentId);

      const removedMainAgent = this.mainAgentId === agentId;
      if (removedMainAgent) {
        this.mainAgentId = null;
      }

      finishStartLifecycle();
      this.emitStateChange({
        removedAgentIds: [agentId],
        ...(removedMainAgent ? { mainAgentIdChanged: true } : {}),
      });
      if (callback) callback(null, `${startupError}${runtimeCleanupSuffix}${cleanupSuffix}`);
      return null;
    }
  }
  
  assertAgentOperationAdmission() {
    if (this.disposing) {
      throw new Error('Farming is shutting down; Agent operations are not accepted');
    }
  }

  async enqueueInputOperation<Result>(
    agentId: AgentId,
    operation: InputOperation<Result>,
    options: InputQueueOptions = {},
  ): Promise<Result> {
    return this.inputCoordinator.enqueue(agentId, operation, options);
  }

  async enqueueInputOperationUntilReleased<Result>(
    agentId: AgentId,
    operation: ReleasedInputOperation<Result>,
  ): Promise<Result> {
    return this.inputCoordinator.enqueueUntilReleased(agentId, operation);
  }

  async sendInput(
    agentId: AgentId,
    input: TerminalInput,
    options: TerminalInputOptions = {},
  ): Promise<TerminalInputResult | undefined> {
    return this.enqueueInputOperation(agentId, () => this.sendInputNow(agentId, input, options));
  }

  sendPersistentComposerMessage(
    agentId: AgentId,
    message: unknown,
    requestId: string,
    options: ComposerMessageOptions = {},
  ): Promise<unknown> {
    const lifecycleOperation = this.agentLifecycleOperations.get(agentId);
    if (lifecycleOperation) {
      return Promise.reject(new Error(
        `Agent lifecycle change already in progress: ${lifecycleOperation.label}`,
      ));
    }
    const agent = this.agents.get(agentId);
    if (!agent) return Promise.reject(new Error('Agent not found'));
    return this.composerAdmissionCoordinator.request({
      agent,
      delivery: options.delivery,
      message,
      requestId,
    });
  }

  async sendComposerMessage(
    agentId: AgentId,
    message: unknown,
    options: ComposerMessageOptions = {},
  ): Promise<unknown> {
    const lifecycleOperation = this.agentLifecycleOperations.get(agentId);
    if (lifecycleOperation) {
      throw new Error(`Agent lifecycle change already in progress: ${lifecycleOperation.label}`);
    }
    const requestId = String(options.requestId || '').trim();
    if (requestId) {
      if (!/^[A-Za-z0-9._:-]{1,160}$/.test(requestId)) throw new Error('Composer requestId is invalid');
      return this.sendPersistentComposerMessage(agentId, message, requestId, options);
    }
    const agent = this.agents.get(agentId);
    if (agent && isAcpAgent(agent)) {
      if (options.delivery === 'steer') {
        return this.sendComposerMessageNow(agentId, message, { delivery: 'steer' });
      }
      return this.enqueueInputOperationUntilReleased(
        agentId,
        (releaseInput: () => void) => this.sendComposerMessageNow(agentId, message, {
          releaseInput,
          delivery: options.delivery,
        }),
      );
    }
    return this.enqueueInputOperation(
      agentId,
      () => this.sendComposerMessageNow(agentId, message, { delivery: options.delivery }),
    );
  }

  confirmCodexTerminalStatusIdentity(
    agentId: AgentId,
    sessionId: string,
    expectedAgent: TypedAgentRecord,
    expectedRuntimeEpoch: string,
  ): boolean {
    const current = this.agents.get(agentId);
    if (
      current !== expectedAgent
      || runtimeKind(current) !== 'terminal'
      || current.providerSessionProvider !== 'codex'
      || current.providerSessionTemporary !== true
      || (expectedRuntimeEpoch && current.runtimeEpoch !== expectedRuntimeEpoch)
      || !isSafeProviderSessionId(sessionId)
    ) {
      return false;
    }
    return this.providerSessionService.confirm(agentId, {
      provider: 'codex',
      sessionId,
      source: 'codex-terminal-status',
      workspace: current.projectWorkspace || current.cwd || '',
    });
  }

  resolveCodexTerminalIdentityFromPreview(
    agentId: AgentId,
    previewText: string,
  ): Promise<boolean> {
    const agent = this.agents.get(agentId);
    if (
      !agent
      || runtimeKind(agent) !== 'terminal'
      || agent.providerSessionProvider !== 'codex'
      || agent.providerSessionTemporary !== true
      || agent.terminalDraftInputReceived === true
      || !isRunningAgentRuntimeStatus(agent.status)
    ) {
      return Promise.resolve(false);
    }

    const runtimeEpoch = String(agent.runtimeEpoch || '');
    const sessionId = codexTerminalSessionIdFromStatus(previewText);
    if (sessionId) {
      return Promise.resolve(this.confirmCodexTerminalStatusIdentity(
        agentId,
        sessionId,
        agent,
        runtimeEpoch,
      ));
    }
    if (!isCodexTerminalComposerPreview(previewText)) return Promise.resolve(false);

    const attemptKey = runtimeEpoch || `started:${Number(agent.startedAt) || 0}`;
    if (this.codexTerminalIdentityAttempts.get(agentId) === attemptKey) {
      return this.codexTerminalIdentityPromises.get(agentId) || Promise.resolve(false);
    }
    this.codexTerminalIdentityAttempts.set(agentId, attemptKey);

    const operation = this.enqueueInputOperation(agentId, async () => {
      const current = this.agents.get(agentId);
      if (
        current !== agent
        || current.providerSessionTemporary !== true
        || (runtimeEpoch && current.runtimeEpoch !== runtimeEpoch)
      ) {
        return false;
      }
      const view = await this.getAgentSessionView(agentId);
      const currentPreview = String(view?.previewText || '');
      const renderedSessionId = codexTerminalSessionIdFromStatus(currentPreview);
      if (renderedSessionId) {
        return this.confirmCodexTerminalStatusIdentity(
          agentId,
          renderedSessionId,
          agent,
          runtimeEpoch,
        );
      }
      if (!isCodexTerminalComposerPreview(currentPreview)) {
        if (this.codexTerminalIdentityAttempts.get(agentId) === attemptKey) {
          this.codexTerminalIdentityAttempts.delete(agentId);
        }
        return false;
      }

      const resolvedSessionId = await resolveCodexTerminalSessionId({
        timeoutMs: CODEX_TERMINAL_STATUS_TIMEOUT_MS,
        readPreview: async () => {
          const nextView = await this.getAgentSessionView(agentId);
          if (!nextView) throw new Error('Agent not found');
          return nextView.previewText;
        },
        sendInput: async (input: TerminalInput) => {
          const result = await this.sendInputNow(agentId, input, {
            expectedRuntimeEpoch: runtimeEpoch,
            markUserInput: false,
            throwOnUncertain: true,
          });
          if (!result) throw new Error('Codex Terminal is not available');
          if ('status' in result && result.status === 'input-rejected') {
            throw new Error('Codex Terminal runtime changed before /status');
          }
          return result;
        },
      });
      return this.confirmCodexTerminalStatusIdentity(
        agentId,
        resolvedSessionId,
        agent,
        runtimeEpoch,
      );
    }).catch((error: unknown) => {
      console.warn(
        `Failed to resolve Codex Terminal session id for ${agentId}:`,
        error instanceof Error ? error.message : String(error),
      );
      return false;
    });
    this.codexTerminalIdentityPromises.set(agentId, operation);
    void operation.finally(() => {
      if (this.codexTerminalIdentityPromises.get(agentId) === operation) {
        this.codexTerminalIdentityPromises.delete(agentId);
      }
    });
    return operation;
  }

  async resolveCodexTerminalIdentityFromCurrentView(agentId: AgentId): Promise<boolean> {
    const agent = this.agents.get(agentId);
    if (
      !agent
      || runtimeKind(agent) !== 'terminal'
      || agent.providerSessionProvider !== 'codex'
      || agent.providerSessionTemporary !== true
    ) {
      return false;
    }
    try {
      const view = await this.getAgentSessionView(agentId);
      return this.resolveCodexTerminalIdentityFromPreview(
        agentId,
        String(view?.previewText || agent.previewText || ''),
      );
    } catch (error) {
      console.warn(
        `Failed to inspect Codex Terminal session id for ${agentId}:`,
        error instanceof Error ? error.message : String(error),
      );
      return false;
    }
  }

  async setCodexTerminalProfile(
    agentId: AgentId,
    profile: CodexTerminalProfileRequest,
    options: CodexTerminalProfileOptions = {},
  ): Promise<unknown> {
    const previous = this.codexTerminalProfileQueues.get(agentId) || Promise.resolve();
    const start = () => this.enqueueInputOperationUntilReleased(
      agentId,
      (releaseInput: () => void) => this.setCodexTerminalProfileNow(agentId, profile, {
        ...options,
        onInputSafe: releaseInput,
      }),
    );
    const next = this.codexTerminalProfileQueues.has(agentId)
      ? previous.catch(() => {}).then(start)
      : start();
    this.codexTerminalProfileQueues.set(agentId, next);
    try {
      return await next;
    } finally {
      if (this.codexTerminalProfileQueues.get(agentId) === next) {
        this.codexTerminalProfileQueues.delete(agentId);
      }
    }
  }

  async setCodexTerminalProfileNow(
    agentId: AgentId,
    profile: CodexTerminalProfileRequest,
    options: CodexTerminalProfileOptions = {},
  ): Promise<unknown> {
    const agent = this.agents.get(agentId);
    if (!agent) throw new Error('Agent not found');
    if (
      agentProgramName(agent.command).toLowerCase() !== 'codex'
      || runtimeKind(agent) !== 'terminal'
    ) {
      throw new Error('This Agent is not using Codex Terminal');
    }
    if (!isRunningAgentRuntimeStatus(agent.status)) {
      throw new Error('Codex Terminal is not running');
    }
    if (this.isAgentAttentionTurnActive(agent)) {
      throw new Error('Wait for the active Codex Terminal turn to finish before changing its model');
    }

    const applied = await applyCodexTerminalProfile({
      profile,
      timeoutMs: options.timeoutMs,
      signal: options.signal,
      onInputSafe: options.onInputSafe,
      readPreview: async () => {
        const view = await this.getAgentSessionView(agentId);
        if (!view) throw new Error('Agent not found');
        return view.previewText;
      },
      readOutput: async () => String(await this.getAgentSessionText(agentId) || ''),
      // `/model` and `/fast on|off` are Farming-owned control traffic. They must not
      // make a fresh Terminal look user-authored, because that would remove
      // the safe fresh-session path into ACP Chat before the provider has
      // materialized a resumable history record.
      sendInput: async (input: TerminalInput) => this.sendInputNow(
        agentId,
        input,
        { markUserInput: false },
      ),
    });
    agent.codexTerminalProfile = {
      model: applied.model,
      reasoningEffort: applied.effort,
      serviceTier: applied.serviceTier,
      source: 'terminal-command',
    };

    // The HTTP response confirms the terminal has already reached this profile.
    // Publish that confirmation immediately instead of waiting for a later PTY
    // preview tick; otherwise the browser's bounded optimistic state can expire
    // and briefly fall back to the pre-command footer.
    const view = options.signal?.aborted
      ? null
      : await this.getAgentSessionView(agentId);
    if (view) {
      agent.previewText = view.previewText || agent.previewText || '';
      agent.previewSnapshot = view.previewSnapshot || agent.previewSnapshot || null;
      agent.previewCols = view.previewCols || agent.previewCols || 80;
      agent.previewRows = view.previewRows || agent.previewRows || 30;
      this.emit('session-preview-update', {
        agentId,
        previewText: agent.previewText,
        cols: agent.previewCols,
        rows: agent.previewRows,
        previewSnapshot: agent.previewSnapshot,
        codexTerminalProfile: agent.codexTerminalProfile,
        terminalStatus: view.terminalStatus,
        runtimeObservation: deriveRuntimeObservation({ ...agent, terminalStatus: view.terminalStatus }),
      });
    }
    this.emitStateChange({ agentIds: [agentId] });
    return applied;
  }

  async sendComposerMessageNow(
    agentId: AgentId,
    message: unknown,
    options: ComposerSendOptions = {},
  ): Promise<ComposerSubmissionResult> {
    options.assertDeliveryOwner?.();
    const agent = this.agents.get(agentId);
    if (!agent) throw new Error('Agent not found');
    if (options.requireConfirmedTerminalDelivery === true) {
      if (
        runtimeKind(agent) !== 'terminal'
        || agent !== options.expectedTerminalAgent
        || agent.runtimeEpoch !== options.expectedTerminalRuntimeEpoch
      ) {
        throw Object.assign(
          new Error('Agent runtime changed before Terminal message delivery'),
          {
            code: 'COMPOSER_TERMINAL_RUNTIME_REPLACED',
            composerRecordExact: agent === options.expectedTerminalAgent,
            composerZeroEffect: true,
          },
        );
      }
    }
    const prompt = normalizedComposerPrompt(message);
    const text = prompt
      .filter((content: ComposerContentPart) => content.type === 'text')
      .map((content: ComposerContentPart) => String(content.text || ''))
      .join('')
      .trim();

    if (isAcpAgent(agent)) {
      this.requireLiveAcpAgent(agentId);
      await this.reconnectAcpAgent(agentId);
      options.assertDeliveryOwner?.();
      this.requireLiveAcpAgent(agentId);
      const result = await this.acpRuntime.submitMessage(agentId, prompt, {
        delivery: options.delivery,
        clientPromptId: options.requestId,
        retryDefinitiveFailure: options.retryDefinitiveFailure,
        onSubmitted: options.onSubmitted
          ? () => options.onSubmitted?.({ kind: 'acp' })
          : options.releaseInput,
      });
      if (result.steered !== true) {
        const runtime = runtimeBindingOf(agent, 'acp');
        if (!runtime) throw new Error('ACP runtime binding is unavailable');
        runtime.state = 'idle';
        runtime.stopReason = result.stopReason || '';
        if (
          this.acpRuntime.turnCompletionEvents !== true
          &&
          this.agents.get(agentId) === agent
          && ACP_ATTENTION_STOP_REASONS.has(runtime.stopReason)
        ) {
          try {
            agent.attentionSummary = acpLastAssistantNotificationSummary(
              await this.acpRuntime.getTranscriptSessionForRead(agentId, { maxTurns: 1 }),
            );
          } catch {
            agent.attentionSummary = '';
          }
          this.recordAgentAttentionEvent(agent, 'turn-complete');
        }
      }
      // ACP assigns a Codex session id before it writes an archivable
      // conversation. A submitted message is the materialization boundary.
      agent.providerSessionMaterialized = true;
      this.ensurePersistentAgentSession(agent);
      if (result.steered !== true && this.acpRuntime.turnCompletionEvents !== true) {
        this.providerSessionService.observe(agentId, { force: true });
      }
      return { kind: 'acp', ...result };
    }

    const input: TerminalInput = [{ type: 'paste', text }, '\r'];
    if (options.requireConfirmedTerminalDelivery === true) {
      const result = await this.sendInputNow(agentId, input, {
        expectedRuntimeEpoch: options.expectedTerminalRuntimeEpoch,
        throwOnUncertain: true,
      });
      if (!result || !('sent' in result) || result.sent !== true) {
        if (
          result
          && 'status' in result
          && result.status === 'input-rejected'
          && result.reason === 'runtime-epoch-mismatch'
        ) {
          // Terminal engines reject a stale runtime epoch before the PTY write,
          // so this exact rejection proves the message had no provider effect.
          throw Object.assign(
            new Error('Terminal runtime epoch advanced before Composer input reached the terminal'),
            {
              code: 'COMPOSER_TERMINAL_INPUT_EPOCH_REJECTED',
              composerRecordExact: this.agents.get(agentId) === agent,
              composerZeroEffect: true,
            },
          );
        }
        const reason = result && 'reason' in result ? result.reason : 'Terminal runtime is unavailable';
        throw new Error(reason);
      }
    } else {
      await this.sendInputNow(agentId, input);
    }
    const submitted: ComposerSubmissionResult = { kind: 'terminal' };
    options.onSubmitted?.(submitted);
    return submitted;
  }

  getAcpSession(agentId: AgentId, options: Partial<AcpSessionRequestOptions> = {}) {
    this.requireLiveAcpAgent(agentId);
    return this.acpRuntime.getSession(agentId, options);
  }

  async getAcpSessionForRead(agentId: AgentId, options: Partial<AcpSessionRequestOptions> = {}) {
    this.requireLiveAcpAgent(agentId);
    return this.acpRuntime.getSessionForRead(agentId, options);
  }

  async reconnectAcpAgent(agentId: AgentId) {
    this.assertAgentOperationAdmission();
    const agent = this.requireLiveAcpAgent(agentId);
    await this.acpRuntime.initialize?.();
    if (!this.acpRuntime.hasBinding(agentId)) {
      await this.recoverAcpSessions();
      this.requireLiveAcpAgent(agentId);
      if (!this.acpRuntime.hasBinding(agentId)) {
        throw new Error('ACP runtime Host binding could not be recovered');
      }
    }
    const result = await this.acpRuntime.reconnectAgent(agentId, {
      onProcessStopped: () => {
        if (this.agents.get(agentId) !== agent) return;
        agent.structuredRuntimeProcess = null;
        this.ensurePersistentAgentSession(agent);
      },
    });
    this.ensurePersistentAgentSession(agent);
    return result;
  }

  async getAcpTranscript(agentId: AgentId, options: Partial<AcpSessionRequestOptions> = {}) {
    const response = await this.resolveAcpTranscriptResponse(agentId, options);
    if (response.payload) return response.payload;
    return JSON.parse(String(response.serialized || '{}'));
  }

  async getAcpTranscriptSerialized(agentId: AgentId, options: Partial<AcpSessionRequestOptions> = {}) {
    const response = await this.resolveAcpTranscriptResponse(agentId, options);
    return response.serialized || JSON.stringify(response.payload);
  }

  async resolveAcpTranscriptResponse(agentId: AgentId, options: Partial<AcpSessionRequestOptions> = {}) {
    this.requireLiveAcpAgent(agentId);
    const agent = this.agents.get(agentId);
    const runtime = runtimeBindingOf(agent, 'acp');
    const identity = {
      agentId,
      sessionId: String(agent?.providerSessionId || ''),
      runtimeEpoch: this.acpRuntime.bindingEpoch(agentId),
      revision: Number(runtime?.sessionRevision || 0),
      projectionRevision: this.acpRuntime.transcriptProjectionRevision(agentId),
    };
    const preparedProfile = !Number.isFinite(Number(options.sinceRevision))
      && Number(options.maxTurns) === PREPARED_ACP_TRANSCRIPT_TURN_LIMIT
      && options.mediaPathPrefix === this.transcriptMediaPathPrefix(agentId);
    if (preparedProfile && identity.sessionId) {
      this.observeAcpPreparedTranscript(agentId, 100);
      const serialized = this.acpPreparedTranscriptCache.getSerialized(identity);
      if (serialized) return { serialized };
    }
    const readKey = JSON.stringify({
      agentId,
      sessionId: identity.sessionId,
      runtimeEpoch: identity.runtimeEpoch,
      maxTurns: Number(options.maxTurns) || 0,
      sinceRevision: Number.isFinite(Number(options.sinceRevision)) ? Number(options.sinceRevision) : null,
      mediaPathPrefix: String(options.mediaPathPrefix || ''),
    });
    const existing = this.acpTranscriptReads.get(readKey);
    if (existing) return existing;
    const read = (async () => {
      const payload = await this.buildAcpTranscriptEnvelope(agentId, options);
      if (preparedProfile && identity.sessionId) {
        const serialized = this.acpPreparedTranscriptCache.publishOnDemand(identity, payload);
        if (serialized) return { payload, serialized };
      }
      return { payload };
    })().finally(() => {
      if (this.acpTranscriptReads.get(readKey) === read) this.acpTranscriptReads.delete(readKey);
    });
    this.acpTranscriptReads.set(readKey, read);
    return read;
  }

  async buildAcpTranscript(agentId: AgentId, options: Partial<AcpSessionRequestOptions> = {}) {
    this.requireLiveAcpAgent(agentId);
    const transcript = await this.acpRuntime.getTranscriptSessionForRead(agentId, options);
    const entries = Array.isArray(transcript.entries)
      ? transcript.entries.filter(isAcpTranscriptEntry)
      : [];
    return {
      ...transcript,
      entries: acpTranscriptEntries(entries, {
        mediaPathPrefix: typeof options.mediaPathPrefix === 'string'
          ? options.mediaPathPrefix
          : undefined,
      }),
    };
  }

  async buildAcpTranscriptEnvelope(agentId: AgentId, options: Partial<AcpSessionRequestOptions> = {}) {
    const transcript = await this.buildAcpTranscript(agentId, options);
    const requestedRevision = Number(options.sinceRevision);
    const replace = transcript.delta !== true;
    return {
      version: 1,
      agentId,
      sessionId: String(transcript.sessionId || ''),
      runtimeEpoch: this.acpRuntime.bindingEpoch(agentId),
      fromRevision: !replace && Number.isFinite(requestedRevision)
        ? Math.max(0, Math.floor(requestedRevision))
        : null,
      toRevision: Number(transcript.revision || 0),
      replace,
      settled: this.acpRuntime.transcriptSettled(agentId),
      hasMoreBefore: transcript.hasMoreBefore === true,
      transcript,
    };
  }

  observeAcpPreparedTranscript(agentId: AgentId, priority = 0) {
    const agent = this.agents.get(agentId);
    const runtime = runtimeBindingOf(agent, 'acp');
    const sessionId = String(agent?.providerSessionId || '');
    if (!agent || !runtime || !sessionId) return;
    this.acpPreparedTranscriptCache.observe({
      agentId,
      sessionId,
      runtimeEpoch: this.acpRuntime.bindingEpoch(agentId),
      revision: Number(runtime.sessionRevision || 0),
      projectionRevision: this.acpRuntime.transcriptProjectionRevision(agentId),
      eligible: runtime.state === 'idle',
      priority,
    });
  }

  refreshAcpPreparedTranscript(agentId: AgentId) {
    if (!this.acpPreparedTranscriptCache.hasAgent(agentId)) return;
    this.observeAcpPreparedTranscript(agentId);
  }

  prioritizeAcpPreparedTranscript(agentId: AgentId) {
    this.observeAcpPreparedTranscript(agentId, 100);
  }

  prepareAcpTranscript(agentId: AgentId) {
    this.requireLiveAcpAgent(agentId);
    this.observeAcpPreparedTranscript(agentId, 100);
    return { accepted: true };
  }

  async getAcpTranscriptMedia(agentId: AgentId, entryId: string, mediaId: string) {
    this.requireLiveAcpAgent(agentId);
    const entry = await this.acpRuntime.getTranscriptEntryForRead(agentId, entryId);
    if (!entry) throw new Error('ACP transcript entry not found');
    const media = acpTranscriptMedia(entry, mediaId);
    if (!media) throw new Error('ACP transcript media not found');
    return media;
  }

  async getAcpToolDetail(agentId: AgentId, toolCallId: string) {
    this.requireLiveAcpAgent(agentId);
    const entry = await this.acpRuntime.getToolEntryForRead(agentId, toolCallId);
    if (!entry) throw new Error('ACP tool call not found');
    const subagentSessionId = String(entry?._meta?.subagent_session_info?.session_id || '');
    const subagentSession = subagentSessionId
      ? await this.acpRuntime.getSubagentTranscriptSessionForRead(agentId, subagentSessionId, { maxTurns: 12 })
      : null;
    return {
      toolCallId: String(toolCallId || ''),
      detail: acpToolDetail(entry),
      changes: acpToolChanges(entry),
      ...(subagentSession ? { subagentSession } : {}),
      terminals: (Array.isArray(entry.content) ? entry.content : [])
        .filter((block) => block.type === 'terminal')
        .map((block) => ({
          terminalId: String(block.terminalId || ''),
          ...(block.terminal ? { terminal: block.terminal } : {}),
        })),
    };
  }

  killAcpTerminal(agentId: AgentId, terminalId: string) {
    this.assertAgentOperationAdmission();
    this.getAcpSession(agentId);
    return this.acpRuntime.killTerminal(agentId, terminalId);
  }

  inputAcpTerminal(agentId: AgentId, terminalId: string, input: string, operationId?: string) {
    this.assertAgentOperationAdmission();
    this.getAcpSession(agentId);
    return this.acpRuntime.inputTerminal(agentId, terminalId, input, operationId);
  }

  resizeAcpTerminal(agentId: AgentId, terminalId: string, cols: number, rows: number) {
    this.assertAgentOperationAdmission();
    this.getAcpSession(agentId);
    return this.acpRuntime.resizeTerminal(agentId, terminalId, cols, rows);
  }

  cancelAcpSubagent(agentId: AgentId, sessionId: string) {
    this.assertAgentOperationAdmission();
    this.getAcpSession(agentId);
    return this.acpRuntime.cancelSubagent(agentId, sessionId);
  }

  async decideAcpPatch(agentId: AgentId, toolCallId: string, requestedPath: string, decision: 'keep' | 'revert') {
    this.assertAgentOperationAdmission();
    this.getAcpSession(agentId);
    await this.reconnectAcpAgent(agentId);
    return this.acpRuntime.decidePatch(agentId, toolCallId, requestedPath, decision);
  }

  async getAcpReviewChanges(agentId: AgentId, toolCallIds: readonly string[]) {
    this.requireLiveAcpAgent(agentId);
    if (!Array.isArray(toolCallIds) || toolCallIds.length === 0 || toolCallIds.length > 256) {
      throw new Error('ACP review tool calls are invalid');
    }
    const changes = [];
    for (const toolCallId of toolCallIds) {
      if (typeof toolCallId !== 'string' || !toolCallId.trim()) {
        throw new Error('ACP review tool calls are invalid');
      }
      const entry = await this.acpRuntime.getToolEntryForRead(agentId, toolCallId.trim());
      if (!entry) throw new Error('ACP tool call not found');
      const entryChanges = acpToolReviewChanges(entry);
      if (Array.isArray(entryChanges)) changes.push(...entryChanges);
    }
    return changes;
  }

  async listAcpSessions(agentId: AgentId, options: AcpSessionListOptions = {}) {
    this.requireLiveAcpAgent(agentId);
    await this.reconnectAcpAgent(agentId);
    return this.acpRuntime.listSessions(agentId, options);
  }

  respondToAcpPermission(agentId: AgentId, requestId: string, optionId: string, cancelled = false) {
    this.assertAgentOperationAdmission();
    this.requireLiveAcpAgent(agentId);
    return this.acpRuntime.respondPermission(agentId, requestId, optionId, cancelled);
  }

  respondToAcpElicitation(agentId: AgentId, requestId: string, action: string, content: unknown) {
    this.assertAgentOperationAdmission();
    this.requireLiveAcpAgent(agentId);
    return this.acpRuntime.respondElicitation(agentId, requestId, action, content);
  }

  requireLiveAcpAgent(agentId: AgentId) {
    const agent = this.agents.get(agentId);
    if (!agent) throw new Error('Agent not found');
    if (!isAcpAgent(agent)) throw new Error('Agent is not using the ACP runtime');
    if (typeof this.acpRuntime.hasBinding === 'function' && !this.acpRuntime.hasBinding(agentId)) {
      const runtime = runtimeBindingOf(agent, 'acp');
      const message = runtime?.error || (
        runtime?.state === 'connecting'
          ? 'ACP Agent is still connecting'
          : 'ACP Agent runtime is unavailable'
      );
      const error: MutableError = new Error(message);
      error.code = 'ACP_RUNTIME_UNAVAILABLE';
      throw error;
    }
    return agent;
  }

  async authenticateAcpAgent(agentId: AgentId, methodId: string) {
    this.assertAgentOperationAdmission();
    this.getAcpSession(agentId);
    await this.reconnectAcpAgent(agentId);
    return this.acpRuntime.authenticate(agentId, methodId);
  }

  async logoutAcpAgent(agentId: AgentId) {
    this.assertAgentOperationAdmission();
    this.getAcpSession(agentId);
    await this.reconnectAcpAgent(agentId);
    return this.acpRuntime.logout(agentId);
  }

  async forkAcpSession(agentId: AgentId, options: AcpForkOptions = {}) {
    this.assertAgentOperationAdmission();
    this.getAcpSession(agentId);
    await this.reconnectAcpAgent(agentId);
    return this.acpRuntime.forkSession(agentId, options);
  }

  async deleteAcpSession(agentId: AgentId, sessionId: string) {
    this.assertAgentOperationAdmission();
    this.getAcpSession(agentId);
    await this.reconnectAcpAgent(agentId);
    return this.acpRuntime.deleteSession(agentId, sessionId);
  }

  async closeAcpSession(agentId: AgentId) {
    this.assertAgentOperationAdmission();
    this.getAcpSession(agentId);
    await this.reconnectAcpAgent(agentId);
    return this.acpRuntime.closeSession(agentId);
  }

  async setAcpSessionMode(agentId: AgentId, modeId: string) {
    this.assertAgentOperationAdmission();
    this.getAcpSession(agentId);
    await this.reconnectAcpAgent(agentId);
    return this.acpRuntime.setSessionMode(agentId, modeId);
  }

  async setAcpSessionConfigOption(agentId: AgentId, configId: string, value: AcpConfigValue) {
    this.assertAgentOperationAdmission();
    this.getAcpSession(agentId);
    await this.reconnectAcpAgent(agentId);
    return this.acpRuntime.setSessionConfigOption(agentId, configId, value);
  }

  async setAcpSessionConfigOptions(agentId: AgentId, changes: AcpConfigChange[]) {
    this.assertAgentOperationAdmission();
    this.getAcpSession(agentId);
    await this.reconnectAcpAgent(agentId);
    return this.acpRuntime.setSessionConfigOptions(agentId, changes);
  }

  async sendInputNow(
    agentId: AgentId,
    input: TerminalInput,
    {
      markUserInput = true,
      expectedRuntimeEpoch = '',
      throwOnUncertain = false,
    }: TerminalInputOptions = {},
  ): Promise<TerminalInputResult | undefined> {
    const agent = this.agents.get(agentId);
    if (!agent) return;
    if (runtimeKind(agent) !== 'terminal') return;
    if (expectedRuntimeEpoch && agent.runtimeEpoch !== expectedRuntimeEpoch) {
      return { status: 'input-rejected', reason: 'runtime-epoch-mismatch' };
    }

    const engine = this.engineBridge.getEngine(agent.engineName);
    if (!engine) return;

    const submittedUserInput = markUserInput && hasSubmittedTerminalInput(input);
    if (
      markUserInput
      && !submittedUserInput
      && hasTerminalDraftInput(input)
    ) {
      agent.terminalDraftInputReceived = true;
    }
    if (submittedUserInput && agent.terminalInputReceived !== true) {
      agent.terminalInputReceived = true;
      this.ensurePersistentAgentSession(agent);
      this.updateEngineProviderSessionMetadata(agent);
      this.emit('agent-update', { agentId, patch: { terminalInputReceived: true } });
    }

    try {
      const result = await engine.sendInput(agentId, input, { expectedRuntimeEpoch });
      if (submittedUserInput) {
        agent.terminalDraftInputReceived = false;
        this.providerSessionService.observe(agentId, { force: true });
      }
      return result;
    } catch (caughtError: unknown) {
      const error = caughtError as ErrorRecord;
      console.error('Failed to send input:', error);
      if (isSessionNotAvailableError(error)) {
        this.markAgentSessionDead(agentId, error);
      }
      if (throwOnUncertain) {
        throw composerAdmissionError(
          `Terminal input may have been accepted, but delivery could not be confirmed: ${error.message || error}`,
          true,
        );
      }
      return;
    }
  }

  markAgentSessionDead(agentId: AgentId, error: unknown): void {
    const agent = this.agents.get(agentId);
    if (!agent || agent.status === 'dead') return;
    const message = error instanceof Error
      ? error.message
      : String(error || 'Session not available');
    agent.status = 'dead';
    agent.engineStatus = 'dead';
    agent.terminalBusy = false;
    agent.exitedAt = Date.now();
    agent.output = trimSessionOutput(`${agent.output || ''}\n${message}`);
    this.providerSessionService.observe(agentId, { force: true });
    this.emitStateChange({ agentIds: [agentId] });
  }

  async interruptAgent(
    agentId: AgentId,
    options: InterruptOptions = {},
  ): Promise<TerminalInputResult | undefined> {
    this.assertAgentOperationAdmission();
    const agent = this.agents.get(agentId);
    if (!agent) return;
    try {
      if (isAcpAgent(agent)) {
        await this.acpRuntime.cancel(agentId);
        return;
      }
      const engine = this.engineBridge.getEngine(agent.engineName);
      if (!engine) return;

      const input = interruptInputForAgent(agent);
      if (engine.interruptSession) {
        return await engine.interruptSession(agentId, input, options);
      } else {
        return await engine.sendInput(agentId, input, options);
      }
    } catch (caughtError: unknown) {
      const error = caughtError as ErrorRecord;
      console.error('Failed to interrupt agent:', error);
      if (isSessionNotAvailableError(error)) {
        this.markAgentSessionDead(agentId, error);
      }
    }
  }

  agentSupportsTerminalInput(agentId: AgentId) {
    const agent = this.agents.get(agentId);
    if (!agent) return false;
    return runtimeKind(agent) === 'terminal';
  }

  agentRuntimeKind(agentId: AgentId) {
    const agent = this.agents.get(agentId);
    return agent ? runtimeKind(agent) : null;
  }

  async getAgentSessionAttachCheckpoint(agentId: AgentId): Promise<TerminalAttachCheckpoint | null> {
    const agent = this.agents.get(agentId);
    if (!agent || runtimeKind(agent) !== 'terminal') {
      return null;
    }
    try {
      return await this.engineBridge.getSessionAttachCheckpoint(agent.engineName, agentId);
    } catch (caughtError: unknown) {
      const error = caughtError as ErrorRecord;
      console.error('Failed to read agent terminal attach checkpoint:', error);
      return null;
    }
  }

  requestAgentSessionResize(agentId: AgentId, cols: number, rows: number): boolean {
    return this.terminalResizeCoordinator.request(agentId, cols, rows);
  }

  async resizeAgentSession(
    agentId: AgentId,
    cols: number,
    rows: number,
  ): Promise<TerminalResizeResult> {
    const agent = this.agents.get(agentId);
    if (!agent) return { status: 'resize-rejected', reason: 'session-unavailable', resized: false };
    if (runtimeKind(agent) !== 'terminal') {
      return { status: 'resize-rejected', reason: 'unsupported-session', resized: false };
    }

    const nextCols = Math.floor(Number(cols));
    const nextRows = Math.floor(Number(rows));
    if (
      !Number.isFinite(nextCols) ||
      !Number.isFinite(nextRows) ||
      nextCols < MIN_TERMINAL_RESIZE_COLS ||
      nextRows < MIN_TERMINAL_RESIZE_ROWS
    ) {
      return { status: 'resize-rejected', reason: 'invalid-dimensions', resized: false };
    }

    try {
      const engine = this.engineBridge.getEngine(agent.engineName);
      if (!engine || !engine.resizeSession) {
        return { status: 'resize-rejected', reason: 'unsupported-engine', resized: false };
      }

      const result = await engine.resizeSession(agentId, nextCols, nextRows);
      if (result && result.resized === false && result.reason === 'session-unavailable') {
        this.markAgentSessionDead(agentId, 'Session not available');
      }
      return result;
    } catch (caughtError: unknown) {
      const error = caughtError as ErrorRecord;
      console.error('Failed to resize agent session:', error);
      return { status: 'resize-rejected', reason: 'resize-failed', resized: false };
    }
  }

  async clearAgentSessionBuffer(
    agentId: AgentId,
    options: ClearTerminalOptions = {},
  ): Promise<TerminalClearResult | { cleared: true }> {
    const agent = this.agents.get(agentId);
    if (!agent) return { cleared: false };
    if (runtimeKind(agent) !== 'terminal') return { cleared: false };
    if (options.expectedRuntimeEpoch && agent.runtimeEpoch !== options.expectedRuntimeEpoch) {
      return { cleared: false, reason: 'runtime-epoch-mismatch' };
    }

    try {
      const engine = this.engineBridge.getEngine(agent.engineName);
      if (!engine || !engine.clearBuffer) return { cleared: false };
      const result = await engine.clearBuffer(agentId, options);
      if (result && result.cleared === false) {
        if (result.reason === 'session-unavailable') {
          this.markAgentSessionDead(agentId, 'Session not available');
        }
        return result;
      }
      // The ordered clear transition is the single metadata writer. Output
      // committed immediately after clear must not be erased by this RPC
      // response path racing the transition stream.
      return result || { cleared: true };
    } catch (caughtError: unknown) {
      const error = caughtError as ErrorRecord;
      console.error('Failed to clear agent session buffer:', error);
      if (isSessionNotAvailableError(error)) {
        this.markAgentSessionDead(agentId, error);
      }
      return { cleared: false, error: error && error.message ? error.message : String(error) };
    }
  }

  renameAgent(agentId: AgentId, title: string): UnknownRecord {
    if (this.disposing) {
      return { error: 'Farming is shutting down; Agent updates are not accepted' };
    }
    const lifecycleOperation = this.agentLifecycleOperations.get(agentId);
    if (lifecycleOperation) {
      return { error: `Agent lifecycle change already in progress: ${lifecycleOperation.label}` };
    }
    const agent = this.agents.get(agentId);
    if (!agent) {
      return { error: 'Agent not found' };
    }

    const customTitle = String(title || '').trim().slice(0, 80);
    const admission: PersistentAgentUpdateAdmission = this.beginPersistentAgentUpdate(
      agent,
      `rename:${customTitle}`,
      { customTitle },
    );
    if ('error' in admission) return { error: `Failed to rename Agent: ${admission.error}` };
    if (admission.deduplicated) {
      return { agentId, customTitle, operationId: admission.operation.id, deduplicated: true };
    }
    const operation = admission.operation;
    if (!operation) return { error: 'Failed to rename Agent: update admission was not created' };
    const staged: AgentRecord = {
      ...agent,
      customTitle,
      lifecycleJournal: lifecycleJournal(agent),
    };
    transitionLifecycleOperation(staged, operation.id, 'succeeded');
    try {
      this.ensurePersistentAgentSession(staged, { customTitle });
    } catch (caughtError: unknown) {
      const error = caughtError as ErrorRecord;
      return {
        error: `Failed to rename Agent: ${error.message || error}`,
        operationId: operation.id,
        retryable: true,
      };
    }
    agent.customTitle = customTitle;
    agent.lifecycleJournal = staged.lifecycleJournal;
    setAgentRecordId(agent, staged.agentRecordId || staged.persistentSessionId || '');
    this.updateEngineProviderSessionMetadata(agent);
    this.emitStateChange({ agentIds: [agentId] });
    return { agentId, customTitle, operationId: operation.id };
  }

  setAgentAdaptiveTitle(
    agentId: AgentId,
    title: string,
  ): UnknownRecord | Promise<UnknownRecord> {
    if (this.disposing) {
      return { error: 'Farming is shutting down; Agent title updates are not accepted' };
    }
    const lifecycleOperation = this.agentLifecycleOperations.get(agentId);
    if (lifecycleOperation) {
      return { error: `Agent lifecycle change already in progress: ${lifecycleOperation.label}` };
    }
    const agent = this.agents.get(agentId);
    if (!agent) return { error: 'Agent not found' };
    if (this.isMainAgentRecord(agentId, agent)) {
      return { error: 'Main Agent keeps its fixed title' };
    }
    if (!agent.agentRecordId && !agent.persistentSessionId) {
      return { error: 'Agent title update requires a persisted Agent session record' };
    }

    const adaptiveTitle = String(title || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    if (!adaptiveTitle) return { error: 'Agent title is required' };
    if (adaptiveTitle === agent.adaptiveTitle) {
      return this.adaptiveTitlePersistence.pendingResult(agentId)
        || { agentId, adaptiveTitle, deduplicated: true };
    }

    const previousTitle = agent.adaptiveTitle || '';
    agent.adaptiveTitle = adaptiveTitle;
    this.emit('agent-update', { agentId, patch: { adaptiveTitle } });
    return this.adaptiveTitlePersistence.schedule(agentId, agent, adaptiveTitle, previousTitle);
  }

  setAgentTask(agentId: AgentId, task: string): UnknownRecord {
    if (this.disposing) {
      return { error: 'Farming is shutting down; Agent updates are not accepted' };
    }
    const lifecycleOperation = this.agentLifecycleOperations.get(agentId);
    if (lifecycleOperation) {
      return { error: `Agent lifecycle change already in progress: ${lifecycleOperation.label}` };
    }
    const agent = this.agents.get(agentId);
    if (!agent) {
      return { error: 'Agent not found' };
    }

    const nextTask = String(task || '').trim().slice(0, 240);
    const admission: PersistentAgentUpdateAdmission = this.beginPersistentAgentUpdate(
      agent,
      `task:${nextTask}`,
      { task: nextTask },
    );
    if ('error' in admission) return { error: `Failed to update Agent task: ${admission.error}` };
    if (admission.deduplicated) {
      return { agentId, task: nextTask, operationId: admission.operation.id, deduplicated: true };
    }
    const operation = admission.operation;
    if (!operation) return { error: 'Failed to update Agent task: update admission was not created' };
    const staged: AgentRecord = {
      ...agent,
      task: nextTask,
      lifecycleJournal: lifecycleJournal(agent),
    };
    transitionLifecycleOperation(staged, operation.id, 'succeeded');
    try {
      this.ensurePersistentAgentSession(staged, { task: nextTask });
    } catch (caughtError: unknown) {
      const error = caughtError as ErrorRecord;
      return {
        error: `Failed to update Agent task: ${error.message || error}`,
        operationId: operation.id,
        retryable: true,
      };
    }
    agent.task = nextTask;
    agent.lifecycleJournal = staged.lifecycleJournal;
    setAgentRecordId(agent, staged.agentRecordId || staged.persistentSessionId || '');
    this.emitStateChange({ agentIds: [agentId] });
    return { agentId, task: nextTask, operationId: operation.id };
  }

  updateAgentFlags(agentId: AgentId, flags: UnknownRecord): UnknownRecord {
    if (this.disposing) {
      return { error: 'Farming is shutting down; Agent updates are not accepted' };
    }
    const lifecycleOperation = this.agentLifecycleOperations.get(agentId);
    if (lifecycleOperation) {
      return { error: `Agent lifecycle change already in progress: ${lifecycleOperation.label}` };
    }
    const agent = this.agents.get(agentId);
    if (!agent) {
      return { error: 'Agent not found' };
    }
    if (flags.archived === true) {
      return { error: 'Use archiveAgent to archive live agents' };
    }

    const persistedFlags: UnknownRecord = {};
    [
      'pinned',
      'unread',
      'archived',
      'readAttentionSeq',
      'readOutputEpoch',
      'readOutputSeq',
    ].forEach((field: string) => {
      if (Object.prototype.hasOwnProperty.call(flags, field)) persistedFlags[field] = flags[field];
    });
    const requestKey = `flags:${JSON.stringify(persistedFlags)}`;
    const activeUpdate = activeLifecycleOperation(agent);
    const needsLifecycleJournal = typeof persistedFlags.pinned === 'boolean'
      || persistedFlags.archived === false
      || (
        activeUpdate?.type === 'update'
        && activeUpdate.requestKey === requestKey
      );
    const admission = needsLifecycleJournal
      ? this.beginPersistentAgentOperation(
          agent,
          'update',
          requestKey,
          persistedFlags,
        )
      : null;
    if (admission && 'error' in admission) {
      return { error: `Failed to update Agent: ${admission.error}` };
    }

    const staged: AgentRecord = {
      ...agent,
      lifecycleJournal: lifecycleJournal(agent),
    };
    const updates: UnknownRecord = {};
    let structuralUpdateChanged = false;
    let readUpdateChanged = false;
    if (typeof flags.pinned === 'boolean') {
      const wasPinned = staged.pinned === true;
      staged.pinned = flags.pinned;
      structuralUpdateChanged = structuralUpdateChanged || wasPinned !== staged.pinned;
      updates.pinned = staged.pinned;
      if (!wasPinned && staged.pinned) {
        staged.pinnedOrder = this.agentOrderAllocator.nextPinnedOrder();
      }
      updates.pinnedOrder = finiteOrder(staged.pinnedOrder);
    }

    if (
      typeof flags.readOutputEpoch === 'string'
      && typeof flags.readOutputSeq === 'number'
      && Number.isFinite(flags.readOutputSeq)
    ) {
      const currentRuntimeEpoch = typeof staged.runtimeEpoch === 'string' ? staged.runtimeEpoch : '';
      const currentOutputSeq = finiteNumberOrNull(staged.lastOutputSeq);
      if (
        currentRuntimeEpoch
        && flags.readOutputEpoch === currentRuntimeEpoch
        && currentOutputSeq !== null
      ) {
        const nextOutputSeq = Math.min(currentOutputSeq, Math.max(0, Math.floor(flags.readOutputSeq)));
        const previousOutputSeq = staged.readOutputEpoch === currentRuntimeEpoch
          ? finiteNumberOrNull(staged.readOutputSeq)
          : null;
        const readOutputSeq = previousOutputSeq === null
          ? nextOutputSeq
          : Math.max(previousOutputSeq, nextOutputSeq);
        readUpdateChanged = readUpdateChanged
          || staged.readOutputEpoch !== currentRuntimeEpoch
          || previousOutputSeq !== readOutputSeq;
        staged.readOutputEpoch = currentRuntimeEpoch;
        staged.readOutputSeq = readOutputSeq;
      }
      updates.readOutputEpoch = typeof staged.readOutputEpoch === 'string' ? staged.readOutputEpoch : '';
      updates.readOutputSeq = finiteNumberOrNull(staged.readOutputSeq);
    }

    if (typeof flags.unread === 'boolean') {
      const previousReadSeq = finiteNonNegativeInteger(staged.readAttentionSeq);
      const previousUnread = staged.unread === true;
      if (flags.unread) {
        if (finiteNonNegativeInteger(staged.attentionSeq) === 0) {
          const now = Date.now();
          staged.attentionSeq = 1;
          staged.attentionUpdatedAt = now;
          staged.attentionReason = 'manual-unread';
          staged.attentionOutputEpoch = typeof staged.runtimeEpoch === 'string' ? staged.runtimeEpoch : '';
          staged.attentionOutputSeq = Number.isFinite(staged.lastOutputSeq) ? staged.lastOutputSeq : null;
          staged.attentionAutoReadNext = false;
        }
        staged.readAttentionSeq = Math.max(0, finiteNonNegativeInteger(staged.attentionSeq) - 1);
      } else {
        staged.readAttentionSeq = finiteNonNegativeInteger(staged.attentionSeq);
      }
      staged.readAttentionAt = Date.now();
      staged.unread = agentAttentionUnread(staged);
      readUpdateChanged = readUpdateChanged
        || previousReadSeq !== staged.readAttentionSeq
        || previousUnread !== staged.unread;
      updates.unread = staged.unread;
      updates.attentionSeq = finiteNonNegativeInteger(staged.attentionSeq);
      updates.readAttentionSeq = finiteNonNegativeInteger(staged.readAttentionSeq);
    }

    if (typeof flags.readAttentionSeq === 'number' && Number.isFinite(flags.readAttentionSeq)) {
      const previousReadSeq = finiteNonNegativeInteger(staged.readAttentionSeq);
      const previousUnread = staged.unread === true;
      const attentionSeq = finiteNonNegativeInteger(staged.attentionSeq);
      staged.readAttentionSeq = Math.min(
        attentionSeq,
        Math.max(previousReadSeq, finiteNonNegativeInteger(flags.readAttentionSeq)),
      );
      staged.readAttentionAt = Date.now();
      staged.unread = agentAttentionUnread(staged);
      readUpdateChanged = readUpdateChanged
        || previousReadSeq !== staged.readAttentionSeq
        || previousUnread !== staged.unread;
      updates.unread = staged.unread;
      updates.attentionSeq = attentionSeq;
      updates.readAttentionSeq = staged.readAttentionSeq;
    }

    if (flags.archived === false) {
      structuralUpdateChanged = structuralUpdateChanged || staged.archived === true || staged.archivedAt !== null;
      staged.archived = false;
      staged.archivedAt = null;
      updates.archived = staged.archived;
      updates.archivedAt = staged.archivedAt;
    }

    if (admission) {
      transitionLifecycleOperation(staged, admission.operation.id, 'succeeded');
    }
    if (!admission && !structuralUpdateChanged && !readUpdateChanged) {
      return {
        agentId,
        ...updates,
        changed: false,
        requiresState: false,
      };
    }
    try {
      this.ensurePersistentAgentSession(staged);
    } catch (caughtError: unknown) {
      const error = caughtError as ErrorRecord;
      return {
        error: `Failed to update Agent: ${error.message || error}`,
        ...(admission ? { operationId: admission.operation.id } : {}),
        retryable: true,
      };
    }
    Object.assign(agent, staged);
    this.agentOrderAllocator.observe(agent);
    if (structuralUpdateChanged || readUpdateChanged) {
      this.updateEngineProviderSessionMetadata(agent);
    }
    if (structuralUpdateChanged) {
      this.emitStateChange({ agentIds: [agentId] });
    } else if (readUpdateChanged) {
      this.emitAgentReadState(agent);
    }
    return {
      agentId,
      ...updates,
      changed: structuralUpdateChanged || readUpdateChanged,
      requiresState: structuralUpdateChanged,
      ...(admission ? { operationId: admission.operation.id } : {}),
    };
  }

  reorderProjectAgent(
    agentId: AgentId,
    { beforeAgentId = '', afterAgentId = '' }: AgentOrderNeighbors = {},
  ) {
    const result = reorderedProjectAgentOrders(
      Array.from(this.agents.values()),
      agentId,
      String(beforeAgentId || ''),
      String(afterAgentId || ''),
    );
    if ('error' in result) return result;
    return this.commitAgentOrderUpdates(agentId, result.updates, 'projectOrder');
  }

  reorderPinnedAgent(
    agentId: AgentId,
    { beforeAgentId = '', afterAgentId = '' }: AgentOrderNeighbors = {},
  ) {
    const result = reorderedPinnedAgentOrders(
      Array.from(this.agents.values()),
      agentId,
      String(beforeAgentId || ''),
      String(afterAgentId || ''),
    );
    if ('error' in result) return result;
    return this.commitAgentOrderUpdates(agentId, result.updates, 'pinnedOrder');
  }

  commitAgentOrderUpdates(
    agentId: AgentId,
    orderUpdates: AgentOrderUpdates,
    field: AgentOrderField,
  ) {
    const updatedAgentIds = [...orderUpdates.keys()];
    const result = commitAgentOrderTransaction({
      agents: this.agents,
      lifecycleOperations: this.agentLifecycleOperations,
      persistAgent: (agent: TypedAgentRecord) => this.ensurePersistentAgentSession(agent),
      updateRuntimeMetadata: (agent: TypedAgentRecord) => this.updateEngineProviderSessionMetadata(agent),
      emitUpdate: () => this.emitStateChange({ agentIds: updatedAgentIds }),
      setAgentRecordId,
      finiteOrder,
    }, agentId, orderUpdates, field);
    if (!result.error) {
      updatedAgentIds.forEach(updatedAgentId => {
        this.agentOrderAllocator.observe(this.agents.get(updatedAgentId));
      });
    } else {
      orderUpdates.forEach((order, updatedAgentId) => {
        const agent = this.agents.get(updatedAgentId);
        if (agent) this.agentOrderAllocator.reserve({ ...agent, [field]: order });
      });
    }
    return result;
  }

  reorderAgent(agentId: AgentId, neighbors: AgentOrderNeighbors = {}) {
    if (this.disposing) {
      return { error: 'Farming is shutting down; Agent updates are not accepted' };
    }
    const lifecycleOperation = this.agentLifecycleOperations.get(agentId);
    if (lifecycleOperation) {
      return { error: `Agent lifecycle change already in progress: ${lifecycleOperation.label}` };
    }
    const agent = this.agents.get(agentId);
    if (!agent) return { error: 'Agent not found' };
    return agent.pinned === true
      ? this.reorderPinnedAgent(agentId, neighbors)
      : this.reorderProjectAgent(agentId, neighbors);
  }

  async syncCodexTerminalPermissionMode(agentId: AgentId, mode: string) {
    const agent = this.agents.get(agentId);
    if (!agent) return { error: 'Agent not found' };
    return this.restartAgentWithPermissionMode(agentId, mode);
  }

  runAgentLifecycleOperation<Result>(
    agentId: AgentId,
    key: string,
    kind: string,
    label: string,
    operation: (token: symbol) => Result,
    sameKindConflictError = '',
  ): Promise<Awaited<Result> | { error: string }> {
    const inFlight = this.agentLifecycleOperations.get(agentId) as AgentLifecycleEntry<Awaited<Result>> | undefined;
    if (inFlight) {
      if (inFlight.key === key) return inFlight.promise;
      if (sameKindConflictError && inFlight.kind === kind) {
        return Promise.resolve({ error: sameKindConflictError });
      }
      return inFlight.promise
        .catch(() => {})
        .then(() => this.runAgentLifecycleOperation(
          agentId,
          key,
          kind,
          label,
          operation,
          sameKindConflictError,
        ));
    }
    if (this.disposing) {
      return Promise.resolve({ error: 'Farming is shutting down; Agent lifecycle changes are not accepted' });
    }

    const token = Symbol(key);
    const promise = Promise.resolve().then(() => operation(token)) as Promise<Awaited<Result>>;
    const entry: AgentLifecycleEntry<Awaited<Result>> = {
      key,
      kind,
      label,
      token,
      promise,
      agentIds: new Set([agentId]),
    };
    this.agentLifecycleOperations.set(agentId, entry);
    void promise.finally(() => {
      for (const ownedAgentId of entry.agentIds) {
        if (this.agentLifecycleOperations.get(ownedAgentId) === entry) {
          this.agentLifecycleOperations.delete(ownedAgentId);
        }
      }
    }).catch(() => {});
    return promise;
  }

  async whenAgentLifecycleIdle(agentId: AgentId) {
    await this.whenRecovered();
    while (true) {
      const inFlight = this.agentLifecycleOperations.get(agentId);
      if (!inFlight) return;
      await inFlight.promise.catch(() => {});
    }
  }

  beginAgentStartLifecycleOperation(
    agentId: AgentId,
    startAdmissionToken: symbol,
  ): (() => void) | null {
    if (this.agentLifecycleOperations.has(agentId)) return null;
    if (this.disposing && !this.agentStartAdmissions.has(startAdmissionToken)) return null;
    let resolveCompletion!: (value: unknown) => void;
    const promise = new Promise<unknown>(resolve => {
      resolveCompletion = resolve;
    });
    const entry: AgentLifecycleEntry<unknown> = {
      key: 'start',
      kind: 'start',
      label: 'start',
      token: Symbol('start'),
      promise,
      agentIds: new Set([agentId]),
    };
    this.agentLifecycleOperations.set(agentId, entry);
    let finished = false;
    return () => {
      if (finished) return;
      finished = true;
      if (this.agentLifecycleOperations.get(agentId) === entry) {
        this.agentLifecycleOperations.delete(agentId);
      }
      resolveCompletion({ agentId, started: true });
    };
  }

  adoptAgentLifecycleOperation(agentId: AgentId, lifecycleToken: symbol | undefined): boolean {
    if (!lifecycleToken) return false;
    const entries = [...new Set(this.agentLifecycleOperations.values())] as AgentLifecycleEntry[];
    const entry = entries.find((candidate: AgentLifecycleEntry) => candidate.token === lifecycleToken);
    if (!entry) return false;
    const existing = this.agentLifecycleOperations.get(agentId);
    if (existing && existing !== entry) return false;
    entry.agentIds.add(agentId);
    this.agentLifecycleOperations.set(agentId, entry);
    return true;
  }

  restartAgentWithPermissionMode(agentId: AgentId, mode: string) {
    return this.runAgentLifecycleOperation(
      agentId,
      `permission-restart:${mode}`,
      'permission-restart',
      'permission restart',
      (token: symbol) => this.performAgentPermissionRestart(agentId, mode, token),
      'Permission change already in progress',
    );
  }

  restartAgentRuntimeMode(agentId: AgentId, mode: unknown): Promise<AgentRestartResult> {
    if (!isAgentRuntimeModeRequest(mode)) {
      return Promise.resolve({ error: 'Unsupported Agent runtime mode' });
    }
    return this.runAgentLifecycleOperation(
      agentId,
      `runtime-switch:${mode}`,
      'runtime-switch',
      'runtime switch',
      (token: symbol) => this.performAgentRuntimeModeRestart(agentId, mode, token),
      'Agent runtime switch already in progress',
    );
  }

  async performAgentRuntimeModeRestart(
    agentId: AgentId,
    mode: AgentRuntimeModeRequest,
    lifecycleToken: symbol,
  ): Promise<AgentRestartResult> {
    if (await this.composerAdmissionCoordinator.whenIdle(agentId)) {
      return { error: 'Composer message delivery finished while the runtime switch was waiting. Retry the runtime switch.' };
    }
    const agent = this.agents.get(agentId);
    if (!agent) return { error: 'Agent not found' };
    const expectedRuntimeBinding = agent.runtimeBinding;
    const expectedRuntimeEpoch = runtimeKind(agent) === 'acp'
      ? String(this.acpRuntime.bindingEpoch(agentId) || '')
      : String(agent.runtimeEpoch || '');
    const provider = agent.providerSessionProvider || '';
    const nextMode = mode === 'acp' && provider === 'codex' ? 'chat' : mode;
    const currentKind = runtimeKind(agent);
    const currentMode = currentKind === 'acp' ? 'chat' : 'terminal';
    const nextRuntimeKind = nextMode === 'chat' ? chatRuntimeForProvider(provider) : nextMode;
    if (currentMode === nextMode) {
      return { agentId, agentRuntimeMode: nextMode };
    }
    const turnActive = currentKind === 'acp'
      ? ['working', 'waiting-for-permission', 'interrupting'].includes(
          runtimeBindingOf(agent, 'acp')?.state || '',
        )
      : this.isAgentAttentionTurnActive(agent);
    if (turnActive) {
      return { error: 'Interrupt the active Agent turn before switching Chat and Terminal.' };
    }
    const supportsNextMode = nextMode === 'chat'
      ? providerCapabilities(provider).supportsChat === true
      : providerSupportsRuntime(provider, nextMode);
    if (!supportsNextMode) {
      return { error: `Agent does not support the ${nextMode.toUpperCase()} runtime` };
    }
    const sessionId = String(agent.providerSessionId || '').trim();
    const canStartFreshChatSession = nextMode === 'chat'
      && currentMode === 'terminal'
      && agent.terminalInputReceived !== true
      && (
        agent.providerSessionTemporary === true
        || isFreshAcpSessionSource(provider, agent.providerSessionSource || '')
      );
    if (!isSafeProviderSessionId(sessionId) && !canStartFreshChatSession) {
      return { error: 'Runtime switching requires a resumable provider session. Send the first message and try again.' };
    }
    // A live ACP binding is the authoritative owner of a newly-created
    // provider session. Provider history indexes can lag behind that binding
    // (and some adapters persist only while closing), so requiring an
    // immediate filesystem/history hit makes Chat -> Terminal spuriously
    // fail. Historical/terminal sessions still use the provider lookup as a
    // stale-session guard.
    let liveAcpSession = false;
    if (currentKind === 'acp' && this.acpRuntime && typeof this.acpRuntime.getSession === 'function') {
      try {
        const snapshot = this.acpRuntime.getSession(agentId, { maxEntries: 0 });
        liveAcpSession = String(snapshot?.sessionId || '') === sessionId;
      } catch {
        liveAcpSession = false;
      }
    }
    const previouslyVerifiedSession = String(agent.runtimeSwitchVerifiedSessionId || '') === sessionId;
    let startsFreshChatSession = canStartFreshChatSession && !isSafeProviderSessionId(sessionId);
    if (!startsFreshChatSession && !liveAcpSession && !previouslyVerifiedSession) {
      const providerSession = await this.findRuntimeSwitchSession(agent);
      if (!providerSession) {
        if (canStartFreshChatSession) startsFreshChatSession = true;
        else return { error: 'The saved Agent session is no longer available in the selected Agent Home.' };
      }
    }
    const command = startsFreshChatSession
      ? (agent.forkCommand || agent.command)
      : buildAgentSessionResumeCommand(provider, sessionId, {
          cwd: effectiveAgentWorkspaceRoot(agent),
          providerHomePath: agent.providerHomePath || '',
        });
    if (!command) return { error: 'Failed to build provider resume command' };
    const preserved = {
      pinned: agent.pinned === true,
      projectOrder: finiteOrder(agent.projectOrder),
      pinnedOrder: finiteOrder(agent.pinnedOrder),
      customTitle: agent.customTitle || '',
      adaptiveTitle: agent.adaptiveTitle || '',
      unread: agent.unread === true,
    };
    let acpSessionOptions: AcpSessionRequestOptions = {
      cwd: effectiveAgentWorkspaceRoot(agent),
      additionalDirectories: [],
      mcpServers: [],
    };
    if (currentKind === 'acp' && this.acpRuntime?.getSessionRequestOptions) {
      try {
        acpSessionOptions = this.acpRuntime.getSessionRequestOptions(agentId);
      } catch {
        acpSessionOptions = {
          cwd: effectiveAgentWorkspaceRoot(agent),
          additionalDirectories: [],
          mcpServers: [],
        };
      }
    }
    const acpConfigOverrides = cloneAcpConfigOverrides(
      agent.providerSessionKey
        ? this.acpSessionOptionsByKey.get(agent.providerSessionKey)?.configOverrides
        : [],
    );
    const restartOptions: ProviderStartOptions = {
      wantsMain: agent.wantsMain === true,
      task: agent.task || agent.providerSessionTitle || '',
      workflowTemplate: agent.workflowTemplate || '',
      projectWorkspace: effectiveAgentWorkspaceRoot(agent),
      source: startsFreshChatSession
        ? 'ui-runtime-switch-fresh'
        : resumedAgentSource(provider, sessionId, agent.providerHomeId || ''),
      providerHomeId: agent.providerHomeId || '',
      providerHomePath: agent.providerHomePath || '',
      acpRuntimeMode: agent.acpRuntimeMode === 'custom' ? 'custom' : 'managed',
      acpRuntimeExecutable: agent.acpRuntimeExecutable || '',
      providerSessionTitle: agent.providerSessionTitle || '',
      adaptiveTitle: agent.adaptiveTitle || '',
      agentRecordId: agent.agentRecordId || agent.persistentSessionId || '',
      restoreRuntimeAgentIdOnFailure: agentId,
      restartedFromAgentId: agentId,
      restartedFromAgentIds: Array.from(new Set([
        ...(Array.isArray(agent.restartedFromAgentIds) ? agent.restartedFromAgentIds : []),
        ...(agent.restartedFromAgentId ? [agent.restartedFromAgentId] : []),
        agentId,
      ])),
      projectOrder: preserved.projectOrder,
      pinnedOrder: preserved.pinnedOrder,
      composerCommands: normalizedComposerCommands(agent.composerCommands),
      providerSessionMaterialized: agent.providerSessionMaterialized !== false,
      agentRuntimeMode: nextMode,
      acpStartFresh: startsFreshChatSession && nextRuntimeKind === 'acp',
      codexApprovalMode: agent.launchPermissionMode || undefined,
      runtimeSwitchVerifiedSessionId: startsFreshChatSession ? '' : sessionId,
      lifecycleToken,
      ...acpSessionOptions,
      acpConfigOverrides,
      ...(provider === 'codex' && !startsFreshChatSession
        ? preserveCodexSessionProfileOptions()
        : {}),
    };
    const originalMode = currentMode;
    const originalOptions: ProviderStartOptions = {
      ...restartOptions,
      agentRuntimeMode: originalMode,
      acpStartFresh: false,
    };
    const startReplacement = (options: ProviderStartOptions): Promise<RuntimeReplacementResult> => new Promise((resolve) => {
      let settled = false;
      const finish = (restartedAgentId: string | null | undefined, error: unknown) => {
        if (settled) return;
        settled = true;
        resolve({
          restartedAgentId: restartedAgentId || '',
          error: error instanceof Error ? error.message : String(error || ''),
        });
      };
      try {
        const started = this.startAgent(
          command,
          effectiveAgentWorkspaceRoot(agent) || null,
          (restartedAgentId: string | null, error?: string | null) => finish(restartedAgentId, error),
          options
        );
        Promise.resolve(started).catch((error: unknown) => finish(
          '',
          error instanceof Error ? error.message : 'Failed to start Agent',
        ));
      } catch (caughtError: unknown) {
      const error = caughtError as ErrorRecord;
        finish('', error?.message || 'Failed to start Agent');
      }
    });
    const restorePreservedState = (restartedAgentId: string): void => {
      const replacement = this.agents.get(restartedAgentId);
      if (!replacement) return;
      Object.assign(replacement, preserved);
      this.ensurePersistentAgentSession(replacement);
    };
    const currentRuntimeEpoch = currentKind === 'acp'
      ? String(this.acpRuntime.bindingEpoch(agentId) || '')
      : String(this.agents.get(agentId)?.runtimeEpoch || '');
    if (
      this.agents.get(agentId) !== agent
      || agent.runtimeBinding !== expectedRuntimeBinding
      || currentRuntimeEpoch !== expectedRuntimeEpoch
    ) {
      return { error: 'Agent runtime changed while preparing the runtime switch. Retry the runtime switch.' };
    }
    const killResult = await this.killAgent(agentId, {
      reason: 'runtime-switch',
      recordHistory: false,
      emitUpdate: false,
      lifecycleToken,
      persistDeleteOperation: false,
    });
    if (killResult?.error) return killResult;
    const switched = await startReplacement(restartOptions);
    if (switched.restartedAgentId && !switched.error) {
      restorePreservedState(switched.restartedAgentId);
      this.emitStateChange({ agentIds: [agentId, switched.restartedAgentId] });
      return {
        agentId,
        restarted: true,
        restartedAgentId: switched.restartedAgentId,
        agentRuntimeMode: nextMode,
      };
    }
    if (switched.restartedAgentId && this.agents.has(switched.restartedAgentId)) {
      const cleanup = await this.killAgent(switched.restartedAgentId, {
          reason: 'runtime-switch-start-failed',
          recordHistory: false,
          emitUpdate: false,
          lifecycleToken,
      });
      if (cleanup?.error) {
        this.emitStateChange({ agentIds: [agentId, switched.restartedAgentId] });
        return {
          agentId,
          restartedAgentId: switched.restartedAgentId,
          cleanupUncertain: true,
          error: `${switched.error || 'Failed to switch Agent runtime'} Replacement cleanup could not be verified: ${cleanup.error}`,
        };
      }
    }

    const restored = await startReplacement(originalOptions);
    if (restored.restartedAgentId && !restored.error) {
      restorePreservedState(restored.restartedAgentId);
      this.emitStateChange({ agentIds: [agentId, restored.restartedAgentId] });
      return {
        agentId,
        restarted: true,
        restartedAgentId: restored.restartedAgentId,
        agentRuntimeMode: originalMode,
        switchFailed: true,
        warning: `${switched.error || 'Failed to switch Agent runtime'} Original runtime restored.`,
      };
    }
    let restoreCleanupError = '';
    if (restored.restartedAgentId && this.agents.has(restored.restartedAgentId)) {
      const cleanup = await this.killAgent(restored.restartedAgentId, {
        reason: 'runtime-switch-restore-failed',
        recordHistory: false,
        emitUpdate: false,
        lifecycleToken,
      });
      restoreCleanupError = cleanup?.error || '';
    }
    this.emitStateChange({
      agentIds: [agentId, switched.restartedAgentId, restored.restartedAgentId].filter(
        (value): value is string => typeof value === 'string' && value.length > 0,
      ),
    });
    return {
      ...(restoreCleanupError
        ? { restartedAgentId: restored.restartedAgentId, cleanupUncertain: true }
        : {}),
      error: `${switched.error || 'Failed to switch Agent runtime'} Restore also failed: ${
        restored.error || 'unknown error'
      }${restoreCleanupError ? ` Cleanup could not be verified: ${restoreCleanupError}` : ''}`,
    };
  }

  findRuntimeSwitchSession(agent: TypedAgentRecord) {
    const provider = agent.providerSessionProvider || '';
    const providerHomeId = agent.providerHomeId || 'default';
    const providerHomePath = agent.providerHomePath || '';
    return findAgentSession(agent.providerSessionProvider, agent.providerSessionId, {
      limit: 1000,
      providerLimit: 1000,
      scanLimit: 5000,
      providerHomeId,
      providerHomes: providerHomePath
        ? { [provider]: [{ id: providerHomeId, path: providerHomePath }] }
        : undefined,
    });
  }

  async performAgentPermissionRestart(
    agentId: AgentId,
    mode: string,
    lifecycleToken: symbol,
  ): Promise<AgentRestartResult> {
    const agent = this.agents.get(agentId);
    if (!agent) {
      return { error: 'Agent not found' };
    }

    const sourceSession = resumedSessionFromSource(String(agent.source || ''));
    const provider = agent.providerSessionProvider || (sourceSession && sourceSession.provider) || '';
    const providerHomeId = agent.providerHomeId || (sourceSession && sourceSession.providerHomeId) || '';
    const sessionId = agent.providerSessionTemporary === true
      ? (sourceSession && sourceSession.sessionId)
      : (agent.providerSessionId || (sourceSession && sourceSession.sessionId) || '');

    if (!['codex', 'claude'].includes(provider)) {
      return { error: 'Agent does not support permission restart' };
    }

    const nextMode = provider === 'codex'
      ? (['ask', 'approve', 'full', 'custom'].includes(mode) ? mode : '')
      : (['acceptEdits', 'auto', 'bypassPermissions', 'default', 'dontAsk', 'plan'].includes(mode) ? mode : '');
    if (!nextMode) {
      return { error: `Unsupported ${provider === 'codex' ? 'Codex' : 'Claude'} permission mode` };
    }

    const hasResumableSession = isSafeProviderSessionId(sessionId);
    const startsFreshCodexSession = provider === 'codex'
      && !hasResumableSession
      && (agent.providerSessionTemporary === true || !String(agent.providerSessionId || '').trim());
    if (startsFreshCodexSession && agent.terminalInputReceived === true) {
      return { error: 'Permission changes require a resumable provider session. Try again after the session id is available.' };
    }
    if (!hasResumableSession && !startsFreshCodexSession) {
      return { error: 'Permission changes require a resumable provider session. Try again after the session id is available.' };
    }
    const command = startsFreshCodexSession
      ? 'codex'
      : buildAgentSessionResumeCommand(provider, sessionId, {
        cwd: effectiveAgentWorkspaceRoot(agent),
        providerHomePath: agent.providerHomePath || '',
      });
    if (!command) {
      return { error: 'Failed to build provider resume command' };
    }

    let acpSessionOptions: AcpSessionRequestOptions = {
      cwd: effectiveAgentWorkspaceRoot(agent),
      additionalDirectories: [],
      mcpServers: [],
    };
    if (isAcpAgent(agent) && this.acpRuntime?.getSessionRequestOptions) {
      try {
        acpSessionOptions = this.acpRuntime.getSessionRequestOptions(agentId);
      } catch {
        acpSessionOptions = {
          cwd: effectiveAgentWorkspaceRoot(agent),
          additionalDirectories: [],
          mcpServers: [],
        };
      }
    }
    const acpConfigOverrides = cloneAcpConfigOverrides(
      agent.providerSessionKey
        ? this.acpSessionOptionsByKey.get(agent.providerSessionKey)?.configOverrides
        : [],
    );
    const restartOptions: ProviderStartOptions = {
      wantsMain: agent.wantsMain === true,
      task: agent.task || agent.providerSessionTitle || '',
      workflowTemplate: agent.workflowTemplate || '',
      requiredCliVersion: provider === 'codex' && typeof agent.requiredCliVersion === 'string'
        ? agent.requiredCliVersion
        : '',
      projectWorkspace: effectiveAgentWorkspaceRoot(agent),
      source: startsFreshCodexSession
        ? 'ui'
        : (resumedSessionFromSource(String(agent.source || ''))
          ? String(agent.source || '')
          : resumedAgentSource(provider, sessionId, providerHomeId)),
      providerHomeId,
      providerHomePath: agent.providerHomePath || '',
      providerSessionTitle: agent.providerSessionTitle || '',
      adaptiveTitle: agent.adaptiveTitle || '',
      agentRecordId: agent.agentRecordId || agent.persistentSessionId || '',
      restoreRuntimeAgentIdOnFailure: agentId,
      restartedFromAgentId: agentId,
      restartedFromAgentIds: Array.from(new Set([
        ...(Array.isArray(agent.restartedFromAgentIds) ? agent.restartedFromAgentIds : []),
        ...(agent.restartedFromAgentId ? [agent.restartedFromAgentId] : []),
        agentId,
      ])),
      projectOrder: finiteOrder(agent.projectOrder),
      pinnedOrder: finiteOrder(agent.pinnedOrder),
      composerCommands: normalizedComposerCommands(agent.composerCommands),
      providerSessionMaterialized: agent.providerSessionMaterialized !== false,
      lifecycleToken,
      ...acpSessionOptions,
      acpConfigOverrides,
      ...(provider === 'codex' ? { codexApprovalMode: nextMode } : { claudePermissionMode: nextMode }),
      ...(provider === 'codex' && hasResumableSession
        ? preserveCodexSessionProfileOptions()
        : {}),
    };
    const preserved = {
      pinned: agent.pinned === true,
      projectOrder: finiteOrder(agent.projectOrder),
      pinnedOrder: finiteOrder(agent.pinnedOrder),
      customTitle: agent.customTitle || '',
      adaptiveTitle: agent.adaptiveTitle || '',
      unread: agent.unread === true,
      attentionSeq: finiteNonNegativeInteger(agent.attentionSeq),
      readAttentionSeq: finiteNonNegativeInteger(agent.readAttentionSeq),
    };

    const killResult = await this.killAgent(agentId, {
      reason: 'permission-restart',
      recordHistory: false,
      emitUpdate: false,
      lifecycleToken,
      persistDeleteOperation: false,
    });
    if (killResult?.error) return killResult;

    return new Promise<AgentRestartResult>((resolve) => {
      const startResult = this.startAgent(command, effectiveAgentWorkspaceRoot(agent) || null, (restartedAgentId: string | null, error?: string | null) => {
        if (error) {
          this.emitStateChange({ agentIds: [agentId] });
          resolve({ error });
          return;
        }
        if (!restartedAgentId) {
          this.emitStateChange({ agentIds: [agentId] });
          resolve({ error: 'Failed to restart agent with updated permissions' });
          return;
        }

        const restartedAgent = this.agents.get(restartedAgentId);
        if (restartedAgent) {
          restartedAgent.pinned = preserved.pinned;
          restartedAgent.projectOrder = preserved.projectOrder;
          restartedAgent.pinnedOrder = preserved.pinnedOrder;
          restartedAgent.customTitle = preserved.customTitle;
          restartedAgent.adaptiveTitle = preserved.adaptiveTitle;
          restartedAgent.unread = preserved.unread;
          restartedAgent.attentionSeq = preserved.attentionSeq;
          restartedAgent.readAttentionSeq = preserved.readAttentionSeq;
          restartedAgent.launchPermissionMode = nextMode;
          this.updateEngineProviderSessionMetadata(restartedAgent);
          this.ensurePersistentAgentSession(restartedAgent, {
            pinned: restartedAgent.pinned,
            projectOrder: restartedAgent.projectOrder,
            pinnedOrder: restartedAgent.pinnedOrder,
            customTitle: restartedAgent.customTitle,
            adaptiveTitle: restartedAgent.adaptiveTitle,
            unread: restartedAgent.unread,
            attentionSeq: restartedAgent.attentionSeq,
            readAttentionSeq: restartedAgent.readAttentionSeq,
            launchPermissionMode: nextMode,
          });
        }
        this.emitStateChange({ agentIds: [agentId, restartedAgentId] });
        resolve({
          agentId,
          restarted: true,
          restartedAgentId,
          launchPermissionMode: nextMode,
        });
      }, restartOptions);
      Promise.resolve(startResult).catch((error: unknown) => {
        this.emitStateChange({ agentIds: [agentId] });
        resolve({
          error: error instanceof Error
            ? error.message
            : 'Failed to restart agent with updated permissions',
        });
      });
    });
  }

  setAgentUnread(agentId: AgentId, unread: boolean) {
    return unread === true
      ? this.markAgentUnreadCursor(agentId)
      : this.markAgentReadCursor(agentId);
  }

  persistentProjectOperation(
    requestId: string,
    type: ProjectOperationType,
    signature: string,
    request: ProjectOperationRequest,
  ) {
    if (
      !requestId
      || typeof this.configManager?.getProjectOperation !== 'function'
      || typeof this.configManager?.commitProjectOperation !== 'function'
    ) {
      return { operation: null, created: true };
    }
    const existing = this.configManager.getProjectOperation(requestId);
    if (existing) {
      if (existing.type !== type || existing.signature !== signature) {
        return { error: `Project operation request ${requestId} was already used for different parameters` };
      }
      return { operation: existing, created: false };
    }
    const operation: ProjectOperation = {
      id: requestId,
      type,
      state: 'pending',
      signature,
      request,
      result: null,
      error: '',
      startedAt: Date.now(),
      updatedAt: Date.now(),
      finishedAt: null,
    };
    try {
      this.configManager.commitProjectOperation(operation);
      return { operation, created: true };
    } catch (caughtError: unknown) {
      const error = caughtError as ErrorRecord;
      return { error: `Failed to persist Project operation intent: ${error.message || error}` };
    }
  }

  commitPersistentProjectOperation(
    operation: ProjectOperation | null,
    state: ProjectOperationState,
    result: ProjectOperationResult | null = null,
    error = '',
    membership: ProjectMembershipPatch = {},
  ) {
    if (!operation || typeof this.configManager?.commitProjectOperation !== 'function') {
      return { operation: null, projectWorkspaces: null, pinnedProjectWorkspaces: null };
    }
    const terminal = ['succeeded', 'failed', 'blocked'].includes(state);
    const nextOperation: ProjectOperation = {
      ...operation,
      state,
      result,
      error,
      updatedAt: Date.now(),
      finishedAt: terminal ? Date.now() : null,
    };
    return this.configManager.commitProjectOperation(nextOperation, membership);
  }

  async listGitWorktrees(sourceWorkspace: string) {
    return this.worktreeGitService.listWorktrees(sourceWorkspace);
  }

  async inspectGitWorktreePostcondition(sourceWorkspace: string, workspace: string, branch: string = '') {
    return this.worktreeGitService.inspectPostcondition(sourceWorkspace, workspace, branch);
  }

  async resolveGitWorktreeSourceRoot(workspace: string) {
    const sourceWorkspace = this.expandWorkspacePath(workspace);
    return this.worktreeGitService.resolveSourceRoot(sourceWorkspace);
  }

  async createForkWorktreeIdentity(
    workspace: string,
    beforeEffect?: (identity: TemporaryWorktreeIdentity) => Promise<void> | void,
  ): Promise<TemporaryWorktreeIdentity> {
    const root = await this.resolveGitWorktreeSourceRoot(workspace);
    const identity = await this.worktreeGitService.allocateTemporaryWorktree(root);
    try {
      await beforeEffect?.(identity);
    } catch (error) {
      this.worktreeGitService.releaseTemporaryWorktreeReservation(identity);
      throw error;
    }
    let mutation;
    try {
      mutation = await this.worktreeGitService.createTemporaryWorktree(identity);
    } catch (caughtError: unknown) {
      const error = caughtError as ErrorRecord;
      let postcondition;
      try {
        postcondition = await this.worktreeGitService.inspectPostcondition(
          identity.sourceWorkspace,
          identity.workspace,
        );
      } catch (caughtInspectionError: unknown) {
        const inspectionError = caughtInspectionError as ErrorRecord;
        postcondition = {
          proven: false,
          exists: false,
          registered: false,
          error: inspectionError.message || String(inspectionError),
        };
      }
      const exactAbsence = postcondition.proven
        && !postcondition.exists
        && !postcondition.registered;
      const failure = new Error(
        exactAbsence
          ? error.message || 'Failed to create git worktree'
          : `${error.message || 'Failed to create git worktree'}; the temporary worktree outcome is uncertain`,
        { cause: error },
      ) as Error & { uncertain?: boolean };
      if (!exactAbsence) failure.uncertain = true;
      throw failure;
    }
    const { postcondition } = mutation;
    if (postcondition.proven && postcondition.exists && postcondition.registered) {
      return mutation.identity;
    }
    if (mutation.commandFailure) {
      const exactAbsence = postcondition.proven && !postcondition.exists && !postcondition.registered;
      const detail = exactAbsence
        ? mutation.commandFailure.message
        : `${mutation.commandFailure.message}; the temporary worktree outcome is uncertain`;
      const failure = new Error(detail, { cause: mutation.commandFailure.cause }) as Error & {
        uncertain?: boolean;
      };
      if (!exactAbsence) failure.uncertain = true;
      throw failure;
    }
    const detail = postcondition.error || 'Temporary worktree creation could not be proven';
    const failure = new Error(`${detail}; the operation outcome is uncertain`) as Error & {
      uncertain?: boolean;
    };
    failure.uncertain = true;
    throw failure;
  }

  async createForkWorktree(workspace: string) {
    return (await this.createForkWorktreeIdentity(workspace)).workspace;
  }

  async rollbackTemporaryForkWorktree(identity: TemporaryWorktreeIdentity) {
    try {
      return await this.worktreeGitService.rollbackTemporaryWorktree(identity);
    } catch (caughtError: unknown) {
      const error = caughtError as ErrorRecord;
      return {
        rolledBack: false,
        error: error.message || 'Temporary Fork worktree rollback could not be proven',
        retainedWorkspace: identity.workspace,
        uncertain: true,
      };
    }
  }

  createPermanentWorktree(workspace: string, options: CreatePermanentWorktreeOptions = {}) {
    const requestId = String(options.requestId || '').trim().slice(0, 160);
    if (!requestId) return this.createPermanentWorktreeAdmitted(workspace, options);
    const workspaceKey = canonicalWorkspacePath(this.expandWorkspacePath(workspace));
    const current = this.projectOperationAdmissions.get(requestId);
    if (current) {
      if (current.workspaceKey === workspaceKey) return current.promise;
      return Promise.reject(new Error(`Project operation request ${requestId} was already used for different parameters`));
    }
    const promise = this.createPermanentWorktreeAdmitted(workspace, options);
    const admission: ProjectOperationAdmission<Awaited<typeof promise>> = { workspaceKey, promise };
    this.projectOperationAdmissions.set(requestId, admission);
    void promise.finally(() => {
      if (this.projectOperationAdmissions.get(requestId) === admission) {
        this.projectOperationAdmissions.delete(requestId);
      }
    }).catch(() => {});
    return promise;
  }

  async createPermanentWorktreeAdmitted(
    workspace: string,
    options: CreatePermanentWorktreeOptions = {},
  ): Promise<CreatePermanentWorktreeResult | UnknownRecord> {
    const root = await this.resolveGitWorktreeSourceRoot(workspace);
    const requestId = String(options.requestId || '').trim().slice(0, 160);
    const signature = projectOperationSignature({ sourceWorkspace: root, type: 'create-worktree' });
    const existingOperation = requestId && typeof this.configManager?.getProjectOperation === 'function'
      ? this.configManager.getProjectOperation(requestId)
      : null;
    const operationWasExisting = Boolean(existingOperation);
    if (
      existingOperation
      && (
        existingOperation.type !== 'create-worktree'
        || existingOperation.signature !== signature
      )
    ) {
      throw new Error(`Project operation request ${requestId} was already used for different parameters`);
    }
    if (existingOperation?.state === 'succeeded' && existingOperation.result) {
      const settings = this.configManager?.getSettings();
      return {
        ...existingOperation.result,
        deduplicated: true,
        projectWorkspaces: settings?.projectWorkspaces || [],
        pinnedProjectWorkspaces: settings?.pinnedProjectWorkspaces || [],
      };
    }

    let target = String(existingOperation?.request?.workspace || '');
    let branch = String(existingOperation?.request?.branch || '');
    let operation = existingOperation;
    let reservedIdentity: Awaited<ReturnType<WorktreeGitServicePort['allocatePermanentWorktree']>> | null = null;
    if (!operation) {
      const identity = await this.worktreeGitService.allocatePermanentWorktree(root);
      reservedIdentity = identity;
      target = identity.workspace;
      branch = identity.branch;
      try {
        const admission = this.persistentProjectOperation(requestId, 'create-worktree', signature, {
          sourceWorkspace: root,
          workspace: target,
          branch,
        });
        if ('error' in admission) throw new Error(admission.error);
        operation = admission.operation || null;
      } catch (caught) {
        this.worktreeGitService.releasePermanentWorktreeReservation(identity);
        throw caught;
      }
    }

    const commitSuccess = () => {
      const result: UnknownRecord = { workspace: target, branch, sourceWorkspace: root, ...(requestId ? { requestId } : {}) };
      if (!operation) return result;
      const committed = this.commitPersistentProjectOperation(
        operation,
        'succeeded',
        result,
        '',
        { mountWorkspace: target },
      );
      return {
        ...result,
        projectWorkspaces: committed.projectWorkspaces,
        pinnedProjectWorkspaces: committed.pinnedProjectWorkspaces,
      };
    };

    if (operation && !['pending', 'unknown'].includes(operation.state)) {
      if (reservedIdentity) this.worktreeGitService.releasePermanentWorktreeReservation(reservedIdentity);
      throw new Error(operation.error || `Project operation ${requestId} already finished with state ${operation.state}`);
    }
    if (operation && operationWasExisting) {
      const postcondition = await this.inspectGitWorktreePostcondition(root, target, branch);
      if (
        postcondition.proven
        && postcondition.exists
        && postcondition.registered
        && postcondition.branchMatches
        && postcondition.branchExists
      ) {
        return commitSuccess();
      }
      if (operation.state === 'unknown') {
        throw new Error(operation.error || 'Permanent worktree creation has an uncertain outcome and will not be replayed automatically');
      }
      if (
        !postcondition.proven
        || postcondition.exists
        || postcondition.registered
        || postcondition.branchExists
      ) {
        const detail = postcondition.error || 'Permanent worktree creation has a partial or unverifiable result';
        this.commitPersistentProjectOperation(operation, 'unknown', null, detail);
        throw new Error(`${detail}; the operation will not be replayed automatically`);
      }
    }

    const mutation = await this.worktreeGitService.createPermanentWorktree(reservedIdentity || {
      sourceWorkspace: root,
      workspace: target,
      branch,
    });
    const postcondition = mutation.postcondition;
    if (
      postcondition.proven
      && postcondition.exists
      && postcondition.registered
      && postcondition.branchMatches
      && postcondition.branchExists
    ) {
      return commitSuccess();
    }
    if (mutation.commandFailure) {
      const detail = mutation.commandFailure.message;
      if (operation) {
        const state = postcondition.proven
          && !postcondition.exists
          && !postcondition.registered
          && !postcondition.branchExists
          ? 'failed'
          : 'unknown';
        this.commitPersistentProjectOperation(operation, state, null, detail);
      }
      throw new Error(detail, { cause: mutation.commandFailure.cause });
    }
    if (
      !postcondition.proven
      || !postcondition.exists
      || !postcondition.registered
      || !postcondition.branchMatches
      || !postcondition.branchExists
    ) {
      const detail = postcondition.error || 'Permanent worktree creation could not be proven';
      if (operation) this.commitPersistentProjectOperation(operation, 'unknown', null, detail);
      throw new Error(`${detail}; the operation will not be replayed automatically`);
    }
    return commitSuccess();
  }

  async rollbackPermanentWorktree(
    created: Pick<CreatePermanentWorktreeResult, 'workspace' | 'sourceWorkspace'> & { branch?: string },
  ) {
    if (!created?.workspace || !created?.sourceWorkspace) {
      return { rolledBack: true };
    }
    return this.worktreeGitService.rollbackPermanentWorktree({
      sourceWorkspace: created.sourceWorkspace,
      workspace: created.workspace,
      branch: created.branch || '',
    });
  }

  async inspectForkWorktreeProject(workspace: string) {
    const expanded = this.expandWorkspacePath(workspace);
    return this.worktreeGitService.inspectForkWorktree(expanded);
  }

  agentsForProjectWorkspace(workspace: string): TypedAgentRecord[] {
    const resolvedWorkspace = path.resolve(workspace);
    return Array.from(this.agents.values())
      .filter((value: unknown): value is TypedAgentRecord => isRecord(value) && typeof value.id === 'string')
      .filter((agent: TypedAgentRecord) => {
      if (!agent || agent.isMain) return false;
      const agentWorkspace = this.expandWorkspacePath(effectiveAgentWorkspaceRoot(agent));
      if (!agentWorkspace) return false;
      return path.resolve(agentWorkspace) === resolvedWorkspace;
      });
  }

  removeMainPageProviderSessionsForAgents(agents: readonly TypedAgentRecord[]): string[] {
    if (!this.configManager) {
      return [];
    }

    const keysToRemove = new Set<string>();
    agents.forEach((agent: TypedAgentRecord) => {
      const providerSessionKey = canonicalProviderSessionKey(agent.providerSessionKey) || mainPageAgentSessionKey(
        agent.providerSessionProvider,
        agent.providerSessionId,
        agent.providerHomeId || ''
      );
      if (providerSessionKey) keysToRemove.add(providerSessionKey);
    });
    if (keysToRemove.size === 0) return [];

    const currentKeys = this.getMainPageSessionKeys();
    const removedKeys = currentKeys.filter((key: string) => keysToRemove.has(key));
    if (removedKeys.length === 0) return [];
    if (typeof this.configManager.removeMainPageSessionKeys === 'function') {
      this.configManager.removeMainPageSessionKeys(removedKeys);
    } else {
      const nextKeys = currentKeys.filter((key: string) => !keysToRemove.has(key));
      this.setMainPageSessionKeys(nextKeys);
    }
    return removedKeys;
  }

  deleteForkWorktreeProject(
    workspace: string,
    options: DeleteProjectWorktreeOptions = {},
  ): Promise<DeleteProjectWorktreeResult | UnknownRecord> {
    const workspaceKey = canonicalWorkspacePath(this.expandWorkspacePath(workspace));
    if (!workspaceKey) return this.deleteForkWorktreeProjectAdmitted(workspace, options);
    const inFlight = this.projectWorkspaceDeleteAdmissions.get(workspaceKey);
    const requestId = String(options.requestId || '').trim();
    if (inFlight) {
      if (requestId && inFlight.requestId === requestId) return inFlight.promise;
      return inFlight.promise
        .catch(() => {})
        .then(() => this.deleteForkWorktreeProject(workspace, options));
    }

    const promise = this.deleteForkWorktreeProjectAdmitted(workspace, options);
    const admission: ProjectWorkspaceDeleteAdmission<Awaited<typeof promise>> = { requestId, promise };
    this.projectWorkspaceDeleteAdmissions.set(workspaceKey, admission);
    void promise.finally(() => {
      if (this.projectWorkspaceDeleteAdmissions.get(workspaceKey) === admission) {
        this.projectWorkspaceDeleteAdmissions.delete(workspaceKey);
      }
    }).catch(() => {});
    return promise;
  }

  async deleteForkWorktreeProjectAdmitted(
    workspace: string,
    options: DeleteProjectWorktreeOptions = {},
  ): Promise<DeleteProjectWorktreeResult | UnknownRecord> {
    await this.whenRecovered();
    const workspaceKey = canonicalWorkspacePath(this.expandWorkspacePath(workspace));
    const requestId = String(options.requestId || '').trim().slice(0, 160);
    const signature = projectOperationSignature({
      force: options.force === true,
      type: 'delete-worktree',
      workspace: workspaceKey,
    });
    const existingOperation = requestId && typeof this.configManager?.getProjectOperation === 'function'
      ? this.configManager.getProjectOperation(requestId)
      : null;
    if (
      existingOperation
      && (
        existingOperation.type !== 'delete-worktree'
        || existingOperation.signature !== signature
      )
    ) {
      return { workspace: workspaceKey, error: `Project operation request ${requestId} was already used for different parameters` };
    }
    if (existingOperation?.state === 'succeeded' && existingOperation.result) {
      const settings = this.configManager?.getSettings();
      return {
        ...existingOperation.result,
        deduplicated: true,
        projectWorkspaces: settings?.projectWorkspaces || [],
        pinnedProjectWorkspaces: settings?.pinnedProjectWorkspaces || [],
      };
    }
    let operation = existingOperation;
    const storedSourceWorkspace = String(operation?.request?.sourceWorkspace || '');
    const commitDeleted = (baseResult: ProjectOperationResult) => {
      const result: UnknownRecord = { ...baseResult, ...(requestId ? { requestId } : {}) };
      if (!operation) return result;
      const committed = this.commitPersistentProjectOperation(
        operation,
        'succeeded',
        result,
        '',
        { removeWorkspace: workspaceKey },
      );
      return {
        ...result,
        projectWorkspaces: committed.projectWorkspaces,
        pinnedProjectWorkspaces: committed.pinnedProjectWorkspaces,
      };
    };
    if (operation && ['pending', 'unknown'].includes(operation.state) && storedSourceWorkspace) {
      const postcondition = await this.inspectGitWorktreePostcondition(
        storedSourceWorkspace,
        operation.request.workspace || workspaceKey,
      );
      if (postcondition.proven && !postcondition.exists && !postcondition.registered) {
        try {
          return commitDeleted({
            workspace: workspaceKey,
            deleted: true,
            forced: operation.request.force === true,
            archivedAgentIds: [],
            removedMainPageSessionKeys: [],
          });
        } catch (caughtError: unknown) {
      const error = caughtError as ErrorRecord;
          return {
            workspace: workspaceKey,
            deleted: true,
            retryable: true,
            error: `Worktree was deleted, but Project operation commit failed: ${error.message || error}`,
          };
        }
      }
      if (operation.state === 'unknown') {
        return {
          workspace: workspaceKey,
          error: operation.error || 'Worktree deletion has an uncertain outcome and will not be replayed automatically',
          uncertain: true,
        };
      }
      if (!postcondition.proven || postcondition.exists !== postcondition.registered) {
        const detail = postcondition.error || 'Worktree deletion has a partial or unverifiable result';
        try {
          this.commitPersistentProjectOperation(operation, 'unknown', null, detail);
        } catch {
          // The previously persisted pending intent still prevents blind replay.
        }
        return { workspace: workspaceKey, error: `${detail}; the operation will not be replayed automatically`, uncertain: true };
      }
    } else if (operation && !['pending', 'unknown'].includes(operation.state)) {
      return {
        workspace: workspaceKey,
        error: operation.error || `Project operation ${requestId} already finished with state ${operation.state}`,
      };
    }
    const relatedStarts = workspaceKey
      ? [...this.agentStartAdmissions.values()].filter((admission: AgentStartAdmission) => (
          !admission.workspaceKey
          || isSameOrDescendantPath(workspaceKey, admission.workspaceKey)
        ))
      : [];
    try {
      await withBoundedWait(
        Promise.allSettled(relatedStarts.map((admission: AgentStartAdmission) => admission.promise)),
        WORKTREE_DELETE_START_DRAIN_TIMEOUT_MS,
        `Worktree ${workspaceKey} Agent start drain`,
      );
    } catch (caughtError: unknown) {
      const error = caughtError as ErrorRecord;
      return {
        workspace: workspaceKey,
        error: error.message || String(error),
      };
    }
    const inspected = await this.inspectForkWorktreeProject(workspace);
    if ('error' in inspected) return inspected;
    if (inspected.requiresForce && options.force !== true) {
      return {
        ...inspected,
        error: 'Worktree has uncommitted or untracked files',
      };
    }

    if (!operation) {
      const admission = this.persistentProjectOperation(requestId, 'delete-worktree', signature, {
        workspace: inspected.workspace,
        sourceWorkspace: inspected.sourceWorkspace,
        force: options.force === true,
      });
      if ('error' in admission) return { ...inspected, error: admission.error };
      operation = admission.operation || null;
    }

    const archivedAgentIds: AgentId[] = [];
    const removedMainPageSessionKeys: string[] = [];
    const projectAgents = this.agentsForProjectWorkspace(inspected.workspace);
    for (const agent of projectAgents) {
      const result = await this.archiveAgent(agent.id, { requireEngineExit: true });
      if (result && !result.error) {
        archivedAgentIds.push(agent.id);
        removedMainPageSessionKeys.push(...(result.removedMainPageSessionKeys || []));
      } else {
        return {
          ...inspected,
          error: `Agent ${agent.id} could not be stopped before deleting the worktree: ${result?.error || 'Failed to archive Agent'}`,
          archivedAgentIds,
          removedMainPageSessionKeys: Array.from(new Set(removedMainPageSessionKeys)),
        };
      }
    }

    const mutation = await this.worktreeGitService.deleteWorktree({
      sourceWorkspace: inspected.sourceWorkspace,
      workspace: inspected.workspace,
    }, options.force === true);
    const postcondition = mutation.postcondition;
    if (mutation.commandFailure) {
      if (postcondition.proven && !postcondition.exists && !postcondition.registered) {
        try {
          return commitDeleted({
            workspace: inspected.workspace,
            deleted: true,
            forced: options.force === true,
            archivedAgentIds,
            removedMainPageSessionKeys: Array.from(new Set(removedMainPageSessionKeys)),
          });
        } catch (caughtCommitError: unknown) {
      const commitError = caughtCommitError as ErrorRecord;
          return {
            ...inspected,
            deleted: true,
            retryable: true,
            error: `Worktree was deleted, but Project operation commit failed: ${commitError.message || commitError}`,
            archivedAgentIds,
            removedMainPageSessionKeys: Array.from(new Set(removedMainPageSessionKeys)),
          };
        }
      }
      const detail = mutation.commandFailure.message;
      if (operation) {
        const state = postcondition.proven && postcondition.exists && postcondition.registered
          ? 'failed'
          : 'unknown';
        try {
          this.commitPersistentProjectOperation(operation, state, null, detail);
        } catch {
          // Preserve the earlier durable pending intent when the result write fails.
        }
      }
      return {
        ...inspected,
        error: detail,
        ...(postcondition.proven && postcondition.exists && postcondition.registered
          ? {}
          : { uncertain: true }),
        archivedAgentIds,
        removedMainPageSessionKeys: Array.from(new Set(removedMainPageSessionKeys)),
      };
    }
    if (!postcondition.proven || postcondition.exists || postcondition.registered) {
      const detail = postcondition.error || 'Worktree deletion could not be proven';
      if (operation) {
        try {
          this.commitPersistentProjectOperation(operation, 'unknown', null, detail);
        } catch {
          // Preserve the earlier durable pending intent when the result write fails.
        }
      }
      return {
        ...inspected,
        error: `${detail}; the operation will not be replayed automatically`,
        uncertain: true,
        archivedAgentIds,
        removedMainPageSessionKeys: Array.from(new Set(removedMainPageSessionKeys)),
      };
    }
    try {
      return commitDeleted({
        workspace: inspected.workspace,
        deleted: true,
        forced: options.force === true,
        archivedAgentIds,
        removedMainPageSessionKeys: Array.from(new Set(removedMainPageSessionKeys)),
      });
    } catch (caughtError: unknown) {
      const error = caughtError as ErrorRecord;
      return {
        ...inspected,
        deleted: true,
        retryable: true,
        error: `Worktree was deleted, but Project operation commit failed: ${error.message || error}`,
        archivedAgentIds,
        removedMainPageSessionKeys: Array.from(new Set(removedMainPageSessionKeys)),
      };
    }
  }

  async forkAgent(
    agentId: AgentId,
    mode: 'same-worktree' | 'new-worktree' | 'conversation' = 'same-worktree',
    options: ForkAgentOptions = {},
  ): Promise<AgentForkResult> {
    return this.forkOperationCoordinator.request({
      agentId,
      mode,
      options,
    });
  }

  async stabilizeForkSourceIdentity(
    agentId: AgentId,
    options: ForkAgentOptions = {},
  ): Promise<{ error?: string }> {
    let agent = this.agents.get(agentId);
    if (!agent) return { error: 'Agent not found' };
    if (
      forkTargetRuntime(agent, options.targetRuntime) !== 'terminal'
      || agent.providerSessionProvider !== 'codex'
      || agent.providerSessionTemporary !== true
    ) {
      return {};
    }
    await this.resolveCodexTerminalIdentityFromPreview(agentId, agent.previewText || '');
    agent = this.agents.get(agentId);
    if (!agent) return { error: 'Agent not found' };
    return agent.providerSessionTemporary === true
      ? { error: 'Fork requires a resumable Codex session. Try again after the session id is available.' }
      : {};
  }

  async forkAgentUntracked(
    agentId: AgentId,
    mode: 'same-worktree' | 'new-worktree' | 'conversation' = 'same-worktree',
    options: ForkAgentOptions = {},
    executionContext?: {
      onWorktreeCreated(identity: TemporaryWorktreeIdentity): Promise<void> | void;
    },
  ): Promise<AgentForkResult> {
    await this.whenRecovered();
    if (this.disposing) {
      return { error: 'Farming is shutting down; Agent lifecycle changes are not accepted' };
    }
    let agent = this.agents.get(agentId);
    if (!agent) {
      return { error: 'Agent not found' };
    }
    if (!['same-worktree', 'new-worktree'].includes(mode)) {
      return { error: 'Unsupported fork mode' };
    }
    const targetRuntime = forkTargetRuntime(agent, options.targetRuntime);
    const forkProvider = agent.providerSessionProvider
      || agentHomeProviderForProgram(agent.forkCommand || agent.command || '');
    const forkRuntime = targetRuntime === 'chat' ? 'acp' : 'terminal';
    const forkCapability = providerConversationForkCapability(forkProvider, forkRuntime);
    if (forkProvider && forkCapability.supported !== true) {
      return { error: `${forkProvider} does not support session Fork` };
    }
    if (
      forkProvider
      && !forkCapability.worktreeModes.includes(mode as 'same-worktree' | 'new-worktree')
    ) {
      return { error: `${forkProvider} does not support ${mode} ${forkRuntime.toUpperCase()} Fork` };
    }
    if (targetRuntime === 'chat') {
      let acpBinding = runtimeBindingOf(agent, 'acp');
      if (String(acpBinding?.state || '') === 'error') {
        try {
          await this.reconnectAcpAgent(agentId);
        } catch (caughtError: unknown) {
          const error = caughtError as ErrorRecord;
          return { error: `ACP Conversation Fork could not prepare the source Agent: ${error.message || error}` };
        }
        agent = this.agents.get(agentId);
        if (!agent) return { error: 'Agent not found' };
        acpBinding = runtimeBindingOf(agent, 'acp');
      }
      if (acpBinding?.state !== 'idle') {
        return { error: `ACP Agent is not ready for Conversation Fork (${acpBinding?.state || 'unavailable'})` };
      }
      if (
        forkCapability.requiresRuntimeCapability === true
        && acpBinding.supportsFork !== true
      ) {
        return { error: `${forkProvider || 'Provider'} ACP Agent does not currently support session/fork` };
      }
      const expectedRevision = Number(options.expectedRevision);
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
        return { error: 'Conversation Fork requires an exact transcript revision' };
      }
      if (options.lifecycleToken) {
        return this.performAcpConversationFork(
          agentId,
          expectedRevision,
          options.lifecycleToken,
          options.forkRequestId || '',
          options.forkRequestSignature || '',
        );
      }
      return this.runAgentLifecycleOperation(
        agentId,
        `conversation-fork:${expectedRevision}`,
        'conversation-fork',
        'conversation fork',
        (lifecycleToken: symbol) => this.performAcpConversationFork(agentId, expectedRevision, lifecycleToken, ''),
      );
    }
    const stabilization = await this.stabilizeForkSourceIdentity(agentId, options);
    if (stabilization.error) return stabilization;
    agent = this.agents.get(agentId);
    if (!agent) return { error: 'Agent not found' };

    const sourceWorkspace = effectiveAgentWorkspaceRoot(agent);
    const resumedSession = agent.providerSessionProvider
      && agent.providerSessionId
      && agent.providerSessionTemporary !== true
      ? { provider: agent.providerSessionProvider, providerHomeId: agent.providerHomeId || 'default', sessionId: String(agent.providerSessionId) }
      : resumedSessionFromSource(String(agent.source || ''));
    if (resumedSession?.provider === 'codex') {
      const availability = await this.ensureCodexSessionAvailableForFork(agent, resumedSession, sourceWorkspace);
      if (availability?.error) return availability;
    }

    let targetWorkspace = sourceWorkspace;
    let forkWorktreeIdentity: TemporaryWorktreeIdentity | null = null;
    if (mode === 'new-worktree') {
      try {
        forkWorktreeIdentity = await this.createForkWorktreeIdentity(
          sourceWorkspace,
          async identity => {
            forkWorktreeIdentity = identity;
            targetWorkspace = identity.workspace;
            await executionContext?.onWorktreeCreated(identity);
          },
        );
        targetWorkspace = forkWorktreeIdentity.workspace;
      } catch (caughtError: unknown) {
      const error = caughtError as ErrorRecord;
        const message = error.message || 'Failed to create git worktree';
        return {
          error: error.uncertain === true && forkWorktreeIdentity
            ? `${message}; temporary worktree retained at ${forkWorktreeIdentity.workspace}`
            : message,
          ...(error.uncertain === true ? { uncertain: true } : {}),
          ...(error.uncertain === true && forkWorktreeIdentity
            ? {
                retainedWorkspace: forkWorktreeIdentity.workspace,
                workspace: forkWorktreeIdentity.workspace,
              }
            : {}),
        };
      }
    }

    const forkCommand = resumedSession
      ? buildAgentSessionResumeCommand(resumedSession.provider, resumedSession.sessionId, {
        fork: true,
        cwd: targetWorkspace,
        providerHomePath: agent.providerHomePath || '',
      })
      : String(agent.forkCommand || agent.command || '');

    const start = await settleForkChildStart(
      callback => this.startAgent(forkCommand, targetWorkspace, callback, {
        wantsMain: false,
        parentAgentId: agent.id,
        forkRequestId: options.forkRequestId || '',
        forkRequestSignature: options.forkRequestSignature || '',
        task: agent.task ? `Fork: ${agent.task}` : `Fork of ${agent.command}`,
        workflowTemplate: agent.workflowTemplate || '',
        source: mode === 'new-worktree' ? 'ui-fork-new-worktree' : 'ui-fork-same-worktree',
        providerHomeId: agent.providerHomeId || (resumedSession && resumedSession.providerHomeId) || '',
        providerHomePath: agent.providerHomePath || '',
        ...(resumedSession?.provider === 'codex'
          ? preserveCodexSessionProfileOptions()
          : {}),
      }),
      'Failed to start forked agent',
    );
    if (start.uncertain) {
      return {
        error: `Fork start outcome is uncertain: ${start.error}${forkWorktreeIdentity ? `; temporary worktree retained at ${targetWorkspace}` : ''}`,
        ...(start.agentId ? { retainedAgentId: start.agentId } : {}),
        ...(forkWorktreeIdentity ? { retainedWorkspace: targetWorkspace } : {}),
        workspace: targetWorkspace,
        uncertain: true,
      };
    }
    if (start.error || !start.agentId) {
      const failure = start.error || 'Failed to start forked agent';
      if (start.agentId) {
        return {
          error: failure,
          retainedAgentId: start.agentId,
          workspace: targetWorkspace,
          uncertain: true,
        };
      }
      if (!forkWorktreeIdentity) return { error: failure };
      const rollback = await this.rollbackTemporaryForkWorktree(forkWorktreeIdentity);
      return rollback.rolledBack
        ? { error: failure }
        : {
            error: `${failure}; temporary worktree retained at ${targetWorkspace}: ${rollback.error}`,
            workspace: targetWorkspace,
            retainedWorkspace: targetWorkspace,
            uncertain: true,
          };
    }
    return {
      agentId: start.agentId,
      workspace: targetWorkspace,
      mode,
    };
  }

  async performAcpConversationFork(
    agentId: AgentId,
    expectedRevision: number,
    lifecycleToken: symbol,
    forkRequestId = '',
    forkRequestSignature = '',
  ): Promise<AgentForkResult> {
    const agent = this.agents.get(agentId);
    if (!agent) return { error: 'Agent not found' };
    if (runtimeKind(agent) !== 'acp') {
      return { error: 'Conversation Fork requires an ACP Chat Agent' };
    }
    const provider = String(agent.providerSessionProvider || '').trim();
    const sourceSessionId = String(agent.providerSessionId || '').trim();
    if (!provider || !isSafeProviderSessionId(sourceSessionId) || agent.providerSessionTemporary === true) {
      return { error: 'Conversation Fork requires a stable ACP provider session' };
    }

    const workspace = effectiveAgentWorkspaceRoot(agent);
    let acpSessionOptions: AcpSessionRequestOptions = {
      cwd: workspace,
      additionalDirectories: [],
      mcpServers: [],
    };
    try {
      acpSessionOptions = this.acpRuntime.getSessionRequestOptions(agentId);
    } catch (caughtError: unknown) {
      const error = caughtError as ErrorRecord;
      return { error: error.message || 'Failed to read ACP session options' };
    }

    if (providerConversationForkCapability(provider, 'acp').strategy === 'target-process') {
      return this.performTargetProcessAcpConversationFork({
        agent,
        provider,
        sourceSessionId,
        workspace,
        expectedRevision,
        lifecycleToken,
        acpSessionOptions,
        forkRequestId,
        forkRequestSignature,
      });
    }

    let forkedSessionId = '';
    try {
      const forked = await this.acpRuntime.forkSession(agentId, {
        ...acpSessionOptions,
        cwd: workspace,
        expectedRevision,
        requireLoad: true,
      });
      forkedSessionId = String(forked?.sessionId || '').trim();
    } catch (caughtError: unknown) {
      const error = caughtError as ErrorRecord;
      return { error: error.message || 'Failed to fork ACP conversation', uncertain: true };
    }
    if (!isSafeProviderSessionId(forkedSessionId) || forkedSessionId === sourceSessionId) {
      return { error: 'ACP Conversation Fork did not return a distinct resumable session', uncertain: true };
    }

    const command = buildAgentSessionResumeCommand(provider, forkedSessionId, {
      cwd: workspace,
      providerHomePath: agent.providerHomePath || '',
    });
    if (!command) {
      return {
        error: 'Failed to build provider resume command for the forked ACP session',
        retainedProviderSessionId: forkedSessionId,
        uncertain: true,
      };
    }

    const start = await settleForkChildStart(
      callback => this.startAgent(command, workspace, callback, {
        wantsMain: false,
        parentAgentId: agent.id,
        forkRequestId,
        forkRequestSignature,
        task: agent.task ? `Fork: ${agent.task}` : `Fork of ${agent.command}`,
        workflowTemplate: agent.workflowTemplate || '',
        source: 'ui-fork-acp-chat',
        providerHomeId: agent.providerHomeId || 'default',
        providerHomePath: agent.providerHomePath || '',
        providerSessionTitle: agent.providerSessionTitle || '',
        requiredCliVersion: provider === 'codex' ? (agent.requiredCliVersion || '') : '',
        projectWorkspace: workspace,
        agentRuntimeMode: 'chat',
        acpHistoryMode: 'load',
        runtimeSwitchVerifiedSessionId: forkedSessionId,
        forkedFromProviderSessionId: sourceSessionId,
        lifecycleToken,
        ...acpSessionOptions,
        ...(provider === 'codex'
          ? {
              codexApprovalMode: agent.launchPermissionMode || undefined,
              ...preserveCodexSessionProfileOptions(),
            }
          : {}),
        ...(provider === 'claude'
          ? { claudePermissionMode: agent.launchPermissionMode || undefined }
          : {}),
      }),
      'Failed to start forked ACP Chat Agent',
    );
    if (start.uncertain) {
      return {
        error: `Fork start outcome is uncertain: ${start.error}`,
        ...(start.agentId ? { retainedAgentId: start.agentId } : {}),
        retainedProviderSessionId: forkedSessionId,
        uncertain: true,
      };
    }
    if (start.error || !start.agentId) {
      let rollbackError = '';
      if (!start.agentId) {
        try {
          await this.acpRuntime.deleteSession(agentId, forkedSessionId);
        } catch (caughtCleanupError: unknown) {
          const cleanupError = caughtCleanupError as ErrorRecord;
          rollbackError = cleanupError.message || String(cleanupError);
        }
      }
      return {
        error: [
          start.error || 'Failed to start forked ACP Chat Agent',
          rollbackError ? `forked session cleanup failed: ${rollbackError}` : '',
        ].filter(Boolean).join('; '),
        ...(start.agentId ? { retainedAgentId: start.agentId } : {}),
        ...(rollbackError ? { retainedProviderSessionId: forkedSessionId, uncertain: true } : {}),
      };
    }
    return {
      agentId: start.agentId,
      workspace,
      mode: 'same-worktree',
      targetRuntime: 'chat',
      providerSessionId: forkedSessionId,
    };
  }

  async performTargetProcessAcpConversationFork(
    options: TargetProcessAcpForkOptions,
  ): Promise<AgentForkResult> {
    const {
      agent,
      provider,
      sourceSessionId,
      workspace,
      expectedRevision,
      lifecycleToken,
      acpSessionOptions,
      forkRequestId,
      forkRequestSignature,
    } = options;
    const command = getProviderAdapter(provider)?.executable || provider;
    let preparedSessionId = '';
    let result: AgentForkResult;
    try {
      result = await this.acpRuntime.runWithForkReservation(
        agent.id,
        { expectedRevision, requireLoad: true },
        async (sourceBinding: AcpBindingContract) => {
          const forkSourceCheckpoint = this.acpRuntime.bindingCheckpoint(sourceBinding).exportCheckpoint();
          if (!forkSourceCheckpoint?.sessionState) {
            throw new Error('ACP fork source transcript is unavailable');
          }
          const start = await settleForkChildStart(
            callback => this.startAgent(command, workspace, callback, {
              wantsMain: false,
              parentAgentId: agent.id,
              forkRequestId,
              forkRequestSignature,
              task: agent.task ? `Fork: ${agent.task}` : `Fork of ${agent.command}`,
              workflowTemplate: agent.workflowTemplate || '',
              source: 'ui-fork-acp-chat',
              providerHomeId: agent.providerHomeId || 'default',
              providerHomePath: agent.providerHomePath || '',
              providerSessionTitle: agent.providerSessionTitle || '',
              projectWorkspace: workspace,
              agentRuntimeMode: 'chat',
              acpForkSourceSessionId: sourceSessionId,
              acpForkSourceCheckpoint: forkSourceCheckpoint,
              forkedFromProviderSessionId: sourceSessionId,
              lifecycleToken,
              ...acpSessionOptions,
              onAcpForkSessionCreated: (sessionId: string) => {
                preparedSessionId = String(sessionId || '').trim();
              },
              onAcpSessionPrepared: (prepared: AcpPrepareResult) => {
                preparedSessionId = String(prepared?.sessionId || '').trim();
              },
              ...(provider === 'claude'
                ? { claudePermissionMode: agent.launchPermissionMode || undefined }
                : {}),
            }),
            'Failed to start forked ACP Chat Agent',
          );
          if (start.uncertain) {
            return {
              error: `Fork start outcome is uncertain: ${start.error}`,
              ...(start.agentId ? { retainedAgentId: start.agentId } : {}),
              ...(isSafeProviderSessionId(preparedSessionId)
                ? { retainedProviderSessionId: preparedSessionId }
                : {}),
              uncertain: true,
            };
          }
          if (start.error || !start.agentId) {
            return {
              error: start.error || 'Failed to start forked ACP Chat Agent',
              ...(start.agentId ? { retainedAgentId: start.agentId } : {}),
            };
          }
          const forkedAgent = this.agents.get(start.agentId);
          const forkedSessionId = String(forkedAgent?.providerSessionId || preparedSessionId).trim();
          return {
            agentId: start.agentId,
            workspace,
            mode: 'same-worktree',
            targetRuntime: 'chat',
            providerSessionId: forkedSessionId,
          };
        },
      );
    } catch (caughtError: unknown) {
      const error = caughtError as ErrorRecord;
      return { error: error.message || 'Failed to fork ACP conversation', uncertain: true };
    }
    if (
      result?.error
      && !result.retainedAgentId
      && result.uncertain !== true
      && isSafeProviderSessionId(preparedSessionId)
    ) {
      try {
        await this.acpRuntime.deleteSession(agent.id, preparedSessionId);
      } catch (caughtCleanupError: unknown) {
      const cleanupError = caughtCleanupError as ErrorRecord;
        result.retainedProviderSessionId = preparedSessionId;
        result.error = `${result.error}; forked session ${preparedSessionId} cleanup failed: ${cleanupError.message || cleanupError}`;
      }
    }
    return result;
  }

  enqueueCodexSessionMutation<Result>(
    sessionId: string,
    options: ProviderResumeOptions,
    type: string,
    operation: () => Result | Promise<Result>,
    joinSameType = false,
  ): Promise<Result> {
    const providerHomeId = String(options?.providerHomeId || 'default').trim() || 'default';
    const key = JSON.stringify([providerHomeId, sessionId]);
    const current = this.codexSessionMutationQueues.get(key);
    if (joinSameType && current?.type === type) return current.promise as Promise<Result>;

    const previous = current?.promise || Promise.resolve();
    const next = previous.catch(() => {}).then(operation);
    const entry: CodexSessionMutationAdmission<Result> = { type, promise: next };
    this.codexSessionMutationQueues.set(key, entry);
    void next.finally(() => {
      if (this.codexSessionMutationQueues.get(key) === entry) {
        this.codexSessionMutationQueues.delete(key);
      }
    }).catch(() => {});
    return next;
  }

  ensureCodexSessionAvailable(
    sessionId: string,
    options: ProviderResumeOptions = {},
  ): Promise<{ error: string } | null> {
    const providerHomeId = String(options.providerHomeId || 'default').trim() || 'default';
    const providerHomePath = String(options.providerHomePath || '').trim();
    return this.enqueueCodexSessionMutation(
      sessionId,
      { providerHomeId, providerHomePath },
      'unarchive',
      async () => {
        let session: Awaited<ReturnType<typeof findAgentSession>>;
        try {
          session = await findAgentSession('codex', sessionId, {
            limit: 1000,
            providerLimit: 1000,
            scanLimit: 5000,
            providerHomeId,
            providerHomes: options.providerHomes || (providerHomePath
              ? { codex: [{ id: providerHomeId, path: providerHomePath }] }
              : undefined),
          });
        } catch (caughtError: unknown) {
      const error = caughtError as ErrorRecord;
          return {
            error: `Failed to inspect Codex session before unarchiving: ${error && (error.message || error)}`,
          };
        }
        if (!session || session.archived !== true) return null;

        const result = await this.unarchiveCodexSession(sessionId, {
          ...session,
          cwd: options.cwd || session.cwd || session.workspace,
          providerHomePath: session.providerHomePath || providerHomePath,
        });
        return result?.error ? { error: result.error } : null;
      },
      true,
    );
  }

  async ensureCodexSessionAvailableForFork(
    agent: TypedAgentRecord,
    resumedSession: ExactResumeSession,
    sourceWorkspace: string,
  ): Promise<{ error: string } | null> {
    const providerHomeId = agent.providerHomeId || resumedSession.providerHomeId || 'default';
    const providerHomePath = agent.providerHomePath || '';
    const sessionId = resumedSession.sessionId;
    const result = await this.ensureCodexSessionAvailable(sessionId, {
      providerHomeId,
      providerHomePath,
      providerHomes: providerHomePath
        ? { codex: [{ id: providerHomeId, path: providerHomePath }] }
        : undefined,
      // Fork is an action on the live Farming Agent. Its current workspace is
      // authoritative even when the older provider history cwd no longer exists.
      cwd: sourceWorkspace,
    });
    if (!result?.error) return null;
    const detail = result.error.startsWith('Failed to inspect Codex session')
      ? result.error.replace('before unarchiving', 'before forking')
      : `Codex session ${sessionId} is archived and could not be unarchived before forking: ${result.error}`;
    return { error: detail };
  }

  recordTaskHistory(
    agent: TypedAgentRecord,
    options: { archivedAt?: number; reason?: string } = {},
  ): void {
    if (!agent || agent.id === this.mainAgentId) return;
    if (!isSupportedHistoryAgent(agent.forkCommand || agent.command || '')) return;
    const providerHistorySource = agent.providerSessionProvider
      && agent.providerSessionId
      && agent.providerSessionTemporary !== true
      ? resumedAgentSource(agent.providerSessionProvider, agent.providerSessionId, agent.providerHomeId || '')
      : '';
    const entry: UnknownRecord = {
      id: `history-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      agentId: agent.id,
      command: agent.command || '',
      cwd: agent.cwd || '',
      projectWorkspace: effectiveAgentWorkspaceRoot(agent),
      title: agent.customTitle || agent.adaptiveTitle || agent.sessionTitle || agent.task || '',
      customTitle: agent.customTitle || '',
      adaptiveTitle: agent.adaptiveTitle || '',
      task: agent.task || '',
      workflowTemplate: agent.workflowTemplate || '',
      source: providerHistorySource || agent.source || 'ui',
      reason: options.reason || 'manual-kill',
      status: agent.status || 'stopped',
      startedAt: agent.startedAt || null,
      lastActivity: this.lastActivity.get(agent.id) || null,
      archivedAt: options.archivedAt || Date.now(),
    };
    this.taskHistory = [entry, ...this.taskHistory].slice(0, 200);
    if (this.configManager && this.configManager.appendTaskHistory) {
      this.configManager.appendTaskHistory(entry);
    }
  }

  archiveAgent(agentId: AgentId, options: ArchiveAgentOptions = {}): Promise<ArchiveAgentResult> {
    if (options.skipRecoveryWait !== true && !this.recoveryComplete) {
      return this.whenRecovered().then(() => this.archiveAgent(agentId, {
        ...options,
        skipRecoveryWait: true,
      }));
    }
    const inFlight = this.agentLifecycleOperations.get(agentId);
    if (inFlight) {
      return this.runAgentLifecycleOperation(
        agentId,
        'archive',
        'archive',
        'archive',
        (lifecycleToken: symbol) => this.performArchiveAgent(agentId, options, lifecycleToken),
      );
    }
    const agent = this.agents.get(agentId);
    if (!agent) {
      return Promise.resolve({ error: 'Agent not found' });
    }
    return this.runAgentLifecycleOperation(
      agentId,
      'archive',
      'archive',
      'archive',
      (lifecycleToken: symbol) => this.performArchiveAgent(agentId, options, lifecycleToken),
    );
  }

  async performArchiveAgent(
    agentId: AgentId,
    options: ArchiveAgentOptions,
    lifecycleToken: symbol,
  ): Promise<ArchiveAgentResult> {
    const agent = this.agents.get(agentId);
    if (!agent) return { error: 'Agent not found' };
    const admission = this.beginPersistentAgentOperation(agent, 'archive', 'archive', {
      reason: options.reason || 'manual-archive',
      structuredProcessProofRequired: runtimeKind(agent) === 'acp',
    });
    if ('error' in admission) return { agentId, error: admission.error };
    const operationId = admission.operation.id;
    const killResult = await this.killAgent(agentId, {
      reason: options.reason || 'manual-archive',
      recordHistory: false,
      requireEngineExit: true,
      retainAgentRecord: true,
      emitUpdate: false,
      lifecycleToken,
      persistDeleteOperation: false,
      skipRecoveryWait: options.skipRecoveryWait === true,
    });
    if (killResult?.error) {
      try {
        this.transitionPersistentAgentOperation(agent, operationId, 'blocked', killResult.error);
      } catch (caughtError: unknown) {
      const error = caughtError as ErrorRecord;
        return {
          ...killResult,
          error: `${killResult.error}; failed to persist blocked Archive: ${error.message || error}`,
        };
      }
      return { ...killResult, operationId };
    }
    let removedMainPageSessionKeys: string[] = [];
    try {
      this.transitionPersistentAgentOperation(agent, operationId, 'provider-archive-pending', '', {
        visibleOnMainPage: false,
        archived: true,
        archivedAt: Date.now(),
        runtimeAgentId: '',
      });
    } catch (caughtError: unknown) {
      const error = caughtError as ErrorRecord;
      this.emitStateChange({ agentIds: [agentId] });
      return {
        agentId,
        error: `Agent stopped, but archive metadata could not be saved: ${error.message || error}`,
        stopped: true,
        archived: false,
        retryable: true,
        operationId,
        removedMainPageSessionKeys,
      };
    }
    agent.archived = true;
    agent.archivedAt = Date.now();
    let metadataWarning = '';
    try {
      removedMainPageSessionKeys = this.removeMainPageProviderSessionsForAgents([agent]);
    } catch (caughtError: unknown) {
      const error = caughtError as ErrorRecord;
      metadataWarning = `Agent archived, but main-page membership cleanup failed: ${error.message || error}`;
      console.error(metadataWarning);
    }

    let historyWarning = '';
    if (!admission.joined && options.recordHistory !== false && !isEphemeralShellAgent(agent)) {
      const previousTaskHistory = this.taskHistory;
      try {
        this.recordTaskHistory(agent, {
          reason: options.reason || 'manual-archive',
          archivedAt: Date.now(),
        });
      } catch (caughtError: unknown) {
      const error = caughtError as ErrorRecord;
        this.taskHistory = previousTaskHistory;
        historyWarning = `Agent stopped, but history could not be saved: ${error.message || error}`;
        console.error(historyWarning);
      }
    }
    // The local archive is now durable and the runtime has stopped. Publish
    // this committed state before waiting for the slower external Codex
    // archive so every connected client can remove the Agent immediately.
    // The lifecycle journal remains provider-archive-pending until that
    // external mutation reaches its terminal state.
    this.emitStateChange({ agentIds: [agentId], taskHistoryChanged: true });
    if (options.scheduleProviderArchive !== false) {
      const providerArchive = await this.archiveCodexProviderSession(agent);
      if (providerArchive?.error) {
        try {
          this.transitionPersistentAgentOperation(agent, operationId, 'blocked', providerArchive.error, {
            visibleOnMainPage: false,
            archived: true,
            runtimeAgentId: '',
          });
        } catch (caughtError: unknown) {
      const error = caughtError as ErrorRecord;
          return {
            agentId,
            archived: true,
            stopped: true,
            retryable: true,
            operationId,
            removedMainPageSessionKeys,
            error: `Provider archive failed: ${providerArchive.error}; failed to persist blocked Archive: ${error.message || error}`,
          };
        }
        this.emitStateChange({ agentIds: [agentId] });
        return {
          agentId,
          archived: true,
          stopped: true,
          providerArchived: false,
          retryable: true,
          operationId,
          removedMainPageSessionKeys,
          error: `Provider archive failed: ${providerArchive.error}`,
        };
      }
    }
    try {
      this.transitionPersistentAgentOperation(agent, operationId, 'succeeded', '', {
        visibleOnMainPage: false,
        archived: true,
        runtimeAgentId: '',
      });
    } catch (caughtError: unknown) {
      const error = caughtError as ErrorRecord;
      this.emitStateChange({ agentIds: [agentId] });
      return {
        agentId,
        archived: true,
        stopped: true,
        providerArchived: true,
        retryable: true,
        operationId,
        removedMainPageSessionKeys,
        error: `Provider archive succeeded, but terminal Archive result could not be saved: ${error.message || error}`,
      };
    }
    this.forgetStoppedAgentRecord(agentId);
    return {
      agentId,
      archived: true,
      removed: true,
      operationId,
      removedMainPageSessionKeys,
      ...(
        metadataWarning || historyWarning
          ? { warning: [metadataWarning, historyWarning].filter(Boolean).join('; ') }
          : {}
      ),
    };
  }

  async archiveCodexProviderSession(agent: TypedAgentRecord) {
    if (
      !agent
      || agent.providerSessionProvider !== 'codex'
      || !agent.providerSessionId
      || agent.providerSessionTemporary === true
      || (agent.providerSessionMaterialized === false && agent.terminalInputReceived !== true)
    ) {
      return null;
    }

    const sessionId = agent.providerSessionId;
    const session: UnknownRecord = {
      cliVersion: agent.cliVersion || '',
      cwd: agent.cwd || '',
      workspace: agent.projectWorkspace || '',
      providerHomePath: agent.providerHomePath || '',
    };
    try {
      const result = await this.enqueueCodexSessionMutation(
        sessionId,
        {
          providerHomeId: agent.providerHomeId || 'default',
          providerHomePath: agent.providerHomePath || '',
        },
        'archive',
        () => this.archiveCodexSession(sessionId, session),
        true,
      );
      return result?.error ? { error: result.error } : { archived: true };
    } catch (caughtError: unknown) {
      const error = caughtError as ErrorRecord;
      return { error: error.message || String(error) };
    }
  }

  admitPersistentDelete(agent: TypedAgentRecord, options: DeleteAgentOptions = {}) {
    const activeOperation = activeLifecycleOperation(agent);
    if (
      activeOperation?.type === 'create'
      && ['pending', 'blocked'].includes(activeOperation.state)
    ) {
      const previousJournal = lifecycleJournal(agent);
      try {
        transitionLifecycleOperation(
          agent,
          activeOperation.id,
          'cancelled',
          'Create was superseded by Delete',
        );
        const admittedDelete = beginLifecycleOperation(
          agent,
          'delete',
          'delete',
          {
            reason: options.reason || 'manual-kill',
            structuredProcessProofRequired: runtimeKind(agent) === 'acp',
          },
        );
        if (admittedDelete.conflict) {
          throw new Error(
            `Delete conflicts with Agent operation ${admittedDelete.conflict.id}`,
          );
        }
        const persistentSessionId = this.ensurePersistentAgentSession(agent);
        if (
          typeof this.configManager?.ensureAgentSessionRecord === 'function'
          && !persistentSessionId
        ) {
          throw new Error('Agent session store did not return a persistent id');
        }
        return {
          operationId: admittedDelete.operation.id,
          completesBlockedCreate: false,
        };
      } catch (caughtError: unknown) {
      const error = caughtError as ErrorRecord;
        agent.lifecycleJournal = previousJournal;
        return { error: `Failed to persist Create cleanup retry: ${error.message || error}` };
      }
    }
    const admitted = this.beginPersistentAgentOperation(agent, 'delete', 'delete', {
      reason: options.reason || 'manual-kill',
      structuredProcessProofRequired: runtimeKind(agent) === 'acp',
    });
    if ('error' in admitted) return { error: admitted.error };
    return {
      operationId: admitted.operation.id,
      completesBlockedCreate: false,
    };
  }

  async requestKillAgent(
    agentId: AgentId,
    options: KillAgentOptions = {},
  ): Promise<KillAgentAdmission> {
    if (options.skipRecoveryWait !== true) await this.whenRecovered();
    const existing = this.agentLifecycleOperations.get(agentId);
    if (existing && existing.key !== 'kill') {
      await existing.promise.catch(() => {});
      return this.requestKillAgent(agentId, options);
    }
    const completion = this.killAgent(agentId, options);
    const operation = activeLifecycleOperation(this.agents.get(agentId));
    if (!operation || !['create', 'delete'].includes(operation.type)) {
      const result = await completion;
      return { result, completion: Promise.resolve(result) };
    }
    return {
      result: {
        agentId,
        accepted: true,
        operationId: operation.id,
        operationType: operation.type,
        operationState: operation.state,
      },
      completion,
    };
  }

  killAgent(agentId: AgentId, options: KillAgentOptions = {}): Promise<KillAgentResult> {
    if (options.skipRecoveryWait !== true && !this.recoveryComplete) {
      return this.whenRecovered().then(() => this.killAgent(agentId, {
        ...options,
        skipRecoveryWait: true,
      }));
    }
    const inFlight = this.agentLifecycleOperations.get(agentId);
    if (inFlight) {
      if (options.lifecycleToken && inFlight.token === options.lifecycleToken) {
        return this.performKillAgent(agentId, options);
      }
      return this.runAgentLifecycleOperation(
        agentId,
        'kill',
        'kill',
        'kill',
        (lifecycleToken: symbol) => {
          const agent = this.agents.get(agentId);
          if (!agent) return { agentId, killed: true, missing: true };
          let queuedOptions = options;
          if (options.persistDeleteOperation !== false && !options.persistentOperationId) {
            const admitted = this.admitPersistentDelete(agent, options);
            if ('error' in admitted) return { agentId, error: admitted.error };
            queuedOptions = {
              ...options,
              persistentOperationId: admitted.operationId,
              completesBlockedCreate: admitted.completesBlockedCreate,
            };
          }
          return this.performKillAgent(agentId, { ...queuedOptions, lifecycleToken });
        },
      );
    }
    const agent = this.agents.get(agentId);
    if (!agent) return Promise.resolve({ agentId, killed: true, missing: true });
    let admittedOptions = options;
    if (options.persistDeleteOperation !== false && !options.persistentOperationId) {
      const admitted = this.admitPersistentDelete(agent, options);
      if ('error' in admitted) return Promise.resolve({ agentId, error: admitted.error });
      admittedOptions = {
        ...options,
        persistentOperationId: admitted.operationId,
        completesBlockedCreate: admitted.completesBlockedCreate,
      };
    }

    return this.runAgentLifecycleOperation(
      agentId,
      'kill',
      'kill',
      'kill',
      (lifecycleToken: symbol) => this.performKillAgent(agentId, { ...admittedOptions, lifecycleToken }),
    );
  }

  async performKillAgent(agentId: AgentId, options: KillAgentOptions = {}): Promise<KillAgentResult> {
    const agent = this.agents.get(agentId);
    if (!agent) return { agentId, killed: true, missing: true };

    let persistentOperationId = typeof options.persistentOperationId === 'string'
      ? options.persistentOperationId
      : '';
    const completesBlockedCreate = options.completesBlockedCreate === true;
    const cleanupFailure = (message: string, kind: string = ''): KillAgentResult => {
      const error = String(message || 'Failed to stop Agent runtime');
      if (kind === 'acp') {
        return this.markStructuredAgentCleanupUncertain(
          agentId,
          kind,
          error,
          { operationId: persistentOperationId },
        );
      }
      agent.status = 'error';
      agent.engineStatus = 'cleanup-uncertain';
      if (persistentOperationId) {
        try {
          this.transitionPersistentAgentOperation(agent, persistentOperationId, 'blocked', error);
        } catch (caughtPersistError: unknown) {
      const persistError = caughtPersistError as ErrorRecord;
          return {
            agentId,
            error: `${error}; failed to persist blocked Agent operation: ${persistError.message || persistError}`,
            cleanupUncertain: true,
            retryable: true,
          };
        }
      }
      this.emitStateChange({ agentIds: [agentId] });
      return { agentId, error, cleanupUncertain: true, retryable: true };
    };

    const requireEngineExit = options.requireEngineExit !== false;
    const currentRuntimeKind = runtimeKind(agent);
    if (!this.verifiedStoppedAgentIds.has(agentId)) {
      this.permissionRestartSuppressedAgentIds.add(agentId);
      try {
      if (currentRuntimeKind === 'acp') {
        if (typeof this.acpRuntime?.unregisterAgentAndWait !== 'function') {
          return cleanupFailure('ACP runtime exit cannot be verified', 'acp');
        }
        const stopped = await this.acpRuntime.unregisterAgentAndWait(agentId);
        if (stopped !== true) {
          if (!agent.structuredRuntimeProcess) {
            if (
              options.acknowledgeUnprovenAcpExit !== true
              || agent.requiresProcessExitAcknowledgement !== true
            ) {
              return cleanupFailure('ACP runtime binding is missing; process exit cannot be verified', 'acp');
            }
            const previousAcknowledgedAt = agent.legacyAcpProcessExitAcknowledgedAt;
            agent.legacyAcpProcessExitAcknowledgedAt = Date.now();
            agent.requiresProcessExitAcknowledgement = false;
            try {
              this.ensurePersistentAgentSession(agent);
            } catch (caughtError: unknown) {
      const error = caughtError as ErrorRecord;
              agent.legacyAcpProcessExitAcknowledgedAt = previousAcknowledgedAt;
              agent.requiresProcessExitAcknowledgement = true;
              throw error;
            }
          } else {
            const liveBindingIds = new Set([...this.acpRuntime.bindings.keys()]);
            if (!this.hasLiveAcpProcessPeer(
              agentId,
              agent.structuredRuntimeProcess,
              this.agents.values(),
              liveBindingIds,
            )) {
              const cleanup = await this.stopPersistedAcpProcessGroup(agent.structuredRuntimeProcess);
              if (cleanup.stopped !== true) {
                return cleanupFailure(
                  'ACP runtime binding is missing and the persisted process identity could not be safely stopped',
                  'acp',
                );
              }
            }
          }
        }
      } else {
        const engine = this.engineBridge.getEngine(agent.engineName);
        if (requireEngineExit && !engine) {
          return cleanupFailure('Agent runtime is unavailable; process exit cannot be verified');
        }
        let killError = null;
        try {
          if (engine) {
            await engine.killSession(agentId);
          }
        } catch (caughtError: unknown) {
      const error = caughtError as ErrorRecord;
          console.error('Failed to kill agent:', error);
          killError = error;
        }

        if (requireEngineExit && engine) {
          const deadline = Date.now() + 3000;
          let lastState = null;
          while (Date.now() < deadline) {
            try {
              lastState = await engine.getSessionState(agentId);
            } catch (caughtError: unknown) {
      const error = caughtError as ErrorRecord;
              if (isSessionNotAvailableError(error)) {
                lastState = null;
                break;
              }
              return cleanupFailure(error.message || 'Failed to verify Agent process exit');
            }
            if (!isLiveEngineSessionState(lastState)) break;
            await new Promise<void>(resolve => setTimeout(resolve, 50));
          }
          if (isLiveEngineSessionState(lastState)) {
            return cleanupFailure(killError?.message || 'Agent process did not exit within 3 seconds');
          }
        } else if (killError) {
          return cleanupFailure(killError.message || 'Failed to stop Agent runtime');
        }
      }
      } catch (caughtError: unknown) {
      const error = caughtError as ErrorRecord;
        if (currentRuntimeKind === 'acp') {
          return cleanupFailure(error.message || 'Failed to stop Agent runtime', currentRuntimeKind);
        }
        return cleanupFailure(error.message || 'Failed to stop Agent runtime');
      } finally {
        this.permissionRestartSuppressedAgentIds.delete(agentId);
      }
    }
    if (currentRuntimeKind === 'acp') {
      agent.structuredRuntimeProcess = null;
    }

    if (completesBlockedCreate) {
      try {
        this.transitionPersistentAgentOperation(
          agent,
          persistentOperationId,
          'failed',
          'Create runtime was stopped by Delete recovery',
        );
      } catch (caughtError: unknown) {
      const error = caughtError as ErrorRecord;
        const message = `Agent stopped, but Create cleanup could not be committed: ${error.message || error}`;
        this.verifiedStoppedAgentIds.add(agentId);
        agent.status = 'stopped';
        agent.engineStatus = 'exited';
        this.emitStateChange({ agentIds: [agentId] });
        return {
          agentId,
          error: message,
          stopped: true,
          retryable: true,
          operationId: persistentOperationId,
        };
      }
      const admittedDelete = this.beginPersistentAgentOperation(agent, 'delete', 'delete', {
        reason: options.reason || 'manual-kill',
        structuredProcessProofRequired: runtimeKind(agent) === 'acp',
      });
      if ('error' in admittedDelete) {
        return { agentId, error: admittedDelete.error, stopped: true, retryable: true };
      }
      persistentOperationId = admittedDelete.operation.id;
    }

    if (persistentOperationId) {
      try {
        this.transitionPersistentAgentOperation(agent, persistentOperationId, 'succeeded', '', {
          visibleOnMainPage: false,
          archived: true,
          archivedAt: Date.now(),
          runtimeAgentId: '',
        });
        this.removeMainPageProviderSessionsForAgents([agent]);
      } catch (caughtError: unknown) {
      const error = caughtError as ErrorRecord;
        const message = `Agent stopped, but Delete metadata could not be committed: ${error.message || error}`;
        console.error(message);
        this.verifiedStoppedAgentIds.add(agentId);
        agent.status = 'stopped';
        agent.engineStatus = 'exited';
        this.emitStateChange({ agentIds: [agentId] });
        return {
          agentId,
          error: message,
          stopped: true,
          retryable: true,
          operationId: persistentOperationId,
        };
      }
    }

    let historyWarning = '';
    if (options.recordHistory !== false && !isEphemeralShellAgent(agent)) {
      const previousTaskHistory = this.taskHistory;
      try {
        this.recordTaskHistory(agent, {
          reason: options.reason || 'manual-kill',
          archivedAt: Date.now(),
        });
      } catch (caughtError: unknown) {
      const error = caughtError as ErrorRecord;
        this.taskHistory = previousTaskHistory;
        historyWarning = `Agent stopped, but history could not be saved: ${error.message || error}`;
        console.error(historyWarning);
      }
    }

    if (options.retainAgentRecord === true) {
      this.verifiedStoppedAgentIds.add(agentId);
      agent.status = 'stopped';
      agent.engineStatus = 'exited';
      if (options.emitUpdate !== false) {
        this.emitStateChange({
          agentIds: [agentId],
          ...(options.recordHistory !== false && !isEphemeralShellAgent(agent)
            ? { taskHistoryChanged: true }
            : {}),
        });
      }
      return {
        agentId,
        killed: true,
        retained: true,
        ...(historyWarning ? { warning: historyWarning } : {}),
      };
    }

    const removedMainAgent = this.mainAgentId === agentId;
    this.forgetStoppedAgentRecord(agentId, { emitUpdate: false });
    if (options.emitUpdate !== false) {
      this.emitStateChange({
        removedAgentIds: [agentId],
        ...(removedMainAgent ? { mainAgentIdChanged: true } : {}),
        ...(options.recordHistory !== false && !isEphemeralShellAgent(agent)
          ? { taskHistoryChanged: true }
          : {}),
      });
    }
    return {
      agentId,
      killed: true,
      ...(persistentOperationId ? { operationId: persistentOperationId } : {}),
      ...(historyWarning ? { warning: historyWarning } : {}),
    };
  }

  markStructuredAgentCleanupUncertain(
    agentId: AgentId,
    kind: string,
    error: unknown,
    options: KillAgentOptions = {},
  ) {
    const agent = this.agents.get(agentId);
    const message = String(error || 'Agent runtime exit cannot be verified');
    if (agent) {
      agent.status = 'error';
      agent.engineStatus = 'cleanup-uncertain';
      const runtime = runtimeBindingOf(agent, kind);
      if (runtime) {
        runtime.state = 'error';
        runtime.error = message;
      }
      if (options.operationId) {
        try {
          this.transitionPersistentAgentOperation(agent, options.operationId, 'blocked', message);
        } catch (caughtPersistError: unknown) {
      const persistError = caughtPersistError as ErrorRecord;
          return {
            agentId,
            error: `${message}; failed to persist blocked Agent operation: ${persistError.message || persistError}`,
            cleanupUncertain: true,
            retryable: true,
          };
        }
      }
      if (options.emitUpdate !== false) this.emitStateChange({ agentIds: [agentId] });
    }
    return {
      agentId,
      error: message,
      cleanupUncertain: true,
      retryable: true,
    };
  }

  forgetStoppedAgentRecord(agentId: AgentId, options: KillAgentOptions = {}) {
    this.acpPreparedTranscriptCache.deleteAgent(agentId);
    this.deleteAgentRecord(agentId);
    this.acpFinalizedTurns.delete(agentId);
    this.acpTurnFinalizationTails.delete(agentId);
    this.verifiedStoppedAgentIds.delete(agentId);
    this.lastActivity.delete(agentId);
    this.lastActivityUpdate.delete(agentId);
    this.usageRateTracker.forget(agentId);
    this.codexTerminalIdentityAttempts.delete(agentId);
    this.codexTerminalIdentityPromises.delete(agentId);
    this.providerSessionService.stop(agentId);
    if (this.acpRuntime) this.acpRuntime.unregisterAgent(agentId);

    const removedMainAgent = this.mainAgentId === agentId;
    if (removedMainAgent) {
      this.mainAgentId = null;
    }
    
    if (options.emitUpdate !== false) {
      this.emitStateChange({
        removedAgentIds: [agentId],
        ...(removedMainAgent ? { mainAgentIdChanged: true } : {}),
      });
    }
  }

  async getAgentSessionText(agentId: AgentId) {
    const agent = this.agents.get(agentId);
    if (!agent) {
      return null;
    }

    const engine = this.engineBridge.getEngine(agent.engineName);
    if (!engine) {
      return agent.output;
    }

    try {
      const sessionState = await engine.getSessionState(agentId);
      if (isLiveEngineSessionState(sessionState) && this.reviveAgentRuntime(agent, sessionState)) {
        this.emitStateChange({ agentIds: [agentId] });
      }
      if (sessionState && typeof sessionState.output === 'string') {
        return sessionState.output;
      }
      if (!sessionState && isRunningAgentRuntimeStatus(agent.status) && !this.shouldDeferMissingEngineSession(agent)) {
        this.markAgentSessionDead(agentId, 'Session not available');
      }
    } catch (caughtError: unknown) {
      const error = caughtError as ErrorRecord;
      console.error('Failed to read session text:', error);
      if (isSessionNotAvailableError(error) && !this.shouldDeferMissingEngineSession(agent)) {
        this.markAgentSessionDead(agentId, error);
      }
    }

    return agent.output;
  }

  getAgentWorkspaceRoot(agentId: AgentId): string | null {
    const agent = this.agents.get(agentId);
    if (!agent) {
      return null;
    }

    return effectiveAgentWorkspaceRoot(agent);
  }

  getAgentProviderSession(agentId: AgentId): ProviderSessionContract | null {
    const agent = this.agents.get(agentId);
    if (!agent) return null;
    return {
      provider: agent.providerSessionProvider || '',
      sessionId: agent.providerSessionId || '',
      providerHomeId: agent.providerHomeId || '',
      providerHomePath: agent.providerHomePath || '',
      runtimeBinding: publicRuntimeBinding(agent),
      temporary: agent.providerSessionTemporary === true,
      title: agent.providerSessionTitle || '',
    };
  }

  async getAgentSessionView(agentId: AgentId): Promise<AgentSessionViewContract | null> {
    const agent = this.agents.get(agentId);
    if (!agent) {
      return null;
    }

    const engine = this.engineBridge.getEngine(agent.engineName);
    let sessionState = null;

    if (engine && engine.getSessionState) {
      try {
        sessionState = await engine.getSessionState(agentId);
        if (isLiveEngineSessionState(sessionState) && this.reviveAgentRuntime(agent, sessionState)) {
          this.emitStateChange({ agentIds: [agentId] });
        }
        if (!sessionState && isRunningAgentRuntimeStatus(agent.status) && !this.shouldDeferMissingEngineSession(agent)) {
          this.markAgentSessionDead(agentId, 'Session not available');
        }
      } catch (caughtError: unknown) {
      const error = caughtError as ErrorRecord;
        console.error('Failed to read session state:', error);
        if (isSessionNotAvailableError(error) && !this.shouldDeferMissingEngineSession(agent)) {
          this.markAgentSessionDead(agentId, error);
        }
      }
    }

    const fallbackOutput = agent.output || '';
    const fallbackPreview = agent.previewText || fallbackOutput.slice(-2000);
    const lastActivity = this.lastActivity.get(agentId) || Date.now();
    const terminalBusy = sessionState && typeof sessionState.terminalBusy === 'boolean'
      ? sessionState.terminalBusy
      : (typeof agent.terminalBusy === 'boolean' ? agent.terminalBusy : null);
    const shellCommand = sessionState && typeof sessionState.shellCommand === 'string'
      ? sessionState.shellCommand
      : (agent.shellCommand || '');
    const shellLastCommand = sessionState && typeof sessionState.shellLastCommand === 'string'
      ? sessionState.shellLastCommand
      : (agent.shellLastCommand || '');
    const shellCommandStartedAt = sessionState && Object.prototype.hasOwnProperty.call(sessionState, 'shellCommandStartedAt')
      ? finiteNumberOrNull(sessionState.shellCommandStartedAt)
      : finiteNumberOrNull(agent.shellCommandStartedAt);
    const shellLastCommandStartedAt = sessionState && Object.prototype.hasOwnProperty.call(sessionState, 'shellLastCommandStartedAt')
      ? finiteNumberOrNull(sessionState.shellLastCommandStartedAt)
      : finiteNumberOrNull(agent.shellLastCommandStartedAt);
    const shellLastCommandFinishedAt = sessionState && Object.prototype.hasOwnProperty.call(sessionState, 'shellLastCommandFinishedAt')
      ? finiteNumberOrNull(sessionState.shellLastCommandFinishedAt)
      : finiteNumberOrNull(agent.shellLastCommandFinishedAt);
    const shellLastCommandDurationMs = sessionState && Object.prototype.hasOwnProperty.call(sessionState, 'shellLastCommandDurationMs')
      ? finiteNumberOrNull(sessionState.shellLastCommandDurationMs)
      : finiteNumberOrNull(agent.shellLastCommandDurationMs);
    const previewText = (sessionState && typeof sessionState.previewText === 'string') ? sessionState.previewText : fallbackPreview;
    const sessionTitle = (sessionState && typeof sessionState.title === 'string' && sessionState.title) || agent.sessionTitle || '';
    const sessionStatus = sessionState && typeof sessionState.status === 'string'
      ? sessionState.status
      : terminalRuntimeStatus(agent.status);
    const terminalStatus = (sessionState && sessionState.terminalStatus) || deriveAgentTerminalStatus(agent, {
      terminalBusy,
      status: String(sessionStatus || ''),
      title: sessionTitle,
      previewText,
      cwd: (sessionState && sessionState.terminalStatus && sessionState.terminalStatus.cwd) || agent.shellCwd || agent.cwd,
      shellCommand,
      shellLastCommand,
      shellCommandStartedAt,
      shellLastCommandStartedAt,
      shellLastCommandFinishedAt,
      shellLastCommandDurationMs,
    });

    const now = Date.now();
    const isMain = this.isMainAgentRecord(agent.id, agent);
    return {
      agentId: agent.id,
      command: agent.command,
      engineName: agent.engineName || '',
      cwd: agent.cwd,
      projectWorkspace: agent.projectWorkspace || '',
      gitWorktree: publicAgentGitWorktree(agent),
      status: sessionState && sessionState.status === 'exited'
        ? agent.status
        : (isLiveEngineSessionState(sessionState) ? 'running' : agent.status),
      terminalBusy,
      terminalStatus,
      shellCommand,
      shellLastCommand,
      shellCommandStartedAt,
      shellLastCommandStartedAt,
      shellLastCommandFinishedAt,
      shellLastCommandDurationMs,
      parentAgentId: agent.parentAgentId || '',
      task: agent.task || '',
      workflowTemplate: agent.workflowTemplate || '',
      source: agent.source || '',
      providerSessionProvider: agent.providerSessionProvider || '',
      providerHomeId: agent.providerHomeId || '',
      providerHomePath: agent.providerHomePath || '',
      providerSessionId: agent.providerSessionId || '',
      providerSessionKey: agent.providerSessionKey || '',
      providerSessionTemporary: agent.providerSessionTemporary === true,
      providerSessionSource: agent.providerSessionSource || '',
      providerSessionResolvedAt: agent.providerSessionResolvedAt || null,
      providerSessionTitle: agent.providerSessionTitle || '',
      providerSessionWorkspace: agent.providerSessionWorkspace || '',
      terminalInputReceived: agent.terminalInputReceived === true,
      runtimeBinding: publicRuntimeBinding(agent),
      forkedFromProviderSessionId: agent.forkedFromProviderSessionId || '',
      customTitle: agent.customTitle || '',
      adaptiveTitle: agent.adaptiveTitle || '',
      pinned: agent.pinned === true,
      projectOrder: finiteOrder(agent.projectOrder),
      pinnedOrder: finiteOrder(agent.pinnedOrder),
      attentionSeq: finiteNonNegativeInteger(agent.attentionSeq),
      readAttentionSeq: finiteNonNegativeInteger(agent.readAttentionSeq),
      attentionUpdatedAt: finiteNumberOrNull(agent.attentionUpdatedAt),
      readAttentionAt: finiteNumberOrNull(agent.readAttentionAt),
      attentionReason: agent.attentionReason || '',
      attentionSummary: agent.attentionSummary || '',
      attentionOutputEpoch: agent.attentionOutputEpoch || '',
      attentionOutputSeq: finiteNumberOrNull(agent.attentionOutputSeq),
      readOutputEpoch: agent.readOutputEpoch || '',
      readOutputSeq: finiteNumberOrNull(agent.readOutputSeq),
      unread: agentAttentionUnread(agent),
      archived: agent.archived === true,
      archivedAt: agent.archivedAt || null,
      sessionSource: this.getEngineSessionSource(agent.engineName),
      runtimeEpoch: sessionState && typeof sessionState.runtimeEpoch === 'string'
        ? sessionState.runtimeEpoch
        : (agent.runtimeEpoch || ''),
      outputSeq: sessionState && Number.isFinite(sessionState.outputSeq) ? sessionState.outputSeq : null,
      stateRevision: sessionState && Number.isFinite(sessionState.stateRevision)
        ? sessionState.stateRevision
        : null,
      isMain,
      activityLevel: isMain ? 'warm' : this.calculateActivityLevel(lastActivity, now),
      lastActivity,
      attentionScore: isMain ? 0 : this.calculateAttentionScore(agentId, now),
      isZombie: isMain ? false : this.isZombie(agentId, now),
      startedAt: (sessionState && sessionState.startedAt) || agent.startedAt || null,
      exitedAt: (sessionState && sessionState.exitedAt) || agent.exitedAt || null,
      sessionTitle,
      output: (sessionState && typeof sessionState.output === 'string') ? sessionState.output : fallbackOutput,
      renderOutput: (sessionState && typeof sessionState.renderOutput === 'string') ? sessionState.renderOutput : fallbackOutput,
      previewText,
      codexTerminalProfile: activeCodexTerminalProfile(agent, previewText),
      previewSnapshot: (sessionState && sessionState.previewSnapshot) || agent.previewSnapshot || null,
      previewCols: (sessionState && Number.isFinite(sessionState.previewCols) && sessionState.previewCols > 0)
        ? sessionState.previewCols
        : (agent.previewCols || 80),
      previewRows: (sessionState && Number.isFinite(sessionState.previewRows) && sessionState.previewRows > 0)
        ? sessionState.previewRows
        : (agent.previewRows || 30),
      usageRate: this.getAgentUsageRate(agent.id),
    };
  }

  recordAgentOutputActivity(agentId: AgentId, bytes: number, timestamp = Date.now()) {
    this.usageRateTracker.record(agentId, bytes, timestamp);
  }

  getAgentUsageRate(agentId: AgentId, options: UsageRateOptions = {}): AgentUsageRate {
    return this.usageRateTracker.getRate(agentId, options);
  }

  calculateAgentUsageRate(agentId: AgentId, options: UsageRateOptions = {}): AgentUsageRate {
    return this.usageRateTracker.calculateRate(agentId, options);
  }

  getAgentUsageSnapshots(options: UsageRateOptions = {}) {
    const now = options.now || Date.now();
    const windowMs = agentUsageRateWindowMs(options.windowMs);
    const agents = Array.from(this.agents.values())
      .filter((value: unknown): value is TypedAgentRecord => isRecord(value) && typeof value.id === 'string')
      .map((agent: TypedAgentRecord) => ({
      agentId: agent.id,
      command: agent.command,
      cwd: agent.cwd,
      isMain: this.isMainAgentRecord(agent.id, agent),
      status: agent.status,
      usageRate: this.getAgentUsageRate(agent.id, { now, windowMs }),
      }));
    const totalOutputBytes = agents.reduce((sum: number, agent) => sum + agent.usageRate.outputBytes, 0);
    const estimatedOutputTokens = agents.reduce((sum: number, agent) => sum + agent.usageRate.estimatedOutputTokens, 0);
    const windowMinutes = Math.max(1, windowMs / 60_000);

    return {
      windowMs,
      sampledAt: now,
      source: 'terminal-output-estimate',
      totalOutputBytes,
      estimatedOutputTokens,
      estimatedTokensPerMinute: Math.round((estimatedOutputTokens / windowMinutes) * 10) / 10,
      agents,
    };
  }

  emitStateChange(change: AgentManagerStateChange) {
    this.emit('update', {
      ...(change.agentIds?.length ? { agentIds: [...new Set(change.agentIds)] } : {}),
      ...(change.removedAgentIds?.length ? { removedAgentIds: [...new Set(change.removedAgentIds)] } : {}),
      ...(change.mainAgentIdChanged === true ? { mainAgentIdChanged: true } : {}),
      ...(change.taskHistoryChanged === true ? { taskHistoryChanged: true } : {}),
    } satisfies AgentManagerStateChange);
  }

  getAgentState(agentId: AgentId, now = Date.now()): AgentPublicState | null {
    const agent = this.agents.get(agentId);
    if (!agent) return null;
    const lastActivity = this.lastActivity.get(agentId) || now;
    const isMain = this.isMainAgentRecord(agentId, agent);
    const terminalBusy = typeof agent.terminalBusy === 'boolean' ? agent.terminalBusy : null;
    const terminalStatus = deriveAgentTerminalStatus(agent, {
      terminalBusy,
      status: String(terminalRuntimeStatus(agent.status) || ''),
      title: agent.sessionTitle || '',
      previewText: agent.previewText || '',
    });
    const codexTerminalProfile = activeCodexTerminalProfile(agent, agent.previewText || '') || null;
    this.terminalStatusProjections.set(agent, terminalStatus);
    this.codexTerminalProfileProjections.set(agent, codexTerminalProfile);

    return {
      id: agent.id,
      command: agent.command,
      engineName: agent.engineName || '',
      cwd: agent.cwd,
      projectWorkspace: canonicalWorkspacePath(agent.projectWorkspace || ''),
      gitWorktree: publicAgentGitWorktree(agent),
      output: (agent.output || '').slice(-2000),
      previewText: agent.previewText || '',
      codexTerminalProfile,
      previewCols: agent.previewCols || 80,
      previewRows: agent.previewRows || 30,
      sessionTitle: agent.sessionTitle || '',
      sessionSource: this.getEngineSessionSource(agent.engineName),
      runtimeEpoch: agent.runtimeEpoch || '',
      outputSeq: finiteNumberOrNull(agent.lastOutputSeq),
      stateRevision: finiteNumberOrNull(agent.stateRevision),
      status: agent.status,
      terminalBusy,
      terminalStatus,
      shellCommand: agent.shellCommand || '',
      shellLastCommand: agent.shellLastCommand || '',
      shellCommandStartedAt: finiteNumberOrNull(agent.shellCommandStartedAt),
      shellLastCommandStartedAt: finiteNumberOrNull(agent.shellLastCommandStartedAt),
      shellLastCommandFinishedAt: finiteNumberOrNull(agent.shellLastCommandFinishedAt),
      shellLastCommandDurationMs: finiteNumberOrNull(agent.shellLastCommandDurationMs),
      isMain,
      parentAgentId: agent.parentAgentId || '',
      task: agent.task || '',
      workflowTemplate: agent.workflowTemplate || '',
      source: agent.source || '',
      providerSessionProvider: agent.providerSessionProvider || '',
      providerHomeId: agent.providerHomeId || '',
      providerHomePath: agent.providerHomePath || '',
      providerSessionId: agent.providerSessionId || '',
      providerSessionKey: agent.providerSessionKey || '',
      providerSessionTemporary: agent.providerSessionTemporary === true,
      providerSessionSource: agent.providerSessionSource || '',
      providerSessionResolvedAt: agent.providerSessionResolvedAt || null,
      providerSessionTitle: agent.providerSessionTitle || '',
      providerSessionWorkspace: agent.providerSessionWorkspace || '',
      providerCapabilities: {
        ...providerCapabilities(agent.providerSessionProvider),
        supportsSteer: runtimeBindingOf(agent, 'acp')?.supportsSteer === true,
      },
      terminalInputReceived: agent.terminalInputReceived === true,
      runtimeBinding: publicRuntimeBinding(agent),
      runtimeObservation: deriveRuntimeObservation(agent),
      lifecycleOperation: publicActiveLifecycleOperation(agent),
      requiresProcessExitAcknowledgement:
        agent.requiresProcessExitAcknowledgement === true,
      forkedFromProviderSessionId: agent.forkedFromProviderSessionId || '',
      restartedFromAgentId: agent.restartedFromAgentId || '',
      restartedFromAgentIds: Array.isArray(agent.restartedFromAgentIds) ? agent.restartedFromAgentIds : [],
      launchPermissionMode: agent.launchPermissionMode || '',
      customTitle: agent.customTitle || '',
      adaptiveTitle: agent.adaptiveTitle || '',
      pinned: agent.pinned === true,
      projectOrder: finiteOrder(agent.projectOrder),
      pinnedOrder: finiteOrder(agent.pinnedOrder),
      attentionSeq: finiteNonNegativeInteger(agent.attentionSeq),
      readAttentionSeq: finiteNonNegativeInteger(agent.readAttentionSeq),
      attentionUpdatedAt: finiteNumberOrNull(agent.attentionUpdatedAt),
      readAttentionAt: finiteNumberOrNull(agent.readAttentionAt),
      attentionReason: agent.attentionReason || '',
      attentionSummary: agent.attentionSummary || '',
      attentionOutputEpoch: agent.attentionOutputEpoch || '',
      attentionOutputSeq: finiteNumberOrNull(agent.attentionOutputSeq),
      readOutputEpoch: agent.readOutputEpoch || '',
      readOutputSeq: finiteNumberOrNull(agent.readOutputSeq),
      unread: agentAttentionUnread(agent),
      archived: agent.archived === true,
      archivedAt: agent.archivedAt || null,
      canForkNewWorktree: this.canCreateForkWorktree(effectiveAgentWorkspaceRoot(agent)),
      startedAt: agent.startedAt || null,
      exitedAt: agent.exitedAt || null,
      activityLevel: isMain ? 'warm' : this.calculateActivityLevel(lastActivity, now),
      lastActivity,
      attentionScore: isMain ? 0 : this.calculateAttentionScore(agentId, now),
      isZombie: isMain ? false : this.isZombie(agentId, now),
      usageRate: this.getAgentUsageRate(agentId, { now }),
    };
  }

  getStateMetadata(): Omit<AgentManagerState, 'agents'> {
    return {
      mainAgentId: this.mainAgentId,
      taskHistory: this.taskHistory,
    };
  }
  
  getState(): AgentManagerState {
    const state: AgentManagerState = {
      ...this.getStateMetadata(),
      agents: [],
    };

    const now = Date.now();
    for (const id of this.agents.keys()) {
      const agentState = this.getAgentState(id, now);
      if (agentState) state.agents.push(agentState);
    }
    
    return state;
  }
  
  calculateActivityLevel(lastActivity: number, now: number): 'hot' | 'warm' | 'cool' | 'cold' {
    const secondsSinceActivity = (now - lastActivity) / 1000;

    if (secondsSinceActivity < ACTIVITY_HOT_SEC) return 'hot';
    if (secondsSinceActivity < ACTIVITY_WARM_SEC) return 'warm';
    if (secondsSinceActivity < ACTIVITY_COOL_SEC) return 'cool';
    return 'cold';
  }

  isZombie(agentId: AgentId, now: number) {
    const agent = this.agents.get(agentId);
    if (!agent || agent.status !== 'running') return false;
    if (this.isMainAgentRecord(agentId, agent)) return false;
    const acpState = String(runtimeBindingOf(agent, 'acp')?.state || '');
    if ([
      'connecting',
      'working',
      'waiting-for-permission',
      'waiting-for-input',
      'interrupting',
      'reconnecting',
    ].includes(acpState)) return false;
    const lastAct = this.lastActivity.get(agentId) || now;
    return now - lastAct > ZOMBIE_IDLE_MS;
  }

  calculateAttentionScore(agentId: AgentId, now: number) {
    const agent = this.agents.get(agentId);
    if (!agent) return 0;
    if (this.isMainAgentRecord(agentId, agent)) return 0;

    let score = 0;
    const lastAct = this.lastActivity.get(agentId) || now;
    const secsSinceActivity = (now - lastAct) / 1000;

    // Status weight (0-20)
    if (agent.status === 'running') score += 20;
    else if (agent.status === 'pending') score += 15;
    else if (agent.status === 'stopped') score += 5;

    // Recency (0-40)
    if (secsSinceActivity < ACTIVITY_HOT_SEC) score += 40;
    else if (secsSinceActivity < ACTIVITY_WARM_SEC) score += 30;
    else if (secsSinceActivity < ACTIVITY_COOL_SEC) score += 15;

    // Output rate (0-30) — based on bounded one-second buckets from the last 30s
    const recentOutput = this.usageRateTracker.getActivityTotals(agentId, {
      cutoff: now - 30_000,
      inclusiveCutoff: false,
    });
    if (recentOutput.eventCount > 0) {
      const eventsPerSec = recentOutput.eventCount / 30;
      const bytesPerSec = recentOutput.bytes / 30;
      score += Math.min(30, Math.round(eventsPerSec * 6 + bytesPerSec / 50));
    }

    // Zombie penalty
    if (this.isZombie(agentId, now)) {
      score = Math.max(0, score - 10);
    }

    return Math.min(100, Math.max(0, score));
  }

  getUptime() {
    return Math.floor((Date.now() - this.startTime) / 1000);
  }
  
  onSystemStats(callback: (...args: unknown[]) => void) {
    this.on('system-stats', callback);
  }
  
  onUpdate(callback: (change: AgentManagerStateChange) => void) {
    this.on('update', callback);
  }

  onAgentActivity(callback: (...args: unknown[]) => void) {
    this.on('agent-activity', callback);
  }

  onSessionStream(callback: (...args: unknown[]) => void) {
    this.on('session-stream', callback);
  }

  onSessionPreview(callback: (...args: unknown[]) => void) {
    this.on('session-preview-update', callback);
  }

  getPreviewPayload(agentId: AgentId): UnknownRecord | null {
    const agent = this.agents.get(agentId);
    if (!agent || (!agent.previewText && !agent.previewSnapshot)) return null;
    const terminalStatus = deriveAgentTerminalStatus(agent, {
      previewText: agent.previewText || '',
      title: agent.sessionTitle || '',
      terminalBusy: typeof agent.terminalBusy === 'boolean' ? agent.terminalBusy : null,
    });
    return {
      agentId: agent.id,
      previewText: agent.previewText || '',
      cols: agent.previewCols || 80,
      rows: agent.previewRows || 30,
      previewSnapshot: agent.previewSnapshot || null,
      codexTerminalProfile: activeCodexTerminalProfile(agent, agent.previewText || ''),
      terminalStatus,
      runtimeObservation: deriveRuntimeObservation({ ...agent, terminalStatus }),
    };
  }

  getPreviewPayloads(): UnknownRecord[] {
    const previews: UnknownRecord[] = [];
    for (const agentId of this.agents.keys()) {
      const preview = this.getPreviewPayload(agentId);
      if (preview) previews.push(preview);
    }
    return previews;
  }
}

export {
  AgentManager,
  AGENT_USAGE_RATE_WINDOW_MS,
  SESSION_OUTPUT_LIMIT,
  ZOMBIE_IDLE_MS,
  trimSessionOutput,
};

Object.assign(AgentManager, {
  AgentManager,
  AGENT_USAGE_RATE_WINDOW_MS,
  SESSION_OUTPUT_LIMIT,
  ZOMBIE_IDLE_MS,
  trimSessionOutput,
});
