interface CrtTerminalDisposable {
  dispose(): void;
}

interface CrtTerminalCell {
  getChars(): string;
  getCode(): number;
  getCodepoint(): number;
  getWidth(): number;
  getHyperlinkId?(): number;
}

interface CrtTerminalBufferLine {
  readonly isWrapped: boolean;
  readonly length: number;
  getCell(column: number, cell?: CrtTerminalCell): CrtTerminalCell | undefined;
  translateToString(trimRight?: boolean, startColumn?: number, endColumn?: number): string;
}

interface CrtTerminalBuffer {
  readonly baseY: number;
  readonly cursorX: number;
  readonly cursorY: number;
  readonly length: number;
  readonly viewportY: number;
  getLine(row: number): CrtTerminalBufferLine | undefined;
}

interface CrtTerminalSelectionPosition {
  start: { x: number; y: number };
  end: { x: number; y: number };
}

interface CrtTerminalLink {
  text: string;
  range: {
    start: { x: number; y: number };
    end: { x: number; y: number };
  };
  activate(event: MouseEvent, text: string): void;
  hover?(event: MouseEvent, text: string): void;
  leave?(event: MouseEvent, text: string): void;
  decorations?: {
    pointerCursor?: boolean;
    underline?: boolean;
  };
}

interface CrtTerminalLinkProvider {
  provideLinks(
    row: number,
    callback: (links: CrtTerminalLink[] | undefined) => void,
  ): void;
}

interface CrtGhosttyTerminalState {
  getHyperlinkUri(id: number): string | null;
}

interface CrtTerminalOptions {
  disableStdin?: boolean;
  fontFamily?: string;
  fontSize?: number;
  theme?: Record<string, string>;
}

interface CrtTerminalAddon {
  activate?(terminal: CrtTerminalInstance): void;
  dispose?(): void;
}

interface CrtTerminalInstance {
  readonly buffer: { active: CrtTerminalBuffer };
  readonly cols: number;
  readonly rows: number;
  readonly wasmTerm?: CrtGhosttyTerminalState;
  options: CrtTerminalOptions;
  clear(): void;
  clearSelection(): void;
  dispose(): void;
  focus(): void;
  getSelection(): string;
  getSelectionPosition(): CrtTerminalSelectionPosition | undefined;
  getVisibleBufferBase?(): number;
  loadAddon(addon: CrtTerminalAddon): void;
  onData(listener: (data: string) => void): CrtTerminalDisposable;
  onResize(listener: (size: CrtTerminalDimensions) => void): CrtTerminalDisposable;
  onScroll(listener: (viewportY: number) => void): CrtTerminalDisposable;
  onSelectionChange(listener: () => void): CrtTerminalDisposable;
  onTitleChange(listener: (title: string) => void): CrtTerminalDisposable;
  open(container: HTMLElement): void;
  paste(data: string): void;
  registerLinkProvider(provider: CrtTerminalLinkProvider): CrtTerminalDisposable;
  reset(): void;
  resize(cols: number, rows: number): void;
  scrollToBottom(): void;
  scrollToLine(line: number): void;
  select(column: number, row: number, length: number): void;
  selectLines(start: number, end: number): void;
  write(data: string | Uint8Array, callback?: () => void): void;
}

interface CrtTerminalDimensions {
  cols: number;
  rows: number;
}

interface CrtTerminalFitAddon extends CrtTerminalAddon {
  fit(): void;
  proposeDimensions(): CrtTerminalDimensions | undefined;
}

interface CrtTerminalWebglAddon extends CrtTerminalAddon {
  onContextLoss?(listener: () => void): CrtTerminalDisposable;
}

interface FarmingTerminalBundle {
  kind: 'ghostty' | 'xterm' | 'xterm-webgl';
  terminal: CrtTerminalInstance;
  fitAddon: CrtTerminalFitAddon;
  webglAddon?: CrtTerminalWebglAddon;
}

interface FarmingTerminalBridgeCreateOptions {
  theme?: Record<string, string>;
  fontSize?: number;
  fontFamily?: string;
  cursorBlink?: boolean;
  disableStdin?: boolean;
  scrollback?: number;
  smoothScrollDuration?: number;
  requireWebgl?: boolean;
  onWebglContextLoss?: () => void;
}

interface FarmingTerminalBridge {
  readonly DEFAULT_THEME: Record<string, string>;
  readonly DEFAULT_FONT_FAMILY: string;
  preferredEngine(): 'ghostty' | 'xterm';
  supportsWebgl2(): boolean;
  createInstance(options?: FarmingTerminalBridgeCreateOptions): Promise<FarmingTerminalBundle | null>;
}

type FarmingTerminalTransitionKind = 'output' | 'resize' | 'clear';

interface FarmingTerminalTransition {
  kind?: FarmingTerminalTransitionKind;
  data?: string;
  runtimeEpoch?: string;
  outputSeq?: number | null;
  stateRevision?: number | null;
  cols?: number;
  rows?: number;
}

