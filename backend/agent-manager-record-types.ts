export type AgentId = string;
export type AgentRecordId = `agent_${string}` | `fsess_${string}`;
export type ProviderSessionKey = `agent-session:${string}:${string}`;

export type AgentRuntimeKind = 'terminal' | 'acp';

export interface TerminalRuntimeBinding {
  kind: 'terminal';
}

export interface AcpRuntimeBinding {
  activeElicitations: unknown[];
  error: string;
  kind: 'acp';
  pendingElicitation: unknown;
  pendingElicitations: unknown[];
  pendingPermission: unknown;
  pendingPermissions: unknown[];
  sessionRevision: number;
  sessionUpdatedAt: string;
  state: string;
  stopReason: string;
  supportsFork: boolean;
  supportsSteer: boolean;
}

export type RuntimeBinding = TerminalRuntimeBinding | AcpRuntimeBinding;

export interface ProviderSessionBinding {
  providerHomeId: string;
  providerHomePath: string;
  providerSessionId: string;
  providerSessionKey: string;
  providerSessionProvider: string;
  providerSessionResolvedAt: number | null;
  providerSessionSource: string;
  providerSessionTemporary: boolean;
  providerSessionTitle: string;
  providerSessionWorkspace: string;
}

export interface StructuredRuntimeProcessIdentity {
  kind: 'acp-process-group';
  pid: number;
  processGroupId: number;
  startedAt: string;
  configInstanceFingerprint?: string;
}

export interface AcpSessionStartBinding {
  additionalDirectories: string[];
  configOverrides: AcpSessionConfigOverride[];
  mcpServers: unknown[];
}

export interface AcpSessionConfigOverride {
  configId: string;
  value: string | number | boolean | null | string[];
}

export interface PersistedAcpSessionOptions {
  acpAdditionalDirectories?: string[];
  acpConfigOverrides?: AcpSessionConfigOverride[];
  acpMcpServers?: unknown[];
}

export interface WorktreeListEntry {
  bare: boolean;
  branch: string;
  current: boolean;
  detached: boolean;
  head: string;
  locked: boolean;
  lockReason: string;
  main: boolean;
  prunable: boolean;
  pruneReason: string;
  workspace: string;
}

export interface GitWorktreeRecord {
  branch: string;
  commonDir: string;
  detached: boolean;
  head: string;
  linked: boolean;
  locked: boolean;
  lockReason: string;
  mainWorkspace: string;
  prunable: boolean;
  pruneReason: string;
  workspace: string;
  worktrees: WorktreeListEntry[];
}

export interface WorkspaceIdentity {
  cwd: string;
  gitWorktree?: GitWorktreeRecord | null;
  mainWorkspace: string;
  projectWorkspace: string;
}

export interface AgentDisplayState {
  adaptiveTitle?: string;
  archived?: boolean;
  archivedAt?: number | null;
  customTitle?: string;
  pinned?: boolean;
  pinnedOrder?: number | null;
  projectOrder?: number | null;
  task?: string;
  title?: string;
  titleUserSpecified?: boolean;
  visibleOnMainPage?: boolean;
  workflowTemplate?: string;
}

export interface AgentAttentionState {
  attentionOutputEpoch?: string;
  attentionOutputSeq?: number | null;
  attentionReason?: string;
  attentionSeq?: number;
  attentionUpdatedAt?: number | null;
  readAttentionAt?: number | null;
  readAttentionSeq?: number;
  readOutputEpoch?: string;
  readOutputSeq?: number | null;
  unread?: boolean;
}

export interface AgentShellState {
  shellCommand?: string;
  shellCommandStartedAt?: number | null;
  shellCwd?: string;
  shellLastCommand?: string;
  shellLastCommandDurationMs?: number | null;
  shellLastCommandFinishedAt?: number | null;
  shellLastCommandStartedAt?: number | null;
  shellLastEvent?: string;
  shellLastExitCode?: number | null;
  terminalBusy?: boolean | null;
}

export interface ComposerCommandRecord {
  contentHash: string;
  createdAt: number;
  error: string;
  requestId: string;
  result: Record<string, unknown> | null;
  state: 'intent' | 'accepted' | 'unknown' | 'failed';
  updatedAt: number;
}

