const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { isDeepStrictEqual } = require('util');
import { atomicWriteJson, atomicWriteJsonAsync } from './atomic-json-store.cjs';
import { legacyRuntimeMetadata } from './agent-runtime-binding.cjs';
import { lifecycleJournal } from './agent-lifecycle-journal.cjs';
import { getProviderAdapter, providerSessionIdentityScope } from './provider-adapters.cjs';
import * as storageLayout from './storage-layout.cjs';
import {
  canonicalProviderSessionKey,
  decodeProviderSessionKey,
  encodeProviderSessionKey,
  isProviderSessionKeyV2,
} from '../shared/provider-session-identity.js';

type JsonRecord = Record<string, unknown>;

interface ProviderSessionKey {
  provider: string;
  providerHomeId: string;
  sessionId: string;
}

interface SessionIndex {
  version: number;
  mainPageSessionKeys: string[];
  updatedAt: number;
}

interface FarmingSessionStoreOptions {
  normalizeMainPageSessionKeys?: (keys: unknown) => string[];
  writeJson?: (file: string, value: unknown) => void;
  writeJsonAsync?: (
    file: string,
    value: unknown,
    options: { beforeCommit: () => boolean },
  ) => Promise<boolean>;
}

interface FarmingSessionStoreInitOptions {
  legacyMainPageSessionKeys?: unknown;
}

type AsyncJsonWriter = NonNullable<FarmingSessionStoreOptions['writeJsonAsync']>;

interface AgentRecord extends JsonRecord {
  id: string;
  lifecycleJournal?: unknown;
}

interface AgentStateRecord extends JsonRecord {
  agentRecordId: string;
  agentStateVersion: number;
}

type AgentStatePersistenceResult =
  | {
    status: 'committed';
    id: string;
    commit: { metadataGeneration: number; stateGeneration: number };
  }
  | { status: 'fenced' }
  | { status: 'legacy-record' }
  | { status: 'record-missing' }
  | { status: 'owner-mismatch' };

function objectRecord(value: unknown): JsonRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

const AGENT_RECORD_ID_PREFIX = 'agent';
const AGENT_RECORD_VERSION = 1;
const AGENT_STATE_VERSION = 1;
const MAX_ADAPTIVE_TITLE_PERSISTENCE_ATTEMPTS = 8;
const MAX_AGENT_STATE_PERSISTENCE_ATTEMPTS = 8;
const SESSION_INDEX_VERSION = 2;
const MAX_MAIN_PAGE_SESSION_KEYS = 50;
const AGENT_STATE_FIELDS: string[] = [
  'acpState',
  'acpError',
  'acpStopReason',
  'acpPendingPermission',
  'acpPendingPermissions',
  'acpPendingElicitation',
  'acpPendingElicitations',
  'acpActiveElicitations',
  'acpSessionUpdatedAt',
  'acpSessionRevision',
  'acpFinalizedTurnHandle',
  'jsonCliState',
  'jsonCliError',
  'jsonCliTranscriptUpdatedAt',
  'attentionSeq',
  'readAttentionSeq',
  'attentionUpdatedAt',
  'readAttentionAt',
  'attentionReason',
  'attentionOutputEpoch',
  'attentionOutputSeq',
  'readOutputEpoch',
  'readOutputSeq',
  'unread',
  'composerCommands',
];
const AGENT_STATE_FIELD_SET = new Set(AGENT_STATE_FIELDS);
const PRODUCT_STATE_FIELDS: string[] = [
  'projectWorkspace',
  'task',
  'workflowTemplate',
  'pinned',
  'projectOrder',
  'pinnedOrder',
  'attentionSeq',
  'readAttentionSeq',
  'attentionUpdatedAt',
  'readAttentionAt',
  'attentionReason',
  'attentionOutputEpoch',
  'attentionOutputSeq',
  'readOutputEpoch',
  'readOutputSeq',
  'customTitle',
  'adaptiveTitle',
  'title',
  'titleUserSpecified',
];

function titleValue(value: unknown, limit = 160): string {
  return String(value || '').trim().slice(0, limit);
}

function normalizeTitleMetadata(record: JsonRecord, options: { explicitCustomTitle?: boolean } = {}): void {
  const customTitle = titleValue(record.customTitle, 80);
  if (customTitle) {
    record.customTitle = customTitle;
    record.title = customTitle;
    record.titleUserSpecified = true;
    return;
  }

  record.titleUserSpecified = false;
  const adaptiveTitle = titleValue(record.adaptiveTitle, 80);
  const providerTitle = titleValue(record.providerSessionTitle);
  const sessionTitle = titleValue(record.sessionTitle);
  const fallbackTitle = titleValue(record.task);
  const nextTitle = options.explicitCustomTitle === true
    ? (adaptiveTitle || providerTitle || sessionTitle || fallbackTitle)
    : (adaptiveTitle || providerTitle || sessionTitle || titleValue(record.title) || fallbackTitle);
  record.title = nextTitle;
}

function now(): number {
  return Date.now();
}

function createAgentRecordId(): string {
  const stamp = now().toString(36);
  const random = crypto.randomBytes(6).toString('hex');
  return `${AGENT_RECORD_ID_PREFIX}_${stamp}_${random}`;
}

function safeSessionFileName(id: unknown): string {
  const value = String(id || '').trim();
  return /^(?:agent|fsess)_[A-Za-z0-9_-]+$/.test(value) ? `${value}.json` : '';
}

function isLegacySessionId(id: unknown): boolean {
  return /^fsess_[A-Za-z0-9_-]+$/.test(String(id || '').trim());
}

function isAgentRecordId(id: unknown): boolean {
  return /^agent_[A-Za-z0-9_-]+$/.test(String(id || '').trim());
}

