const { parentPort, workerData } = require('worker_threads');
const TerminalScreenState = require('./terminal-screen-state');

const PREVIEW_FLUSH_INTERVAL_MS = 120;
const MAX_PENDING_DATA_BYTES = 128 * 1024;

const screenState = new TerminalScreenState(workerData || {});
let pendingData = '';
let previewFlushTimer = null;
let lastPreviewText = '';
let lastTitle = '';
let lastSnapshotFingerprint = '';
let messageQueue = Promise.resolve();

function byteLength(value) {
  return Buffer.byteLength(String(value || ''), 'utf8');
}

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

async function flushPending(options = {}) {
  if (previewFlushTimer) {
    clearTimeout(previewFlushTimer);
    previewFlushTimer = null;
  }

  if (pendingData) {
    const data = pendingData;
    pendingData = '';
    const state = await screenState.write(data);
    if (options.emitPreview !== false) {
      postPreview(state);
    }
    return screenState.getState({ includeRenderOutput: options.includeRenderOutput });
  }

  const state = screenState.getState({ includeRenderOutput: options.includeRenderOutput });
  if (options.emitPreview) {
    postPreview(state);
  }
  return state;
}

function scheduleFlush() {
  if (previewFlushTimer) {
    return;
  }

  previewFlushTimer = setTimeout(() => {
    flushPending({ includeRenderOutput: false, emitPreview: true }).catch((error) => {
      parentPort.postMessage({
        type: 'error',
        message: error.message,
      });
    });
  }, PREVIEW_FLUSH_INTERVAL_MS);
}

async function appendData(data) {
  const text = String(data || '');
  if (!text) return;

  if (pendingData && byteLength(pendingData) + byteLength(text) > MAX_PENDING_DATA_BYTES) {
    await flushPending({ includeRenderOutput: false, emitPreview: false });
  }

  if (byteLength(text) > MAX_PENDING_DATA_BYTES) {
    const state = await screenState.write(text);
    postPreview(state);
    return;
  }

  pendingData += text;
  scheduleFlush();
}

async function handleRequest(message) {
  switch (message.type) {
    case 'append':
      await appendData(message.data);
      return null;
    case 'resize': {
      await flushPending({ includeRenderOutput: false, emitPreview: false });
      const state = screenState.resize(message.cols, message.rows);
      postPreview(state);
      return state;
    }
    case 'clear': {
      await flushPending({ includeRenderOutput: false, emitPreview: false });
      const state = await screenState.clearBuffer();
      postPreview(state);
      return state;
    }
    case 'get-state':
      return flushPending({
        includeRenderOutput: message.includeRenderOutput !== false,
        emitPreview: false,
      });
    case 'dispose':
      await flushPending({ includeRenderOutput: false, emitPreview: false });
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
