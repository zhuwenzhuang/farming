const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { legacyRuntimeMetadata } = require('./agent-runtime-binding');
const storageLayout = require('./storage-layout');

const SESSION_ID_PREFIX = 'fsess';
const MAX_MAIN_PAGE_SESSION_KEYS = 50;
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

function createSessionId() {
  const stamp = now().toString(36);
  const random = crypto.randomBytes(6).toString('hex');
  return `${SESSION_ID_PREFIX}_${stamp}_${random}`;
}

function safeSessionFileName(id) {
  const value = String(id || '').trim();
  return /^fsess_[A-Za-z0-9_-]+$/.test(value) ? `${value}.json` : '';
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
    if (!Array.isArray(this.index.mainPageSessionKeys) || this.index.mainPageSessionKeys.length === 0) {
      const migrated = this.normalizeMainPageSessionKeys(legacyMainPageSessionKeys);
      if (migrated.length > 0) {
        this.setMainPageSessionKeys(migrated);
        return;
      }
    }
    this.index.mainPageSessionKeys = this.normalizeMainPageSessionKeys(this.index.mainPageSessionKeys);
    this.writeIndex();
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

  readRecord(id) {
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

  writeRecord(record) {
    if (!record || !safeSessionFileName(record.id)) return '';
    const file = this.sessionFile(record.id);
    atomicWriteJson(file, record);
    return record.id;
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
      lastSeenAt: now(),
    };
  }

  ensureRecordForProviderSessionKey(sessionKey, patch = {}, preferredId = '') {
    const parsed = parseProviderSessionKey(sessionKey);
    if (!parsed) return '';
    const index = this.ensureIndex();
    const existingId = index.providerSessionRecords[sessionKey];
    const id = safeSessionFileName(existingId)
      ? existingId
      : (safeSessionFileName(preferredId) ? preferredId : createSessionId());
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
    index.providerSessionRecords[sessionKey] = id;
    this.writeRecord(record);
    this.writeIndex();
    return id;
  }

  ensureRecordForAgent(agent, patch = {}) {
    const providerSessionKey = this.providerSessionKeyForAgent(agent);
    if (providerSessionKey) {
      const previousId = safeSessionFileName(agent?.persistentSessionId)
        ? agent.persistentSessionId
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
      }, agent?.persistentSessionId || '');
      if (previousId && previousId !== id) {
        if (previous && (previous.providerSessionTemporary === true || !previous.providerSessionKey)) {
          this.writeRecord({
            ...previous,
            runtimeAgentId: '',
            visibleOnMainPage: false,
            archived: true,
            archivedAt: now(),
            mergedInto: id,
            updatedAt: now(),
          });
        }
      }
      return id;
    }

    const existingId = safeSessionFileName(agent?.persistentSessionId) ? agent.persistentSessionId : '';
    const id = existingId || createSessionId();
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
    this.writeRecord(record);
    return id;
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
        this.writeRecord({
          ...existing,
          visibleOnMainPage: false,
          updatedAt: now(),
        });
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
      this.writeRecord({
        ...existing,
        visibleOnMainPage: false,
        updatedAt: now(),
      });
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
    let names = [];
    try {
      names = fs.readdirSync(this.sessionsDir);
    } catch {
      return [];
    }
    return names
      .filter(name => name.endsWith('.json') && safeSessionFileName(name.slice(0, -5)))
      .map(name => this.readRecord(name.slice(0, -5)))
      .filter(record => record && record.kind === 'agent');
  }
}

module.exports = {
  FarmingSessionStore,
  MAX_MAIN_PAGE_SESSION_KEYS,
  parseProviderSessionKey,
};