interface FarmingValidTerminalTransition extends FarmingTerminalTransition {
  runtimeEpoch: string;
  outputSeq: number;
  stateRevision: number;
}

interface FarmingTerminalCheckpoint {
  runtimeEpoch: string;
  outputSeq: number;
  stateRevision: number;
  cols: number;
  rows: number;
}

interface FarmingTerminalCheckpointCandidate {
  runtimeEpoch?: string;
  outputSeq?: number | null;
  stateRevision?: number | null;
  cols?: number | null;
  rows?: number | null;
}

interface FarmingTerminalReplayState {
  runtimeEpoch: string;
  outputSeq: number | null;
  stateRevision: number | null;
  replayTargetEpoch: string;
  replayTargetRevision: number | null;
  recovering: boolean;
  queuedTransitions: FarmingValidTerminalTransition[];
  queuedBytes: number;
  retiredRuntimeEpochs: Set<string>;
  failureCount: number;
  invariantFailureSignature: string;
  invariantFailureCount: number;
  halted: boolean;
  haltMessage: string;
  maxQueuedTransitions: number;
  maxQueuedBytes: number;
  retryBaseMs: number;
  retryMaxMs: number;
  maxIdenticalInvariantFailures: number;
}

interface FarmingTerminalReplayDecision {
  action: 'apply' | 'drop' | 'recover' | 'current' | 'install' | 'reject';
  reason?: string;
  signature?: string;
  message?: string;
}

interface FarmingTerminalReplayFailure {
  halted: boolean;
  delay: number;
  message: string;
}

interface FarmingTerminalReplay {
  createState(options?: Partial<Pick<FarmingTerminalReplayState,
    | 'maxQueuedTransitions'
    | 'maxQueuedBytes'
    | 'retryBaseMs'
    | 'retryMaxMs'
    | 'maxIdenticalInvariantFailures'
  >>): FarmingTerminalReplayState;
  compareRuntimeEpochs(left: string, right: string): -1 | 0 | 1 | null;
  beginRecovery(state: FarmingTerminalReplayState, event?: FarmingTerminalTransition): void;
  isReplayTargetPending(state: FarmingTerminalReplayState): boolean;
  classifyTransition(
    state: FarmingTerminalReplayState,
    event: FarmingTerminalTransition,
  ): FarmingTerminalReplayDecision;
  queueTransition(
    state: FarmingTerminalReplayState,
    event: FarmingTerminalTransition,
  ): { queued: boolean; overflow: boolean };
  takeQueuedTransition(state: FarmingTerminalReplayState): FarmingValidTerminalTransition | null;
  clearQueuedTransitions(state: FarmingTerminalReplayState): void;
  evaluateCheckpoint(
    state: FarmingTerminalReplayState,
    checkpoint: FarmingTerminalCheckpointCandidate,
  ): FarmingTerminalReplayDecision;
  commitCheckpoint(state: FarmingTerminalReplayState, checkpoint: FarmingTerminalCheckpoint): boolean;
  commitTransition(state: FarmingTerminalReplayState, event: FarmingTerminalTransition): void;
  recordTransportFailure(state: FarmingTerminalReplayState): FarmingTerminalReplayFailure;
  recordInvariantFailure(
    state: FarmingTerminalReplayState,
    signature: string,
    message: string,
  ): FarmingTerminalReplayFailure;
  resetRecovery(state: FarmingTerminalReplayState, options?: { keepCursor?: boolean }): void;
}

interface CrtTerminalSessionViewResponse {
  agentId?: string;
  available?: boolean;
  renderOutput?: string;
  previewCols?: number | null;
  previewRows?: number | null;
  runtimeEpoch?: string;
  outputSeq?: number | null;
  stateRevision?: number | null;
}

interface CrtTerminalSessionView {
  agentId?: string;
  available?: boolean;
  renderOutput: string;
  previewCols: number;
  previewRows: number;
  runtimeEpoch: string;
  outputSeq: number;
  stateRevision: number;
}

interface CrtTerminalStreamChunk extends FarmingTerminalTransition {
  kind?: FarmingTerminalTransitionKind;
}

interface CrtTerminalStream extends CrtTerminalStreamChunk {
  agentId: string;
  replace?: boolean;
  chunks?: CrtTerminalStreamChunk[];
}

interface CrtTerminalReplication {
  agentId: string;
  initialFocusPending: boolean;
  lastResizeCols: number | null;
  lastResizeRows: number | null;
  pendingFitResize: CrtTerminalDimensions | null;
  fitResizeTimer: number | null;
  applyingLocalResize: boolean;
  replayState: FarmingTerminalReplayState;
  checkpointInFlight: boolean;
  checkpointSeq: number;
  checkpointAbortController: AbortController | null;
  checkpointRetryTimer: number | null;
  installSeq: number;
  installInProgress: boolean;
  pendingCheckpoint: CrtTerminalSessionView | null;
  writeInProgress: boolean;
  disposed: boolean;
}

interface Window {
  FarmingTerminalBridge?: FarmingTerminalBridge;
  FarmingTerminalReplay?: FarmingTerminalReplay;
}
