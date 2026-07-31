import * as crypto from 'crypto';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';

interface InventorySnapshot<Value> {
  fingerprint: string;
  value: Value;
}

interface SnapshotDocument<Value> {
  entries: Record<string, InventorySnapshot<Value>>;
  version: 1;
}

interface FingerprintOptions {
  appendOnlyIdentityOnly?: boolean;
  appendOnlyPrefixBytes?: number;
  appendOnlyRoots?: string[];
  ignoredNames?: ReadonlySet<string>;
  maxDepth?: number;
  maxEntries?: number;
}

interface InventoryRequest<Value> {
  backgroundRefresh?: boolean;
  fingerprintPaths?: string[];
  fingerprintOptions?: FingerprintOptions;
  load: () => Value | PromiseLike<Value>;
  sourceMayChangeDuringLoad?: boolean;
  validate?: (value: unknown) => value is Value;
  watchPaths: string[];
}

interface InventoryEntry<Value> {
  backgroundRefresh: boolean;
  fingerprint: string;
  fingerprintOptions: FingerprintOptions;
  fingerprintPaths: string[];
  generation: number;
  key: string;
  load: (() => Value | PromiseLike<Value>) | null;
  pending: Promise<Value> | null;
  refreshTimer: ReturnType<typeof setTimeout> | null;
  sourceMayChangeDuringLoad: boolean;
  value: Value | null;
  validate: ((value: unknown) => value is Value) | null;
  watchPaths: string[];
  watchSignature: string;
  watcher: import('chokidar').FSWatcher | null;
  watcherReady: Promise<void> | null;
  watcherToken: number;
}

interface AuthoritativeInventoryCacheOptions {
  fingerprintOptions?: FingerprintOptions;
  maxReconcileAttempts?: number;
  refreshDebounceMs?: number;
  snapshotFile?: string;
}

const DEFAULT_IGNORED_NAMES = new Set(['.git', 'node_modules']);

function normalizedWatchPaths(input: string[]): string[] {
  return [...new Set(input
    .map(candidate => String(candidate || '').trim())
    .filter(Boolean)
    .map(candidate => path.resolve(candidate)))]
    .sort((left, right) => left.localeCompare(right));
}

async function filesystemFingerprint(
  inputPaths: string[],
  options: FingerprintOptions = {},
): Promise<string> {
  const roots = normalizedWatchPaths(inputPaths);
  const ignoredNames = options.ignoredNames || DEFAULT_IGNORED_NAMES;
  const maxDepth = typeof options.maxDepth === 'number' && Number.isFinite(options.maxDepth)
    ? Math.max(0, Math.floor(options.maxDepth))
    : 16;
  const maxEntries = typeof options.maxEntries === 'number' && Number.isFinite(options.maxEntries)
    ? Math.max(1, Math.floor(options.maxEntries))
    : 50_000;
  const hash = crypto.createHash('sha256');
  const appendOnlyRoots = normalizedWatchPaths(options.appendOnlyRoots || []);
  const appendOnlyPrefixBytes = typeof options.appendOnlyPrefixBytes === 'number'
    ? Math.max(1, Math.floor(options.appendOnlyPrefixBytes))
    : 64 * 1024;
  let entries = 0;

  const isAppendOnlyFile = (filePath: string) => (
    filePath.endsWith('.jsonl')
    && appendOnlyRoots.some(root => {
      const relative = path.relative(root, filePath);
      return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
    })
  );

  const visit = async (root: string, current: string, depth: number): Promise<void> => {
    if (entries >= maxEntries) {
      throw new Error(`Inventory fingerprint exceeded ${maxEntries} filesystem entries`);
    }
    entries += 1;
    const relative = path.relative(root, current).split(path.sep).join('/') || '.';
    let stat: fs.Stats;
    try {
      stat = await fsp.lstat(current);
    } catch (caught) {
      const error = caught as NodeJS.ErrnoException;
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
        hash.update(`missing\0${root}\0${relative}\n`);
        return;
      }
      throw caught;
    }

    const kind = stat.isDirectory() ? 'd' : stat.isFile() ? 'f' : stat.isSymbolicLink() ? 'l' : 'o';
    if (stat.isFile() && isAppendOnlyFile(current)) {
      if (options.appendOnlyIdentityOnly) {
        hash.update(`${kind}\0${root}\0${relative}\0${stat.dev}\0${stat.ino}\0append-only\n`);
        return;
      }
      const length = Math.min(stat.size, appendOnlyPrefixBytes);
      const buffer = Buffer.alloc(length);
      const handle = await fsp.open(current, 'r');
      try {
        if (length > 0) await handle.read(buffer, 0, length, 0);
      } finally {
        await handle.close();
      }
      hash.update(`${kind}\0${root}\0${relative}\0${stat.dev}\0${stat.ino}\0prefix\0${length}\n`);
      hash.update(buffer);
      hash.update('\n');
    } else {
      hash.update(`${kind}\0${root}\0${relative}\0${stat.dev}\0${stat.ino}\0${stat.size}\0${stat.mtimeMs}\n`);
    }
    if (!stat.isDirectory() || depth >= maxDepth) return;

    const children = await fsp.readdir(current, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      if (ignoredNames.has(child.name)) continue;
      await visit(root, path.join(current, child.name), depth + 1);
    }
  };

  for (const root of roots) {
    await visit(root, root, 0);
  }
  return hash.digest('hex');
}

