import {
  createReviewState,
  isReviewSpecialFilePath,
  type ReviewCatalog,
  type ReviewFile,
  type ReviewPatchRange,
  type ReviewPreferences,
  type ReviewState,
} from './state'
import { compareReviewFilePaths } from './file-info'

export type ReviewDiffSource = 'git-range' | 'working-copy'
export type WorkingCopyReviewScope = 'tracked' | 'untracked'

export type ReviewWorkspaceTarget =
  | { agentId: string; root?: never }
  | { agentId?: never; root: string }

export type ReviewDiffSnapshotRequest =
  | (ReviewWorkspaceTarget & { context?: number; ignoreWhitespace?: ReviewPreferences['ignoreWhitespace']; limit?: number; metadataOnly?: boolean; modifiedWithinDays?: number; scope?: WorkingCopyReviewScope; source: 'working-copy' })
  | (ReviewWorkspaceTarget & { base: string; context?: number; head: string; ignoreWhitespace?: ReviewPreferences['ignoreWhitespace']; limit?: number; metadataOnly?: boolean; reviewId?: string; source: 'git-range' })

export type GitRangeReviewDiffSnapshotRequest = Extract<ReviewDiffSnapshotRequest, { source: 'git-range' }>

export type ReviewDiffSnapshot = {
  basePatchset?: string
  comparison?: ReviewComparison
  files: ReviewFile[]
  isGitRepo: boolean
  patchset: string
  reviewId: string
  root: string
  source: ReviewDiffSource
  truncated: boolean
}

export type ReviewCommitSummary = {
  authoredAt: string
  authorEmail: string
  authorName: string
  id: string
  message: string
}

export type ReviewComparison = {
  base?: ReviewCommitSummary
  head?: ReviewCommitSummary
  workingTree: boolean
}

export type WorkingCopyReview = ReviewDiffSnapshot

export type ReviewFileMap = Record<string, ReviewFile>

export type ReviewSnapshotIdentity = {
  basePatchset: string
  patchset: string
  reviewId: string
  root: string
  source: ReviewDiffSource
}

function snapshotBasePatchset(snapshot: ReviewDiffSnapshot) {
  return snapshot.basePatchset ?? (snapshot.source === 'working-copy' ? 'HEAD' : 'Base')
}

export function reviewSnapshotRange(snapshot: ReviewDiffSnapshot): ReviewPatchRange {
  return {
    basePatchset: snapshotBasePatchset(snapshot),
    patchset: snapshot.patchset,
  }
}

export function reviewSnapshotIdentity(snapshot: ReviewDiffSnapshot): ReviewSnapshotIdentity {
  return {
    ...reviewSnapshotRange(snapshot),
    reviewId: snapshot.reviewId,
    root: snapshot.root,
    source: snapshot.source,
  }
}

export function reviewSnapshotStateKey(snapshot: ReviewDiffSnapshot) {
  const identity = reviewSnapshotIdentity(snapshot)
  return [
    identity.source,
    identity.reviewId,
    identity.basePatchset,
    identity.patchset,
  ].join('\0')
}

export function reviewFileMapFromFiles(files: readonly ReviewFile[]): ReviewFileMap {
  const map: ReviewFileMap = Object.create(null) as ReviewFileMap
  for (const file of files) {
    if (Object.prototype.hasOwnProperty.call(map, file.path)) {
      throw new TypeError(`duplicate review file path: ${file.path}`)
    }
    map[file.path] = file
  }
  return map
}

export function reviewCatalogFromSnapshot(snapshot: ReviewDiffSnapshot): ReviewCatalog {
  reviewFileMapFromFiles(snapshot.files)
  return { [snapshot.patchset]: snapshot.files }
}

function validCatalogPath(path: unknown): path is string {
  if (isReviewSpecialFilePath(path)) return true
  return typeof path === 'string'
    && path.length > 0
    && path.length <= 4096
    && !path.includes('\0')
    && !path.startsWith('/')
    && !path.startsWith('\\')
    && path.split(/[\\/]/).every(segment => segment && segment !== '.' && segment !== '..')
}

