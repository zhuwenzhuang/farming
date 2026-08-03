type PreparedTranscript = Record<string, unknown>;

type PreparedTranscriptIdentity = {
  agentId: string;
  sessionId: string;
  runtimeEpoch: string;
  revision: number;
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
  transcript: PreparedTranscript;
};

function cacheKey(identity: PreparedTranscriptIdentity) {
  return `${identity.agentId}\u0000${identity.sessionId}\u0000${identity.runtimeEpoch}\u0000${identity.revision}`;
}

function serializedBytes(value: unknown) {
  try {
    return Buffer.byteLength(JSON.stringify(value));
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

export class AcpPreparedTranscriptCache {
  private readonly prepare: PreparedTranscriptCacheOptions['prepare'];
  private readonly validate: PreparedTranscriptCacheOptions['validate'];
  private readonly quietMs: number;
  private readonly maxConcurrent: number;
  private readonly maxQueued: number;
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
    if (this.disposed || !input.agentId || !input.sessionId || !input.runtimeEpoch || !Number.isFinite(input.revision)) return;
    const previous = this.records.get(input.agentId);
    const identityChanged = !previous
      || previous.sessionId !== input.sessionId
      || previous.runtimeEpoch !== input.runtimeEpoch
      || previous.revision !== input.revision;
    if (previous?.timer) this.cancel(previous.timer);
    if (identityChanged) this.dropAgentEntries(input.agentId);
    if (
      !identityChanged
      && previous?.eligible === input.eligible
      && this.entries.has(cacheKey(input))
    ) return;
    const record: PreparedTranscriptRecord = {
      ...input,
      revision: Math.max(0, Math.floor(input.revision)),
      priority: Number.isFinite(input.priority) ? Number(input.priority) : 0,
      generation: (previous?.generation ?? 0) + 1,
      timer: null,
    };
    this.records.set(input.agentId, record);
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

  get(identity: PreparedTranscriptIdentity) {
    const key = cacheKey(identity);
    const entry = this.entries.get(key);
    if (!entry) return null;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.transcript;
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
      bytes: this.totalBytes,
      maxConcurrent: this.maxConcurrent,
      maxQueued: this.maxQueued,
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
      generation: record.generation,
      priority: record.priority ?? 0,
      sequence: ++this.sequence,
    });
    this.queue.sort((left, right) => (
      right.priority - left.priority || right.sequence - left.sequence
    ));
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
    const bytes = serializedBytes(transcript);
    if (!Number.isFinite(bytes) || bytes > this.maxEntryBytes || bytes > this.maxBytes) return false;
    const key = cacheKey(identity);
    const previous = this.entries.get(key);
    if (previous) this.totalBytes -= previous.bytes;
    this.entries.delete(key);
    this.entries.set(key, { ...identity, bytes, transcript });
    this.totalBytes += bytes;
    while (this.totalBytes > this.maxBytes && this.entries.size > 0) {
      const oldestKey = this.entries.keys().next().value;
      if (typeof oldestKey !== 'string') break;
      const oldest = this.entries.get(oldestKey);
      this.entries.delete(oldestKey);
      if (oldest) this.totalBytes -= oldest.bytes;
    }
    return this.entries.has(key);
  }

  private dropAgentEntries(agentId: string) {
    for (const [key, entry] of this.entries) {
      if (entry.agentId !== agentId) continue;
      this.entries.delete(key);
      this.totalBytes -= entry.bytes;
    }
  }
}
