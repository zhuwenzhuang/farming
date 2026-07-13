const express = require('express');
const { ReviewSessionError } = require('./review-session-service');
const { WorkspaceFileError } = require('./workspace-file-service');

function createReviewDiffRouter(reviewDiffService, reviewSessionService) {
  const router = express.Router();
  function sendWorkspaceError(res, error, fallbackMessage, logMessage) {
    if (error instanceof WorkspaceFileError) {
      res.status(error.statusCode).json({ error: error.message, ...(Object.keys(error.details || {}).length ? { details: error.details } : {}) });
      return true;
    }
    if (error instanceof ReviewSessionError) {
      res.status(error.statusCode).json({ error: error.message });
      return true;
    }
    console.error(logMessage, error);
    res.status(500).json({ error: fallbackMessage });
    return true;
  }

  function assertReviewSessionRange(req) {
    if (req.query.reviewId === undefined) return;
    reviewSessionService?.assertRange(req.query.reviewId, req.query.root, req.query.base, req.query.head);
  }

  function sendPatch(res, patch, filename, truncated) {
    res.set({
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Type': 'text/x-diff; charset=utf-8',
      'X-Farming-Review-Truncated': truncated === true ? 'true' : 'false',
    });
    res.send(patch);
  }

  router.get('/working-copy/patch', async (req, res) => {
    try {
      const result = await reviewDiffService.getWorkingCopyPatch(req.query.agentId, {
        context: req.query.context,
        ignoreWhitespace: req.query.ignoreWhitespace,
        limit: req.query.limit,
        ...(req.query.modifiedWithinDays !== undefined ? { modifiedWithinDays: req.query.modifiedWithinDays } : {}),
        ...(req.query.scope !== undefined ? { scope: req.query.scope } : {}),
        ...(req.query.root !== undefined ? { root: req.query.root } : {}),
      });
      sendPatch(res, result.patch, 'working-copy.patch', result.truncated);
    } catch (error) {
      sendWorkspaceError(res, error, 'review patch download failed', 'Review patch download API error:');
    }
  });
  router.get('/working-copy', async (req, res) => {
    try {
      const review = await reviewDiffService.getWorkingCopy(req.query.agentId, {
        context: req.query.context,
        ignoreWhitespace: req.query.ignoreWhitespace,
        limit: req.query.limit,
        metadataOnly: req.query.metadataOnly,
        ...(req.query.modifiedWithinDays !== undefined ? { modifiedWithinDays: req.query.modifiedWithinDays } : {}),
        ...(req.query.scope !== undefined ? { scope: req.query.scope } : {}),
        ...(req.query.root !== undefined ? { root: req.query.root } : {}),
      });
      res.json(review);
    } catch (error) {
      sendWorkspaceError(res, error, 'review diff operation failed', 'Review diff API error:');
    }
  });
  router.get('/working-copy/files/:filePath/diff', async (req, res) => {
    try {
      const file = await reviewDiffService.getWorkingCopyFile(req.query.agentId, req.params.filePath, {
        context: req.query.context,
        fileMeta: true,
        ignoreWhitespace: req.query.ignoreWhitespace,
        ...(req.query.modifiedWithinDays !== undefined ? { modifiedWithinDays: req.query.modifiedWithinDays } : {}),
        ...(req.query.scope !== undefined ? { scope: req.query.scope } : {}),
        ...(req.query.root !== undefined ? { root: req.query.root } : {}),
      });
      res.json(file);
    } catch (error) {
      sendWorkspaceError(res, error, 'review file diff operation failed', 'Review file diff API error:');
    }
  });
  router.get('/working-copy/files/:filePath/context', async (req, res) => {
    try {
      const context = await reviewDiffService.getWorkingCopyFileContext(req.query.agentId, req.params.filePath, {
        lines: req.query.lines,
        newStart: req.query.newStart,
        oldStart: req.query.oldStart,
        ...(req.query.modifiedWithinDays !== undefined ? { modifiedWithinDays: req.query.modifiedWithinDays } : {}),
        ...(req.query.scope !== undefined ? { scope: req.query.scope } : {}),
        ...(req.query.root !== undefined ? { root: req.query.root } : {}),
      });
      res.json(context);
    } catch (error) {
      sendWorkspaceError(res, error, 'review context operation failed', 'Review context API error:');
    }
  });
  router.get('/git-range/patch', async (req, res) => {
    try {
      assertReviewSessionRange(req);
      const result = await reviewDiffService.getGitRangePatch(req.query.agentId, {
        base: req.query.base,
        context: req.query.context,
        head: req.query.head,
        ignoreWhitespace: req.query.ignoreWhitespace,
        limit: req.query.limit,
        ...(req.query.reviewId !== undefined ? { reviewId: req.query.reviewId } : {}),
        ...(req.query.root !== undefined ? { root: req.query.root } : {}),
      });
      sendPatch(res, result.patch, 'git-range.patch', result.truncated);
    } catch (error) {
      sendWorkspaceError(res, error, 'review git range patch download failed', 'Review git range patch download API error:');
    }
  });
  router.get('/git-range', async (req, res) => {
    try {
      assertReviewSessionRange(req);
      const review = await reviewDiffService.getGitRange(req.query.agentId, {
        base: req.query.base,
        context: req.query.context,
        head: req.query.head,
        ignoreWhitespace: req.query.ignoreWhitespace,
        limit: req.query.limit,
        metadataOnly: req.query.metadataOnly,
        ...(req.query.reviewId !== undefined ? { reviewId: req.query.reviewId } : {}),
        ...(req.query.root !== undefined ? { root: req.query.root } : {}),
      });
      res.json(review);
    } catch (error) {
      sendWorkspaceError(res, error, 'review git range operation failed', 'Review git range API error:');
    }
  });
  router.get('/git-range/files/:filePath/diff', async (req, res) => {
    try {
      assertReviewSessionRange(req);
      const file = await reviewDiffService.getGitRangeFile(req.query.agentId, {
        base: req.query.base,
        context: req.query.context,
        fileMeta: true,
        head: req.query.head,
        ignoreWhitespace: req.query.ignoreWhitespace,
        path: req.params.filePath,
        ...(req.query.reviewId !== undefined ? { reviewId: req.query.reviewId } : {}),
        ...(req.query.root !== undefined ? { root: req.query.root } : {}),
      });
      res.json(file);
    } catch (error) {
      sendWorkspaceError(res, error, 'review git range file diff operation failed', 'Review git range file diff API error:');
    }
  });
  router.get('/git-range/files/:filePath/context', async (req, res) => {
    try {
      assertReviewSessionRange(req);
      const context = await reviewDiffService.getGitRangeFileContext(req.query.agentId, {
        base: req.query.base,
        head: req.query.head,
        lines: req.query.lines,
        newStart: req.query.newStart,
        oldStart: req.query.oldStart,
        path: req.params.filePath,
        ...(req.query.reviewId !== undefined ? { reviewId: req.query.reviewId } : {}),
        ...(req.query.root !== undefined ? { root: req.query.root } : {}),
      });
      res.json(context);
    } catch (error) {
      sendWorkspaceError(res, error, 'review git range context operation failed', 'Review git range context API error:');
    }
  });
  return router;
}

module.exports = { createReviewDiffRouter };
