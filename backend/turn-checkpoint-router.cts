import { TurnCheckpointError, type TurnCheckpointService } from './turn-checkpoint-service.cjs';

const express = require('express');

interface TurnCheckpointAgentLookup {
  id: string;
  cwd?: string;
}

interface TurnCheckpointRouterPort {
  getAgent(agentId: string): TurnCheckpointAgentLookup | null | undefined;
  isAgentTurnActive?(agentId: string): boolean;
}

interface ExpressRequest {
  body?: Record<string, unknown>;
  params: Record<string, string>;
  query: Record<string, unknown>;
}

interface ExpressResponse {
  json(value: unknown): ExpressResponse;
  setHeader(name: string, value: string): void;
  status(code: number): ExpressResponse;
}

type ExpressHandler = (req: ExpressRequest, res: ExpressResponse) => void | Promise<void>;
type ExpressMiddleware = (req: ExpressRequest, res: ExpressResponse, next: (err?: unknown) => void) => void;

interface ExpressRouter {
  get(path: string, handler: ExpressHandler): ExpressRouter;
  post(path: string, parser: ExpressMiddleware, handler: ExpressHandler): ExpressRouter;
}

interface ExpressFactory {
  Router(options?: { mergeParams?: boolean }): ExpressRouter;
  json(): ExpressMiddleware;
}

const expressFactory = express as ExpressFactory;

function handleError(res: ExpressResponse, caught: unknown): void {
  if (caught instanceof TurnCheckpointError) {
    res.status(caught.statusCode).json({ error: caught.message });
    return;
  }
  const message = caught instanceof Error ? caught.message : String(caught || 'Turn checkpoint operation failed');
  res.status(500).json({ error: message });
}

export function createTurnCheckpointRouter(
  service: TurnCheckpointService,
  agents: TurnCheckpointRouterPort,
): ExpressRouter {
  const router = expressFactory.Router({ mergeParams: true });

  router.get('/', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const agentId = String(req.params.agentId || '').trim();
    if (!agentId) {
      res.status(400).json({ error: 'Agent ID is required' });
      return;
    }
    const checkpoints = service.listCheckpoints(agentId);
    res.json({ agentId, checkpoints });
  });

  router.post('/', expressFactory.json(), async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const agentId = String(req.params.agentId || '').trim();
    const agent = agents.getAgent(agentId);
    if (!agent || !agent.cwd) {
      res.status(404).json({ error: 'Agent workspace not found' });
      return;
    }
    try {
      const checkpoint = await service.captureTurnCheckpoint({
        agentId,
        workspace: agent.cwd,
        kind: 'manual',
        force: req.body?.force === true,
        summary: typeof req.body?.summary === 'string' ? req.body.summary : 'Manual checkpoint',
      });
      res.json({ checkpoint });
    } catch (caught) {
      handleError(res, caught);
    }
  });

  router.get('/:checkpointId/diff', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const agentId = String(req.params.agentId || '').trim();
    const checkpointId = String(req.params.checkpointId || '').trim();
    const filePath = typeof req.query.path === 'string' ? req.query.path : undefined;
    try {
      const diff = await service.getCheckpointDiff(agentId, checkpointId, filePath);
      res.json(diff);
    } catch (caught) {
      handleError(res, caught);
    }
  });

  router.post('/:checkpointId/restore', expressFactory.json(), async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const agentId = String(req.params.agentId || '').trim();
    const checkpointId = String(req.params.checkpointId || '').trim();
    const target = req.body?.target === 'after' ? 'after' : 'before';
    const isBusy = agents.isAgentTurnActive ? agents.isAgentTurnActive(agentId) : false;
    try {
      const result = await service.restoreCheckpoint(agentId, checkpointId, {
        target,
        isAgentBusy: isBusy,
      });
      res.json(result);
    } catch (caught) {
      handleError(res, caught);
    }
  });

  return router;
}
