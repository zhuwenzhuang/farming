import * as path from 'path';
import * as fs from 'fs';
import { Worker } from 'worker_threads';
import { usageHistoryCacheFile } from './storage-layout.cjs';

interface UsageWorkerRequest extends Record<string, unknown> {
  nowMs?: number;
}

export interface UsageHistoryCache extends Record<string, unknown> {
  committed_bytes?: unknown;
  discovered_files?: unknown;
  enumerated_entries?: unknown;
  errors?: unknown;
  pending_directories?: unknown;
  pending_files?: unknown;
  scan_complete?: boolean;
}

export interface UsageHistoryEvent extends Record<string, unknown> {
  agentId?: unknown;
  agentLabel?: unknown;
  sessionId?: unknown;
  timestamp?: unknown;
  totalTokens?: unknown;
}

export interface UsageHistoryProvider extends Record<string, unknown> {
  available: boolean;
  events: UsageHistoryEvent[];
  fileCount: number;
  quotaCandidates: Array<Record<string, unknown>>;
  reason?: string;
  source?: string;
}

export interface UsageHistoryResult extends Record<string, unknown> {
  cache: UsageHistoryCache;
  providers: Record<string, UsageHistoryProvider>;
  source: string;
  sampledAt?: unknown;
}

interface UsageWorkerLike {
  on(eventName: string, listener: (value: unknown) => void): unknown;
  once(eventName: string, listener: (value: unknown) => void): unknown;
  postMessage(message: Record<string, unknown>): void;
  ref?(): void;
  terminate(): Promise<unknown>;
  unref?(): void;
}

interface UsageWorkerConstructor {
  new(
    workerFile: string,
    options?: { workerData: { request: UsageWorkerRequest } },
  ): UsageWorkerLike;
}

interface UsageWorkerOptions {
  timeoutMs?: number;
  WorkerClass?: UsageWorkerConstructor;
}

interface PendingWorkerRequest {
  reject(error: Error): void;
  resolve(result: UsageHistoryResult): void;
  timeout: NodeJS.Timeout;
}

interface SharedWorkerSession {
  run(request: UsageWorkerRequest, timeoutMs: number): Promise<UsageHistoryResult>;
  terminate(): void;
  worker: UsageWorkerLike;
  workerFile: string;
}

type UsageWorkerRunner = (
  request: UsageWorkerRequest,
  options: { timeoutMs: number },
) => Promise<UsageHistoryResult>;

interface UsageHistoryClientOptions {
  backgroundDelayMs?: number;
  backgroundErrorDelayMs?: number;
  configDir: string;
  runner?: UsageWorkerRunner;
  timeoutMs?: number;
}

interface UsageHistoryCollectOptions {
  claudeRoots?: string[];
  codexRoots?: string[];
  fresh?: boolean;
  legacyCacheFile?: string;
  now?: number;
  recentRawMs?: number;
  retentionDays?: number;
  roots?: Record<string, string[]>;
  scanBudgetMs?: number;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_RETENTION_DAYS = 52 * 7;
const DEFAULT_RECENT_RAW_MS = 24 * 60 * 60 * 1000;
const DEFAULT_SCAN_BUDGET_MS = 5_000;
const BACKGROUND_SCAN_DELAY_MS = 100;
const RESULT_REUSE_MS = 2_000;
const SOURCE_WORKER_FILE = 'usage-history-worker.cjs';
const PACKAGED_WORKER_FILE = 'usage-history-worker.pkg.js';
let sharedWorkerSession: SharedWorkerSession | null = null;
let nextWorkerRequestId = 1;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object'
    ? value as Record<string, unknown>
    : null;
}

function workerError(value: unknown, fallbackMessage: string, fallbackCode: string): Error {
  const payload = asRecord(value);
  const error = new Error(
    typeof payload?.message === 'string' && payload.message
      ? payload.message
      : fallbackMessage,
  );
  error.code = typeof payload?.code === 'string' && payload.code
    ? payload.code
    : fallbackCode;
  if (typeof payload?.stack === 'string' && payload.stack) error.stack = payload.stack;
  return error;
}

