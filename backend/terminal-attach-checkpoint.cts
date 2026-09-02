const DEFAULT_TERMINAL_ATTACH_CHECKPOINT_TIMEOUT_MS = 2000;

export interface TerminalAttachCheckpoint {
  runtimeEpoch: string;
  renderOutput: string;
  outputSeq: number;
  stateRevision: number;
  cols: number;
  rows: number;
  previewText: string;
  previewSnapshot: unknown;
  renderedScrollback?: number;
  scrollbackAvailable?: number;
  title: string;
}

export interface TerminalAttachScreenWorker {
  getState(options: { scrollback?: number; timeoutMs: number }): Promise<unknown>;
}

export interface TerminalAttachSession {
  finalCheckpoint?: TerminalAttachCheckpoint | null;
  screenWorker?: TerminalAttachScreenWorker | null;
  stateProofAvailable?: boolean;
  runtimeEpoch?: unknown;
  outputSeq?: unknown;
  stateRevision?: unknown;
}

interface TerminalAttachCheckpointOptions {
  requireCurrentCut?: boolean;
  scrollback?: number;
  timeoutMs?: number;
}

function finiteNonNegativeInteger(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : null;
}

function finitePositiveInteger(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : null;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object'
    ? value as Record<string, unknown>
    : null;
}

async function captureTerminalAttachCheckpoint(
  session: TerminalAttachSession | null | undefined,
  options: TerminalAttachCheckpointOptions = {},
): Promise<TerminalAttachCheckpoint | null> {
  if (session?.finalCheckpoint) {
    return { ...session.finalCheckpoint };
  }
  if (
    !session
    || !session.screenWorker
    || session.stateProofAvailable === false
    || typeof session.runtimeEpoch !== 'string'
    || !session.runtimeEpoch
  ) {
    return null;
  }

  const timeoutMs = typeof options.timeoutMs === 'number' && Number.isFinite(options.timeoutMs)
    ? Math.max(1, Math.floor(options.timeoutMs))
    : DEFAULT_TERMINAL_ATTACH_CHECKPOINT_TIMEOUT_MS;
  const requestedScrollback = finiteNonNegativeInteger(options.scrollback);
  const state = recordValue(await session.screenWorker.getState({
    ...(requestedScrollback === null ? {} : { scrollback: requestedScrollback }),
    timeoutMs,
  }).catch(() => null));
  const outputSeq = finiteNonNegativeInteger(state?.outputSeq);
  const stateRevision = finiteNonNegativeInteger(state?.stateRevision);
  const currentOutputSeq = finiteNonNegativeInteger(session.outputSeq);
  const currentStateRevision = finiteNonNegativeInteger(session.stateRevision);
  const cols = finitePositiveInteger(state?.cols);
  const rows = finitePositiveInteger(state?.rows);
  const requireCurrentCut = options.requireCurrentCut === true;

  if (
    !state
    || state.runtimeEpoch !== session.runtimeEpoch
    || outputSeq === null
    || stateRevision === null
    || currentOutputSeq === null
    || currentStateRevision === null
    || stateRevision < outputSeq
    || outputSeq > currentOutputSeq
    || stateRevision > currentStateRevision
    || (requireCurrentCut && outputSeq !== currentOutputSeq)
    || (requireCurrentCut && stateRevision !== currentStateRevision)
    || cols === null
    || rows === null
    || typeof state.renderOutput !== 'string'
  ) {
    return null;
  }

  return {
    runtimeEpoch: state.runtimeEpoch as string,
    renderOutput: state.renderOutput,
    outputSeq,
    stateRevision,
    cols,
    rows,
    previewText: typeof state.previewText === 'string' ? state.previewText : '',
    previewSnapshot: state.previewSnapshot || null,
    renderedScrollback: finiteNonNegativeInteger(state.renderedScrollback) || 0,
    scrollbackAvailable: finiteNonNegativeInteger(state.scrollbackAvailable) || 0,
    title: typeof state.title === 'string' ? state.title : '',
  };
}

export {
  DEFAULT_TERMINAL_ATTACH_CHECKPOINT_TIMEOUT_MS,
  captureTerminalAttachCheckpoint,
};
