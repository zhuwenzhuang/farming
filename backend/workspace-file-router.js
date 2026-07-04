const express = require('express');
const { WorkspaceFileError } = require('./workspace-file-service');

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

function createWorkspaceFileRouter(agentManager, fileService) {
  const router = express.Router();

  router.use(express.json({ limit: '3mb' }));

  router.get('/tree', async (req, res) => {
    try {
      const root = resolveWorkspaceRoot(agentManager, req.query.agentId);
      const tree = await fileService.listTree(root, req.query.path || '');
      res.json({ root, tree });
    } catch (error) {
      sendWorkspaceFileError(res, error);
    }
  });

  router.get('/file', async (req, res) => {
    try {
      const root = resolveWorkspaceRoot(agentManager, req.query.agentId);
      const file = await fileService.readFile(root, req.query.path || '');
      res.json({ root, file });
    } catch (error) {
      sendWorkspaceFileError(res, error);
    }
  });

  router.get('/raw', async (req, res) => {
    try {
      const root = resolveWorkspaceRoot(agentManager, req.query.agentId);
      const file = await fileService.readPreviewFile(root, req.query.path || '');
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
      const root = resolveWorkspaceRoot(agentManager, agentId);
      const deleted = await fileService.deleteEntry(root, targetPath);
      res.json({ root, deleted });
    } catch (error) {
      sendWorkspaceFileError(res, error);
    }
  });

  router.get('/search', async (req, res) => {
    try {
      const root = resolveWorkspaceRoot(agentManager, req.query.agentId);
      const results = await fileService.search(root, req.query.q || '', {
        path: req.query.path || '',
        limit: req.query.limit,
      });
      res.json({ root, results });
    } catch (error) {
      sendWorkspaceFileError(res, error);
    }
  });

  router.get('/diff', async (req, res) => {
    try {
      const root = resolveWorkspaceRoot(agentManager, req.query.agentId);
      const diff = await fileService.diff(root, req.query.path || '');
      res.json({ root, diff });
    } catch (error) {
      sendWorkspaceFileError(res, error);
    }
  });

  router.get('/changes', async (req, res) => {
    try {
      const root = resolveWorkspaceRoot(agentManager, req.query.agentId);
      const changes = await fileService.changes(root, {
        limit: req.query.limit,
      });
      res.json({ root, changes });
    } catch (error) {
      sendWorkspaceFileError(res, error);
    }
  });

  router.get('/line-changes', async (req, res) => {
    try {
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
      const root = resolveWorkspaceRoot(agentManager, req.query.agentId);
      const blame = await fileService.blame(root, req.query.path || '');
      res.json({ root, blame });
    } catch (error) {
      sendWorkspaceFileError(res, error);
    }
  });

  router.get('/blame-capability', async (req, res) => {
    try {
      const root = resolveWorkspaceRoot(agentManager, req.query.agentId);
      const capability = await fileService.blameCapability(root, req.query.path || '');
      res.json({ root, capability });
    } catch (error) {
      sendWorkspaceFileError(res, error);
    }
  });

  return router;
}

module.exports = {
  createWorkspaceFileRouter,
  resolveWorkspaceRoot,
  sendWorkspaceFileError,
};
