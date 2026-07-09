const assert = require('assert');
const express = require('express');

const { createReviewDiffRouter } = require('../review-diff-router');
const { WorkspaceFileError } = require('../workspace-file-service');

async function fetchJson(baseUrl, pathname) {
  const response = await fetch(`${baseUrl}${pathname}`);
  const body = await response.json();
  return { body, response };
}

async function fetchText(baseUrl, pathname) {
  const response = await fetch(`${baseUrl}${pathname}`);
  return { response, text: await response.text() };
}

async function run() {
  const calls = [];
  const service = {
    async getWorkingCopy(agentId, options) {
      calls.push(['working-copy', agentId, options]);
      return {
        basePatchset: 'HEAD',
        files: [],
        isGitRepo: true,
        patchset: 'Working copy abc',
        reviewId: 'working-copy-test',
        root: '/workspace',
        source: 'working-copy',
        truncated: false,
      };
    },
    async getWorkingCopyPatch(agentId, options) {
      calls.push(['working-copy-patch', agentId, options]);
      return {
        patch: 'diff --git a/src/review.ts b/src/review.ts\n',
        truncated: false,
      };
    },
    async getWorkingCopyFile(agentId, filePath, options) {
      calls.push(['working-copy-file', agentId, filePath, options]);
      return {
        added: 1,
        diff: { hunks: [] },
        kind: 'modified',
        path: filePath,
        removed: 1,
        status: 'M',
      };
    },
    async getGitRange(agentId, options) {
      calls.push(['git-range', agentId, options]);
      if (options.base === 'bad') throw new WorkspaceFileError('base and head revisions are required', 400, { base: options.base });
      return {
        basePatchset: options.base,
        files: [],
        isGitRepo: true,
        patchset: options.head,
        reviewId: 'git-range-test',
        root: '/workspace',
        source: 'git-range',
        truncated: false,
      };
    },
    async getGitRangePatch(agentId, options) {
      calls.push(['git-range-patch', agentId, options]);
      return {
        patch: 'diff --git a/base.ts b/head.ts\n',
        truncated: true,
      };
    },
    async getGitRangeFile(agentId, options) {
      calls.push(['git-range-file', agentId, options]);
      return {
        added: 1,
        diff: { hunks: [] },
        kind: 'modified',
        path: options.path,
        removed: 1,
        status: 'M',
      };
    },
  };
  const sessionService = {
    assertRange(reviewId, root, base, head) {
      calls.push(['assert-session-range', reviewId, root, base, head]);
    },
  };

  const app = express();
  app.use('/api/reviews', createReviewDiffRouter(service, sessionService));
  const server = await new Promise(resolve => {
    const listener = app.listen(0, () => resolve(listener));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    const workingCopy = await fetchJson(baseUrl, '/api/reviews/working-copy?agentId=agent-1&limit=5&metadataOnly=1&context=25&ignoreWhitespace=ALL');
    assert.strictEqual(workingCopy.response.status, 200);
    assert.strictEqual(workingCopy.body.source, 'working-copy');
    assert.deepStrictEqual(calls.at(-1), ['working-copy', 'agent-1', { context: '25', ignoreWhitespace: 'ALL', limit: '5', metadataOnly: '1' }]);

    await fetchJson(baseUrl, '/api/reviews/working-copy?agentId=agent-1&scope=untracked&modifiedWithinDays=3&metadataOnly=1');
    assert.deepStrictEqual(calls.at(-1), ['working-copy', 'agent-1', {
      context: undefined,
      ignoreWhitespace: undefined,
      limit: undefined,
      metadataOnly: '1',
      modifiedWithinDays: '3',
      scope: 'untracked',
    }]);

    const gitRange = await fetchJson(baseUrl, '/api/reviews/git-range?agentId=agent-1&base=HEAD~1&head=HEAD&limit=3&metadataOnly=true&context=10&ignoreWhitespace=TRAILING');
    assert.strictEqual(gitRange.response.status, 200);
    assert.strictEqual(gitRange.body.source, 'git-range');
    assert.deepStrictEqual(calls.at(-1), ['git-range', 'agent-1', { base: 'HEAD~1', context: '10', head: 'HEAD', ignoreWhitespace: 'TRAILING', limit: '3', metadataOnly: 'true' }]);

    const sessionRange = await fetchJson(baseUrl, `/api/reviews/git-range?root=%2Frepo&base=${'1'.repeat(40)}&head=${'2'.repeat(40)}&reviewId=review-${'a'.repeat(32)}`);
    assert.strictEqual(sessionRange.response.status, 200);
    assert.deepStrictEqual(calls.at(-2), ['assert-session-range', `review-${'a'.repeat(32)}`, '/repo', '1'.repeat(40), '2'.repeat(40)]);
    assert.deepStrictEqual(calls.at(-1), ['git-range', undefined, {
      base: '1'.repeat(40),
      context: undefined,
      head: '2'.repeat(40),
      ignoreWhitespace: undefined,
      limit: undefined,
      metadataOnly: undefined,
      reviewId: `review-${'a'.repeat(32)}`,
      root: '/repo',
    }]);

    const directRoot = await fetchJson(baseUrl, '/api/reviews/git-range?root=%2Fworkspace%2Frepo&base=HEAD&head=now');
    assert.strictEqual(directRoot.response.status, 200);
    assert.deepStrictEqual(calls.at(-1), ['git-range', undefined, {
      base: 'HEAD',
      context: undefined,
      head: 'now',
      ignoreWhitespace: undefined,
      limit: undefined,
      metadataOnly: undefined,
      root: '/workspace/repo',
    }]);

    const patch = await fetchText(baseUrl, '/api/reviews/working-copy/patch?agentId=agent-1&limit=2&context=100&ignoreWhitespace=LEADING_AND_TRAILING');
    assert.strictEqual(patch.response.status, 200);
    assert.match(patch.response.headers.get('content-type'), /text\/x-diff/);
    assert.match(patch.response.headers.get('content-disposition'), /working-copy\.patch/);
    assert.strictEqual(patch.response.headers.get('x-farming-review-truncated'), 'false');
    assert.match(patch.text, /diff --git/);
    assert.deepStrictEqual(calls.at(-1), ['working-copy-patch', 'agent-1', { context: '100', ignoreWhitespace: 'LEADING_AND_TRAILING', limit: '2' }]);

    await fetchText(baseUrl, '/api/reviews/working-copy/patch?agentId=agent-1&scope=tracked');
    assert.deepStrictEqual(calls.at(-1), ['working-copy-patch', 'agent-1', {
      context: undefined,
      ignoreWhitespace: undefined,
      limit: undefined,
      scope: 'tracked',
    }]);

    const workingCopyFile = await fetchJson(baseUrl, '/api/reviews/working-copy/files/src%2Freview.ts/diff?agentId=agent-1&context=25&ignoreWhitespace=ALL');
    assert.strictEqual(workingCopyFile.response.status, 200);
    assert.strictEqual(workingCopyFile.body.path, 'src/review.ts');
    assert.deepStrictEqual(calls.at(-1), ['working-copy-file', 'agent-1', 'src/review.ts', { context: '25', ignoreWhitespace: 'ALL' }]);

    await fetchJson(baseUrl, '/api/reviews/working-copy/files/src%2Freview.ts/diff?agentId=agent-1&scope=untracked&modifiedWithinDays=3');
    assert.deepStrictEqual(calls.at(-1), ['working-copy-file', 'agent-1', 'src/review.ts', {
      context: undefined,
      ignoreWhitespace: undefined,
      modifiedWithinDays: '3',
      scope: 'untracked',
    }]);

    const rangePatch = await fetchText(baseUrl, '/api/reviews/git-range/patch?agentId=agent-1&base=HEAD~1&head=HEAD&limit=4&context=10&ignoreWhitespace=ALL');
    assert.strictEqual(rangePatch.response.status, 200);
    assert.match(rangePatch.response.headers.get('content-type'), /text\/x-diff/);
    assert.match(rangePatch.response.headers.get('content-disposition'), /git-range\.patch/);
    assert.strictEqual(rangePatch.response.headers.get('x-farming-review-truncated'), 'true');
    assert.match(rangePatch.text, /diff --git/);
    assert.deepStrictEqual(calls.at(-1), ['git-range-patch', 'agent-1', { base: 'HEAD~1', context: '10', head: 'HEAD', ignoreWhitespace: 'ALL', limit: '4' }]);

    const gitRangeFile = await fetchJson(baseUrl, '/api/reviews/git-range/files/src%2Freview.ts/diff?agentId=agent-1&base=HEAD~1&head=HEAD&context=10&ignoreWhitespace=TRAILING');
    assert.strictEqual(gitRangeFile.response.status, 200);
    assert.strictEqual(gitRangeFile.body.path, 'src/review.ts');
    assert.deepStrictEqual(calls.at(-1), ['git-range-file', 'agent-1', { base: 'HEAD~1', context: '10', head: 'HEAD', ignoreWhitespace: 'TRAILING', path: 'src/review.ts' }]);

    const error = await fetchJson(baseUrl, '/api/reviews/git-range?agentId=agent-1&base=bad&head=HEAD');
    assert.strictEqual(error.response.status, 400);
    assert.strictEqual(error.body.error, 'base and head revisions are required');
    assert.deepStrictEqual(error.body.details, { base: 'bad' });

    console.log('test-review-diff-router passed');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

run();
