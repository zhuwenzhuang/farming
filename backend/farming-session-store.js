const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { isDeepStrictEqual } = require('util');
const { legacyRuntimeMetadata } = require('./agent-runtime-binding');
const { lifecycleJournal } = require('./agent-lifecycle-journal');
const storageLayout = require('./storage-layout');

const AGENT_RECORD_ID_PREFIX = 'agent';
const AGENT_RECORD_VERSION = 1;
const AGENT_STATE_VERSION = 1;
const MAX_MAIN_PAGE_SESSION_KEYS = 50;
const AGENT_STATE_FIELDS = [
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
];
const AGENT_STATE_FIELD_SET = new Set(AGENT_STATE_FIELDS);
const PRODUCT_STATE_FIELDS = [
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
];

function now() {
  return Date.now();
}

function createAgentRecordId() {
  const stamp = now().toString(36);
  const random = crypto.randomBytes(6).toString('hex');
  return `${AGENT_RECORD_ID_PREFIX}_${stamp}_${random}`;
}

function safeSessionFileName(id) {
  const value = String(id || '').trim();
  return /^(?:agent|fsess)_[A-Za-z0-9_-]+$/.test(value) ? `${value}.json` : '';
}

function isLegacySessionId(id) {
  return /^fsess_[A-Za-z0-9_-]+$/.test(String(id || '').trim());
}

function isAgentRecordId(id) {
  return /^agent_[A-Za-z0-9_-]+$/.test(String(id || '').trim());
}

function agentRecordIdFor(agent) {
  if (agent && Object.prototype.hasOwnProperty.call(agent, 'persistentSessionId')) {
    return typeof agent.persistentSessionId === 'string' ? agent.persistentSessionId : '';
  }
  return typeof agent?.agentRecordId === 'string' ? agent.agentRecordId : '';
}

function cloneJson(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function sameJson(left, right) {
  return isDeepStrictEqual(left, right);
}

function withoutUpdatedAt(value) {
  const copy = { ...(value || {}) };
  delete copy.updatedAt;
  return copy;
}

function atomicWriteJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmpFile = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpFile, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(tmpFile, file);
  fs.chmodSync(file, 0o600);
}

function parseProviderSessionKey(key) {
  const match = String(key || '').match(/^agent-session:([^:]+):(.+)$/);
  if (!match) return null;
  const provider = String(match[1] || '').trim().toLowerCase();
  let sessionId = String(match[2] || '').trim();
  let providerHomeId = 'default';
  const homeMatch = sessionId.match(/^home:([A-Za-z0-9._-]+):(.+)$/);
  if (homeMatch) {
    providerHomeId = homeMatch[1];
    sessionId = String(homeMatch[2] || '').trim();
  }
  if (!provider || !sessionId) return null;
  return { provider, providerHomeId, sessionId };
}

class FarmingSessionStore {
  constructor(configDir, options = {}) {
    this.configDir = configDir;
    this.sessionsDir = storageLayout.sessionsDir(configDir);
    this.indexFile = storageLayout.sessionIndexFile(configDir);
    this.normalizeMainPageSessionKeys = typeof options.normalizeMainPageSessionKeys === 'function'
      ? options.normalizeMainPageSessionKeys
      : keys => (Array.isArray(keys) ? keys : []).slice(0, MAX_MAIN_PAGE_SESSION_KEYS);
    this.index = null;
  }

  init({ legacyMainPageSessionKeys = [] } = {}) {
    fs.mkdirSync(this.sessionsDir, { recursive: true });
    this.index = this.readIndex();
    this.reconcileProviderSessionIndex();
    if (!Array.isArray(this.index.mainPageSessionKeys) || this.index.mainPageSessionKeys.length === 0) {
      const migrated = this.filterRecoverableMainPageSessionKeys(legacyMainPageSessionKeys);
      if (migrated.length > 0) {
        this.setMainPageSessionKeys(migrated);
        return;
      }
    }
    this.index.mainPageSessionKeys = this.filterRecoverableMainPageSessionKeys(
      this.index.mainPageSessionKeys,
    );
    this.writeIndex();
  }