export interface AgentRecord extends Record<string, unknown>, AgentDisplayState, AgentAttentionState, AgentShellState {
  acpFinalizedTurnHandle?: string;
  agentRecordId?: string;
  browserCapabilityTokenHash?: string;
  capabilityRuntimeEpoch?: string;
  capabilityWorkspace?: string;
  category?: string;
  canForkNewWorktree?: boolean;
  command?: string;
  composerCommands?: ComposerCommandRecord[];
  computerCapabilityTokenHash?: string;
  cwd?: string;
  engineName?: string;
  engineStarted?: boolean;
  engineStatus?: string;
  exitedAt?: number | null;
  forkCommand?: string;
  forkRequestId?: string;
  forkedFromProviderSessionId?: string;
  gitWorktree?: GitWorktreeRecord | null;
  id: AgentId;
  launchPermissionMode?: string;
  lifecycleJournal?: LifecycleJournal;
  mainWorkspace?: string;
  output?: string;
  lastEngineOutputAt?: number;
  lastObservedTurnActive?: boolean;
  lastOutputSeq?: number | null;
  parentAgentId?: string;
  persistentSessionId?: string;
  previewCols?: number;
  previewRows?: number;
  previewSnapshot?: unknown;
  previewText?: string;
  projectWorkspace?: string;
  providerHomeId?: string;
  providerHomePath?: string;
  providerSessionId?: string;
  providerSessionKey?: string;
  providerSessionProvider?: string;
  providerSessionResolvedAt?: number | null;
  providerSessionSource?: string;
  providerSessionTemporary?: boolean;
  providerSessionTitle?: string;
  providerSessionWorkspace?: string;
  restartedFromAgentId?: string;
  restartedFromAgentIds?: string[];
  runtimeAgentId?: string;
  runtimeBinding?: RuntimeBinding;
  runtimeEpoch?: string;
  runtimeSwitchVerifiedSessionId?: string;
  sessionTitle?: string;
  source?: string;
  startedAt?: number | null;
  stateRevision?: number | null;
  status?: string;
  structuredRuntimeProcess?: StructuredRuntimeProcessIdentity | null;
  terminalInputReceived?: boolean;
  terminalDraftInputReceived?: boolean;
  titleUpdateToken?: string;
  attentionBaselineOutputAt?: number | null;
  attentionBaselineOutputSeq?: number | null;
  attentionRequiresNewOutput?: boolean;
  attentionSuppressUntil?: number;
  attentionTrackingReady?: boolean;
  validated?: boolean;
  wantsMain?: boolean;
}

export interface PersistedAgentPrivateMetadata extends Record<string, unknown>, PersistedAcpSessionOptions, AgentDisplayState, AgentAttentionState {
  acpFinalizedTurnHandle?: string;
  agentRecordId?: string;
  agentRecordVersion?: number;
  browserCapabilityTokenHash?: string;
  capabilityRuntimeEpoch?: string;
  capabilityWorkspace?: string;
  category?: string;
  command?: string;
  computerCapabilityTokenHash?: string;
  cwd?: string;
  forkCommand?: string;
  forkRequestId?: string;
  forkedFromProviderSessionId?: string;
  id: string;
  kind?: 'agent';
  launchPermissionMode?: string;
  lifecycleJournal?: LifecycleJournal;
  mainWorkspace?: string;
  parentAgentId?: string;
  persistentSessionId?: string;
  projectWorkspace?: string;
  providerHomeId?: string;
  providerHomePath?: string;
  providerSessionId?: string;
  providerSessionKey?: string;
  providerSessionProvider?: string;
  providerSessionResolvedAt?: number | null;
  providerSessionSource?: string;
  providerSessionTemporary?: boolean;
  providerSessionTitle?: string;
  providerSessionWorkspace?: string;
  restartedFromAgentId?: string;
  restartedFromAgentIds?: string[];
  engine?: string;
  legacyAcpProcessExitAcknowledgedAt?: number | null;
  requiresProcessExitAcknowledgement?: boolean;
  runtimeAgentId?: string;
  runtimeBinding?: RuntimeBinding;
  source?: string;
  startedAt?: number | null;
  structuredRuntimeProcess?: StructuredRuntimeProcessIdentity | null;
  terminalInputReceived?: boolean;
  updatedAt?: number;
  wantsMain?: boolean;
}

export interface PersistedAgentState extends Record<string, unknown>, AgentAttentionState {
  acpActiveElicitations?: unknown[];
  acpError?: string;
  acpPendingElicitation?: unknown;
  acpPendingElicitations?: unknown[];
  acpPendingPermission?: unknown;
  acpPendingPermissions?: unknown[];
  acpSessionRevision?: number;
  acpSessionUpdatedAt?: string;
  acpState?: string;
  acpStopReason?: string;
  agentRecordId: string;
  agentStateVersion: number;
  composerCommands?: ComposerCommandRecord[];
  jsonCliError?: string;
  jsonCliState?: string;
  jsonCliTranscriptUpdatedAt?: string;
}

export interface MainPageMembership {
  archived: boolean;
  providerSessionKey: string;
  visibleOnMainPage: boolean;
}

export interface MainPageSessionIndex {
  mainPageSessionKeys: string[];
  updatedAt: number;
  version: number;
}

export type ProjectOperationType = 'create-worktree' | 'delete-worktree';
export type ProjectOperationState = 'pending' | 'unknown' | 'succeeded' | 'failed' | 'blocked';

