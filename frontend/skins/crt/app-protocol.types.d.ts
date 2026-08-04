type CrtProtocolRecord = Record<string, unknown>;

type CrtProtocolAgentStatus = 'pending' | 'running' | 'stopped' | 'dead';
type CrtProtocolActivityLevel = 'hot' | 'warm' | 'cool' | 'cold';

interface CrtProtocolTerminalStatus extends CrtProtocolRecord {
  kind: 'codex' | 'claude' | 'shell' | 'process' | 'unknown';
  activity: 'busy' | 'idle' | 'exited' | 'unknown';
  busy: boolean;
  cwd: string;
  title: string;
  lastExitCode?: number | null;
}

interface CrtProtocolRuntimeObservation extends CrtProtocolRecord {
  kind: 'codex' | 'claude' | 'shell' | 'process' | 'unknown';
  phase: 'starting' | 'working' | 'waiting' | 'idle' | 'exited' | 'unknown';
  confidence: 'authoritative' | 'high' | 'heuristic';
  source: 'structured-runtime' | 'shell-marker' | 'terminal-observer';
  observerVersion: string;
  observedAt: number;
}

interface CrtProtocolProviderCapabilities extends CrtProtocolRecord {
  supportedRuntimes: Array<'terminal' | 'acp' | 'json'>;
  runtimeSwitch: boolean;
  terminalProfile: boolean;
  terminalSessionFork: boolean;
  sessionFork: boolean;
  chatRuntime: 'acp' | '';
  supportsChat: boolean;
  supportsSteer: boolean;
}

interface CrtProtocolPermissionOption extends CrtProtocolRecord {
  optionId: string;
  name: string;
  kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always' | string;
}

interface CrtProtocolPermissionToolCall extends CrtProtocolRecord {
  toolCallId: string;
  title?: string | null;
  kind?: string | null;
  status?: string | null;
  content?: unknown;
}

interface CrtProtocolPendingPermission extends CrtProtocolRecord {
  requestId: string;
  sessionId: string;
  origin?: 'agent' | 'subagent' | string;
  toolCall: CrtProtocolPermissionToolCall;
  options: CrtProtocolPermissionOption[];
}

interface CrtProtocolTerminalRuntimeBinding extends CrtProtocolRecord {
  kind: 'terminal';
}

interface CrtProtocolAcpRuntimeBinding extends CrtProtocolRecord {
  kind: 'acp';
  state: string;
  error: string;
  stopReason: string;
  supportsSteer: boolean;
  supportsFork?: boolean;
  pendingPermission: CrtProtocolPendingPermission | null;
  pendingPermissions: CrtProtocolPendingPermission[];
  sessionUpdatedAt: string;
  sessionRevision: number;
}

type CrtProtocolRuntimeBinding =
  | CrtProtocolTerminalRuntimeBinding
  | CrtProtocolAcpRuntimeBinding;

interface CrtProtocolPreviewCell extends CrtProtocolRecord {
  char: string;
  width: number;
  fg?: number;
  bg?: number;
  attributes?: number;
}

interface CrtProtocolPreviewSnapshot extends CrtProtocolRecord {
  cols: number;
  rows: number;
  viewportY: number;
  cursorX: number;
  cursorY: number;
  cursorVisible?: boolean;
  cells: CrtProtocolPreviewCell[][];
  messageLines?: string[];
  userText?: string;
  assistantText?: string;
  activityText?: string;
}

