type PreparedTranscript = Record<string, unknown>;

type PreparedTranscriptIdentity = {
  agentId: string;
  sessionId: string;
  runtimeEpoch: string;
  revision: number;
  projectionRevision: number;
};

type ObservePreparedTranscript = PreparedTranscriptIdentity & {
  eligible: boolean;
  priority?: number;
};

type PreparedTranscriptCacheOptions = {
  prepare: (identity: PreparedTranscriptIdentity) => Promise<PreparedTranscript> | PreparedTranscript;
  validate: (identity: PreparedTranscriptIdentity) => boolean;
  quietMs?: number;
  maxConcurrent?: number;
  maxQueued?: number;
  maxRecords?: number;
  maxBytes?: number;
  maxEntryBytes?: number;
  schedule?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  cancel?: (timer: ReturnType<typeof setTimeout>) => void;
  defer?: (callback: () => void) => void;
};

type PreparedTranscriptRecord = ObservePreparedTranscript & {
  generation: number;
  timer: ReturnType<typeof setTimeout> | null;
};

type PreparedTranscriptJob = PreparedTranscriptIdentity & {
  generation: number;
  priority: number;
  sequence: number;
};

type PreparedTranscriptEntry = PreparedTranscriptIdentity & {
  bytes: number;
  json: string;
};

function cacheKey(identity: PreparedTranscriptIdentity) {
  return `${identity.agentId}\u0000${identity.sessionId}\u0000${identity.runtimeEpoch}\u0000${identity.revision}\u0000${identity.projectionRevision}`;
}

