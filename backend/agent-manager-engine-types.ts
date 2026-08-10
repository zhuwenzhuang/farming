import type { LifecycleJournal } from './agent-manager-lifecycle-types.js';
import type { TerminalStartupCoordinator } from './terminal-startup-coordinator.cjs';

type MaybePromise<Value> = Value | Promise<Value>;
type TerminalInput = string | readonly unknown[];
type TerminalSessionStatus = 'running' | 'stopping' | 'stopped' | 'exited' | 'dead';
type TerminalTransitionKind = 'clear' | 'resize';

interface RuntimeEpochOptions {
  expectedRuntimeEpoch?: string;
}

interface RuntimeEngineMetadata extends Record<string, unknown> {
  adaptiveTitle?: string;
  agentId?: string;
  attentionOutputEpoch?: string;
  attentionOutputSeq?: number | null;
  attentionReason?: string;
  attentionSeq?: number;
  attentionSummary?: string;
  attentionUpdatedAt?: number | null;
  category?: string;
  command?: string;
  customTitle?: string;
  cwd?: string;
  engineName?: string;
  forkCommand?: string;
  forkRequestId?: string;
  forkRequestSignature?: string;
  forkedFromProviderSessionId?: string;
  launchPermissionMode?: string;
  lifecycleJournal?: LifecycleJournal;
  lastActivityAt?: number;
  mainWorkspace?: string;
  parentAgentId?: string;
  persistentSessionId?: string;
  pinned?: boolean;
  pinnedOrder?: number | null;
  projectOrder?: number | null;
  projectWorkspace?: string;
  provider?: string;
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
  readAttentionAt?: number | null;
  readAttentionSeq?: number;
  readOutputEpoch?: string;
  readOutputSeq?: number | null;
  restartedFromAgentId?: string;
  restartedFromAgentIds?: string[];
  source?: string;
  startedAt?: number | null;
  task?: string;
  terminalInputReceived?: boolean;
  wantsMain?: boolean;
  workflowTemplate?: string;
}

type RuntimeEngineMetadataPatch = Partial<RuntimeEngineMetadata> & Record<string, unknown>;

interface CreateTerminalSessionOptions {
  agentId: string;
  args?: string[];
  category?: string;
  cols?: number;
  command: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  metadata?: RuntimeEngineMetadata;
  reviveState?: unknown;
  rows?: number;
}

interface TerminalEngineLaunch {
  args?: string[];
  category?: string;
  command: string;
  cwd: string;
  reviveState?: SerializedTerminalStateEntry | null;
}

interface CreateTerminalSessionResult {
  sessionId: string;
  status: TerminalSessionStatus;
}

interface TerminalStateCursor {
  outputSeq: number;
  runtimeEpoch: string;
  stateRevision: number;
}

interface TerminalDimensions {
  cols: number;
  rows: number;
}

interface TerminalAttachCheckpoint extends TerminalStateCursor, TerminalDimensions {
  previewSnapshot: unknown;
  previewText: string;
  renderOutput: string;
  title: string;
}

interface TerminalStatusContract {
  activity: string;
  command?: string;
  cwd?: string;
  status?: string;
  title?: string;
}

interface TerminalSessionState {
  exitedAt: number | null;
  lastActivityAt: number;
  output: string;
  outputSeq: number | null;
  previewCols: number;
  previewRows: number;
  previewSnapshot: unknown;
  previewText: string;
  renderOutput: string;
  runtimeEpoch: string;
  sessionId: string;
  shellCwd: string;
  shellCommand: string;
  shellCommandStartedAt: number | null;
  shellLastCommand: string;
  shellLastCommandDurationMs: number | null;
  shellLastCommandFinishedAt: number | null;
  shellLastCommandStartedAt: number | null;
  shellLastEvent: string;
  shellLastExitCode: number | null;
  startedAt: number | null;
  stateProofAvailable: boolean;
  stateRevision: number | null;
  status: TerminalSessionStatus;
  terminalBusy: boolean | null;
  terminalStatus: TerminalStatusContract;
  title: string;
}

interface TerminalInputAcceptedResult {
  sent: true;
}