function reviewUnmodifiedFile(path: string): ReviewFile {
  return {
    added: 0,
    diff: { hunks: [] },
    diffLoaded: false,
    kind: 'unmodified',
    path,
    removed: 0,
    status: 'U',
  }
}

export function reviewFilesWithUnmodifiedPaths(files: readonly ReviewFile[], paths: readonly string[]) {
  const next = [...files]
  for (const path of paths) {
    if (!validCatalogPath(path)) continue
    if (next.some(file => file.path === path)) continue
    if (next.some(file => file.kind === 'renamed' && file.previousPath === path)) continue
    next.push(reviewUnmodifiedFile(path))
  }
  return next.sort((left, right) => compareReviewFilePaths(left.path, right.path))
}

export function reviewCatalogWithUnmodifiedPaths(catalog: ReviewCatalog, patchset: string, paths: readonly string[]): ReviewCatalog {
  const files = catalog[patchset]
  if (!files) return catalog
  const nextFiles = reviewFilesWithUnmodifiedPaths(files, paths)
  if (nextFiles.length === files.length && nextFiles.every((file, index) => file === files[index])) return catalog
  return {
    ...catalog,
    [patchset]: nextFiles,
  }
}

function reviewFileWithLoadedDiff(current: ReviewFile, file: ReviewFile): ReviewFile {
  const next: ReviewFile = {
    ...file,
    ...current,
    diff: file.diff,
    diffLoaded: true,
  }
  if (current.binary === true || file.binary === true) next.binary = true
  if (current.diffTooExpensive === true || file.diffTooExpensive === true) next.diffTooExpensive = true
  if (current.truncated === true || file.truncated === true) next.truncated = true
  if (current.diff.truncated === true || file.diff.truncated === true) next.diff = { ...next.diff, truncated: true }
  return next
}

export function reviewCatalogWithFile(catalog: ReviewCatalog, patchset: string, file: ReviewFile): ReviewCatalog {
  const files = catalog[patchset]
  if (!files) return catalog
  let replaced = false
  const nextFiles = files.map(current => {
    if (current.path !== file.path) return current
    replaced = true
    return reviewFileWithLoadedDiff(current, file)
  })
  if (!replaced) return catalog
  return {
    ...catalog,
    [patchset]: nextFiles,
  }
}

export function createReviewStateFromSnapshot({
  comments = [],
  preferences,
  reviewedPaths,
  snapshot,
}: {
  comments?: Parameters<typeof createReviewState>[0]['comments']
  preferences: ReviewPreferences
  reviewedPaths?: string[]
  snapshot: ReviewDiffSnapshot
}): ReviewState {
  return createReviewState({
    catalog: reviewCatalogFromSnapshot(snapshot),
    comments,
    patchRange: reviewSnapshotRange(snapshot),
    preferences,
    reviewId: snapshot.reviewId,
    reviewedPathsByPatchset: reviewedPaths === undefined ? {} : { [snapshot.patchset]: reviewedPaths },
  })
}

export function reviewSnapshotLabel(snapshot: ReviewDiffSnapshot) {
  return snapshot.source === 'working-copy'
    ? 'Working copy'
    : reviewPatchRangeLabel(reviewSnapshotRange(snapshot))
}

export function reviewPatchRangeLabel(range: ReviewPatchRange) {
  return `${range.basePatchset} -> ${range.patchset}`
}

export function normalizeReviewGitRevision(value: unknown) {
  if (typeof value !== 'string') return undefined
  const revision = value.trim()
  if (
    !revision
    || revision.length > 200
    || revision.startsWith('-')
    || /[\\\0\r\n\t ]/.test(revision)
  ) return undefined
  return revision
}

export function reviewSnapshotRequestLabel(request: ReviewDiffSnapshotRequest) {
  if (request.source === 'working-copy') return 'Working copy'
  return reviewPatchRangeLabel({
    basePatchset: normalizeReviewGitRevision(request.base) ?? request.base,
    patchset: normalizeReviewGitRevision(request.head) ?? request.head,
  })
}

