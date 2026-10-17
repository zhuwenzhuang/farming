import express from 'express';
import type { AgentCommunicationCredentials } from '../../../backend/agent-communication-credentials.cjs';

export function createAgentCommunicationAdminRouter(options: {
  credentials: AgentCommunicationCredentials;
  isOwner(request: express.Request): boolean;
  validateTarget(agentId: string): void;
  authorizeIssuance(): Promise<number>;
}) {
  const router = express.Router();
  const requireCommunicationOwner: express.RequestHandler = (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!options.isOwner(req)) { res.status(403).json({ error: 'Owner access is required to manage communication grants' }); return; }
    next();
  };
  router.use(requireCommunicationOwner);
  router.use(express.json({ limit: '16kb' }));
  router.get('/', async (_req, res, next) => {
    try { res.json({ grants: (await options.credentials.list()).filter(grant => grant.principal.kind === 'external') }); } catch (error) { next(error); }
  });
  router.post('/', async (req, res, next) => {
    const body: unknown = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) { res.status(400).json({ error: 'A grant object is required' }); return; }
    const input = body as Record<string, unknown>;
    if (typeof input.peerId !== 'string' || typeof input.name !== 'string' || !Array.isArray(input.targets)
      || !input.targets.length || input.targets.length > 128 || !input.targets.every(target => typeof target === 'string')
      || typeof input.expiresAt !== 'number') {
      res.status(400).json({ error: 'Require peerId, name, explicit target Agent IDs, and expiresAt' }); return;
    }
    const { peerId, name, targets, expiresAt } = input;
    const id = /^[A-Za-z0-9._:-]{1,160}$/;
    if (!id.test(peerId) || !name.trim() || name.length > 240 || !targets.every(target => id.test(target))
      || !Number.isSafeInteger(expiresAt) || expiresAt <= Date.now() || expiresAt > Date.now() + 30 * 86400000) {
      res.status(400).json({ error: 'Invalid grant identity or expiry; expiry must be within 30 days' }); return;
    }
    try {
      await options.authorizeIssuance();
      for (const target of targets) options.validateTarget(target);
    } catch (error) { res.status((error as { status?: number }).status || 400).json({ error: error instanceof Error ? error.message : 'Invalid recipient' }); return; }
    try {
      const issued = await options.credentials.issue({ kind: 'external', peerId, name }, targets, expiresAt);
      res.status(201).json(issued);
    } catch (error) { next(error); }
  });
  router.delete('/:id', async (req, res, next) => {
    try { res.json({ revoked: await options.credentials.revoke(String(req.params.id)) }); } catch (error) { next(error); }
  });
  return router;
}
