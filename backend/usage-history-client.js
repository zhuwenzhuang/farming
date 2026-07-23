const path = require('path');
const fs = require('fs');
const { Worker } = require('worker_threads');
const { usageHistoryCacheFile } = require('./storage-layout');

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_RETENTION_DAYS = 52 * 7;
const DEFAULT_RECENT_RAW_MS = 24 * 60 * 60 * 1000;
const DEFAULT_SCAN_BUDGET_MS = 5_000;
const BACKGROUND_SCAN_DELAY_MS = 100;
const RESULT_REUSE_MS = 2_000;
const SOURCE_WORKER_FILE = 'usage-history-worker.js';
const PACKAGED_WORKER_FILE = 'usage-history-worker.pkg.js';

function resolveWorkerFile() {
  if (!process.pkg && process.env.FARMING_PACKAGED_RUNTIME !== '1') {
    return SOURCE_WORKER_FILE;
  }
  const packaged = path.join(__dirname, PACKAGED_WORKER_FILE);
  return fs.existsSync(packaged) ? PACKAGED_WORKER_FILE : SOURCE_WORKER_FILE;
}

function runUsageWorker(request, options = {}) {
  return new Promise((resolve, reject) => {
    const worker = new (options.WorkerClass || Worker)(
      path.join(__dirname, resolveWorkerFile()),
      { workerData: { request } },
    );
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      worker.terminate().catch(() => {});
      if (error) reject(error);
      else resolve(value);
    };
    const timeout = setTimeout(() => {
      const error = new Error(
        `TypeScript usage scanner exceeded ${options.timeoutMs || DEFAULT_TIMEOUT_MS}ms`,
      );
      error.code = 'ETIMEDOUT';
      finish(error);
    }, options.timeoutMs || DEFAULT_TIMEOUT_MS);
    timeout.unref?.();
    worker.once('error', finish);
    worker.once('exit', (code) => {
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
    worker.once('message', (message) => {
      if (message?.error) {
        const error = new Error(message.error.message || 'Usage scanner failed');
        error.code = message.error.code || 'EUSAGE';
        error.stack = message.error.stack || error.stack;
        finish(error);
        return;
      }
      finish(null, message?.result);
    });
  });
}

class UsageHistoryClient {
  constructor(options = {}) {
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

  invoke(request) {
    return this.runner(request, { timeoutMs: this.timeoutMs });
  }

  storeResult(result, cacheKey) {
    if (cacheKey !== this.cacheKey) return;
    this.cached = result;
    this.cachedAt = Number.isFinite(result?.sampledAt)
      ? result.sampledAt
      : Date.now();
  }

  scheduleBackgroundScan(request, cacheKey, result) {
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
      result?.cache?.pending_files,
      result?.cache?.committed_bytes,
    ].join(':');
    if (progressSignature === this.backgroundProgressSignature) {
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

  collect(options = {}) {
    const now = options.now ?? Date.now();
    const retentionDays = options.retentionDays ?? DEFAULT_RETENTION_DAYS;
    const roots = {
      codex: Array.from(new Set(options.codexRoots || [])).sort(),
      claude: Array.from(new Set(options.claudeRoots || [])).sort(),
    };
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
    const pending = this.invoke(request).then((result) => {
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

module.exports = {
  UsageHistoryClient,
  DEFAULT_RECENT_RAW_MS,
  DEFAULT_RETENTION_DAYS,
  DEFAULT_SCAN_BUDGET_MS,
  resolveWorkerFile,
  runUsageWorker,
};
