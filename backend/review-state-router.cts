const express = require('express');

interface ExpressRequest {
  body?: Record<string, unknown>;
  params: Record<string, string>;
  query: Record<string, unknown>;
}

interface ExpressResponse {
  json(value: unknown): ExpressResponse;
  send(value?: unknown): ExpressResponse;
  set(field: string, value: string): ExpressResponse;
  status(code: number): ExpressResponse;
}

type ExpressHandler = (
  request: ExpressRequest,
  response: ExpressResponse,
) => void | Promise<void>;

interface ExpressRouter {
  delete(path: string, handler: ExpressHandler): ExpressRouter;
  get(path: string, handler: ExpressHandler): ExpressRouter;
  patch(path: string, handler: ExpressHandler): ExpressRouter;
  post(path: string, handler: ExpressHandler): ExpressRouter;
  put(path: string, handler: ExpressHandler): ExpressRouter;
  use(middleware: unknown): ExpressRouter;
}

interface ExpressFactory {
  Router(): ExpressRouter;
  json(options: { limit: string }): unknown;
}

interface ReviewPatchsetState {
  comments: unknown[];
  reviewedPaths: string[];
  revision: number;
}

interface ReviewStateStore {
  deleteComment(input: {
    commentId: string;
    patchset: string;
    reviewId: string;
  }): unknown[];
  getComments(reviewId: string, patchset: string): unknown[];
  getPatchsetState(reviewId: string, patchset: string): ReviewPatchsetState;
  saveComment(input: {
    comment: Record<string, unknown> | undefined;
    patchset: string;
    reviewId: string;
  }): unknown;
  setFileReviewedGerrit(input: {
    path: string;
    patchset: string;
    reviewId: string;
    reviewed: boolean;
  }): { changed: boolean; state: ReviewPatchsetState };
  updateCommentStatus(input: {
    commentId: string;
    patchset: string;
    reviewId: string;
    status: unknown;
  }): unknown;
}

const expressFactory = express as ExpressFactory;

function sendError(res: ExpressResponse, error: unknown): void {
  if (error instanceof TypeError) {
    res.status(400).json({ error: error.message });
    return;
  }
  console.error('Review state API error:', error);
  res.status(500).json({ error: 'review state operation failed' });
}

function isReviewedQuery(value: unknown): boolean {
  return value === '' || value === true || value === 'true' || value === '1';
}

function createReviewStateRouter(reviewStateStore: ReviewStateStore): ExpressRouter {
  const router = expressFactory.Router();
  router.use(expressFactory.json({ limit: '32kb' }));

  router.get('/:reviewId/revisions/:patchset/files', (req, res) => {
    try {
      if (req.query.reviewed === undefined) {
        res.status(400).json({ error: 'reviewed query is required' });
        return;
      }
      if (!isReviewedQuery(req.query.reviewed)) {
        res.status(400).json({ error: 'reviewed query must be bare or true' });
        return;
      }
      const state = reviewStateStore.getPatchsetState(req.params.reviewId, req.params.patchset);
      res.set('X-Farming-Review-Revision', String(state.revision));
      res.json(state.reviewedPaths);
    } catch (error) {
      sendError(res, error);
    }
  });

  router.put('/:reviewId/revisions/:patchset/files/:filePath/reviewed', (req, res) => {
    try {
      const result = reviewStateStore.setFileReviewedGerrit({
        reviewId: req.params.reviewId,
        patchset: req.params.patchset,
        path: req.params.filePath,
        reviewed: true,
      });
      res.set('X-Farming-Review-Revision', String(result.state.revision));
      res.status(result.changed ? 201 : 200).send();
    } catch (error) {
      sendError(res, error);
    }
  });

  router.delete('/:reviewId/revisions/:patchset/files/:filePath/reviewed', (req, res) => {
    try {
      const result = reviewStateStore.setFileReviewedGerrit({
        reviewId: req.params.reviewId,
        patchset: req.params.patchset,
        path: req.params.filePath,
        reviewed: false,
      });
      res.set('X-Farming-Review-Revision', String(result.state.revision));
      res.status(204).send();
    } catch (error) {
      sendError(res, error);
    }
  });

  router.get('/:reviewId/patchsets/:patchset/comments', (req, res) => {
    try {
      res.json({ comments: reviewStateStore.getComments(req.params.reviewId, req.params.patchset) });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post('/:reviewId/patchsets/:patchset/comments', (req, res) => {
    try {
      res.status(201).json(reviewStateStore.saveComment({
        reviewId: req.params.reviewId,
        patchset: req.params.patchset,
        comment: req.body,
      }));
    } catch (error) {
      sendError(res, error);
    }
  });

  router.delete('/:reviewId/patchsets/:patchset/comments/:commentId', (req, res) => {
    try {
      res.json({ comments: reviewStateStore.deleteComment({
        reviewId: req.params.reviewId,
        patchset: req.params.patchset,
        commentId: req.params.commentId,
      }) });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.patch('/:reviewId/patchsets/:patchset/comments/:commentId', (req, res) => {
    try {
      res.json(reviewStateStore.updateCommentStatus({
        reviewId: req.params.reviewId,
        patchset: req.params.patchset,
        commentId: req.params.commentId,
        status: req.body?.status,
      }));
    } catch (error) {
      sendError(res, error);
    }
  });

  return router;
}

export { createReviewStateRouter };