interface TerminalInputRejectedResult {
  reason: 'runtime-epoch-mismatch';
  status: 'input-rejected';
}

type TerminalInputResult = TerminalInputAcceptedResult | TerminalInputRejectedResult;

interface TerminalResizeCommittedResult extends Partial<TerminalStateCursor>, Partial<TerminalDimensions> {
  resized: true;
  status: 'resize-committed';
  unchanged: boolean;
}

interface TerminalResizeRejectedResult {
  error?: string;
  reason:
    | 'invalid-dimensions'
    | 'pty-resize-failed'
    | 'resize-failed'
    | 'runtime-rotation'
    | 'screen-reducer-failed'
    | 'session-replaced'
    | 'session-unavailable'
    | 'unsupported-engine'
    | 'unsupported-session';
  resized: false;
  status: 'resize-rejected';
}

type TerminalResizeResult = TerminalResizeCommittedResult | TerminalResizeRejectedResult;

interface TerminalClearCommittedResult extends TerminalStateCursor, TerminalDimensions {
  cleared: true;
}

interface TerminalClearRejectedResult {
  cleared: false;
  error?: string;
  reason?:
    | 'runtime-epoch-mismatch'
    | 'runtime-rotation'
    | 'session-replaced'
    | 'session-unavailable';
}

type TerminalClearResult = TerminalClearCommittedResult | TerminalClearRejectedResult;

interface TerminalKillResult {
  killed: boolean;
}

interface NativePtyHostRuntimeIdentity {
  buildId: string;
  protocolVersion: number;
  version: string;
}

interface NativeRuntimeRotationRecord {
  current: NativePtyHostRuntimeIdentity | null;
  previous: NativePtyHostRuntimeIdentity | null;
  previousPid: number | null;
  rotatedAt: number;
  serializedTerminalState: string;
}

interface RuntimeRotationRecord extends NativeRuntimeRotationRecord {
  engineName: string;
}

interface SerializedTerminalReplayEvent extends TerminalDimensions {
  data: string;
}

interface SerializedTerminalStateEntry {
  id: string;
  metadata: RuntimeEngineMetadata;
  processDetails: {
    cwd: string;
    title: string;
  };
  processLaunchConfig: {
    args: string[];
    category: string;
    command: string;
  };
  replayEvent: {
    events: [SerializedTerminalReplayEvent];
  };
  timestamp: number;
}

interface RecoveredEngineSession {
  agentId?: string;
  engineName: string;
  metadata: RuntimeEngineMetadata;
  sessionId?: string;
  state: TerminalSessionState;
}

interface TerminalSessionEventBase {
  runtimeEpoch: string;
  sessionId: string;
}

interface TerminalSessionStateEvent extends TerminalSessionEventBase, TerminalStateCursor {
  startedAt: number;
  status: TerminalSessionStatus;
}

interface TerminalSessionOutputEvent extends TerminalSessionEventBase, TerminalStateCursor {
  data: string;
}

interface TerminalSessionTransitionEvent
  extends TerminalSessionEventBase, TerminalStateCursor, TerminalDimensions {
  data: string;
  kind: TerminalTransitionKind;
}

interface TerminalSessionSnapshotEvent
  extends TerminalSessionEventBase, TerminalStateCursor, Partial<TerminalDimensions> {
  output: string;
  replaceLive: boolean;
  revived?: boolean;
  textOutput?: string;
}

interface TerminalMetadataPatch {
  runtimeObservation: unknown;
  shellCommand: string;
  shellCommandStartedAt: number | null;
  shellCwd: string;
  shellLastCommand: string;
  shellLastCommandDurationMs: number | null;
  shellLastCommandFinishedAt: number | null;
  shellLastCommandStartedAt: number | null;
  shellLastEvent: string;
  shellLastExitCode: number | null;
  terminalBusy: boolean | null;
  terminalStatus: TerminalStatusContract;
}

interface TerminalResizeRequest extends TerminalDimensions {}

interface AgentManagerTerminalEngineFields {
  activeInputOperations: Set<Promise<unknown>>;
  engineBridge: SessionEngineBridgeContract;
  pendingResizeByAgent: Map<string, TerminalResizeRequest>;
  permissionRestartSuppressedAgentIds: Set<string>;
  resizeDrains: Map<string, Promise<void>>;
  terminalStartupCoordinator: TerminalStartupCoordinator;
  verifiedStoppedAgentIds: Set<string>;
}

