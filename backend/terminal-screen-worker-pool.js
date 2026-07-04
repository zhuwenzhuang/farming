const TerminalScreenWorker = require('./terminal-screen-worker');
const InlineTerminalScreenWorker = require('./inline-terminal-screen-worker');

const DEFAULT_POOL_SIZE = 3;

function normalizePoolSize(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_POOL_SIZE;
  return Math.max(0, Math.min(12, Math.floor(parsed)));
}

class TerminalScreenWorkerPool {
  constructor(options = {}) {
    this.size = normalizePoolSize(
      options.size !== undefined
        ? options.size
        : process.env.FARMING_TERMINAL_SCREEN_WORKER_POOL_SIZE
    );
    this.workerOptions = { ...(options.workerOptions || {}) };
    this.WorkerClass = options.WorkerClass || defaultWorkerClass();
    this.idle = [];
    this.waiters = [];
    this.readyWaiters = [];
    this.pendingStarts = 0;
    this.disposed = false;

    this.ensureCapacity();
  }

  getStats() {
    return {
      size: this.size,
      idle: this.idle.length,
      pendingStarts: this.pendingStarts,
      waiters: this.waiters.length,
    };
  }

  ready() {
    if (this.disposed) {
      return Promise.reject(new Error('Terminal screen worker pool is disposed'));
    }
    if (this.idle.length >= this.size) {
      return Promise.resolve(this.getStats());
    }

    return new Promise((resolve, reject) => {
      this.readyWaiters.push({ resolve, reject });
      this.ensureCapacity();
    });
  }

  acquire(options = {}) {
    if (this.disposed) {
      return Promise.reject(new Error('Terminal screen worker pool is disposed'));
    }
    if (this.size <= 0) {
      return Promise.reject(new Error('Terminal screen worker pool has no workers configured'));
    }

    const worker = this.idle.shift();
    if (worker) {
      this.ensureCapacity();
      return this.prepareWorker(worker, options);
    }

    return new Promise((resolve, reject) => {
      this.waiters.push({ resolve, reject, options });
      this.ensureCapacity();
    });
  }

  ensureCapacity() {
    if (this.disposed || this.size <= 0) {
      return;
    }

    const desiredStarts = this.size + this.waiters.length;
    while (this.idle.length + this.pendingStarts < desiredStarts) {
      this.startWorker();
    }
  }

  startWorker() {
    this.pendingStarts += 1;
    this.createReadyWorker()
      .then((worker) => {
        this.pendingStarts -= 1;
        if (this.disposed) {
          worker.dispose().catch(() => {});
          return;
        }
        this.deliverWorker(worker);
      })
      .catch((error) => {
        this.pendingStarts -= 1;
        const waiter = this.waiters.shift();
        if (waiter) {
          waiter.reject(error);
        }
      })
      .finally(() => {
        this.notifyReadyWaiters();
        this.ensureCapacity();
      });
  }

  async createReadyWorker() {
    const worker = new this.WorkerClass(this.workerOptions);
    try {
      await worker.getState({ includeRenderOutput: false });
      return worker;
    } catch (error) {
      try {
        await worker.dispose();
      } catch {
        // best effort
      }
      throw error;
    }
  }

  async prepareWorker(worker, options = {}) {
    const cols = Number(options.cols || this.workerOptions.cols || 80);
    const rows = Number(options.rows || this.workerOptions.rows || 30);
    if (Number.isFinite(cols) && cols > 0 && Number.isFinite(rows) && rows > 0) {
      await worker.resize(cols, rows);
    }
    return worker;
  }

  deliverWorker(worker) {
    const waiter = this.waiters.shift();
    if (!waiter) {
      this.idle.push(worker);
      this.notifyReadyWaiters();
      return;
    }

    this.prepareWorker(worker, waiter.options).then(waiter.resolve, waiter.reject);
  }

  notifyReadyWaiters() {
    if (this.idle.length < this.size) {
      return;
    }
    const waiters = this.readyWaiters.splice(0);
    waiters.forEach(({ resolve }) => resolve(this.getStats()));
  }

  async dispose() {
    if (this.disposed) {
      return;
    }

    this.disposed = true;
    const error = new Error('Terminal screen worker pool is disposed');
    this.waiters.splice(0).forEach(({ reject }) => reject(error));
    this.readyWaiters.splice(0).forEach(({ reject }) => reject(error));
    const workers = this.idle.splice(0);
    await Promise.allSettled(workers.map(worker => worker.dispose()));
  }
}

module.exports = TerminalScreenWorkerPool;
module.exports.defaultWorkerClass = defaultWorkerClass;

function defaultWorkerClass() {
  const mode = String(process.env.FARMING_TERMINAL_SCREEN_WORKER_MODE || '').toLowerCase();
  if (mode === 'inline') return InlineTerminalScreenWorker;
  if (mode === 'thread') return TerminalScreenWorker;
  if (process.platform === 'linux' && (process.pkg || process.env.FARMING_PACKAGED_RUNTIME === '1')) {
    return InlineTerminalScreenWorker;
  }
  return TerminalScreenWorker;
}
module.exports.DEFAULT_POOL_SIZE = DEFAULT_POOL_SIZE;
