import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createAcpReviewSession,
  createReviewSession,
  deleteReviewComment,
  loadGitRangeReviewFile,
  loadAcpReviewPreview,
  loadReviewedFiles,
  loadReviewComments,
  loadReviewComparisonSources,
  loadReviewDiffSnapshot,
  loadReviewFileContext,
  loadReviewFileDiff,
  loadReviewPatch,
  loadReviewPatchText,
  loadReviewSession,
  loadWorkingCopyReviewFile,
  ReviewApiError,
  refreshReviewSession,
  reviewFileDiffUrl,
  reviewFileContextUrl,
  reviewPatchUrl,
  reviewRequestForSessionRevision,
  reviewSnapshotUrl,
  saveReviewComment,
  saveReviewedFileStatus,
  saveReviewedFilesStatus,
} from '../src/lib/review/api'

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json' },
    status,
  })
}

test('loads working-copy review snapshots through one request model', async () => {
  const calls: string[] = []
  const previousFetch = globalThis.fetch
  globalThis.fetch = async (input) => {
    calls.push(String(input))
    return jsonResponse({
      files: [],
      isGitRepo: true,
      patchset: 'Working copy abc',
      reviewId: 'working-copy-test',
      root: '/workspace',
      truncated: false,
    })
  }
  try {
    const snapshot = await loadReviewDiffSnapshot({ agentId: 'agent-1', context: 25, ignoreWhitespace: 'ALL', limit: 7, metadataOnly: true, source: 'working-copy' })
    assert.equal(
      reviewSnapshotUrl({ agentId: 'agent-1', context: 25, ignoreWhitespace: 'ALL', limit: 7, metadataOnly: true, source: 'working-copy' }),
      '/api/reviews/working-copy?agentId=agent-1&limit=7&metadataOnly=1'
    )
    assert.deepEqual(calls, ['/api/reviews/working-copy?agentId=agent-1&limit=7&metadataOnly=1'])
    assert.equal(snapshot.source, 'working-copy')
    assert.equal(snapshot.basePatchset, 'HEAD')
  } finally {
    globalThis.fetch = previousFetch
  }
})

test('loads git-range review snapshots through one request model', async () => {
  const calls: string[] = []
  const previousFetch = globalThis.fetch
  globalThis.fetch = async (input) => {
    calls.push(String(input))
    return jsonResponse({
      basePatchset: 'HEAD~1',
      files: [],
      isGitRepo: true,
      patchset: 'HEAD',
      reviewId: 'git-range-test',
      root: '/workspace',
      truncated: false,
    })
  }
  try {
    const snapshot = await loadReviewDiffSnapshot({ agentId: 'agent-1', base: ' HEAD~1 ', context: 10, head: ' HEAD ', ignoreWhitespace: 'TRAILING', limit: 3, metadataOnly: true, source: 'git-range' })
    assert.equal(
      reviewSnapshotUrl({ agentId: 'agent-1', base: ' HEAD~1 ', context: 10, head: ' HEAD ', ignoreWhitespace: 'TRAILING', limit: 3, metadataOnly: true, source: 'git-range' }),
      '/api/reviews/git-range?agentId=agent-1&base=HEAD%7E1&head=HEAD&limit=3&metadataOnly=1'
    )
    assert.deepEqual(calls, ['/api/reviews/git-range?agentId=agent-1&base=HEAD%7E1&head=HEAD&limit=3&metadataOnly=1'])
    assert.equal(snapshot.source, 'git-range')
    assert.equal(snapshot.basePatchset, 'HEAD~1')
  } finally {
    globalThis.fetch = previousFetch
  }
})

test('loads a direct-root git range without fabricating an agent id', async () => {
  const calls: string[] = []
  const previousFetch = globalThis.fetch
  globalThis.fetch = async (input) => {
    calls.push(String(input))
    return jsonResponse({
      basePatchset: 'abc',
      files: [],
      isGitRepo: true,
      patchset: 'now',
      reviewId: 'git-range-direct-root',
      root: '/workspace/direct',
      source: 'git-range',
      truncated: false,
    })
  }
  try {
    const request = { base: 'abc', head: 'now', root: '/workspace/direct', source: 'git-range' as const }
    await loadReviewDiffSnapshot(request)
    assert.equal(reviewSnapshotUrl(request), '/api/reviews/git-range?root=%2Fworkspace%2Fdirect&base=abc&head=now')
    assert.deepEqual(calls, ['/api/reviews/git-range?root=%2Fworkspace%2Fdirect&base=abc&head=now'])
  } finally {
    globalThis.fetch = previousFetch
  }
})

test('loads semantic comparison sources for the review workspace', async () => {
  const previousFetch = globalThis.fetch
  const calls: string[] = []
  globalThis.fetch = async input => {
    calls.push(String(input))
    return jsonResponse({
      branches: [{ base: '1'.repeat(40), head: '2'.repeat(40), id: 'branch:main', label: 'main' }],
      commits: [{ base: '1'.repeat(40), head: '2'.repeat(40), id: `commit:${'2'.repeat(40)}`, label: '2222222 Review UI' }],
      currentBranch: 'feature/review',
      root: '/workspace/direct',
      staged: { available: true, base: '1'.repeat(40), head: '2'.repeat(40), id: 'staged', label: 'Staged' },
      unstaged: { available: false, base: '2'.repeat(40), head: 'now', id: 'unstaged', label: 'Unstaged' },
    })
  }
  try {
    const sources = await loadReviewComparisonSources({ root: '/workspace/direct' })
    assert.equal(sources.currentBranch, 'feature/review')
    assert.equal(sources.staged.available, true)
    assert.deepEqual(calls, ['/api/reviews/comparison-sources?root=%2Fworkspace%2Fdirect'])
  } finally {
    globalThis.fetch = previousFetch
  }
})