interface TerminalSessionPreviewEvent extends TerminalSessionEventBase, TerminalDimensions {
  previewSnapshot: unknown;
  previewText: string;
  title?: string;
}

interface TerminalSessionTitleEvent extends TerminalSessionEventBase {
  title: string;
}

interface TerminalSessionActivityEvent extends TerminalSessionEventBase {
  lastActivityAt: number;
}

interface TerminalSessionBusyStateEvent extends TerminalSessionEventBase {
  busyMarkerSeen?: boolean;
  cwd?: string;
  lastExitCode?: number | null;
  shellCommand?: string;
  shellCommandStartedAt?: number | null;
  shellEvent?: string;
  shellLastCommand?: string;
  shellLastCommandDurationMs?: number | null;
  shellLastCommandFinishedAt?: number | null;
  shellLastCommandStartedAt?: number | null;
  statusMarkerSeen?: boolean;
  terminalBusy?: boolean | null;
}

interface TerminalSessionNotificationEvent extends TerminalSessionEventBase {
  message: string;
  method: 'bel' | 'osc9' | 'osc99' | 'osc777';
  outputSeq?: number;
  title: string;
}

interface TerminalSessionExitEvent extends TerminalSessionEventBase {
  code: number | string;
  exitedAt: number;
  outputSeq?: number;
  stateProofAvailable: boolean;
  stateRevision?: number;
}

interface TerminalSessionErrorEvent extends TerminalSessionEventBase {
  error: string;
  fatal: boolean;
}

interface EngineSessionEventMap {
  'session-activity': TerminalSessionActivityEvent;
  'session-busy-state': TerminalSessionBusyStateEvent;
  'session-error': TerminalSessionErrorEvent;
  'session-exited': TerminalSessionExitEvent;
  'session-notification': TerminalSessionNotificationEvent;
  'session-output': TerminalSessionOutputEvent;
  'session-preview': TerminalSessionPreviewEvent;
  'session-started': TerminalSessionStateEvent;
  'session-sync': TerminalSessionSnapshotEvent;
  'session-title': TerminalSessionTitleEvent;
  'session-transition': TerminalSessionTransitionEvent;
}

type BridgeEngineEventMap = {
  [EventName in keyof EngineSessionEventMap]: EngineSessionEventMap[EventName] & {
    engineName: string;
  };
};

interface EngineEventEmitter<EventMap extends object> {
  on<EventName extends keyof EventMap>(
    eventName: EventName,
    listener: (payload: EventMap[EventName]) => void,
  ): unknown;
}

interface SessionEngineContract extends EngineEventEmitter<EngineSessionEventMap> {
  clearBuffer?(
    sessionId: string,
    options?: RuntimeEpochOptions,
  ): MaybePromise<TerminalClearResult>;
  consumeRuntimeRotation?(): NativeRuntimeRotationRecord | null;
  createSession(options: CreateTerminalSessionOptions): MaybePromise<CreateTerminalSessionResult>;
  dispose(options?: { preserveHost?: boolean }): unknown;
  getSessionAttachCheckpoint?(
    sessionId: string,
  ): MaybePromise<TerminalAttachCheckpoint | null>;
  getSessionPreview(sessionId: string): MaybePromise<string>;
  getSessionSource?(): string;
  getSessionState(sessionId: string): MaybePromise<TerminalSessionState | null>;
  interruptSession?(
    sessionId: string,
    input: TerminalInput,
    options?: RuntimeEpochOptions,
  ): MaybePromise<TerminalInputResult>;
  killSession(sessionId: string): MaybePromise<TerminalKillResult | void>;
  recoverSessions?(options?: { startHost?: boolean }): MaybePromise<RecoveredEngineSession[]>;
  resizeSession?(
    sessionId: string,
    cols: number,
    rows: number,
  ): MaybePromise<TerminalResizeResult>;
  sendInput(
    sessionId: string,
    input: TerminalInput,
    options?: RuntimeEpochOptions,
  ): MaybePromise<TerminalInputResult>;
  updateSessionMetadata?(
    sessionId: string,
    metadata: RuntimeEngineMetadataPatch,
  ): MaybePromise<RuntimeEngineMetadata | null>;
}

