export type AgentId = string;
export type LifecycleOperationId = string;
export type LifecycleRequestKey = string;

export interface ErrorLike {
  cause?: unknown;
  code?: string;
  message: string;
  name?: string;
  retryable?: boolean;
  statusCode?: number;
  uncertain?: boolean;
}

export type LifecycleOperationType =
  | 'create'
  | 'update'
  | 'delete'
  | 'archive'
  | 'fork';

export type LifecycleOperationState =
  | 'intent'
  | 'pending'
  | 'runtime-pending'
  | 'membership-pending'
  | 'provider-archive-pending'
  | 'blocked'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

export interface LifecyclePreviousState {
  acpAdditionalDirectories?: readonly string[];
  acpConfigOverrides?: readonly {
    configId: string;
    value: string | number | boolean | null | string[];
  }[];
  acpMcpServers?: readonly unknown[];
  adaptiveTitle?: string;
  archived?: boolean;
  customTitle?: string;
  runtimeAgentId?: string;
  task?: string;
  visibleOnMainPage?: boolean;
}

export interface LifecycleOperationRequest {
  [field: string]: unknown;
  force?: boolean;
  previousRuntimeAgentId?: string;
  previousState?: LifecyclePreviousState;
  signature?: string;
  workspace?: string;
}

export interface LifecycleOperationResult {
  [field: string]: unknown;
  agentId?: AgentId;
  archived?: boolean;
  error?: string;
  operationId?: LifecycleOperationId;
  requestId?: string;
  retryable?: boolean;
  stopped?: boolean;
  uncertain?: boolean;
}

export interface LifecycleOperation<
  Request extends LifecycleOperationRequest = LifecycleOperationRequest,
  Result extends LifecycleOperationResult = LifecycleOperationResult,
> {
  error: string;
  finishedAt: number | null;
  id: LifecycleOperationId;
  request: Request;
  requestKey: LifecycleRequestKey;
  result: Result | null;
  startedAt: number;
  state: LifecycleOperationState;
  type: LifecycleOperationType;
  updatedAt: number;
}

export interface LifecycleJournal {
  entries: LifecycleOperation[];
  sequence: number;
}

export interface LifecycleJournalOwner {
  lifecycleJournal?: LifecycleJournal;
}

export interface LifecycleRecoveryContext {
  recoveredRuntimeAgentIds: ReadonlySet<AgentId>;
  recoveryStartedAt: number;
  serverGeneration?: string;
}

export type LifecycleRecoveryDisposition =
  | 'completed'
  | 'resumed'
  | 'rolled-back'
  | 'blocked'
  | 'unchanged';

export interface LifecycleRecoveryResult extends LifecycleOperationResult {
  disposition: LifecycleRecoveryDisposition;
  operation: LifecycleOperation;
  recoveredAgentId?: AgentId;
}

export interface BaseLifecycleOptions {
  lifecycleToken?: symbol;
  skipRecoveryWait?: boolean;
}

export interface CreateAgentOptions extends BaseLifecycleOptions {
  acpHistoryMode?: 'load' | 'resume';
  additionalDirectories?: readonly string[];
  agentRuntimeMode?: 'terminal' | 'chat' | 'acp';
  createRequestId?: string;
  customTitle?: string;
  dangerouslySkipPermissions?: boolean;
  mcpServers?: readonly unknown[];
  projectWorkspace?: string;
  providerHomeId?: string;
  providerSessionId?: string;
  providerSessionProvider?: string;
  startAdmissionToken?: symbol;
  task?: string;
  wantsMain?: boolean;
  workflowTemplate?: string;
}

export interface UpdateAgentOptions extends BaseLifecycleOptions {
  archived?: boolean;
  customTitle?: string;
  pinned?: boolean;
  readAttentionSeq?: number;
  readOutputEpoch?: string;
  readOutputSeq?: number;
  task?: string;
  unread?: boolean;
}

export interface DeleteAgentOptions extends BaseLifecycleOptions {
  acknowledgeUnprovenAcpExit?: boolean;
  completesBlockedCreate?: boolean;
  emitUpdate?: boolean;
  operationId?: string;
  persistentOperationId?: string;
  persistDeleteOperation?: boolean;
  reason?: string;
  recordHistory?: boolean;
  requireEngineExit?: boolean;
  retainAgentRecord?: boolean;
}

export interface ArchiveAgentOptions extends DeleteAgentOptions {
  scheduleProviderArchive?: boolean;
}

export type ForkMode = 'same-worktree' | 'new-worktree' | 'conversation';

export interface ForkAgentOptions extends BaseLifecycleOptions {
  expectedRevision?: number;
  forkRequestId?: string;
  providerHomeId?: string;
  requestId?: string;
  targetRuntime?: 'terminal' | 'chat' | 'acp';
}

export type KillAgentOptions = DeleteAgentOptions;

export interface LifecycleSuccessResult extends LifecycleOperationResult {
  agentId: AgentId;
  error?: undefined;
}

export interface LifecycleFailureResult extends LifecycleOperationResult {
  error: string;
}

export type CreateAgentResult = LifecycleSuccessResult | LifecycleFailureResult;

export interface UpdateAgentSuccessResult extends LifecycleSuccessResult {
  changed?: boolean;
  customTitle?: string;
  deduplicated?: boolean;
  requiresState?: boolean;
  task?: string;
}

export type UpdateAgentResult = UpdateAgentSuccessResult | LifecycleFailureResult;

export interface DeleteAgentResult extends LifecycleOperationResult {
  agentId?: AgentId;
  removed?: boolean;
  stopped?: boolean;
}

export interface ArchiveAgentResult extends DeleteAgentResult {
  archived?: boolean;
  providerArchived?: boolean;
  removedMainPageSessionKeys?: readonly string[];
  warning?: string;
}

export interface ForkAgentResult extends LifecycleOperationResult {
  agentId?: AgentId;
  childAgentId?: AgentId;
  retainedAgentId?: AgentId;
  retainedProviderSessionId?: string;
}

export interface KillAgentResult extends DeleteAgentResult {
  cleanupUncertain?: boolean;
  engineExited?: boolean;
  killed?: boolean;
  missing?: boolean;
  retained?: boolean;
  retainedAgentRecord?: boolean;
  warning?: string;
}

export interface AsyncOwner<Resource extends string = string> {
  generation: number;
  ownerId: string;
  resource: Resource;
}

export interface AsyncOwnershipLease<Resource extends string = string> {
  owner: AsyncOwner<Resource>;
  released: boolean;
  release(): void;
}

export interface AsyncOwnedOperation<Result, Resource extends string = string> {
  completion: Promise<Result>;
  key: string;
  owner: AsyncOwner<Resource>;
}

export type AsyncOperationAdmission<Result, Resource extends string = string> =
  | {
      accepted: true;
      joined: false;
      operation: AsyncOwnedOperation<Result, Resource>;
    }
  | {
      accepted: true;
      joined: true;
      operation: AsyncOwnedOperation<Result, Resource>;
    }
  | {
      accepted: false;
      conflict: AsyncOwnedOperation<unknown, Resource>;
      reason: string;
    };

export interface LifecycleRequest<Result extends LifecycleOperationResult> {
  completion: Promise<Result>;
  result: Result;
}