test('captures and refreshes immutable review session revisions', async () => {
  const previousFetch = globalThis.fetch
  const reviewId = `review-${'a'.repeat(32)}`
  const first = {
    base: '1'.repeat(40),
    createdAt: '2026-07-11T00:00:00.000Z',
    fixesBase: '1'.repeat(40),
    head: '2'.repeat(40),
    number: 1,
    reviewId,
    root: '/workspace/direct',
  }
  const second = {
    ...first,
    changedPaths: ['src/review.ts'],
    fixesBase: first.head,
    head: '3'.repeat(40),
    number: 2,
  }
  const calls: Array<{ body?: string; method?: string; url: string }> = []
  globalThis.fetch = async (input, init) => {
    calls.push({ body: init?.body as string | undefined, method: init?.method, url: String(input) })
    if (String(input).endsWith('/acp/preview')) return jsonResponse({
      changes: [{ added: 1, diff: '+new', kind: 'updated', path: 'src/a.ts', removed: 1 }],
    })
    if (String(input).endsWith('/revisions')) return jsonResponse(second, 201)
    if (init?.method === 'POST') return jsonResponse(first, 201)
    return jsonResponse({ ...second, revisions: [first, second] })
  }
  try {
    assert.deepEqual(await createReviewSession({ root: '/workspace/direct' }, 'HEAD'), first)
    assert.deepEqual(await createAcpReviewSession('agent-1', ['tool-1', 'tool-2']), first)
    assert.deepEqual(await loadAcpReviewPreview('agent-1', ['tool-1', 'tool-2']), [
      { added: 1, diff: '+new', kind: 'updated', path: 'src/a.ts', removed: 1 },
    ])
    assert.deepEqual(await refreshReviewSession(reviewId), second)
    assert.equal((await loadReviewSession(reviewId)).revisions.length, 2)
    const fixesRequest = reviewRequestForSessionRevision(second, 'fixes')
    assert.deepEqual(fixesRequest, {
      base: first.head,
      head: second.head,
      metadataOnly: true,
      reviewId,
      root: '/workspace/direct',
      source: 'git-range',
    })
    assert.equal(reviewSnapshotUrl(fixesRequest), `/api/reviews/git-range?root=%2Fworkspace%2Fdirect&base=${first.head}&head=${second.head}&metadataOnly=1&reviewId=${reviewId}`)
    assert.deepEqual(calls.map(call => [call.url, call.method]), [
      ['/api/review-sessions', 'POST'],
      ['/api/review-sessions/acp', 'POST'],
      ['/api/review-sessions/acp/preview', 'POST'],
      [`/api/review-sessions/${reviewId}/revisions`, 'POST'],
      [`/api/review-sessions/${reviewId}`, undefined],
    ])
    assert.deepEqual(JSON.parse(calls[2]?.body || '{}'), {
      agentId: 'agent-1',
      itemIds: ['tool-1', 'tool-2'],
    })
  } finally {
    globalThis.fetch = previousFetch
  }
})

test('loads Gerrit-style file metadata in review snapshots', async () => {
  const previousFetch = globalThis.fetch
  globalThis.fetch = async () => jsonResponse({
    files: [{
      added: 0,
      binary: true,
      diff: { hunks: [], truncated: true },
      diffTooExpensive: true,
      kind: 'copied',
      newMode: '100755',
      newSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      oldMode: '100644',
      oldSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      path: 'assets/logo.png',
      previousPath: 'assets/old-logo.png',
      removed: 0,
      size: 2048,
      sizeDelta: 512,
      status: 'C',
      truncated: true,
    }],
    isGitRepo: true,
    patchset: 'HEAD',
    reviewId: 'git-range-test',
    root: '/workspace',
    truncated: false,
  })
  try {
    const snapshot = await loadReviewDiffSnapshot({ agentId: 'agent-1', base: 'HEAD~1', head: 'HEAD', source: 'git-range' })
    assert.deepEqual(snapshot.files[0], {
      added: 0,
      binary: true,
      diff: { hunks: [], truncated: true },
      diffTooExpensive: true,
      kind: 'copied',
      newMode: '100755',
      newSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      oldMode: '100644',
      oldSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      path: 'assets/logo.png',
      previousPath: 'assets/old-logo.png',
      removed: 0,
      size: 2048,
      sizeDelta: 512,
      status: 'C',
      truncated: true,
    })
  } finally {
    globalThis.fetch = previousFetch
  }
})

test('rejects malformed review snapshot responses', async () => {
  const previousFetch = globalThis.fetch
  globalThis.fetch = async () => jsonResponse({ files: [], isGitRepo: true }, 200)
  try {
    await assert.rejects(
      () => loadReviewDiffSnapshot({ agentId: 'agent-1', source: 'working-copy' }),
      ReviewApiError
    )
  } finally {
    globalThis.fetch = previousFetch
  }
})

