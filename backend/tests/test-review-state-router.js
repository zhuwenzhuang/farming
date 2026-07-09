const assert = require('assert');
const express = require('express');

const { createReviewStateRouter } = require('../review-state-router');

async function fetchJson(baseUrl, pathname, init) {
  const response = await fetch(`${baseUrl}${pathname}`, init);
  const body = await response.json().catch(() => null);
  return { body, response };
}

async function run() {
  const calls = [];
  const store = {
    getPatchsetState(reviewId, patchset) {
      calls.push(['get-patchset-state', reviewId, patchset]);
      return {
        comments: [],
        reviewedPaths: ['src/review.ts'],
        revision: 3,
      };
    },
    setFileReviewedGerrit({ reviewId, patchset, path, reviewed }) {
      calls.push(['set-file-reviewed-gerrit', reviewId, patchset, path, reviewed]);
      const alreadyReviewed = path === 'src/review.ts';
      return {
        changed: reviewed !== alreadyReviewed,
        state: {
          comments: [],
          reviewedPaths: reviewed ? [...new Set(['src/review.ts', path])] : [],
          revision: 4,
        },
      };
    },
    getComments() {
      return [];
    },
    updateCommentStatus({ reviewId, patchset, commentId, status }) {
      calls.push(['update-comment-status', reviewId, patchset, commentId, status]);
      return { body: 'Fix it.', id: commentId, line: 4, patchset, path: 'src/review.ts', side: 'right', status };
    },
  };

  const app = express();
  app.use('/api/reviews', createReviewStateRouter(store));
  const server = await new Promise(resolve => {
    const listener = app.listen(0, () => resolve(listener));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    const listed = await fetchJson(baseUrl, '/api/reviews/change%201/revisions/Patchset%202/files?reviewed');
    assert.strictEqual(listed.response.status, 200);
    assert.strictEqual(listed.response.headers.get('x-farming-review-revision'), '3');
    assert.deepStrictEqual(listed.body, ['src/review.ts']);
    assert.deepStrictEqual(calls.at(-1), ['get-patchset-state', 'change 1', 'Patchset 2']);

    const listedExplicitTrue = await fetchJson(baseUrl, '/api/reviews/change%201/revisions/Patchset%202/files?reviewed=true');
    assert.strictEqual(listedExplicitTrue.response.status, 200);
    assert.deepStrictEqual(listedExplicitTrue.body, ['src/review.ts']);
    assert.deepStrictEqual(calls.at(-1), ['get-patchset-state', 'change 1', 'Patchset 2']);

    const missingReviewedQuery = await fetchJson(baseUrl, '/api/reviews/change%201/revisions/Patchset%202/files');
    assert.strictEqual(missingReviewedQuery.response.status, 400);
    assert.deepStrictEqual(missingReviewedQuery.body, { error: 'reviewed query is required' });
    assert.deepStrictEqual(calls.at(-1), ['get-patchset-state', 'change 1', 'Patchset 2']);

    const falseReviewedQuery = await fetchJson(baseUrl, '/api/reviews/change%201/revisions/Patchset%202/files?reviewed=false');
    assert.strictEqual(falseReviewedQuery.response.status, 400);
    assert.deepStrictEqual(falseReviewedQuery.body, { error: 'reviewed query must be bare or true' });
    assert.deepStrictEqual(calls.at(-1), ['get-patchset-state', 'change 1', 'Patchset 2']);

    const listedGitRef = await fetchJson(baseUrl, '/api/reviews/git-range-a1b2c3/revisions/origin%2Fmaster/files?reviewed');
    assert.strictEqual(listedGitRef.response.status, 200);
    assert.deepStrictEqual(calls.at(-1), ['get-patchset-state', 'git-range-a1b2c3', 'origin/master']);

    const marked = await fetch(`${baseUrl}/api/reviews/change%201/revisions/Patchset%202/files/docs%2Freview.md/reviewed`, { method: 'PUT' });
    assert.strictEqual(marked.status, 201);
    assert.strictEqual(marked.headers.get('x-farming-review-revision'), '4');
    assert.deepStrictEqual(calls.at(-1), ['set-file-reviewed-gerrit', 'change 1', 'Patchset 2', 'docs/review.md', true]);

    const markedCommitMessage = await fetch(`${baseUrl}/api/reviews/change%201/revisions/Patchset%202/files/%2FCOMMIT_MSG/reviewed`, { method: 'PUT' });
    assert.strictEqual(markedCommitMessage.status, 201);
    assert.deepStrictEqual(calls.at(-1), ['set-file-reviewed-gerrit', 'change 1', 'Patchset 2', '/COMMIT_MSG', true]);

    const alreadyMarked = await fetch(`${baseUrl}/api/reviews/change%201/revisions/Patchset%202/files/src%2Freview.ts/reviewed`, { method: 'PUT' });
    assert.strictEqual(alreadyMarked.status, 200);
    assert.strictEqual(alreadyMarked.headers.get('x-farming-review-revision'), '4');
    assert.deepStrictEqual(calls.at(-1), ['set-file-reviewed-gerrit', 'change 1', 'Patchset 2', 'src/review.ts', true]);

    const unmarked = await fetch(`${baseUrl}/api/reviews/change%201/revisions/Patchset%202/files/src%2Freview.ts/reviewed`, { method: 'DELETE' });
    assert.strictEqual(unmarked.status, 204);
    assert.deepStrictEqual(calls.at(-1), ['set-file-reviewed-gerrit', 'change 1', 'Patchset 2', 'src/review.ts', false]);

    const resolved = await fetchJson(baseUrl, '/api/reviews/change%201/patchsets/Patchset%202/comments/note-1', {
      body: JSON.stringify({ status: 'resolved' }),
      headers: { 'Content-Type': 'application/json' },
      method: 'PATCH',
    });
    assert.strictEqual(resolved.response.status, 200);
    assert.strictEqual(resolved.body.status, 'resolved');
    assert.deepStrictEqual(calls.at(-1), ['update-comment-status', 'change 1', 'Patchset 2', 'note-1', 'resolved']);

    console.log('test-review-state-router passed');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

run();
