import { parentPort, workerData } from 'worker_threads';
import { TerminalScreenState } from './terminal-screen-state.cjs';
import type { TerminalScreenSnapshot } from './terminal-screen-state.cjs';

const PREVIEW_FLUSH_INTERVAL_MS = 50;

interface TerminalScreenWorkerMessage extends Record<string, unknown> {
  cols?: number;
  data?: unknown;
  entries?: unknown;
  includeRenderOutput?: boolean;
  outputSeq?: number;
  requestId?: number;
  rows?: number;
  runtimeEpoch?: string;
  stateRevision?: number;
  type?: string;
}

interface TerminalScreenReadOptions {
  emitPreview?: boolean;
  includeRenderOutput?: boolean;
  refreshPreview?: boolean;
}

interface TerminalScreenStateWithRevision extends TerminalScreenSnapshot {
  outputSeq: number;
  runtimeEpoch: string;
  stateRevision: number;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const workerPort = parentPort;
const initialWorkerData = workerData && typeof workerData === 'object'
  ? workerData as Record<string, unknown>
  : {};
const screenState = new TerminalScreenState(initialWorkerData);
let runtimeEpoch = typeof initialWorkerData.runtimeEpoch === 'string'
  ? initialWorkerData.runtimeEpoch
  : '';
let appliedOutputSeq = 0;
let appliedStateRevision = 0;
let lastPreviewText = '';
let lastTitle = '';
let lastSnapshotFingerprint = '';
let messageQueue: Promise<void> = Promise.resolve();
let previewFlushTimer: NodeJS.Timeout | null = null;

function postPreview(state: TerminalScreenSnapshot): void {
  const previewText = state.previewText || '';
  const title = state.title || '';
  const previewSnapshot = state.previewSnapshot || null;
  const snapshotFingerprint = previewSnapshot ? JSON.stringify(previewSnapshot) : '';

  if (previewText === lastPreviewText && title === lastTitle && snapshotFingerprint === lastSnapshotFingerprint) {
    return;
  }

  lastPreviewText = previewText;
  lastTitle = title;
  lastSnapshotFingerprint = snapshotFingerprint;
  workerPort?.postMessage({
    type: 'preview',
    previewText,
    title,
    cols: state.cols || 0,
    rows: state.rows || 0,
    previewSnapshot,
  });
}

function withOutputSeq(state: TerminalScreenSnapshot): TerminalScreenStateWithRevision {
  return {
    ...state,
    runtimeEpoch,
    outputSeq: appliedOutputSeq,
    stateRevision: appliedStateRevision,
  };
}

function currentState(options: TerminalScreenReadOptions = {}): TerminalScreenStateWithRevision {
  const state = screenState.getState({
    includeRenderOutput: options.includeRenderOutput,
    refreshPreview: options.refreshPreview,
  });
  if (options.emitPreview) {
    postPreview(state);
  }
  return withOutputSeq(state);
}

function schedulePreview(): void {
  if (previewFlushTimer) return;
  previewFlushTimer = setTimeout(() => {
    previewFlushTimer = null;
    postPreview(currentState({
      includeRenderOutput: false,
      refreshPreview: true,
    }));
  }, PREVIEW_FLUSH_INTERVAL_MS);
  if (typeof previewFlushTimer.unref === 'function') previewFlushTimer.unref();
}

function assertNextRevision(stateRevision: unknown, transition: string): asserts stateRevision is number {
  if (!Number.isFinite(stateRevision) || stateRevision !== appliedStateRevision + 1) {
    throw new Error(
      `Terminal screen ${transition} revision gap: expected ${appliedStateRevision + 1}, received ${stateRevision}`,
    );
  }
}

function assertFiniteDimension(value: unknown, name: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Terminal screen ${name} must be finite`);
  }
}

async function appendEntries(rawEntries: unknown): Promise<TerminalScreenSnapshot | undefined> {
  const entries = Array.isArray(rawEntries) ? rawEntries : [];
  if (entries.length === 0) return;

  let expectedRevision = appliedStateRevision + 1;
  let nextOutputSeq = appliedOutputSeq;
  let data = '';
  for (const value of entries) {
    const entry = value && typeof value === 'object'
      ? value as Record<string, unknown>
      : {};
    const stateRevision = Number(entry.stateRevision);
    if (!Number.isFinite(stateRevision) || stateRevision !== expectedRevision) {
      throw new Error(
        `Terminal screen append revision gap: expected ${expectedRevision}, received ${entry.stateRevision}`,
      );
    }
    const text = String(entry.data || '');
    if (!text) {
      throw new Error(`Terminal screen append revision ${stateRevision} has no data`);
    }
    const outputSeq = Number(entry.outputSeq);
    if (!Number.isFinite(outputSeq) || outputSeq !== nextOutputSeq + 1) {
      throw new Error(
        `Terminal screen output sequence gap: expected ${nextOutputSeq + 1}, received ${entry.outputSeq}`,
      );
    }
    data += text;
    nextOutputSeq = outputSeq;
    expectedRevision += 1;
  }

  const state = await screenState.write(data);
  appliedStateRevision = expectedRevision - 1;
  appliedOutputSeq = nextOutputSeq;
  schedulePreview();
  return state;
}

async function handleRequest(message: TerminalScreenWorkerMessage): Promise<unknown> {
  switch (message.type) {
    case 'append':
      await appendEntries(message.entries);
      return currentState({
        includeRenderOutput: false,
        refreshPreview: false,
      });
    case 'set-runtime-epoch':
      runtimeEpoch = typeof message.runtimeEpoch === 'string' ? message.runtimeEpoch : '';
      appliedOutputSeq = 0;
      appliedStateRevision = 0;
      if (
        typeof message.cols === 'number'
        && Number.isFinite(message.cols)
        && typeof message.rows === 'number'
        && Number.isFinite(message.rows)
      ) {
        screenState.resize(message.cols, message.rows);
      }
      return currentState({ includeRenderOutput: false });
    case 'resize': {
      assertNextRevision(message.stateRevision, 'resize');
      assertFiniteDimension(message.cols, 'columns');
      assertFiniteDimension(message.rows, 'rows');
      screenState.resize(message.cols, message.rows);
      appliedStateRevision = message.stateRevision;
      const state = screenState.getState({ includeRenderOutput: true });
      postPreview(state);
      return withOutputSeq(state);
    }
    case 'clear': {
      assertNextRevision(message.stateRevision, 'clear');
      const state = await screenState.clearBuffer();
      const outputSeq = Number(message.outputSeq);
      if (!Number.isFinite(outputSeq) || outputSeq !== appliedOutputSeq) {
        throw new Error(
          `Terminal screen clear output sequence mismatch: expected ${appliedOutputSeq}, received ${message.outputSeq}`,
        );
      }
      appliedStateRevision = message.stateRevision;
      postPreview(state);
      return withOutputSeq(state);
    }
    case 'get-state':
      return currentState({
        includeRenderOutput: message.includeRenderOutput !== false,
        emitPreview: false,
      });
    case 'dispose':
      if (previewFlushTimer) {
        clearTimeout(previewFlushTimer);
        previewFlushTimer = null;
      }
      screenState.dispose();
      return { disposed: true };
    default:
      throw new Error(`Unknown worker message type: ${message.type}`);
  }
}

async function processMessage(message: TerminalScreenWorkerMessage): Promise<void> {
  try {
    const payload = await handleRequest(message);
    if (message.requestId) {
      workerPort?.postMessage({
        type: 'response',
        requestId: message.requestId,
        payload,
      });
    }
  } catch (error: unknown) {
    if (message.requestId) {
      workerPort?.postMessage({
        type: 'response',
        requestId: message.requestId,
        error: errorMessage(error),
      });
      return;
    }

    workerPort?.postMessage({
      type: 'error',
      message: errorMessage(error),
    });
  }
}

workerPort?.on('message', (message: TerminalScreenWorkerMessage) => {
  messageQueue = messageQueue.then(
    () => processMessage(message),
    () => processMessage(message),
  );
});
