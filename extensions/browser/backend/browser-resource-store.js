const fs = require('fs');
const crypto = require('crypto');
const { atomicWriteJson } = require('../../../backend/atomic-json-store.cjs');
const storageLayout = require('../../../backend/storage-layout');

const STORE_VERSION = 5;
const RESOURCE_ID_RE = /^browser_[A-Za-z0-9_-]+$/;
const TAB_ID_RE = /^t\d+$/;
const STATUSES = new Set(['stopped', 'starting', 'running', 'stopping', 'failed']);

function createBrowserId() {
  return `browser_${Date.now().toString(36)}_${crypto.randomBytes(6).toString('hex')}`;
}

function normalizeProcessIdentity(value) {
  if (
    !value
    || Number(value.pid) <= 0
    || !Number.isSafeInteger(Number(value.pid))
    || Number(value.processGroupId) <= 0
    || !Number.isSafeInteger(Number(value.processGroupId))
    || !String(value.startedAt || '').trim()
    || !String(value.format || '').trim()
  ) return null;
  return {
    pid: Number(value.pid),
    processGroupId: Number(value.processGroupId),
    startedAt: String(value.startedAt).trim(),
    format: String(value.format).trim(),
  };
}

function normalizeResource(value) {
  if (!value || typeof value !== 'object' || !RESOURCE_ID_RE.test(String(value.id || ''))) return null;
  const projectRootId = String(value.projectRootId || '').trim();
  const workspace = String(value.workspace || '').trim();
  if (!projectRootId || !workspace) return null;
  return {
    id: value.id,
    projectRootId,
    workspace,
    name: String(value.name || 'Browser').trim().slice(0, 120) || 'Browser',
    autoName: value.autoName === true,
    status: STATUSES.has(value.status) ? value.status : 'failed',
    generation: Number.isSafeInteger(value.generation) && value.generation >= 0 ? value.generation : 0,
    revision: Number.isSafeInteger(value.revision) && value.revision >= 0 ? value.revision : 0,
    url: String(value.url || 'about:blank').slice(0, 8_192) || 'about:blank',
    title: String(value.title || '').slice(0, 512),
    browserKind: String(value.browserKind || ''),
    runtimeKind: String(value.runtimeKind || ''),
    sessionId: RESOURCE_ID_RE.test(String(value.sessionId || '')) ? String(value.sessionId) : '',
    sessionGeneration: Number.isSafeInteger(value.sessionGeneration) && value.sessionGeneration >= 0
      ? value.sessionGeneration
      : 0,
    tabId: TAB_ID_RE.test(String(value.tabId || '')) ? String(value.tabId) : '',
    error: String(value.error || '').slice(0, 2_000),
    processIdentity: normalizeProcessIdentity(value.processIdentity),
    createdAt: Number.isFinite(value.createdAt) ? value.createdAt : Date.now(),
    updatedAt: Number.isFinite(value.updatedAt) ? value.updatedAt : Date.now(),
  };
}

class BrowserResourceStore {
  constructor(configDir, options = {}) {
    this.directory = storageLayout.browserResourcesDir(configDir);
    this.file = storageLayout.browserResourcesFile(configDir);
    this.writeJson = options.writeJson || ((file, value) => atomicWriteJson(file, value, { mode: 0o600 }));
    this.resources = new Map();
    this.revision = 0;
  }

  init() {
    fs.mkdirSync(this.directory, { recursive: true });
    let parsed = {};
    try {
      parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        console.warn('Failed to read Browser resources:', error?.message || error);
      }
    }
    this.revision = Number.isSafeInteger(parsed?.revision) && parsed.revision >= 0
      ? parsed.revision
      : 0;
    const resources = Array.isArray(parsed?.resources) ? parsed.resources : [];
    for (const value of resources) {
      const resource = normalizeResource(value);
      if (!resource || this.resources.has(resource.id)) continue;
      this.resources.set(resource.id, resource);
    }
    this.commit();
  }

  list() {
    return [...this.resources.values()]
      .map(resource => ({ ...resource }))
      .sort((left, right) => left.createdAt - right.createdAt);
  }

  get(id) {
    const resource = this.resources.get(id);
    return resource ? { ...resource } : null;
  }

  create(input) {
    const resource = normalizeResource({
      id: createBrowserId(),
      projectRootId: input.projectRootId,
      workspace: input.workspace,
      name: input.name || 'Browser',
      autoName: input.autoName === true,
      status: 'stopped',
      generation: 0,
      revision: 0,
      url: input.url || 'about:blank',
      title: '',
      browserKind: '',
      sessionId: input.sessionId || '',
      sessionGeneration: input.sessionGeneration || 0,
      tabId: input.tabId || '',
      error: '',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    if (!resource) throw new Error('Invalid Browser resource');
    this.resources.set(resource.id, resource);
    this.commit();
    return { ...resource };
  }

  createRunningTab(input) {
    const resource = this.create(input);
    return this.update(resource.id, {
      status: 'running',
      autoName: true,
      generation: 1,
      browserKind: input.browserKind,
      runtimeKind: 'agent-browser',
      sessionId: input.sessionId,
      sessionGeneration: input.sessionGeneration,
      tabId: input.tabId,
      title: input.title || '',
    });
  }

  update(id, patch) {
    const current = this.resources.get(id);
    if (!current) return null;
    const next = normalizeResource({
      ...current,
      ...patch,
      id: current.id,
      projectRootId: current.projectRootId,
      workspace: current.workspace,
      revision: current.revision + 1,
      updatedAt: Date.now(),
    });
    if (!next) throw new Error('Invalid Browser resource update');
    this.resources.set(id, next);
    this.commit();
    return { ...next };
  }

  delete(id) {
    if (!this.resources.delete(id)) return false;
    this.commit();
    return true;
  }

  commit() {
    const previousRevision = this.revision;
    this.revision += 1;
    try {
      this.writeJson(this.file, {
        version: STORE_VERSION,
        revision: this.revision,
        resources: this.list(),
        updatedAt: Date.now(),
      });
    } catch (error) {
      this.revision = previousRevision;
      throw error;
    }
  }
}

module.exports = {
  BrowserResourceStore,
  RESOURCE_ID_RE,
};
