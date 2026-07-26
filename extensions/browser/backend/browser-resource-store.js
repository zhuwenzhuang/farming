const fs = require('fs');
const crypto = require('crypto');
const { atomicWriteJson } = require('../../../backend/atomic-json-store');
const storageLayout = require('../../../backend/storage-layout');

const STORE_VERSION = 1;
const RESOURCE_ID_RE = /^browser_[A-Za-z0-9_-]+$/;
const STATUSES = new Set(['stopped', 'starting', 'running', 'stopping', 'failed']);

function createBrowserId() {
  return `browser_${Date.now().toString(36)}_${crypto.randomBytes(6).toString('hex')}`;
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
    status: STATUSES.has(value.status) ? value.status : 'failed',
    generation: Number.isSafeInteger(value.generation) && value.generation >= 0 ? value.generation : 0,
    url: String(value.url || 'about:blank').slice(0, 8_192) || 'about:blank',
    title: String(value.title || '').slice(0, 512),
    browserKind: String(value.browserKind || ''),
    error: String(value.error || '').slice(0, 2_000),
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
    const resources = Array.isArray(parsed?.resources) ? parsed.resources : [];
    for (const value of resources) {
      const resource = normalizeResource(value);
      if (!resource || this.resources.has(resource.id)) continue;
      if (resource.status === 'running' || resource.status === 'starting' || resource.status === 'stopping') {
        resource.status = 'failed';
        resource.error = 'Farming restarted before the Browser runtime could be reconciled';
        resource.updatedAt = Date.now();
      }
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
      status: 'stopped',
      generation: 0,
      url: input.url || 'about:blank',
      title: '',
      browserKind: '',
      error: '',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    if (!resource) throw new Error('Invalid Browser resource');
    this.resources.set(resource.id, resource);
    this.commit();
    return { ...resource };
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
    this.writeJson(this.file, {
      version: STORE_VERSION,
      resources: this.list(),
      updatedAt: Date.now(),
    });
  }
}

module.exports = {
  BrowserResourceStore,
  RESOURCE_ID_RE,
};
