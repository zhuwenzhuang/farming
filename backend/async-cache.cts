interface AsyncCacheOptions {
  now?: () => number;
  staleMs?: number;
  ttlMs?: number;
}

interface AsyncCacheGetOptions {
  force?: boolean;
  maxAgeMs?: number;
}

interface AsyncCacheEntry<Value> {
  error: unknown;
  fetchedAt: number;
  hasValue: boolean;
  pending: Promise<Value> | null;
  value: Value | null;
}

class AsyncCache<Value> {
  private readonly entries = new Map<string, AsyncCacheEntry<Value>>();
  private readonly loader: (entryId: string) => Value | PromiseLike<Value>;
  private readonly now: () => number;
  private readonly staleMs: number;
  private readonly ttlMs: number;

  constructor(
    loader: (entryId: string) => Value | PromiseLike<Value>,
    options: AsyncCacheOptions = {},
  ) {
    if (typeof loader !== 'function') {
      throw new TypeError('AsyncCache loader must be a function');
    }

    this.loader = loader;
    this.ttlMs = typeof options.ttlMs === 'number' && Number.isFinite(options.ttlMs)
      ? Math.max(0, options.ttlMs)
      : 30_000;
    this.staleMs = typeof options.staleMs === 'number' && Number.isFinite(options.staleMs)
      ? Math.max(this.ttlMs, options.staleMs)
      : this.ttlMs;
    this.now = typeof options.now === 'function' ? options.now : () => Date.now();
  }

  private isFresh(entry: AsyncCacheEntry<Value>, now: number): boolean {
    return entry.hasValue && now - entry.fetchedAt <= this.ttlMs;
  }

  private isStaleUsable(entry: AsyncCacheEntry<Value>, now: number): boolean {
    return entry.hasValue && now - entry.fetchedAt <= this.staleMs;
  }

  private async refresh(entryId: string, entry: AsyncCacheEntry<Value>): Promise<Value> {
    if (entry.pending) return entry.pending;

    entry.pending = Promise.resolve()
      .then(() => this.loader(entryId))
      .then(value => {
        entry.value = value;
        entry.fetchedAt = this.now();
        entry.hasValue = true;
        entry.error = null;
        return value;
      })
      .catch((error: unknown) => {
        entry.error = error;
        throw error;
      })
      .finally(() => {
        entry.pending = null;
      });

    return entry.pending;
  }

  get(entryId: unknown = 'default', options: AsyncCacheGetOptions = {}): Promise<Value | null> {
    const cacheId = String(entryId);
    const now = this.now();
    const maxAgeMs = typeof options.maxAgeMs === 'number' && Number.isFinite(options.maxAgeMs)
      ? Math.max(0, options.maxAgeMs)
      : null;
    let entry = this.entries.get(cacheId);
    if (!entry) {
      entry = {
        value: null,
        fetchedAt: 0,
        hasValue: false,
        pending: null,
        error: null,
      };
      this.entries.set(cacheId, entry);
    }

    if (!options.force && maxAgeMs !== null) {
      if (entry.hasValue && now - entry.fetchedAt <= maxAgeMs) {
        return Promise.resolve(entry.value);
      }
      return this.refresh(cacheId, entry);
    }

    if (!options.force && this.isFresh(entry, now)) {
      return Promise.resolve(entry.value);
    }

    if (!options.force && this.isStaleUsable(entry, now)) {
      this.refresh(cacheId, entry).catch(() => {});
      return Promise.resolve(entry.value);
    }

    return this.refresh(cacheId, entry);
  }

  invalidate(entryId: unknown = null): void {
    if (entryId === null || entryId === undefined) {
      this.entries.clear();
      return;
    }

    this.entries.delete(String(entryId));
  }
}

export {
  AsyncCache,
};