function resolveWorkerFile(): string {
  if (!process.pkg && process.env.FARMING_PACKAGED_RUNTIME !== '1') {
    return SOURCE_WORKER_FILE;
  }
  const packaged = path.join(__dirname, PACKAGED_WORKER_FILE);
  return fs.existsSync(packaged) ? PACKAGED_WORKER_FILE : SOURCE_WORKER_FILE;
}

function runUsageWorker(
  request: UsageWorkerRequest,
  options: UsageWorkerOptions = {},
): Promise<UsageHistoryResult> {
  if (options.WorkerClass) {
    return runOneShotUsageWorker(request, options);
  }
  const workerFile = path.join(__dirname, resolveWorkerFile());
  if (!sharedWorkerSession || sharedWorkerSession.workerFile !== workerFile) {
    sharedWorkerSession?.terminate();
    sharedWorkerSession = createSharedWorkerSession(
      workerFile,
      options.WorkerClass || Worker as unknown as UsageWorkerConstructor,
    );
  }
  return sharedWorkerSession.run(request, options.timeoutMs || DEFAULT_TIMEOUT_MS);
}

function runOneShotUsageWorker(
  request: UsageWorkerRequest,
  options: UsageWorkerOptions = {},
): Promise<UsageHistoryResult> {
  return new Promise<UsageHistoryResult>((resolve, reject) => {
    const WorkerClass = options.WorkerClass || Worker as unknown as UsageWorkerConstructor;
    const worker = new WorkerClass(
      path.join(__dirname, resolveWorkerFile()),
      { workerData: { request } },
    );
    let settled = false;
    const finish = (error: Error | null, value?: UsageHistoryResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      worker.terminate().catch(() => {});
      if (error) reject(error);
      else resolve(value as UsageHistoryResult);
    };
    const timeout = setTimeout(() => {
      const error = new Error(
        `TypeScript usage scanner exceeded ${options.timeoutMs || DEFAULT_TIMEOUT_MS}ms`,
      );
      error.code = 'ETIMEDOUT';
      finish(error);
    }, options.timeoutMs || DEFAULT_TIMEOUT_MS);
    timeout.unref?.();
    worker.once('error', (value: unknown) => {
      finish(value instanceof Error ? value : new Error(String(value)));
    });
    worker.once('exit', (value: unknown) => {
      const code = typeof value === 'number' ? value : null;
      if (!settled) {
        const error = new Error(
          code === 0
            ? 'TypeScript usage scanner exited without returning a result'
            : `TypeScript usage scanner exited with code ${code}`,
        );
        error.code = 'EUSAGEWORKER';
        finish(error);
      }
    });
    worker.once('message', (value: unknown) => {
      const message = asRecord(value);
      if (message?.error) {
        finish(workerError(message.error, 'Usage scanner failed', 'EUSAGE'));
        return;
      }
      finish(null, message?.result as UsageHistoryResult);
    });
  });
}

