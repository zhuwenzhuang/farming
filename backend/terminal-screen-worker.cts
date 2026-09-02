import * as path from 'path';
import * as fs from 'fs';
import { EventEmitter } from 'events';
import { Worker } from 'worker_threads';

const APPEND_FLUSH_INTERVAL_MS = 16;
const MAX_PENDING_APPEND_BYTES = 128 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 30000;
const DEFAULT_STATE_REQUEST_HARD_TIMEOUT_MS = 5000;
const PACKAGED_WORKER_FILE = 'terminal-screen-worker-thread.pkg.js';
const SOURCE_WORKER_FILE = 'terminal-screen-worker-thread.cjs';

export interface TerminalScreenWorkerOptions extends Record<string, unknown> {
  requestTimeoutMs?: number;
  stateRequestHardTimeoutMs?: number;
  WorkerClass?: TerminalWorkerConstructor;
}

export interface TerminalScreenWorkerPreview {
  cols: number;
  previewSnapshot: unknown;
  previewText: string;
  rows: number;
  title: string;
}

export interface TerminalScreenWorkerState extends TerminalScreenWorkerPreview {
  outputSeq: number;
  renderOutput: string;
  renderedScrollback?: number;
  runtimeEpoch: string;
  scrollbackAvailable?: number;
  stateRevision: number;
}

interface TerminalWorkerLike {
  on(eventName: string, listener: (...args: unknown[]) => void): unknown;
  postMessage(message: Record<string, unknown>): void;
  terminate(): Promise<unknown>;
}

interface TerminalWorkerConstructor {
  new(
    workerFile: string,
    options: { workerData: Record<string, unknown> },
  ): TerminalWorkerLike;
}

interface PendingRequest {
  reject(error: unknown): void;
  resolve(value: unknown): void;
  timer: NodeJS.Timeout;
}

interface AppendEntry {
  data: string;
  outputSeq: number | null;
  stateRevision: number;
}

interface PendingAppendWaiter {
  reject(error: unknown): void;
  resolve(value: unknown): void;
}

interface TerminalScreenRequestOptions {
  flushAppend?: boolean;
  timeoutMs?: number;
}

interface TerminalScreenStateOptions {
  includeRenderOutput?: boolean;
  scrollback?: number;
  timeoutMs?: number;
}

function errorCode(error: unknown): string {
  return error && typeof error === 'object' && 'code' in error
    ? String(error.code)
    : '';
}

