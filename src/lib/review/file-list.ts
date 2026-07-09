import type { ReviewFile, ReviewState, ReviewStatusChange } from './state'
import { isReviewSpecialFilePath, reviewCommentPathsForFile, reviewFileDiffLoadError, reviewFileHasLoadedNegativeDiff, reviewFileState, reviewStateForPatchset } from './state'

export type ReviewFileRowAction = {
  ariaLabel: 'Mark as reviewed' | 'Mark as unreviewed'
  disabled: boolean
  label: 'MARK REVIEWED' | 'MARK UNREVIEWED'
  nextReviewed: boolean
  visibility: 'on-row-interaction'
}

export type ReviewFileRowModel = {
  action: ReviewFileRowAction | null
  added: number
  binary: boolean
  changeLabel: 'A' | 'C' | 'D' | 'M' | 'R' | 'U' | 'W' | 'X'
  commentPaths: string[]
  deleted: number
  diffLoadError?: string
  diffLoadPending: boolean
  diffStatus: 'binary' | 'loaded' | 'not-loaded' | 'too-expensive'
  diffTooExpensive: boolean
  expanded: boolean
  newMode?: string
  newSha?: string
  oldMode?: string
  oldSha?: string
  path: string
  pending: boolean
  previousPath?: string
  reviewed: boolean | null
  reviewStatusLoaded: boolean
  reviewedLabel: 'Reviewed' | null
  size?: number
  sizeDelta?: number
}

export type ReviewFileListToolbarModel = {
  markAllReviewed: {
    changes: ReviewStatusChange[]
    disabled: boolean
    label: 'MARK ALL REVIEWED'
  }
  markAllUnreviewed: {
    changes: ReviewStatusChange[]
    disabled: boolean
    label: 'MARK ALL UNREVIEWED'
  }
  reviewedStatusLoaded: boolean
  reviewableCount: number
}

export type ReviewFileListSections = {
  displayFiles: ReviewFile[]
  modifiedFiles: ReviewFile[]
  showUnmodifiedSeparator: boolean
  unmodifiedFiles: ReviewFile[]
}

export type ReviewFileListStats = {
  additions: number
  binarySizeDeltaDeleted: number
  binarySizeDeltaInserted: number
  binaryTotalSize: number
  deletions: number
  maxAdded: number
  maxDeleted: number
}

export type ReviewFileNavigationDirection = 'next' | 'previous'
export type ReviewUnreviewedNavigationDirection = ReviewFileNavigationDirection

export type ReviewMarkReviewedNavigationIntent = {
  changes: ReviewStatusChange[]
  mutationPending: boolean
  nextPath: string | null
  reviewedStatusLoaded: boolean
}

export function isReviewFileUnmodified(file: ReviewFile) {
  return file.status === 'U' || file.kind === 'unmodified'
}

export function reviewFileListSections(files: readonly ReviewFile[]): ReviewFileListSections {
  const modified = files.filter(file => !isReviewFileUnmodified(file))
  const unmodified = files.filter(isReviewFileUnmodified)
  return {
    displayFiles: [...modified, ...unmodified],
    modifiedFiles: modified,
    showUnmodifiedSeparator: modified.length > 0 && unmodified.length > 0,
    unmodifiedFiles: unmodified,
  }
}

export function reviewFileListDisplayFiles(files: readonly ReviewFile[]): ReviewFile[] {
  return reviewFileListSections(files).displayFiles
}

export function reviewFileListReviewableFiles(files: readonly ReviewFile[]): ReviewFile[] {
  return reviewFileListSections(files).displayFiles
}

export function reviewAdjacentFilePath(
  files: readonly ReviewFile[],
  currentPath: string,
  direction: ReviewFileNavigationDirection = 'next'
) {
  const paths = reviewFileListDisplayFiles(files).map(file => file.path)
  const currentIndex = paths.indexOf(currentPath)
  if (currentIndex === -1) return null
  const nextIndex = direction === 'next' ? currentIndex + 1 : currentIndex - 1
  return paths[nextIndex] ?? null
}

