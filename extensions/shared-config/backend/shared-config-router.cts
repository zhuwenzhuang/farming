const express = require('express');
import type { SharedConfigService } from './shared-config-service.cjs';

interface ExpressRequest { authAccessMode?: string; body?: unknown }
interface ExpressResponse {
  json(value: unknown): ExpressResponse;
  status(code: number): ExpressResponse;
  setHeader(name: string, value: string): void;
}
type ExpressHandler = (req: ExpressRequest, res: ExpressResponse, next: () => void) => void;
interface ExpressRouter {
  get(path: string, ...handlers: ExpressHandler[]): ExpressRouter;
  put(path: string, ...handlers: Array<ExpressHandler | unknown>): ExpressRouter;
}
interface ExpressFactory { Router(): ExpressRouter; json(options: { limit: string }): unknown }
const expressFactory = express as ExpressFactory;

function createSharedConfigRouter(
  service: SharedConfigService,
  options: { authDisabled?: boolean } = {},
): ExpressRouter {
  const router = expressFactory.Router();
  const ownerOnly: ExpressHandler = (req, res, next) => {
    if (!options.authDisabled && req.authAccessMode !== 'owner') {
      res.status(403).json({ error: 'Owner access is required', code: 'OWNER_ACCESS_REQUIRED' });
      return;
    }
    next();
  };
  const respondError = (res: ExpressResponse, caught: unknown) => {
    const error = caught as Error & { status?: number; code?: string };
    res.status(error.status || 500).json({
      error: error.message || 'Shared configuration request failed',
      code: error.code || 'SHARED_CONFIG_ERROR',
    });
  };

  router.get('/', ownerOnly, (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try { res.json(service.getState()); } catch (caught) { respondError(res, caught); }
  });
  router.put('/', ownerOnly, expressFactory.json({ limit: '64kb' }), (req: ExpressRequest, res: ExpressResponse) => {
    res.setHeader('Cache-Control', 'no-store');
    try { res.json(service.save(req.body)); } catch (caught) { respondError(res, caught); }
  });
  return router;
}

export { createSharedConfigRouter };
