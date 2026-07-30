const DEFAULT_REDUCER_HIGH_WATERMARK_BYTES = 512 * 1024;
const DEFAULT_REDUCER_LOW_WATERMARK_BYTES = 64 * 1024;

interface TerminalReducerFlowControlOptions {
  highWatermarkBytes?: number;
  lowWatermarkBytes?: number;
}

export interface TerminalReducerFlowControl {
  pendingBytes: number;
  paused: boolean;
  reducerBlocked: boolean;
  externalBlocked: boolean;
  highWatermarkBytes: number;
  lowWatermarkBytes: number;
}

interface TerminalFlowControlProcess {
  pause?(): void;
  resume?(): void;
}

export interface TerminalReducerFlowControlSession {
  reducerFlowControl?: TerminalReducerFlowControl | null;
}

interface TerminalReducerEnqueueResult {
  bytes: number;
  error: Error | null;
}

function positiveInteger(value: unknown, fallback: number): number {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function createTerminalReducerFlowControl(
  options: TerminalReducerFlowControlOptions = {},
): TerminalReducerFlowControl {
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
    paused: false,
    reducerBlocked: false,
    externalBlocked: false,
    highWatermarkBytes,
    lowWatermarkBytes,
  };
}

function ensureTerminalReducerFlowControl(
  session: TerminalReducerFlowControlSession | null | undefined,
  options: TerminalReducerFlowControlOptions = {},
): TerminalReducerFlowControl {
  if (!session || typeof session !== 'object') {
    return createTerminalReducerFlowControl(options);
  }
  if (!session.reducerFlowControl || typeof session.reducerFlowControl !== 'object') {
    session.reducerFlowControl = createTerminalReducerFlowControl(options);
  }
  return session.reducerFlowControl;
}

function terminalReducerDataBytes(data: unknown): number {
  return Buffer.byteLength(String(data || ''), 'utf8');
}

function reconcileTerminalFlowControl(
  control: TerminalReducerFlowControl,
  process: TerminalFlowControlProcess | null | undefined,
): Error | null {
  const shouldPause = control.reducerBlocked || control.externalBlocked;
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

function setTerminalExternalFlowControlBlocked(
  control: TerminalReducerFlowControl,
  process: TerminalFlowControlProcess | null | undefined,
  blocked: unknown,
): Error | null {
  control.externalBlocked = blocked === true;
  return reconcileTerminalFlowControl(control, process);
}

function enqueueTerminalReducerData(
  control: TerminalReducerFlowControl,
  process: TerminalFlowControlProcess | null | undefined,
  data: unknown,
): TerminalReducerEnqueueResult {
  const bytes = terminalReducerDataBytes(data);
  control.pendingBytes += bytes;
  if (!control.reducerBlocked && control.pendingBytes > control.highWatermarkBytes) {
    control.reducerBlocked = true;
  }
  return { bytes, error: reconcileTerminalFlowControl(control, process) };
}

function acknowledgeTerminalReducerData(
  control: TerminalReducerFlowControl,
  process: TerminalFlowControlProcess | null | undefined,
  bytes: unknown,
): Error | null {
  const acknowledgedBytes = Math.max(0, Math.floor(Number(bytes) || 0));
  control.pendingBytes = Math.max(0, control.pendingBytes - acknowledgedBytes);
  if (control.reducerBlocked && control.pendingBytes < control.lowWatermarkBytes) {
    control.reducerBlocked = false;
  }
  return reconcileTerminalFlowControl(control, process);
}

function resetTerminalReducerFlowControl(
  control: TerminalReducerFlowControl,
  process: TerminalFlowControlProcess | null | undefined,
): Error | null {
  control.pendingBytes = 0;
  control.reducerBlocked = false;
  return reconcileTerminalFlowControl(control, process);
}

export {
  DEFAULT_REDUCER_HIGH_WATERMARK_BYTES,
  DEFAULT_REDUCER_LOW_WATERMARK_BYTES,
  acknowledgeTerminalReducerData,
  createTerminalReducerFlowControl,
  ensureTerminalReducerFlowControl,
  enqueueTerminalReducerData,
  resetTerminalReducerFlowControl,
  setTerminalExternalFlowControlBlocked,
  terminalReducerDataBytes,
};
