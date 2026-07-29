export type ProviderId = 'codex' | 'claude' | 'opencode' | 'qoder' | string;
export type StructuredRuntimeKind = 'acp' | 'json' | 'terminal';
export type AcpConfigValue = string | number | boolean | null | string[];

export interface ProviderCapabilities extends Record<string, unknown> {
  supportsChat?: boolean;
  supportsTerminal?: boolean;
  supportsFork?: boolean;
}

export interface ProviderAcpDescriptor extends Record<string, unknown> {
  version: string;
  packageName?: string;
}

export interface ProviderAdapter extends Record<string, unknown> {
  id: ProviderId;
  displayName: string;
  executable: string;
  interruptInput?: string;
  acp?: ProviderAcpDescriptor;
  capabilities?: ProviderCapabilities;
  terminalResumeArgs?: (args: string[], sessionId: string) => string[];
  planSession?: (rawArgs: string[], launchArgs: string[]) => ProviderSessionPlanFragment | null;
}

export interface ProviderSessionPlanFragment extends Record<string, unknown> {
  id?: string;
  precreate?: boolean;
  temporary?: boolean;
  source?: string;
  forkedFromProviderSessionId?: string;
  identityWorkspace?: string;
  resumeInsertIndex?: number | null;
  error?: string;
  args?: string[];
}

export interface AgentProviderSessionPlan {
  provider: ProviderId;
  id: string;
  providerHomeId?: string;
  precreate: boolean;
  temporary: boolean;
  source: string;
  forkedFromProviderSessionId: string;
  identityWorkspace?: string;
  resumeInsertIndex?: number | null;
  error?: string;
  args: string[];
}

export interface AgentProviderSessionPlanOptions {
  command?: string;
  program?: string;
  args?: string[];
  source?: string;
}

export interface ExactResumeSession {
  provider: ProviderId;
  providerHomeId: string;
  sessionId: string;
}

export type BuildAgentProviderSessionPlanContract = (
  options?: AgentProviderSessionPlanOptions,
) => AgentProviderSessionPlan;

export type SessionFromExactResumeSourceContract = (
  source: unknown,
) => ExactResumeSession | null;

export interface ProviderResumeOptions extends Record<string, unknown> {
  cwd?: string;
  providerHomePath?: string;
  fork?: boolean;
}

export interface ProviderHomeEntry {
  id: string;
  path: string;
}

export interface AgentHistoryQuery extends Record<string, unknown> {
  limit?: number;
  providerLimit?: number;
  scanLimit?: number;
  providerHomeId?: string;
  providerHomes?: Record<string, ProviderHomeEntry[]>;
}

export interface AgentHistorySession extends Record<string, unknown> {
  id?: string;
  sessionId?: string;
  provider?: ProviderId;
  providerHomeId?: string;
  providerHomePath?: string;
  cwd?: string;
  workspace?: string;
  title?: string;
  archived?: boolean;
  cliVersion?: string;
}

export interface ArchiveSessionPayload extends Record<string, unknown> {
  cwd?: string;
  workspace?: string;
  providerHomePath?: string;
  cliVersion?: string;
}

export interface ArchiveSessionResult extends Record<string, unknown> {
  archived?: boolean;
  error?: string;
}

export type FindAgentSessionContract = (
  provider: ProviderId,
  sessionId: string,
  options?: AgentHistoryQuery,
) => Promise<AgentHistorySession | null>;

export type ArchiveCodexSessionContract = (
  sessionId: string,
  payload: ArchiveSessionPayload,
) => Promise<ArchiveSessionResult | null>;

export type UnarchiveCodexSessionContract = ArchiveCodexSessionContract;

export interface AcpPermissionOption extends Record<string, unknown> {
  optionId: string;
  kind?: string;
  name?: string;
}

export interface AcpPermissionRequest extends Record<string, unknown> {
  requestId: string;
  sessionId?: string;
  options: AcpPermissionOption[];
}

export interface AcpElicitationRequest extends Record<string, unknown> {
  requestId: string;
  elicitationId?: string;
  sessionId?: string;
  mode?: 'form' | 'url' | string;
  requestedSchema?: Record<string, unknown>;
}