test('rejects review snapshots with empty identity fields', async () => {
  const previousFetch = globalThis.fetch
  try {
    globalThis.fetch = async () => jsonResponse({
      files: [],
      isGitRepo: true,
      patchset: '',
      reviewId: 'working-copy-test',
      root: '/workspace',
      truncated: false,
    })
    await assert.rejects(
      () => loadReviewDiffSnapshot({ agentId: 'agent-1', source: 'working-copy' }),
      /working copy response is invalid/
    )

    globalThis.fetch = async () => jsonResponse({
      basePatchset: '',
      files: [],
      isGitRepo: true,
      patchset: 'HEAD',
      reviewId: 'git-range-test',
      root: '/workspace',
      truncated: false,
    })
    await assert.rejects(
      () => loadReviewDiffSnapshot({ agentId: 'agent-1', base: 'HEAD~1', head: 'HEAD', source: 'git-range' }),
      /git range review response is invalid/
    )

    globalThis.fetch = async () => jsonResponse({
      basePatchset: 'HEAD~1',
      files: [],
      isGitRepo: true,
      patchset: 'HEAD',
      reviewId: '',
      root: '/workspace',
      truncated: false,
    })
    await assert.rejects(
      () => loadReviewDiffSnapshot({ agentId: 'agent-1', base: 'HEAD~1', head: 'HEAD', source: 'git-range' }),
      /git range review response is invalid/
    )
  } finally {
    globalThis.fetch = previousFetch
  }
})

test('rejects false binary flags before they enter ReviewFile', async () => {
  const previousFetch = globalThis.fetch
  globalThis.fetch = async () => jsonResponse({
    files: [{
      added: 1,
      binary: false,
      diff: { hunks: [] },
      kind: 'modified',
      path: 'src/review.ts',
      removed: 1,
    }],
    isGitRepo: true,
    patchset: 'Working copy abc',
    reviewId: 'working-copy-test',
    root: '/workspace',
    truncated: false,
  })
  try {
    await assert.rejects(
      () => loadReviewDiffSnapshot({ agentId: 'agent-1', source: 'working-copy' }),
      /working copy response is invalid/
    )
  } finally {
    globalThis.fetch = previousFetch
  }
})

test('rejects review snapshots whose explicit source conflicts with the endpoint', async () => {
  const previousFetch = globalThis.fetch
  try {
    globalThis.fetch = async () => jsonResponse({
      files: [],
      isGitRepo: true,
      patchset: 'Working copy abc',
      reviewId: 'working-copy-test',
      root: '/workspace',
      source: 'git-range',
      truncated: false,
    })
    await assert.rejects(
      () => loadReviewDiffSnapshot({ agentId: 'agent-1', source: 'working-copy' }),
      /working copy response is invalid/
    )

    globalThis.fetch = async () => jsonResponse({
      basePatchset: 'HEAD~1',
      files: [],
      isGitRepo: true,
      patchset: 'HEAD',
      reviewId: 'git-range-test',
      root: '/workspace',
      source: 'working-copy',
      truncated: false,
    })
    await assert.rejects(
      () => loadReviewDiffSnapshot({ agentId: 'agent-1', base: 'HEAD~1', head: 'HEAD', source: 'git-range' }),
      /git range review response is invalid/
    )
  } finally {
    globalThis.fetch = previousFetch
  }
})

test('rejects review snapshots with duplicate file paths', async () => {
  const duplicateFiles = [
    { added: 1, diff: { hunks: [] }, kind: 'modified', path: 'src/review.ts', removed: 1 },
    { added: 2, diff: { hunks: [] }, kind: 'modified', path: 'src/review.ts', removed: 0 },
  ]
  const previousFetch = globalThis.fetch
  try {
    globalThis.fetch = async () => jsonResponse({
      files: duplicateFiles,
      isGitRepo: true,
      patchset: 'Working copy abc',
      reviewId: 'working-copy-test',
      root: '/workspace',
      truncated: false,
    })
    await assert.rejects(
      () => loadReviewDiffSnapshot({ agentId: 'agent-1', source: 'working-copy' }),
      /working copy response is invalid/
    )

    globalThis.fetch = async () => jsonResponse({
      basePatchset: 'HEAD~1',
      files: duplicateFiles,
      isGitRepo: true,
      patchset: 'HEAD',
      reviewId: 'git-range-test',
      root: '/workspace',
      truncated: false,
    })
    await assert.rejects(
      () => loadReviewDiffSnapshot({ agentId: 'agent-1', base: 'HEAD~1', head: 'HEAD', source: 'git-range' }),
      /git range review response is invalid/
    )
  } finally {
    globalThis.fetch = previousFetch
  }
})

test('rejects review snapshots whose not-loaded files already contain inline hunks', async () => {
  const previousFetch = globalThis.fetch
  globalThis.fetch = async () => jsonResponse({
    files: [{
      added: 1,
      diff: {
        hunks: [{
          header: '@@ -1,1 +1,1 @@',
          oldStart: 1,
          oldLines: 1,
          newStart: 1,
          newLines: 1,
          rows: [{ kind: 'changed', left: { line: 1, text: 'old' }, right: { line: 1, text: 'new' } }],
        }],
      },
      diffLoaded: false,
      kind: 'modified',
      path: 'src/review.ts',
      removed: 1,
    }],
    isGitRepo: true,
    patchset: 'Working copy abc',
    reviewId: 'working-copy-test',
    root: '/workspace',
    truncated: false,
  })
  try {
    await assert.rejects(
      () => loadReviewDiffSnapshot({ agentId: 'agent-1', source: 'working-copy' }),
      /working copy response is invalid/
    )
  } finally {
    globalThis.fetch = previousFetch
  }
})

