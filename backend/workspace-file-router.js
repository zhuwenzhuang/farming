const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { inspectGitWorktree } = require('./git-worktree-info');
const { WorkspaceFileError } = require('./workspace-file-service');
const {
  GLOBAL_WORKSPACE_FILES_AGENT_ID,
  GLOBAL_WORKSPACE_FILES_ROOT,
  GLOBAL_WORKSPACE_ROOT_ID,
  PROJECT_FILES_WORKSPACE_PREFIX,
  WorkspaceRootRegistry,
  projectWorkspaceFromLegacyRef,
} = require('./workspace-root-registry');

const ROOT_REGISTRIES = new WeakMap();

function isGlobalWorkspaceFilesAgentId(agentId) {
  return agentId === GLOBAL_WORKSPACE_FILES_AGENT_ID || agentId === GLOBAL_WORKSPACE_ROOT_ID;
}

function projectWorkspaceFromFilesId(filesId) {
  return projectWorkspaceFromLegacyRef(filesId);
}

function workspaceRootRegistryFor(agentManager) {
  let registry = ROOT_REGISTRIES.get(agentManager);
  if (!registry) {
    registry = new WorkspaceRootRegistry(agentManager);
    ROOT_REGISTRIES.set(agentManager, registry);
  }
  return registry;
}

function workspaceRef(source) {
  return source && typeof source.rootId === 'string' && source.rootId.trim()
    ? source.rootId
    : source?.agentId;
}

function normalizeAbsolutePath(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  return path.resolve(raw.replace(/^~(?=$|[\\/])/, os.homedir()));
}

function realPathIfPresent(value) {
  try {
    return fs.realpathSync(value);
  } catch {
    return value;
  }
}

