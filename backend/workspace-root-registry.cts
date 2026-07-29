const fs = require('fs');
const os = require('os');
const path = require('path');
const { WorkspaceFileError } = require('./workspace-file-service.cjs');

const GLOBAL_WORKSPACE_FILES_AGENT_ID = '__farming_global_files__';
const GLOBAL_WORKSPACE_ROOT_ID = 'wroot_global';
const GLOBAL_WORKSPACE_FILES_ROOT = '/';
const PROJECT_FILES_WORKSPACE_PREFIX = '__farming_project__:';

interface WorkspaceAccessPolicy {
  externalReads: boolean;
  readOnly: boolean;
  watch: boolean;
}

interface WorkspaceRoot {
  accessPolicy: Readonly<WorkspaceAccessPolicy>;
  canonicalPath: string;
  kind: string;
  repositoryId: string;
  rootId: string;
}

interface WorkspaceRootOptions {
  accessPolicy?: Partial<WorkspaceAccessPolicy>;
  canonicalPath?: unknown;
  kind?: string;
  repositoryId?: string;
  rootId?: string;
}

interface WorkspaceRootAgentManager {
  configManager?: {
    getSettings?(): unknown;
  };
  getAgentWorkspaceRoot?(agentId: string): unknown;
  getState?(): unknown;
}

interface LiveAgentPath {
  agentId: string;
  path: string;
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object'
    ? value as Record<string, unknown>
    : {};
}

function normalizeWorkspacePath(value: unknown): string {
  const raw = String(value || '').trim();
  if (!raw) return '';
  return path.resolve(raw.replace(/^~(?=$|[\\/])/, os.homedir()));
}

function canonicalWorkspacePath(value: unknown): string {
  const normalized = normalizeWorkspacePath(value);
  if (!normalized) return '';
  try {
    return fs.realpathSync(normalized);
  } catch {
    return normalized;
  }
}

function rootIdForPath(value: unknown): string {
  const canonicalPath = canonicalWorkspacePath(value);
  if (!canonicalPath) return '';
  if (canonicalPath === GLOBAL_WORKSPACE_FILES_ROOT) return GLOBAL_WORKSPACE_ROOT_ID;
  let hash = 0xcbf29ce484222325n;
  for (const byte of Buffer.from(canonicalPath, 'utf8')) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return `wroot_${hash.toString(16).padStart(16, '0')}`;
}

function projectWorkspaceFromLegacyRef(ref: unknown): string {
  const value = String(ref || '');
  if (!value.startsWith(PROJECT_FILES_WORKSPACE_PREFIX)) return '';
  try {
    return normalizeWorkspacePath(decodeURIComponent(value.slice(PROJECT_FILES_WORKSPACE_PREFIX.length)));
  } catch {
    return '';
  }
}

function workspaceRootSnapshot(root: WorkspaceRoot): WorkspaceRoot {
  return {
    rootId: root.rootId,
    kind: root.kind,
    canonicalPath: root.canonicalPath,
    repositoryId: root.repositoryId || '',
    accessPolicy: { ...root.accessPolicy },
  };
}

class WorkspaceRootRegistry {
  private readonly agentManager: WorkspaceRootAgentManager | null | undefined;
  private readonly roots = new Map<string, WorkspaceRoot>();

  constructor(agentManager?: WorkspaceRootAgentManager | null) {
    this.agentManager = agentManager;
    this.register({
      rootId: GLOBAL_WORKSPACE_ROOT_ID,
      kind: 'global',
      canonicalPath: GLOBAL_WORKSPACE_FILES_ROOT,
      accessPolicy: { readOnly: true, watch: false, externalReads: false },
    });
  }