class InventorySnapshotStore<Value> {
  private document: SnapshotDocument<Value> | null = null;
  private readonly filePath: string;
  private writeTask: Promise<void> = Promise.resolve();

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  private load(): SnapshotDocument<Value> {
    if (this.document) return this.document;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as SnapshotDocument<Value>;
      if (parsed?.version === 1 && parsed.entries && typeof parsed.entries === 'object') {
        this.document = parsed;
        return parsed;
      }
    } catch {
      // A missing or malformed cache is rebuilt from authoritative sources.
    }
    this.document = { version: 1, entries: {} };
    return this.document;
  }

  get(key: string): InventorySnapshot<Value> | null {
    const snapshot = this.load().entries[key];
    return snapshot && typeof snapshot.fingerprint === 'string' ? snapshot : null;
  }

  set(key: string, snapshot: InventorySnapshot<Value>): Promise<void> {
    this.load().entries[key] = snapshot;
    const serialized = JSON.stringify(this.document);
    this.writeTask = this.writeTask
      .catch(() => {})
      .then(async () => {
        await fsp.mkdir(path.dirname(this.filePath), { recursive: true });
        const temporary = `${this.filePath}.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}.tmp`;
        try {
          await fsp.writeFile(temporary, serialized, { encoding: 'utf8', mode: 0o600 });
          await fsp.rename(temporary, this.filePath);
        } finally {
          await fsp.rm(temporary, { force: true }).catch(() => {});
        }
      });
    return this.writeTask;
  }

  deleteExcept(keys: ReadonlySet<string>): Promise<void> {
    const document = this.load();
    let changed = false;
    for (const key of Object.keys(document.entries)) {
      if (keys.has(key)) continue;
      delete document.entries[key];
      changed = true;
    }
    if (!changed) return this.writeTask;
    const serialized = JSON.stringify(document);
    this.writeTask = this.writeTask
      .catch(() => {})
      .then(async () => {
        await fsp.mkdir(path.dirname(this.filePath), { recursive: true });
        const temporary = `${this.filePath}.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}.tmp`;
        try {
          await fsp.writeFile(temporary, serialized, { encoding: 'utf8', mode: 0o600 });
          await fsp.rename(temporary, this.filePath);
        } finally {
          await fsp.rm(temporary, { force: true }).catch(() => {});
        }
      });
    return this.writeTask;
  }
}

let chokidarPromise: Promise<typeof import('chokidar')> | null = null;

function loadChokidar(): Promise<typeof import('chokidar')> {
  if (!chokidarPromise) chokidarPromise = import('chokidar');
  return chokidarPromise;
}

class AuthoritativeInventoryCache<Value> {
  private readonly entries = new Map<string, InventoryEntry<Value>>();
  private readonly fingerprintOptions: FingerprintOptions;
  private readonly maxReconcileAttempts: number;
  private readonly refreshDebounceMs: number;
  private readonly snapshots: InventorySnapshotStore<Value> | null;