function isSameOrDescendantPath(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function globalUserPathToAbsolute(userPath = '') {
  const normalized = String(userPath || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\/+/, '');
  return path.resolve(GLOBAL_WORKSPACE_FILES_ROOT, normalized || '.');
}

function relativeGlobalPath(absolutePath) {
  const relative = path.relative(GLOBAL_WORKSPACE_FILES_ROOT, absolutePath);
  return relative === '' ? '' : relative.replace(/\\/g, '/');
}

function collectCandidateAllowedRoots(agentManager) {
  const roots = [os.homedir()];
  const state = agentManager && typeof agentManager.getState === 'function'
    ? agentManager.getState()
    : {};
  for (const agent of state.agents || []) {
    roots.push(agent && agent.projectWorkspace);
    roots.push(agent && agent.cwd);
    roots.push(agent && agent.gitWorktree && agent.gitWorktree.workspace);
  }
  for (const entry of state.taskHistory || []) {
    roots.push(entry && entry.projectWorkspace);
    roots.push(entry && entry.cwd);
  }

  const configManager = agentManager && agentManager.configManager;
  const settings = configManager && typeof configManager.getSettings === 'function'
    ? configManager.getSettings()
    : null;
  if (settings) {
    roots.push(...(Array.isArray(settings.workspaceHistory) ? settings.workspaceHistory : []));
    roots.push(...(Array.isArray(settings.projectWorkspaces) ? settings.projectWorkspaces : []));
  }
  return roots;
}

function globalWorkspaceAllowedRoots(agentManager) {
  const seen = new Set();
  return collectCandidateAllowedRoots(agentManager)
    .map(normalizeAbsolutePath)
    .filter(Boolean)
    .map(realPathIfPresent)
    .filter(root => {
      if (root === path.parse(root).root) return false;
      if (seen.has(root)) return false;
      seen.add(root);
      return true;
    });
}

function assertGlobalWorkspacePathAllowed(agentManager, userPath, options = {}) {
  const allowedRoots = globalWorkspaceAllowedRoots(agentManager);
  const requestedTarget = globalUserPathToAbsolute(userPath);
  if (!allowedRoots.length) {
    throw new WorkspaceFileError('global files have no allowed roots', 403);
  }

  if (options.allowAllowedRootAncestor === true) {
    const isAllowedRootAncestor = allowedRoots.some(root => isSameOrDescendantPath(requestedTarget, root));
    if (isAllowedRootAncestor) return { target: requestedTarget, allowedRoots };
  }

  const allowed = allowedRoots.some(root => {
    if (options.allowMissing === true) {
      const realParent = realPathIfPresent(path.dirname(requestedTarget));
      return isSameOrDescendantPath(root, requestedTarget) && isSameOrDescendantPath(root, realParent);
    }
    const realTarget = realPathIfPresent(requestedTarget);
    return isSameOrDescendantPath(root, realTarget);
  });
  if (!allowed) {
    throw new WorkspaceFileError('global file path is outside allowed workspaces', 403);
  }
  return { target: requestedTarget, allowedRoots };
}

function globalSyntheticTree(agentManager, userPath = '') {
  const { target, allowedRoots } = assertGlobalWorkspacePathAllowed(agentManager, userPath, {
    allowAllowedRootAncestor: true,
  });
  const children = new Map();
  for (const root of allowedRoots) {
    if (!isSameOrDescendantPath(target, root) || target === root) continue;
    const relative = path.relative(target, root);
    const first = relative.split(path.sep).filter(Boolean)[0];
    if (!first) continue;
    const childAbsolute = path.join(target, first);
    children.set(first, {
      name: first,
      path: relativeGlobalPath(childAbsolute),
      type: 'directory',
      size: 0,
      mtimeMs: 0,
    });
  }
  return {
    path: relativeGlobalPath(target),
    items: Array.from(children.values()).sort((a, b) => a.name.localeCompare(b.name)),
    gitStatusPending: false,
  };
}

async function listGlobalWorkspaceTree(agentManager, fileService, userPath = '') {
  const { target, allowedRoots } = assertGlobalWorkspacePathAllowed(agentManager, userPath, {
    allowAllowedRootAncestor: true,
  });
  const insideAllowedRoot = allowedRoots.some(root => isSameOrDescendantPath(root, realPathIfPresent(target)));
  if (!insideAllowedRoot) {
    return globalSyntheticTree(agentManager, userPath);
  }
  return fileService.listTree(GLOBAL_WORKSPACE_FILES_ROOT, userPath || '');
}

function sendWorkspaceFileError(res, error) {
  if (error instanceof WorkspaceFileError) {
    res.status(error.statusCode).json({
      error: error.message,
      ...(Object.keys(error.details || {}).length > 0 ? { details: error.details } : {}),
    });
    return;
  }

  console.error('Workspace file API error:', error);
  res.status(500).json({ error: 'workspace file operation failed' });
}

function resolveWorkspaceRoot(agentManager, rootRef) {
  return workspaceRootRegistryFor(agentManager).resolve(rootRef).canonicalPath;
}

function assertWritableWorkspaceAgent(agentId) {
  if (isGlobalWorkspaceFilesAgentId(agentId)) {
    throw new WorkspaceFileError('global files are read-only', 403);
  }
}

function readOptionsForAgent(agentManager, agentId) {
  return isGlobalWorkspaceFilesAgentId(agentId)
    ? {}
    : { allowedExternalRoots: globalWorkspaceAllowedRoots(agentManager) };
}

function createWorkspaceFileRouter(agentManager, fileService, options = {}) {
  const router = express.Router();
  const rootRegistry = options.rootRegistry || workspaceRootRegistryFor(agentManager);

  router.use(express.json({ limit: '3mb' }));

  router.get('/roots', (_req, res) => {
    res.json({ roots: rootRegistry.list() });
  });

  const resolveRequestRoot = source => {
    const workspaceRoot = rootRegistry.resolve(workspaceRef(source));
    return { root: workspaceRoot.canonicalPath, rootId: workspaceRoot.rootId };
  };

  router.get('/tree', async (req, res) => {
    try {
      const rootRef = workspaceRef(req.query);
      const { root, rootId } = resolveRequestRoot(req.query);
      const tree = isGlobalWorkspaceFilesAgentId(rootRef)
        ? await listGlobalWorkspaceTree(agentManager, fileService, req.query.path || '')
        : await fileService.listTree(root, req.query.path || '', readOptionsForAgent(agentManager, rootRef));
      res.json({ rootId, root, tree });
    } catch (error) {
      sendWorkspaceFileError(res, error);
    }
  });

  router.get('/file', async (req, res) => {
    try {
      const rootRef = workspaceRef(req.query);
      if (isGlobalWorkspaceFilesAgentId(rootRef)) {
        assertGlobalWorkspacePathAllowed(agentManager, req.query.path || '');
      }
      const { root, rootId } = resolveRequestRoot(req.query);
      const file = await fileService.readFile(root, req.query.path || '', readOptionsForAgent(agentManager, rootRef));
      res.json({ rootId, root, file });
    } catch (error) {
      sendWorkspaceFileError(res, error);
    }
  });

  router.get('/raw', async (req, res) => {
    try {
      const rootRef = workspaceRef(req.query);
      if (isGlobalWorkspaceFilesAgentId(rootRef)) {
        assertGlobalWorkspacePathAllowed(agentManager, req.query.path || '');
      }
      const { root } = resolveRequestRoot(req.query);
      const file = await fileService.readPreviewFile(root, req.query.path || '', readOptionsForAgent(agentManager, rootRef));
      res
        .status(200)
        .type(file.preview.mediaType)
        .set('Cache-Control', 'no-store')
        .set('X-Content-Type-Options', 'nosniff')
        .set('Content-Length', String(file.size))
        .send(file.buffer);
    } catch (error) {
      sendWorkspaceFileError(res, error);
    }
  });

  router.put('/file', async (req, res) => {
    try {
      const body = req.body || {};
      const rootRef = workspaceRef(body);
      assertWritableWorkspaceAgent(rootRef);
      const { root, rootId } = resolveRequestRoot(body);
      const file = await fileService.writeFile(root, body.path || '', body.content, {
        baseSha1: body.baseSha1,
        overwrite: body.overwrite === true,
      });
      res.json({ rootId, root, file });
    } catch (error) {
      sendWorkspaceFileError(res, error);
    }
  });

  router.post('/move', async (req, res) => {
    try {
      const body = req.body || {};
      const rootRef = workspaceRef(body);
      assertWritableWorkspaceAgent(rootRef);
      const { root, rootId } = resolveRequestRoot(body);
      const move = await fileService.moveEntry(root, body.sourcePath || '', body.targetDirectory || '');
      res.json({ rootId, root, move });
    } catch (error) {
      sendWorkspaceFileError(res, error);
    }
  });

  router.post('/entry', async (req, res) => {
    try {
      const body = req.body || {};
      const rootRef = workspaceRef(body);
      assertWritableWorkspaceAgent(rootRef);
      const { root, rootId } = resolveRequestRoot(body);
      const created = await fileService.createEntry(root, body.parentPath || '', body.name || '', body.entryType || 'file', body.content || '');
      res.status(201).json({ rootId, root, ...created });
    } catch (error) {
      sendWorkspaceFileError(res, error);
    }
  });

  router.patch('/entry', async (req, res) => {
    try {
      const body = req.body || {};
      const rootRef = workspaceRef(body);
      assertWritableWorkspaceAgent(rootRef);
      const { root, rootId } = resolveRequestRoot(body);
      const move = await fileService.renameEntry(root, body.path || '', body.name || '');
      res.json({ rootId, root, move });
    } catch (error) {
      sendWorkspaceFileError(res, error);
    }
  });

  router.delete('/entry', async (req, res) => {
    try {
      const body = req.body || {};
      const rootRef = workspaceRef(body) || workspaceRef(req.query);
      const targetPath = body.path || req.query.path || '';
      assertWritableWorkspaceAgent(rootRef);
      const workspaceRoot = rootRegistry.resolve(rootRef);
      const { canonicalPath: root, rootId } = workspaceRoot;
      const deleted = await fileService.deleteEntry(root, targetPath);
      res.json({ rootId, root, deleted });
    } catch (error) {
      sendWorkspaceFileError(res, error);
    }
  });

  router.get('/search', async (req, res) => {
    try {
      const rootRef = workspaceRef(req.query);
      if (isGlobalWorkspaceFilesAgentId(rootRef)) {
        assertGlobalWorkspacePathAllowed(agentManager, req.query.path || '');
      }
      const { root, rootId } = resolveRequestRoot(req.query);
      const settings = agentManager?.configManager?.getSettings?.() || {};
      const results = await fileService.search(root, req.query.q || '', {
        includeIgnored: req.query.includeIgnored === 'true',
        path: req.query.path || '',
        limit: req.query.limit,
        timeoutMs: settings.searchTimeoutMs,
      });
      res.json({ rootId, root, results });
    } catch (error) {
      sendWorkspaceFileError(res, error);
    }
  });

  router.get('/diff', async (req, res) => {
    try {
      const rootRef = workspaceRef(req.query);
      if (isGlobalWorkspaceFilesAgentId(rootRef)) {
        assertGlobalWorkspacePathAllowed(agentManager, req.query.path || '', { allowMissing: true });
      }
      const { root, rootId } = resolveRequestRoot(req.query);
      const diff = await fileService.diff(root, req.query.path || '');
      res.json({ rootId, root, diff });
    } catch (error) {
      sendWorkspaceFileError(res, error);
    }
  });

  router.get('/changes', async (req, res) => {
    try {
      const rootRef = workspaceRef(req.query);
      if (isGlobalWorkspaceFilesAgentId(rootRef)) {
        throw new WorkspaceFileError('global files do not support workspace changes', 403);
      }
      const { root, rootId } = resolveRequestRoot(req.query);
      const changes = await fileService.changes(root, {
        limit: req.query.limit,
      });
      res.json({ rootId, root, changes });
    } catch (error) {
      sendWorkspaceFileError(res, error);
    }
  });

  router.get('/branch', async (req, res) => {
    try {
      const rootRef = workspaceRef(req.query);
      if (isGlobalWorkspaceFilesAgentId(rootRef)) {
        throw new WorkspaceFileError('global files do not support git branches', 403);
      }
      const { root, rootId } = resolveRequestRoot(req.query);
      const branch = await fileService.gitBranch(root);
      res.json({ rootId, root, branch });
    } catch (error) {
      sendWorkspaceFileError(res, error);
    }
  });

  router.get('/worktrees', async (req, res) => {
    try {
      const rootRef = workspaceRef(req.query);
      if (isGlobalWorkspaceFilesAgentId(rootRef)) {
        throw new WorkspaceFileError('global files do not support git worktrees', 403);
      }
      const { root, rootId } = resolveRequestRoot(req.query);
      const info = await inspectGitWorktree(root, { cacheMs: 0 });
      res.json({
        rootId,
        root,
        worktrees: info
          ? {
            isGitRepo: true,
            commonDir: info.commonDir,
            currentWorkspace: info.workspace,
            mainWorkspace: info.mainWorkspace,
            items: info.worktrees,
          }
          : {
            isGitRepo: false,
            commonDir: '',
            currentWorkspace: root,
            mainWorkspace: '',
            items: [],
          },
      });
    } catch (error) {
      sendWorkspaceFileError(res, error);
    }
  });

  router.get('/history', async (req, res) => {
    try {
      const rootRef = workspaceRef(req.query);
      if (isGlobalWorkspaceFilesAgentId(rootRef)) {
        throw new WorkspaceFileError('global files do not support git history', 403);
      }
      const { root, rootId } = resolveRequestRoot(req.query);
      const history = await fileService.gitHistory(root, {
        limit: req.query.limit,
        skip: req.query.skip,
        scope: req.query.scope,
      });
      res.json({ rootId, root, history });
    } catch (error) {
      sendWorkspaceFileError(res, error);
    }
  });

  router.get('/history/changes', async (req, res) => {
    try {
      const rootRef = workspaceRef(req.query);
      if (isGlobalWorkspaceFilesAgentId(rootRef)) {
        throw new WorkspaceFileError('global files do not support git history', 403);
      }
      const { root, rootId } = resolveRequestRoot(req.query);
      const changes = await fileService.gitHistoryChanges(
        root,
        req.query.commit,
        req.query.parent,
        { limit: req.query.limit }
      );
      res.json({ rootId, root, changes });
    } catch (error) {
      sendWorkspaceFileError(res, error);
    }
  });

  router.get('/line-changes', async (req, res) => {
    try {
      const rootRef = workspaceRef(req.query);
      if (isGlobalWorkspaceFilesAgentId(rootRef)) {
        assertGlobalWorkspacePathAllowed(agentManager, req.query.path || '');
      }
      const { root, rootId } = resolveRequestRoot(req.query);
      const changes = await fileService.lineChanges(
        root,
        req.query.path || '',
        req.query.lineNumber,
        req.query.mode || 'working'
      );
      res.json({ rootId, root, changes });
    } catch (error) {
      sendWorkspaceFileError(res, error);
    }
  });

  router.get('/blame', async (req, res) => {
    try {
      const rootRef = workspaceRef(req.query);
      if (isGlobalWorkspaceFilesAgentId(rootRef)) {
        assertGlobalWorkspacePathAllowed(agentManager, req.query.path || '');
      }
      const { root, rootId } = resolveRequestRoot(req.query);
      const blame = await fileService.blame(root, req.query.path || '');
      res.json({ rootId, root, blame });
    } catch (error) {
      sendWorkspaceFileError(res, error);
    }
  });

  router.get('/blame-capability', async (req, res) => {
    try {
      const rootRef = workspaceRef(req.query);
      if (isGlobalWorkspaceFilesAgentId(rootRef)) {
        assertGlobalWorkspacePathAllowed(agentManager, req.query.path || '');
      }
      const { root, rootId } = resolveRequestRoot(req.query);
      const capability = await fileService.blameCapability(
        root,
        req.query.path || '',
        readOptionsForAgent(agentManager, rootRef)
      );
      res.json({ rootId, root, capability });
    } catch (error) {
      sendWorkspaceFileError(res, error);
    }
  });

  return router;
}

module.exports = {
  GLOBAL_WORKSPACE_FILES_AGENT_ID,
  GLOBAL_WORKSPACE_FILES_ROOT,
  PROJECT_FILES_WORKSPACE_PREFIX,
  PROJECT_FILES_AGENT_PREFIX: PROJECT_FILES_WORKSPACE_PREFIX,
  assertGlobalWorkspacePathAllowed,
  createWorkspaceFileRouter,
  globalWorkspaceAllowedRoots,
  isGlobalWorkspaceFilesAgentId,
  projectWorkspaceFromFilesId,
  projectWorkspaceFromFilesAgentId: projectWorkspaceFromFilesId,
  resolveWorkspaceRoot,
  sendWorkspaceFileError,
};