interface LocalSessionEngineContract extends SessionEngineContract {
  dispose(): Promise<PromiseSettledResult<unknown>[]>;
  getSessionSource?(): 'buffer';
}

interface NativeSessionEngineContract extends SessionEngineContract {
  dispose(options?: { preserveHost?: boolean }): void;
  getSessionSource(): 'buffer';
}

interface SessionEngineResolutionContract {
  engine: SessionEngineContract;
  engineName: string;
  spec: unknown;
}

interface SessionEngineBridgeContract extends EngineEventEmitter<BridgeEngineEventMap> {
  clearBuffer(
    engineName: unknown,
    sessionId: string,
    options?: RuntimeEpochOptions,
  ): Promise<TerminalClearResult | null | undefined>;
  consumeRuntimeRotations(): RuntimeRotationRecord[];
  createSession(
    command: string,
    options: CreateTerminalSessionOptions,
  ): Promise<SessionEngineResolutionContract>;
  dispose(options?: { preserveHost?: boolean }): Promise<PromiseSettledResult<unknown>[]>;
  getEngine(name: unknown): SessionEngineContract | null;
  getSessionAttachCheckpoint(
    engineName: unknown,
    sessionId: string,
  ): Promise<TerminalAttachCheckpoint | null>;
  getSessionPreview(engineName: unknown, sessionId: string): Promise<string>;
  getSessionState(engineName: unknown, sessionId: string): Promise<TerminalSessionState | null>;
  killSession(engineName: unknown, sessionId: string): Promise<TerminalKillResult | void>;
  recoverSessions(options?: { startHost?: boolean }): Promise<RecoveredEngineSession[]>;
  resizeSession(
    engineName: unknown,
    sessionId: string,
    cols: number,
    rows: number,
  ): Promise<TerminalResizeResult | null | undefined>;
  resolve(command: string): SessionEngineResolutionContract;
  sendInput(
    engineName: unknown,
    sessionId: string,
    input: TerminalInput,
    options?: RuntimeEpochOptions,
  ): Promise<TerminalInputResult | undefined>;
}

interface SessionEngineBridgeConstructor {
  new(configManager?: { farmingDir?: string } | null): SessionEngineBridgeContract;
}

export type {
  AgentManagerTerminalEngineFields,
  BridgeEngineEventMap,
  CreateTerminalSessionOptions,
  CreateTerminalSessionResult,
  EngineEventEmitter,
  EngineSessionEventMap,
  LocalSessionEngineContract,
  NativeSessionEngineContract,
  NativePtyHostRuntimeIdentity,
  NativeRuntimeRotationRecord,
  RecoveredEngineSession,
  RuntimeEngineMetadata,
  RuntimeEngineMetadataPatch,
  RuntimeEpochOptions,
  RuntimeRotationRecord,
  SessionEngineBridgeContract,
  SessionEngineBridgeConstructor,
  SessionEngineContract,
  SessionEngineResolutionContract,
  SerializedTerminalReplayEvent,
  SerializedTerminalStateEntry,
  TerminalAttachCheckpoint,
  TerminalClearResult,
  TerminalDimensions,
  TerminalEngineLaunch,
  TerminalInput,
  TerminalInputResult,
  TerminalKillResult,
  TerminalMetadataPatch,
  TerminalResizeRequest,
  TerminalResizeResult,
  TerminalSessionActivityEvent,
  TerminalSessionBusyStateEvent,
  TerminalSessionErrorEvent,
  TerminalSessionExitEvent,
  TerminalSessionNotificationEvent,
  TerminalSessionOutputEvent,
  TerminalSessionPreviewEvent,
  TerminalSessionSnapshotEvent,
  TerminalSessionState,
  TerminalSessionStatus,
  TerminalSessionStateEvent,
  TerminalSessionTitleEvent,
  TerminalSessionTransitionEvent,
  TerminalStateCursor,
  TerminalStatusContract,
  TerminalTransitionKind,
};
