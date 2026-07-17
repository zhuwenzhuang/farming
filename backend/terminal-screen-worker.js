const path = require('path');
const fs = require('fs');
const EventEmitter = require('events');
const { Worker } = require('worker_threads');

const APPEND_FLUSH_INTERVAL_MS = 16;
const MAX_PENDING_APPEND_BYTES = 128 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 30000;
const DEFAULT_STATE_REQUEST_HARD_TIMEOUT_MS = 5000;
const PACKAGED_WORKER_FILE = 'terminal-screen-worker-thread.pkg.js';
const SOURCE_WORKER_FILE = 'terminal-screen-worker-thread.js';

function byteLength(value) {
  return Buffer.byteLength(String(value || ''), 'utf8');
}

function resolveWorkerFile() {
  const wantsPackagedWorker = process.pkg || process.env.FARMING_PACKAGED_RUNTIME === '1';
  if (!wantsPackagedWorker) return SOURCE_WORKER_FILE;

  const packagedWorkerPath = path.join(__dirname, PACKAGED_WORKER_FILE);
  return fs.existsSync(packagedWorkerPath)
    ? PACKAGED_WORKER_FILE
    : SOURCE_WORKER_FILE;
}

class TerminalScreenWorker extends EventEmitter {
  constructor(options = {}) {
    super();
    this.nextRequestId = 1;
    this.pendingRequests = new Map();
    this.pendingAppendEntries = [];
    this.pendingAppendBytes = 0;
    this.pendingAppendWaiters = [];
    this.appendFlushTimer = null;
    this.stateRequestInFlight = null;
    this.requestTimeoutMs = Number.isFinite(options.requestTimeoutMs)
      ? Math.max(1, Math.floor(options.requestTimeoutMs))
      : DEFAULT_REQUEST_TIMEOUT_MS;
    this.stateRequestHardTimeoutMs = Number.isFinite(options.stateRequestHardTimeoutMs)
      ? Math.max(1, Math.floor(options.stateRequestHardTimeoutMs))
      : Math.min(this.requestTimeoutMs, DEFAULT_STATE_REQUEST_HARD_TIMEOUT_MS);
    this.failed = false;
    this.disposed = false;
    const workerFile = resolveWorkerFile();
    const WorkerClass = options.WorkerClass || Worker;
    const workerData = { ...options };
    delete workerData.WorkerClass;
    delete workerData.requestTimeoutMs;
    delete workerData.stateRequestHardTimeoutMs;
    this.worker = new WorkerClass(path.join(__dirname, workerFile), {
      workerData,
    });

    this.worker.on('message', (message) => {
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

      if (message.type === 'response' && message.requestId) {
        const pending = this.pendingRequests.get(message.requestId);
        if (!pending) return;
        this.pendingRequests.delete(message.requestId);
        clearTimeout(pending.timer);
        if (message.error) {
          pending.reject(new Error(message.error));
          return;
        }
        pending.resolve(message.payload);
        return;
      }

      if (message.type === 'error') {
        this.emit('error', new Error(message.message || 'Unknown worker error'));
      }
    });

    this.worker.on('error', (error) => {
      this.handleWorkerFailure(error);
    });

    this.worker.on('exit', (code) => {
      if (this.disposed) {
        return;
      }

      this.handleWorkerFailure(new Error(`Terminal screen worker exited unexpectedly with code ${code}`));
    });
  }

  handleWorkerFailure(error) {
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

  handlePostMessageFailure(error) {
    this.handleWorkerFailure(error);
  }

  postWorkerMessage(message, options = {}) {
    try {
      this.worker.postMessage(message);
      return true;
    } catch (error) {
      if (options.throwOnError) throw error;
      this.handlePostMessageFailure(error);
      return false;
    }
  }

  flushAppend() {
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

  request(type, payload = {}, options = {}) {
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

    return new Promise((resolve, reject) => {
      const requestTimeoutMs = Number.isFinite(options.timeoutMs)
        ? Math.max(1, Math.floor(options.timeoutMs))
        : this.requestTimeoutMs;
      const timer = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        const error = new Error(`Terminal screen worker request timed out: ${type}`);
        error.code = 'ETIMEDOUT';
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

  append(data, stateRevision, outputSeq = null) {
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

    return new Promise((resolve, reject) => {
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

  resize(cols, rows, stateRevision) {
    return this.request('resize', { cols, rows, stateRevision });
  }

  setRuntimeEpoch(runtimeEpoch, cols, rows) {
    return this.request('set-runtime-epoch', { runtimeEpoch, cols, rows });
  }

  clear(stateRevision, outputSeq = null) {
    return this.request('clear', { stateRevision, outputSeq });
  }

  getState(options = {}) {
    if (!this.stateRequestInFlight) {
      const request = this.request('get-state', {
        // A full checkpoint can satisfy callers that only need metadata too,
        // while the reverse would make coalescing unsafe.
        includeRenderOutput: true,
      }, {
        // Caller deadlines are deliberately softer than this shared deadline.
        // A timed-out caller may stop waiting, but the single-flight itself
        // must never poison every later checkpoint for the generic 30s worker
        // request timeout. Crossing this hard deadline means the authoritative
        // reducer can no longer prove progress, so fail it closed.
        timeoutMs: this.stateRequestHardTimeoutMs,
      });
      const sharedRequest = request.catch((error) => {
        if (error && error.code === 'ETIMEDOUT') {
          this.handleWorkerFailure(error);
        }
        throw error;
      }).finally(() => {
        if (this.stateRequestInFlight === sharedRequest) {
          this.stateRequestInFlight = null;
        }
      });
      this.stateRequestInFlight = sharedRequest;
    }

    const sharedRequest = this.stateRequestInFlight;
    const timeoutMs = Number.isFinite(options.timeoutMs)
      ? Math.max(1, Math.floor(options.timeoutMs))
      : null;
    if (timeoutMs === null) return sharedRequest;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const error = new Error('Terminal screen worker request timed out: get-state');
        error.code = 'ETIMEDOUT';
        reject(error);
      }, timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
      sharedRequest.then(
        (state) => {
          clearTimeout(timer);
          resolve(state);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }

  async dispose() {
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

module.exports = TerminalScreenWorker;
module.exports.resolveWorkerFile = resolveWorkerFile;
module.exports.DEFAULT_REQUEST_TIMEOUT_MS = DEFAULT_REQUEST_TIMEOUT_MS;
module.exports.DEFAULT_STATE_REQUEST_HARD_TIMEOUT_MS = DEFAULT_STATE_REQUEST_HARD_TIMEOUT_MS;