function createSharedWorkerSession(
  workerFile: string,
  WorkerClass: UsageWorkerConstructor,
): SharedWorkerSession {
  const worker = new WorkerClass(workerFile);
  const pending = new Map<number, PendingWorkerRequest>();
  const failAll = (error: Error): void => {
    for (const request of pending.values()) {
      clearTimeout(request.timeout);
      request.reject(error);
    }
    pending.clear();
    if (sharedWorkerSession?.worker === worker) sharedWorkerSession = null;
  };
  worker.on('message', (value: unknown) => {
    const message = asRecord(value);
    const requestId = typeof message?.requestId === 'number'
      ? message.requestId
      : null;
    if (requestId === null) return;
    const request = pending.get(requestId);
    if (!request) return;
    pending.delete(requestId);
    clearTimeout(request.timeout);
    if (message?.error) {
      request.reject(workerError(message.error, 'Usage scanner failed', 'EUSAGE'));
    } else {
      request.resolve(message?.result as UsageHistoryResult);
    }
    if (pending.size === 0) worker.unref?.();
  });
  worker.once('error', (value: unknown) => {
    failAll(value instanceof Error ? value : new Error(String(value)));
  });
  worker.once('exit', (value: unknown) => {
    const code = typeof value === 'number' ? value : null;
    if (pending.size > 0) {
      const error = new Error(
        code === 0
          ? 'TypeScript usage scanner exited before returning all results'
          : `TypeScript usage scanner exited with code ${code}`,
      );
      error.code = 'EUSAGEWORKER';
      failAll(error);
    } else if (sharedWorkerSession?.worker === worker) {
      sharedWorkerSession = null;
    }
  });
  worker.unref?.();
  return {
    worker,
    workerFile,
    run(request: UsageWorkerRequest, timeoutMs: number): Promise<UsageHistoryResult> {
      return new Promise<UsageHistoryResult>((resolve, reject) => {
        const requestId = nextWorkerRequestId++;
        const timeout = setTimeout(() => {
          if (!pending.delete(requestId)) return;
          const error = new Error(`TypeScript usage scanner exceeded ${timeoutMs}ms`);
          error.code = 'ETIMEDOUT';
          reject(error);
          worker.terminate().catch(() => {});
          if (sharedWorkerSession?.worker === worker) sharedWorkerSession = null;
        }, timeoutMs);
        timeout.unref?.();
        pending.set(requestId, { resolve, reject, timeout });
        worker.ref?.();
        worker.postMessage({ requestId, request });
      });
    },
    terminate() {
      const error = new Error('Usage scanner worker was replaced');
      error.code = 'EUSAGEWORKER';
      failAll(error);
      worker.terminate().catch(() => {});
    },
  };
}

class UsageHistoryClient {
  configDir: string;
  timeoutMs: number;
  runner: UsageWorkerRunner;
  pending: Promise<UsageHistoryResult> | null;
  pendingKey: string;
  cached: UsageHistoryResult | null;
  cachedAt: number;
  cacheKey: string;
  backgroundTimer: NodeJS.Timeout | null;
  backgroundGeneration: number;
  backgroundDelayMs: number;
  backgroundErrorDelayMs: number;
  backgroundErrorRetries: number;
  backgroundStalls: number;
  backgroundProgressSignature: string;

  constructor(
    options: UsageHistoryClientOptions = {} as UsageHistoryClientOptions,
  ) {
    this.configDir = options.configDir;
    this.timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
    this.runner = options.runner || runUsageWorker;
    this.pending = null;
    this.pendingKey = '';
    this.cached = null;
    this.cachedAt = 0;
    this.cacheKey = '';
    this.backgroundTimer = null;
    this.backgroundGeneration = 0;
    this.backgroundDelayMs = options.backgroundDelayMs || BACKGROUND_SCAN_DELAY_MS;
    this.backgroundErrorDelayMs = options.backgroundErrorDelayMs || 5_000;
    this.backgroundErrorRetries = 0;
    this.backgroundStalls = 0;
    this.backgroundProgressSignature = '';
  }

  invoke(request: UsageWorkerRequest): Promise<UsageHistoryResult> {
    return this.runner(request, { timeoutMs: this.timeoutMs });
  }

  storeResult(result: UsageHistoryResult, cacheKey: string): void {
    if (cacheKey !== this.cacheKey) return;
    this.cached = result;
    this.cachedAt = typeof result.sampledAt === 'number' && Number.isFinite(result.sampledAt)
      ? result.sampledAt
      : Date.now();
  }

