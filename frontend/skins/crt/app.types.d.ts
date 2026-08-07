type CrtUnknownRecord = Record<string, unknown>;

interface FarmingComposerResult extends CrtUnknownRecord {
  type?: 'composer-input-result';
  requestId?: string;
  accepted?: boolean;
  message?: string;
  uncertain?: boolean;
}

interface FarmingSessionClient {
  focusAgent(agentId: string | null, options?: {
    activityScope?: 'all' | 'focused' | 'none';
    stateScope?: 'all' | 'focused';
    streamScope?: string;
    previewScope?: string;
    refreshState?: boolean;
  }): boolean;
  sendTerminalInput(agentId: string, input: string): boolean;
  sendComposerMessage(
    agentId: string,
    message: string,
    attachments?: readonly CrtStructuredPromptAttachment[],
    options?: { requestId?: string; onResult?: (result: FarmingComposerResult) => void },
  ): boolean;
  handleServerMessage(message: unknown): boolean;
  handleTransportDisconnected(message?: string): void;
  interruptAgent(agentId: string): boolean;
  resizeAgent(agentId: string, cols: number, rows: number): boolean;
  clearTerminal(agentId: string): boolean;
  archiveAgent(agentId: string): boolean;
  requestTerminalCheckpoint(agentId: string, options?: { signal?: AbortSignal }): Promise<Record<string, unknown>>;
}

interface FarmingSessionBridge {
  createClient(options?: {
    getSocket?: () => WebSocket | null;
  }): FarmingSessionClient;
}

interface FarmingSessionModalState {
  agentId: string | null;
  sessionSource: string;
  sessionSkin: FarmingSessionSkin | null;
  title: string;
}

interface FarmingSessionModalRuntime {
  getFocusedAgentId(): string | null;
  getSessionSource(): string | null;
  getLastOutputLength(): number;
  getSessionToken(): number;
  isAwaitingInitialSync(): boolean;
  isCurrentSession(agentId: string | null, token: number): boolean;
  setLastOutputLength(length: number): void;
  prepareInitialOutput(text: string): string;
  markHydrated(nextLength?: number): void;
  activate(state: FarmingSessionModalState): void;
  deactivate(): void;
  startPolling(context?: CrtUnknownRecord): null;
  stopPolling(): void;
  handleStateMessage(state: CrtWorkspaceState): { focusedAgentId: string | null };
  handleStreamMessage(stream: unknown): {
    focusedAgentId: string | null;
    patch: { text: string; nextLengthDelta: number } | null;
  };
  open(documentRef: Document, state: FarmingSessionModalState): {
    sessionToken: number;
    domState: ReturnType<FarmingSessionModalBridge['getDomState']>;
  };
  close(documentRef: Document): void;
}

interface FarmingSessionModalBridge {
  createModalState(
    agent: CrtAgent | null,
    themeId?: string | null,
    themeSettings?: CrtUnknownRecord,
  ): FarmingSessionModalState;
  shouldPollSessionView(sessionSource: unknown): false;
  getDomState(documentRef: Document): {
    modal: HTMLElement;
    terminalContainer: HTMLElement;
    title: HTMLElement;
  };
  openShell(
    documentRef: Document,
    state: FarmingSessionModalState,
  ): ReturnType<FarmingSessionModalBridge['getDomState']>;
  mountTerminal(
    documentRef: Document,
    bundle: FarmingTerminalBundle,
    options?: {
      initialOutput?: string;
      authoritativeGeometry?: boolean;
      onData?: (data: string) => void;
      onResize?: (cols: number, rows: number) => void;
      hasSelection?: () => boolean;
      focusTerminal?: () => void;
      isSessionActive?: () => boolean;
      afterFit?: () => void;
    },
  ): {
    terminal: CrtTerminalInstance;
    fitAddon: CrtTerminalFitAddon;
    outputLength: number;
    readyPromise: Promise<void>;
  } & CrtUnknownRecord;
  resetTerminalShell(documentRef: Document): CrtUnknownRecord;
  createRuntime(options?: {
    deriveSessionStreamPatch?: (
      stream: Record<string, unknown> | null | undefined,
      agentId: string | null,
      source: string | null,
    ) => { text: string; nextLengthDelta: number } | null;
    refreshSessionView?: (
      forceReplace?: boolean,
      expectedAgentId?: string | null,
      expectedSessionToken?: number,
    ) => Promise<void>;
  }): FarmingSessionModalRuntime;
  closeShell(documentRef: Document): CrtUnknownRecord;
}

