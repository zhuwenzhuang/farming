const express = require('express');

interface ExpressRequest {
  query: Record<string, unknown>;
}

interface ExpressResponse {
  json(value: unknown): ExpressResponse;
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

interface RequestedProviderHome {
  error: string;
  home: { path: string } | null;
  status: number;
}

interface ProviderCatalogRouterPort {
  loadCodexModels(homePath: string): Promise<unknown>;
  readClaudeSettings(homePath: string): unknown;
  resolveProviderHome(provider: string, rawHomeId: unknown): RequestedProviderHome;
}

const expressFactory = express as ExpressFactory;

function caughtError(error: unknown): Error {
  if (error instanceof Error) return error;
  const normalized = new Error(String(error));
  if (error && typeof error === 'object') Object.assign(normalized, error);
  return normalized;
}

function createProviderCatalogRouter(service: ProviderCatalogRouterPort): ExpressRouter {
  const router = expressFactory.Router();

  router.get('/codex/models', async (req, res) => {
    const requested = service.resolveProviderHome('codex', req.query.homeId);
    if (!requested.home) {
      res.status(requested.status).json({ error: requested.error });
      return;
    }
    try {
      const catalog = await service.loadCodexModels(requested.home.path);
      res.json(catalog);
    } catch (caught) {
      const error = caughtError(caught) as Error & { code?: string };
      const timedOut = error && error.code === 'CODEX_MODELS_TIMEOUT';
      res.status(timedOut ? 504 : 502).json({
        error: error && error.message ? error.message : 'Failed to load Codex model catalog',
        code: error && error.code ? error.code : 'CODEX_MODELS_FAILED',
      });
    }
  });

  router.get('/claude/settings', (req, res) => {
    const requested = service.resolveProviderHome('claude', req.query.homeId);
    if (!requested.home) {
      res.status(requested.status).json({ error: requested.error });
      return;
    }
    res.json({ settings: service.readClaudeSettings(requested.home.path) });
  });

  return router;
}

export {
  createProviderCatalogRouter,
  type ProviderCatalogRouterPort,
};