  scheduleBackgroundScan(
    request: UsageWorkerRequest,
    cacheKey: string,
    result: UsageHistoryResult,
  ): void {
    if (result?.cache?.scan_complete !== false || cacheKey !== this.cacheKey) {
      this.backgroundErrorRetries = 0;
      this.backgroundStalls = 0;
      this.backgroundProgressSignature = '';
      return;
    }
    if (this.backgroundTimer) return;
    const hasErrors = Number(result?.cache?.errors) > 0;
    this.backgroundErrorRetries = hasErrors ? this.backgroundErrorRetries + 1 : 0;
    const progressSignature = [
      result?.cache?.pending_directories,
      result?.cache?.pending_files,
      result?.cache?.discovered_files,
      result?.cache?.committed_bytes,
    ].join(':');
    if (Number(result?.cache?.enumerated_entries) > 0) {
      this.backgroundProgressSignature = progressSignature;
      this.backgroundStalls = 0;
    } else if (progressSignature === this.backgroundProgressSignature) {
      this.backgroundStalls += 1;
    } else {
      this.backgroundProgressSignature = progressSignature;
      this.backgroundStalls = 0;
    }
    if (this.backgroundErrorRetries >= 3 || this.backgroundStalls >= 3) return;
    const generation = this.backgroundGeneration;
    const retryDelayMs = hasErrors
      ? this.backgroundErrorDelayMs
      : this.backgroundDelayMs;
    this.backgroundTimer = setTimeout(() => {
      this.backgroundTimer = null;
      if (generation !== this.backgroundGeneration || cacheKey !== this.cacheKey) return;
      const backgroundRequest = { ...request, nowMs: Date.now() };
      const pending = this.invoke(backgroundRequest).then((nextResult) => {
        this.storeResult(nextResult, cacheKey);
        this.scheduleBackgroundScan(backgroundRequest, cacheKey, nextResult);
        return nextResult;
      }).catch(() => {
        // Keep the last usable snapshot. A later normal request retries.
        return undefined as unknown as UsageHistoryResult;
      }).finally(() => {
        if (this.pending === pending) {
          this.pending = null;
          this.pendingKey = '';
        }
      });
      this.pending = pending;
      this.pendingKey = cacheKey;
    }, retryDelayMs);
    this.backgroundTimer.unref?.();
  }

  collect(options: UsageHistoryCollectOptions = {}): Promise<UsageHistoryResult> {
    const now = options.now ?? Date.now();
    const retentionDays = options.retentionDays ?? DEFAULT_RETENTION_DAYS;
    const requestedRoots = options.roots || {
      codex: options.codexRoots || [],
      claude: options.claudeRoots || [],
    };
    const roots = Object.fromEntries(Object.entries(requestedRoots).map(([provider, entries]) => [
      provider,
      Array.from(new Set(entries)).sort(),
    ]));
    const recentRawMs = options.recentRawMs ?? DEFAULT_RECENT_RAW_MS;
    const cacheKey = JSON.stringify({ roots, retentionDays, recentRawMs });
    if (this.cacheKey && this.cacheKey !== cacheKey) {
      this.backgroundGeneration += 1;
      if (this.backgroundTimer) clearTimeout(this.backgroundTimer);
      this.backgroundTimer = null;
      this.backgroundErrorRetries = 0;
      this.backgroundStalls = 0;
      this.backgroundProgressSignature = '';
    }
    if (
      options.fresh !== true
      && this.cached
      && this.cacheKey === cacheKey
      && (
        now - this.cachedAt <= RESULT_REUSE_MS
        || this.backgroundTimer
        || (this.pending && this.pendingKey === cacheKey)
      )
    ) {
      return Promise.resolve(this.cached);
    }
    if (this.pending && this.pendingKey === cacheKey) return this.pending;
    if (this.pending) return this.pending.then(() => this.collect(options));
    this.cacheKey = cacheKey;
    this.backgroundErrorRetries = 0;
    this.backgroundStalls = 0;
    this.backgroundProgressSignature = '';
    const request = {
      cacheFile: usageHistoryCacheFile(this.configDir),
      legacyCacheFile: options.legacyCacheFile,
      nowMs: now,
      retentionDays,
      recentRawMs,
      scanBudgetMs: options.scanBudgetMs ?? DEFAULT_SCAN_BUDGET_MS,
      roots,
    };
    const pending: Promise<UsageHistoryResult> = this.invoke(request).then((result) => {
      this.storeResult(result, cacheKey);
      this.scheduleBackgroundScan(request, cacheKey, result);
      return result;
    }).finally(() => {
      if (this.pending === pending) {
        this.pending = null;
        this.pendingKey = '';
      }
    });
    this.pending = pending;
    this.pendingKey = cacheKey;
    return pending;
  }
}

export {
  UsageHistoryClient,
  DEFAULT_RECENT_RAW_MS,
  DEFAULT_RETENTION_DAYS,
  DEFAULT_SCAN_BUDGET_MS,
  resolveWorkerFile,
  runUsageWorker,
};