export interface AcpConfigOption extends Record<string, unknown> {
  id: string;
  type?: 'boolean' | 'select' | string;
  name?: string;
  category?: string;
  currentValue?: AcpConfigValue;
}

export interface AcpConfigChange {
  configId: string;
  value: AcpConfigValue;
}

export interface AcpPromptBlock extends Record<string, unknown> {
  type: string;
  text?: string;
  path?: string;
  terminalId?: string;
  terminal?: unknown;
}

export interface AcpTranscriptEntry extends Record<string, unknown> {
  id?: string;
  type?: string;
  title?: string;
  status?: string;
  content?: AcpPromptBlock[];
  _meta?: {
    subagent_session_info?: { session_id?: string };
    [key: string]: unknown;
  };
}

export interface AcpTranscriptSession extends Record<string, unknown> {
  version?: number;
  protocol?: 'acp';
  provider?: ProviderId;
  sessionId: string;
  cwd?: string;
  title?: string;
  revision?: number;
  updatedAt?: string;
  truncated?: boolean;
  entries: AcpTranscriptEntry[];
  configOptions?: AcpConfigOption[];
}

export interface AcpRuntimeEvent extends Record<string, unknown> {
  agentId: string;
  state?: string;
  error?: string;
  sessionId?: string;
  stopReason?: string;
  supportsSteer?: boolean;
  supportsFork?: boolean;
  pendingPermission?: AcpPermissionRequest | null;
  pendingPermissions?: AcpPermissionRequest[];
  pendingElicitation?: AcpElicitationRequest | null;
  pendingElicitations?: AcpElicitationRequest[];
  activeElicitations?: AcpElicitationRequest[];
  updatedAt?: string;
}

export interface AcpSessionEvent extends Record<string, unknown> {
  agentId: string;
  revision?: number;
  title?: string;
}

export interface AcpSessionRequestOptions extends Record<string, unknown> {
  cwd: string;
  additionalDirectories: string[];
  mcpServers: Record<string, unknown>[];
}

export interface AcpPrepareOptions extends Record<string, unknown> {
  agentId: string;
  provider: ProviderId;
  cwd?: string;
  sessionId?: string;
  historyMode?: 'checkpoint' | 'load' | 'resume' | string;
  additionalDirectories?: string[];
  mcpServers?: Record<string, unknown>[];
  forkSourceSessionId?: string;
  forkSourceCheckpoint?: AcpBindingCheckpoint | null;
  onForkSessionCreated?: (sessionId: string) => Promise<void> | void;
  onProcessStarted?: (identity: AcpProcessIdentity) => Promise<void> | void;
}

export interface AcpPrepareResult extends Record<string, unknown> {
  sessionId: string;
  historyMode: string;
  protocolVersion?: number;
  capabilities?: Record<string, unknown>;
}

export interface AcpProcessIdentity {
  pid: number;
  processGroupId: number;
  startedAt: string;
}

export interface PersistedAcpProcessIdentity extends AcpProcessIdentity {
  kind?: 'acp-process-group';
}

export interface StopPersistedAcpProcessResult extends Record<string, unknown> {
  stopped: boolean;
  alreadyExited?: boolean;
  missingProof?: boolean;
  identityMismatch?: boolean;
  timedOut?: boolean;
}

export type StopPersistedAcpProcessGroupContract = (
  identity: PersistedAcpProcessIdentity,
) => Promise<StopPersistedAcpProcessResult>;

export interface ProviderSessionIdentityRequest extends Record<string, unknown> {
  provider: ProviderId;
  executable?: string;
  env?: NodeJS.ProcessEnv;
  cwd: string;
  providerHomeId?: string;
  approvalMode?: string;
  model?: string;
  reasoningEffort?: string;
  serviceTier?: string;
  farmingSystemPrompt?: string;
  additionalDirectories?: string[];
  mcpServers?: Record<string, unknown>[];
}

export interface ProviderSessionIdentity extends Record<string, unknown> {
  provider?: ProviderId;
  executable?: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  sessionId: string;
  producerStopped?: boolean;
}

export interface ProviderSessionIdentityResult extends AcpPrepareResult {
  sessionRequestOptions?: AcpSessionRequestOptions;
}

export type CreateProviderSessionIdentityContract = (
  options: ProviderSessionIdentityRequest,
) => Promise<ProviderSessionIdentityResult>;

