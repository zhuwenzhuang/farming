import * as crypto from 'crypto';
import * as fs from 'fs';
import { atomicWriteJson } from '../../../backend/atomic-json-store.cjs';
import {
  browserResourcesDir,
  browserResourcesFile,
} from '../../../backend/storage-layout.cjs';

const STORE_VERSION = 10;
const RESOURCE_ID_RE = /^browser_[A-Za-z0-9_-]+$/;
const SESSION_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const TAB_ID_RE = /^t\d+$/;
const STATUSES = new Set<BrowserResourceStatus>([
  'stopped',
  'starting',
  'running',
  'stopping',
  'failed',
]);

type BrowserResourceStatus = 'stopped' | 'starting' | 'running' | 'stopping' | 'failed';
type BrowserResourceOwnerType = 'agent' | 'project';

interface BrowserProcessIdentity {
  configInstanceFingerprint?: string;
  format: string;
  pid: number;
  processGroupId: number;
  startedAt: string;
}

interface BrowserResource {
  autoName: boolean;
  browserKind: string;
  browserSource: string;
  browserExecutablePath: string;
  createdAt: number;
  error: string;
  existingTabId: number | null;
  generation: number;
  id: string;
  name: string;
  ownerAgentId: string;
  ownerType: BrowserResourceOwnerType;
  processIdentity: BrowserProcessIdentity | null;
  projectRootId: string;
  revision: number;
  runtimeKind: string;
  sessionName: string;
  sessionGeneration: number;
  sessionId: string;
  status: BrowserResourceStatus;
  tabId: string;
  title: string;
  updatedAt: number;
  url: string;
  workspace: string;
}

interface BrowserResourceCreateInput {
  autoName?: boolean;
  browserKind?: unknown;
  browserSource?: unknown;
  browserExecutablePath?: unknown;
  existingTabId?: unknown;
  name?: unknown;
  ownerAgentId?: unknown;
  ownerType?: unknown;
  projectRootId: unknown;
  sessionName?: unknown;
  sessionGeneration?: unknown;
  sessionId?: unknown;
  tabId?: unknown;
  title?: unknown;
  url?: unknown;
  workspace: unknown;
}

interface RunningBrowserTabInput extends BrowserResourceCreateInput {
  browserKind: unknown;
  sessionGeneration: unknown;
  sessionId: unknown;
  tabId: unknown;
}

type MutableBrowserResourceKey = Exclude<
  keyof BrowserResource,
  'id' | 'ownerAgentId' | 'ownerType' | 'projectRootId' | 'revision' | 'updatedAt' | 'workspace'
>;

type BrowserResourcePatch = {
  [Key in MutableBrowserResourceKey]?: unknown;
};

type WriteJson = (file: string, value: unknown) => void;

interface BrowserResourceStoreOptions {
  writeJson?: WriteJson;
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object'
    ? value as Record<string, unknown>
    : {};
}

function errorCode(error: unknown): string {
  if (!error || typeof error !== 'object' || !('code' in error)) return '';
  return typeof error.code === 'string' ? error.code : '';
}

function isBrowserResourceStatus(value: unknown): value is BrowserResourceStatus {
  return typeof value === 'string' && STATUSES.has(value as BrowserResourceStatus);
}

function createBrowserId(): string {
  return `browser_${Date.now().toString(36)}_${crypto.randomBytes(6).toString('hex')}`;
}

function normalizeProcessIdentity(value: unknown): BrowserProcessIdentity | null {
  const identity = recordValue(value);
  if (
    !value
    || Number(identity.pid) <= 0
    || !Number.isSafeInteger(Number(identity.pid))
    || Number(identity.processGroupId) <= 0
    || !Number.isSafeInteger(Number(identity.processGroupId))
    || !String(identity.startedAt || '').trim()
    || !String(identity.format || '').trim()
  ) return null;
  const configFingerprint = String(identity.configInstanceFingerprint || '').trim();
  return {
    ...(configFingerprint ? { configInstanceFingerprint: configFingerprint } : {}),
    pid: Number(identity.pid),
    processGroupId: Number(identity.processGroupId),
    startedAt: String(identity.startedAt).trim(),
    format: String(identity.format).trim(),
  };
}