function agentRecordIdFor(agent: JsonRecord | null | undefined): string {
  if (agent && Object.prototype.hasOwnProperty.call(agent, 'persistentSessionId')) {
    return typeof agent.persistentSessionId === 'string' ? agent.persistentSessionId : '';
  }
  return typeof agent?.agentRecordId === 'string' ? agent.agentRecordId : '';
}

function cloneJson<T>(value: T): T {
  if (value === undefined) return value;
  return JSON.parse(JSON.stringify(value)) as T;
}

function sameJson(left: unknown, right: unknown): boolean {
  return isDeepStrictEqual(left, right);
}

function withoutUpdatedAt(value: JsonRecord | null | undefined): JsonRecord {
  const copy = { ...(value || {}) };
  delete copy.updatedAt;
  return copy;
}

function parseProviderSessionKey(key: unknown): ProviderSessionKey | null {
  return decodeProviderSessionKey(key);
}

function canonicalMainPageSessionKeys(keys: readonly string[]): string[] {
  const canonical: string[] = [];
  const seen = new Set<string>();
  for (const key of keys) {
    const canonicalKey = canonicalProviderSessionKey(key);
    if (!canonicalKey || seen.has(canonicalKey)) continue;
    seen.add(canonicalKey);
    canonical.push(canonicalKey);
  }
  return canonical;
}

class FarmingSessionStore {
  configDir: string;
  sessionsDir: string;
  indexFile: string;
  normalizeMainPageSessionKeys: (keys: unknown) => string[];
  writeJson: (file: string, value: unknown) => void;
  writeJsonAsync: AsyncJsonWriter;
  metadataWriteGenerations: Map<string, number>;
  stateWriteGenerations: Map<string, number>;
  index: SessionIndex | null;
  legacyProviderSessionRecords: Record<string, string>;
  providerSessionRecords: Map<string, string>;

  constructor(configDir: string, options: FarmingSessionStoreOptions = {}) {
    this.configDir = configDir;
    this.sessionsDir = storageLayout.sessionsDir(configDir);
    this.indexFile = storageLayout.sessionIndexFile(configDir);
    this.normalizeMainPageSessionKeys = typeof options.normalizeMainPageSessionKeys === 'function'
      ? options.normalizeMainPageSessionKeys
      : keys => (Array.isArray(keys) ? keys.filter((key): key is string => typeof key === 'string') : [])
        .slice(0, MAX_MAIN_PAGE_SESSION_KEYS);
    this.writeJson = typeof options.writeJson === 'function'
      ? options.writeJson
      : (file: string, value: unknown) => atomicWriteJson(file, value, { mode: 0o600 });
    this.writeJsonAsync = typeof options.writeJsonAsync === 'function'
      ? options.writeJsonAsync
      : (file, value, writeOptions) => atomicWriteJsonAsync(file, value, {
          ...writeOptions,
          mode: 0o600,
        });
    this.metadataWriteGenerations = new Map();
    this.stateWriteGenerations = new Map();
    this.index = null;
    this.legacyProviderSessionRecords = {};
    this.providerSessionRecords = new Map<string, string>();
  }

  init({ legacyMainPageSessionKeys = [] }: FarmingSessionStoreInitOptions = {}): void {
    fs.mkdirSync(this.sessionsDir, { recursive: true });
    this.index = this.readIndex();
    this.reconcileProviderSessionIndex();
    let nextMainPageSessionKeys = this.index.mainPageSessionKeys;
    if (!Array.isArray(this.index.mainPageSessionKeys) || this.index.mainPageSessionKeys.length === 0) {
      const migrated = this.filterRecoverableMainPageSessionKeys(legacyMainPageSessionKeys);
      if (migrated.length > 0) {
        nextMainPageSessionKeys = migrated;
      }
    }
    nextMainPageSessionKeys = this.filterRecoverableMainPageSessionKeys(nextMainPageSessionKeys);
    nextMainPageSessionKeys.forEach(sessionKey => {
      if (this.getRecordForProviderSessionKey(sessionKey)) return;
      this.ensureRecordForProviderSessionKey(sessionKey, {
        archived: false,
        lastSeenAt: now(),
      });
    });
    this.writeIndex({ ...this.index, mainPageSessionKeys: nextMainPageSessionKeys });
    this.legacyProviderSessionRecords = {};
  }

  reconcileProviderSessionIndex(): void {
    const recordsByProviderKey = new Map<string, AgentRecord[]>();
    const records = this.listStoredAgentRecords();
    const successors = this.legacySuccessors(records);
    for (const record of records) {
      if (successors.has(record.id)) continue;
      const sessionKey = String(record?.providerSessionKey || '');
      if (!record || record.kind !== 'agent' || !parseProviderSessionKey(sessionKey)) continue;
      const matches = recordsByProviderKey.get(sessionKey) || [];
      matches.push(record);
      recordsByProviderKey.set(sessionKey, matches);
    }

    const providerSessionRecords = new Map<string, string>();
    for (const [sessionKey, records] of recordsByProviderKey) {
      if (records.length > 1) {
        const ids = records.map(record => record.id).sort().join(', ');
        throw new Error(`Conflicting Farming session records for ${sessionKey}: ${ids}`);
      }
      providerSessionRecords.set(sessionKey, records[0].id);
    }

    for (const [sessionKey, id] of Object.entries(this.legacyProviderSessionRecords)) {
      if (providerSessionRecords.has(sessionKey)) continue;
      const record = this.readRecord(id);
      if (!record || successors.has(record.id)) continue;
      if (record.providerSessionKey && record.providerSessionKey !== sessionKey) {
        throw new Error(`Farming session ${id} is indexed as ${sessionKey} but bound to ${record.providerSessionKey}`);
      }
      providerSessionRecords.set(sessionKey, record.id);
    }
    this.providerSessionRecords = providerSessionRecords;
  }

