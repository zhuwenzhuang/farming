import { reviewFileHasLoadedNegativeDiff, type ReviewAction, type ReviewCatalog, type ReviewEffect, type ReviewFile } from './state'
import { reviewCatalogWithFile } from './snapshot'

export type ReviewFileDiffLoadEffect = Extract<ReviewEffect, { type: 'load-file-diff' }>
export type ReviewFileDiffLoadCommitAction = Extract<ReviewAction, { type: 'commit-file-diff-load' }>
export type ReviewFileDiffLoadFailAction = Extract<ReviewAction, { type: 'fail-file-diff-load' }>

export type ReviewFileDiffLoadResult = {
  action: ReviewFileDiffLoadCommitAction
  catalog: ReviewCatalog
}

function errorMessage(error: unknown) {
  if (error instanceof Error && error.message.trim()) return error.message.trim()
  if (typeof error === 'string' && error.trim()) return error.trim()
  return 'review file diff request failed'
}

function isMetadataOnlyReviewFile(file: ReviewFile) {
  return file.diffLoaded === false && !reviewFileHasLoadedNegativeDiff(file)
}

export function completeReviewFileDiffLoad(
  catalog: ReviewCatalog,
  effect: ReviewFileDiffLoadEffect,
  file: ReviewFile,
  context: { reviewId?: string } = {}
): ReviewFileDiffLoadResult {
  if (effect.reviewId !== undefined && context.reviewId !== effect.reviewId) {
    throw new Error('loaded review file belongs to a stale review')
  }
  if (file.path !== effect.path) {
    throw new Error('loaded review file path does not match requested path')
  }
  if (isMetadataOnlyReviewFile(file)) {
    throw new Error('loaded review file is still a metadata-only row')
  }
  const currentFiles = catalog[effect.patchset]
  if (!currentFiles?.some(current => current.path === effect.path)) {
    throw new Error('loaded review file path is no longer in the review catalog')
  }
  return {
    action: {
      patchset: effect.patchset,
      path: effect.path,
      ...(effect.reviewId ? { reviewId: effect.reviewId } : {}),
      type: 'commit-file-diff-load',
    },
    catalog: reviewCatalogWithFile(catalog, effect.patchset, { ...file, diffLoaded: true }),
  }
}

export function failReviewFileDiffLoad(
  effect: ReviewFileDiffLoadEffect,
  error: unknown
): ReviewFileDiffLoadFailAction {
  return {
    error: errorMessage(error),
    patchset: effect.patchset,
    path: effect.path,
    ...(effect.reviewId ? { reviewId: effect.reviewId } : {}),
    type: 'fail-file-diff-load',
  }
}