test('loads review patch text through the same request model', async () => {
  const calls: string[] = []
  const previousFetch = globalThis.fetch
  globalThis.fetch = async (input) => {
    calls.push(String(input))
    return new Response('diff --git a/src/review.ts b/src/review.ts\n', {
      headers: {
        'Content-Type': 'text/x-diff',
        'X-Farming-Review-Truncated': String(calls.length === 1),
      },
      status: 200,
    })
  }
  try {
    const workingCopyPatch = await loadReviewPatch({ agentId: 'agent-1', context: 25, ignoreWhitespace: 'ALL', limit: 5, source: 'working-copy' })
    assert.match(workingCopyPatch.text, /diff --git/)
    assert.equal(workingCopyPatch.truncated, true)
    const gitRangePatch = await loadReviewPatchText({ agentId: 'agent-1', base: 'HEAD~1', context: 100, head: 'HEAD', ignoreWhitespace: 'LEADING_AND_TRAILING', limit: 2, source: 'git-range' })
    assert.match(gitRangePatch, /diff --git/)
    const normalizedPatch = await loadReviewPatchText({ agentId: 'agent-1', context: -1, ignoreWhitespace: 'INVALID' as never, limit: 0, source: 'working-copy' })
    assert.match(normalizedPatch, /diff --git/)
    assert.equal(
      reviewPatchUrl({ agentId: 'agent-1', base: ' HEAD~1 ', context: 100, head: ' HEAD ', ignoreWhitespace: 'LEADING_AND_TRAILING', limit: 2, source: 'git-range' }),
      '/api/reviews/git-range/patch?agentId=agent-1&limit=2&context=100&ignoreWhitespace=LEADING_AND_TRAILING&base=HEAD%7E1&head=HEAD'
    )
    assert.deepEqual(calls, [
      '/api/reviews/working-copy/patch?agentId=agent-1&limit=5&context=25&ignoreWhitespace=ALL',
      '/api/reviews/git-range/patch?agentId=agent-1&limit=2&context=100&ignoreWhitespace=LEADING_AND_TRAILING&base=HEAD%7E1&head=HEAD',
      '/api/reviews/working-copy/patch?agentId=agent-1',
    ])
  } finally {
    globalThis.fetch = previousFetch
  }
})

test('omits invalid review limits at the transport boundary', async () => {
  const calls: string[] = []
  const previousFetch = globalThis.fetch
  globalThis.fetch = async (input) => {
    calls.push(String(input))
    return jsonResponse({
      basePatchset: 'HEAD~1',
      files: [],
      isGitRepo: true,
      patchset: 'HEAD',
      reviewId: 'git-range-test',
      root: '/workspace',
      truncated: false,
    })
  }
  try {
    await loadReviewDiffSnapshot({ agentId: 'agent-1', base: 'HEAD~1', head: 'HEAD', limit: Number.NaN, source: 'git-range' })
    await loadReviewDiffSnapshot({ agentId: 'agent-1', limit: -1, source: 'working-copy' })
    await loadReviewPatch({ agentId: 'agent-1', base: 'HEAD~1', head: 'HEAD', limit: 1.5, source: 'git-range' })
    assert.deepEqual(calls, [
      '/api/reviews/git-range?agentId=agent-1&base=HEAD%7E1&head=HEAD',
      '/api/reviews/working-copy?agentId=agent-1',
      '/api/reviews/git-range/patch?agentId=agent-1&base=HEAD%7E1&head=HEAD',
    ])
  } finally {
    globalThis.fetch = previousFetch
  }
})

test('loads single-file review diffs for lazy expansion', async () => {
  const calls: string[] = []
  const previousFetch = globalThis.fetch
  globalThis.fetch = async (input) => {
    calls.push(String(input))
    return jsonResponse({
      added: 1,
      diff: {
        hunks: [{
          header: '@@ -1,1 +1,1 @@',
          oldStart: 1,
          oldLines: 1,
          newStart: 1,
          newLines: 1,
          rows: [{
            dueToRebase: true,
            kind: 'changed',
            left: { line: 1, text: 'old' },
            moveDetails: { changed: true, range: { start: 10, end: 12 } },
            right: { line: 1, text: 'new' },
          }],
        }],
      },
      kind: 'modified',
      path: 'src/review.ts',
      removed: 1,
      status: 'M',
    })
  }
  try {
    const workingCopyFile = await loadWorkingCopyReviewFile('agent-1', 'src/review.ts', 'ALL', 25)
    assert.equal(workingCopyFile.path, 'src/review.ts')
    assert.deepEqual(workingCopyFile.diff.hunks[0]?.rows[0], {
      dueToRebase: true,
      kind: 'changed',
      left: { line: 1, text: 'old' },
      moveDetails: { changed: true, range: { start: 10, end: 12 } },
      right: { line: 1, text: 'new' },
    })
    const gitRangeFile = await loadGitRangeReviewFile('agent-1', 'HEAD~1', 'HEAD', 'src/review.ts', 'TRAILING', 10)
    assert.equal(gitRangeFile.path, 'src/review.ts')
    const genericWorkingCopyFile = await loadReviewFileDiff({ agentId: 'agent-1', context: 25, ignoreWhitespace: 'ALL', source: 'working-copy' }, 'src/review.ts')
    assert.equal(genericWorkingCopyFile.path, 'src/review.ts')
    const genericGitRangeFile = await loadReviewFileDiff({ agentId: 'agent-1', base: 'HEAD~1', context: 10, head: 'HEAD', ignoreWhitespace: 'TRAILING', source: 'git-range' }, 'src/review.ts')
    assert.equal(genericGitRangeFile.path, 'src/review.ts')
    assert.equal(
      reviewFileDiffUrl({ agentId: 'agent-1', base: ' HEAD~1 ', context: 10, head: ' HEAD ', ignoreWhitespace: 'TRAILING', source: 'git-range' }, 'src/review.ts'),
      '/api/reviews/git-range/files/src%2Freview.ts/diff?agentId=agent-1&context=10&ignoreWhitespace=TRAILING&base=HEAD%7E1&head=HEAD'
    )
    assert.deepEqual(calls, [
      '/api/reviews/working-copy/files/src%2Freview.ts/diff?agentId=agent-1&context=25&ignoreWhitespace=ALL',
      '/api/reviews/git-range/files/src%2Freview.ts/diff?agentId=agent-1&base=HEAD%7E1&head=HEAD&context=10&ignoreWhitespace=TRAILING',
      '/api/reviews/working-copy/files/src%2Freview.ts/diff?agentId=agent-1&context=25&ignoreWhitespace=ALL',
      '/api/reviews/git-range/files/src%2Freview.ts/diff?agentId=agent-1&context=10&ignoreWhitespace=TRAILING&base=HEAD%7E1&head=HEAD',
    ])
  } finally {
    globalThis.fetch = previousFetch
  }
})