function byteLength(value: unknown): number {
  return Buffer.byteLength(String(value || ''), 'utf8');
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function resolveWorkerFile(): string {
  const wantsPackagedWorker = process.pkg || process.env.FARMING_PACKAGED_RUNTIME === '1';
  if (!wantsPackagedWorker) return SOURCE_WORKER_FILE;

  const packagedWorkerPath = path.join(__dirname, PACKAGED_WORKER_FILE);
  return fs.existsSync(packagedWorkerPath)
    ? PACKAGED_WORKER_FILE
    : SOURCE_WORKER_FILE;
}

class TerminalScreenWorker extends EventEmitter {
  static readonly DEFAULT_REQUEST_TIMEOUT_MS = DEFAULT_REQUEST_TIMEOUT_MS;
  static readonly DEFAULT_STATE_REQUEST_HARD_TIMEOUT_MS = DEFAULT_STATE_REQUEST_HARD_TIMEOUT_MS;
  static readonly resolveWorkerFile = resolveWorkerFile;

  readonly worker: TerminalWorkerLike;
  readonly pendingRequests = new Map<number, PendingRequest>();
  pendingAppendEntries: AppendEntry[] = [];
  pendingAppendWaiters: PendingAppendWaiter[] = [];
  pendingAppendBytes = 0;
  appendFlushTimer: NodeJS.Timeout | null = null;
  stateRequestsInFlight = new Map<number, Promise<unknown>>();
  failed = false;
  disposed = false;
  private nextRequestId = 1;
  private readonly requestTimeoutMs: number;
  private readonly stateRequestHardTimeoutMs: number;

  constructor(options: TerminalScreenWorkerOptions = {}) {
    super();
    const requestTimeoutMs = finiteNumber(options.requestTimeoutMs);
    this.requestTimeoutMs = requestTimeoutMs !== null
      ? Math.max(1, Math.floor(requestTimeoutMs))
      : DEFAULT_REQUEST_TIMEOUT_MS;
    const stateRequestHardTimeoutMs = finiteNumber(options.stateRequestHardTimeoutMs);
    this.stateRequestHardTimeoutMs = stateRequestHardTimeoutMs !== null
      ? Math.max(1, Math.floor(stateRequestHardTimeoutMs))
      : Math.min(this.requestTimeoutMs, DEFAULT_STATE_REQUEST_HARD_TIMEOUT_MS);
    const workerFile = resolveWorkerFile();
    const WorkerClass = options.WorkerClass || Worker as unknown as TerminalWorkerConstructor;
    const workerData = { ...options };
    delete workerData.WorkerClass;
    delete workerData.requestTimeoutMs;
    delete workerData.stateRequestHardTimeoutMs;
    this.worker = new WorkerClass(path.join(__dirname, workerFile), {
      workerData,
    });

    this.worker.on('message', (value: unknown) => {
      const message = value && typeof value === 'object'
        ? value as Record<string, unknown>
        : null;
      if (!message || typeof message !== 'object') {
        return;
      }

      if (message.type === 'preview') {
        this.emit('preview', {
          previewText: message.previewText || '',
          title: message.title || '',
          cols: message.cols || 0,
          rows: message.rows || 0,
          previewSnapshot: message.previewSnapshot || null,
        });
        return;
      }

      if (message.type === 'response' && typeof message.requestId === 'number') {
        const pending = this.pendingRequests.get(message.requestId);
        if (!pending) return;
        this.pendingRequests.delete(message.requestId);
        clearTimeout(pending.timer);
        if (message.error) {
          pending.reject(new Error(String(message.error)));
          return;
        }
        pending.resolve(message.payload);
        return;
      }

      if (message.type === 'error') {
        this.emit('error', new Error(String(message.message || 'Unknown worker error')));
      }
    });

    this.worker.on('error', (error: unknown) => {
      this.handleWorkerFailure(error);
    });

    this.worker.on('exit', (code: unknown) => {
      if (this.disposed) {
        return;
      }

      this.handleWorkerFailure(new Error(`Terminal screen worker exited unexpectedly with code ${code}`));
    });
  }

  private handleWorkerFailure(error: unknown): void {
    if (this.disposed) return;
    const failure = error instanceof Error ? error : new Error(String(error));
    const shouldEmit = !this.failed;
    this.failed = true;
    if (this.appendFlushTimer) {
      clearTimeout(this.appendFlushTimer);
      this.appendFlushTimer = null;
    }
    this.pendingAppendEntries = [];
    this.pendingAppendBytes = 0;
    this.pendingAppendWaiters.splice(0).forEach(({ reject }) => reject(failure));
    this.pendingRequests.forEach(({ reject, timer }) => {
      clearTimeout(timer);
      reject(failure);
    });
    this.pendingRequests.clear();
    if (shouldEmit && this.listenerCount('error') > 0) {
      this.emit('error', failure);
    }
  }

  private handlePostMessageFailure(error: unknown): void {
    this.handleWorkerFailure(error);
  }

  private postWorkerMessage(
    message: Record<string, unknown>,
    options: { throwOnError?: boolean } = {},
  ): boolean {
    try {
      this.worker.postMessage(message);
      return true;
    } catch (error) {
      if (options.throwOnError) throw error;
      this.handlePostMessageFailure(error);
      return false;
    }
  }

  private flushAppend(): void {
    if (this.appendFlushTimer) {
      clearTimeout(this.appendFlushTimer);
      this.appendFlushTimer = null;
    }
    if (this.disposed || this.failed || this.pendingAppendEntries.length === 0) {
      this.pendingAppendEntries = [];
      this.pendingAppendBytes = 0;
      return;
    }

    const entries = this.pendingAppendEntries;
    const waiters = this.pendingAppendWaiters;
    this.pendingAppendEntries = [];
    this.pendingAppendBytes = 0;
    this.pendingAppendWaiters = [];
    this.request('append', { entries }, { flushAppend: false }).then(
      state => waiters.forEach(({ resolve }) => resolve(state)),
      error => waiters.forEach(({ reject }) => reject(error)),
    );
  }

  private request(
    type: string,
    payload: Record<string, unknown> = {},
    options: TerminalScreenRequestOptions = {},
  ): Promise<unknown> {
    if (this.disposed) {
      return Promise.reject(new Error('Terminal screen worker is disposed'));
    }
    if (this.failed) {
      return Promise.reject(new Error('Terminal screen worker is not available'));
    }

    if (options.flushAppend !== false) {
      this.flushAppend();
    }
    if (this.failed) {
      return Promise.reject(new Error('Terminal screen worker is not available'));
    }
    const requestId = this.nextRequestId;
    this.nextRequestId += 1;

    return new Promise<unknown>((resolve, reject) => {
      const requestedTimeoutMs = finiteNumber(options.timeoutMs);
      const requestTimeoutMs = requestedTimeoutMs !== null
        ? Math.max(1, Math.floor(requestedTimeoutMs))
        : this.requestTimeoutMs;
      const timer = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        const error = Object.assign(
          new Error(`Terminal screen worker request timed out: ${type}`),
          { code: 'ETIMEDOUT' },
        );
        reject(error);
      }, requestTimeoutMs);
      if (typeof timer.unref === 'function') timer.unref();

      this.pendingRequests.set(requestId, { resolve, reject, timer });
      try {
        this.postWorkerMessage({
          requestId,
          type,
          ...payload,
        }, { throwOnError: true });
      } catch (error) {
        this.pendingRequests.delete(requestId);
        clearTimeout(timer);
        this.handlePostMessageFailure(error);
        reject(error);
      }
    });
  }

  append(
    data: unknown,
    stateRevision: number,
    outputSeq: number | null = null,
  ): Promise<unknown> | undefined {
    if (this.disposed || this.failed) {
      return Promise.reject(new Error('Terminal screen worker is not available'));
    }

    const text = String(data || '');
    if (!text) return;
    if (!Number.isFinite(stateRevision)) {
      this.handlePostMessageFailure(new Error('Terminal screen append requires a finite state revision'));
      return Promise.reject(new Error('Terminal screen append requires a finite state revision'));
    }

    if (
      this.pendingAppendEntries.length > 0 &&
      this.pendingAppendBytes + byteLength(text) > MAX_PENDING_APPEND_BYTES
    ) {
      this.flushAppend();
    }

    return new Promise<unknown>((resolve, reject) => {
      this.pendingAppendEntries.push({ data: text, stateRevision, outputSeq });
      this.pendingAppendBytes += byteLength(text);
      this.pendingAppendWaiters.push({ resolve, reject });
      if (byteLength(text) > MAX_PENDING_APPEND_BYTES) {
        this.flushAppend();
        return;
      }
      if (this.appendFlushTimer) return;
      this.appendFlushTimer = setTimeout(() => {
        this.flushAppend();
      }, APPEND_FLUSH_INTERVAL_MS);
    });
  }

  resize(
    cols: number,
    rows: number,
    stateRevision: number,
  ): Promise<TerminalScreenWorkerState> {
    return this.request(
      'resize',
      { cols, rows, stateRevision },
    ) as Promise<TerminalScreenWorkerState>;
  }

  setRuntimeEpoch(runtimeEpoch: string, cols: number, rows: number): Promise<unknown> {
    return this.request('set-runtime-epoch', { runtimeEpoch, cols, rows });
  }

  clear(
    stateRevision: number,
    outputSeq: number | null = null,
  ): Promise<TerminalScreenWorkerState> {
    return this.request('clear', { stateRevision, outputSeq }) as Promise<TerminalScreenWorkerState>;
  }

  getState(options: TerminalScreenStateOptions = {}): Promise<TerminalScreenWorkerState> {
    const requestedScrollback = finiteNumber(options.scrollback);
    const scrollback = requestedScrollback === null ? -1 : Math.max(0, Math.floor(requestedScrollback));
    if (!this.stateRequestsInFlight.has(scrollback)) {
      const request = this.request('get-state', {
        includeRenderOutput: true,
        ...(scrollback >= 0 ? { scrollback } : {}),
      }, {
        // Caller deadlines are deliberately softer than this shared deadline.
        // A timed-out caller may stop waiting, but the single-flight itself
        // must never poison every later checkpoint for the generic 30s worker
        // request timeout. Crossing this hard deadline means the authoritative
        // reducer can no longer prove progress, so fail it closed.
        timeoutMs: this.stateRequestHardTimeoutMs,
      });
      const sharedRequest = request.catch((error: unknown) => {
        if (errorCode(error) === 'ETIMEDOUT') {
          this.handleWorkerFailure(error);
        }
        throw error;
      }).finally(() => {
        if (this.stateRequestsInFlight.get(scrollback) === sharedRequest) {
          this.stateRequestsInFlight.delete(scrollback);
        }
      });
      this.stateRequestsInFlight.set(scrollback, sharedRequest);
    }

    const sharedRequest = this.stateRequestsInFlight.get(scrollback)!;
    const timeoutMs = typeof options.timeoutMs === 'number' && Number.isFinite(options.timeoutMs)
      ? Math.max(1, Math.floor(options.timeoutMs))
      : null;
    if (timeoutMs === null) return sharedRequest as Promise<TerminalScreenWorkerState>;

    return new Promise<TerminalScreenWorkerState>((resolve, reject) => {
      const timer = setTimeout(() => {
        const error = Object.assign(
          new Error('Terminal screen worker request timed out: get-state'),
          { code: 'ETIMEDOUT' },
        );
        reject(error);
      }, timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
      sharedRequest.then(
        (state) => {
          clearTimeout(timer);
          resolve(state as TerminalScreenWorkerState);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }

  async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }

    try {
      await this.request('dispose');
    } catch {
      // best effort
    }
    if (this.appendFlushTimer) {
      clearTimeout(this.appendFlushTimer);
      this.appendFlushTimer = null;
    }
    this.pendingAppendEntries = [];
    this.pendingAppendBytes = 0;
    this.pendingAppendWaiters.splice(0).forEach(({ reject }) => {
      reject(new Error('Terminal screen worker is disposed'));
    });
    this.disposed = true;
    this.pendingRequests.forEach(({ reject, timer }) => {
      clearTimeout(timer);
      reject(new Error('Terminal screen worker disposed'));
    });
    this.pendingRequests.clear();
    await this.worker.terminate();
  }
}

export {
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_STATE_REQUEST_HARD_TIMEOUT_MS,
  TerminalScreenWorker,
  resolveWorkerFile,
};
