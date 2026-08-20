import {
  isSafeSessionId,
  normalizeProvider,
  paginateAgentSessions,
  searchAgentSessions,
} from './agent-session-history.cjs';
import type { AgentSession } from './agent-session-history.cjs';
import { mainPageAgentSessionFromKey, mainPageAgentSessionKey } from './main-page-session.cjs';
import { canonicalProviderSessionKey } from '../shared/provider-session-identity.js';

const express = require('express');

interface AgentSessionDisplayRecord {
  displayPinned?: unknown;
  providerSessionKey?: unknown;
}

interface AgentSessionRouterSettings {
  projectNames: Record<string, string>;
  searchTimeoutMs: number;
}

type MainPageSessionRecordPatch = {
  provider: string;
  providerHomeId: string;
  providerSessionId: string;
  providerSessionKey: string;
};

interface AgentSessionRouterPort {
  archiveSession(provider: string, sessionId: string, providerHomeId: string): Promise<{
    error?: string;
    status?: number;
  }>;
  getMainPageSessionKeys(): string[];
  getSettings(): AgentSessionRouterSettings;
  invalidate(): void;
  listDisplayRecords(): readonly AgentSessionDisplayRecord[];
  listSessions(): Promise<AgentSession[]>;
  publishStateMetadata(state: { mainPageSessionKeys: string[] }): void;
  rememberMainPageSessionKey(sessionKey: string, patch: MainPageSessionRecordPatch): void;
  removeMainPageSessionKeys(sessionKeys: readonly string[]): void;
  setProviderSessionDisplayState(sessionKey: string, patch: { pinned: boolean }): void;
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

type ExpressHandler = (
  request: ExpressRequest,
  response: ExpressResponse,
) => void | Promise<void>;

type ExpressMiddleware = (
  request: ExpressRequest,
  response: ExpressResponse,
  next: (error?: unknown) => void,
) => void;

interface ExpressRouter {
  get(path: string, handler: ExpressHandler): ExpressRouter;
  patch(path: string, parser: ExpressMiddleware, handler: ExpressHandler): ExpressRouter;
  post(path: string, parser: ExpressMiddleware, handler: ExpressHandler): ExpressRouter;
}

interface ExpressFactory {
  Router(): ExpressRouter;
  json(): ExpressMiddleware;
}

interface AgentSessionRouterError extends Error {
  code?: string;
}

const expressFactory = express as ExpressFactory;

function caughtError(error: unknown): AgentSessionRouterError {
  if (error instanceof Error) return error as AgentSessionRouterError;
  const normalized = new Error(String(error)) as AgentSessionRouterError;
  if (error && typeof error === 'object') Object.assign(normalized, error);
  return normalized;
}

function providerSessionDisplayStates(
  records: readonly AgentSessionDisplayRecord[],
): Map<string, AgentSessionDisplayRecord> {
  const states = new Map<string, AgentSessionDisplayRecord>();
  for (const record of records) {
    if (typeof record.providerSessionKey === 'string' && record.providerSessionKey) {
      states.set(record.providerSessionKey, record);
    }
  }
  return states;
}

function applyProviderSessionDisplayStates(
  sessions: readonly AgentSession[],
  records: readonly AgentSessionDisplayRecord[],
): AgentSession[] {
  const displayStateByKey = providerSessionDisplayStates(records);
  return sessions.map(session => {
    const key = mainPageAgentSessionKey(session.provider, session.id, session.providerHomeId);
    const displayState = displayStateByKey.get(key);
    return typeof displayState?.displayPinned === 'boolean'
      ? { ...session, pinned: displayState.displayPinned }
      : session;
  });
}

function withSearchTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error('Agent search timed out') as AgentSessionRouterError;
      error.code = 'ETIMEDOUT';
      reject(error);
    }, timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function createAgentSessionRouter(service: AgentSessionRouterPort): ExpressRouter {
  const router = expressFactory.Router();

  router.get('/agent-sessions', async (req, res) => {
    try {
      res.setHeader('Cache-Control', 'no-store');
      const requestedLimit = Number(req.query.limit);
      const limit = Number.isFinite(requestedLimit) ? Math.max(0, Math.min(1000, requestedLimit)) : 60;
      const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : '';
      if (req.query.force === '1') service.invalidate();
      const sessions = await service.listSessions();
      const page = paginateAgentSessions(sessions, { limit: Math.max(1, limit), cursor });
      if (page.invalidCursor) {
        res.status(400).json({ error: 'Invalid Agent session cursor' });
        return;
      }
      res.json({
        sessions: applyProviderSessionDisplayStates(page.sessions, service.listDisplayRecords()),
        nextCursor: page.nextCursor,
        hasMore: page.hasMore,
        total: sessions.length,
      });
    } catch (caught) {
      const error = caughtError(caught);
      console.error('Failed to read agent sessions:', error);
      res.status(500).json({ error: error.message || 'Failed to read agent sessions' });
    }
  });

  router.get('/agent-sessions/search', async (req, res) => {
    try {
      res.setHeader('Cache-Control', 'no-store');
      const query = typeof req.query.q === 'string' ? req.query.q : '';
      const requestedLimit = Number(req.query.limit);
      const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(1000, requestedLimit)) : 100;
      const settings = service.getSettings();
      if (req.query.force === '1') service.invalidate();
      const sessions = await withSearchTimeout(
        service.listSessions(),
        Number(settings.searchTimeoutMs) || 10_000,
      );
      const result = searchAgentSessions(sessions, query, {
        limit,
        projectNames: settings.projectNames,
      });
      res.json({
        ...result,
        sessions: applyProviderSessionDisplayStates(result.sessions, service.listDisplayRecords()),
      });
    } catch (caught) {
      const error = caughtError(caught);
      if (error?.code === 'ETIMEDOUT') {
        res.status(504).json({ error: error.message });
        return;
      }
      console.error('Failed to search agent sessions:', error);
      res.status(500).json({ error: error.message || 'Failed to search Agent sessions' });
    }
  });

  router.patch('/agent-sessions/:provider/:sessionId', expressFactory.json(), (req, res) => {
    const provider = normalizeProvider(req.params.provider);
    const sessionId = String(req.params.sessionId || '').trim();
    const providerHomeId = String(req.body?.providerHomeId || 'default').trim() || 'default';
    if (!provider || !isSafeSessionId(sessionId) || !/^[A-Za-z0-9._-]+$/.test(providerHomeId)) {
      res.status(400).json({ error: 'Invalid Agent session' });
      return;
    }
    if (typeof req.body?.pinned !== 'boolean') {
      res.status(400).json({ error: 'Pinned state is required' });
      return;
    }
    const sessionKey = mainPageAgentSessionKey(provider, sessionId, providerHomeId);
    service.setProviderSessionDisplayState(sessionKey, { pinned: req.body.pinned });
    res.json({ sessionKey, pinned: req.body.pinned });
  });

  router.post('/agent-sessions/:provider/:sessionId/archive', expressFactory.json(), async (req, res) => {
    const provider = normalizeProvider(req.params.provider);
    const sessionId = String(req.params.sessionId || '').trim();
    const providerHomeId = String(req.body?.providerHomeId || 'default').trim() || 'default';
    if (!provider || !isSafeSessionId(sessionId) || !/^[A-Za-z0-9._-]+$/.test(providerHomeId)) {
      res.status(400).json({ error: 'Invalid Agent session' });
      return;
    }

    try {
      const archived = await service.archiveSession(provider, sessionId, providerHomeId);
      if (archived.error) {
        const status = Number(archived.status);
        res.status(Number.isInteger(status) && status >= 400 && status < 600 ? status : 409).json({
          error: archived.error,
        });
        return;
      }

      const sessionKey = mainPageAgentSessionKey(provider, sessionId, providerHomeId);
      service.removeMainPageSessionKeys([sessionKey]);
      const mainPageSessionKeys = service.getMainPageSessionKeys();
      service.invalidate();
      res.json({ success: true, sessionKey, mainPageSessionKeys });
      service.publishStateMetadata({ mainPageSessionKeys });
    } catch (caught) {
      const error = caughtError(caught);
      console.error('Failed to archive Agent session:', error);
      res.status(500).json({ error: error.message || 'Failed to archive Agent session' });
    }
  });

  router.post('/main-page-agent-sessions', expressFactory.json(), (req, res) => {
    const operation = typeof req.body?.operation === 'string' ? req.body.operation : '';
    const requestedKeys = Array.isArray(req.body?.sessionKeys) ? req.body.sessionKeys : [];
    // A client may still hold a pre-v2 spelling, so dedupe by the exact tuple
    // rather than by the received string.
    const sessionKeys = [...new Set(
      requestedKeys
        .map(key => canonicalProviderSessionKey(key))
        .filter(Boolean),
    )];
    if (
      !['add', 'remove'].includes(operation)
      || sessionKeys.length === 0
      || sessionKeys.length > 50
      || sessionKeys.some(key => !mainPageAgentSessionFromKey(key))
    ) {
      res.status(400).json({ error: 'A valid main-page Agent session mutation is required' });
      return;
    }

    if (operation === 'add') {
      [...sessionKeys].reverse().forEach(sessionKey => {
        const session = mainPageAgentSessionFromKey(sessionKey);
        if (!session) return;
        service.rememberMainPageSessionKey(sessionKey, {
          provider: session.provider,
          providerSessionId: session.sessionId,
          providerSessionKey: sessionKey,
          providerHomeId: session.providerHomeId || 'default',
        });
      });
    } else {
      service.removeMainPageSessionKeys(sessionKeys);
    }

    const mainPageSessionKeys = service.getMainPageSessionKeys();
    service.invalidate();
    res.json({ success: true, mainPageSessionKeys });
    service.publishStateMetadata({ mainPageSessionKeys });
  });

  return router;
}

export {
  createAgentSessionRouter,
  type AgentSessionRouterPort,
};
