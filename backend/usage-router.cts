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

interface UsageRouterPort {
  getUsageDay(date: string, options: { fresh: boolean; live: boolean }): Promise<unknown>;
  getUsageSummary(options: { force?: boolean; maxAgeMs?: number }): Promise<unknown>;
  invalidateDailyCache(): void;
}

const expressFactory = express as ExpressFactory;

function caughtError(error: unknown): Error {
  if (error instanceof Error) return error;
  const normalized = new Error(String(error));
  if (error && typeof error === 'object') Object.assign(normalized, error);
  return normalized;
}

function createUsageRouter(service: UsageRouterPort): ExpressRouter {
  const router = expressFactory.Router();

  router.get('/', async (req, res) => {
    try {
      const fresh = req.query.fresh === '1';
      const live = req.query.live === '1';
      if (fresh) service.invalidateDailyCache();
      const usage = await service.getUsageSummary(
        fresh ? { force: true } : live ? { maxAgeMs: 15_000 } : {},
      );
      res.json({ usage });
    } catch (caught) {
      const error = caughtError(caught);
      res.status(500).json({ error: error.message || 'Failed to read usage information' });
    }
  });

  router.get('/day', async (req, res) => {
    try {
      const date = String(req.query.date || '').trim();
      const detail = await service.getUsageDay(date, {
        fresh: req.query.fresh === '1',
        live: req.query.live === '1',
      });
      res.json({ detail });
    } catch (caught) {
      const error = caughtError(caught);
      const invalidDate = error instanceof RangeError;
      res.status(invalidDate ? 400 : 500).json({
        error: invalidDate
          ? error.message
          : error.message || 'Failed to read usage day information',
      });
    }
  });

  return router;
}

export { createUsageRouter, type UsageRouterPort };