export type DeleteProviderSessionIdentityContract = (
  identity: ProviderSessionIdentity,
) => Promise<void>;

export interface AcpSubmitOptions extends Record<string, unknown> {
  delivery?: 'auto' | 'prompt' | 'steer';
  onSubmitted?: () => Promise<void> | void;
}

export interface AcpSubmitResult extends Record<string, unknown> {
  sessionId?: string;
  stopReason?: string;
  steered?: boolean;
  turnId?: string;
  clientMessageId?: string;
}

export interface AcpForkOptions extends Record<string, unknown> {
  sessionId?: string;
  cwd?: string;
  additionalDirectories?: string[];
  mcpServers?: Record<string, unknown>[];
  expectedRevision?: number;
  requireLoad?: boolean;
}

export interface AcpForkResult extends Record<string, unknown> {
  sessionId: string;
}

export interface AgentRecoveryRecord extends Record<string, unknown> {
  id?: string;
  runtimeAgentId?: string;
  runtimeBinding?: Record<string, unknown>;
  engine?: string;
  archived?: boolean;
  updatedAt?: number | string;
  wantsMain?: boolean;
  provider?: ProviderId;
  providerSessionProvider?: ProviderId;
  providerSessionId?: string;
  providerSessionKey?: string;
  providerHomeId?: string;
  providerHomePath?: string;
  providerSessionTemporary?: boolean;
  terminalInputReceived?: boolean;
  structuredRuntimeProcess?: PersistedAcpProcessIdentity | null;
  legacyAcpProcessExitAcknowledgedAt?: number | null;
  acpAdditionalDirectories?: string[];
  acpMcpServers?: Record<string, unknown>[];
  cwd?: string;
  pinned?: boolean;
  projectOrder?: number | null;
  pinnedOrder?: number | null;
  customTitle?: string;
  attentionSeq?: number;
  readAttentionSeq?: number;
  attentionUpdatedAt?: number | null;
  readAttentionAt?: number | null;
  attentionReason?: string;
  attentionOutputEpoch?: string;
  attentionOutputSeq?: number | null;
  readOutputEpoch?: string;
  readOutputSeq?: number | null;
}

export interface SerializedTerminalRecoveryState extends Record<string, unknown> {
  id: string;
  metadata?: AgentRecoveryRecord;
}

export interface NativeRuntimeRotationRecord extends Record<string, unknown> {
  serializedTerminalState?: string;
  previousGeneration?: number;
  nextGeneration?: number;
  reason?: string;
}

export interface NativeRuntimeRotationSummary extends Omit<NativeRuntimeRotationRecord, 'serializedTerminalState'> {
  serializedTerminalStateBytes: number;
}

export interface RuntimeRecoveryCleanupResult extends Record<string, unknown> {
  stopped: boolean;
  error?: string;
}

export interface AgentRestartResult extends Record<string, unknown> {
  error?: string;
  warning?: string;
  restarted?: boolean;
  restartedAgentId?: string;
  agentRuntimeMode?: StructuredRuntimeKind | string;
  switchFailed?: boolean;
  cleanupUncertain?: boolean;
}

export interface AgentForkResult extends Record<string, unknown> {
  error?: string;
  agentId?: string;
  retainedAgentId?: string;
  workspace?: string;
  mode?: 'same-worktree' | 'new-worktree' | string;
  targetRuntime?: 'chat' | 'terminal';
  providerSessionId?: string;
}

export interface TargetProcessAcpForkOptions {
  agent: Record<string, unknown> & { id: string };
  provider: ProviderId;
  sourceSessionId: string;
  workspace: string;
  expectedRevision: number;
  lifecycleToken: symbol;
  acpSessionOptions: AcpSessionRequestOptions;
  forkRequestId: string;
}

export interface AcpBindingCheckpoint extends Record<string, unknown> {
  version?: number;
  sessionState?: Record<string, unknown>;
  subagentStates?: Record<string, unknown>[];
  patchDecisions?: Record<string, unknown>[];
  providerProof?: Record<string, unknown>;
  complete?: boolean;
}

export interface AcpBindingContract {
  agentId: string;
  provider: ProviderId;
  sessionId: string;
  cwd: string;
}