  filterRecoverableMainPageSessionKeys(keys: unknown): string[] {
    return this.normalizeMainPageSessionKeys(keys).filter(sessionKey => {
      const record = this.getRecordForProviderSessionKey(sessionKey);
      if (!record) return true;
      if (record.archived === true) return false;
      const entries = lifecycleJournal(record).entries;
      const latest = entries.length > 0 ? entries[entries.length - 1] : null;
      return !(
        latest
        && ['delete', 'archive'].includes(latest.type)
        && latest.state === 'succeeded'
      );
    });
  }

  readIndex(): SessionIndex {
    try {
      if (fs.existsSync(this.indexFile)) {
        const parsed = objectRecord(JSON.parse(fs.readFileSync(this.indexFile, 'utf8')));
        this.legacyProviderSessionRecords = this.normalizeProviderSessionRecords(parsed?.providerSessionRecords);
        return this.normalizeIndex(parsed);
      }
    } catch (error: unknown) {
      console.warn('Failed to read Farming session index:', error instanceof Error ? error.message : error);
    }
    return this.normalizeIndex({});
  }

  normalizeIndex(index: JsonRecord | null | undefined): SessionIndex {
    return {
      version: SESSION_INDEX_VERSION,
      mainPageSessionKeys: canonicalMainPageSessionKeys(
        this.normalizeMainPageSessionKeys(index?.mainPageSessionKeys),
      ),
      updatedAt: typeof index?.updatedAt === 'number' ? index.updatedAt : now(),
    };
  }

  normalizeProviderSessionRecords(providerSessionRecords: unknown): Record<string, string> {
    const bindingsByCanonicalKey = new Map<string, { v2: Set<string>; legacy: Set<string> }>();
    Object.entries(
      providerSessionRecords && typeof providerSessionRecords === 'object' && !Array.isArray(providerSessionRecords)
        ? providerSessionRecords as JsonRecord
        : {},
    ).forEach(([key, id]) => {
      const canonicalKey = canonicalProviderSessionKey(key);
      if (!canonicalKey) return;
      if (!safeSessionFileName(id)) return;
      const bindings = bindingsByCanonicalKey.get(canonicalKey)
        || { v2: new Set<string>(), legacy: new Set<string>() };
      (isProviderSessionKeyV2(key) ? bindings.v2 : bindings.legacy).add(String(id));
      bindingsByCanonicalKey.set(canonicalKey, bindings);
    });

    const normalizedProviderSessionRecords: Record<string, string> = {};
    for (const [canonicalKey, bindings] of bindingsByCanonicalKey) {
      // A pre-v2 alias and its v2 key collapse onto one canonical key. The v2
      // spelling was written by a v2 build and therefore outranks the alias;
      // equally authoritative spellings that disagree are dropped rather than
      // resolved by persisted key order, so the reconcile pass rebuilds the
      // binding from the authoritative records.
      const authoritative = bindings.v2.size > 0 ? bindings.v2 : bindings.legacy;
      if (authoritative.size !== 1) {
        console.warn(
          `Dropping ambiguous Farming session index binding for ${canonicalKey}:`,
          [...authoritative].sort().join(', '),
        );
        continue;
      }
      normalizedProviderSessionRecords[canonicalKey] = [...authoritative][0];
    }
    return normalizedProviderSessionRecords;
  }

  ensureIndex(): SessionIndex {
    if (!this.index) this.init();
    if (!this.index) throw new Error('Farming session index initialization failed');
    return this.index;
  }

  writeIndex(index: SessionIndex = this.ensureIndex()): SessionIndex {
    const nextIndex = this.normalizeIndex({ ...index, updatedAt: now() });
    this.writeJson(this.indexFile, nextIndex);
    this.index = nextIndex;
    return nextIndex;
  }

  sessionFile(id: unknown): string {
    const fileName = safeSessionFileName(id);
    return fileName ? path.join(this.sessionsDir, fileName) : '';
  }

  agentStateFile(id: unknown): string {
    return isAgentRecordId(id) ? storageLayout.agentStateFile(this.configDir, String(id)) : '';
  }

  readMetadataRecord(id: string): AgentRecord | null {
    const file = this.sessionFile(id);
    if (!file) return null;
    try {
      if (!fs.existsSync(file)) return null;
      const parsed = objectRecord(JSON.parse(fs.readFileSync(file, 'utf8')));
      return parsed as AgentRecord | null;
    } catch {
      return null;
    }
  }

  readAgentState(id: string): AgentStateRecord | null {
    const file = this.agentStateFile(id);
    if (!file) return null;
    try {
      if (!fs.existsSync(file)) return null;
      const parsed = objectRecord(JSON.parse(fs.readFileSync(file, 'utf8')));
      if (
        !parsed
        || typeof parsed !== 'object'
        || parsed.agentRecordId !== id
        || parsed.agentStateVersion !== AGENT_STATE_VERSION
      ) {
        return null;
      }
      return {
        ...parsed,
        agentRecordId: id,
        agentStateVersion: AGENT_STATE_VERSION,
      };
    } catch {
      return null;
    }
  }

  readRecord(id: string): AgentRecord | null {
    const metadata = this.readMetadataRecord(id);
    if (!metadata) return null;
    if (!isAgentRecordId(id)) return this.withCanonicalProviderSessionKey(metadata);
    const state = this.readAgentState(id);
    if (!state) return this.withCanonicalProviderSessionKey({ ...metadata, agentRecordId: id });
    const merged: AgentRecord = { ...metadata, agentRecordId: id };
    AGENT_STATE_FIELDS.forEach(field => {
      if (Object.prototype.hasOwnProperty.call(state, field)) merged[field] = cloneJson(state[field]);
    });
    return this.withCanonicalProviderSessionKey(merged);
  }

