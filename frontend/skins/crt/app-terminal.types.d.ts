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
  kind: 'xterm' | 'xterm-webgl';
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
  requireWebgl?: boolean;
  onWebglContextLoss?: () => void;
}

interface FarmingTerminalBridge {
  readonly DEFAULT_THEME: Record<string, string>;
  readonly DEFAULT_FONT_FAMILY: string;
  supportsWebgl2(): boolean;
  createInstance(options?: FarmingTerminalBridgeCreateOptions): Promise<FarmingTerminalBundle | null>;
}

type FarmingTerminalTransitionKind = 'output' | 'resize' | 'clear';

type FarmingTerminalTransition = TerminalReplayTransition;
type FarmingValidTerminalTransition = ValidTerminalReplayTransition;
type FarmingTerminalCheckpoint = TerminalReplayCheckpoint;
type FarmingTerminalCheckpointCandidate = TerminalReplayCheckpointCandidate;
type FarmingTerminalReplayState = TerminalReplayState;
type FarmingTerminalReplayDecision = TerminalReplayDecision;
type FarmingTerminalReplayFailure = TerminalReplayFailure;
type FarmingTerminalReplay = FarmingTerminalReplayApi;

interface CrtTerminalSessionViewResponse {
  agentId?: string;
  available?: boolean;
  renderOutput?: string;
  renderedScrollback?: number;
  previewCols?: number | null;
  previewRows?: number | null;
  runtimeEpoch?: string;
  outputSeq?: number | null;
  stateRevision?: number | null;
  scrollbackAvailable?: number;
}

interface CrtTerminalSessionView {
  agentId?: string;
  available?: boolean;
  renderOutput: string;
  renderedScrollback: number;
  previewCols: number;
  previewRows: number;
  runtimeEpoch: string;
  outputSeq: number;
  stateRevision: number;
  scrollbackAvailable: number;
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
  attachment: FarmingTerminalAttachmentCoordinatorApi;
  checkpointInFlight: boolean;
  checkpointScrollbackAvailable: number;
  checkpointScrollbackDesired: number;
  checkpointScrollbackInstalled: number;
  checkpointAbortController: AbortController | null;
  checkpointRetryTimer: number | null;
  installInProgress: boolean;
  pendingCheckpoint: {
    operation: TerminalAttachmentOperation;
    sameCutHistoryExpansion: boolean;
    scrollbackLength: number;
    sessionView: CrtTerminalSessionView;
    viewportY: number;
  } | null;
  writeInProgress: boolean;
  disposed: boolean;
}

interface Window {
  FarmingTerminalBridge?: FarmingTerminalBridge;
  FarmingTerminalReplay?: FarmingTerminalReplay;
  FarmingTerminalAttachmentCoordinator?: FarmingTerminalAttachmentCoordinatorConstructor;
}
