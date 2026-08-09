import {
  paginateAgentSessions,
  searchAgentSessions,
} from './agent-session-history.cjs';
import type { AgentSession } from './agent-session-history.cjs';
import { mainPageAgentSessionKey } from './main-page-session.cjs';

const express = require('express');

interface AgentSessionDisplayRecord {
  displayPinned?: unknown;
  providerSessionKey?: unknown;
}

interface AgentSessionRouterSettings {
  projectNames: Record<string, string>;
  searchTimeoutMs: number;
}

interface AgentSessionRouterPort {
  getSettings(): AgentSessionRouterSettings;
  invalidate(): void;
  listDisplayRecords(): readonly AgentSessionDisplayRecord[];
  listSessions(): Promise<AgentSession[]>;
}

interface ExpressRequest {
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

interface ExpressRouter {
  get(path: string, handler: ExpressHandler): ExpressRouter;
}

interface ExpressFactory {
  Router(): ExpressRouter;
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

  router.get('/', async (req, res) => {
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

  router.get('/search', async (req, res) => {
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

  return router;
}

export {
  createAgentSessionRouter,
  type AgentSessionRouterPort,
};
