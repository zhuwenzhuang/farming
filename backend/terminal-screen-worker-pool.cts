import {
  TerminalScreenWorker,
  type TerminalScreenWorkerOptions,
  type TerminalScreenWorkerPreview,
  type TerminalScreenWorkerState,
} from './terminal-screen-worker.cjs';

const DEFAULT_POOL_SIZE = 3;
const DEFAULT_RETRY_DELAY_MS = 250;
const MAX_RETRY_DELAY_MS = 5000;

export interface TerminalScreenWorkerLike {
  append(data: string, stateRevision: number, outputSeq?: number | null): Promise<unknown> | undefined;
  clear(stateRevision: number, outputSeq?: number | null): Promise<TerminalScreenWorkerState>;
  dispose(): Promise<unknown>;
  getState(options?: Record<string, unknown>): Promise<TerminalScreenWorkerState>;
  on(eventName: 'preview', listener: (payload: TerminalScreenWorkerPreview) => void): unknown;
  on(eventName: 'error', listener: (error: Error) => void): unknown;
  resize(cols: number, rows: number, stateRevision: number): Promise<TerminalScreenWorkerState>;
  setRuntimeEpoch(runtimeEpoch: string, cols: number, rows: number): Promise<unknown>;
}

export interface TerminalScreenWorkerConstructor {
  new(options?: TerminalScreenWorkerOptions): TerminalScreenWorkerLike;
}

export interface TerminalScreenWorkerPoolOptions {
  retryDelayMs?: number;
  size?: unknown;
  workerOptions?: Record<string, unknown>;
  WorkerClass?: TerminalScreenWorkerConstructor;
}

interface TerminalScreenWorkerAcquireOptions {
  cols?: number;
  rows?: number;
  runtimeGeneration?: number;
  runtimeEpoch?: string;
}

interface TerminalScreenWorkerPoolStats {
  consecutiveStartFailures: number;
  idle: number;
  pendingStarts: number;
  size: number;
  waiters: number;
}

interface WorkerWaiter {
  options: TerminalScreenWorkerAcquireOptions;
  reject(error: unknown): void;
  resolve(worker: TerminalScreenWorkerLike): void;
}

interface ReadyWaiter {
  reject(error: unknown): void;
  resolve(stats: TerminalScreenWorkerPoolStats): void;
}

function normalizePoolSize(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_POOL_SIZE;
  return Math.max(0, Math.min(12, Math.floor(parsed)));
}

class TerminalScreenWorkerPool {
  private readonly WorkerClass: TerminalScreenWorkerConstructor;
  private consecutiveStartFailures: number;
  private disposePromise: Promise<void> | null = null;
  private disposed: boolean;
  private readonly idle: TerminalScreenWorkerLike[];
  private pendingStarts: number;
  private retryDelayMs: number;
  private retryTimer: NodeJS.Timeout | null;
  private readonly readyWaiters: ReadyWaiter[];
  private readonly size: number;
  private readonly startTasks: Set<Promise<unknown>>;
  private readonly waiters: WorkerWaiter[];
  private readonly workerOptions: Record<string, unknown>;

  constructor(options: TerminalScreenWorkerPoolOptions = {}) {
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

  getStats(): TerminalScreenWorkerPoolStats {
    return {
      size: this.size,
      idle: this.idle.length,
      pendingStarts: this.pendingStarts,
      waiters: this.waiters.length,
      consecutiveStartFailures: this.consecutiveStartFailures,
    };
  }

  ready(): Promise<TerminalScreenWorkerPoolStats> {
    if (this.disposed) {
      return Promise.reject(new Error('Terminal screen worker pool is disposed'));
    }
    if (this.idle.length >= this.size) {
      return Promise.resolve(this.getStats());
    }

    return new Promise<TerminalScreenWorkerPoolStats>((resolve, reject) => {
      this.readyWaiters.push({ resolve, reject });
      this.ensureCapacity();
    });
  }

  acquire(
    options: TerminalScreenWorkerAcquireOptions = {},
  ): Promise<TerminalScreenWorkerLike> {
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

    return new Promise<TerminalScreenWorkerLike>((resolve, reject) => {
      this.waiters.push({ resolve, reject, options });
      this.ensureCapacity();
    });
  }

  private ensureCapacity(): void {
    if (this.disposed || this.size <= 0 || this.retryTimer) {
      return;
    }

    const desiredStarts = this.size + this.waiters.length;
    while (this.idle.length + this.pendingStarts < desiredStarts) {
      this.startWorker();
    }
  }

  private startWorker(): void {
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
      .catch((error: unknown) => {
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

  private scheduleCapacityRetry(): void {
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

  private async createReadyWorker(): Promise<TerminalScreenWorkerLike> {
    const worker = new this.WorkerClass(this.workerOptions);
    try {
      await worker.getState({ includeRenderOutput: false });
      return worker;
    } catch (error: unknown) {
      try {
        await worker.dispose();
      } catch {
        // best effort
      }
      throw error;
    }
  }

  private async prepareWorker(
    worker: TerminalScreenWorkerLike,
    options: TerminalScreenWorkerAcquireOptions = {},
  ): Promise<TerminalScreenWorkerLike> {
    const cols = Number(options.cols || this.workerOptions.cols || 80);
    const rows = Number(options.rows || this.workerOptions.rows || 30);
    if (typeof options.runtimeEpoch === 'string') {
      await worker.setRuntimeEpoch(options.runtimeEpoch, cols, rows);
    } else if (Number.isFinite(cols) && cols > 0 && Number.isFinite(rows) && rows > 0) {
      await worker.resize(cols, rows, 1);
    }
    return worker;
  }

  private async prepareCheckedWorker(
    worker: TerminalScreenWorkerLike,
    options: TerminalScreenWorkerAcquireOptions = {},
  ): Promise<TerminalScreenWorkerLike> {
    try {
      return await this.prepareWorker(worker, options);
    } catch (error: unknown) {
      try {
        await worker.dispose();
      } catch {
        // best effort
      }
      this.ensureCapacity();
      throw error;
    }
  }

  private deliverWorker(worker: TerminalScreenWorkerLike): void {
    const waiter = this.waiters.shift();
    if (!waiter) {
      this.idle.push(worker);
      this.notifyReadyWaiters();
      return;
    }

    this.prepareCheckedWorker(worker, waiter.options).then(waiter.resolve, waiter.reject);
  }

  private notifyReadyWaiters(): void {
    if (this.idle.length < this.size) {
      return;
    }
    const waiters = this.readyWaiters.splice(0);
    waiters.forEach(({ resolve }) => resolve(this.getStats()));
  }

  async dispose(): Promise<void> {
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

export {
  DEFAULT_POOL_SIZE,
  TerminalScreenWorkerPool,
};
