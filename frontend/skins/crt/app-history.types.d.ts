type CrtHistoryOpenRecord = Record<string, unknown>;

interface CrtPermissionOption extends CrtHistoryOpenRecord {
  optionId: string;
  name: string;
}

interface CrtPermissionRequest extends CrtHistoryOpenRecord {
  requestId: string;
  toolCall?: {
    kind?: string;
    title?: string;
  };
  options?: CrtPermissionOption[];
}

interface CrtTerminalRuntimeBinding extends CrtHistoryOpenRecord {
  kind: 'terminal';
  state?: string;
  error?: string;
}

interface CrtAcpRuntimeBinding extends CrtHistoryOpenRecord {
  kind: 'acp';
  state?: string;
  error?: string;
  sessionRevision?: number;
  sessionUpdatedAt?: string;
  transcriptUpdatedAt?: string;
  turnId?: string;
  pendingPermission?: CrtPermissionRequest;
  pendingPermissions?: CrtPermissionRequest[];
}

interface CrtJsonRuntimeBinding extends CrtHistoryOpenRecord {
  kind: 'json';
  state?: string;
  error?: string;
  sessionRevision?: number;
  sessionUpdatedAt?: string;
  transcriptUpdatedAt?: string;
  turnId?: string;
}

type CrtDiscriminatedRuntimeBinding =
  | CrtTerminalRuntimeBinding
  | CrtAcpRuntimeBinding
  | CrtJsonRuntimeBinding;

interface CrtProviderSession extends CrtSessionRecord {}

interface CrtHistoryRun extends CrtHistoryEntry {
  customTitle?: string;
}

interface CrtResumedProviderSession {
  provider: string;
  providerHomeId: string;
  sessionId: string;
}

interface CrtRunHistoryCandidate {
  kind: 'run';
  historyKey: string;
  entry: CrtHistoryRun;
}

interface CrtAgentHistoryCandidate {
  kind: 'agent';
  historyKey: string;
  agent: CrtAgent;
}

interface CrtSessionHistoryCandidate {
  kind: 'session';
  historyKey: string;
  session: CrtProviderSession;
}

type CrtHistoryCandidate =
  | CrtRunHistoryCandidate
  | CrtAgentHistoryCandidate
  | CrtSessionHistoryCandidate;

type CrtHistoryItem = CrtHistoryCandidate & { updatedAt: number };

interface CrtAgentSearchResult {
  kind: 'agent';
  searchKey: string;
  agent: CrtAgent;
}

interface CrtSessionSearchResult {
  kind: 'session';
  searchKey: string;
  session: CrtProviderSession;
}

type CrtSearchResult = CrtAgentSearchResult | CrtSessionSearchResult;

interface CrtStructuredCommand extends CrtHistoryOpenRecord {
  name: string;
  description?: string;
  input?: { hint?: string };
}

interface CrtStructuredMode extends CrtHistoryOpenRecord {
  id: string;
  name?: string;
  description?: string;
}

interface CrtStructuredSelectValue extends CrtHistoryOpenRecord {
  value: unknown;
  name?: string;
  description?: string;
}

interface CrtStructuredSelectGroup extends CrtHistoryOpenRecord {
  options: CrtStructuredSelectValue[];
}

type CrtStructuredSelectCandidate = CrtStructuredSelectValue | CrtStructuredSelectGroup;

interface CrtStructuredConfigBase extends CrtHistoryOpenRecord {
  id: string;
  name: string;
  description?: string;
  category?: string;
  currentValue: unknown;
}

interface CrtStructuredBooleanConfig extends CrtStructuredConfigBase {
  type: 'boolean';
  currentValue: boolean;
}

interface CrtStructuredSelectConfig extends CrtStructuredConfigBase {
  type: 'select';
  options?: CrtStructuredSelectCandidate[];
}

type CrtStructuredConfig = CrtStructuredBooleanConfig | CrtStructuredSelectConfig;

interface CrtStructuredSessionSnapshot extends CrtHistoryOpenRecord {
  updatedAt?: string | number;
  availableCommands: CrtStructuredCommand[];
  currentModeId?: string;
  modes?: {
    currentModeId?: string;
    availableModes?: CrtStructuredMode[];
  };
  configOptions?: CrtStructuredConfig[];
  usage?: {
    used?: number;
    size?: number;
  };
}

interface CrtStructuredTextBlock extends CrtHistoryOpenRecord {
  type: 'text';
  text: string;
}

interface CrtStructuredImageBlock extends CrtHistoryOpenRecord {
  type: 'image';
  url?: string;
  data?: string;
  mimeType?: string;
}

interface CrtStructuredAudioBlock extends CrtHistoryOpenRecord {
  type: 'audio';
  url?: string;
  data?: string;
  mimeType?: string;
}

interface CrtStructuredResourceBlock extends CrtHistoryOpenRecord {
  type: 'resource' | 'resource_link' | 'file';
  name?: string;
  uri?: string;
  text?: string;
}

interface CrtStructuredDiffBlock extends CrtHistoryOpenRecord {
  type: 'diff';
  path?: string;
  oldText?: string;
  newText?: string;
}

type CrtStructuredContentBlock =
  | CrtStructuredTextBlock
  | CrtStructuredImageBlock
  | CrtStructuredAudioBlock
  | CrtStructuredResourceBlock
  | CrtStructuredDiffBlock;

interface CrtStructuredMessageEntry extends CrtHistoryOpenRecord {
  type: 'message';
  id?: string;
  role: 'user' | 'assistant';
  internal?: boolean;
  content: CrtStructuredContentBlock[];
}

interface CrtStructuredToolEntry extends CrtHistoryOpenRecord {
  type: 'tool';
  id?: string;
  internal?: boolean;
  title?: string;
  kind?: string;
  status?: string;
  content?: CrtStructuredContentBlock[];
}

interface CrtStructuredThoughtEntry extends CrtHistoryOpenRecord {
  type: 'thought';
  id?: string;
  internal?: boolean;
  content?: CrtStructuredContentBlock[];
}

interface CrtStructuredPlanStep extends CrtHistoryOpenRecord {
  status?: 'pending' | 'in_progress' | 'completed' | string;
  content?: string;
  title?: string;
}

interface CrtStructuredPlanEntry extends CrtHistoryOpenRecord {
  type: 'plan';
  id?: string;
  internal?: boolean;
  entries?: CrtStructuredPlanStep[];
}

interface CrtStructuredCompactionEntry extends CrtHistoryOpenRecord {
  type: 'compaction';
  id?: string;
  internal?: boolean;
  status?: string;
}

type CrtStructuredEntry =
  | CrtStructuredMessageEntry
  | CrtStructuredToolEntry
  | CrtStructuredThoughtEntry
  | CrtStructuredPlanEntry
  | CrtStructuredCompactionEntry;

interface CrtStructuredProcessItem extends CrtHistoryOpenRecord {
  id?: string;
  type?: string;
  title?: string;
  detail?: string;
  status?: string;
}

interface CrtStructuredTurn extends CrtHistoryOpenRecord {
  id?: string;
  userMessage?: string;
  finalMessage?: string;
  processItems?: CrtStructuredProcessItem[];
}

interface CrtStructuredTranscript extends CrtHistoryOpenRecord {
  state?: string;
  entries?: CrtStructuredEntry[];
  turns?: CrtStructuredTurn[];
}

interface CrtHistoryComposerAttachment extends CrtHistoryOpenRecord {
  id: string;
  kind: 'image' | 'audio';
  name: string;
  status: 'uploading' | 'ready' | 'error';
  messageBlock: string;
  path?: string;
  type?: string;
  size?: number;
  error?: string;
}