  withCanonicalProviderSessionKey(record: AgentRecord): AgentRecord {
    const persisted = typeof record.providerSessionKey === 'string' ? record.providerSessionKey : '';
    if (!persisted) return record;
    const canonical = canonicalProviderSessionKey(persisted);
    if (!canonical || canonical === persisted) return record;
    return { ...record, providerSessionKey: canonical };
  }

  splitAgentRecord(record: JsonRecord, id: string): {
    metadata: AgentRecord;
    state: AgentStateRecord;
  } {
    const metadata: JsonRecord = {};
    const state: AgentStateRecord = {
      agentStateVersion: AGENT_STATE_VERSION,
      agentRecordId: id,
      kind: 'agent-state',
    };
    Object.entries(record || {}).forEach(([field, value]) => {
      if (AGENT_STATE_FIELD_SET.has(field)) state[field] = cloneJson(value);
      else metadata[field] = cloneJson(value);
    });
    metadata.id = id;
    metadata.agentRecordId = id;
    metadata.kind = 'agent';
    metadata.recordVersion = AGENT_RECORD_VERSION;
    return { metadata: metadata as AgentRecord, state };
  }

  promoteIndexRecordId(previousId: string, nextId: string): void {
    if (!previousId || previousId === nextId) return;
    for (const [key, id] of this.providerSessionRecords) {
      if (id === previousId) this.providerSessionRecords.set(key, nextId);
    }
  }

  writeRecord(record: AgentRecord | null | undefined): string {
    if (!record || !safeSessionFileName(record.id)) return '';
    const previousId = record.id;
    const id = isLegacySessionId(previousId) ? createAgentRecordId() : previousId;
    if (!isAgentRecordId(id)) return '';
    const promoted = id !== previousId;
    const nextRecord = {
      ...record,
      id,
      agentRecordId: id,
      ...(promoted ? { legacyRecordId: previousId } : {}),
    };
    const { metadata, state } = this.splitAgentRecord(nextRecord, id);
    const existingMetadata = this.readMetadataRecord(id);
    const existingState = this.readAgentState(id);
    const metadataChanged = !existingMetadata
      || !sameJson(withoutUpdatedAt(existingMetadata), withoutUpdatedAt(metadata));
    const stateChanged = !existingState
      || !sameJson(withoutUpdatedAt(existingState), withoutUpdatedAt(state));
    if (stateChanged) {
      state.updatedAt = now();
      this.stateWriteGenerations.set(id, (this.stateWriteGenerations.get(id) || 0) + 1);
      this.writeJson(this.agentStateFile(id), state);
    }
    if (metadataChanged) {
      metadata.updatedAt = now();
      this.metadataWriteGenerations.set(id, (this.metadataWriteGenerations.get(id) || 0) + 1);
      this.writeJson(this.sessionFile(id), metadata);
    }
    if (promoted) this.promoteIndexRecordId(previousId, id);
    return id;
  }

  async persistAgentStatePatch(
    agent: JsonRecord,
    patch: JsonRecord,
    options: { beforeCommit?: () => boolean } = {},
  ): Promise<AgentStatePersistenceResult> {
    const providerSessionKey = this.providerSessionKeyForAgent(agent);
    const preferredId = agentRecordIdFor(agent);
    const requestedOwner = String(agent?.id || '').trim();
    if (!requestedOwner) return { status: 'record-missing' };

    const statePatch: JsonRecord = {};
    AGENT_STATE_FIELDS.forEach(field => {
      if (Object.prototype.hasOwnProperty.call(patch, field)) statePatch[field] = cloneJson(patch[field]);
    });

    for (let attempt = 0; attempt < MAX_AGENT_STATE_PERSISTENCE_ATTEMPTS; attempt += 1) {
      const indexedId = providerSessionKey
        ? this.providerSessionRecords.get(providerSessionKey)
        : '';
      const candidateId = providerSessionKey ? String(indexedId || '') : preferredId;
      if (isLegacySessionId(candidateId)) return { status: 'legacy-record' };
      if (!isAgentRecordId(candidateId)) return { status: 'record-missing' };
      const id = candidateId;
      const metadataFile = this.sessionFile(id);
      const stateFile = this.agentStateFile(id);
      if (!metadataFile || !stateFile) return { status: 'record-missing' };

      const metadataGeneration = this.metadataWriteGenerations.get(id) || 0;
      const stateGeneration = this.stateWriteGenerations.get(id) || 0;
      let metadata: JsonRecord | null = null;
      let existingState: JsonRecord | null = null;
      try {
        metadata = objectRecord(JSON.parse(await fs.promises.readFile(metadataFile, 'utf8')));
        try {
          existingState = objectRecord(JSON.parse(await fs.promises.readFile(stateFile, 'utf8')));
        } catch (error: unknown) {
          if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error;
        }
      } catch (error: unknown) {
        if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
          return { status: 'record-missing' };
        }
        throw new Error(
          `Failed to read Agent session state ${id}: ${error instanceof Error ? error.message : error}`,
          { cause: error },
        );
      }
      if (!metadata || metadata.id !== id || metadata.kind !== 'agent') {
        throw new Error(`Agent session metadata ${id} is invalid`);
      }
      const currentOwner = String(metadata.runtimeAgentId || '').trim();
      if (currentOwner && currentOwner !== requestedOwner) return { status: 'owner-mismatch' };

      const state: AgentStateRecord = {
        ...(existingState || {}),
        ...statePatch,
        agentRecordId: id,
        agentStateVersion: AGENT_STATE_VERSION,
        kind: 'agent-state',
      };
      const stateChanged = !existingState
        || !sameJson(withoutUpdatedAt(existingState), withoutUpdatedAt(state));
      let rejectedByCaller = false;
      const canCommit = () => {
        if ((this.metadataWriteGenerations.get(id) || 0) !== metadataGeneration) return false;
        if ((this.stateWriteGenerations.get(id) || 0) !== stateGeneration) return false;
        if (providerSessionKey && this.providerSessionRecords.get(providerSessionKey) !== id) return false;
        if (options.beforeCommit && !options.beforeCommit()) {
          rejectedByCaller = true;
          return false;
        }
        return true;
      };

      if (!stateChanged) {
        if (canCommit()) {
          return {
            status: 'committed',
            id,
            commit: { metadataGeneration, stateGeneration },
          };
        }
        if (rejectedByCaller) return { status: 'fenced' };
        await new Promise<void>(resolve => setImmediate(resolve));
        continue;
      }

      state.updatedAt = now();
      const committed = await this.writeJsonAsync(stateFile, state, {
        beforeCommit: () => {
          if (!canCommit()) return false;
          this.stateWriteGenerations.set(id, stateGeneration + 1);
          return true;
        },
      });
      if (committed) {
        return {
          status: 'committed',
          id,
          commit: { metadataGeneration, stateGeneration: stateGeneration + 1 },
        };
      }
      if (rejectedByCaller) return { status: 'fenced' };
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    throw new Error('Agent state persistence exceeded the conflict retry limit');
  }