  constructor(options: AuthoritativeInventoryCacheOptions = {}) {
    this.fingerprintOptions = options.fingerprintOptions || {};
    this.maxReconcileAttempts = typeof options.maxReconcileAttempts === 'number'
      ? Math.max(1, Math.floor(options.maxReconcileAttempts))
      : 3;
    this.refreshDebounceMs = typeof options.refreshDebounceMs === 'number'
      ? Math.max(0, Math.floor(options.refreshDebounceMs))
      : 150;
    this.snapshots = options.snapshotFile ? new InventorySnapshotStore<Value>(options.snapshotFile) : null;
  }

  private entry(key: string): InventoryEntry<Value> {
    let entry = this.entries.get(key);
    if (entry) return entry;
    const snapshot = this.snapshots?.get(key);
    entry = {
      key,
      backgroundRefresh: true,
      fingerprint: snapshot?.fingerprint || '',
      fingerprintOptions: {},
      fingerprintPaths: [],
      generation: 0,
      load: null,
      pending: null,
      refreshTimer: null,
      sourceMayChangeDuringLoad: false,
      value: snapshot?.value ?? null,
      validate: null,
      watchPaths: [],
      watchSignature: '',
      watcher: null,
      watcherReady: null,
      watcherToken: 0,
    };
    this.entries.set(key, entry);
    return entry;
  }

  private markDirty(entry: InventoryEntry<Value>): void {
    entry.generation += 1;
    entry.fingerprint = '';
    if (!entry.backgroundRefresh || !entry.load || entry.refreshTimer) return;
    entry.refreshTimer = setTimeout(() => {
      entry.refreshTimer = null;
      void this.resolveCurrent(entry).catch(() => {});
    }, this.refreshDebounceMs);
    entry.refreshTimer.unref?.();
  }

  private async configureWatcher(entry: InventoryEntry<Value>, watchPaths: string[]): Promise<void> {
    const normalized = normalizedWatchPaths(watchPaths);
    const signature = JSON.stringify(normalized);
    if (entry.watchSignature === signature && entry.watcherReady) {
      await entry.watcherReady;
      return;
    }

    entry.watcherToken += 1;
    const token = entry.watcherToken;
    const hadWatchConfiguration = Boolean(entry.watchSignature);
    entry.watchSignature = signature;
    entry.watchPaths = normalized;
    if (hadWatchConfiguration) this.markDirty(entry);
    if (entry.watcher) await entry.watcher.close().catch(() => {});
    entry.watcher = null;

    if (normalized.length === 0) {
      entry.watcherReady = Promise.resolve();
      return;
    }

    const chokidar = await loadChokidar();
    const watcher = chokidar.watch(normalized, {
      awaitWriteFinish: { pollInterval: 25, stabilityThreshold: 100 },
      followSymlinks: false,
      ignoreInitial: true,
      persistent: true,
    });
    entry.watcher = watcher;
    entry.watcherReady = new Promise<void>((resolve) => {
      const onError = () => {
        watcher.off('ready', onReady);
        resolve();
      };
      const onReady = () => {
        watcher.off('error', onError);
        resolve();
      };
      watcher.once('error', onError);
      watcher.once('ready', onReady);
    });
    watcher.on('all', (eventName: string, changedPath: string) => {
      if (entry.watcherToken !== token) return;
      if (
        eventName === 'change'
        && changedPath.endsWith('.jsonl')
        && (entry.fingerprintOptions.appendOnlyRoots || []).some(root => {
          const relative = path.relative(root, changedPath);
          return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
        })
      ) return;
      this.markDirty(entry);
    });
    watcher.on('error', () => {
      if (entry.watcherToken !== token) return;
      this.markDirty(entry);
    });
    await entry.watcherReady;
  }