test('loads one bounded common-line range without reloading the file diff', async () => {
  const calls: string[] = []
  const previousFetch = globalThis.fetch
  globalThis.fetch = async input => {
    calls.push(String(input))
    return jsonResponse({
      leftLines: 100,
      rightLines: 101,
      rows: [
        { kind: 'context', left: { line: 21, text: 'same 21' }, right: { line: 22, text: 'same 21' } },
        { kind: 'context', left: { line: 22, text: 'same 22' }, right: { line: 23, text: 'same 22' } },
      ],
    })
  }
  try {
    const range = { lines: 2, newStart: 22, oldStart: 21 }
    const result = await loadReviewFileContext({ agentId: 'agent-1', base: 'HEAD~1', head: 'HEAD', source: 'git-range' }, 'src/review.ts', range)
    assert.equal(result.rows.length, 2)
    assert.equal(
      reviewFileContextUrl({ agentId: 'agent-1', source: 'working-copy' }, 'src/review.ts', range),
      '/api/reviews/working-copy/files/src%2Freview.ts/context?agentId=agent-1&lines=2&newStart=22&oldStart=21'
    )
    assert.deepEqual(calls, [
      '/api/reviews/git-range/files/src%2Freview.ts/context?agentId=agent-1&lines=2&newStart=22&oldStart=21&base=HEAD%7E1&head=HEAD',
    ])
    await assert.rejects(
      () => loadReviewFileContext({ agentId: 'agent-1', source: 'working-copy' }, 'src/review.ts', { lines: 0, newStart: 1, oldStart: 1 }),
      /review context lines is invalid/
    )
  } finally {
    globalThis.fetch = previousFetch
  }
})

test('rejects metadata-only files from single-file diff endpoints', async () => {
  const previousFetch = globalThis.fetch
  globalThis.fetch = async () => jsonResponse({
    added: 1,
    diff: { hunks: [] },
    diffLoaded: false,
    kind: 'modified',
    path: 'src/review.ts',
    removed: 1,
    status: 'M',
  })
  try {
    await assert.rejects(
      () => loadWorkingCopyReviewFile('agent-1', 'src/review.ts'),
      ReviewApiError
    )
  } finally {
    globalThis.fetch = previousFetch
  }
})

test('accepts truncated loaded-negative files from single-file diff endpoints', async () => {
  const previousFetch = globalThis.fetch
  globalThis.fetch = async () => jsonResponse({
    added: 1,
    diff: { hunks: [], truncated: true },
    diffLoaded: false,
    kind: 'modified',
    path: 'src/review.ts',
    removed: 1,
    status: 'M',
  })
  try {
    const file = await loadWorkingCopyReviewFile('agent-1', 'src/review.ts')
    assert.equal(file.diffLoaded, false)
    assert.equal(file.diff.truncated, true)
  } finally {
    globalThis.fetch = previousFetch
  }
})

test('rejects single-file diff responses for a different review path', async () => {
  const previousFetch = globalThis.fetch
  globalThis.fetch = async () => jsonResponse({
    added: 1,
    diff: {
      hunks: [{
        header: '@@ -1,1 +1,1 @@',
        oldStart: 1,
        oldLines: 1,
        newStart: 1,
        newLines: 1,
        rows: [{ kind: 'changed', left: { line: 1, text: 'old' }, right: { line: 1, text: 'new' } }],
      }],
    },
    kind: 'modified',
    path: 'src/other.ts',
    removed: 1,
    status: 'M',
  })
  try {
    await assert.rejects(
      () => loadWorkingCopyReviewFile('agent-1', 'src/review.ts'),
      /review file diff request failed/
    )
    await assert.rejects(
      () => loadGitRangeReviewFile('agent-1', 'HEAD~1', 'HEAD', 'src/review.ts'),
      /review git range file diff request failed/
    )
  } finally {
    globalThis.fetch = previousFetch
  }
})

