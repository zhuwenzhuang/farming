const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');
const { promisify } = require('util');
const zlib = require('zlib');
const storageLayout = require('./storage-layout');

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);
const CHECKPOINT_VERSION = 1;
const DEFAULT_WRITE_DELAY_MS = 250;

async function durableWrite(file, data) {
  const handle = await fs.open(file, 'w');
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(directory) {
  const handle = await fs.open(directory, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function normalizeIdentity(value = {}) {
  return {
    provider: String(value.provider || '').trim().toLowerCase(),
    providerHomeId: String(value.providerHomeId || 'default').trim() || 'default',
    sessionId: String(value.sessionId || '').trim(),
    cwd: path.resolve(String(value.cwd || process.cwd())),
  };
}

function checkpointKey(identity) {
  return crypto.createHash('sha256')
    .update(JSON.stringify(normalizeIdentity(identity)))
    .digest('hex');
}

function sameIdentity(left, right) {
  return JSON.stringify(normalizeIdentity(left)) === JSON.stringify(normalizeIdentity(right));
}

class AcpCheckpointStore {
  constructor(configDir, options = {}) {
    this.dir = storageLayout.acpCheckpointsDir(configDir);
    this.writeDelayMs = Number.isFinite(Number(options.writeDelayMs))
      ? Math.max(0, Math.floor(Number(options.writeDelayMs)))
      : DEFAULT_WRITE_DELAY_MS;
    this.pending = new Map();
    this.writeChains = new Map();
  }

  paths(identity) {
    const key = checkpointKey(identity);
    return {
      key,
      checkpoint: path.join(this.dir, `${key}.json.gz`),
      dirty: path.join(this.dir, `${key}.dirty`),
    };
  }

  enqueue(key, operation) {
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

  async load(identity, options = {}) {
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
      const payload = JSON.parse((await gunzip(compressed)).toString('utf8'));
      if (
        payload?.version !== CHECKPOINT_VERSION
        || !sameIdentity(payload.identity, normalized)
        || !payload.state
      ) return null;
      if (dirty && options.allowDirty !== true) return null;
      return { state: payload.state, exact: !dirty, savedAt: Number(payload.savedAt || 0) };
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        console.warn('Failed to read ACP checkpoint:', error && (error.message || error));
      }
      return null;
    }
  }

  async markDirty(identity) {
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

  schedule(identity, state, options = {}) {
    const normalized = normalizeIdentity(identity);
    if (!normalized.provider || !normalized.sessionId || !state) return;
    const files = this.paths(normalized);
    const previous = this.pending.get(files.key);
    if (previous?.timer) clearTimeout(previous.timer);
    const pending = {
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

  async write(identity, state, options = {}) {
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

  async flush() {
    const pending = [...this.pending.values()];
    this.pending.clear();
    pending.forEach(item => {
      if (item.timer) clearTimeout(item.timer);
    });
    await Promise.all(pending.map(item => this.write(item.identity, item.state, { exact: item.exact })));
    await Promise.all([...this.writeChains.values()].map(write => write.catch(() => {})));
  }

  async dispose() {
    await this.flush();
  }
}

module.exports = {
  AcpCheckpointStore,
  CHECKPOINT_VERSION,
  checkpointKey,
  normalizeIdentity,
};