function requestContextKey(context: unknown) {
  return typeof context === 'number' && Number.isInteger(context) && context >= 0 ? String(context) : ''
}

function requestIgnoreWhitespaceKey(ignoreWhitespace: unknown) {
  if (ignoreWhitespace === 'ALL' || ignoreWhitespace === 'LEADING_AND_TRAILING' || ignoreWhitespace === 'TRAILING') return ignoreWhitespace
  return 'NONE'
}

function requestLimitKey(limit: unknown) {
  return typeof limit === 'number' && Number.isInteger(limit) && limit > 0 ? String(limit) : ''
}

function requestWorkspaceKey(request: ReviewDiffSnapshotRequest) {
  return 'root' in request && typeof request.root === 'string' ? `root:${request.root}` : request.agentId
}

function requestWorkingCopyScopeKey(request: ReviewDiffSnapshotRequest) {
  if (request.source !== 'working-copy') return ''
  return `${request.scope ?? ''}:${request.modifiedWithinDays ?? ''}`
}

export function reviewSnapshotRequestKey(request: ReviewDiffSnapshotRequest) {
  const limit = requestLimitKey(request.limit)
  const metadataOnly = request.metadataOnly === true ? 'metadata' : 'full'
  const context = request.metadataOnly === true ? '' : requestContextKey(request.context)
  const ignoreWhitespace = request.metadataOnly === true ? 'NONE' : requestIgnoreWhitespaceKey(request.ignoreWhitespace)
  if (request.source === 'working-copy') return ['working-copy', requestWorkspaceKey(request), requestWorkingCopyScopeKey(request), limit, metadataOnly, context, ignoreWhitespace].join('\0')
  return ['git-range', ...(request.reviewId ? [request.reviewId] : []), requestWorkspaceKey(request), normalizeReviewGitRevision(request.base) ?? '', normalizeReviewGitRevision(request.head) ?? '', limit, metadataOnly, context, ignoreWhitespace].join('\0')
}

export function reviewSnapshotFileRequestKey(request: ReviewDiffSnapshotRequest, path: string) {
  const context = requestContextKey(request.context)
  const ignoreWhitespace = requestIgnoreWhitespaceKey(request.ignoreWhitespace)
  if (request.source === 'working-copy') return ['working-copy-file', requestWorkspaceKey(request), requestWorkingCopyScopeKey(request), path, context, ignoreWhitespace].join('\0')
  return ['git-range-file', ...(request.reviewId ? [request.reviewId] : []), requestWorkspaceKey(request), normalizeReviewGitRevision(request.base) ?? '', normalizeReviewGitRevision(request.head) ?? '', path, context, ignoreWhitespace].join('\0')
}

export function reviewSnapshotPatchRequestKey(request: ReviewDiffSnapshotRequest) {
  const limit = requestLimitKey(request.limit)
  const context = requestContextKey(request.context)
  const ignoreWhitespace = requestIgnoreWhitespaceKey(request.ignoreWhitespace)
  if (request.source === 'working-copy') return ['working-copy-patch', requestWorkspaceKey(request), requestWorkingCopyScopeKey(request), limit, context, ignoreWhitespace].join('\0')
  return ['git-range-patch', ...(request.reviewId ? [request.reviewId] : []), requestWorkspaceKey(request), normalizeReviewGitRevision(request.base) ?? '', normalizeReviewGitRevision(request.head) ?? '', limit, context, ignoreWhitespace].join('\0')
}

export function reviewSnapshotRequestSupportsPatchText(request: ReviewDiffSnapshotRequest) {
  return request.source === 'working-copy' || request.source === 'git-range'
}

export function reviewSnapshotRequestSupportsFileDiff(request: ReviewDiffSnapshotRequest) {
  return request.source === 'working-copy' || request.source === 'git-range'
}
