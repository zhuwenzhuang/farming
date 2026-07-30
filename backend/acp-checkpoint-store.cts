const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');
const { promisify } = require('util');
const zlib = require('zlib');
import * as storageLayout from './storage-layout.cjs';

type Gzip = (data: Buffer, options: { level: number }) => Promise<Buffer>;
type Gunzip = (data: Buffer) => Promise<Buffer>;

interface AcpCheckpointIdentity {
  cwd: string;
  provider: string;
  providerHomeId: string;
  sessionId: string;
}

interface AcpCheckpointState {
  exportCheckpoint(): unknown;
}

interface PendingCheckpoint {
  exact: boolean;
  identity: AcpCheckpointIdentity;
  state: AcpCheckpointState;
  timer: NodeJS.Timeout | null;
}

interface AcpCheckpointPaths {
  checkpoint: string;
  dirty: string;
  key: string;
}

interface AcpCheckpointLoadResult {
  exact: boolean;
  savedAt: number;
  state: unknown;
}

const gzip = promisify(zlib.gzip) as unknown as Gzip;
const gunzip = promisify(zlib.gunzip) as unknown as Gunzip;
const CHECKPOINT_VERSION = 1;
const DEFAULT_WRITE_DELAY_MS = 250;

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function errorCode(error: unknown): string {
  return error instanceof Error && 'code' in error ? String(error.code) : '';
}

