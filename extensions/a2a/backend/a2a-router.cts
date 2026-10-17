import express from 'express';
import type { A2aExtensionService } from './a2a-service.cjs';
import type { CommunicationTarget } from '../../../backend/agent-communication-service.cjs';

export function createA2aExtensionRouter(options: {
  service: A2aExtensionService;
  isOwner(req: express.Request): boolean;
  targets(): CommunicationTarget[];
  endpointBaseUrl: string;
}) {
  const router = express.Router();
  const requireA2aOwner: express.RequestHandler = (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!options.isOwner(req)) { res.status(403).json({ error: 'Owner access is required' }); return; }
    next();
  };
  router.use(requireA2aOwner);
  router.use(express.json({ limit: '4kb' }));
  router.get('/', async (_req, res, next) => {
    try { res.json({ ...await options.service.getState(), targets: options.targets(), endpointBaseUrl: options.endpointBaseUrl }); }
    catch (error) { next(error); }
  });
  router.put('/', async (req, res) => {
    try { res.json(await options.service.save(req.body)); }
    catch (caught) {
      const error = caught as Error & { status?: number };
      res.status(error.status || 500).json({ error: error.message });
    }
  });
  return router;
}
