const express = require('express');

function sendError(res, error) {
  res.status(Number(error?.status) || 500).json({
    error: error?.message || 'Browser request failed',
    code: error?.code || 'BROWSER_INTERNAL_ERROR',
  });
}

function createBrowserRouter(manager, workspaceRootRegistry) {
  const router = express.Router();
  router.use(express.json({ limit: '2mb' }));

  router.get('/capability', (_req, res) => {
    res.json(manager.capability());
  });

  router.get('/', (_req, res) => {
    try {
      res.json(manager.snapshot());
    } catch (error) {
      sendError(res, error);
    }
  });

  router.get('/events', (req, res) => {
    try {
      manager.requireEnabled();
    } catch (error) {
      sendError(res, error);
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const onResource = resource => {
      res.write(`event: resource\ndata: ${JSON.stringify(resource)}\n\n`);
    };
    const onDeleted = deletion => {
      res.write(`event: deleted\ndata: ${JSON.stringify(deletion)}\n\n`);
    };
    const keepalive = setInterval(() => res.write(': keepalive\n\n'), 25_000);
    keepalive.unref?.();
    manager.on('resource', onResource);
    manager.on('deleted', onDeleted);
    res.write(`event: resources\ndata: ${JSON.stringify(manager.snapshot())}\n\n`);
    req.on('close', () => {
      clearInterval(keepalive);
      manager.off('resource', onResource);
      manager.off('deleted', onDeleted);
    });
  });

  router.post('/', (req, res) => {
    try {
      const root = workspaceRootRegistry.resolve(req.body?.rootId);
      if (root.kind === 'global') {
        return res.status(400).json({ error: 'Browsers require a Project workspace' });
      }
      const resource = manager.create({
        projectRootId: root.rootId,
        workspace: root.canonicalPath,
        name: req.body?.name,
        url: req.body?.url,
      });
      res.status(201).json(resource);
    } catch (error) {
      sendError(res, error);
    }
  });

  router.patch('/:id', (req, res) => {
    try {
      res.json(manager.rename(req.params.id, req.body?.name));
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post('/:id/start', async (req, res) => {
    try {
      res.json(await manager.start(req.params.id));
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post('/:id/stop', async (req, res) => {
    try {
      res.json(await manager.stop(req.params.id));
    } catch (error) {
      sendError(res, error);
    }
  });

  router.delete('/:id', async (req, res) => {
    try {
      res.json(await manager.delete(req.params.id));
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post('/:id/navigate', async (req, res) => {
    try {
      res.json(await manager.navigate(req.params.id, req.body?.url));
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post('/:id/action', async (req, res) => {
    try {
      res.json(await manager.action(req.params.id, req.body));
    } catch (error) {
      sendError(res, error);
    }
  });

  return router;
}

module.exports = {
  createBrowserRouter,
};