async function durableWrite(file: string, data: string | Buffer): Promise<void> {
  const handle = await fs.open(file, 'w');
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await fs.open(directory, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function normalizeIdentity(value: unknown = {}): AcpCheckpointIdentity {
  const candidate = isObject(value) ? value : {};
  return {
    provider: String(candidate.provider || '').trim().toLowerCase(),
    providerHomeId: String(candidate.providerHomeId || 'default').trim() || 'default',
    sessionId: String(candidate.sessionId || '').trim(),
    cwd: path.resolve(String(candidate.cwd || process.cwd())),
  };
}

function checkpointKey(identity: unknown): string {
  return crypto.createHash('sha256')
    .update(JSON.stringify(normalizeIdentity(identity)))
    .digest('hex');
}

function sameIdentity(left: unknown, right: unknown): boolean {
  return JSON.stringify(normalizeIdentity(left)) === JSON.stringify(normalizeIdentity(right));
}

class AcpCheckpointStore {
  dir: string;
  writeDelayMs: number;
  pending: Map<string, PendingCheckpoint>;
  writeChains: Map<string, Promise<void>>;

  constructor(configDir: string, options: { writeDelayMs?: unknown } = {}) {
    this.dir = storageLayout.acpCheckpointsDir(configDir);
    this.writeDelayMs = Number.isFinite(Number(options.writeDelayMs))
      ? Math.max(0, Math.floor(Number(options.writeDelayMs)))
      : DEFAULT_WRITE_DELAY_MS;
    this.pending = new Map<string, PendingCheckpoint>();
    this.writeChains = new Map<string, Promise<void>>();
  }

  paths(identity: unknown): AcpCheckpointPaths {
    const key = checkpointKey(identity);
    return {
      key,
      checkpoint: path.join(this.dir, `${key}.json.gz`),
      dirty: path.join(this.dir, `${key}.dirty`),
    };
  }

  enqueue(key: string, operation: () => Promise<void>): Promise<void> {
    const previous = this.writeChains.get(key) || Promise.resolve();
    const next = previous.catch(() => {}).then(operation);
    this.writeChains.set(key, next);
    void next.then(() => {
      if (this.writeChains.get(key) === next) this.writeChains.delete(key);
    }, () => {
      if (this.writeChains.get(key) === next) this.writeChains.delete(key);
    });
    return next;
  }

  async load(
    identity: unknown,
    options: { allowDirty?: boolean } = {},
  ): Promise<AcpCheckpointLoadResult | null> {
    const normalized = normalizeIdentity(identity);
    if (!normalized.provider || !normalized.sessionId) return null;
    const files = this.paths(normalized);
    const inFlight = this.writeChains.get(files.key);
    if (inFlight) await inFlight.catch(() => {});
    try {
      const [compressed, dirty] = await Promise.all([
        fs.readFile(files.checkpoint),
        fs.access(files.dirty).then(() => true).catch(() => false),
      ]);
      const payload: unknown = JSON.parse((await gunzip(compressed)).toString('utf8'));
      if (
        !isObject(payload)
        || payload.version !== CHECKPOINT_VERSION
        || !sameIdentity(payload.identity, normalized)
        || !payload.state
      ) return null;
      if (dirty && options.allowDirty !== true) return null;
      return { state: payload.state, exact: !dirty, savedAt: Number(payload.savedAt || 0) };
    } catch (error: unknown) {
      if (errorCode(error) !== 'ENOENT') {
        console.warn('Failed to read ACP checkpoint:', error instanceof Error ? error.message : error);
      }
      return null;
    }
  }

  async markDirty(identity: unknown): Promise<void> {
    const normalized = normalizeIdentity(identity);
    if (!normalized.provider || !normalized.sessionId) return;
    const files = this.paths(normalized);
    const pending = this.pending.get(files.key);
    if (pending?.timer) clearTimeout(pending.timer);
    this.pending.delete(files.key);
    return this.enqueue(files.key, async () => {
      await fs.mkdir(this.dir, { recursive: true });
      await durableWrite(files.dirty, `${Date.now()}\n`);
      await syncDirectory(this.dir);
    });
  }

  schedule(
    identity: unknown,
    state: AcpCheckpointState | null | undefined,
    options: { exact?: boolean } = {},
  ): void {
    const normalized = normalizeIdentity(identity);
    if (!normalized.provider || !normalized.sessionId || !state) return;
    const files = this.paths(normalized);
    const previous = this.pending.get(files.key);
    if (previous?.timer) clearTimeout(previous.timer);
    const pending: PendingCheckpoint = {
      identity: normalized,
      state,
      exact: options.exact === true,
      timer: null,
    };
    pending.timer = setTimeout(() => {
      this.pending.delete(files.key);
      void this.write(pending.identity, pending.state, { exact: pending.exact });
    }, this.writeDelayMs);
    pending.timer.unref?.();
    this.pending.set(files.key, pending);
  }

  async write(
    identity: unknown,
    state: AcpCheckpointState | null | undefined,
    options: { exact?: boolean } = {},
  ): Promise<void> {
    const normalized = normalizeIdentity(identity);
    if (!normalized.provider || !normalized.sessionId || !state) return;
    const files = this.paths(normalized);
    const pending = this.pending.get(files.key);
    if (pending?.timer) clearTimeout(pending.timer);
    this.pending.delete(files.key);
    return this.enqueue(files.key, async () => {
      const payload = {
        version: CHECKPOINT_VERSION,
        savedAt: Date.now(),
        identity: normalized,
        state: state.exportCheckpoint(),
      };
      const compressed = await gzip(Buffer.from(JSON.stringify(payload)), { level: zlib.constants.Z_BEST_SPEED });
      await fs.mkdir(this.dir, { recursive: true });
      if (options.exact !== true) {
        await durableWrite(files.dirty, `${Date.now()}\n`);
        await syncDirectory(this.dir);
      }
      const temporary = `${files.checkpoint}.${process.pid}.${Date.now()}.tmp`;
      try {
        await durableWrite(temporary, compressed);
        await fs.rename(temporary, files.checkpoint);
        await syncDirectory(this.dir);
      } finally {
        await fs.rm(temporary, { force: true }).catch(() => {});
      }
      if (options.exact === true) {
        await fs.rm(files.dirty, { force: true });
        await syncDirectory(this.dir);
      }
    });
  }

  async flush(): Promise<void> {
    const pending = [...this.pending.values()];
    this.pending.clear();
    pending.forEach(item => {
      if (item.timer) clearTimeout(item.timer);
    });
    await Promise.all(pending.map(item => this.write(item.identity, item.state, { exact: item.exact })));
    await Promise.all([...this.writeChains.values()].map(write => write.catch(() => {})));
  }

  async dispose(): Promise<void> {
    await this.flush();
  }
}

export {
  AcpCheckpointStore,
  CHECKPOINT_VERSION,
  checkpointKey,
  normalizeIdentity,
};