  reconcileProviderSessionIndex() {
    const index = this.ensureIndex();
    const recordsByProviderKey = new Map();
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

    for (const [sessionKey, records] of recordsByProviderKey) {
      const indexedId = index.providerSessionRecords[sessionKey];
      const indexedRecord = indexedId ? records.find(record => record.id === indexedId) : null;
      if (records.length > 1) {
        const ids = records.map(record => record.id).sort().join(', ');
        throw new Error(`Conflicting Farming session records for ${sessionKey}: ${ids}`);
      }
      if (!indexedRecord || isLegacySessionId(indexedId)) {
        index.providerSessionRecords[sessionKey] = records[0].id;
      }
    }
  }

  filterRecoverableMainPageSessionKeys(keys) {
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

  readIndex() {
    try {
      if (fs.existsSync(this.indexFile)) {
        const parsed = JSON.parse(fs.readFileSync(this.indexFile, 'utf8'));
        return this.normalizeIndex(parsed);
      }
    } catch (error) {
      console.warn('Failed to read Farming session index:', error && (error.message || error));
    }
    return this.normalizeIndex({});
  }

  normalizeIndex(index) {
    const providerSessionRecords = index && typeof index.providerSessionRecords === 'object' && !Array.isArray(index.providerSessionRecords)
      ? index.providerSessionRecords
      : {};
    const normalizedProviderSessionRecords = {};
    Object.entries(providerSessionRecords).forEach(([key, id]) => {
      if (!parseProviderSessionKey(key)) return;
      if (!safeSessionFileName(id)) return;
      normalizedProviderSessionRecords[key] = id;
    });

    return {
      version: 1,
      mainPageSessionKeys: this.normalizeMainPageSessionKeys(index?.mainPageSessionKeys),
      providerSessionRecords: normalizedProviderSessionRecords,
      updatedAt: typeof index?.updatedAt === 'number' ? index.updatedAt : now(),
    };
  }

  ensureIndex() {
    if (!this.index) this.init();
    return this.index;
  }

  writeIndex() {
    const index = this.ensureIndex();
    index.updatedAt = now();
    atomicWriteJson(this.indexFile, index);
  }

  sessionFile(id) {
    const fileName = safeSessionFileName(id);
    return fileName ? path.join(this.sessionsDir, fileName) : '';
  }

  agentStateFile(id) {
    return isAgentRecordId(id) ? storageLayout.agentStateFile(this.configDir, id) : '';
  }

  readMetadataRecord(id) {
    const file = this.sessionFile(id);
    if (!file) return null;
    try {
      if (!fs.existsSync(file)) return null;
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
      return null;
    }
  }

  readAgentState(id) {
    const file = this.agentStateFile(id);
    if (!file) return null;
    try {
      if (!fs.existsSync(file)) return null;
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (
        !parsed
        || typeof parsed !== 'object'
        || parsed.agentRecordId !== id
        || parsed.agentStateVersion !== AGENT_STATE_VERSION
      ) {
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }

  readRecord(id) {
    const metadata = this.readMetadataRecord(id);
    if (!metadata) return null;
    if (!isAgentRecordId(id)) return metadata;
    const state = this.readAgentState(id);
    if (!state) return { ...metadata, agentRecordId: id };
    const merged = { ...metadata, agentRecordId: id };
    AGENT_STATE_FIELDS.forEach(field => {
      if (Object.prototype.hasOwnProperty.call(state, field)) merged[field] = cloneJson(state[field]);
    });
    return merged;
  }

  splitAgentRecord(record, id) {
    const metadata = {};
    const state = {
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
    return { metadata, state };
  }

  promoteIndexRecordId(previousId, nextId) {
    if (!this.index || !previousId || previousId === nextId) return;
    Object.entries(this.index.providerSessionRecords).forEach(([key, id]) => {
      if (id === previousId) this.index.providerSessionRecords[key] = nextId;
    });
  }

  writeRecord(record) {
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
      atomicWriteJson(this.agentStateFile(id), state);
    }
    if (metadataChanged) {
      metadata.updatedAt = now();
      atomicWriteJson(this.sessionFile(id), metadata);
    }
    if (promoted) this.promoteIndexRecordId(previousId, id);
    return id;
  }

  listStoredAgentRecords() {
    let names = [];
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
      .filter(record => record && record.kind === 'agent');
  }

  legacySuccessors(records) {
    const successors = new Map();
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

  providerSessionKeyForAgent(agent) {
    if (!agent || agent.providerSessionTemporary === true) return '';
    if (agent.providerSessionKey) return agent.providerSessionKey;
    if (agent.providerSessionProvider && agent.providerSessionId) {
      const homeId = typeof agent.providerHomeId === 'string' ? agent.providerHomeId.trim() : '';
      return homeId && homeId !== 'default'
        ? `agent-session:${agent.providerSessionProvider}:home:${homeId}:${agent.providerSessionId}`
        : `agent-session:${agent.providerSessionProvider}:${agent.providerSessionId}`;
    }
    return '';
  }

  recordPatchFromAgent(agent) {
    const providerSessionKey = this.providerSessionKeyForAgent(agent);
    const parsed = parseProviderSessionKey(providerSessionKey);
    return {
      runtimeAgentId: typeof agent.id === 'string' ? agent.id : '',
      command: typeof agent.command === 'string' ? agent.command : '',
      forkCommand: typeof agent.forkCommand === 'string' ? agent.forkCommand : '',
      cwd: typeof agent.cwd === 'string' ? agent.cwd : '',
      projectWorkspace: typeof agent.projectWorkspace === 'string' ? agent.projectWorkspace : '',
      mainWorkspace: typeof agent.mainWorkspace === 'string' ? agent.mainWorkspace : '',
      source: typeof agent.source === 'string' ? agent.source : '',
      provider: parsed ? parsed.provider : (typeof agent.providerSessionProvider === 'string' ? agent.providerSessionProvider : ''),
      providerHomeId: parsed ? parsed.providerHomeId : (typeof agent.providerHomeId === 'string' ? agent.providerHomeId : ''),
      providerHomePath: typeof agent.providerHomePath === 'string' ? agent.providerHomePath : '',
      providerSessionId: parsed ? parsed.sessionId : (typeof agent.providerSessionId === 'string' ? agent.providerSessionId : ''),
      providerSessionKey,
      providerSessionTemporary: agent.providerSessionTemporary === true,
      providerSessionSource: typeof agent.providerSessionSource === 'string' ? agent.providerSessionSource : '',
      providerSessionResolvedAt: typeof agent.providerSessionResolvedAt === 'number' ? agent.providerSessionResolvedAt : null,
      providerSessionTitle: typeof agent.providerSessionTitle === 'string' ? agent.providerSessionTitle : '',
      providerSessionWorkspace: typeof agent.providerSessionWorkspace === 'string' ? agent.providerSessionWorkspace : '',
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
      attentionUpdatedAt: typeof agent.attentionUpdatedAt === 'number' ? agent.attentionUpdatedAt : null,
      readAttentionAt: typeof agent.readAttentionAt === 'number' ? agent.readAttentionAt : null,
      attentionReason: typeof agent.attentionReason === 'string' ? agent.attentionReason : '',
      attentionOutputEpoch: typeof agent.attentionOutputEpoch === 'string' ? agent.attentionOutputEpoch : '',
      attentionOutputSeq: typeof agent.attentionOutputSeq === 'number' ? agent.attentionOutputSeq : null,
      readOutputEpoch: typeof agent.readOutputEpoch === 'string' ? agent.readOutputEpoch : '',
      readOutputSeq: typeof agent.readOutputSeq === 'number' ? agent.readOutputSeq : null,
      archived: agent.archived === true,
      archivedAt: typeof agent.archivedAt === 'number' ? agent.archivedAt : null,
      ...(typeof agent.customTitle === 'string' && agent.customTitle
        ? { customTitle: agent.customTitle }
        : {}),
      title: typeof agent.customTitle === 'string' && agent.customTitle
        ? agent.customTitle
        : (typeof agent.providerSessionTitle === 'string' && agent.providerSessionTitle
          ? agent.providerSessionTitle
          : (typeof agent.sessionTitle === 'string' ? agent.sessionTitle : '')),
      startedAt: typeof agent.startedAt === 'number' ? agent.startedAt : null,
    };
  }

  ensureRecordForProviderSessionKey(sessionKey, patch = {}, preferredId = '') {
    const parsed = parseProviderSessionKey(sessionKey);
    if (!parsed) return '';
    const index = this.ensureIndex();
    const existingId = index.providerSessionRecords[sessionKey];
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
    const existing = this.readRecord(id) || {};
    const record = {
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
    if (typeof record.customTitle === 'string' && record.customTitle) {
      record.title = record.customTitle;
    }
    Object.entries(index.providerSessionRecords).forEach(([key, recordId]) => {
      if (key !== sessionKey && recordId === id) delete index.providerSessionRecords[key];
    });
    const writtenId = this.writeRecord(record);
    index.providerSessionRecords[sessionKey] = writtenId;
    this.writeIndex();
    return writtenId;
  }

  ensureRecordForAgent(agent, patch = {}) {
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
          if (mergedId && mergedId !== previousId) this.writeIndex();
        }
      }
      return id;
    }

    const preferredId = agentRecordIdFor(agent);
    const existingId = safeSessionFileName(preferredId) ? preferredId : '';
    const id = existingId || createAgentRecordId();
    const existing = this.readRecord(id) || {};
    const record = {
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
    return this.writeRecord(record);
  }

  setProviderSessionDisplayState(sessionKey, patch = {}) {
    const displayPatch = {};
    if (typeof patch.pinned === 'boolean') displayPatch.displayPinned = patch.pinned;
    return this.ensureRecordForProviderSessionKey(sessionKey, displayPatch);
  }

  rememberMainPageSessionKey(sessionKey, patch = {}) {
    const id = this.ensureRecordForProviderSessionKey(sessionKey, {
      ...patch,
      visibleOnMainPage: true,
      archived: false,
      lastSeenAt: now(),
    });
    if (!id) return this.getMainPageSessionKeys();
    const index = this.ensureIndex();
    index.mainPageSessionKeys = this.normalizeMainPageSessionKeys([
      sessionKey,
      ...index.mainPageSessionKeys.filter(key => key !== sessionKey),
    ]);
    this.writeIndex();
    return index.mainPageSessionKeys.slice();
  }

  rememberAgent(agent) {
    const providerSessionKey = this.providerSessionKeyForAgent(agent);
    const id = this.ensureRecordForAgent(agent, providerSessionKey ? { visibleOnMainPage: true, archived: false } : {});
    if (providerSessionKey) {
      this.rememberMainPageSessionKey(providerSessionKey, this.recordPatchFromAgent(agent));
    }
    return id;
  }

  setMainPageSessionKeys(keys) {
    const normalized = this.normalizeMainPageSessionKeys(keys);
    const index = this.ensureIndex();
    const visible = new Set(normalized);
    normalized.forEach(key => {
      this.ensureRecordForProviderSessionKey(key, {
        visibleOnMainPage: true,
        archived: false,
        lastSeenAt: now(),
      });
    });
    index.mainPageSessionKeys.forEach(key => {
      if (visible.has(key)) return;
      const id = index.providerSessionRecords[key];
      const existing = this.readRecord(id);
      if (existing) {
        const writtenId = this.writeRecord({
          ...existing,
          visibleOnMainPage: false,
          updatedAt: now(),
        });
        if (writtenId) index.providerSessionRecords[key] = writtenId;
      }
    });
    index.mainPageSessionKeys = normalized;
    this.writeIndex();
    return normalized.slice();
  }

  removeMainPageSessionKey(sessionKey) {
    const index = this.ensureIndex();
    if (!index.mainPageSessionKeys.includes(sessionKey)) return false;
    index.mainPageSessionKeys = index.mainPageSessionKeys.filter(key => key !== sessionKey);
    const id = index.providerSessionRecords[sessionKey];
    const existing = this.readRecord(id);
    if (existing) {
      const writtenId = this.writeRecord({
        ...existing,
        visibleOnMainPage: false,
        updatedAt: now(),
      });
      if (writtenId) index.providerSessionRecords[sessionKey] = writtenId;
    }
    this.writeIndex();
    return true;
  }

  removeMainPageSessionKeys(keys) {
    const removed = [];
    keys.forEach(key => {
      if (this.removeMainPageSessionKey(key)) removed.push(key);
    });
    return removed;
  }

  getMainPageSessionKeys() {
    return this.ensureIndex().mainPageSessionKeys.slice();
  }

  getRecordForProviderSessionKey(sessionKey) {
    const index = this.ensureIndex();
    const id = index.providerSessionRecords[sessionKey];
    return safeSessionFileName(id) ? this.readRecord(id) : null;
  }

  listAgentRecords() {
    this.ensureIndex();
    const records = this.listStoredAgentRecords();
    const successors = this.legacySuccessors(records);
    return records.filter(record => !successors.has(record.id));
  }
}

module.exports = {
  AGENT_RECORD_VERSION,
  AGENT_STATE_VERSION,
  FarmingSessionStore,
  MAX_MAIN_PAGE_SESSION_KEYS,
  parseProviderSessionKey,
};