  register(options: WorkspaceRootOptions = {}): WorkspaceRoot {
    const canonicalPath = options.rootId === GLOBAL_WORKSPACE_ROOT_ID
      ? GLOBAL_WORKSPACE_FILES_ROOT
      : canonicalWorkspacePath(options.canonicalPath);
    if (!canonicalPath) throw new WorkspaceFileError('workspace root path is required', 400);
    const rootId = options.rootId || rootIdForPath(canonicalPath);
    const current = this.roots.get(rootId);
    if (current && current.canonicalPath !== canonicalPath) {
      throw new WorkspaceFileError('workspace root identity collision', 409);
    }
    const isGlobalRoot = rootId === GLOBAL_WORKSPACE_ROOT_ID;
    const root: WorkspaceRoot = Object.freeze({
      rootId,
      kind: isGlobalRoot ? 'global' : (options.kind || current?.kind || 'directory'),
      canonicalPath,
      repositoryId: options.repositoryId || current?.repositoryId || '',
      accessPolicy: Object.freeze({
        readOnly: isGlobalRoot || options.accessPolicy?.readOnly === true,
        watch: isGlobalRoot ? false : options.accessPolicy?.watch !== false,
        externalReads: isGlobalRoot ? false : options.accessPolicy?.externalReads !== false,
      }),
    });
    this.roots.set(rootId, root);
    return root;
  }

  configuredProjectPaths(): string[] {
    const settings = recordValue(this.agentManager?.configManager?.getSettings?.());
    return (Array.isArray(settings.projectWorkspaces) ? settings.projectWorkspaces : [])
      .map(normalizeWorkspacePath)
      .filter(Boolean);
  }

  liveAgentPaths(): LiveAgentPath[] {
    const state = recordValue(this.agentManager?.getState?.());
    const agents = Array.isArray(state.agents) ? state.agents : [];
    return agents.map(recordValue).filter(agent => !agent.isMain).map(agent => {
      const worktree = recordValue(agent.gitWorktree);
      return {
        agentId: String(agent.id || ''),
        path: normalizeWorkspacePath(agent.projectWorkspace || worktree.workspace || agent.cwd),
      };
    }).filter(entry => Boolean(entry.agentId && entry.path));
  }

  refresh(): void {
    const activeRootIds = new Set([GLOBAL_WORKSPACE_ROOT_ID]);
    for (const projectPath of this.configuredProjectPaths()) {
      activeRootIds.add(this.register({ kind: 'directory', canonicalPath: projectPath }).rootId);
    }
    for (const entry of this.liveAgentPaths()) {
      activeRootIds.add(this.register({ kind: 'directory', canonicalPath: entry.path }).rootId);
    }
    for (const rootId of this.roots.keys()) {
      if (!activeRootIds.has(rootId)) this.roots.delete(rootId);
    }
  }

  resolve(ref: unknown): WorkspaceRoot {
    const value = String(ref || '').trim();
    if (!value) throw new WorkspaceFileError('rootId is required', 400);
    if (value === GLOBAL_WORKSPACE_ROOT_ID || value === GLOBAL_WORKSPACE_FILES_AGENT_ID) {
      return this.roots.get(GLOBAL_WORKSPACE_ROOT_ID) as WorkspaceRoot;
    }

    this.refresh();
    const registered = this.roots.get(value);
    if (registered) return registered;

    const projectPath = projectWorkspaceFromLegacyRef(value);
    if (projectPath) {
      const authorized = this.configuredProjectPaths().includes(projectPath)
        || this.liveAgentPaths().some(entry => entry.path === projectPath);
      if (!authorized) throw new WorkspaceFileError('project not found', 404);
      return this.register({ kind: 'directory', canonicalPath: projectPath });
    }

    const agentPath = this.liveAgentPaths().find(entry => entry.agentId === value)?.path
      || normalizeWorkspacePath(this.agentManager?.getAgentWorkspaceRoot?.(value));
    if (agentPath) return this.register({ kind: 'directory', canonicalPath: agentPath });
    throw new WorkspaceFileError(value.startsWith('wroot_') ? 'workspace root not found' : 'agent not found', 404);
  }

  list(): WorkspaceRoot[] {
    this.refresh();
    return [...this.roots.values()].map(workspaceRootSnapshot);
  }
}

export {
  GLOBAL_WORKSPACE_FILES_AGENT_ID,
  GLOBAL_WORKSPACE_FILES_ROOT,
  GLOBAL_WORKSPACE_ROOT_ID,
  PROJECT_FILES_WORKSPACE_PREFIX,
  WorkspaceRootRegistry,
  canonicalWorkspacePath,
  projectWorkspaceFromLegacyRef,
  rootIdForPath,
  workspaceRootSnapshot,
};