export function reviewFileListStats(files: readonly ReviewFile[]): ReviewFileListStats {
  return files
    .filter(file => !isReviewSpecialFilePath(file.path))
    .reduce((stats, file) => {
      const sizeDelta = typeof file.sizeDelta === 'number' && Number.isInteger(file.sizeDelta) ? file.sizeDelta : 0
      const size = typeof file.size === 'number' && Number.isInteger(file.size) && file.binary === true ? file.size : 0
      return {
        additions: stats.additions + file.added,
        binarySizeDeltaDeleted: stats.binarySizeDeltaDeleted + (file.binary === true && sizeDelta < 0 ? sizeDelta : 0),
        binarySizeDeltaInserted: stats.binarySizeDeltaInserted + (file.binary === true && sizeDelta > 0 ? sizeDelta : 0),
        binaryTotalSize: stats.binaryTotalSize + size,
        deletions: stats.deletions + file.removed,
        maxAdded: Math.max(stats.maxAdded, file.added),
        maxDeleted: Math.max(stats.maxDeleted, file.removed),
      }
    }, {
      additions: 0,
      binarySizeDeltaDeleted: 0,
      binarySizeDeltaInserted: 0,
      binaryTotalSize: 0,
      deletions: 0,
      maxAdded: 0,
      maxDeleted: 0,
    })
}

export function reviewFileChangeLabel(kind: ReviewFile['kind']): ReviewFileRowModel['changeLabel'] {
  if (kind === 'added') return 'A'
  if (kind === 'copied') return 'C'
  if (kind === 'deleted') return 'D'
  if (kind === 'renamed') return 'R'
  if (kind === 'rewritten') return 'W'
  if (kind === 'unmodified') return 'U'
  if (kind === 'reverted') return 'X'
  return 'M'
}

export function reviewFileStatusLabel(file: ReviewFile): ReviewFileRowModel['changeLabel'] {
  if (file.status) return file.status
  return reviewFileChangeLabel(file.kind)
}

export function reviewFileCommentPaths(file: ReviewFile) {
  return reviewCommentPathsForFile(file)
}

export function reviewFileDiffStatus(file: ReviewFile): ReviewFileRowModel['diffStatus'] {
  if (file.binary) return 'binary'
  if (reviewFileHasLoadedNegativeDiff(file)) return 'too-expensive'
  if (file.diffLoaded === false) return 'not-loaded'
  return 'loaded'
}

export function reviewFileRowModel(
  state: ReviewState,
  file: ReviewFile,
  options: { mutationPending?: boolean; patchset?: string } = {}
): ReviewFileRowModel {
  const patchset = options.patchset ?? state.patchRange.patchset
  const status = reviewFileState(state, file.path, patchset)
  const patchsetState = reviewStateForPatchset(state, patchset)
  const reviewed = status.loaded ? status.status === 'reviewed' : null
  const action = reviewed === null
    ? null
    : {
        ariaLabel: reviewed ? 'Mark as unreviewed' : 'Mark as reviewed',
        disabled: Boolean(options.mutationPending),
        label: reviewed ? 'MARK UNREVIEWED' : 'MARK REVIEWED',
        nextReviewed: !reviewed,
        visibility: 'on-row-interaction',
      } satisfies ReviewFileRowAction
  return {
    action,
    added: file.added,
    binary: file.binary === true,
    changeLabel: reviewFileStatusLabel(file),
    commentPaths: reviewFileCommentPaths(file),
    deleted: file.removed,
    ...(reviewFileDiffLoadError(state, file.path, patchset) ? { diffLoadError: reviewFileDiffLoadError(state, file.path, patchset) } : {}),
    diffLoadPending: patchsetState.pendingDiffPaths.includes(file.path),
    diffStatus: reviewFileDiffStatus(file),
    diffTooExpensive: file.diffTooExpensive === true || file.diff.truncated === true,
    expanded: patchsetState.expandedPaths.includes(file.path),
    ...(file.newMode ? { newMode: file.newMode } : {}),
    ...(file.newSha ? { newSha: file.newSha } : {}),
    ...(file.oldMode ? { oldMode: file.oldMode } : {}),
    ...(file.oldSha ? { oldSha: file.oldSha } : {}),
    path: file.path,
    pending: status.pending,
    ...(file.previousPath ? { previousPath: file.previousPath } : {}),
    reviewed,
    reviewedLabel: reviewed === true ? 'Reviewed' : null,
    reviewStatusLoaded: status.loaded,
    ...(Number.isInteger(file.size) ? { size: file.size } : {}),
    ...(Number.isInteger(file.sizeDelta) ? { sizeDelta: file.sizeDelta } : {}),
  }
}

