const DEFAULT_REDUCER_HIGH_WATERMARK_BYTES = 512 * 1024;
const DEFAULT_REDUCER_LOW_WATERMARK_BYTES = 64 * 1024;
const DEFAULT_RENDERER_HIGH_WATERMARK_CHARS = 100000;
const DEFAULT_RENDERER_LOW_WATERMARK_CHARS = 5000;
const DEFAULT_RENDERER_ACK_CHARS = 5000;

function positiveInteger(value, fallback) {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function createTerminalReducerFlowControl(options = {}) {
  const highWatermarkBytes = positiveInteger(
    options.highWatermarkBytes,
    DEFAULT_REDUCER_HIGH_WATERMARK_BYTES,
  );
  const lowWatermarkBytes = Math.min(
    highWatermarkBytes,
    positiveInteger(options.lowWatermarkBytes, DEFAULT_REDUCER_LOW_WATERMARK_BYTES),
  );
  return {
    pendingBytes: 0,
    unacknowledgedRendererChars: 0,
    rendererDebt: [],
    paused: false,
    reducerBlocked: false,
    rendererBlocked: false,
    externalBlocked: false,
    highWatermarkBytes,
    lowWatermarkBytes,
    rendererHighWatermarkChars: positiveInteger(
      options.rendererHighWatermarkChars,
      DEFAULT_RENDERER_HIGH_WATERMARK_CHARS,
    ),
    rendererLowWatermarkChars: positiveInteger(
      options.rendererLowWatermarkChars,
      DEFAULT_RENDERER_LOW_WATERMARK_CHARS,
    ),
  };
}

function ensureTerminalReducerFlowControl(session, options = {}) {
  if (!session || typeof session !== 'object') {
    return createTerminalReducerFlowControl(options);
  }
  if (!session.reducerFlowControl || typeof session.reducerFlowControl !== 'object') {
    session.reducerFlowControl = createTerminalReducerFlowControl(options);
  }
  if (!Array.isArray(session.reducerFlowControl.rendererDebt)) {
    session.reducerFlowControl.rendererDebt = [];
  }
  return session.reducerFlowControl;
}

function terminalReducerDataBytes(data) {
  return Buffer.byteLength(String(data || ''), 'utf8');
}

function reconcileTerminalFlowControl(control, process) {
  const shouldPause = control.reducerBlocked || control.rendererBlocked || control.externalBlocked;
  if (shouldPause === control.paused) return null;
  const method = shouldPause ? 'pause' : 'resume';
  if (!process || typeof process[method] !== 'function') {
    return new Error(`Native PTY does not support terminal flow-control ${method}`);
  }
  try {
    process[method]();
    control.paused = shouldPause;
    return null;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}

function setTerminalExternalFlowControlBlocked(control, process, blocked) {
  control.externalBlocked = blocked === true;
  return reconcileTerminalFlowControl(control, process);
}

function enqueueTerminalReducerData(control, process, data) {
  const bytes = terminalReducerDataBytes(data);
  control.pendingBytes += bytes;
  if (!control.reducerBlocked && control.pendingBytes > control.highWatermarkBytes) {
    control.reducerBlocked = true;
  }
  return { bytes, error: reconcileTerminalFlowControl(control, process) };
}

function acknowledgeTerminalReducerData(control, process, bytes) {
  const acknowledgedBytes = Math.max(0, Math.floor(Number(bytes) || 0));
  control.pendingBytes = Math.max(0, control.pendingBytes - acknowledgedBytes);
  if (control.reducerBlocked && control.pendingBytes < control.lowWatermarkBytes) {
    control.reducerBlocked = false;
  }
  return reconcileTerminalFlowControl(control, process);
}

function enqueueTerminalRendererData(control, process, charCount, outputSeq) {
  const chars = Math.max(0, Math.floor(Number(charCount) || 0));
  if (chars > 0 && Number.isFinite(outputSeq)) {
    control.rendererDebt.push({
      outputSeq: Math.max(0, Math.floor(outputSeq)),
      charCount: chars,
    });
  }
  control.unacknowledgedRendererChars += chars;
  if (
    !control.rendererBlocked &&
    control.unacknowledgedRendererChars > control.rendererHighWatermarkChars
  ) {
    control.rendererBlocked = true;
  }
  return reconcileTerminalFlowControl(control, process);
}

function acknowledgeTerminalRendererData(control, process, charCount) {
  const chars = Math.max(0, Math.floor(Number(charCount) || 0));
  let remaining = chars;
  while (remaining > 0 && control.rendererDebt.length > 0) {
    const debt = control.rendererDebt[0];
    const consumed = Math.min(remaining, debt.charCount);
    debt.charCount -= consumed;
    remaining -= consumed;
    if (debt.charCount === 0) control.rendererDebt.shift();
  }
  control.unacknowledgedRendererChars = Math.max(
    0,
    control.unacknowledgedRendererChars - chars,
  );
  if (
    control.rendererBlocked &&
    control.unacknowledgedRendererChars < control.rendererLowWatermarkChars
  ) {
    control.rendererBlocked = false;
  }
  return reconcileTerminalFlowControl(control, process);
}

function acknowledgeTerminalRendererCheckpoint(control, process, outputSeq) {
  const appliedOutputSeq = Math.max(0, Math.floor(Number(outputSeq) || 0));
  let coveredChars = 0;
  control.rendererDebt = control.rendererDebt.filter((debt) => {
    if (debt.outputSeq > appliedOutputSeq) return true;
    coveredChars += debt.charCount;
    return false;
  });
  control.unacknowledgedRendererChars = Math.max(
    0,
    control.unacknowledgedRendererChars - coveredChars,
  );
  if (
    control.rendererBlocked &&
    control.unacknowledgedRendererChars < control.rendererLowWatermarkChars
  ) {
    control.rendererBlocked = false;
  }
  return {
    coveredChars,
    error: reconcileTerminalFlowControl(control, process),
  };
}

function resetTerminalRendererFlowControl(control, process) {
  control.unacknowledgedRendererChars = 0;
  control.rendererDebt = [];
  control.rendererBlocked = false;
  return reconcileTerminalFlowControl(control, process);
}

function resetTerminalReducerFlowControl(control, process) {
  control.pendingBytes = 0;
  control.unacknowledgedRendererChars = 0;
  control.rendererDebt = [];
  control.reducerBlocked = false;
  control.rendererBlocked = false;
  return reconcileTerminalFlowControl(control, process);
}

module.exports = {
  DEFAULT_REDUCER_HIGH_WATERMARK_BYTES,
  DEFAULT_REDUCER_LOW_WATERMARK_BYTES,
  DEFAULT_RENDERER_ACK_CHARS,
  DEFAULT_RENDERER_HIGH_WATERMARK_CHARS,
  DEFAULT_RENDERER_LOW_WATERMARK_CHARS,
  acknowledgeTerminalReducerData,
  acknowledgeTerminalRendererCheckpoint,
  acknowledgeTerminalRendererData,
  createTerminalReducerFlowControl,
  ensureTerminalReducerFlowControl,
  enqueueTerminalReducerData,
  enqueueTerminalRendererData,
  resetTerminalReducerFlowControl,
  resetTerminalRendererFlowControl,
  setTerminalExternalFlowControlBlocked,
  terminalReducerDataBytes,
};