type FarmingReadingAnchor =
  | {
    version: 1;
    surface: 'chat';
    resource: { kind: 'agent'; id: string };
    locator: { kind: 'message'; id: string; childId?: string };
    position: { unit: 'fraction'; value: number };
  }
  | {
    version: 1;
    surface: 'terminal';
    resource: { kind: 'agent'; id: string };
    locator: { kind: 'terminal-lines'; id: string; lineCount?: number };
    position: { unit: 'row'; value: number };
  }
  | {
    version: 1;
    surface: 'file';
    resource: { kind: 'file'; workspace: string; path: string };
    locator: { kind: 'file-line'; id: string };
    position: { unit: 'line-column'; value: number; column?: number };
  };

interface FarmingReadingAnchors {
  VERSION: 1;
  agentKey(agentId: unknown, surface: unknown): string;
  fileKey(workspace: unknown, path: unknown): string;
  read(key: string): FarmingReadingAnchor | null;
  save(anchor: unknown): FarmingReadingAnchor | null;
  remove(key: string): void;
  fingerprint(parts: unknown[] | unknown): string;
  encode(anchor: unknown): string;
  decode(encoded: unknown): FarmingReadingAnchor | null;
  importEncoded(encoded: unknown): FarmingReadingAnchor | null;
  importFromSearch(search?: string): FarmingReadingAnchor | null;
}

interface CrtRuntimeBinding extends CrtUnknownRecord {
  kind: 'terminal' | 'acp' | 'json';
  state?: string;
  error?: string;
  sessionRevision?: number;
  sessionUpdatedAt?: string;
  pendingPermission?: CrtStructuredPermission | null;
  pendingPermissions?: CrtStructuredPermission[];
}

interface CrtRuntimeObservation extends CrtUnknownRecord {
  kind?: string;
  state?: string;
  activity?: string;
  busy?: boolean;
}

interface CrtProviderCapabilities extends CrtUnknownRecord {
  runtimeSwitch?: boolean;
  supportsChat?: boolean;
  supportsTerminal?: boolean;
  supportsFork?: boolean;
}

interface CrtPreviewSnapshot extends CrtUnknownRecord {
  cells?: Array<Array<{
    char?: string;
    width: number;
    attributes?: number;
    fg?: number;
    bg?: number;
  }>>;
  cursorVisible?: boolean;
  cursorY?: number;
  messageLines?: string[];
  userText?: string;
  assistantText?: string;
  activityText?: string;
}

interface CrtAgent extends CrtUnknownRecord {
  id: string;
  name?: string;
  description?: string;
  isMain?: boolean;
  archived?: boolean;
  source?: string;
  status?: string;
  activityLevel?: string;
  command?: string;
  engineName?: string;
  customTitle?: string;
  providerSessionTitle?: string;
  adaptiveTitle?: string;
  sessionTitle?: string;
  cwd?: string;
  projectWorkspace?: string;
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
  archivedAt?: number | null;
  lastActivity?: number | null;
  startedAt?: number | null;
  previewText?: string;
  previewSnapshot?: CrtPreviewSnapshot | null;
  previewCols?: number;
  previewRows?: number;
  output?: string;
  attentionSeq?: number;
  readAttentionSeq?: number;
  sessionSource?: string;
  terminalBusy?: boolean | null;
  terminalInputReceived?: boolean;
  terminalStatus?: string | CrtUnknownRecord | null;
  shellStatus?: string | CrtUnknownRecord;
  runtimeBinding?: CrtRuntimeBinding | CrtProtocolRuntimeBinding;
  runtimeObservation?: CrtRuntimeObservation;
  providerCapabilities?: CrtProviderCapabilities;
}

