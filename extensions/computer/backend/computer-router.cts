const express = require('express');
const http = require('http');

interface ComputerResourceManager {
  capability(refresh?: boolean): Promise<unknown>;
  prepare(): Promise<unknown>;
  requireEnabled(): void;
  snapshot(): { collectionRevision: number; resources: unknown[] };
  get(id: string): Record<string, unknown>;
  create(input: Record<string, unknown>): unknown;
  rename(id: string, name: unknown): unknown;
  start(id: string): Promise<unknown>;
  stop(id: string): Promise<unknown>;
  delete(id: string): Promise<unknown>;
  takeControl(id: string, owner: 'agent' | 'human'): unknown;
  callTool(id: string, tool: string, input: Record<string, unknown>, caller?: 'agent' | 'human'): Promise<unknown>;
  viewerConfig(id: string): {
    host: string;
    port: number;
    password: string;
    viewOnly: boolean;
    generation: number;
    controlEpoch: number;
  };
  on(event: string, listener: (value: unknown) => void): void;
  off(event: string, listener: (value: unknown) => void): void;
}

interface WorkspaceRootRegistry {
  resolve(rootId: string): {
    rootId: string;
    canonicalPath: string;
  } | null;
}

interface AgentStateReader {
  getState(): { agents?: unknown[] };
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function requestAgentId(req: { get?(name: string): string | undefined }): string {
  return String(req.get?.('X-Farming-Agent-Id') || '').trim();
}

function ownerAgent(
  agentStateReader: AgentStateReader | undefined,
  agentId: string,
): Record<string, unknown> | undefined {
  const agents = agentStateReader?.getState()?.agents;
  return Array.isArray(agents)
    ? agents.map(recordValue).find(agent => agent.id === agentId)
    : undefined;
}

function assertRequestOwner(
  manager: ComputerResourceManager,
  req: { get?(name: string): string | undefined },
  id: string,
): void {
  const agentId = requestAgentId(req);
  if (!agentId) return;
  const resource = manager.get(id);
  if (resource.ownerAgentId !== agentId) {
    throw Object.assign(new Error('Computer Resource is not owned by this Agent'), {
      status: 403,
      code: 'COMPUTER_OWNER_MISMATCH',
    });
  }
}

function sendError(res: any, caught: unknown): void {
  const error = caught as Error;
  res.status(Number(error.status) || 500).json({
    error: error.message || 'Computer request failed',
    ...(error.code ? { code: error.code } : {}),
    ...(error.uncertain ? { uncertain: true } : {}),
    ...(recordValue(error).compatibilityRequired ? { compatibilityRequired: true } : {}),
  });
}

function createComputerRouter(
  manager: ComputerResourceManager,
  workspaceRoots: WorkspaceRootRegistry,
  agentStateReader?: AgentStateReader,
) {
  const router = express.Router();
  router.use(express.json({ limit: '1mb' }));

  router.get('/capability', async (req: any, res: any) => {
    try {
      res.json(await manager.capability(req.query?.refresh === '1'));
    } catch (caught) {
      sendError(res, caught);
    }
  });

  router.post('/prepare', async (_req: any, res: any) => {
    try {
      res.json(await manager.prepare());
    } catch (caught) {
      sendError(res, caught);
    }
  });

  router.get('/', (req: any, res: any) => {
    try {
      const snapshot = manager.snapshot();
      const agentId = requestAgentId(req);
      res.json(agentId
        ? {
            ...snapshot,
            resources: snapshot.resources.filter(resource => recordValue(resource).ownerAgentId === agentId),
          }
        : snapshot);
    } catch (caught) {
      sendError(res, caught);
    }
  });

  router.get('/events', (req: any, res: any) => {
    try {
      manager.requireEnabled();
    } catch (caught) {
      sendError(res, caught);
      return;
    }
    res.writeHead(200, {
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'Content-Type': 'text/event-stream',
      'X-Accel-Buffering': 'no',
    });
    const write = (event: string, value: unknown) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`);
    };
    const onResources = (value: unknown) => write('resources', value);
    const onResource = (value: unknown) => write('resource', value);
    const onDeleted = (value: unknown) => write('deleted', value);
    manager.on('resources', onResources);
    manager.on('resource', onResource);
    manager.on('deleted', onDeleted);
    write('resources', manager.snapshot());
    req.on('close', () => {
      manager.off('resources', onResources);
      manager.off('resource', onResource);
      manager.off('deleted', onDeleted);
    });
  });

  router.post('/', (req: any, res: any) => {
    try {
      manager.requireEnabled();
      const body = recordValue(req.body);
      const callerAgentId = requestAgentId(req);
      const requestedAgentId = String(body.agentId || '').trim();
      if (callerAgentId && requestedAgentId && callerAgentId !== requestedAgentId) {
        res.status(403).json({ error: 'Agent tools cannot create a Computer for another Agent' });
        return;
      }
      const agentId = callerAgentId || requestedAgentId;
      if (!agentId) {
        res.status(400).json({ error: 'Computer owner Agent is required' });
        return;
      }
      const owner = ownerAgent(agentStateReader, agentId);
      if (!owner) {
        res.status(404).json({ error: 'Computer owner Agent was not found' });
        return;
      }
      const root = workspaceRoots.resolve(String(body.rootId || ''));
      if (!root) {
        res.status(404).json({ error: 'Computer Project workspace was not found' });
        return;
      }
      const ownerWorkspace = String(owner.projectWorkspace || owner.cwd || '').trim();
      if (!ownerWorkspace || ownerWorkspace !== root.canonicalPath) {
        res.status(409).json({ error: 'Computer owner Agent is not bound to the selected Project workspace' });
        return;
      }
      res.json(manager.create({
        ownerAgentId: agentId,
        projectRootId: root.rootId,
        workspace: root.canonicalPath,
        name: body.name,
      }));
    } catch (caught) {
      sendError(res, caught);
    }
  });

  router.patch('/:id', (req: any, res: any) => {
    try {
      assertRequestOwner(manager, req, req.params.id);
      res.json(manager.rename(req.params.id, recordValue(req.body).name));
    } catch (caught) {
      sendError(res, caught);
    }
  });

  for (const operation of ['start', 'stop'] as const) {
    router.post(`/:id/${operation}`, async (req: any, res: any) => {
      try {
        assertRequestOwner(manager, req, req.params.id);
        res.json(await manager[operation](req.params.id));
      } catch (caught) {
        sendError(res, caught);
      }
    });
  }

  router.delete('/:id', async (req: any, res: any) => {
    try {
      assertRequestOwner(manager, req, req.params.id);
      res.json(await manager.delete(req.params.id));
    } catch (caught) {
      sendError(res, caught);
    }
  });

  router.post('/:id/control', (req: any, res: any) => {
    try {
      assertRequestOwner(manager, req, req.params.id);
      const owner = recordValue(req.body).owner;
      if (owner !== 'agent' && owner !== 'human') {
        res.status(400).json({ error: 'Computer control owner must be agent or human' });
        return;
      }
      res.json(manager.takeControl(req.params.id, owner));
    } catch (caught) {
      sendError(res, caught);
    }
  });

  router.post('/:id/tool/:tool', async (req: any, res: any) => {
    try {
      assertRequestOwner(manager, req, req.params.id);
      res.json(await manager.callTool(
        req.params.id,
        req.params.tool,
        recordValue(req.body),
        requestAgentId(req) ? 'agent' : 'human',
      ));
    } catch (caught) {
      sendError(res, caught);
    }
  });

  router.get('/:id/viewer-config', (req: any, res: any) => {
    try {
      const config = manager.viewerConfig(req.params.id);
      res.json({
        password: config.password,
        viewOnly: config.viewOnly,
        generation: config.generation,
        controlEpoch: config.controlEpoch,
      });
    } catch (caught) {
      sendError(res, caught);
    }
  });

  router.get('/:id/viewer/*', (req: any, res: any) => {
    try {
      const config = manager.viewerConfig(req.params.id);
      const viewerPath = `/${String(req.params[0] || 'vnc.html').replace(/^\/+/, '')}`;
      const query = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
      const upstream = http.request({
        hostname: config.host,
        port: config.port,
        method: 'GET',
        path: `${viewerPath}${query}`,
        headers: {
          Accept: req.get('Accept') || '*/*',
          'Accept-Encoding': 'identity',
        },
      }, (response: any) => {
        res.status(response.statusCode || 502);
        for (const [name, value] of Object.entries(response.headers)) {
          if (value !== undefined && !['content-security-policy', 'x-frame-options'].includes(name)) {
            res.setHeader(name, value as string | string[]);
          }
        }
        response.pipe(res);
      });
      upstream.on('error', (error: Error) => {
        if (!res.headersSent) res.status(502).json({ error: error.message });
        else res.end();
      });
      upstream.end();
    } catch (caught) {
      sendError(res, caught);
    }
  });

  router.get('/:id/viewer', (req: any, res: any) => {
    res.redirect(307, `${req.originalUrl.replace(/\/viewer(?:\?.*)?$/, '/viewer/vnc.html')}`);
  });

  return router;
}

export {
  createComputerRouter,
};