  private async reconcile(entry: InventoryEntry<Value>): Promise<Value> {
    if (!entry.load) throw new Error(`Inventory loader is unavailable for ${entry.key}`);
    for (let attempt = 0; attempt < this.maxReconcileAttempts; attempt += 1) {
      const generation = entry.generation;
      const fingerprintOptions = { ...this.fingerprintOptions, ...entry.fingerprintOptions };
      const before = entry.sourceMayChangeDuringLoad
        ? ''
        : await filesystemFingerprint(entry.fingerprintPaths, fingerprintOptions);
      const hasAppendOnlyRoots = (fingerprintOptions.appendOnlyRoots || []).length > 0;
      const stableBefore = !entry.sourceMayChangeDuringLoad && hasAppendOnlyRoots
        ? await filesystemFingerprint(entry.fingerprintPaths, {
            ...fingerprintOptions,
            appendOnlyIdentityOnly: true,
          })
        : before;
      const value = await entry.load();
      if (entry.validate && !entry.validate(value)) {
        throw new Error(`Inventory loader returned an invalid value for ${entry.key}`);
      }
      const after = await filesystemFingerprint(entry.fingerprintPaths, fingerprintOptions);
      const stableAfter = !entry.sourceMayChangeDuringLoad && hasAppendOnlyRoots
        ? await filesystemFingerprint(entry.fingerprintPaths, {
            ...fingerprintOptions,
            appendOnlyIdentityOnly: true,
          })
        : after;
      if (
        !entry.sourceMayChangeDuringLoad
        && (generation !== entry.generation || stableBefore !== stableAfter)
      ) continue;
      entry.value = value;
      entry.fingerprint = before === after ? after : '';
      if (entry.fingerprint) {
        await this.snapshots?.set(entry.key, { fingerprint: after, value });
      }
      return value;
    }
    throw new Error(`Inventory changed repeatedly while reconciling ${entry.key}`);
  }

  private resolveCurrent(entry: InventoryEntry<Value>): Promise<Value> {
    if (entry.pending) return entry.pending;
    entry.pending = (async () => {
      if (entry.watcherReady) await entry.watcherReady;
      const generation = entry.generation;
      const fingerprint = await filesystemFingerprint(entry.fingerprintPaths, {
        ...this.fingerprintOptions,
        ...entry.fingerprintOptions,
      });
      if (
        entry.value !== null
        && (!entry.validate || entry.validate(entry.value))
        && entry.fingerprint === fingerprint
        && generation === entry.generation
      ) {
        return entry.value;
      }
      return this.reconcile(entry);
    })().finally(() => {
      entry.pending = null;
    });
    return entry.pending;
  }

  async get(key: string, request: InventoryRequest<Value>): Promise<Value> {
    const entry = this.entry(key);
    entry.backgroundRefresh = request.backgroundRefresh !== false;
    entry.load = request.load;
    entry.validate = request.validate || null;
    entry.fingerprintOptions = request.fingerprintOptions || {};
    entry.sourceMayChangeDuringLoad = request.sourceMayChangeDuringLoad === true;
    const fingerprintPaths = normalizedWatchPaths(request.fingerprintPaths || request.watchPaths);
    if (JSON.stringify(entry.fingerprintPaths) !== JSON.stringify(fingerprintPaths)) {
      if (entry.fingerprintPaths.length > 0) entry.fingerprint = '';
      entry.fingerprintPaths = fingerprintPaths;
    }
    await this.configureWatcher(entry, request.watchPaths);
    return this.resolveCurrent(entry);
  }

  invalidate(key?: string): void {
    if (key !== undefined) {
      const entry = this.entries.get(key);
      if (entry) this.markDirty(entry);
      return;
    }
    this.entries.forEach(entry => this.markDirty(entry));
  }

  async retain(keys: ReadonlySet<string>): Promise<void> {
    const closes: Promise<void>[] = [];
    for (const [key, entry] of this.entries) {
      if (keys.has(key)) continue;
      this.entries.delete(key);
      if (entry.refreshTimer) clearTimeout(entry.refreshTimer);
      if (entry.watcher) closes.push(entry.watcher.close());
    }
    await Promise.allSettled(closes);
    await this.snapshots?.deleteExcept(keys);
  }

  async close(): Promise<void> {
    const closes: Promise<void>[] = [];
    for (const entry of this.entries.values()) {
      if (entry.refreshTimer) clearTimeout(entry.refreshTimer);
      if (entry.watcher) closes.push(entry.watcher.close());
    }
    this.entries.clear();
    await Promise.allSettled(closes);
  }
}

export {
  AuthoritativeInventoryCache,
  filesystemFingerprint,
};
export type {
  AuthoritativeInventoryCacheOptions,
  FingerprintOptions,
  InventoryRequest,
};