export interface AcpBindingCheckpointView {
  exportCheckpoint(): AcpBindingCheckpoint;
}

export interface AcpSessionListOptions extends Record<string, unknown> {
  cwd?: string;
  cursor?: string;
  additionalDirectories?: string[];
}

export interface AcpSessionListResult extends Record<string, unknown> {
  sessions?: Array<Record<string, unknown> & { sessionId?: string }>;
  nextCursor?: string;
}

export interface AcpRuntimeContract {
  bindings: Map<string, AcpBindingContract>;
  on(event: 'agent-runtime', listener: (event: AcpRuntimeEvent) => void): this;
  on(event: 'session', listener: (event: AcpSessionEvent) => void): this;
  prepareAgent(options: AcpPrepareOptions): Promise<AcpPrepareResult>;
  createSessionIdentity(options: ProviderSessionIdentityRequest): Promise<ProviderSessionIdentityResult>;
  submitMessage(agentId: string, prompt: AcpPromptBlock[], options?: AcpSubmitOptions): Promise<AcpSubmitResult>;
  getSession(agentId: string, options?: Record<string, unknown>): AcpTranscriptSession;
  getTranscriptSession(agentId: string, options?: Record<string, unknown>): AcpTranscriptSession;
  getSubagentTranscriptSession(agentId: string, sessionId: string, options?: Record<string, unknown>): AcpTranscriptSession | null;
  getTranscriptEntry(agentId: string, entryId: string): AcpTranscriptEntry | null;
  getToolEntry(agentId: string, toolCallId: string): AcpTranscriptEntry | null;
  getSessionRequestOptions(agentId: string): AcpSessionRequestOptions;
  bindingCheckpoint(binding: AcpBindingContract): AcpBindingCheckpointView;
  runWithForkReservation<T>(
    agentId: string,
    options: AcpForkOptions,
    operation: (binding: AcpBindingContract) => Promise<T> | T,
  ): Promise<T>;
  forkSession(agentId: string, options?: AcpForkOptions): Promise<AcpForkResult>;
  listSessions(agentId: string, options?: AcpSessionListOptions): Promise<AcpSessionListResult>;
  respondPermission(agentId: string, requestId: string, optionId: string, cancelled?: boolean): unknown;
  respondElicitation(agentId: string, requestId: string, action: string, content: unknown): unknown;
  authenticate(agentId: string, methodId: string): Promise<unknown>;
  logout(agentId: string): Promise<unknown>;
  deleteSession(agentId: string, sessionId: string): Promise<unknown>;
  closeSession(agentId: string): Promise<unknown>;
  setSessionMode(agentId: string, modeId: string): Promise<unknown>;
  setSessionConfigOption(agentId: string, configId: string, value: AcpConfigValue): Promise<unknown>;
  setSessionConfigOptions(agentId: string, changes: AcpConfigChange[]): Promise<unknown>;
  killTerminal(agentId: string, terminalId: string): unknown;
  inputTerminal(agentId: string, terminalId: string, input: string): unknown;
  resizeTerminal(agentId: string, terminalId: string, cols: number, rows: number): unknown;
  cancelSubagent(agentId: string, sessionId: string): Promise<unknown>;
  decidePatch(agentId: string, toolCallId: string, requestedPath: string, decision: 'accept' | 'reject'): Promise<unknown>;
  cancel(agentId: string): Promise<unknown>;
  hasBinding(agentId: string): boolean;
  unregisterAgent(agentId: string): void;
  unregisterAgentAndWait(agentId: string): Promise<boolean>;
  dispose(): Promise<void>;
  resumeAfterDisposeAbort(): void;
}

export interface AcpRuntimeConstructorOptions extends Record<string, unknown> {
  configDir?: string;
  resolveLaunch?: (
    provider: ProviderId,
    options?: Record<string, unknown>,
  ) => { command: string; args: string[]; version?: string };
}

export interface ProviderSessionUpdateEvent extends Record<string, unknown> {
  agentId: string;
  provider: ProviderId;
  sessionId: string;
  previousSessionId?: string;
  temporary?: boolean;
  title?: string;
}

export interface ProviderSessionServiceChange extends Record<string, unknown> {
  kind?: 'known-session' | 'session-updated';
  event?: ProviderSessionUpdateEvent;
  refreshWorkspace?: string;
}

