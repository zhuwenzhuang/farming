const fs = require('fs');
const os = require('os');
const path = require('path');
const { WorkspaceFileError } = require('./workspace-file-service');

const GLOBAL_WORKSPACE_FILES_AGENT_ID = '__farming_global_files__';
const GLOBAL_WORKSPACE_ROOT_ID = 'wroot_global';
const GLOBAL_WORKSPACE_FILES_ROOT = '/';
const PROJECT_FILES_WORKSPACE_PREFIX = '__farming_project__:';

function normalizeWorkspacePath(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  return path.resolve(raw.replace(/^~(?=$|[\\/])/, os.homedir()));
}

function canonicalWorkspacePath(value) {
  const normalized = normalizeWorkspacePath(value);
  if (!normalized) return '';
  try {
    return fs.realpathSync(normalized);
  } catch {
    return normalized;
  }
}

function rootIdForPath(value) {
  const canonicalPath = canonicalWorkspacePath(value);
  if (!canonicalPath) return '';
  let hash = 0xcbf29ce484222325n;
  for (const byte of Buffer.from(canonicalPath, 'utf8')) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return `wroot_${hash.toString(16).padStart(16, '0')}`;
}

function projectWorkspaceFromLegacyRef(ref) {
  const value = String(ref || '');
  if (!value.startsWith(PROJECT_FILES_WORKSPACE_PREFIX)) return '';
  try {
    return normalizeWorkspacePath(decodeURIComponent(value.slice(PROJECT_FILES_WORKSPACE_PREFIX.length)));
  } catch {
    return '';
  }
}

function workspaceRootSnapshot(root) {
  return {
    rootId: root.rootId,
    kind: root.kind,
    canonicalPath: root.canonicalPath,
    repositoryId: root.repositoryId || '',
    accessPolicy: { ...root.accessPolicy },
  };
}

class WorkspaceRootRegistry {
  constructor(agentManager) {
    this.agentManager = agentManager;
    this.roots = new Map();
    this.register({
      rootId: GLOBAL_WORKSPACE_ROOT_ID,
      kind: 'global',
      canonicalPath: GLOBAL_WORKSPACE_FILES_ROOT,
      accessPolicy: { readOnly: true, watch: false, externalReads: false },
    });
  }

  register(options = {}) {
    const canonicalPath = options.rootId === GLOBAL_WORKSPACE_ROOT_ID
      ? GLOBAL_WORKSPACE_FILES_ROOT
      : canonicalWorkspacePath(options.canonicalPath);
    if (!canonicalPath) throw new WorkspaceFileError('workspace root path is required', 400);
    const rootId = options.rootId || rootIdForPath(canonicalPath);
    const current = this.roots.get(rootId);
    if (current && current.canonicalPath !== canonicalPath) {
      throw new WorkspaceFileError('workspace root identity collision', 409);
    }
    const root = Object.freeze({
      rootId,
      kind: options.kind || current?.kind || 'directory',
      canonicalPath,
      repositoryId: options.repositoryId || current?.repositoryId || '',
      accessPolicy: Object.freeze({
        readOnly: options.accessPolicy?.readOnly === true,
        watch: options.accessPolicy?.watch !== false,
        externalReads: options.accessPolicy?.externalReads !== false,
      }),
    });
    this.roots.set(rootId, root);
    return root;
  }

  configuredProjectPaths() {
    const settings = this.agentManager?.configManager?.getSettings?.() || {};
    return (Array.isArray(settings.projectWorkspaces) ? settings.projectWorkspaces : [])
      .map(normalizeWorkspacePath)
      .filter(Boolean);
  }

  liveAgentPaths() {
    const state = this.agentManager?.getState?.() || { agents: [] };
    return (state.agents || []).filter(agent => agent && !agent.isMain).map(agent => ({
      agentId: agent.id,
      path: normalizeWorkspacePath(agent.projectWorkspace || agent.gitWorktree?.workspace || agent.cwd),
    })).filter(entry => entry.path);
  }

  refresh() {
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

  resolve(ref) {
    const value = String(ref || '').trim();
    if (!value) throw new WorkspaceFileError('rootId is required', 400);
    if (value === GLOBAL_WORKSPACE_ROOT_ID || value === GLOBAL_WORKSPACE_FILES_AGENT_ID) {
      return this.roots.get(GLOBAL_WORKSPACE_ROOT_ID);
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

  list() {
    this.refresh();
    return [...this.roots.values()].map(workspaceRootSnapshot);
  }
}

module.exports = {
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