export interface ProjectOperationRequest extends Record<string, unknown> {
  branch?: string;
  sourceWorkspace?: string;
  workspace?: string;
}

export interface ProjectOperationResult extends Record<string, unknown> {
  branch?: string;
  requestId?: string;
  sourceWorkspace?: string;
  workspace?: string;
}

export interface ProjectOperation {
  error: string;
  finishedAt: number | null;
  id: string;
  request: ProjectOperationRequest;
  result: ProjectOperationResult | null;
  signature: string;
  startedAt: number;
  state: ProjectOperationState;
  type: ProjectOperationType;
  updatedAt: number;
}

export interface ProjectMembershipPatch {
  mountWorkspace?: string;
  pinnedProjectWorkspaces?: string[];
  projectWorkspaces?: string[];
  removeWorkspace?: string;
}

export interface CreatePermanentWorktreeOptions {
  requestId?: string;
}

export interface DeleteProjectWorktreeOptions {
  force?: boolean;
  requestId?: string;
}

export interface AgentHome {
  id: string;
  newAgentDefaults: {
    model: string;
    reasoning: string;
    fast: 'inherit' | 'on' | 'off';
  };
  order: number;
  path: string;
}

export interface AgentLaunchProfile extends Record<string, unknown> {
  approvalMode?: string;
  effort?: string;
  model?: string;
  modelPreset?: string;
  permissionMode?: string;
  reasoningEffort?: string;
  serviceTier?: string;
}

export interface AgentManagerSettings extends Record<string, unknown> {
  agentHomes: Record<string, AgentHome[]>;
  agentLaunchProfiles: Record<string, AgentLaunchProfile>;
  appearance: string;
  browserExecutablePath: string;
  browserExtensionEnabled: boolean;
  computerExtensionEnabled: boolean;
  computerCompatibilityMode: boolean;
  computerImage: string;
  browserExternalCdpUrl: string;
  browserSource: string;
  codexApprovalMode: string;
  codexModel: string;
  codexModelPreset: string;
  codexReasoningEffort: string;
  codexServiceTier: string;
  crtDynamicHeatEnabled: boolean;
  crtSkinEffectsEnabled: boolean;
  crtTerminalFontSize: number;
  dangerouslySkipAgentPermissionsByDefault: boolean;
  defaultLaunchAgent: string;
  heartbeatInterval: number;
  instanceName: string;
  language: string;
  lastMainWorkspace: string;
  mainPageSessionKeys?: string[];
  pinnedProjectWorkspaces: string[];
  projectNames: Record<string, string>;
  projectOperations?: Record<string, ProjectOperation>;
  projectWorkspaces: string[];
  restReminderIntervalSeconds: number | null;
  searchTimeoutMs: number;
  theme: unknown;
  version: string;
  workspace: string;
  workspaceHistory: string[];
}

export type RecoveredEngineSessionMetadata = Partial<PersistedAgentPrivateMetadata> & Record<string, unknown> & {
  engineName?: string;
  lastActivityAt?: number;
  provider?: string;
  runtimeAgentId?: string;
  sessionTitle?: string;
};

export interface RecoveredEngineSessionState extends Record<string, unknown> {
  cols?: number;
  lastActivityAt?: number;
  output?: string;
  outputSeq?: number;
  rows?: number;
  runtimeEpoch?: string;
  stateRevision?: number;
  status?: string;
}

export interface RecoveredEngineSession {
  engineName?: string;
  metadata?: RecoveredEngineSessionMetadata;
  sessionId?: string;
  state?: RecoveredEngineSessionState;
}

export interface SerializedTerminalRecoveryState extends Record<string, unknown> {
  id: string;
  metadata?: RecoveredEngineSessionMetadata;
}

export interface NativeRuntimeRotation extends Record<string, unknown> {
  controllerGeneration?: number;
  previousControllerGeneration?: number;
  serializedTerminalState?: string;
}

export interface TerminalRecoveryCandidate extends RecoveredEngineSessionMetadata {
  id: string;
  runtimeAgentId: string;
  serializedState?: SerializedTerminalStateEntry;
}

export interface AcpProcessCleanupResult {
  alreadyExited?: boolean;
  identityMismatch?: boolean;
  missingProof?: boolean;
  stopped: boolean;
  timedOut?: boolean;
}

export interface AgentLifecycleOperationAdmission<T = unknown> {
  agentIds: Set<AgentId>;
  agentId?: string;
  key: string;
  kind: string;
  label: string;
  promise: Promise<T>;
  token: symbol;
}

export interface AgentStartAdmission<T = unknown> {
  promise: Promise<T>;
  token: symbol;
  workspaceKey?: string;
}

export interface AgentStartOutcome {
  agentId: AgentId | null;
  error: string | null;
  metadata?: Record<string, unknown>;
}

