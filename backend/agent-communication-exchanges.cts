import express from 'express';
import { RequestMalformedError, TaskNotFoundError, UnsupportedOperationError } from '@a2a-js/sdk/errors';
import { SendMessageRequest } from '@a2a-js/sdk';
import type { AgentCommunicationRuntime } from './agent-communication-runtime.cjs';

/** Human supervision uses owner auth; no caller-supplied provenance or peer token. */
export function createAgentCommunicationExchangeRouter(options: {
  runtime: AgentCommunicationRuntime;
  isOwner(request: express.Request): boolean;
}) {
  const router = express.Router();
  const requireExchangeOwner: express.RequestHandler = (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!options.isOwner(req)) { res.status(403).json({ error: 'Owner access is required to supervise Agent messages' }); return; }
    next();
  };
  router.use(requireExchangeOwner);
  router.use(express.json({ limit: '128kb' }));
  router.get('/exchanges', async (req, res) => {
    if (typeof req.query.agentId !== 'string' || !/^[A-Za-z0-9._:-]{1,160}$/.test(req.query.agentId)
      || (req.query.before !== undefined && (typeof req.query.before !== 'string' || req.query.before.length > 160))) {
      res.status(400).json({ error: 'An exact Agent ID and bounded cursor are required' }); return;
    }
    try { res.json(await options.runtime.service.exchanges(req.query.agentId, req.query.before as string | undefined)); }
    catch (error) { res.status(409).json({ error: error instanceof Error ? error.message : 'Unable to read Agent messages' }); }
  });
  router.get('/exchanges/:taskId', async (req, res) => {
    try { res.json(await options.runtime.service.exchangeById(String(req.params.taskId))); }
    catch (error) { res.status(409).json({ error: error instanceof Error ? error.message : 'Unable to read message result' }); }
  });
  router.post('/exchanges/:taskId/cancel', async (req, res) => {
    try { res.json(await options.runtime.service.cancelForOwner(String(req.params.taskId))); }
    catch (error) { res.status(409).json({ error: error instanceof Error ? error.message : 'Cancellation was not confirmed; refresh the original message' }); }
  });
  router.post('/send', async (req, res) => {
    const input: unknown = req.body;
    if (!input || typeof input !== 'object' || Array.isArray(input)) { res.status(400).json({ error: 'A message object is required' }); return; }
    const body = input as Record<string, unknown>;
    const validId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9._:-]{1,160}$/.test(value);
    if (!validId(body.sourceAgentId) || !validId(body.targetAgentId) || !validId(body.messageId)
      || typeof body.text !== 'string' || !body.text.trim() || Buffer.byteLength(body.text) > 65536 || (body.replyToTaskId !== undefined && !validId(body.replyToTaskId))) {
      res.status(400).json({ error: 'Require sourceAgentId, targetAgentId, messageId and text' }); return;
    }
    try {
      const task = await options.runtime.service.send({ id: 'owner-directed', principal: { kind: 'agent', agentId: body.sourceAgentId },
        initiatedBy: 'user', targets: [], expiresAt: Date.now() + 60000 }, body.targetAgentId, SendMessageRequest.fromJSON({
        message: { messageId: body.messageId, role: 'ROLE_USER', parts: [{ text: body.text }], referenceTaskIds: body.replyToTaskId ? [body.replyToTaskId] : [] },
        configuration: { returnImmediately: true },
      }));
      res.status(202).json(await options.runtime.service.exchangeById(task.id));
    } catch (error) {
      const rejected = error instanceof RequestMalformedError || error instanceof TaskNotFoundError || error instanceof UnsupportedOperationError;
      res.status(rejected ? 400 : 409).json({ error: error instanceof Error ? error.message : 'Message admission was not confirmed; reconcile with the same ID' });
    }
  });
  return router;
}
