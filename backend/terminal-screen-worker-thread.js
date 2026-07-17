const { parentPort, workerData } = require('worker_threads');
const TerminalScreenState = require('./terminal-screen-state');

const PREVIEW_FLUSH_INTERVAL_MS = 50;

const screenState = new TerminalScreenState(workerData || {});
let runtimeEpoch = typeof workerData.runtimeEpoch === 'string' ? workerData.runtimeEpoch : '';
let appliedOutputSeq = 0;
let appliedStateRevision = 0;
let lastPreviewText = '';
let lastTitle = '';
let lastSnapshotFingerprint = '';
let messageQueue = Promise.resolve();
let previewFlushTimer = null;

function postPreview(state) {
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
  parentPort.postMessage({
    type: 'preview',
    previewText,
    title,
    cols: state.cols || 0,
    rows: state.rows || 0,
    previewSnapshot,
  });
}

function withOutputSeq(state) {
  return {
    ...state,
    runtimeEpoch,
    outputSeq: appliedOutputSeq,
    stateRevision: appliedStateRevision,
  };
}

function currentState(options = {}) {
  const state = screenState.getState({
    includeRenderOutput: options.includeRenderOutput,
    refreshPreview: options.refreshPreview,
  });
  if (options.emitPreview) {
    postPreview(state);
  }
  return withOutputSeq(state);
}

function schedulePreview() {
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

function assertNextRevision(stateRevision, transition) {
  if (!Number.isFinite(stateRevision) || stateRevision !== appliedStateRevision + 1) {
    throw new Error(
      `Terminal screen ${transition} revision gap: expected ${appliedStateRevision + 1}, received ${stateRevision}`,
    );
  }
}

async function appendEntries(rawEntries) {
  const entries = Array.isArray(rawEntries) ? rawEntries : [];
  if (entries.length === 0) return;

  let expectedRevision = appliedStateRevision + 1;
  let nextOutputSeq = appliedOutputSeq;
  let data = '';
  for (const entry of entries) {
    const stateRevision = Number(entry && entry.stateRevision);
    if (!Number.isFinite(stateRevision) || stateRevision !== expectedRevision) {
      throw new Error(
        `Terminal screen append revision gap: expected ${expectedRevision}, received ${entry && entry.stateRevision}`,
      );
    }
    const text = String((entry && entry.data) || '');
    if (!text) {
      throw new Error(`Terminal screen append revision ${stateRevision} has no data`);
    }
    const outputSeq = Number(entry && entry.outputSeq);
    if (!Number.isFinite(outputSeq) || outputSeq !== nextOutputSeq + 1) {
      throw new Error(
        `Terminal screen output sequence gap: expected ${nextOutputSeq + 1}, received ${entry && entry.outputSeq}`,
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

async function handleRequest(message) {
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
      if (Number.isFinite(message.cols) && Number.isFinite(message.rows)) {
        screenState.resize(message.cols, message.rows);
      }
      return currentState({ includeRenderOutput: false });
    case 'resize': {
      assertNextRevision(message.stateRevision, 'resize');
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

async function processMessage(message) {
  try {
    const payload = await handleRequest(message);
    if (message.requestId) {
      parentPort.postMessage({
        type: 'response',
        requestId: message.requestId,
        payload,
      });
    }
  } catch (error) {
    if (message.requestId) {
      parentPort.postMessage({
        type: 'response',
        requestId: message.requestId,
        error: error.message,
      });
      return;
    }

    parentPort.postMessage({
      type: 'error',
      message: error.message,
    });
  }
}

parentPort.on('message', (message) => {
  messageQueue = messageQueue.then(
    () => processMessage(message),
    () => processMessage(message),
  );
});
