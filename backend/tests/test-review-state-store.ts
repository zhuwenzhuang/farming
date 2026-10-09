const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ReviewStateStore } = require('../review-state-store.cjs');

function run() {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-review-state-'));
  try {
    const store = new ReviewStateStore(configDir, {
      seedReviews: {
        change_1: {
          patchsets: {
            'Patchset 2': { reviewedPaths: ['src/app.ts'], revision: 0 },
          },
        },
      },
    });

    assert.deepStrictEqual(store.getPatchsetState('change_1', 'Patchset 2'), {
      comments: [],
      reviewedPaths: ['src/app.ts'],
      revision: 0,
    });
    assert.strictEqual(fs.existsSync(path.join(configDir, 'history', 'review-state.json')), false);

    const savedResult = store.setFileReviewedGerrit({
      reviewId: 'change_1',
      patchset: 'Patchset 2',
      path: 'src/review.ts',
      reviewed: true,
    });
    assert.strictEqual(savedResult.changed, true);
    const saved = savedResult.state;
    assert.deepStrictEqual(saved, {
      comments: [],
      reviewedPaths: ['src/app.ts', 'src/review.ts'],
      revision: 1,
    });

    const savedComment = store.saveComment({
      reviewId: 'change_1',
      patchset: 'Patchset 2',
      comment: {
        body: 'Keep the range explicit.',
        id: 'comment-1',
        line: 24,
        patchset: 'Patchset 2',
        path: 'src/review.ts',
        side: 'right',
      },
    });
    assert.deepStrictEqual(savedComment, {
      body: 'Keep the range explicit.',
      id: 'comment-1',
      line: 24,
      patchset: 'Patchset 2',
      path: 'src/review.ts',
      side: 'right',
    });
    assert.deepStrictEqual(store.getComments('change_1', 'Patchset 2'), [savedComment]);

    const savedRangeComment = store.saveComment({
      reviewId: 'change_1',
      patchset: 'Patchset 2',
      comment: {
        body: 'This whole expression should be simplified.',
        id: 'comment-range',
        line: 26,
        patchset: 'Patchset 2',
        path: 'src/review.ts',
        range: { start_line: 24, start_character: 4, end_line: 26, end_character: 18 },
        side: 'right',
      },
    });
    assert.deepStrictEqual(savedRangeComment.range, { start_line: 24, start_character: 4, end_line: 26, end_character: 18 });
    assert.throws(() => store.saveComment({
      reviewId: 'change_1',
      patchset: 'Patchset 2',
      comment: {
        body: 'Empty range.',
        id: 'comment-empty-range',
        line: 24,
        patchset: 'Patchset 2',
        path: 'src/review.ts',
        range: { start_line: 24, start_character: 4, end_line: 24, end_character: 4 },
        side: 'right',
      },
    }), /invalid review comment/);

    assert.deepStrictEqual(store.setFileReviewedGerrit({
      reviewId: 'change_1',
      patchset: 'Patchset 2',
      path: 'src/review.ts',
      reviewed: true,
    }), { changed: false, state: { ...saved, comments: [savedComment, savedRangeComment] } }, 'replaying the desired review state is idempotent');

    const removedAppResult = store.setFileReviewedGerrit({
      reviewId: 'change_1',
      patchset: 'Patchset 2',
      path: 'src/app.ts',
      reviewed: false,
    });
    assert.strictEqual(removedAppResult.changed, true);
    const removedApp = removedAppResult.state;
    assert.deepStrictEqual(removedApp, {
      comments: [savedComment, savedRangeComment],
      reviewedPaths: ['src/review.ts'],
      revision: 2,
    });

    const gerritSavedResult = store.setFileReviewedGerrit({
      reviewId: 'change_1',
      patchset: 'Patchset 2',
      path: 'src/other.ts',
      reviewed: true,
    });
    assert.strictEqual(gerritSavedResult.changed, true);
    const gerritSaved = gerritSavedResult.state;
    assert.deepStrictEqual(gerritSaved, {
      comments: [savedComment, savedRangeComment],
      reviewedPaths: ['src/review.ts', 'src/other.ts'],
      revision: 3,
    });
    assert.deepStrictEqual(store.setFileReviewedGerrit({
      reviewId: 'change_1',
      patchset: 'Patchset 2',
      path: 'src/other.ts',
      reviewed: true,
    }), { changed: false, state: gerritSaved }, 'Gerrit-style single-file status update is idempotent');

    const gitRefPatchsetResult = store.setFileReviewedGerrit({
      reviewId: 'git-range-a1b2c3',
      patchset: 'origin/master',
      path: 'src/ref-reviewed.ts',
      reviewed: true,
    });
    assert.strictEqual(gitRefPatchsetResult.changed, true);
    assert.deepStrictEqual(gitRefPatchsetResult.state, {
      comments: [],
      reviewedPaths: ['src/ref-reviewed.ts'],
      revision: 1,
    });
    assert.deepStrictEqual(store.getPatchsetState('git-range-a1b2c3', 'origin/master'), gitRefPatchsetResult.state);

    const gitRevisionPatchsetResult = store.setFileReviewedGerrit({
      reviewId: 'git-range-a1b2c3',
      patchset: 'HEAD^',
      path: 'src/head-parent.ts',
      reviewed: true,
    });
    assert.deepStrictEqual(gitRevisionPatchsetResult.state.reviewedPaths, ['src/head-parent.ts']);

    const prototypeNamedReviewResult = store.setFileReviewedGerrit({
      reviewId: 'toString',
      patchset: 'refs/heads/topic',
      path: 'src/prototype-safe.ts',
      reviewed: true,
    });
    assert.deepStrictEqual(prototypeNamedReviewResult.state, {
      comments: [],
      reviewedPaths: ['src/prototype-safe.ts'],
      revision: 1,
    });
    assert.deepStrictEqual(store.getPatchsetState('toString', 'refs/heads/topic'), prototypeNamedReviewResult.state);

    const longGitRef = `refs/heads/${'feature-'.repeat(22)}topic`;
    assert.strictEqual(longGitRef.length > 160 && longGitRef.length <= 200, true);
    const longGitRefPatchsetResult = store.setFileReviewedGerrit({
      reviewId: 'git-range-a1b2c3',
      patchset: longGitRef,
      path: 'src/long-ref-reviewed.ts',
      reviewed: true,
    });
    assert.deepStrictEqual(longGitRefPatchsetResult.state, {
      comments: [],
      reviewedPaths: ['src/long-ref-reviewed.ts'],
      revision: 1,
    });

    const specialPathSavedResult = store.setFileReviewedGerrit({
      reviewId: 'change_1',
      patchset: 'Patchset 2',
      path: '/COMMIT_MSG',
      reviewed: true,
    });
    assert.strictEqual(specialPathSavedResult.changed, true);
    const specialPathSaved = specialPathSavedResult.state;
    assert.deepStrictEqual(specialPathSaved.reviewedPaths, ['src/review.ts', 'src/other.ts', '/COMMIT_MSG']);

    const reloaded = new ReviewStateStore(configDir, {
      seedReviews: {
        change_1: { patchsets: { 'Patchset 2': { reviewedPaths: ['ignored.ts'], revision: 0 } } },
      },
    });
    assert.deepStrictEqual(reloaded.getPatchsetState('change_1', 'Patchset 2'), specialPathSaved);
    assert.deepStrictEqual(reloaded.deleteComment({
      reviewId: 'change_1',
      patchset: 'Patchset 2',
      commentId: 'comment-1',
    }), [savedRangeComment]);
    assert.throws(() => reloaded.saveComment({
      reviewId: 'change_1',
      patchset: 'Patchset 2',
      comment: { body: '', id: 'bad', line: 0, patchset: 'Patchset 2', path: '../outside.ts', side: 'right' },
    }), /invalid review comment/);
    assert.throws(() => store.setFileReviewedGerrit({
      reviewId: 'change_1',
      patchset: 'Patchset 2',
      path: '../outside.ts',
      reviewed: true,
    }), /invalid review status request/);

    store.saveComment({
      reviewId: 'status-review',
      patchset: 'revision-1',
      comment: { body: 'Resolve this.', id: 'status-note', line: 3, patchset: 'revision-1', path: 'src/status.ts', side: 'right', status: 'open' },
    });
    assert.strictEqual(store.updateCommentStatus({
      reviewId: 'status-review',
      patchset: 'revision-1',
      commentId: 'status-note',
      status: 'resolved',
    }).status, 'resolved');
    assert.strictEqual(store.updateCommentStatus({
      reviewId: 'status-review',
      patchset: 'revision-1',
      commentId: 'status-note',
      status: 'open',
    }).status, 'open');

    store.inheritPatchset({ reviewId: 'status-review', previousPatchset: 'revision-1', nextPatchset: 'revision-2', changedPaths: ['src/status.ts'] });
    const statusInput = { reviewId: 'status-review', patchset: 'revision-2', commentId: 'status-note' };
    const outdated = store.getComments('status-review', 'revision-2')[0];
    assert.strictEqual(outdated.outdated, true);
    assert.strictEqual(outdated.status, 'open');
    assert.strictEqual(outdated.sourcePatchset, 'revision-1');
    for (const status of ['resolved', 'open', 'resolved']) {
      const updated = store.updateCommentStatus({ ...statusInput, status });
      assert.strictEqual(updated.status, status);
      assert.strictEqual(updated.outdated, true);
      assert.strictEqual(updated.sourcePatchset, 'revision-1');
    }
    const inheritedAgain = store.inheritPatchset({
      reviewId: 'status-review', previousPatchset: 'revision-2', nextPatchset: 'revision-3', changedPaths: ['src/status.ts'],
      preservedAnchors: { 'status-note': { line: 99 } },
    }).comments[0];
    assert.strictEqual(inheritedAgain.line, 3, 'an outdated anchor cannot be reattached');
    assert.strictEqual(inheritedAgain.status, 'resolved');
    assert.strictEqual(inheritedAgain.sourcePatchset, 'revision-1');
    assert.strictEqual(inheritedAgain.outdated, true);
    const writeJson = store.writeJson;
    store.writeJson = () => { throw new Error('injected write failure'); };
    assert.throws(() => store.updateCommentStatus({ ...statusInput, status: 'open' }), /injected write failure/);
    assert.strictEqual(store.getComments('status-review', 'revision-2')[0].status, 'resolved');
    store.writeJson = writeJson;
    const restarted = new ReviewStateStore(configDir);
    assert.deepStrictEqual(restarted.getComments('status-review', 'revision-2')[0], { ...outdated, status: 'resolved' });

    const legacyFile = path.join(configDir, 'legacy.json');
    fs.writeFileSync(legacyFile, JSON.stringify({ reviews: { legacy: { patchsets: { 'revision-2': {
      comments: [
        { ...outdated, outdated: undefined, status: 'outdated', id: 'legacy-open' },
        { ...outdated, outdated: undefined, status: 'resolved', id: 'legacy-resolved' },
      ], reviewedPaths: [], revision: 0,
    } } } } }));
    const legacy = new ReviewStateStore(configDir, { file: legacyFile });
    const migrated = legacy.getComments('legacy', 'revision-2');
    assert.deepStrictEqual(migrated.map(comment => [comment.status, comment.outdated]), [['open', true], ['resolved', true]]);
    legacy.updateCommentStatus({ reviewId: 'legacy', patchset: 'revision-2', commentId: 'legacy-open', status: 'resolved' });
    assert.strictEqual(new ReviewStateStore(configDir, { file: legacyFile }).getComments('legacy', 'revision-2')[0].outdated, true);

    console.log('test-review-state-store passed');
  } finally {
    fs.rmSync(configDir, { recursive: true, force: true });
  }
}

run();
