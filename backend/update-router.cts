const express = require('express');

interface ExpressRequest {
  body?: { assetName?: unknown } | null;
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
  post(path: string, middleware: unknown, handler: ExpressHandler): ExpressRouter;
}

interface ExpressFactory {
  Router(): ExpressRouter;
  json(): unknown;
}

interface FarmingUpdateServicePort {
  check(options: { force: boolean }): Promise<unknown>;
  startInstall(options: { assetName: string }): Promise<unknown>;
  applyPreparedUpdate(): Promise<unknown>;
}

const expressFactory = express as ExpressFactory;

function caughtError(error: unknown): Error {
  if (error instanceof Error) return error;
  const normalized = new Error(String(error));
  if (error && typeof error === 'object') Object.assign(normalized, error);
  return normalized;
}

function createUpdateRouter(updateService: FarmingUpdateServicePort): ExpressRouter {
  const router = expressFactory.Router();

  router.get('/', async (req, res) => {
    try {
      const update = await updateService.check({ force: req.query.force === '1' });
      res.json({ update });
    } catch (caught) {
      const error = caughtError(caught);
      res.status(502).json({ error: error.message || 'Failed to check for updates' });
    }
  });

  router.post('/install', expressFactory.json(), async (req, res) => {
    try {
      const state = await updateService.startInstall({
        assetName: req.body && typeof req.body.assetName === 'string' ? req.body.assetName : '',
      });
      res.status(202).json({ update: { state } });
    } catch (caught) {
      const error = caughtError(caught);
      res.status(500).json({ error: error.message || 'Failed to start update' });
    }
  });

  router.post('/restart', expressFactory.json(), async (_req, res) => {
    try {
      const state = await updateService.applyPreparedUpdate();
      res.status(202).json({ update: { state } });
    } catch (caught) {
      const error = caughtError(caught);
      res.status(500).json({ error: error.message || 'Failed to restart for update' });
    }
  });

  return router;
}

export { createUpdateRouter, type FarmingUpdateServicePort };