export function reviewStatusChangesForFiles(
  state: ReviewState,
  files: readonly ReviewFile[],
  reviewed: boolean,
  patchset = state.patchRange.patchset
): ReviewStatusChange[] {
  if (!reviewStateForPatchset(state, patchset).reviewedLoaded) return []
  return reviewFileListReviewableFiles(files)
    .filter(file => reviewFileState(state, file.path, patchset).status === (reviewed ? 'unreviewed' : 'reviewed'))
    .map(file => ({ path: file.path, reviewed }))
}

export function reviewUnreviewedFilePaths(
  state: ReviewState,
  files: readonly ReviewFile[],
  options: { currentPath?: string; patchset?: string } = {}
) {
  const patchset = options.patchset ?? state.patchRange.patchset
  if (!reviewStateForPatchset(state, patchset).reviewedLoaded) return []
  return reviewFileListReviewableFiles(files)
    .filter(file => file.path === options.currentPath || reviewFileState(state, file.path, patchset).status === 'unreviewed')
    .map(file => file.path)
}

export function reviewAdjacentUnreviewedFilePath(
  state: ReviewState,
  files: readonly ReviewFile[],
  currentPath: string,
  direction: ReviewUnreviewedNavigationDirection = 'next',
  patchset = state.patchRange.patchset
) {
  const paths = reviewUnreviewedFilePaths(state, files, { currentPath, patchset })
  const currentIndex = paths.indexOf(currentPath)
  if (currentIndex === -1) return null
  const nextIndex = direction === 'next' ? currentIndex + 1 : currentIndex - 1
  return paths[nextIndex] ?? null
}

export function reviewMarkReviewedAndNavigateIntent(
  state: ReviewState,
  files: readonly ReviewFile[],
  currentPath: string,
  patchset = state.patchRange.patchset
): ReviewMarkReviewedNavigationIntent {
  const patchsetState = reviewStateForPatchset(state, patchset)
  const hasCurrentFile = reviewFileListReviewableFiles(files).some(file => file.path === currentPath)
  const status = reviewFileState(state, currentPath, patchset)
  const mutationPending = Boolean(patchsetState.pendingReview)
  const canMarkCurrentReviewed = hasCurrentFile && status.loaded && !mutationPending && status.status === 'unreviewed'
  return {
    changes: canMarkCurrentReviewed
      ? [{ path: currentPath, reviewed: true }]
      : [],
    mutationPending,
    nextPath: canMarkCurrentReviewed
      ? reviewAdjacentUnreviewedFilePath(state, files, currentPath, 'next', patchset)
      : null,
    reviewedStatusLoaded: patchsetState.reviewedLoaded,
  }
}

export function reviewFileListToolbarModel(
  state: ReviewState,
  files: readonly ReviewFile[],
  options: { mutationPending?: boolean; patchset?: string } = {}
): ReviewFileListToolbarModel {
  const patchset = options.patchset ?? state.patchRange.patchset
  const markReviewedChanges = reviewStatusChangesForFiles(state, files, true, patchset)
  const markUnreviewedChanges = reviewStatusChangesForFiles(state, files, false, patchset)
  const mutationPending = Boolean(options.mutationPending)
  const reviewedStatusLoaded = reviewStateForPatchset(state, patchset).reviewedLoaded
  const reviewableFiles = reviewFileListReviewableFiles(files)
  return {
    markAllReviewed: {
      changes: markReviewedChanges,
      disabled: !reviewedStatusLoaded || mutationPending || markReviewedChanges.length === 0,
      label: 'MARK ALL REVIEWED',
    },
    markAllUnreviewed: {
      changes: markUnreviewedChanges,
      disabled: !reviewedStatusLoaded || mutationPending || markUnreviewedChanges.length === 0,
      label: 'MARK ALL UNREVIEWED',
    },
    reviewedStatusLoaded,
    reviewableCount: reviewableFiles.length,
  }
}
