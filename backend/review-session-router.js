const express = require('express');
const { ReviewSessionError } = require('./review-session-service');

function sendError(res, error) {
  if (error instanceof ReviewSessionError) {
    res.status(error.statusCode).json({ error: error.message });
    return;
  }
  console.error('Review session API error:', error);
  res.status(500).json({ error: 'review session operation failed' });
}

function createReviewSessionRouter(service) {
  const router = express.Router();
  router.use(express.json({ limit: '16kb' }));

  router.post('/', async (req, res) => {
    try {
      res.status(201).json(await service.create({
        agentId: req.body?.agentId,
        base: req.body?.base,
        root: req.body?.root,
        ...(req.body?.modifiedWithinDays !== undefined ? { modifiedWithinDays: req.body.modifiedWithinDays } : {}),
        ...(req.body?.scope !== undefined ? { scope: req.body.scope } : {}),
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

module.exports = { createReviewSessionRouter };