test('rejects invalid single-file diff request paths before fetch', async () => {
  const calls: string[] = []
  const previousFetch = globalThis.fetch
  globalThis.fetch = async (input) => {
    calls.push(String(input))
    return jsonResponse({ error: 'should not be requested' }, 500)
  }
  try {
    await assert.rejects(
      () => loadReviewFileDiff({ agentId: 'agent-1', source: 'working-copy' }, '../outside.ts'),
      /review file path is invalid/
    )
    await assert.rejects(
      () => loadReviewFileDiff({ agentId: 'agent-1', base: 'HEAD~1', head: 'HEAD', source: 'git-range' }, '/absolute.ts'),
      /review file path is invalid/
    )
    assert.deepEqual(calls, [])
  } finally {
    globalThis.fetch = previousFetch
  }
})

test('loads single-file review diffs with structured file metadata', async () => {
  const previousFetch = globalThis.fetch
  globalThis.fetch = async () => jsonResponse({
    added: 0,
    binary: true,
    diff: {
      hunks: [],
      leftMeta: {
        contentType: 'image/jpeg',
        language: 'image',
        lines: 66,
        name: 'old-carrot.jpg',
        syntaxTree: [{ name: 'image', range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 1 } }],
        webLinks: [{ name: 'base', url: 'https://example.test/base' }],
      },
      rightMeta: {
        contentType: 'image/jpeg',
        lines: 560,
        name: 'carrot.jpg',
        webLinks: [{ name: 'revision', url: 'https://example.test/revision' }],
      },
    },
    kind: 'modified',
    path: 'assets/carrot.jpg',
    removed: 0,
    status: 'M',
  })
  try {
    const file = await loadWorkingCopyReviewFile('agent-1', 'assets/carrot.jpg')
    assert.deepEqual(file.diff.leftMeta, {
      contentType: 'image/jpeg',
      language: 'image',
      lines: 66,
      name: 'old-carrot.jpg',
      syntaxTree: [{ name: 'image', range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 1 } }],
      webLinks: [{ name: 'base', url: 'https://example.test/base' }],
    })
    assert.deepEqual(file.diff.rightMeta, {
      contentType: 'image/jpeg',
      lines: 560,
      name: 'carrot.jpg',
      webLinks: [{ name: 'revision', url: 'https://example.test/revision' }],
    })
  } finally {
    globalThis.fetch = previousFetch
  }
})

test('surfaces review patch API errors', async () => {
  const previousFetch = globalThis.fetch
  globalThis.fetch = async () => jsonResponse({ error: 'git diff failed' }, 500)
  try {
    await assert.rejects(
      () => loadReviewPatchText({ agentId: 'agent-1', base: 'HEAD~1', head: 'HEAD', source: 'git-range' }),
      /git diff failed/
    )
  } finally {
    globalThis.fetch = previousFetch
  }
})

test('rejects invalid git range revisions before fetch', async () => {
  const calls: string[] = []
  const previousFetch = globalThis.fetch
  globalThis.fetch = async (input) => {
    calls.push(String(input))
    return jsonResponse({ error: 'should not be requested' }, 500)
  }
  try {
    await assert.rejects(
      () => loadReviewDiffSnapshot({ agentId: 'agent-1', base: '', head: 'HEAD', source: 'git-range' }),
      /base and head revisions are invalid/
    )
    await assert.rejects(
      () => loadReviewFileDiff({ agentId: 'agent-1', base: 'HEAD~1', head: '-bad', source: 'git-range' }, 'src/review.ts'),
      /base and head revisions are invalid/
    )
    await assert.rejects(
      () => loadGitRangeReviewFile('agent-1', 'HEAD bad', 'HEAD', 'src/review.ts'),
      /base and head revisions are invalid/
    )
    await assert.rejects(
      () => loadReviewPatch({ agentId: 'agent-1', base: 'HEAD~1', head: 'HEAD bad', source: 'git-range' }),
      /base and head revisions are invalid/
    )
    assert.deepEqual(calls, [])
  } finally {
    globalThis.fetch = previousFetch
  }
})

test('rejects review diff hunks without structured ranges', async () => {
  const previousFetch = globalThis.fetch
  globalThis.fetch = async () => jsonResponse({
    added: 1,
    diff: {
      hunks: [{
        header: '@@ -1,1 +1,1 @@',
        rows: [{
          kind: 'changed',
          left: { line: 1, text: 'old' },
          right: { line: 1, text: 'new' },
        }],
      }],
    },
    kind: 'modified',
    path: 'src/review.ts',
    removed: 1,
    status: 'M',
  })
  try {
    await assert.rejects(
      () => loadWorkingCopyReviewFile('agent-1', 'src/review.ts'),
      ReviewApiError
    )
  } finally {
    globalThis.fetch = previousFetch
  }
})

test('rejects review diff hunks whose structured ranges disagree with rows', async () => {
  const previousFetch = globalThis.fetch
  globalThis.fetch = async () => jsonResponse({
    added: 1,
    diff: {
      hunks: [{
        header: '@@ -1,1 +1,2 @@',
        oldStart: 1,
        oldLines: 1,
        newStart: 1,
        newLines: 2,
        rows: [{
          kind: 'changed',
          left: { line: 1, text: 'old' },
          right: { line: 1, text: 'new' },
        }],
      }],
    },
    kind: 'modified',
    path: 'src/review.ts',
    removed: 1,
    status: 'M',
  })
  try {
    await assert.rejects(
      () => loadWorkingCopyReviewFile('agent-1', 'src/review.ts'),
      ReviewApiError
    )
  } finally {
    globalThis.fetch = previousFetch
  }
})

