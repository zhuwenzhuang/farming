const assert = require('assert');
const express = require('express');
const { createReviewSessionRouter } = require('../review-session-router');

async function run() {
  const calls = [];
  const revision = {
    base: '1'.repeat(40),
    createdAt: '2026-07-11T00:00:00.000Z',
    fixesBase: '1'.repeat(40),
    head: '2'.repeat(40),
    number: 1,
    reviewId: `review-${'a'.repeat(32)}`,
    root: '/repo',
  };
  const service = {
    async create(input) {
      calls.push(['create', input]);
      return revision;
    },
    get(reviewId) {
      calls.push(['get', reviewId]);
      return { ...revision, revisions: [revision] };
    },
    async refresh(reviewId) {
      calls.push(['refresh', reviewId]);
      return { ...revision, unchanged: true };
    },
  };
  const app = express();
  app.use('/api/review-sessions', createReviewSessionRouter(service));
  const server = await new Promise(resolve => {
    const listener = app.listen(0, () => resolve(listener));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const created = await fetch(`${baseUrl}/api/review-sessions`, {
      body: JSON.stringify({ agentId: 'agent-1', base: 'HEAD' }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    });
    assert.strictEqual(created.status, 201);
    assert.deepStrictEqual(calls.at(-1), ['create', { agentId: 'agent-1', base: 'HEAD', root: undefined }]);

    const scoped = await fetch(`${baseUrl}/api/review-sessions`, {
      body: JSON.stringify({ agentId: 'agent-1', base: 'HEAD', modifiedWithinDays: 3, scope: 'untracked' }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    });
    assert.strictEqual(scoped.status, 201);
    assert.deepStrictEqual(calls.at(-1), ['create', {
      agentId: 'agent-1',
      base: 'HEAD',
      modifiedWithinDays: 3,
      root: undefined,
      scope: 'untracked',
    }]);

    const loaded = await fetch(`${baseUrl}/api/review-sessions/${revision.reviewId}`);
    assert.strictEqual(loaded.status, 200);
    assert.deepStrictEqual(calls.at(-1), ['get', revision.reviewId]);

    const refreshed = await fetch(`${baseUrl}/api/review-sessions/${revision.reviewId}/revisions`, { method: 'POST' });
    assert.strictEqual(refreshed.status, 200);
    assert.deepStrictEqual(calls.at(-1), ['refresh', revision.reviewId]);

    console.log('test-review-session-router passed');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