interface CrtWorkspaceState extends CrtUnknownRecord {
  agents: CrtAgent[];
  agentInventoryRunning?: number;
  agentInventoryScope?: 'all' | 'focused';
  agentInventoryTotal?: number;
  mainAgentId?: string | null;
  taskHistory?: CrtHistoryEntry[];
}

interface CrtSessionRecord extends CrtUnknownRecord {
  id: string;
  provider?: string;
  providerHomeId?: string;
  archived?: boolean;
  title?: string;
  workspace?: string;
  cwd?: string;
  providerName?: string;
  source?: string;
  updatedAt?: string | number;
  createdAt?: string | number;
  effort?: string;
  model?: string;
}

interface CrtHistoryEntry extends CrtUnknownRecord {
  id: string;
  title?: string;
  source?: string;
  archivedAt?: number;
  lastActivity?: number | null;
  startedAt?: number | null;
  command?: string;
  projectWorkspace?: string;
  cwd?: string;
  task?: string;
  workflowTemplate?: string;
}

interface CrtStructuredPermission extends CrtUnknownRecord {
  id?: string;
  requestId?: string;
  title?: string;
  description?: string;
  kind?: string;
  status?: string;
  options?: CrtStructuredSelectValue[];
}

interface CrtStructuredSelectValue extends CrtUnknownRecord {
  name?: string;
  value: unknown;
  description?: string;
}

interface CrtStructuredConfigOption extends CrtUnknownRecord {
  id: string;
  name?: string;
  description?: string;
  type: 'boolean' | 'select' | string;
  currentValue: unknown;
  options?: CrtStructuredSelectValue[];
}

interface CrtStructuredCommand extends CrtUnknownRecord {
  name: string;
  description?: string;
  input?: { hint?: string };
}

interface CrtStructuredMode extends CrtUnknownRecord {
  id: string;
  name?: string;
  description?: string;
}

interface CrtStructuredSession extends CrtUnknownRecord {
  updatedAt?: string | number;
  availableCommands?: CrtStructuredCommand[];
  modes?: CrtStructuredMode[];
  currentModeId?: string;
  configOptions?: CrtStructuredConfigOption[];
  usage?: CrtUnknownRecord;
}

interface CrtStructuredPromptAttachment extends CrtUnknownRecord {
  type?: string;
  kind?: string;
  path?: string;
  size?: number;
  mimeType?: string;
  name?: string;
  data?: string;
  url?: string;
}

interface CrtStructuredComposerAttachment extends CrtUnknownRecord {
  id: string;
  name: string;
  status: 'uploading' | 'ready' | 'failed';
  type?: string;
  mimeType?: string;
  content?: string;
  data?: string;
  message?: string;
  size?: number;
}

interface FarmingSessionSkin {
  id: string;
  titleCase: 'lowercase';
  crtEffectsEnabled: boolean;
  sessionClassName: string;
  terminalTheme: Record<string, string> | null;
}

interface Window {
  FarmingRuntimePaths?: {
    basePath: string;
    path(suffix?: string): string;
    apiPath(suffix?: string): string;
    webSocketUrl(): string;
  };
  FarmingTerminalReplay?: FarmingTerminalReplay;
  FarmingTerminalBridge?: FarmingTerminalBridge;
  FarmingSessionModalBridge?: FarmingSessionModalBridge;
  FarmingSessionBridge?: FarmingSessionBridge;
  FarmingReadingAnchors?: FarmingReadingAnchors;
  FarmingCrtMarkdownRenderer?: {
    renderOutput(container: Element, content: unknown, options?: CrtUnknownRecord): unknown;
    render(container: Element, content: unknown): unknown;
    unmount(container: Element): void;
  };
  FarmingSkinBridge?: {
    getSessionSkin(themeId?: string | null, settings?: CrtUnknownRecord): FarmingSessionSkin;
    applySessionSkin(documentRef: Document, skin: FarmingSessionSkin | null): void;
  };
  __FARMING_E2E__?: boolean;
  __farmingCrtTerminalTest?: CrtUnknownRecord;
}