export interface ProviderSessionServiceContract {
  observe(agentId: string, options?: { force?: boolean }): Promise<boolean> | boolean;
  resolveTemporaryCodex(agentId: string, options?: { force?: boolean }): Promise<boolean>;
}

export interface AgentManagerProviderDependencies extends Record<string, unknown> {
  acpRuntime?: AcpRuntimeContract;
  createProviderSessionIdentity?: CreateProviderSessionIdentityContract;
  deleteProviderSessionIdentity?: DeleteProviderSessionIdentityContract;
  archiveCodexSession?: ArchiveCodexSessionContract;
  unarchiveCodexSession?: UnarchiveCodexSessionContract;
  stopPersistedAcpProcessGroup?: StopPersistedAcpProcessGroupContract;
  allowUnprovenLegacyAcpRecovery?: boolean;
  agentShellEnvProvider?: (shell: string) => NodeJS.ProcessEnv;
}

export interface AgentShellEnvOptions {
  force?: boolean;
  maxAgeMs?: number;
}

export interface AgentDisposeOptions {
  preserveTerminalHost?: boolean;
}

export interface ProviderStartOptions extends Record<string, unknown> {
  acpForkSourceCheckpoint?: AcpBindingCheckpoint | null;
  acpForkSourceSessionId?: string;
  acpHistoryMode?: 'checkpoint' | 'load' | 'resume';
  acpStartFresh?: boolean;
  additionalDirectories?: string[];
  agentRuntimeMode?: 'terminal' | 'acp' | 'chat' | 'json';
  allowLegacyJsonRuntime?: boolean;
  claudePermissionMode?: string;
  codexApprovalMode?: string;
  codexModel?: string;
  codexReasoningEffort?: string;
  codexServiceTier?: string;
  customTitle?: string;
  customTitleExplicit?: boolean;
  dangerouslySkipPermissions?: boolean;
  forkRequestId?: string;
  forkedFromProviderSessionId?: string;
  lifecycleToken?: symbol;
  mcpServers?: Record<string, unknown>[];
  onAcpForkSessionCreated?: (sessionId: string) => Promise<void> | void;
  onAcpSessionPrepared?: (prepared: AcpPrepareResult) => Promise<void> | void;
  parentAgentId?: string;
  preserveProviderSessionProfile?: boolean;
  projectWorkspace?: string;
  providerHomeId?: string;
  providerHomePath?: string;
  providerSessionId?: string;
  providerSessionProvider?: string;
  providerSessionTitle?: string;
  requiredCliVersion?: string;
  restoreRuntimeAgentIdOnFailure?: string;
  reviveTerminalState?: unknown;
  runtimeAgentId?: string;
  skipRecoveryWait?: boolean;
  source?: string;
  startAdmissionToken?: symbol;
  task?: string;
  wantsMain?: boolean;
  workflowTemplate?: string;
}

export interface AgentStartOutcome {
  agentId: string | null;
  error: string | null;
  metadata?: Record<string, unknown>;
}

export interface AgentStartReservation {
  promise: Promise<AgentStartOutcome>;
}

export interface AgentStartAdmission {
  token: symbol;
  promise: Promise<void>;
  workspaceKey: string;
}

export interface CreateRequestAdmission {
  signature: string;
  promise: Promise<AgentStartOutcome>;
}

export interface ProviderSessionRollbackIdentity extends ProviderSessionIdentity {
  sessionKey: string;
}

export interface RuntimeBindingRegistry {
  bindings: Map<string, unknown>;
  dispose(): Promise<void>;
  resumeAfterDisposeAbort?(): void;
}

export interface RuntimeLifecycleEntry extends Record<string, unknown> {
  token?: symbol;
  promise?: Promise<unknown>;
}

export interface AcpTranscriptHelpersContract {
  entries(entries: AcpTranscriptEntry[], options?: { mediaPathPrefix?: string }): AcpTranscriptEntry[];
  media(entry: AcpTranscriptEntry, mediaId: string): unknown | null;
  toolDetail(entry: AcpTranscriptEntry): unknown;
  toolChanges(entry: AcpTranscriptEntry): unknown[];
  toolReviewChanges(entry: AcpTranscriptEntry): unknown[];
}
