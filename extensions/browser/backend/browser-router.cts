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
  resolveAgentResourceBinding?(
    agentId: string,
  ): { agentId: string; workspace: string } | null;
  getState(): { agents?: unknown[] };
}

interface Request {
  authAccessMode?: 'none' | 'owner' | 'read-only';
  baseUrl: string;
  body: unknown;
  headers: Record<string, string | string[] | undefined>;
  params: Record<string, string>;
  protocol: string;
  get?(name: string): string | undefined;
}

interface Response {
  json(value: unknown): Response;
  status(status: number): Response;
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
    ...(value.uncertain === true ? { uncertain: true } : {}),
    ...(value.retryable === true ? { retryable: true } : {}),
    ...(value.compatibilityRequired ? { compatibilityRequired: true } : {}),
  });
}

function requestAgentId(req: Request): string {
  return String(req.get?.('X-Farming-Agent-Id') || '').trim();
}

function requestAgentBinding(
  agentStateReader: AgentStateReader | undefined,
  req: Request,
): { agentId: string; workspace: string } | null {
  const agentId = requestAgentId(req);
  if (!agentId) return null;
  const binding = agentStateReader?.resolveAgentResourceBinding?.(agentId);
  if (binding) return binding;
  throw Object.assign(new Error('Browser Agent name is not active'), {
    status: 404,
    code: 'BROWSER_AGENT_NOT_FOUND',
  });
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
  agentStateReader: AgentStateReader | undefined,
  req: Request,
  id: string,
): void {
  const binding = requestAgentBinding(agentStateReader, req);
  if (!binding) return;
  const resource = manager.get(id);
  if (
    resource.ownerType !== 'agent'
    || resource.ownerAgentId !== binding.agentId
    || resource.workspace !== binding.workspace
  ) {
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
      requestAgentBinding(agentStateReader, _req);
      await manager.refreshCapability(undefined, { reuseVerified: true });
      const capability = manager.capability();
      const sources = await manager.sourceCapabilities();
      const anySourceAvailable = sources.some(source => source.available === true);
      res.json({
        ...capability,
        available: capability.enabled === true && anySourceAvailable,
        sources,
        message: capability.enabled !== true
          ? capability.message
          : anySourceAvailable
            ? ''
            : capability.message,
      });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.get('/extension', (req, res) => {
    try {
      if (req.authAccessMode === 'read-only') {
        return res.status(403).json({ error: 'Browser extension pairing requires owner access' });
      }
      requestAgentBinding(agentStateReader, req);
      const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0]?.trim();
      const protocol = forwardedProto || req.protocol;
      const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0]?.trim();
      if (!host) throw new Error('Farming public host is unavailable');
      const basePath = req.baseUrl.endsWith('/api/browsers')
        ? req.baseUrl.slice(0, -'/api/browsers'.length)
        : '';
      const relayUrl = `${protocol === 'https' ? 'wss' : 'ws'}://${host}${basePath}/browser/extension`;
      res.json(manager.browserExtensionStatus(relayUrl));
    } catch (error) {
      sendError(res, error);
    }
  });

  router.get('/extension/tabs', (req, res) => {
    try {
      requestAgentBinding(agentStateReader, req);
      res.json({ tabs: manager.extensionTabs() });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post('/extension/prepare', (req, res) => {
    try {
      if (req.authAccessMode === 'read-only') {
        return res.status(403).json({ error: 'Preparing Browser Connector requires owner access' });
      }
      requestAgentBinding(agentStateReader, req);
      res.json(manager.prepareBrowserExtension());
    } catch (error) {
      sendError(res, error);
    }
  });

  router.delete('/extension/prepare', (req, res) => {
    try {
      if (req.authAccessMode === 'read-only') {
        return res.status(403).json({ error: 'Removing the Browser Connector folder requires owner access' });
      }
      requestAgentBinding(agentStateReader, req);
      res.json(manager.removeBrowserExtension());
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post('/isolated/prepare', async (req, res) => {
    try {
      requestAgentBinding(agentStateReader, req);
      res.json(await manager.prepareIsolatedBrowser());
    } catch (error) {
      sendError(res, error);
    }
  });

  router.get('/', (req, res) => {
    try {
      const snapshot = recordValue(manager.snapshot());
      const binding = requestAgentBinding(agentStateReader, req);
      const agentId = binding?.agentId || '';
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

  router.post('/', (req, res) => {
    try {
      const body = recordValue(req.body);
      const root = workspaceRootRegistry.resolve(body.rootId);
      if (root.kind === 'global') {
        return res.status(400).json({ error: 'Browsers require a Project workspace' });
      }
      const binding = requestAgentBinding(agentStateReader, req);
      const callerAgentId = binding?.agentId || '';
      if (binding && root.canonicalPath !== binding.workspace) {
        return res.status(403).json({
          error: 'Browser Agent is not bound to the selected Project workspace',
          code: 'BROWSER_WORKSPACE_MISMATCH',
        });
      }
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
      const source = String(body.source || '').trim();
      const executablePath = String(body.executablePath || '').trim();
      const resource = manager.create({
        projectRootId: root.rootId,
        workspace: root.canonicalPath,
        ownerType: ownerAgentId ? 'agent' : 'project',
        ownerAgentId,
        name: body.name,
        url: body.url,
        ...(source ? { browserSource: source } : {}),
        ...(executablePath ? { browserExecutablePath: executablePath } : {}),
        ...(body.existingTabId !== undefined ? { existingTabId: body.existingTabId } : {}),
      });
      res.status(201).json(resource);
    } catch (error) {
      sendError(res, error);
    }
  });

  router.patch('/:id', (req, res) => {
    try {
      requireRequestOwnership(manager, agentStateReader, req, req.params.id);
      res.json(manager.rename(req.params.id, recordValue(req.body).name));
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post('/:id/start', async (req, res) => {
    try {
      requireRequestOwnership(manager, agentStateReader, req, req.params.id);
      requireActiveOwner(manager, agentStateReader, req.params.id);
      res.json(await manager.start(req.params.id));
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post('/:id/stop', async (req, res) => {
    try {
      requireRequestOwnership(manager, agentStateReader, req, req.params.id);
      res.json(await manager.stop(req.params.id));
    } catch (error) {
      sendError(res, error);
    }
  });

  router.delete('/:id', async (req, res) => {
    try {
      requireRequestOwnership(manager, agentStateReader, req, req.params.id);
      res.json(await manager.delete(req.params.id));
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post('/:id/navigate', async (req, res) => {
    try {
      requireRequestOwnership(manager, agentStateReader, req, req.params.id);
      requireActiveOwner(manager, agentStateReader, req.params.id);
      res.json(await manager.navigate(req.params.id, recordValue(req.body).url));
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post('/:id/action', async (req, res) => {
    try {
      requireRequestOwnership(manager, agentStateReader, req, req.params.id);
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
