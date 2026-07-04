const path = require('path');
const fs = require('fs');
const EventEmitter = require('events');
const { Worker } = require('worker_threads');

const APPEND_FLUSH_INTERVAL_MS = 16;
const MAX_PENDING_APPEND_BYTES = 128 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 30000;
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
    this.pendingAppendData = '';
    this.appendFlushTimer = null;
    this.requestTimeoutMs = Number.isFinite(options.requestTimeoutMs)
      ? Math.max(1, Math.floor(options.requestTimeoutMs))
      : DEFAULT_REQUEST_TIMEOUT_MS;
    this.failed = false;
    this.disposed = false;
    const workerFile = resolveWorkerFile();
    const WorkerClass = options.WorkerClass || Worker;
    const workerData = { ...options };
    delete workerData.WorkerClass;
    delete workerData.requestTimeoutMs;
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
      this.emit('error', error);
    });

    this.worker.on('exit', (code) => {
      if (this.disposed) {
        return;
      }

      const error = new Error(`Terminal screen worker exited unexpectedly with code ${code}`);
      this.failed = true;
      this.pendingRequests.forEach(({ reject, timer }) => {
        clearTimeout(timer);
        reject(error);
      });
      this.pendingRequests.clear();
      this.emit('error', error);
    });
  }

  handlePostMessageFailure(error) {
    if (this.disposed) return;
    this.failed = true;
    if (this.appendFlushTimer) {
      clearTimeout(this.appendFlushTimer);
      this.appendFlushTimer = null;
    }
    this.pendingAppendData = '';
    this.emit('error', error instanceof Error ? error : new Error(String(error)));
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
    if (this.disposed || this.failed || !this.pendingAppendData) {
      this.pendingAppendData = '';
      return;
    }

    const data = this.pendingAppendData;
    this.pendingAppendData = '';
    this.postWorkerMessage({
      type: 'append',
      data,
    });
  }

  request(type, payload = {}) {
    if (this.disposed) {
      return Promise.reject(new Error('Terminal screen worker is disposed'));
    }
    if (this.failed) {
      return Promise.reject(new Error('Terminal screen worker is not available'));
    }

    this.flushAppend();
    if (this.failed) {
      return Promise.reject(new Error('Terminal screen worker is not available'));
    }
    const requestId = this.nextRequestId;
    this.nextRequestId += 1;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        const error = new Error(`Terminal screen worker request timed out: ${type}`);
        error.code = 'ETIMEDOUT';
        reject(error);
      }, this.requestTimeoutMs);
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
        this.failed = true;
        reject(error);
      }
    });
  }

  append(data) {
    if (this.disposed || this.failed) {
      return;
    }

    const text = String(data || '');
    if (!text) return;

    if (
      this.pendingAppendData &&
      byteLength(this.pendingAppendData) + byteLength(text) > MAX_PENDING_APPEND_BYTES
    ) {
      this.flushAppend();
    }

    if (byteLength(text) > MAX_PENDING_APPEND_BYTES) {
      this.postWorkerMessage({
        type: 'append',
        data: text,
      });
      return;
    }

    this.pendingAppendData += text;
    if (this.appendFlushTimer) {
      return;
    }

    this.appendFlushTimer = setTimeout(() => {
      this.flushAppend();
    }, APPEND_FLUSH_INTERVAL_MS);
  }

  resize(cols, rows) {
    return this.request('resize', { cols, rows });
  }

  getState(options = {}) {
    return this.request('get-state', {
      includeRenderOutput: options.includeRenderOutput !== false,
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
    this.pendingAppendData = '';
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