function serialize(value: unknown) {
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

export class AcpPreparedTranscriptCache {
  private readonly prepare: PreparedTranscriptCacheOptions['prepare'];
  private readonly validate: PreparedTranscriptCacheOptions['validate'];
  private readonly quietMs: number;
  private readonly maxConcurrent: number;
  private readonly maxQueued: number;
  private readonly maxRecords: number;
  private readonly maxBytes: number;
  private readonly maxEntryBytes: number;
  private readonly schedule: NonNullable<PreparedTranscriptCacheOptions['schedule']>;
  private readonly cancel: NonNullable<PreparedTranscriptCacheOptions['cancel']>;
  private readonly defer: NonNullable<PreparedTranscriptCacheOptions['defer']>;
  private readonly records = new Map<string, PreparedTranscriptRecord>();
  private readonly entries = new Map<string, PreparedTranscriptEntry>();
  private queue: PreparedTranscriptJob[] = [];
  private readonly inFlightAgents = new Set<string>();
  private active = 0;
  private sequence = 0;
  private totalBytes = 0;
  private disposed = false;

  constructor(options: PreparedTranscriptCacheOptions) {
    this.prepare = options.prepare;
    this.validate = options.validate;
    this.quietMs = Math.max(0, options.quietMs ?? 150);
    this.maxConcurrent = Math.max(1, options.maxConcurrent ?? 2);
    this.maxQueued = Math.max(this.maxConcurrent, options.maxQueued ?? 32);
    this.maxRecords = Math.max(this.maxQueued, options.maxRecords ?? 128);
    this.maxBytes = Math.max(1, options.maxBytes ?? 16 * 1024 * 1024);
    this.maxEntryBytes = Math.min(
      this.maxBytes,
      Math.max(1, options.maxEntryBytes ?? 2 * 1024 * 1024),
    );
    this.schedule = options.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.cancel = options.cancel ?? (timer => clearTimeout(timer));
    this.defer = options.defer ?? (callback => setImmediate(callback));
  }

  observe(input: ObservePreparedTranscript) {
    if (
      this.disposed
      || !input.agentId
      || !input.sessionId
      || !input.runtimeEpoch
      || !Number.isFinite(input.revision)
      || !Number.isFinite(input.projectionRevision)
    ) return;
    const previous = this.records.get(input.agentId);
    const identityChanged = !previous
      || previous.sessionId !== input.sessionId
      || previous.runtimeEpoch !== input.runtimeEpoch
      || previous.revision !== input.revision
      || previous.projectionRevision !== input.projectionRevision;
    if (identityChanged) this.dropAgentEntries(input.agentId);
    if (
      !identityChanged
      && previous
      && previous.eligible === input.eligible
    ) {
      previous.priority = Math.max(
        Number(previous.priority || 0),
        Number.isFinite(input.priority) ? Number(input.priority) : 0,
      );
      this.records.delete(input.agentId);
      this.records.set(input.agentId, previous);
      const queued = this.queue.find(job => job.agentId === input.agentId);
      if (queued) {
        queued.priority = previous.priority;
        this.sortQueue();
      }
      if (
        !previous.eligible
        || this.entries.has(cacheKey(input))
        || previous.timer
        || queued
        || this.inFlightAgents.has(input.agentId)
      ) return;
    }
    if (previous?.timer) this.cancel(previous.timer);
    const record: PreparedTranscriptRecord = {
      ...input,
      revision: Math.max(0, Math.floor(input.revision)),
      projectionRevision: Math.max(0, Math.floor(input.projectionRevision)),
      priority: Number.isFinite(input.priority) ? Number(input.priority) : 0,
      generation: (previous?.generation ?? 0) + 1,
      timer: null,
    };
    this.records.delete(input.agentId);
    this.records.set(input.agentId, record);
    this.trimRecords();
    if (this.records.get(input.agentId) !== record) return;
    this.queue = this.queue.filter(job => job.agentId !== input.agentId);
    if (!record.eligible) return;
    const generation = record.generation;
    record.timer = this.schedule(() => {
      const current = this.records.get(input.agentId);
      if (!current || current.generation !== generation || !current.eligible) return;
      current.timer = null;
      this.enqueue(current);
    }, this.quietMs);
  }

  hasAgent(agentId: string) {
    return this.records.has(agentId);
  }

  getSerialized(identity: PreparedTranscriptIdentity) {
    const key = cacheKey(identity);
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (!this.validate(identity)) {
      this.entries.delete(key);
      this.totalBytes -= entry.bytes;
      return null;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.json;
  }

  get(identity: PreparedTranscriptIdentity) {
    const json = this.getSerialized(identity);
    if (!json) return null;
    try {
      return JSON.parse(json) as PreparedTranscript;
    } catch {
      return null;
    }
  }

  publishOnDemand(identity: PreparedTranscriptIdentity, transcript: PreparedTranscript) {
    if (!this.validate(identity)) return false;
    const current = this.records.get(identity.agentId);
    if (
      current
      && (
        current.sessionId !== identity.sessionId
        || current.runtimeEpoch !== identity.runtimeEpoch
        || current.revision !== identity.revision
        || current.projectionRevision !== identity.projectionRevision
      )
    ) return false;
    return this.publish(identity, transcript);
  }

  deleteAgent(agentId: string) {
    const record = this.records.get(agentId);
    if (record?.timer) this.cancel(record.timer);
    this.records.delete(agentId);
    this.queue = this.queue.filter(job => job.agentId !== agentId);
    this.dropAgentEntries(agentId);
  }

  stats() {
    return {
      active: this.active,
      queued: this.queue.length,
      entries: this.entries.size,
      records: this.records.size,
      bytes: this.totalBytes,
      maxConcurrent: this.maxConcurrent,
      maxQueued: this.maxQueued,
      maxRecords: this.maxRecords,
      maxBytes: this.maxBytes,
    };
  }

  dispose() {
    this.disposed = true;
    for (const record of this.records.values()) {
      if (record.timer) this.cancel(record.timer);
    }
    this.records.clear();
    this.queue = [];
    this.entries.clear();
    this.totalBytes = 0;
  }

  private enqueue(record: PreparedTranscriptRecord) {
    this.queue = this.queue.filter(job => job.agentId !== record.agentId);
    this.queue.push({
      agentId: record.agentId,
      sessionId: record.sessionId,
      runtimeEpoch: record.runtimeEpoch,
      revision: record.revision,
      projectionRevision: record.projectionRevision,
      generation: record.generation,
      priority: record.priority ?? 0,
      sequence: ++this.sequence,
    });
    this.sortQueue();
    if (this.queue.length > this.maxQueued) this.queue.length = this.maxQueued;
    this.pump();
  }

  private pump() {
    while (!this.disposed && this.active < this.maxConcurrent && this.queue.length > 0) {
      const jobIndex = this.queue.findIndex(candidate => !this.inFlightAgents.has(candidate.agentId));
      if (jobIndex < 0) return;
      const [job] = this.queue.splice(jobIndex, 1);
      if (!job) return;
      const record = this.records.get(job.agentId);
      if (
        !record
        || !record.eligible
        || record.generation !== job.generation
          || record.sessionId !== job.sessionId
          || record.runtimeEpoch !== job.runtimeEpoch
          || record.revision !== job.revision
          || record.projectionRevision !== job.projectionRevision
      ) continue;
      this.active += 1;
      this.inFlightAgents.add(job.agentId);
      this.defer(() => {
        void Promise.resolve(this.prepare(job))
          .then(transcript => {
            const current = this.records.get(job.agentId);
            if (
              !current
              || !current.eligible
              || current.generation !== job.generation
              || current.sessionId !== job.sessionId
              || current.runtimeEpoch !== job.runtimeEpoch
              || current.revision !== job.revision
              || current.projectionRevision !== job.projectionRevision
              || !this.validate(job)
            ) return;
            this.publish(job, transcript);
          })
          .catch(() => undefined)
          .finally(() => {
            this.active -= 1;
            this.inFlightAgents.delete(job.agentId);
            this.pump();
          });
      });
    }
  }

  private publish(identity: PreparedTranscriptIdentity, transcript: PreparedTranscript) {
    const json = serialize(transcript);
    if (json === null) return null;
    const bytes = Buffer.byteLength(json);
    if (bytes > this.maxEntryBytes || bytes > this.maxBytes) return null;
    const key = cacheKey(identity);
    const previous = this.entries.get(key);
    if (previous) this.totalBytes -= previous.bytes;
    this.entries.delete(key);
    this.entries.set(key, { ...identity, bytes, json });
    this.totalBytes += bytes;
    while (this.totalBytes > this.maxBytes && this.entries.size > 0) {
      const oldestKey = this.entries.keys().next().value;
      if (typeof oldestKey !== 'string') break;
      const oldest = this.entries.get(oldestKey);
      this.entries.delete(oldestKey);
      if (oldest) this.totalBytes -= oldest.bytes;
    }
    return this.entries.has(key) ? json : null;
  }

  private sortQueue() {
    this.queue.sort((left, right) => (
      right.priority - left.priority || right.sequence - left.sequence
    ));
  }

  private trimRecords() {
    while (this.records.size > this.maxRecords) {
      const oldestAgentId = this.records.keys().next().value;
      if (typeof oldestAgentId !== 'string') break;
      const oldest = this.records.get(oldestAgentId);
      if (oldest?.timer) this.cancel(oldest.timer);
      this.records.delete(oldestAgentId);
      this.queue = this.queue.filter(job => job.agentId !== oldestAgentId);
      this.dropAgentEntries(oldestAgentId);
    }
  }

  private dropAgentEntries(agentId: string) {
    for (const [key, entry] of this.entries) {
      if (entry.agentId !== agentId) continue;
      this.entries.delete(key);
      this.totalBytes -= entry.bytes;
    }
  }
}
