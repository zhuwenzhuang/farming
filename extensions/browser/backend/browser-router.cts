import type { BrowserResourceManager } from './browser-resource-manager.cjs';

interface WorkspaceRoot {
  canonicalPath: string;
  kind: string;
  rootId: string;
}

interface WorkspaceRootRegistry {
  resolve(rootId: unknown): WorkspaceRoot;
}

interface AgentStateReader {
  getState(): { agents?: unknown[] };
}

interface Request {
  body: unknown;
  params: Record<string, string>;
  get?(name: string): string | undefined;
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
const INACTIVE_AGENT_STATUSES = new Set(['dead', 'error', 'exited', 'stopped']);

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

function requestAgentId(req: Request): string {
  return String(req.get?.('X-Farming-Agent-Id') || '').trim();
}

function browserOwnerAgent(
  agentStateReader: AgentStateReader | undefined,
  agentId: string,
): Record<string, unknown> | undefined {
  const agents = agentStateReader?.getState()?.agents;
  return Array.isArray(agents)
    ? agents.map(recordValue).find(agent => agent.id === agentId)
    : undefined;
}

function requireActiveOwner(
  manager: BrowserResourceManager,
  agentStateReader: AgentStateReader | undefined,
  id: string,
): void {
  const resource = manager.get(id);
  if (resource.ownerType !== 'agent') return;
  const owner = browserOwnerAgent(agentStateReader, String(resource.ownerAgentId || ''));
  const lifecycleType = String(recordValue(owner?.lifecycleOperation).type || '');
  const preservesBrowserRuntime = ['permission-restart', 'runtime-switch'].includes(lifecycleType);
  if (
    !owner
    || owner.archived === true
    || (!preservesBrowserRuntime && INACTIVE_AGENT_STATUSES.has(String(owner.status || '')))
  ) {
    const error = new Error('Browser owner Agent is not running') as Error & {
      code?: string;
      status?: number;
    };
    error.status = 409;
    error.code = 'BROWSER_OWNER_NOT_RUNNING';
    throw error;
  }
}

function requireRequestOwnership(
  manager: BrowserResourceManager,
  req: Request,
  id: string,
): void {
  const agentId = requestAgentId(req);
  if (!agentId) return;
  const resource = manager.get(id);
  if (resource.ownerType !== 'agent' || resource.ownerAgentId !== agentId) {
    const error = new Error('Browser Resource is not owned by this Agent') as Error & {
      code?: string;
      status?: number;
    };
    error.status = 403;
    error.code = 'BROWSER_OWNER_MISMATCH';
    throw error;
  }
}

function createBrowserRouter(
  manager: BrowserResourceManager,
  workspaceRootRegistry: WorkspaceRootRegistry,
  agentStateReader?: AgentStateReader,
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

  router.get('/', (req, res) => {
    try {
      const snapshot = recordValue(manager.snapshot());
      const agentId = requestAgentId(req);
      const resources = Array.isArray(snapshot.resources) ? snapshot.resources : [];
      res.json(agentId
        ? {
            ...snapshot,
            resources: resources.filter(resource => (
              recordValue(resource).ownerType === 'agent'
              && recordValue(resource).ownerAgentId === agentId
            )),
          }
        : snapshot);
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
      const callerAgentId = requestAgentId(req);
      const requestedAgentId = String(body.agentId || '').trim();
      if (callerAgentId && requestedAgentId && callerAgentId !== requestedAgentId) {
        return res.status(403).json({ error: 'Agent tools cannot create a Browser for another Agent' });
      }
      const ownerAgentId = callerAgentId || requestedAgentId;
      if (ownerAgentId) {
        const owner = browserOwnerAgent(agentStateReader, ownerAgentId);
        if (!owner) {
          return res.status(404).json({ error: 'Browser owner Agent was not found' });
        }
        const ownerWorkspace = String(owner.projectWorkspace || owner.cwd || '').trim();
        if (!ownerWorkspace || ownerWorkspace !== root.canonicalPath) {
          return res.status(409).json({
            error: 'Browser owner Agent is not bound to the selected Project workspace',
          });
        }
        const lifecycleType = String(recordValue(owner.lifecycleOperation).type || '');
        const preservesBrowserRuntime = ['permission-restart', 'runtime-switch'].includes(lifecycleType);
        if (
          owner.archived === true
          || (!preservesBrowserRuntime && INACTIVE_AGENT_STATUSES.has(String(owner.status || '')))
        ) {
          return res.status(409).json({ error: 'Browser owner Agent is not running' });
        }
      }
      const resource = manager.create({
        projectRootId: root.rootId,
        workspace: root.canonicalPath,
        ownerType: ownerAgentId ? 'agent' : 'project',
        ownerAgentId,
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
      requireRequestOwnership(manager, req, req.params.id);
      res.json(manager.rename(req.params.id, recordValue(req.body).name));
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post('/:id/start', async (req, res) => {
    try {
      requireRequestOwnership(manager, req, req.params.id);
      requireActiveOwner(manager, agentStateReader, req.params.id);
      res.json(await manager.start(req.params.id));
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post('/:id/stop', async (req, res) => {
    try {
      requireRequestOwnership(manager, req, req.params.id);
      res.json(await manager.stop(req.params.id));
    } catch (error) {
      sendError(res, error);
    }
  });

  router.delete('/:id', async (req, res) => {
    try {
      requireRequestOwnership(manager, req, req.params.id);
      res.json(await manager.delete(req.params.id));
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post('/:id/navigate', async (req, res) => {
    try {
      requireRequestOwnership(manager, req, req.params.id);
      requireActiveOwner(manager, agentStateReader, req.params.id);
      res.json(await manager.navigate(req.params.id, recordValue(req.body).url));
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post('/:id/action', async (req, res) => {
    try {
      requireRequestOwnership(manager, req, req.params.id);
      requireActiveOwner(manager, agentStateReader, req.params.id);
      res.json(await manager.action(req.params.id, recordValue(req.body)));
    } catch (error) {
      sendError(res, error);
    }
  });

  return router;
}

export {
  createBrowserRouter,
};
