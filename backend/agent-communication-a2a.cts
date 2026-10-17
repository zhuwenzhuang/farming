import express from 'express';
import { AgentCard, type StreamResponse, type Task } from '@a2a-js/sdk';
import { UnsupportedOperationError } from '@a2a-js/sdk/errors';
import { type A2ARequestHandler } from '@a2a-js/sdk/server';
import { jsonRpcHandler } from '@a2a-js/sdk/server/express';
import type { AgentCommunicationCredentials, CommunicationGrant } from './agent-communication-credentials.cjs';
import { validateCommunicationHistoryLength, communicationTaskView, isCommunicationTaskActive, type AgentCommunicationService, type CommunicationTarget } from './agent-communication-service.cjs';

interface A2aRouterOptions {
  credentials: AgentCommunicationCredentials;
  authorizeExternal(): Promise<number>;
  service: AgentCommunicationService;
  /** Public base URL or request-relative mount path. */
  endpointBaseUrl: string;
  resolveTarget(grant: CommunicationGrant, agentId: string): Promise<CommunicationTarget>;
}

function handlerFor(options: A2aRouterOptions, grant: CommunicationGrant, agentId: string, signal: AbortSignal, authorize: () => Promise<void>): A2ARequestHandler {
  const unsupported = async (): Promise<never> => { throw new UnsupportedOperationError('Push notification configuration and extended cards are not supported'); };
  const pause = () => new Promise<void>((resolve, reject) => {
    signal.throwIfAborted();
    const done = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); resolve(); };
    const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(new Error('Observation disconnected or timed out; read the original Task')); };
    const timer = setTimeout(done, 500);
    signal.addEventListener('abort', abort, { once: true });
  });
  const wait = async (task: Task, historyLength?: number): Promise<Task> => {
    while (isCommunicationTaskActive(task)) {
      await pause(); await authorize();
      task = await options.service.get(grant, agentId, task.id);
    }
    return communicationTaskView(task, historyLength);
  };
  const stream = async function* (task: Task): AsyncGenerator<StreamResponse, void, undefined> {
    yield { payload: { $case: 'task', value: task } };
    while (isCommunicationTaskActive(task)) {
      await pause(); await authorize();
      const next = await options.service.get(grant, agentId, task.id);
      if (JSON.stringify(next.artifacts) !== JSON.stringify(task.artifacts)) {
        for (const artifact of next.artifacts) yield { payload: { $case: 'artifactUpdate', value: {
          taskId: next.id, contextId: next.contextId, artifact, append: false, lastChunk: true, metadata: undefined,
        } } };
      }
      if (JSON.stringify(next.status) !== JSON.stringify(task.status)) yield { payload: { $case: 'statusUpdate', value: {
        taskId: next.id, contextId: next.contextId, status: next.status, metadata: undefined,
      } } };
      task = next;
    }
  };
  const getAgentCard = async () => {
    return AgentCard.fromJSON({
      name: agentId,
      description: 'Send a request to this Farming Agent and retrieve its correlated result.',
      version: '1',
      supportedInterfaces: [{ url: `${options.endpointBaseUrl.replace(/\/$/, '')}/agents/${encodeURIComponent(agentId)}`, protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
      capabilities: { streaming: true, pushNotifications: false },
      defaultInputModes: ['text/plain'], defaultOutputModes: ['text/plain'],
      securitySchemes: { peer: { httpAuthSecurityScheme: { scheme: 'bearer' } } },
      securityRequirements: [{ schemes: { peer: [] } }],
      skills: [{ id: 'communicate', name: 'Agent communication', description: 'Handle a text request and return a result.', tags: ['communication'] }],
    });
  };
  return {
    getAgentCard,
    getAuthenticatedExtendedAgentCard: unsupported,
    sendMessage: async params => {
      // Validate projection options before admitting any work.
      validateCommunicationHistoryLength(params.configuration?.historyLength);
      const task = await options.service.send(grant, agentId, params);
      return params.configuration?.returnImmediately ? communicationTaskView(task, params.configuration.historyLength)
        : wait(task, params.configuration?.historyLength);
    },
    getTask: async params => {
      if (params.tenant) throw new UnsupportedOperationError('Tenant selection is not supported');
      return communicationTaskView(await options.service.get(grant, agentId, params.id), params.historyLength);
    },
    sendMessageStream: async function* (params) {
      validateCommunicationHistoryLength(params.configuration?.historyLength);
      const task = await options.service.send(grant, agentId, params);
      yield* stream(communicationTaskView(task, params.configuration?.historyLength));
    },
    resubscribe: async function* (params) {
      if (params.tenant) throw new UnsupportedOperationError('Tenant selection is not supported');
      yield* stream(await options.service.get(grant, agentId, params.id));
    },
    cancelTask: async params => {
      if (params.tenant) throw new UnsupportedOperationError('Tenant selection is not supported');
      return options.service.cancel(grant, agentId, params.id);
    },
    listTasks: params => options.service.list(grant, agentId, params),
    createTaskPushNotificationConfig: unsupported,
    getTaskPushNotificationConfig: unsupported,
    listTaskPushNotificationConfigs: unsupported,
    deleteTaskPushNotificationConfig: unsupported,
  };
}

/** Mount before owner auth: peer credentials authorize only these bounded protocol routes. */
export function createAgentCommunicationA2aRouter(options: A2aRouterOptions) {
  const router = express.Router();
  const activeRequests = new Map<string, number>();
  let activeTotal = 0;
  const windows = new Map<string, { since: number; count: number }>();
  const authenticateCommunicationPeer: express.RequestHandler = async (req, res, next) => {
    try {
      const match = /^Bearer (\S+)$/.exec(req.get('authorization') || '');
      const grant = match ? await options.credentials.authenticate(match[1]) : null;
      if (!grant) { res.status(401).json({ error: 'A valid communication credential is required' }); return; }
      if (grant.principal.kind === 'external') {
        try { res.locals.a2aRevision = await options.authorizeExternal(); }
        catch (error) { res.status(403).json({ error: error instanceof Error ? error.message : 'External A2A access is unavailable' }); return; }
      }
      const now = Date.now();
      for (const [key, window] of windows) if (now - window.since >= 60000) windows.delete(key);
      const key = grant.principal.kind === 'agent' ? `agent:${grant.principal.agentId}` : `external:${grant.principal.peerId}`;
      const window = windows.get(key) || { since: now, count: 0 };
      if (window.count >= 120 || (!windows.has(key) && windows.size >= 4096)) {
        res.setHeader('Retry-After', '60'); res.status(429).json({ error: 'Communication request limit reached' }); return;
      }
      window.count++; windows.set(key, window);
      res.locals.communicationGrant = grant;
      res.setHeader('Cache-Control', 'no-store');
      next();
    } catch { res.status(503).json({ error: 'Communication credential storage is unavailable' }); }
  };
  router.use(authenticateCommunicationPeer);
  router.use(express.json({ limit: '128kb' }));
  const dispatchCommunicationProtocol: express.RequestHandler = async (req, res, next) => {
    try {
      const grant: CommunicationGrant = res.locals.communicationGrant;
      const agentId = String(req.params.agentId || '');
      if (grant.principal.kind === 'external' && !grant.targets.includes(agentId)) {
        res.status(404).json({ error: 'Agent is not available to this peer' }); return;
      }
      const principal = grant.principal.kind === 'agent' ? `agent:${grant.principal.agentId}` : `external:${grant.principal.peerId}`;
      const active = activeRequests.get(principal) || 0;
      if (active >= 8 || activeTotal >= 128) {
        res.setHeader('Retry-After', '1'); res.status(429).json({ error: 'Too many open communication requests; close an observer before retrying' }); return;
      }
      activeRequests.set(principal, active + 1); activeTotal++;
      res.once('close', () => {
        activeTotal--;
        const remaining = (activeRequests.get(principal) || 1) - 1;
        if (remaining) activeRequests.set(principal, remaining); else activeRequests.delete(principal);
      });
      const disconnected = new AbortController();
      res.once('close', () => disconnected.abort());
      const signal = AbortSignal.any([disconnected.signal, AbortSignal.timeout(60000)]);
      const authorize = async () => {
        if (grant.principal.kind === 'external' && await options.authorizeExternal() !== res.locals.a2aRevision) {
          throw new Error('A2A plugin configuration changed; reconnect explicitly');
        }
        const token = (req.get('authorization') || '').slice(7);
        if (!(await options.credentials.authenticate(token))) throw new Error('Communication authorization expired or was revoked');
      };
      const endpointBaseUrl = options.endpointBaseUrl.startsWith('/')
        ? new URL(options.endpointBaseUrl, `${req.protocol}://${req.get('host')}`).href
        : options.endpointBaseUrl;
      const handler = handlerFor({ ...options, endpointBaseUrl }, grant, agentId, signal, authorize);
      if (req.route?.path === '/agents/:agentId/.well-known/agent-card.json' && req.method === 'GET') {
        const target = await options.resolveTarget(grant, agentId);
        res.json(AgentCard.toJSON({ ...await handler.getAgentCard(), name: target.name })); return;
      }
      if (req.method !== 'POST' || req.path !== '/') {
        res.status(405).json({ error: 'Method not allowed' }); return;
      }
      return jsonRpcHandler({ requestHandler: handler,
        userBuilder: async () => ({ isAuthenticated: true, userName: grant.id }),
      })(req, res, next);
    } catch (error) { next(error); }
  };
  router.get('/agents/:agentId/.well-known/agent-card.json', dispatchCommunicationProtocol);
  router.use('/agents/:agentId', dispatchCommunicationProtocol);
  return router;
}