interface CrtProtocolAgent extends CrtProtocolRecord {
  id: string;
  command: string;
  cwd: string;
  output: string;
  status: CrtProtocolAgentStatus;
  isMain: boolean;
  activityLevel: CrtProtocolActivityLevel;
  lastActivity: number;
  runtimeBinding: CrtProtocolRuntimeBinding;
  runtimeObservation: CrtProtocolRuntimeObservation;
  providerCapabilities: CrtProtocolProviderCapabilities;
  engineName?: string;
  projectWorkspace?: string;
  archived?: boolean;
  archivedAt?: number | null;
  source?: string;
  customTitle?: string;
  adaptiveTitle?: string;
  providerSessionTitle?: string;
  sessionTitle?: string;
  task?: string;
  unread?: boolean;
  pinned?: boolean;
  projectOrder?: number | null;
  pinnedOrder?: number | null;
  providerSessionKey?: string;
  providerSessionProvider?: string;
  providerSessionId?: string;
  providerSessionTemporary?: boolean;
  providerHomeId?: string;
  startedAt?: number | null;
  exitedAt?: number | null;
  previewText?: string;
  previewSnapshot?: CrtProtocolPreviewSnapshot | null;
  previewCols?: number;
  previewRows?: number;
  renderOutput?: string;
  runtimeEpoch?: string;
  outputSeq?: number | null;
  stateRevision?: number | null;
  attentionSeq?: number;
  readAttentionSeq?: number;
  attentionUpdatedAt?: number | null;
  readAttentionAt?: number | null;
  attentionReason?: string;
  attentionSummary?: string;
  attentionOutputEpoch?: string;
  attentionOutputSeq?: number | null;
  readOutputEpoch?: string;
  readOutputSeq?: number | null;
  sessionSource?: string;
  terminalBusy?: boolean | null;
  terminalInputReceived?: boolean;
  terminalStatus?: CrtProtocolTerminalStatus | null;
}

interface CrtProtocolTaskHistoryEntry extends CrtProtocolRecord {
  id: string;
  agentId: string;
  command: string;
  cwd: string;
  projectWorkspace?: string;
  task: string;
  source: string;
  status: string;
  startedAt: number | null;
  lastActivity: number | null;
  archivedAt: number;
  customTitle?: string;
  workflowTemplate?: string;
}

interface CrtProtocolWorkspaceState extends CrtProtocolRecord {
  agents: CrtProtocolAgent[];
  mainAgentId: string | null;
  taskHistory: CrtProtocolTaskHistoryEntry[];
}

interface CrtProtocolHelloClientMessage extends CrtProtocolRecord {
  type: 'protocol-hello';
  protocolVersion: number;
}

interface CrtProtocolStartAgentClientMessage extends CrtProtocolRecord {
  type: 'start-agent';
  command: string;
  workspace: string | null;
  asMain: boolean;
  dangerouslySkipPermissions: boolean;
  task?: string;
  workflowTemplate?: string;
  customTitle?: string;
}

interface CrtProtocolInputClientMessage extends CrtProtocolRecord {
  type: 'input';
  agentId?: string;
  input?: string;
  inputParts?: unknown[];
}

interface CrtProtocolComposerInputClientMessage extends CrtProtocolRecord {
  type: 'composer-input';
  agentId?: string;
  requestId?: string;
  message: string;
  delivery?: 'prompt' | 'steer';
  attachments?: CrtProtocolPromptAttachment[];
}

interface CrtProtocolAgentCommandClientMessage extends CrtProtocolRecord {
  type: 'interrupt-agent' | 'clear-terminal' | 'watch-workspace-files' | 'archive-agent';
  agentId: string;
}

interface CrtProtocolFocusAgentClientMessage extends CrtProtocolRecord {
  type: 'focus-agent';
  agentId: string | null;
  streamScope?: 'focused' | 'all' | 'none';
  previewScope?: 'focused' | 'all' | 'none';
  refreshState?: boolean;
}

interface CrtProtocolResizeAgentClientMessage extends CrtProtocolRecord {
  type: 'resize-agent';
  agentId: string;
  cols: number;
  rows: number;
}

interface CrtProtocolPermissionResponseClientMessage extends CrtProtocolRecord {
  type: 'acp-permission-response';
  agentId: string;
  requestId: string;
  optionId?: string;
  cancelled?: boolean;
}

interface CrtProtocolStateResyncClientMessage extends CrtProtocolRecord {
  type: 'state-resync';
  generation?: string;
  afterSequence?: number;
}

type CrtWebSocketClientMessage =
  | CrtProtocolHelloClientMessage
  | CrtProtocolStartAgentClientMessage
  | CrtProtocolInputClientMessage
  | CrtProtocolComposerInputClientMessage
  | CrtProtocolAgentCommandClientMessage
  | CrtProtocolFocusAgentClientMessage
  | CrtProtocolResizeAgentClientMessage
  | CrtProtocolPermissionResponseClientMessage
  | CrtProtocolStateResyncClientMessage;