test('accepts review diff hunk ranges that include Gerrit-style skipped rows', async () => {
  const previousFetch = globalThis.fetch
  globalThis.fetch = async () => jsonResponse({
    added: 1,
    diff: {
      hunks: [{
        header: '@@ -1,4 +1,5 @@',
        oldStart: 1,
        oldLines: 4,
        newStart: 1,
        newLines: 5,
        rows: [
          { kind: 'skipped', leftLines: 3, rightLines: 4 },
          {
            kind: 'changed',
            left: { line: 4, text: 'old' },
            right: { line: 5, text: 'new' },
          },
        ],
      }],
    },
    kind: 'modified',
    path: 'src/review.ts',
    removed: 1,
    status: 'M',
  })
  try {
    const file = await loadWorkingCopyReviewFile('agent-1', 'src/review.ts')
    assert.deepEqual(file.diff.hunks[0] && {
      newLines: file.diff.hunks[0].newLines,
      newStart: file.diff.hunks[0].newStart,
      oldLines: file.diff.hunks[0].oldLines,
      oldStart: file.diff.hunks[0].oldStart,
    }, {
      newLines: 5,
      newStart: 1,
      oldLines: 4,
      oldStart: 1,
    })
  } finally {
    globalThis.fetch = previousFetch
  }
})

test('rejects malformed review row metadata without leaking validator errors', async () => {
  const previousFetch = globalThis.fetch
  globalThis.fetch = async () => jsonResponse({
    added: 1,
    diff: {
      hunks: [{
        header: '@@ -1,1 +1,1 @@',
        oldStart: 1,
        oldLines: 1,
        newStart: 1,
        newLines: 1,
        rows: [{
          kind: 'changed',
          left: { line: 1, text: 'old' },
          moveDetails: { changed: true, range: null },
          right: { line: 1, text: 'new' },
        }],
      }],
    },
    kind: 'modified',
    path: 'src/review.ts',
    removed: 1,
    status: 'M',
  })
  try {
    await assert.rejects(
      () => loadWorkingCopyReviewFile('agent-1', 'src/review.ts'),
      ReviewApiError
    )
  } finally {
    globalThis.fetch = previousFetch
  }
})

test('rejects malformed review file metadata', async () => {
  const previousFetch = globalThis.fetch
  try {
    globalThis.fetch = async () => jsonResponse({
      added: 1,
      diff: {
        hunks: [],
        leftMeta: {
          contentType: 'text/plain',
          lines: -1,
          name: 'src/review.ts',
        },
      },
      kind: 'modified',
      path: 'src/review.ts',
      removed: 1,
      status: 'M',
    })
    await assert.rejects(
      () => loadWorkingCopyReviewFile('agent-1', 'src/review.ts'),
      ReviewApiError
    )

    globalThis.fetch = async () => jsonResponse({
      added: 1,
      diff: { hunks: [] },
      kind: 'modified',
      path: 'src/review.ts',
      removed: 1,
      status: 'M',
      truncated: 'yes',
    })
    await assert.rejects(
      () => loadWorkingCopyReviewFile('agent-1', 'src/review.ts'),
      ReviewApiError
    )
  } finally {
    globalThis.fetch = previousFetch
  }
})

test('uses Gerrit-style reviewed file endpoints', async () => {
  const calls: Array<{ input: string; method: string }> = []
  const previousFetch = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    calls.push({ input: String(input), method: init?.method ?? 'GET' })
    if (String(input).includes('/files?reviewed')) {
      return new Response(JSON.stringify(['src/review.ts']), {
        headers: {
          'Content-Type': 'application/json',
          'X-Farming-Review-Revision': '2',
        },
        status: 200,
      })
    }
    return new Response(null, { status: 204 })
  }
  try {
    const loaded = await loadReviewedFiles('change 1', 'Patchset 2')
    assert.deepEqual(loaded, { reviewedPaths: ['src/review.ts'], revision: 2 })
    const loadedGitRef = await loadReviewedFiles('git-range-a1b2c3', 'origin/master')
    assert.deepEqual(loadedGitRef, { reviewedPaths: ['src/review.ts'], revision: 2 })
    const saved = await saveReviewedFilesStatus({
      changes: [
        { path: 'src/review.ts', reviewed: false },
        { path: 'docs/review.md', reviewed: true },
        { path: '/COMMIT_MSG', reviewed: true },
      ],
      patchset: 'Patchset 2',
      reviewId: 'change 1',
      revision: 2,
    })
    assert.deepEqual(saved, { reviewedPaths: ['src/review.ts'], revision: 2 })
    assert.deepEqual(calls, [
      { input: '/api/reviews/change%201/revisions/Patchset%202/files?reviewed', method: 'GET' },
      { input: '/api/reviews/git-range-a1b2c3/revisions/origin%2Fmaster/files?reviewed', method: 'GET' },
      { input: '/api/reviews/change%201/revisions/Patchset%202/files/src%2Freview.ts/reviewed', method: 'DELETE' },
      { input: '/api/reviews/change%201/revisions/Patchset%202/files/docs%2Freview.md/reviewed', method: 'PUT' },
      { input: '/api/reviews/change%201/revisions/Patchset%202/files/%2FCOMMIT_MSG/reviewed', method: 'PUT' },
      { input: '/api/reviews/change%201/revisions/Patchset%202/files?reviewed', method: 'GET' },
    ])
  } finally {
    globalThis.fetch = previousFetch
  }
})

