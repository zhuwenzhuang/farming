const express = require('express');
const http = require('http');

import type { ComputerResourceManager } from './computer-resource-manager.cjs';

interface WorkspaceRootRegistry {
  resolve(rootId: string): {
    rootId: string;
    canonicalPath: string;
  } | null;
}

interface AgentStateReader {
  resolveAgentResourceBinding?(
    agentId: string,
  ): { agentId: string; workspace: string } | null;
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

function requestAgentBinding(
  agentStateReader: AgentStateReader | undefined,
  req: { get?(name: string): string | undefined },
): { agentId: string; workspace: string } | null {
  const agentId = requestAgentId(req);
  if (!agentId) return null;
  const binding = agentStateReader?.resolveAgentResourceBinding?.(agentId);
  if (binding) return binding;
  throw Object.assign(new Error('Computer Agent name is not active'), {
    status: 404,
    code: 'COMPUTER_AGENT_NOT_FOUND',
  });
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
  agentStateReader: AgentStateReader | undefined,
  req: { get?(name: string): string | undefined },
  id: string,
): void {
  const binding = requestAgentBinding(agentStateReader, req);
  if (!binding) return;
  const resource = manager.get(id);
  if (
    resource.ownerAgentId !== binding.agentId
    || resource.workspace !== binding.workspace
  ) {
    throw Object.assign(new Error('Computer Resource is not owned by this Agent'), {
      status: 403,
      code: 'COMPUTER_OWNER_MISMATCH',
    });
  }
}

function assertOwnerActive(
  manager: ComputerResourceManager,
  agentStateReader: AgentStateReader | undefined,
  id: string,
): void {
  const resource = manager.get(id);
  const owner = ownerAgent(agentStateReader, String(resource.ownerAgentId || ''));
  if (!owner) {
    throw Object.assign(new Error('Computer owner Agent was not found'), {
      status: 404,
      code: 'COMPUTER_OWNER_NOT_FOUND',
    });
  }
  const operation = String(recordValue(owner.lifecycleOperation).type || '');
  const preservesRuntime = operation === 'permission-restart' || operation === 'runtime-switch';
  const inactive = owner.archived === true
    || (!preservesRuntime && ['dead', 'error', 'exited', 'stopped'].includes(String(owner.status || '')));
  if (inactive) {
    throw Object.assign(new Error('Computer owner Agent is not active'), {
      status: 409,
      code: 'COMPUTER_OWNER_INACTIVE',
    });
  }
}

function sendError(res: any, caught: unknown): void {
  const error = caught as Error;
  res.status(Number(error.status) || 500).json({
    error: error.message || 'Computer request failed',
    ...(error.code ? { code: error.code } : {}),
    ...(error.uncertain ? { uncertain: true } : {}),
    ...(recordValue(error).retryable === true ? { retryable: true } : {}),
    ...(recordValue(error).actionStarted === false ? { actionStarted: false } : {}),
    ...(typeof recordValue(error).hint === 'string' ? { hint: recordValue(error).hint } : {}),
    ...(recordValue(error).compatibilityRequired ? { compatibilityRequired: true } : {}),
  });
}

function wildcardViewerPath(value: unknown): string {
  // Express 5 (path-to-regexp v8) reports named wildcard matches as segment
  // arrays; Express 4 reported one joined string. Rejoin at this boundary so
  // the upstream Viewer request keeps its slash-separated path.
  if (Array.isArray(value)) return value.map(segment => String(segment)).join('/');
  return typeof value === 'string' ? value : '';
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
      requestAgentBinding(agentStateReader, req);
      // The capability view claims current availability: it always performs
      // the fresh bounded authoritative probe (no query-dependent freshness).
      res.json(await manager.capability());
    } catch (caught) {
      sendError(res, caught);
    }
  });

  router.post('/prepare', async (req: any, res: any) => {
    try {
      requestAgentBinding(agentStateReader, req);
      res.json(await manager.prepare());
    } catch (caught) {
      sendError(res, caught);
    }
  });

  router.get('/', (req: any, res: any) => {
    try {
      const snapshot = manager.snapshot();
      const binding = requestAgentBinding(agentStateReader, req);
      const agentId = binding?.agentId || '';
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

  router.post('/', (req: any, res: any) => {
    try {
      manager.requireEnabled();
      const body = recordValue(req.body);
      const binding = requestAgentBinding(agentStateReader, req);
      const callerAgentId = binding?.agentId || '';
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
      if (binding && root.canonicalPath !== binding.workspace) {
        res.status(403).json({
          error: 'Computer Agent is not bound to the selected Project workspace',
          code: 'COMPUTER_WORKSPACE_MISMATCH',
        });
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
        ...(typeof body.name === 'string' ? { name: body.name } : {}),
      }));
    } catch (caught) {
      sendError(res, caught);
    }
  });

  router.patch('/:id', (req: any, res: any) => {
    try {
      assertRequestOwner(manager, agentStateReader, req, req.params.id);
      res.json(manager.rename(req.params.id, recordValue(req.body).name));
    } catch (caught) {
      sendError(res, caught);
    }
  });

  router.post('/:id/start', async (req: any, res: any) => {
    try {
      assertRequestOwner(manager, agentStateReader, req, req.params.id);
      assertOwnerActive(manager, agentStateReader, req.params.id);
      res.json(await manager.start(req.params.id));
    } catch (caught) {
      sendError(res, caught);
    }
  });

  router.post('/:id/stop', async (req: any, res: any) => {
    try {
      assertRequestOwner(manager, agentStateReader, req, req.params.id);
      res.json(await manager.stop(req.params.id));
    } catch (caught) {
      sendError(res, caught);
    }
  });

  router.delete('/:id', async (req: any, res: any) => {
    try {
      assertRequestOwner(manager, agentStateReader, req, req.params.id);
      res.json(await manager.delete(req.params.id));
    } catch (caught) {
      sendError(res, caught);
    }
  });

  router.post('/:id/control', async (req: any, res: any) => {
    try {
      assertRequestOwner(manager, agentStateReader, req, req.params.id);
      const owner = recordValue(req.body).owner;
      if (owner !== 'agent' && owner !== 'human') {
        res.status(400).json({ error: 'Computer control owner must be agent or human' });
        return;
      }
      res.json(await manager.takeControl(req.params.id, owner));
    } catch (caught) {
      sendError(res, caught);
    }
  });

  router.post('/:id/tool/:tool', async (req: any, res: any) => {
    try {
      assertRequestOwner(manager, agentStateReader, req, req.params.id);
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

  router.get('/:id/viewer/*viewerPath', (req: any, res: any) => {
    try {
      const config = manager.viewerConfig(req.params.id);
      const viewerPath = `/${(wildcardViewerPath(req.params.viewerPath) || 'vnc.html').replace(/^\/+/, '')}`;
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
