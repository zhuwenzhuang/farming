const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
import { atomicWriteJson } from '../../../backend/atomic-json-store.cjs';
import * as storageLayout from '../../../backend/storage-layout.cjs';

const STORE_VERSION = 1;
const RESOURCE_ID_RE = /^computer_[A-Za-z0-9_-]+$/;
const RESOURCE_STATES = new Set(['stopped', 'starting', 'running', 'stopping', 'failed']);
const CONTROL_OWNERS = new Set(['agent', 'human']);

type ComputerResourceStatus = 'stopped' | 'starting' | 'running' | 'stopping' | 'failed';
type ComputerControlOwner = 'agent' | 'human';

interface ComputerResource {
  id: string;
  ownerAgentId: string;
  projectRootId: string;
  workspace: string;
  name: string;
  status: ComputerResourceStatus;
  generation: number;
  controlOwner: ComputerControlOwner;
  controlEpoch: number;
  needsObserve: boolean;
  containerId: string;
  containerName: string;
  viewerPort: number;
  sessionId: string;
  vncPassword: string;
  error: string;
  createdAt: number;
  updatedAt: number;
  revision: number;
}

interface ComputerStoreFile {
  version: number;
  revision: number;
  resources: ComputerResource[];
}

function integer(value: unknown, fallback = 0): number {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : fallback;
}

function cleanString(value: unknown, maxLength = 4096): string {
  return String(value || '').trim().slice(0, maxLength);
}

function normalizeResource(value: unknown): ComputerResource | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const resource = value as Partial<ComputerResource>;
  const id = cleanString(resource.id, 160);
  const ownerAgentId = cleanString(resource.ownerAgentId, 240);
  const projectRootId = cleanString(resource.projectRootId, 240);
  const workspace = cleanString(resource.workspace);
  if (!RESOURCE_ID_RE.test(id) || !ownerAgentId || !projectRootId || !workspace) return null;
  const status = RESOURCE_STATES.has(String(resource.status))
    ? resource.status as ComputerResourceStatus
    : 'stopped';
  const controlOwner = CONTROL_OWNERS.has(String(resource.controlOwner))
    ? resource.controlOwner as ComputerControlOwner
    : 'agent';
  return {
    id,
    ownerAgentId,
    projectRootId,
    workspace: path.resolve(workspace),
    name: cleanString(resource.name, 120) || 'Desktop',
    status,
    generation: integer(resource.generation),
    controlOwner,
    controlEpoch: integer(resource.controlEpoch),
    needsObserve: resource.needsObserve === true,
    containerId: cleanString(resource.containerId, 160),
    containerName: cleanString(resource.containerName, 160),
    viewerPort: integer(resource.viewerPort),
    sessionId: cleanString(resource.sessionId, 240),
    vncPassword: cleanString(resource.vncPassword, 64),
    error: cleanString(resource.error),
    createdAt: integer(resource.createdAt, Date.now()),
    updatedAt: integer(resource.updatedAt, Date.now()),
    revision: integer(resource.revision),
  };
}

function publicResource(resource: ComputerResource, collectionRevision: number) {
  const { vncPassword: _password, ...safe } = resource;
  return { ...safe, collectionRevision };
}

class ComputerResourceStore {
  readonly directory: string;
  readonly file: string;
  revision = 0;
  resources = new Map<string, ComputerResource>();

  constructor(configDir: string) {
    this.directory = storageLayout.computerResourcesDir(configDir);
    this.file = storageLayout.computerResourcesFile(configDir);
  }

  init(): void {
    fs.mkdirSync(this.directory, { recursive: true });
    if (!fs.existsSync(this.file)) {
      this.persist();
      return;
    }
    const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<ComputerStoreFile>;
    this.revision = integer(raw.revision);
    const resources = Array.isArray(raw.resources) ? raw.resources : [];
    this.resources = new Map(resources.flatMap(value => {
      const resource = normalizeResource(value);
      return resource ? [[resource.id, resource]] : [];
    }));
    this.persist();
  }

  list(): ComputerResource[] {
    return [...this.resources.values()].sort((left, right) => left.createdAt - right.createdAt);
  }

  get(id: string): ComputerResource | null {
    return this.resources.get(id) || null;
  }

  create(input: Pick<ComputerResource, 'ownerAgentId' | 'projectRootId' | 'workspace'> & {
    name?: string;
  }): ComputerResource {
    const now = Date.now();
    const id = `computer_${crypto.randomUUID().replace(/-/g, '')}`;
    const resource: ComputerResource = {
      id,
      ownerAgentId: input.ownerAgentId,
      projectRootId: input.projectRootId,
      workspace: path.resolve(input.workspace),
      name: cleanString(input.name, 120) || 'Desktop',
      status: 'stopped',
      generation: 0,
      controlOwner: 'agent',
      controlEpoch: 0,
      needsObserve: false,
      containerId: '',
      containerName: '',
      viewerPort: 0,
      sessionId: '',
      vncPassword: '',
      error: '',
      createdAt: now,
      updatedAt: now,
      revision: 0,
    };
    this.resources.set(id, resource);
    return this.commit(resource);
  }

  patch(id: string, patch: Partial<ComputerResource>): ComputerResource {
    const current = this.resources.get(id);
    if (!current) throw Object.assign(new Error('Computer Resource was not found'), {
      status: 404,
      code: 'COMPUTER_NOT_FOUND',
    });
    Object.assign(current, patch);
    return this.commit(current);
  }

  remove(id: string): ComputerResource | null {
    const current = this.resources.get(id) || null;
    if (!current) return null;
    this.resources.delete(id);
    this.revision += 1;
    this.persist();
    return current;
  }

  snapshot() {
    return {
      collectionRevision: this.revision,
      resources: this.list().map(resource => publicResource(resource, this.revision)),
    };
  }

  commit(resource: ComputerResource): ComputerResource {
    this.revision += 1;
    resource.revision += 1;
    resource.updatedAt = Date.now();
    this.resources.set(resource.id, resource);
    this.persist();
    return resource;
  }

  persist(): void {
    const value: ComputerStoreFile = {
      version: STORE_VERSION,
      revision: this.revision,
      resources: this.list(),
    };
    atomicWriteJson(this.file, value);
  }
}

export {
  ComputerResourceStore,
  RESOURCE_ID_RE,
  publicResource,
};
