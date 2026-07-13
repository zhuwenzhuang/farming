const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { WorkspaceFileError } = require('./workspace-file-service');

const GLOBAL_WORKSPACE_FILES_AGENT_ID = '__farming_global_files__';
const GLOBAL_WORKSPACE_FILES_ROOT = '/';

function isGlobalWorkspaceFilesAgentId(agentId) {
  return agentId === GLOBAL_WORKSPACE_FILES_AGENT_ID;
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

function resolveWorkspaceRoot(agentManager, agentId) {
  if (typeof agentId !== 'string' || !agentId.trim()) {
    throw new WorkspaceFileError('agentId is required', 400);
  }

  if (isGlobalWorkspaceFilesAgentId(agentId)) {
    return GLOBAL_WORKSPACE_FILES_ROOT;
  }

  if (agentManager && typeof agentManager.getAgentWorkspaceRoot === 'function') {
    const root = agentManager.getAgentWorkspaceRoot(agentId);
    if (root) return root;
  }

  const state = agentManager && typeof agentManager.getState === 'function'
    ? agentManager.getState()
    : { agents: [] };
  const agent = (state.agents || []).find(candidate => candidate.id === agentId);
  if (!agent) {
    throw new WorkspaceFileError('agent not found', 404);
  }

  return agent.projectWorkspace || agent.cwd;
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

function createWorkspaceFileRouter(agentManager, fileService) {
  const router = express.Router();

  router.use(express.json({ limit: '3mb' }));

  router.get('/tree', async (req, res) => {
    try {
      const root = resolveWorkspaceRoot(agentManager, req.query.agentId);
      const tree = isGlobalWorkspaceFilesAgentId(req.query.agentId)
        ? await listGlobalWorkspaceTree(agentManager, fileService, req.query.path || '')
        : await fileService.listTree(root, req.query.path || '', readOptionsForAgent(agentManager, req.query.agentId));
      res.json({ root, tree });
    } catch (error) {
      sendWorkspaceFileError(res, error);
    }
  });

  router.get('/file', async (req, res) => {
    try {
      if (isGlobalWorkspaceFilesAgentId(req.query.agentId)) {
        assertGlobalWorkspacePathAllowed(agentManager, req.query.path || '');
      }
      const root = resolveWorkspaceRoot(agentManager, req.query.agentId);
      const file = await fileService.readFile(root, req.query.path || '', readOptionsForAgent(agentManager, req.query.agentId));
      res.json({ root, file });
    } catch (error) {
      sendWorkspaceFileError(res, error);
    }
  });

  router.get('/raw', async (req, res) => {
    try {
      if (isGlobalWorkspaceFilesAgentId(req.query.agentId)) {
        assertGlobalWorkspacePathAllowed(agentManager, req.query.path || '');
      }
      const root = resolveWorkspaceRoot(agentManager, req.query.agentId);
      const file = await fileService.readPreviewFile(root, req.query.path || '', readOptionsForAgent(agentManager, req.query.agentId));
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
      assertWritableWorkspaceAgent(body.agentId);
      const root = resolveWorkspaceRoot(agentManager, body.agentId);
      const file = await fileService.writeFile(root, body.path || '', body.content, {
        baseSha1: body.baseSha1,
        overwrite: body.overwrite === true,
      });
      res.json({ root, file });
    } catch (error) {
      sendWorkspaceFileError(res, error);
    }
  });

  router.post('/move', async (req, res) => {
    try {
      const body = req.body || {};
      assertWritableWorkspaceAgent(body.agentId);
      const root = resolveWorkspaceRoot(agentManager, body.agentId);
      const move = await fileService.moveEntry(root, body.sourcePath || '', body.targetDirectory || '');
      res.json({ root, move });
    } catch (error) {
      sendWorkspaceFileError(res, error);
    }
  });

  router.post('/entry', async (req, res) => {
    try {
      const body = req.body || {};
      assertWritableWorkspaceAgent(body.agentId);
      const root = resolveWorkspaceRoot(agentManager, body.agentId);
      const created = await fileService.createEntry(root, body.parentPath || '', body.name || '', body.entryType || 'file', body.content || '');
      res.status(201).json({ root, ...created });
    } catch (error) {
      sendWorkspaceFileError(res, error);
    }
  });

  router.patch('/entry', async (req, res) => {
    try {
      const body = req.body || {};
      assertWritableWorkspaceAgent(body.agentId);
      const root = resolveWorkspaceRoot(agentManager, body.agentId);
      const move = await fileService.renameEntry(root, body.path || '', body.name || '');
      res.json({ root, move });
    } catch (error) {
      sendWorkspaceFileError(res, error);
    }
  });

  router.delete('/entry', async (req, res) => {
    try {
      const body = req.body || {};
      const agentId = body.agentId || req.query.agentId;
      const targetPath = body.path || req.query.path || '';
      assertWritableWorkspaceAgent(agentId);
      const root = resolveWorkspaceRoot(agentManager, agentId);
      const deleted = await fileService.deleteEntry(root, targetPath);
      res.json({ root, deleted });
    } catch (error) {
      sendWorkspaceFileError(res, error);
    }
  });

  router.get('/search', async (req, res) => {
    try {
      if (isGlobalWorkspaceFilesAgentId(req.query.agentId)) {
        assertGlobalWorkspacePathAllowed(agentManager, req.query.path || '');
      }
      const root = resolveWorkspaceRoot(agentManager, req.query.agentId);
      const settings = agentManager?.configManager?.getSettings?.() || {};
      const results = await fileService.search(root, req.query.q || '', {
        includeIgnored: req.query.includeIgnored === 'true',
        path: req.query.path || '',
        limit: req.query.limit,
        timeoutMs: settings.searchTimeoutMs,
      });
      res.json({ root, results });
    } catch (error) {
      sendWorkspaceFileError(res, error);
    }
  });

  router.get('/diff', async (req, res) => {
    try {
      if (isGlobalWorkspaceFilesAgentId(req.query.agentId)) {
        assertGlobalWorkspacePathAllowed(agentManager, req.query.path || '', { allowMissing: true });
      }
      const root = resolveWorkspaceRoot(agentManager, req.query.agentId);
      const diff = await fileService.diff(root, req.query.path || '');
      res.json({ root, diff });
    } catch (error) {
      sendWorkspaceFileError(res, error);
    }
  });

  router.get('/changes', async (req, res) => {
    try {
      if (isGlobalWorkspaceFilesAgentId(req.query.agentId)) {
        throw new WorkspaceFileError('global files do not support workspace changes', 403);
      }
      const root = resolveWorkspaceRoot(agentManager, req.query.agentId);
      const changes = await fileService.changes(root, {
        limit: req.query.limit,
      });
      res.json({ root, changes });
    } catch (error) {
      sendWorkspaceFileError(res, error);
    }
  });

  router.get('/branch', async (req, res) => {
    try {
      if (isGlobalWorkspaceFilesAgentId(req.query.agentId)) {
        throw new WorkspaceFileError('global files do not support git branches', 403);
      }
      const root = resolveWorkspaceRoot(agentManager, req.query.agentId);
      const branch = await fileService.gitBranch(root);
      res.json({ root, branch });
    } catch (error) {
      sendWorkspaceFileError(res, error);
    }
  });

  router.get('/line-changes', async (req, res) => {
    try {
      if (isGlobalWorkspaceFilesAgentId(req.query.agentId)) {
        assertGlobalWorkspacePathAllowed(agentManager, req.query.path || '');
      }
      const root = resolveWorkspaceRoot(agentManager, req.query.agentId);
      const changes = await fileService.lineChanges(
        root,
        req.query.path || '',
        req.query.lineNumber,
        req.query.mode || 'working'
      );
      res.json({ root, changes });
    } catch (error) {
      sendWorkspaceFileError(res, error);
    }
  });

  router.get('/blame', async (req, res) => {
    try {
      if (isGlobalWorkspaceFilesAgentId(req.query.agentId)) {
        assertGlobalWorkspacePathAllowed(agentManager, req.query.path || '');
      }
      const root = resolveWorkspaceRoot(agentManager, req.query.agentId);
      const blame = await fileService.blame(root, req.query.path || '');
      res.json({ root, blame });
    } catch (error) {
      sendWorkspaceFileError(res, error);
    }
  });

  router.get('/blame-capability', async (req, res) => {
    try {
      if (isGlobalWorkspaceFilesAgentId(req.query.agentId)) {
        assertGlobalWorkspacePathAllowed(agentManager, req.query.path || '');
      }
      const root = resolveWorkspaceRoot(agentManager, req.query.agentId);
      const capability = await fileService.blameCapability(
        root,
        req.query.path || '',
        readOptionsForAgent(agentManager, req.query.agentId)
      );
      res.json({ root, capability });
    } catch (error) {
      sendWorkspaceFileError(res, error);
    }
  });

  return router;
}

module.exports = {
  GLOBAL_WORKSPACE_FILES_AGENT_ID,
  GLOBAL_WORKSPACE_FILES_ROOT,
  assertGlobalWorkspacePathAllowed,
  createWorkspaceFileRouter,
  globalWorkspaceAllowedRoots,
  isGlobalWorkspaceFilesAgentId,
  resolveWorkspaceRoot,
  sendWorkspaceFileError,
};