function normalizeResource(value: unknown): BrowserResource | null {
  const resource = recordValue(value);
  if (!value || typeof value !== 'object' || !RESOURCE_ID_RE.test(String(resource.id || ''))) {
    return null;
  }
  const projectRootId = String(resource.projectRootId || '').trim();
  const workspace = String(resource.workspace || '').trim();
  if (!projectRootId || !workspace) return null;
  const ownerAgentId = String(resource.ownerAgentId || '').trim();
  const ownerType: BrowserResourceOwnerType = resource.ownerType === 'agent' && ownerAgentId
    ? 'agent'
    : 'project';
  const legacySource = resource.browserKind === 'chrome-extension'
    ? 'extension'
    : resource.browserKind === 'isolated-computer'
      ? 'isolated'
      : 'system';
  return {
    id: String(resource.id),
    projectRootId,
    workspace,
    ownerType,
    ownerAgentId: ownerType === 'agent' ? ownerAgentId : '',
    name: String(resource.name || 'Browser').trim().slice(0, 120) || 'Browser',
    autoName: resource.autoName === true,
    status: isBrowserResourceStatus(resource.status) ? resource.status : 'failed',
    generation: Number.isSafeInteger(resource.generation) && Number(resource.generation) >= 0
      ? Number(resource.generation)
      : 0,
    revision: Number.isSafeInteger(resource.revision) && Number(resource.revision) >= 0
      ? Number(resource.revision)
      : 0,
    url: String(resource.url || 'about:blank').slice(0, 8_192) || 'about:blank',
    title: String(resource.title || '').slice(0, 512),
    browserKind: String(resource.browserKind || ''),
    browserSource: ['extension', 'isolated', 'system'].includes(String(resource.browserSource || ''))
      ? String(resource.browserSource)
      : legacySource,
    browserExecutablePath: String(resource.browserExecutablePath || '').slice(0, 4_096),
    runtimeKind: String(resource.runtimeKind || ''),
    sessionName: SESSION_NAME_RE.test(String(resource.sessionName || '').trim())
      ? String(resource.sessionName).trim()
      : '',
    sessionId: RESOURCE_ID_RE.test(String(resource.sessionId || ''))
      ? String(resource.sessionId)
      : '',
    sessionGeneration: Number.isSafeInteger(resource.sessionGeneration)
      && Number(resource.sessionGeneration) >= 0
      ? Number(resource.sessionGeneration)
      : 0,
    tabId: TAB_ID_RE.test(String(resource.tabId || '')) ? String(resource.tabId) : '',
    error: String(resource.error || '').slice(0, 2_000),
    existingTabId: Number.isSafeInteger(Number(resource.existingTabId))
      && Number(resource.existingTabId) > 0
      ? Number(resource.existingTabId)
      : null,
    processIdentity: normalizeProcessIdentity(resource.processIdentity),
    createdAt: Number.isFinite(resource.createdAt) ? Number(resource.createdAt) : Date.now(),
    updatedAt: Number.isFinite(resource.updatedAt) ? Number(resource.updatedAt) : Date.now(),
  };
}

class BrowserResourceStore {
  readonly directory: string;
  readonly file: string;
  readonly writeJson: WriteJson;
  readonly resources = new Map<string, BrowserResource>();
  revision = 0;

  constructor(configDir: string, options: BrowserResourceStoreOptions = {}) {
    this.directory = browserResourcesDir(configDir);
    this.file = browserResourcesFile(configDir);
    this.writeJson = options.writeJson
      || ((file, value) => atomicWriteJson(file, value, { mode: 0o600 }));
  }

  init(): void {
    fs.mkdirSync(this.directory, { recursive: true });
    let parsed: Record<string, unknown> = {};
    try {
      parsed = recordValue(JSON.parse(fs.readFileSync(this.file, 'utf8')) as unknown);
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') {
        const message = recordValue(error).message;
        console.warn('Failed to read Browser resources:', message || error);
      }
    }
    this.revision = Number.isSafeInteger(parsed.revision) && Number(parsed.revision) >= 0
      ? Number(parsed.revision)
      : 0;
    const resources = Array.isArray(parsed.resources) ? parsed.resources : [];
    for (const value of resources) {
      const resource = normalizeResource(value);
      if (!resource || this.resources.has(resource.id)) continue;
      this.resources.set(resource.id, resource);
    }
    this.commit();
  }

  list(): BrowserResource[] {
    return [...this.resources.values()]
      .map(resource => ({ ...resource }))
      .sort((left, right) => left.createdAt - right.createdAt);
  }

  get(id: string): BrowserResource | null {
    const resource = this.resources.get(id);
    return resource ? { ...resource } : null;
  }

  create(input: BrowserResourceCreateInput): BrowserResource {
    const resource = normalizeResource({
      id: createBrowserId(),
      projectRootId: input.projectRootId,
      workspace: input.workspace,
      ownerType: input.ownerType,
      ownerAgentId: input.ownerAgentId,
      name: input.name || 'Browser',
      autoName: input.autoName === true,
      status: 'stopped',
      generation: 0,
      revision: 0,
      url: input.url || 'about:blank',
      title: '',
      browserKind: '',
      browserSource: input.browserSource,
      browserExecutablePath: input.browserExecutablePath,
      sessionName: input.sessionName || '',
      sessionId: input.sessionId || '',
      sessionGeneration: input.sessionGeneration || 0,
      tabId: input.tabId || '',
      error: '',
      existingTabId: input.existingTabId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    if (!resource) throw new Error('Invalid Browser resource');
    if (resource.sessionName && this.hasSession(resource)) {
      throw new Error(`Browser session already exists: ${resource.sessionName}`);
    }
    this.resources.set(resource.id, resource);
    this.commit();
    return { ...resource };
  }

  createRunningTab(input: RunningBrowserTabInput): BrowserResource {
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

  update(id: string, patch: BrowserResourcePatch): BrowserResource {
    const current = this.resources.get(id);
    if (!current) throw new Error(`Browser resource does not exist: ${id}`);
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
    if (next.sessionName && this.hasSession(next, id)) {
      throw new Error(`Browser session already exists: ${next.sessionName}`);
    }
    this.resources.set(id, next);
    this.commit();
    return { ...next };
  }

  delete(id: string): boolean {
    if (!this.resources.delete(id)) return false;
    this.commit();
    return true;
  }

  hasSession(resource: BrowserResource, exceptId = ''): boolean {
    return [...this.resources.values()].some(candidate => (
      candidate.id !== exceptId
      && candidate.ownerType === resource.ownerType
      && candidate.ownerAgentId === resource.ownerAgentId
      && candidate.projectRootId === resource.projectRootId
      && candidate.sessionName === resource.sessionName
    ));
  }

  commit(): void {
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

export {
  BrowserResourceStore,
  RESOURCE_ID_RE,
  SESSION_NAME_RE,
};
export type {
  BrowserProcessIdentity,
  BrowserResource,
  BrowserResourceCreateInput,
  BrowserResourcePatch,
  RunningBrowserTabInput,
};