interface CrtProtocolHelloServerMessage extends CrtProtocolRecord {
  type: 'protocol-hello';
  protocolVersion: number;
  minProtocolVersion: number;
}

interface CrtProtocolErrorServerMessage extends CrtProtocolRecord {
  type: 'protocol-error' | 'error';
  message: string;
}

interface CrtProtocolStateServerMessage extends CrtProtocolRecord {
  type: 'state';
  generation: string;
  sequence: number;
  state: CrtProtocolWorkspaceState;
}

interface CrtProtocolStateDeltaServerMessage extends CrtProtocolRecord {
  type: 'state-delta';
  generation: string;
  sequence: number;
  upserts: CrtProtocolAgent[];
  removedAgentIds: string[];
  state?: Partial<Omit<CrtProtocolWorkspaceState, 'agents'>>;
}

interface CrtProtocolAgentStartedServerMessage extends CrtProtocolRecord {
  type: 'agent-started';
  agentId: string;
}

type CrtProtocolAgentPatch = Partial<Pick<CrtProtocolAgent,
  | 'adaptiveTitle'
  | 'sessionTitle'
  | 'runtimeBinding'
  | 'terminalInputReceived'
  | 'terminalBusy'
  | 'terminalStatus'
  | 'runtimeObservation'
>> & CrtProtocolRecord;

interface CrtProtocolAgentUpdateServerMessage extends CrtProtocolRecord {
  type: 'agent-update';
  update: {
    agentId: string;
    patch: CrtProtocolAgentPatch;
  };
}

interface CrtProtocolAgentReadServerMessage extends CrtProtocolRecord {
  type: 'agent-read';
  read: {
    agentId: string;
    unread: boolean;
    attentionSeq: number;
    readAttentionSeq: number;
    attentionUpdatedAt?: number | null;
    readAttentionAt?: number | null;
    attentionReason?: string;
    attentionSummary?: string;
    attentionOutputEpoch?: string;
    attentionOutputSeq?: number | null;
    readOutputEpoch: string;
    readOutputSeq: number | null;
  };
}

interface CrtProtocolAcpRevisionServerMessage extends CrtProtocolRecord {
  type: 'acp-session-revision';
  session: {
    agentId: string;
    revision: number;
    updatedAt: string;
  };
}

interface CrtProtocolSessionPreviewServerMessage extends CrtProtocolRecord {
  type: 'session-preview';
  preview: {
    agentId: string;
    previewText: string;
    cols: number;
    rows: number;
    previewSnapshot?: CrtProtocolPreviewSnapshot | null;
    terminalStatus?: CrtProtocolTerminalStatus | null;
    runtimeObservation?: CrtProtocolRuntimeObservation;
  };
}

interface CrtProtocolTerminalTransition extends CrtProtocolRecord {
  kind?: 'output' | 'resize' | 'clear';
  data: string;
  runtimeEpoch?: string;
  outputSeq?: number | null;
  stateRevision?: number | null;
  cols?: number;
  rows?: number;
}

interface CrtProtocolSessionOutputServerMessage extends CrtProtocolRecord {
  type: 'session-output';
  stream: CrtProtocolTerminalTransition & {
    agentId: string;
    sessionSource?: string;
    replace?: boolean;
    chunks?: CrtProtocolTerminalTransition[];
  };
}

interface CrtProtocolAgentActivityServerMessage extends CrtProtocolRecord {
  type: 'agent-activity';
  activity: CrtProtocolRecord & {
    agentId: string;
    lastActivity?: number;
    activityLevel?: CrtProtocolActivityLevel;
    attentionScore?: number;
    isZombie?: boolean;
  };
}

interface CrtProtocolSystemStats extends CrtProtocolRecord {
  cpu?: number | string;
  memory?: CrtProtocolRecord & { percentage?: number | string };
  ip?: string;
  timestamp?: number | string;
  timeZone?: string;
}

interface CrtProtocolSystemStatsServerMessage extends CrtProtocolRecord {
  type: 'system-stats';
  stats: CrtProtocolSystemStats;
  uptime: number;
}