export interface CreateRequestAdmission<T = AgentStartOutcome> {
  promise: Promise<T>;
  signature: string;
}

export interface ProjectOperationAdmission<T = unknown> {
  promise: Promise<T>;
  workspaceKey: string;
}

export interface ProjectWorkspaceDeleteAdmission<T = unknown> {
  promise: Promise<T>;
  requestId: string;
}

export interface CodexSessionMutationAdmission<T = unknown> {
  promise: Promise<T>;
  type: string;
}

export interface AgentManagerRecordCollections {
  acpSessionOptionsByKey: Map<string, AcpSessionStartBinding>;
  agentLifecycleOperations: Map<string, AgentLifecycleOperationAdmission>;
  agentStartAdmissions: Map<symbol, AgentStartAdmission>;
  agents: Map<AgentId, AgentRecord>;
  codexSessionMutationQueues: Map<string, CodexSessionMutationAdmission>;
  createRequestAdmissions: Map<string, CreateRequestAdmission>;
  projectOperationAdmissions: Map<string, ProjectOperationAdmission>;
  projectWorkspaceDeleteAdmissions: Map<string, ProjectWorkspaceDeleteAdmission>;
}

export interface AgentRecoveryIndexes {
  mainPageSessionKeys: Set<string>;
  persistedByRuntimeAgentId: Map<string, PersistedAgentPrivateMetadata>;
  recoveredRuntimeAgentIds: Set<string>;
  serializedByRuntimeAgentId: Map<string, SerializedTerminalRecoveryState>;
}

export interface AgentRecoveryEngineBridge {
  consumeRuntimeRotations?(): NativeRuntimeRotation[];
  killSession?(engineName: string, agentId: AgentId): Promise<unknown>;
  recoverSessions?(): Promise<RecoveredEngineSession[]>;
}

export interface GitWorktreePostcondition {
  branch: string;
  error: string;
  exists: boolean;
  proven: boolean;
  registered: boolean;
  workspace: string;
}

export interface CreatePermanentWorktreeResult extends ProjectOperationResult {
  branch: string;
  deduplicated?: boolean;
  pinnedProjectWorkspaces?: string[];
  projectWorkspaces?: string[];
  sourceWorkspace: string;
  workspace: string;
}

export interface DeleteProjectWorktreeResult extends ProjectOperationResult {
  archivedAgentIds?: string[];
  deduplicated?: boolean;
  deleted?: boolean;
  error?: string;
  forced?: boolean;
  pinnedProjectWorkspaces?: string[];
  projectWorkspaces?: string[];
  removedMainPageSessionKeys?: string[];
  retryable?: boolean;
  uncertain?: boolean;
  workspace: string;
}

export interface AgentManagerConfig {
  commitProjectOperation(
    operation: ProjectOperation,
    membership?: ProjectMembershipPatch,
  ): {
    operation: ProjectOperation;
    pinnedProjectWorkspaces: string[];
    projectWorkspaces: string[];
  };
  ensureAgentSessionRecord(agent: AgentRecord, patch?: Partial<PersistedAgentPrivateMetadata>): string;
  persistAgentAdaptiveTitle(agent: AgentRecord, title: string): Promise<string>;
  farmingDir?: string;
  getAgentSessionRecordForProviderSessionKey(sessionKey: string): PersistedAgentPrivateMetadata | null;
  getMainPageSessionKeys(): string[];
  getProjectOperation(requestId: unknown): ProjectOperation | null;
  getSettings(): AgentManagerSettings;
  listAgentSessionRecords(): PersistedAgentPrivateMetadata[];
  rememberAgentSessionRecord(agent: AgentRecord): string;
  rememberMainPageSessionKey(sessionKey: string, patch?: Partial<MainPageMembership>): string[];
  removeMainPageSessionKey(sessionKey: string): boolean;
  removeMainPageSessionKeys(keys: unknown): string[];
  setMainPageSessionKeys(keys: unknown): string[];
  setProviderSessionDisplayState(sessionKey: string, patch?: Partial<AgentDisplayState>): string;
  updateSettings(patch: Partial<AgentManagerSettings>): void;
}
import type {
  LifecycleJournal,
  LifecycleOperation,
  LifecycleOperationRequest,
  LifecycleOperationResult,
  LifecycleOperationState,
  LifecycleOperationType,
  LifecyclePreviousState,
} from './agent-manager-lifecycle-types.js';
import type { SerializedTerminalStateEntry } from './agent-manager-engine-types.js';

export type {
  LifecycleJournal,
  LifecycleOperation,
  LifecycleOperationRequest,
  LifecycleOperationResult,
  LifecycleOperationState,
  LifecycleOperationType,
  LifecyclePreviousState,
} from './agent-manager-lifecycle-types.js';
