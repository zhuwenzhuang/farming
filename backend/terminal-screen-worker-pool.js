const TerminalScreenWorker = require('./terminal-screen-worker');

const DEFAULT_POOL_SIZE = 3;
const DEFAULT_RETRY_DELAY_MS = 250;
const MAX_RETRY_DELAY_MS = 5000;

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
    this.WorkerClass = options.WorkerClass || TerminalScreenWorker;
    this.idle = [];
    this.waiters = [];
    this.readyWaiters = [];
    this.pendingStarts = 0;
    this.startTasks = new Set();
    this.consecutiveStartFailures = 0;
    this.retryDelayMs = Number.isFinite(options.retryDelayMs)
      ? Math.max(0, Number(options.retryDelayMs))
      : DEFAULT_RETRY_DELAY_MS;
    this.retryTimer = null;
    this.disposed = false;

    this.ensureCapacity();
  }

  getStats() {
    return {
      size: this.size,
      idle: this.idle.length,
      pendingStarts: this.pendingStarts,
      waiters: this.waiters.length,
      consecutiveStartFailures: this.consecutiveStartFailures,
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
      return this.prepareCheckedWorker(worker, options);
    }

    return new Promise((resolve, reject) => {
      this.waiters.push({ resolve, reject, options });
      this.ensureCapacity();
    });
  }

  ensureCapacity() {
    if (this.disposed || this.size <= 0 || this.retryTimer) {
      return;
    }

    const desiredStarts = this.size + this.waiters.length;
    while (this.idle.length + this.pendingStarts < desiredStarts) {
      this.startWorker();
    }
  }

  startWorker() {
    this.pendingStarts += 1;
    let failed = false;
    const startTask = this.createReadyWorker()
      .then((worker) => {
        this.pendingStarts -= 1;
        this.consecutiveStartFailures = 0;
        if (this.disposed) {
          return worker.dispose().catch(() => {});
        }
        this.deliverWorker(worker);
      })
      .catch((error) => {
        failed = true;
        this.pendingStarts -= 1;
        this.consecutiveStartFailures += 1;
        const waiter = this.waiters.shift();
        if (waiter) {
          waiter.reject(error);
        }
        if (this.pendingStarts === 0 && this.idle.length < this.size) {
          const readyWaiters = this.readyWaiters.splice(0);
          readyWaiters.forEach(({ reject }) => reject(error));
        }
      })
      .finally(() => {
        this.notifyReadyWaiters();
        if (failed) {
          this.scheduleCapacityRetry();
        } else {
          this.ensureCapacity();
        }
      });
    this.startTasks.add(startTask);
    startTask.then(
      () => this.startTasks.delete(startTask),
      () => this.startTasks.delete(startTask),
    );
  }

  scheduleCapacityRetry() {
    if (this.disposed || this.size <= 0 || this.retryTimer) return;
    const delayMs = Math.min(
      MAX_RETRY_DELAY_MS,
      this.retryDelayMs * Math.max(1, 2 ** Math.min(this.consecutiveStartFailures - 1, 5)),
    );
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.ensureCapacity();
    }, delayMs);
    this.retryTimer.unref?.();
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
    if (typeof options.runtimeEpoch === 'string') {
      await worker.setRuntimeEpoch(options.runtimeEpoch, cols, rows);
    } else if (Number.isFinite(cols) && cols > 0 && Number.isFinite(rows) && rows > 0) {
      await worker.resize(cols, rows, 1);
    }
    return worker;
  }

  async prepareCheckedWorker(worker, options = {}) {
    try {
      return await this.prepareWorker(worker, options);
    } catch (error) {
      try {
        await worker.dispose();
      } catch {
        // best effort
      }
      this.ensureCapacity();
      throw error;
    }
  }

  deliverWorker(worker) {
    const waiter = this.waiters.shift();
    if (!waiter) {
      this.idle.push(worker);
      this.notifyReadyWaiters();
      return;
    }

    this.prepareCheckedWorker(worker, waiter.options).then(waiter.resolve, waiter.reject);
  }

  notifyReadyWaiters() {
    if (this.idle.length < this.size) {
      return;
    }
    const waiters = this.readyWaiters.splice(0);
    waiters.forEach(({ resolve }) => resolve(this.getStats()));
  }

  async dispose() {
    if (this.disposePromise) {
      return this.disposePromise;
    }

    this.disposed = true;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    const error = new Error('Terminal screen worker pool is disposed');
    this.waiters.splice(0).forEach(({ reject }) => reject(error));
    this.readyWaiters.splice(0).forEach(({ reject }) => reject(error));
    const workers = this.idle.splice(0);
    this.disposePromise = Promise.allSettled([
      ...workers.map(worker => worker.dispose()),
      ...this.startTasks,
    ]).then(() => undefined);
    return this.disposePromise;
  }
}

module.exports = TerminalScreenWorkerPool;
module.exports.DEFAULT_POOL_SIZE = DEFAULT_POOL_SIZE;