  isAgentStateCommitCurrent(
    agent: JsonRecord,
    id: string,
    commit: { metadataGeneration: number; stateGeneration: number },
  ): boolean {
    const providerSessionKey = this.providerSessionKeyForAgent(agent);
    if (providerSessionKey) {
      if (this.providerSessionRecords.get(providerSessionKey) !== id) return false;
    } else if (agentRecordIdFor(agent) !== id) {
      return false;
    }
    return (this.metadataWriteGenerations.get(id) || 0) === commit.metadataGeneration
      && (this.stateWriteGenerations.get(id) || 0) === commit.stateGeneration;
  }

  async persistAgentAdaptiveTitle(agent: JsonRecord, title: unknown): Promise<string> {
    const providerSessionKey = this.providerSessionKeyForAgent(agent);
    const preferredId = agentRecordIdFor(agent);
    const adaptiveTitle = titleValue(title, 80);
    if (!adaptiveTitle) return '';

    for (let attempt = 0; attempt < MAX_ADAPTIVE_TITLE_PERSISTENCE_ATTEMPTS; attempt += 1) {
      const indexedId = providerSessionKey
        ? this.providerSessionRecords.get(providerSessionKey)
        : '';
      const id = providerSessionKey
        ? (isAgentRecordId(indexedId) ? String(indexedId) : '')
        : (isAgentRecordId(preferredId) ? preferredId : '');
      const file = this.sessionFile(id);
      if (!id || !file) return '';
      const generation = this.metadataWriteGenerations.get(id) || 0;
      let existing: JsonRecord | null = null;
      try {
        existing = objectRecord(JSON.parse(await fs.promises.readFile(file, 'utf8')));
      } catch (error: unknown) {
        throw new Error(
          `Failed to read Agent session metadata ${id}: ${error instanceof Error ? error.message : error}`,
          { cause: error },
        );
      }
      if (!existing || existing.id !== id || existing.kind !== 'agent') {
        throw new Error(`Agent session metadata ${id} is invalid`);
      }
      const currentOwner = String(existing.runtimeAgentId || '').trim();
      const requestedOwner = String(agent.id || '').trim();
      if (currentOwner && currentOwner !== requestedOwner) return '';
      const record: AgentRecord = {
        ...existing,
        id,
        adaptiveTitle,
        updatedAt: now(),
      };
      normalizeTitleMetadata(record);
      if (
        (this.metadataWriteGenerations.get(id) || 0) !== generation
        || (providerSessionKey && this.providerSessionRecords.get(providerSessionKey) !== id)
      ) {
        await new Promise<void>(resolve => setImmediate(resolve));
        continue;
      }
      const committed = await this.writeJsonAsync(file, record, {
        beforeCommit: () => {
          if ((this.metadataWriteGenerations.get(id) || 0) !== generation) return false;
          if (providerSessionKey && this.providerSessionRecords.get(providerSessionKey) !== id) return false;
          this.metadataWriteGenerations.set(id, generation + 1);
          return true;
        },
      });
      if (committed) return id;
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    throw new Error('Adaptive Agent title persistence exceeded the metadata conflict retry limit');
  }

  listStoredAgentRecords(): AgentRecord[] {
    let names: string[] = [];
    try {
      names = fs.readdirSync(this.sessionsDir);
    } catch {
      return [];
    }
    return names
      .filter(name => name.endsWith('.json') && !name.endsWith('.state.json'))
      .map(name => name.slice(0, -5))
      .filter(id => safeSessionFileName(id))
      .map(id => this.readRecord(id))
      .filter((record): record is AgentRecord => record !== null && record.kind === 'agent');
  }

  legacySuccessors(records: AgentRecord[] | unknown): Map<string, string> {
    const successors = new Map<string, string>();
    for (const record of Array.isArray(records) ? records : []) {
      const legacyId = String(record?.legacyRecordId || '').trim();
      if (!isLegacySessionId(legacyId)) continue;
      const previous = successors.get(legacyId);
      if (previous && previous !== record.id) {
        throw new Error(`Conflicting Agent record successors for ${legacyId}: ${previous}, ${record.id}`);
      }
      successors.set(legacyId, record.id);
    }
    return successors;
  }

  providerSessionKeyForAgent(agent: JsonRecord | null | undefined): string {
    if (!agent || agent.providerSessionTemporary === true) return '';
    if (typeof agent.providerSessionKey === 'string' && agent.providerSessionKey) {
      return canonicalProviderSessionKey(agent.providerSessionKey);
    }
    if (agent.providerSessionProvider && agent.providerSessionId) {
      return encodeProviderSessionKey(
        agent.providerSessionProvider,
        agent.providerSessionId,
        typeof agent.providerHomeId === 'string' ? agent.providerHomeId : '',
      );
    }
    return '';
  }

  recordPatchFromAgent(agent: JsonRecord): JsonRecord {
    const providerSessionKey = this.providerSessionKeyForAgent(agent);
    const parsed = parseProviderSessionKey(providerSessionKey);
    return {
      runtimeAgentId: typeof agent.id === 'string' ? agent.id : '',
      command: typeof agent.command === 'string' ? agent.command : '',
      forkCommand: typeof agent.forkCommand === 'string' ? agent.forkCommand : '',
      cwd: typeof agent.cwd === 'string' ? agent.cwd : '',
      projectWorkspace: typeof agent.projectWorkspace === 'string' ? agent.projectWorkspace : '',
      mainWorkspace: typeof agent.mainWorkspace === 'string' ? agent.mainWorkspace : '',
      capabilityRuntimeEpoch: typeof agent.capabilityRuntimeEpoch === 'string'
        ? agent.capabilityRuntimeEpoch
        : '',
      source: typeof agent.source === 'string' ? agent.source : '',
      parentAgentId: typeof agent.parentAgentId === 'string' ? agent.parentAgentId : '',
      forkRequestId: typeof agent.forkRequestId === 'string' ? agent.forkRequestId : '',
      forkRequestSignature: typeof agent.forkRequestSignature === 'string'
        ? agent.forkRequestSignature
        : '',
      provider: parsed ? parsed.provider : (typeof agent.providerSessionProvider === 'string' ? agent.providerSessionProvider : ''),
      providerHomeId: parsed ? parsed.providerHomeId : (typeof agent.providerHomeId === 'string' ? agent.providerHomeId : ''),
      providerHomePath: typeof agent.providerHomePath === 'string' ? agent.providerHomePath : '',
      acpRuntimeMode: agent.acpRuntimeMode === 'custom' ? 'custom' : 'managed',
      acpRuntimeExecutable: typeof agent.acpRuntimeExecutable === 'string'
        ? agent.acpRuntimeExecutable
        : '',
      providerSessionId: parsed ? parsed.sessionId : (typeof agent.providerSessionId === 'string' ? agent.providerSessionId : ''),
      providerSessionKey,
      providerSessionTemporary: agent.providerSessionTemporary === true,
      providerSessionSource: typeof agent.providerSessionSource === 'string' ? agent.providerSessionSource : '',
      providerSessionMaterialized: agent.providerSessionMaterialized !== false,
      providerSessionResolvedAt: typeof agent.providerSessionResolvedAt === 'number' ? agent.providerSessionResolvedAt : null,
      providerSessionTitle: typeof agent.providerSessionTitle === 'string' ? agent.providerSessionTitle : '',
      providerSessionWorkspace: typeof agent.providerSessionWorkspace === 'string' ? agent.providerSessionWorkspace : '',
      forkedFromProviderSessionId: typeof agent.forkedFromProviderSessionId === 'string'
        ? agent.forkedFromProviderSessionId
        : '',
      terminalInputReceived: agent.terminalInputReceived === true,
      structuredRuntimeProcess: agent.structuredRuntimeProcess
        && typeof agent.structuredRuntimeProcess === 'object'
        ? JSON.parse(JSON.stringify(agent.structuredRuntimeProcess))
        : null,
      legacyAcpProcessExitAcknowledgedAt:
        typeof agent.legacyAcpProcessExitAcknowledgedAt === 'number'
          ? agent.legacyAcpProcessExitAcknowledgedAt
          : null,
      ...(agent.lifecycleJournal ? { lifecycleJournal: lifecycleJournal(agent) } : {}),
      ...legacyRuntimeMetadata(agent),
      engine: typeof agent.engineName === 'string' ? agent.engineName : '',
      category: typeof agent.category === 'string' ? agent.category : '',
      task: typeof agent.task === 'string' ? agent.task : '',
      workflowTemplate: typeof agent.workflowTemplate === 'string' ? agent.workflowTemplate : '',
      wantsMain: agent.wantsMain === true,
      pinned: agent.pinned === true,
      projectOrder: typeof agent.projectOrder === 'number' && Number.isFinite(agent.projectOrder) ? agent.projectOrder : null,
      pinnedOrder: typeof agent.pinnedOrder === 'number' && Number.isFinite(agent.pinnedOrder) ? agent.pinnedOrder : null,
      attentionSeq: typeof agent.attentionSeq === 'number' && Number.isFinite(agent.attentionSeq) ? Math.max(0, Math.floor(agent.attentionSeq)) : 0,
      readAttentionSeq: typeof agent.readAttentionSeq === 'number' && Number.isFinite(agent.readAttentionSeq) ? Math.max(0, Math.floor(agent.readAttentionSeq)) : 0,
      unread: Number(agent.attentionSeq) > Number(agent.readAttentionSeq),
      attentionUpdatedAt: typeof agent.attentionUpdatedAt === 'number' ? agent.attentionUpdatedAt : null,
      readAttentionAt: typeof agent.readAttentionAt === 'number' ? agent.readAttentionAt : null,
      attentionReason: typeof agent.attentionReason === 'string' ? agent.attentionReason : '',
      attentionOutputEpoch: typeof agent.attentionOutputEpoch === 'string' ? agent.attentionOutputEpoch : '',
      attentionOutputSeq: typeof agent.attentionOutputSeq === 'number' ? agent.attentionOutputSeq : null,
      readOutputEpoch: typeof agent.readOutputEpoch === 'string' ? agent.readOutputEpoch : '',
      readOutputSeq: typeof agent.readOutputSeq === 'number' ? agent.readOutputSeq : null,
      composerCommands: Array.isArray(agent.composerCommands)
        ? cloneJson(agent.composerCommands)
        : [],
      acpFinalizedTurnHandle: typeof agent.acpFinalizedTurnHandle === 'string'
        ? agent.acpFinalizedTurnHandle
        : '',
      archived: agent.archived === true,
      archivedAt: typeof agent.archivedAt === 'number' ? agent.archivedAt : null,
      ...(typeof agent.customTitle === 'string' && agent.customTitle
        ? { customTitle: agent.customTitle }
        : {}),
      ...(titleValue(agent.adaptiveTitle, 80)
        ? { adaptiveTitle: titleValue(agent.adaptiveTitle, 80) }
        : {}),
      title: titleValue(
        agent.customTitle
          || agent.adaptiveTitle
          || agent.providerSessionTitle
          || agent.sessionTitle
          || agent.title
          || agent.task,
      ),
      titleUserSpecified: titleValue(agent.customTitle, 80).length > 0,
      startedAt: typeof agent.startedAt === 'number' ? agent.startedAt : null,
    };
  }

  ensureRecordForProviderSessionKey(
    requestedSessionKey: string,
    patch: JsonRecord = {},
    preferredId = '',
  ): string {
    const parsed = parseProviderSessionKey(requestedSessionKey);
    if (!parsed) return '';
    const sessionKey = canonicalProviderSessionKey(requestedSessionKey);
    if (providerSessionIdentityScope(parsed.provider) === 'provider') {
      const conflictingBinding = this.listStoredAgentRecords().find(record => {
        const existing = parseProviderSessionKey(record.providerSessionKey);
        return existing?.provider === parsed.provider
          && existing.sessionId === parsed.sessionId
          && existing.providerHomeId !== parsed.providerHomeId;
      });
      if (conflictingBinding) {
        const providerName = getProviderAdapter(parsed.provider)?.displayName || parsed.provider;
        const error = new Error(
          `${providerName} session ${parsed.sessionId} is already bound to Agent Home "${String(conflictingBinding.providerHomeId || 'default')}"`,
        ) as Error & { code?: string; status?: number };
        error.code = 'AGENT_HOME_SESSION_CONFLICT';
        error.status = 409;
        throw error;
      }
    }
    this.ensureIndex();
    const indexedId = this.providerSessionRecords.get(sessionKey);
    const existingId = typeof indexedId === 'string' ? indexedId : '';
    const normalizedPreferredId = safeSessionFileName(preferredId) ? preferredId : '';
    const preferredRecord = normalizedPreferredId ? this.readRecord(normalizedPreferredId) : null;
    if (
      !safeSessionFileName(existingId)
      && preferredRecord?.providerSessionTemporary !== true
      && preferredRecord?.providerSessionKey
      && preferredRecord.providerSessionKey !== sessionKey
    ) {
      throw new Error(
        `Farming session ${normalizedPreferredId} is already bound to ${preferredRecord.providerSessionKey}`,
      );
    }
    const id = safeSessionFileName(existingId)
      ? existingId
      : (normalizedPreferredId || createAgentRecordId());
    const existing: JsonRecord = this.readRecord(id) || {};
    const record: AgentRecord = {
      id,
      kind: 'agent',
      createdAt: typeof existing.createdAt === 'number' ? existing.createdAt : now(),
      visibleOnMainPage: existing.visibleOnMainPage === true,
      archived: existing.archived === true,
      ...existing,
      ...patch,
      provider: parsed.provider,
      providerHomeId: parsed.providerHomeId,
      providerSessionId: parsed.sessionId,
      providerSessionKey: sessionKey,
      providerSessionTemporary: false,
      updatedAt: now(),
    };
    delete record.visibleOnMainPage;
    normalizeTitleMetadata(record, {
      explicitCustomTitle: Object.prototype.hasOwnProperty.call(patch, 'customTitle'),
    });
    const writtenId = this.writeRecord(record);
    for (const [key, recordId] of this.providerSessionRecords) {
      if (key !== sessionKey && recordId === writtenId) this.providerSessionRecords.delete(key);
    }
    this.providerSessionRecords.set(sessionKey, writtenId);
    return writtenId;
  }

  ensureRecordForAgent(agent: JsonRecord, patch: JsonRecord = {}): string {
    const providerSessionKey = this.providerSessionKeyForAgent(agent);
    if (providerSessionKey) {
      const preferredId = agentRecordIdFor(agent);
      const previousId = safeSessionFileName(preferredId)
        ? preferredId
        : '';
      const previous = previousId ? this.readRecord(previousId) : null;
      const canonical = this.getRecordForProviderSessionKey(providerSessionKey);
      const agentPatch = this.recordPatchFromAgent(agent);
      if (canonical && previousId && canonical.id !== previousId) {
        PRODUCT_STATE_FIELDS.forEach(field => {
          if (Object.prototype.hasOwnProperty.call(canonical, field)) {
            agentPatch[field] = canonical[field];
          } else if (previous && Object.prototype.hasOwnProperty.call(previous, field)) {
            agentPatch[field] = previous[field];
          }
        });
      }
      const id = this.ensureRecordForProviderSessionKey(providerSessionKey, {
        ...agentPatch,
        ...patch,
      }, preferredId || '');
      if (previousId && previousId !== id) {
        const promotedFromPrevious = this.readRecord(id)?.legacyRecordId === previousId;
        if (
          !promotedFromPrevious
          && previous
          && (previous.providerSessionTemporary === true || !previous.providerSessionKey)
        ) {
          const mergedId = this.writeRecord({
            ...previous,
            runtimeAgentId: '',
            visibleOnMainPage: false,
            archived: true,
            archivedAt: now(),
            mergedInto: id,
            updatedAt: now(),
          });
          if (mergedId && mergedId !== previousId) this.promoteIndexRecordId(previousId, mergedId);
        }
      }
      return id;
    }

    const preferredId = agentRecordIdFor(agent);
    const existingId = safeSessionFileName(preferredId) ? preferredId : '';
    const id = existingId || createAgentRecordId();
    const existing: JsonRecord = this.readRecord(id) || {};
    const record: AgentRecord = {
      id,
      kind: 'agent',
      createdAt: typeof existing.createdAt === 'number' ? existing.createdAt : now(),
      visibleOnMainPage: existing.visibleOnMainPage === true,
      archived: existing.archived === true,
      ...existing,
      ...this.recordPatchFromAgent(agent || {}),
      ...patch,
      updatedAt: now(),
    };
    normalizeTitleMetadata(record, {
      explicitCustomTitle: Object.prototype.hasOwnProperty.call(patch, 'customTitle'),
    });
    return this.writeRecord(record);
  }

  setProviderSessionDisplayState(sessionKey: string, patch: JsonRecord = {}): string {
    const displayPatch: JsonRecord = {};
    if (typeof patch.pinned === 'boolean') displayPatch.displayPinned = patch.pinned;
    return this.ensureRecordForProviderSessionKey(sessionKey, displayPatch);
  }

  rememberMainPageSessionKey(requestedSessionKey: string, patch: JsonRecord = {}): string[] {
    const id = this.ensureRecordForProviderSessionKey(requestedSessionKey, {
      ...patch,
      archived: false,
      lastSeenAt: now(),
    });
    if (!id) return this.getMainPageSessionKeys();
    const sessionKey = canonicalProviderSessionKey(requestedSessionKey);
    const index = this.ensureIndex();
    const nextIndex = this.writeIndex({ ...index, mainPageSessionKeys: this.normalizeMainPageSessionKeys([
      sessionKey,
      ...index.mainPageSessionKeys.filter(key => canonicalProviderSessionKey(key) !== sessionKey),
    ]) });
    return nextIndex.mainPageSessionKeys.slice();
  }

  rememberAgent(agent: JsonRecord): string {
    const providerSessionKey = this.providerSessionKeyForAgent(agent);
    const id = this.ensureRecordForAgent(agent, providerSessionKey ? { archived: false } : {});
    if (providerSessionKey) {
      this.rememberMainPageSessionKey(providerSessionKey, this.recordPatchFromAgent(agent));
    }
    return id;
  }

  setMainPageSessionKeys(keys: unknown): string[] {
    const normalized = this.normalizeMainPageSessionKeys(keys);
    const index = this.ensureIndex();
    normalized.forEach(key => {
      this.ensureRecordForProviderSessionKey(key, {
        archived: false,
        lastSeenAt: now(),
      });
    });
    return this.writeIndex({ ...index, mainPageSessionKeys: normalized }).mainPageSessionKeys.slice();
  }

  removeMainPageSessionKey(requestedSessionKey: string): boolean {
    const sessionKey = canonicalProviderSessionKey(requestedSessionKey);
    const index = this.ensureIndex();
    if (!sessionKey) return false;
    if (!index.mainPageSessionKeys.some(key => canonicalProviderSessionKey(key) === sessionKey)) return false;
    this.writeIndex({
      ...index,
      mainPageSessionKeys: index.mainPageSessionKeys.filter(
        key => canonicalProviderSessionKey(key) !== sessionKey,
      ),
    });
    return true;
  }

  removeMainPageSessionKeys(keys: unknown): string[] {
    const index = this.ensureIndex();
    const requested = new Set(
      (Array.isArray(keys) ? keys : [])
        .map(key => canonicalProviderSessionKey(key))
        .filter(Boolean),
    );
    const removed = index.mainPageSessionKeys.filter(
      key => requested.has(canonicalProviderSessionKey(key)),
    );
    if (removed.length === 0) return [];
    this.writeIndex({
      ...index,
      mainPageSessionKeys: index.mainPageSessionKeys.filter(
        key => !requested.has(canonicalProviderSessionKey(key)),
      ),
    });
    return removed;
  }

  getMainPageSessionKeys(): string[] {
    return this.ensureIndex().mainPageSessionKeys.slice();
  }

  getRecordForProviderSessionKey(sessionKey: string): AgentRecord | null {
    this.ensureIndex();
    const id = this.providerSessionRecords.get(canonicalProviderSessionKey(sessionKey));
    return safeSessionFileName(id) ? this.readRecord(String(id)) : null;
  }

  listAgentRecords(): AgentRecord[] {
    this.ensureIndex();
    const records = this.listStoredAgentRecords();
    const successors = this.legacySuccessors(records);
    return records.filter(record => !successors.has(record.id));
  }
}

export {
  AGENT_RECORD_VERSION,
  AGENT_STATE_VERSION,
  FarmingSessionStore,
  MAX_MAIN_PAGE_SESSION_KEYS,
  SESSION_INDEX_VERSION,
  parseProviderSessionKey,
};