test('rejects malformed Gerrit-style reviewed file responses', async () => {
  const previousFetch = globalThis.fetch
  try {
    globalThis.fetch = async () => jsonResponse({ error: 'not found' }, 404)
    await assert.rejects(
      () => loadReviewedFiles('change_1', 'Patchset 2'),
      /not found/
    )

    globalThis.fetch = async () => jsonResponse(['src/review.ts', 'src/review.ts'])
    await assert.rejects(
      () => loadReviewedFiles('change_1', 'Patchset 2'),
      /reviewed files request failed/
    )
  } finally {
    globalThis.fetch = previousFetch
  }
})

test('rejects invalid Gerrit-style reviewed requests before fetch', async () => {
  const calls: string[] = []
  const previousFetch = globalThis.fetch
  globalThis.fetch = async (input) => {
    calls.push(String(input))
    return jsonResponse({ error: 'should not be requested' }, 500)
  }
  try {
    await assert.rejects(
      () => loadReviewedFiles('', 'Patchset 2'),
      /review identity is invalid/
    )
    await assert.rejects(
      () => saveReviewedFileStatus({
        patchset: 'Patchset 2',
        path: '../outside.ts',
        reviewId: 'change 1',
        reviewed: true,
        revision: 2,
      }),
      /review file path is invalid/
    )
    await assert.rejects(
      () => saveReviewedFilesStatus({
        changes: [
          { path: 'src/review.ts', reviewed: false },
          { path: 'src/review.ts', reviewed: true },
        ],
        patchset: 'Patchset 2',
        reviewId: 'change 1',
        revision: 2,
      }),
      /review status changes are invalid/
    )
    assert.deepEqual(calls, [])
  } finally {
    globalThis.fetch = previousFetch
  }
})

test('attaches authoritative reviewed state when a Gerrit-style reviewed write fails', async () => {
  const calls: Array<{ input: string; method: string }> = []
  const previousFetch = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    calls.push({ input: String(input), method: init?.method ?? 'GET' })
    if (String(input).endsWith('/files/src%2Freview.ts/reviewed')) return new Response(null, { status: 204 })
    if (String(input).endsWith('/files/docs%2Freview.md/reviewed')) return jsonResponse({ error: 'permission denied' }, 403)
    if (String(input).includes('/files?reviewed')) {
      return new Response(JSON.stringify(['docs/current.md']), {
        headers: {
          'Content-Type': 'application/json',
          'X-Farming-Review-Revision': '9',
        },
        status: 200,
      })
    }
    return jsonResponse({ error: 'unexpected request' }, 500)
  }
  try {
    await assert.rejects(
      async () => saveReviewedFilesStatus({
        changes: [
          { path: 'src/review.ts', reviewed: false },
          { path: 'docs/review.md', reviewed: true },
        ],
        patchset: 'Patchset 2',
        reviewId: 'change 1',
        revision: 2,
      }),
      (error: unknown) => {
        assert.equal(error instanceof ReviewApiError, true)
        assert.equal((error as ReviewApiError).message, 'permission denied')
        assert.deepEqual((error as ReviewApiError).state, {
          reviewedPaths: ['docs/current.md'],
          revision: 9,
        })
        return true
      }
    )
    assert.deepEqual(calls, [
      { input: '/api/reviews/change%201/revisions/Patchset%202/files/src%2Freview.ts/reviewed', method: 'DELETE' },
      { input: '/api/reviews/change%201/revisions/Patchset%202/files/docs%2Freview.md/reviewed', method: 'PUT' },
      { input: '/api/reviews/change%201/revisions/Patchset%202/files?reviewed', method: 'GET' },
    ])
  } finally {
    globalThis.fetch = previousFetch
  }
})

test('rejects invalid review state identities before fetch', async () => {
  const calls: string[] = []
  const previousFetch = globalThis.fetch
  globalThis.fetch = async (input) => {
    calls.push(String(input))
    return jsonResponse({ error: 'should not be requested' }, 500)
  }
  try {
    await assert.rejects(
      () => loadReviewedFiles('-change', 'Patchset 2'),
      /review identity is invalid/
    )
    await assert.rejects(
      () => loadReviewedFiles('change_1', 'bad\npatchset'),
      /review identity is invalid/
    )
    await assert.rejects(
      () => loadReviewComments('change_1', '-patchset'),
      /review identity is invalid/
    )
    await assert.rejects(
      () => saveReviewComment('change_1', {
        body: 'Looks good.',
        id: 'comment-1',
        line: 1,
        patchset: '\tPatchset 2',
        path: 'src/review.ts',
        side: 'right',
      }),
      /review identity is invalid/
    )
    await assert.rejects(
      () => saveReviewComment('change_1', {
        body: 'Escapes the review root.',
        id: 'comment-1',
        line: 1,
        patchset: 'Patchset 2',
        path: '../outside.ts',
        side: 'right',
      }),
      /review comment is invalid/
    )
    await assert.rejects(
      () => deleteReviewComment('change_1', 'Patchset 2', '../comment'),
      /review comment id is invalid/
    )
    assert.deepEqual(calls, [])
  } finally {
    globalThis.fetch = previousFetch
  }
})