interface CrtComposerInputResult extends CrtProtocolRecord {
  type: 'composer-input-result';
  requestId: string;
  agentId: string;
  accepted: boolean;
  message?: string;
  uncertain?: boolean;
}

interface CrtProtocolResourceMetadataServerMessage extends CrtProtocolRecord {
  type:
    | 'browser-resource-snapshot'
    | 'browser-resource-updated'
    | 'browser-resource-deleted'
    | 'computer-resource-snapshot'
    | 'computer-resource-updated'
    | 'computer-resource-deleted';
}

type CrtWebSocketServerMessage =
  | CrtProtocolHelloServerMessage
  | CrtProtocolErrorServerMessage
  | CrtProtocolStateServerMessage
  | CrtProtocolStateDeltaServerMessage
  | CrtProtocolAgentStartedServerMessage
  | CrtProtocolAgentUpdateServerMessage
  | CrtProtocolAgentReadServerMessage
  | CrtProtocolAcpRevisionServerMessage
  | CrtProtocolSessionPreviewServerMessage
  | CrtProtocolSessionOutputServerMessage
  | CrtProtocolAgentActivityServerMessage
  | CrtProtocolSystemStatsServerMessage
  | CrtProtocolResourceMetadataServerMessage
  | CrtComposerInputResult;

interface CrtProtocolStructuredCommand extends CrtProtocolRecord {
  name: string;
  description?: string;
  input?: { hint?: string };
}

interface CrtProtocolStructuredMode extends CrtProtocolRecord {
  id: string;
  name?: string;
  description?: string;
}

interface CrtProtocolStructuredSelectValue extends CrtProtocolRecord {
  name?: string;
  value: unknown;
  description?: string;
}

interface CrtProtocolStructuredSelectGroup extends CrtProtocolRecord {
  name?: string;
  options: CrtProtocolStructuredSelectValue[];
}

interface CrtProtocolStructuredBooleanConfig extends CrtProtocolRecord {
  id: string;
  type: 'boolean';
  name?: string;
  description?: string;
  category?: string;
  currentValue: boolean;
}

interface CrtProtocolStructuredSelectConfig extends CrtProtocolRecord {
  id: string;
  type: 'select';
  name?: string;
  description?: string;
  category?: string;
  currentValue: unknown;
  options: Array<CrtProtocolStructuredSelectValue | CrtProtocolStructuredSelectGroup>;
}

type CrtProtocolStructuredConfigOption =
  | CrtProtocolStructuredBooleanConfig
  | CrtProtocolStructuredSelectConfig;

interface CrtProtocolStructuredSessionSnapshot extends CrtProtocolRecord {
  updatedAt: string;
  availableCommands: CrtProtocolStructuredCommand[];
  currentModeId: string;
  modes: {
    currentModeId: string;
    availableModes: CrtProtocolStructuredMode[];
  } | null;
  configOptions: CrtProtocolStructuredConfigOption[];
  usage: {
    used?: number;
    size?: number;
  } | null;
}

interface CrtProtocolPromptAttachment extends CrtProtocolRecord {
  kind: 'image' | 'audio';
  path: string;
  name: string;
  type: string;
  size: number;
}

interface CrtProtocolStructuredUploadingAttachment extends CrtProtocolRecord {
  id: string;
  kind: 'image' | 'audio';
  name: string;
  status: 'uploading';
  messageBlock: string;
}

interface CrtProtocolStructuredReadyAttachment extends CrtProtocolRecord {
  id: string;
  kind: 'image' | 'audio';
  name: string;
  status: 'ready';
  messageBlock: string;
  path?: string;
  type?: string;
  size?: number;
}

interface CrtProtocolStructuredFailedAttachment extends CrtProtocolRecord {
  id: string;
  kind: 'image' | 'audio';
  name: string;
  status: 'error';
  messageBlock: '';
  error: string;
}

type CrtProtocolStructuredComposerAttachment =
  | CrtProtocolStructuredUploadingAttachment
  | CrtProtocolStructuredReadyAttachment
  | CrtProtocolStructuredFailedAttachment;

interface CrtProtocolStructuredComposerFollowUp {
  message: string;
  attachments: CrtProtocolPromptAttachment[];
}
