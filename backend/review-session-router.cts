const express = require('express');

interface ReviewSessionApiError extends Error {
  statusCode: number;
}

const { ReviewSessionError } = require('./review-session-service') as {
  ReviewSessionError: new (...args: unknown[]) => ReviewSessionApiError;
};

interface ExpressRequest {
  body?: Record<string, unknown>;
  params: Record<string, string>;
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
  post(path: string, handler: ExpressHandler): ExpressRouter;
  use(middleware: unknown): ExpressRouter;
}

interface ExpressFactory {
  Router(): ExpressRouter;
  json(options: { limit: string }): unknown;
}

interface ReviewSessionRefreshResult {
  unchanged: boolean;
  [key: string]: unknown;
}

interface ReviewSessionService {
  create(input: {
    agentId?: unknown;
    base?: unknown;
    modifiedWithinDays?: unknown;
    paths?: unknown;
    root?: unknown;
    scope?: unknown;
  }): Promise<unknown>;
  createFromAcp(input: { agentId?: unknown; itemIds?: unknown }): Promise<unknown>;
  get(reviewId: string): unknown;
  previewFromAcp(input: { agentId?: unknown; itemIds?: unknown }): Promise<unknown>;
  refresh(reviewId: string): Promise<ReviewSessionRefreshResult>;
}

const expressFactory = express as ExpressFactory;

function sendError(res: ExpressResponse, error: unknown): void {
  if (error instanceof ReviewSessionError) {
    res.status(error.statusCode).json({ error: error.message });
    return;
  }
  console.error('Review session API error:', error);
  res.status(500).json({ error: 'review session operation failed' });
}

function createReviewSessionRouter(service: ReviewSessionService): ExpressRouter {
  const router = expressFactory.Router();
  router.use(expressFactory.json({ limit: '16kb' }));

  router.post('/', async (req, res) => {
    try {
      res.status(201).json(await service.create({
        agentId: req.body?.agentId,
        base: req.body?.base,
        root: req.body?.root,
        ...(req.body?.modifiedWithinDays !== undefined ? { modifiedWithinDays: req.body.modifiedWithinDays } : {}),
        ...(req.body?.scope !== undefined ? { scope: req.body.scope } : {}),
        ...(req.body?.paths !== undefined ? { paths: req.body.paths } : {}),
      }));
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post('/acp', async (req, res) => {
    try {
      res.status(201).json(await service.createFromAcp({
        agentId: req.body?.agentId,
        itemIds: req.body?.itemIds,
      }));
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post('/acp/preview', async (req, res) => {
    try {
      res.json(await service.previewFromAcp({
        agentId: req.body?.agentId,
        itemIds: req.body?.itemIds,
      }));
    } catch (error) {
      sendError(res, error);
    }
  });

  router.get('/:reviewId', (req, res) => {
    try {
      res.json(service.get(req.params.reviewId));
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post('/:reviewId/revisions', async (req, res) => {
    try {
      const result = await service.refresh(req.params.reviewId);
      res.status(result.unchanged ? 200 : 201).json(result);
    } catch (error) {
      sendError(res, error);
    }
  });

  return router;
}

export { createReviewSessionRouter };
