class AsyncCache {
  constructor(loader, options = {}) {
    if (typeof loader !== 'function') {
      throw new TypeError('AsyncCache loader must be a function');
    }

    this.loader = loader;
    this.ttlMs = Number.isFinite(options.ttlMs) ? Math.max(0, options.ttlMs) : 30_000;
    this.staleMs = Number.isFinite(options.staleMs) ? Math.max(this.ttlMs, options.staleMs) : this.ttlMs;
    this.now = typeof options.now === 'function' ? options.now : () => Date.now();
    this.entries = new Map();
  }

  isFresh(entry, now) {
    return entry.hasValue && now - entry.fetchedAt <= this.ttlMs;
  }

  isStaleUsable(entry, now) {
    return entry.hasValue && now - entry.fetchedAt <= this.staleMs;
  }

  async refresh(entryId, entry) {
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
      .catch(error => {
        entry.error = error;
        if (entry.hasValue) return entry.value;
        throw error;
      })
      .finally(() => {
        entry.pending = null;
      });

    return entry.pending;
  }

  get(entryId = 'default', options = {}) {
    const cacheId = String(entryId);
    const now = this.now();
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

    if (!options.force && this.isFresh(entry, now)) {
      return Promise.resolve(entry.value);
    }

    if (!options.force && this.isStaleUsable(entry, now)) {
      this.refresh(cacheId, entry).catch(() => {});
      return Promise.resolve(entry.value);
    }

    return this.refresh(cacheId, entry);
  }

  invalidate(entryId = null) {
    if (entryId === null || entryId === undefined) {
      this.entries.clear();
      return;
    }

    this.entries.delete(String(entryId));
  }
}

module.exports = {
  AsyncCache,
};
