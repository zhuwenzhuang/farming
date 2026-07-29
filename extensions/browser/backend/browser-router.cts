interface BrowserResourceManager {
  action(id: string, input: unknown): Promise<unknown>;
  capability(): unknown;
  create(input: {
    name: unknown;
    projectRootId: string;
    url: unknown;
    workspace: string;
  }): unknown;
  delete(id: string): Promise<unknown>;
  installManagedChromium(): Promise<unknown>;
  navigate(id: string, url: unknown): Promise<unknown>;
  off(event: 'deleted' | 'resource', listener: (value: unknown) => void): unknown;
  on(event: 'deleted' | 'resource', listener: (value: unknown) => void): unknown;
  refreshCapability(): Promise<unknown>;
  rename(id: string, name: unknown): unknown;
  requireEnabled(): void;
  snapshot(): unknown;
  start(id: string): Promise<unknown>;
  stop(id: string): Promise<unknown>;
}

interface WorkspaceRoot {
  canonicalPath: string;
  kind: string;
  rootId: string;
}

interface WorkspaceRootRegistry {
  resolve(rootId: unknown): WorkspaceRoot;
}

interface Request {
  body: unknown;
  params: Record<string, string>;
  on(event: 'close', listener: () => void): unknown;
}

interface Response {
  json(value: unknown): Response;
  status(status: number): Response;
  write(chunk: string): boolean;
  writeHead(status: number, headers: Record<string, string>): Response;
}

type RouteHandler = (request: Request, response: Response) => unknown;

interface Router {
  delete(path: string, handler: RouteHandler): unknown;
  get(path: string, handler: RouteHandler): unknown;
  patch(path: string, handler: RouteHandler): unknown;
  post(path: string, handler: RouteHandler): unknown;
  use(handler: RouteHandler): unknown;
}

interface ExpressModule {
  Router(): Router;
  json(options: { limit: string }): RouteHandler;
}

const express = require('express') as ExpressModule;

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object'
    ? value as Record<string, unknown>
    : {};
}

function errorMessage(error: unknown): unknown {
  const message = recordValue(error).message;
  return message || 'Browser request failed';
}

function sendError(res: Response, error: unknown): void {
  const value = recordValue(error);
  res.status(Number(value.status) || 500).json({
    error: errorMessage(error),
    code: value.code || 'BROWSER_INTERNAL_ERROR',
  });
}

function createBrowserRouter(
  manager: BrowserResourceManager,
  workspaceRootRegistry: WorkspaceRootRegistry,
): Router {
  const router = express.Router();
  router.use(express.json({ limit: '2mb' }));

  router.get('/capability', async (_req, res) => {
    try {
      await manager.refreshCapability();
      res.json(manager.capability());
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post('/install', async (_req, res) => {
    try {
      res.json(await manager.installManagedChromium());
    } catch (error) {
      sendError(res, error);
    }
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
    const onResource = (resource: unknown) => {
      res.write(`event: resource\ndata: ${JSON.stringify(resource)}\n\n`);
    };
    const onDeleted = (deletion: unknown) => {
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
      const body = recordValue(req.body);
      const root = workspaceRootRegistry.resolve(body.rootId);
      if (root.kind === 'global') {
        return res.status(400).json({ error: 'Browsers require a Project workspace' });
      }
      const resource = manager.create({
        projectRootId: root.rootId,
        workspace: root.canonicalPath,
        name: body.name,
        url: body.url,
      });
      res.status(201).json(resource);
    } catch (error) {
      sendError(res, error);
    }
  });

  router.patch('/:id', (req, res) => {
    try {
      res.json(manager.rename(req.params.id, recordValue(req.body).name));
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
      res.json(await manager.navigate(req.params.id, recordValue(req.body).url));
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

export {
  createBrowserRouter,
};
