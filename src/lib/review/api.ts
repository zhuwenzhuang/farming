import { appPath } from '@/lib/base-path'
import { normalizeReviewGitRevision, type GitRangeReviewDiffSnapshotRequest, type ReviewDiffSnapshot, type ReviewDiffSnapshotRequest, type ReviewDiffSource, type WorkingCopyReview } from './snapshot'
import { isReviewSpecialFilePath, reviewFileHasLoadedNegativeDiff, validReviewCommentRange } from './state'
import type { ReviewComment, ReviewDiffCell, ReviewDiffFileMeta, ReviewDiffHunk, ReviewDiffRow, ReviewDiffSyntaxBlock, ReviewDiffWebLink, ReviewFile, ReviewPreferences } from './state'

export type ReviewedPatchsetState = {
  reviewedPaths: string[]
  revision: number
}

export class ReviewApiError extends Error {
  readonly state?: ReviewedPatchsetState

  constructor(message: string, state?: ReviewedPatchsetState) {
    super(message)
    this.name = 'ReviewApiError'
    this.state = state
  }
}

export const REVIEW_FIXTURE_ID = 'review-fixture-553987'
const MAX_REVIEW_KEY_LENGTH = 200

export type ReviewSessionRevision = {
  base: string
  changedPaths?: string[]
  createdAt: string
  fixesBase: string
  head: string
  number: number
  reviewId: string
  root: string
  modifiedWithinDays?: number
  paths?: string[]
  scope?: 'tracked' | 'untracked'
  unchanged?: boolean
}

export type ReviewSession = ReviewSessionRevision & { revisions: ReviewSessionRevision[] }

export type AcpReviewPreviewChange = {
  added: number
  diff: string
  kind: string
  path: string
  removed: number
}

export type ReviewComparisonSource = {
  available?: boolean
  base: string
  head: string
  id: string
  label: string
}

export type ReviewComparisonSources = {
  branches: ReviewComparisonSource[]
  commits: ReviewComparisonSource[]
  currentBranch: string
  root: string
  staged: ReviewComparisonSource & { available: boolean }
  unstaged: ReviewComparisonSource & { available: boolean }
}

function revisionFilesPath(reviewId: string, patchset: string) {
  return appPath(`/api/reviews/${encodeURIComponent(reviewId)}/revisions/${encodeURIComponent(patchset)}/files`)
}

function revisionReviewedFilePath(reviewId: string, patchset: string, path: string) {
  return appPath(`/api/reviews/${encodeURIComponent(reviewId)}/revisions/${encodeURIComponent(patchset)}/files/${encodeURIComponent(path)}/reviewed`)
}

function reviewWorkingCopyFileDiffPath(path: string) {
  return appPath(`/api/reviews/working-copy/files/${encodeURIComponent(path)}/diff`)
}

function reviewWorkingCopyFileContextPath(path: string) {
  return appPath(`/api/reviews/working-copy/files/${encodeURIComponent(path)}/context`)
}

function reviewGitRangeFileDiffPath(path: string) {
  return appPath(`/api/reviews/git-range/files/${encodeURIComponent(path)}/diff`)
}

function reviewGitRangeFileContextPath(path: string) {
  return appPath(`/api/reviews/git-range/files/${encodeURIComponent(path)}/context`)
}

function commentPath(reviewId: string, patchset: string) {
  return appPath(`/api/reviews/${encodeURIComponent(reviewId)}/patchsets/${encodeURIComponent(patchset)}/comments`)
}

function isReviewPath(value: unknown): value is string {
  if (isReviewSpecialFilePath(value)) return true
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 4096
    && !value.includes('\0')
    && !value.startsWith('/')
    && !value.startsWith('\\')
    && value.split(/[\\/]/).every(segment => segment && segment !== '.' && segment !== '..')
}

function isReviewFileStatus(value: unknown) {
  return value === 'A' || value === 'C' || value === 'D' || value === 'M' || value === 'R' || value === 'U' || value === 'W' || value === 'X'
}

function isOptionalString(value: unknown) {
  return value === undefined || typeof value === 'string'
}

function isNonEmptyString(value: unknown) {
  return typeof value === 'string' && value.length > 0
}

function isComparisonSource(value: unknown): value is ReviewComparisonSource {
  if (!value || typeof value !== 'object') return false
  const source = value as ReviewComparisonSource
  return isNonEmptyString(source.id)
    && isNonEmptyString(source.label)
    && Boolean(normalizeReviewGitRevision(source.base))
    && Boolean(normalizeReviewGitRevision(source.head))
    && (source.available === undefined || typeof source.available === 'boolean')
}

function isReviewKey(value: unknown) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= MAX_REVIEW_KEY_LENGTH
    && /^[A-Za-z0-9]/.test(value)
    && !/[\\\0\r\n\t]/.test(value)
}

function isNonNegativeInteger(value: unknown) {
  return Number.isInteger(value) && (value as number) >= 0
}

function revisionFromResponse(response: Response) {
  const revision = Number(response.headers.get('X-Farming-Review-Revision'))
  return Number.isInteger(revision) && revision >= 0 ? revision : 0
}

function errorMessageFromValue(value: unknown, fallback: string) {
  return value && typeof value === 'object' && typeof (value as { error?: unknown }).error === 'string'
    ? (value as { error: string }).error
    : fallback
}

function appendIgnoreWhitespace(params: URLSearchParams, ignoreWhitespace?: ReviewPreferences['ignoreWhitespace']) {
  if (ignoreWhitespace === 'ALL' || ignoreWhitespace === 'LEADING_AND_TRAILING' || ignoreWhitespace === 'TRAILING') {
    params.set('ignoreWhitespace', ignoreWhitespace)
  }
}

function appendDiffContext(params: URLSearchParams, context?: number) {
  if (typeof context === 'number' && Number.isInteger(context) && context >= 0) params.set('context', String(context))
}

function appendReviewLimit(params: URLSearchParams, limit?: number) {
  if (typeof limit === 'number' && Number.isInteger(limit) && limit > 0) params.set('limit', String(limit))
}

function appendReviewWorkspaceTarget(params: URLSearchParams, request: ReviewDiffSnapshotRequest) {
  if ('root' in request && typeof request.root === 'string') params.set('root', request.root)
  else params.set('agentId', request.agentId)
}

function appendReviewSessionIdentity(params: URLSearchParams, request: ReviewDiffSnapshotRequest) {
  if (request.source === 'git-range' && request.reviewId) params.set('reviewId', request.reviewId)
}

function hasUniqueReviewPaths(paths: readonly string[]) {
  return new Set(paths).size === paths.length
}

function assertReviewIdentity(reviewId: string, patchset: string) {
  if (!isReviewKey(reviewId) || !isReviewKey(patchset)) {
    throw new ReviewApiError('review identity is invalid')
  }
}

function assertReviewPath(path: string) {
  if (!isReviewPath(path)) throw new ReviewApiError('review file path is invalid')
}

function assertReviewStatusChanges(changes: readonly { path: string }[]) {
  const paths = changes.map(change => change.path)
  if (!paths.every(isReviewPath) || !hasUniqueReviewPaths(paths)) {
    throw new ReviewApiError('review status changes are invalid')
  }
}

function assertGitRangeRevisions(base: string, head: string) {
  const normalizedBase = normalizeReviewGitRevision(base)
  const normalizedHead = normalizeReviewGitRevision(head)
  if (!normalizedBase || !normalizedHead) throw new ReviewApiError('base and head revisions are invalid')
  return { base: normalizedBase, head: normalizedHead }
}

async function readError(response: Response, fallback: string) {
  const value: unknown = await response.json().catch(() => null)
  return errorMessageFromValue(value, fallback)
}

function isGitObjectId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{40,64}$/.test(value)
}

function isReviewSessionRevision(value: unknown): value is ReviewSessionRevision {
  if (!value || typeof value !== 'object') return false
  const revision = value as ReviewSessionRevision
  return isReviewKey(revision.reviewId)
    && isNonEmptyString(revision.root)
    && isGitObjectId(revision.base)
    && isGitObjectId(revision.fixesBase)
    && isGitObjectId(revision.head)
    && Number.isInteger(revision.number)
    && revision.number > 0
    && isNonEmptyString(revision.createdAt)
    && (revision.changedPaths === undefined || (Array.isArray(revision.changedPaths) && revision.changedPaths.every(isReviewPath)))
    && (revision.unchanged === undefined || typeof revision.unchanged === 'boolean')
    && (revision.scope === undefined || revision.scope === 'tracked' || revision.scope === 'untracked')
    && (revision.modifiedWithinDays === undefined || (Number.isInteger(revision.modifiedWithinDays) && revision.modifiedWithinDays >= 1))
    && (revision.paths === undefined || (Array.isArray(revision.paths) && revision.paths.every(isReviewPath)))
}

async function readReviewSessionRevision(response: Response, fallback: string) {
  const value: unknown = await response.json().catch(() => null)
  if (!response.ok || !isReviewSessionRevision(value)) {
    throw new ReviewApiError(errorMessageFromValue(value, fallback))
  }
  return value
}

export async function createReviewSession(
  target: { agentId: string } | { root: string },
  base: string,
  options: { modifiedWithinDays?: number; paths?: string[]; scope?: 'tracked' | 'untracked' } = {},
): Promise<ReviewSessionRevision> {
  const normalizedBase = normalizeReviewGitRevision(base)
  const targetValue = 'root' in target ? target.root : target.agentId
  if (!targetValue.trim() || !normalizedBase) throw new ReviewApiError('review capture target is invalid')
  const response = await fetch(appPath('/api/review-sessions'), {
    body: JSON.stringify({ base: normalizedBase, ...target, ...options }),
    headers: { 'Content-Type': 'application/json' },
    method: 'POST',
  })
  return readReviewSessionRevision(response, 'review capture failed')
}

export async function createAcpReviewSession(
  agentId: string,
  itemIds: string[],
): Promise<ReviewSessionRevision> {
  if (!agentId.trim() || itemIds.length === 0 || itemIds.some(itemId => !itemId.trim())) {
    throw new ReviewApiError('ACP review capture target is invalid')
  }
  const response = await fetch(appPath('/api/review-sessions/acp'), {
    body: JSON.stringify({ agentId, itemIds }),
    headers: { 'Content-Type': 'application/json' },
    method: 'POST',
  })
  return readReviewSessionRevision(response, 'ACP review capture failed')
}

export async function loadAcpReviewPreview(
  agentId: string,
  itemIds: string[],
): Promise<AcpReviewPreviewChange[]> {
  if (!agentId.trim() || itemIds.length === 0 || itemIds.some(itemId => !itemId.trim())) {
    throw new ReviewApiError('ACP review preview target is invalid')
  }
  const response = await fetch(appPath('/api/review-sessions/acp/preview'), {
    body: JSON.stringify({ agentId, itemIds }),
    headers: { 'Content-Type': 'application/json' },
    method: 'POST',
  })
  const value: unknown = await response.json().catch(() => null)
  const changes = value && typeof value === 'object' ? (value as { changes?: unknown }).changes : null
  if (
    !response.ok
    || !Array.isArray(changes)
    || !changes.every(change => (
      change
      && typeof change === 'object'
      && Number.isInteger((change as AcpReviewPreviewChange).added)
      && (change as AcpReviewPreviewChange).added >= 0
      && typeof (change as AcpReviewPreviewChange).diff === 'string'
      && typeof (change as AcpReviewPreviewChange).kind === 'string'
      && isReviewPath((change as AcpReviewPreviewChange).path)
      && Number.isInteger((change as AcpReviewPreviewChange).removed)
      && (change as AcpReviewPreviewChange).removed >= 0
    ))
  ) throw new ReviewApiError(errorMessageFromValue(value, 'ACP review preview failed'))
  return changes as AcpReviewPreviewChange[]
}

export async function refreshReviewSession(reviewId: string): Promise<ReviewSessionRevision> {
  if (!isReviewKey(reviewId)) throw new ReviewApiError('review session id is invalid')
  const response = await fetch(appPath(`/api/review-sessions/${encodeURIComponent(reviewId)}/revisions`), { method: 'POST' })
  return readReviewSessionRevision(response, 'review refresh failed')
}

export async function loadReviewSession(reviewId: string): Promise<ReviewSession> {
  if (!isReviewKey(reviewId)) throw new ReviewApiError('review session id is invalid')
  const response = await fetch(appPath(`/api/review-sessions/${encodeURIComponent(reviewId)}`))
  const value: unknown = await response.json().catch(() => null)
  if (
    !response.ok
    || !isReviewSessionRevision(value)
    || !Array.isArray((value as ReviewSession).revisions)
    || !(value as ReviewSession).revisions.every(isReviewSessionRevision)
  ) throw new ReviewApiError(errorMessageFromValue(value, 'review session request failed'))
  return value as ReviewSession
}

export async function loadReviewComparisonSources(
  target: { agentId: string } | { root: string },
): Promise<ReviewComparisonSources> {
  const targetValue = 'root' in target ? target.root : target.agentId
  if (!targetValue.trim()) throw new ReviewApiError('review comparison target is invalid')
  const params = new URLSearchParams()
  if ('root' in target) params.set('root', target.root)
  else params.set('agentId', target.agentId)
  const response = await fetch(`${appPath('/api/reviews/comparison-sources')}?${params.toString()}`)
  const value: unknown = await response.json().catch(() => null)
  if (!response.ok || !value || typeof value !== 'object') {
    throw new ReviewApiError(errorMessageFromValue(value, 'review comparison sources could not be loaded'))
  }
  const sources = value as ReviewComparisonSources
  if (
    !isNonEmptyString(sources.currentBranch)
    || !isNonEmptyString(sources.root)
    || !isComparisonSource(sources.staged)
    || typeof sources.staged.available !== 'boolean'
    || !isComparisonSource(sources.unstaged)
    || typeof sources.unstaged.available !== 'boolean'
    || !Array.isArray(sources.commits)
    || !sources.commits.every(isComparisonSource)
    || !Array.isArray(sources.branches)
    || !sources.branches.every(isComparisonSource)
  ) throw new ReviewApiError('review comparison source response is invalid')
  return sources
}

export function reviewRequestForSessionRevision(
  revision: ReviewSessionRevision,
  view: 'final' | 'fixes' = 'final',
): GitRangeReviewDiffSnapshotRequest {
  return {
    base: view === 'fixes' ? revision.fixesBase : revision.base,
    head: revision.head,
    metadataOnly: true,
    reviewId: revision.reviewId,
    root: revision.root,
    source: 'git-range',
  }
}

export async function loadReviewedFiles(reviewId: string, patchset: string): Promise<ReviewedPatchsetState> {
  assertReviewIdentity(reviewId, patchset)
  const response = await fetch(`${revisionFilesPath(reviewId, patchset)}?reviewed`)
  const value: unknown = await response.json().catch(() => null)
  if (!response.ok || !Array.isArray(value) || !value.every(isReviewPath) || !hasUniqueReviewPaths(value)) {
    throw new ReviewApiError(errorMessageFromValue(value, 'reviewed files request failed'))
  }
  return {
    reviewedPaths: value,
    revision: revisionFromResponse(response),
  }
}

export async function loadReviewedPatchsetState(reviewId: string, patchset: string) {
  return loadReviewedFiles(reviewId, patchset)
}

async function setReviewedFilePrimitive({
  patchset,
  path,
  reviewId,
  reviewed,
}: {
  patchset: string
  path: string
  reviewId: string
  reviewed: boolean
}) {
  assertReviewIdentity(reviewId, patchset)
  assertReviewPath(path)
  const response = await fetch(revisionReviewedFilePath(reviewId, patchset, path), {
    method: reviewed ? 'PUT' : 'DELETE',
  })
  if (!response.ok) throw new ReviewApiError(await readError(response, 'review status request failed'))
}

async function reviewStatusWriteError(error: unknown, reviewId: string, patchset: string) {
  const state = await loadReviewedPatchsetState(reviewId, patchset).catch(() => undefined)
  const message = error instanceof Error ? error.message : 'review status request failed'
  return new ReviewApiError(message, state)
}

export async function saveReviewedFileStatus({
  patchset,
  path,
  reviewId,
  reviewed,
}: {
  patchset: string
  path: string
  reviewId: string
  reviewed: boolean
  revision: number
}) {
  assertReviewIdentity(reviewId, patchset)
  assertReviewPath(path)
  try {
    await setReviewedFilePrimitive({ patchset, path, reviewId, reviewed })
    return loadReviewedPatchsetState(reviewId, patchset)
  } catch (error) {
    throw await reviewStatusWriteError(error, reviewId, patchset)
  }
}

export type ReviewedFileChange = {
  path: string
  reviewed: boolean
}

/**
 * Gerrit's backend primitive is a single-file PUT/DELETE. Farming can still
 * expose one toolbar action for several rows, but the adapter executes the
 * same primitive per file and then reloads the authoritative reviewed list.
 * This is intentionally not an atomic batch API.
 */
export async function saveReviewedFilesStatus({
  changes,
  patchset,
  reviewId,
}: {
  changes: ReviewedFileChange[]
  patchset: string
  reviewId: string
  revision: number
}) {
  assertReviewIdentity(reviewId, patchset)
  assertReviewStatusChanges(changes)
  try {
    for (const change of changes) {
      await setReviewedFilePrimitive({ patchset, path: change.path, reviewId, reviewed: change.reviewed })
    }
    return loadReviewedPatchsetState(reviewId, patchset)
  } catch (error) {
    throw await reviewStatusWriteError(error, reviewId, patchset)
  }
}

function isReviewComment(value: unknown): value is ReviewComment {
  if (!value || typeof value !== 'object') return false
  const comment = value as ReviewComment
  return typeof comment.id === 'string'
    && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(comment.id)
    && typeof comment.body === 'string'
    && comment.body.trim().length > 0
    && comment.body.length <= 20000
    && isReviewKey(comment.patchset)
    && isReviewPath(comment.path)
    && Number.isInteger(comment.line)
    && comment.line > 0
    && comment.line <= 100000000
    && (comment.side === 'left' || comment.side === 'right' || comment.side === 'unified')
    && (comment.range === undefined || validReviewCommentRange(comment.range))
    && (comment.status === undefined || comment.status === 'open' || comment.status === 'resolved' || comment.status === 'outdated')
    && (comment.sourcePatchset === undefined || isReviewKey(comment.sourcePatchset))
}

function assertReviewCommentId(commentId: string) {
  if (typeof commentId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(commentId)) {
    throw new ReviewApiError('review comment id is invalid')
  }
}

function isCommentResponse(value: unknown): value is { comments: ReviewComment[] } {
  return Boolean(value)
    && typeof value === 'object'
    && Array.isArray((value as { comments?: unknown }).comments)
    && (value as { comments: unknown[] }).comments.every(isReviewComment)
}

async function readCommentResponse(response: Response) {
  const value: unknown = await response.json().catch(() => null)
  if (isCommentResponse(value)) return value.comments
  if (isReviewComment(value)) return value
  const message = value && typeof value === 'object' && typeof (value as { error?: unknown }).error === 'string'
    ? (value as { error: string }).error
    : 'review comment request failed'
  throw new ReviewApiError(message)
}

export async function loadReviewComments(reviewId: string, patchset: string) {
  assertReviewIdentity(reviewId, patchset)
  const response = await fetch(commentPath(reviewId, patchset))
  const comments = await readCommentResponse(response)
  if (!response.ok || !Array.isArray(comments)) throw new ReviewApiError('review comment request failed')
  return comments
}

export async function saveReviewComment(reviewId: string, comment: ReviewComment) {
  assertReviewIdentity(reviewId, comment.patchset)
  if (!isReviewComment(comment)) throw new ReviewApiError('review comment is invalid')
  const response = await fetch(commentPath(reviewId, comment.patchset), {
    body: JSON.stringify(comment),
    headers: { 'Content-Type': 'application/json' },
    method: 'POST',
  })
  const saved = await readCommentResponse(response)
  if (!response.ok || Array.isArray(saved)) throw new ReviewApiError('review comment request failed')
  return saved
}

export async function deleteReviewComment(reviewId: string, patchset: string, commentId: string) {
  assertReviewIdentity(reviewId, patchset)
  assertReviewCommentId(commentId)
  const response = await fetch(`${commentPath(reviewId, patchset)}/${encodeURIComponent(commentId)}`, { method: 'DELETE' })
  const comments = await readCommentResponse(response)
  if (!response.ok || !Array.isArray(comments)) throw new ReviewApiError('review comment request failed')
  return comments
}

export async function updateReviewCommentStatus(reviewId: string, patchset: string, commentId: string, status: 'open' | 'resolved') {
  assertReviewIdentity(reviewId, patchset)
  assertReviewCommentId(commentId)
  const response = await fetch(`${commentPath(reviewId, patchset)}/${encodeURIComponent(commentId)}`, {
    body: JSON.stringify({ status }),
    headers: { 'Content-Type': 'application/json' },
    method: 'PATCH',
  })
  const comment = await readCommentResponse(response)
  if (!response.ok || Array.isArray(comment)) throw new ReviewApiError('review comment status request failed')
  return comment
}

function isDiffCell(value: unknown): value is ReviewDiffCell {
  const cell = value as ReviewDiffCell
  const intraline = cell?.intraline
  return Boolean(value)
    && typeof value === 'object'
    && Number.isInteger(cell.line)
    && cell.line > 0
    && cell.line <= 100000000
    && typeof cell.text === 'string'
    && (cell.missingNewlineAtEnd === undefined || cell.missingNewlineAtEnd === true)
    && (intraline === undefined || (Array.isArray(intraline) && intraline.every(range => {
      return Number.isInteger(range.start)
        && Number.isInteger(range.end)
        && range.start >= 0
        && range.end > range.start
    })))
}

function isDiffRow(value: unknown): value is ReviewDiffRow {
  if (!value || typeof value !== 'object') return false
  const row = value as ReviewDiffRow
  const moveDetails = row.moveDetails
  if (row.whitespaceOnly !== undefined && typeof row.whitespaceOnly !== 'boolean') return false
  if (row.dueToRebase !== undefined && typeof row.dueToRebase !== 'boolean') return false
  if (moveDetails !== undefined) {
    if (!moveDetails || typeof moveDetails !== 'object' || typeof moveDetails.changed !== 'boolean') return false
    if (moveDetails.range !== undefined) {
      if (!moveDetails.range || typeof moveDetails.range !== 'object') return false
      if (
        !Number.isInteger(moveDetails.range.start)
        || !Number.isInteger(moveDetails.range.end)
        || moveDetails.range.start < 1
        || moveDetails.range.end < moveDetails.range.start
      ) return false
    }
  }
  if (!isDiffCell(row.left) && row.left !== undefined) return false
  if (!isDiffCell(row.right) && row.right !== undefined) return false
  if (row.kind === 'added') return row.left === undefined && isDiffCell(row.right)
  if (row.kind === 'changed') return isDiffCell(row.left) && isDiffCell(row.right)
  if (row.kind === 'deleted') return isDiffCell(row.left) && row.right === undefined
  if (row.kind === 'context') return isDiffCell(row.left) && isDiffCell(row.right)
  if (row.kind === 'skipped') {
    return row.left === undefined
      && row.right === undefined
      && Number.isInteger(row.leftLines)
      && Number.isInteger(row.rightLines)
      && (row.leftLines ?? 0) >= 0
      && (row.rightLines ?? 0) >= 0
      && ((row.leftLines ?? 0) > 0 || (row.rightLines ?? 0) > 0)
  }
  return false
}

function diffRowSpanCounts(rows: readonly ReviewDiffRow[]) {
  return rows.reduce((counts, row) => ({
    left: counts.left + (row.left ? 1 : 0) + (row.kind === 'skipped' ? row.leftLines ?? 0 : 0),
    right: counts.right + (row.right ? 1 : 0) + (row.kind === 'skipped' ? row.rightLines ?? 0 : 0),
  }), { left: 0, right: 0 })
}

function diffHunkSideStart(rows: readonly ReviewDiffRow[], side: 'left' | 'right', lineCount: number) {
  if (lineCount === 0) return 0
  let skippedBeforeFirstLine = 0
  for (const row of rows) {
    const cell = side === 'left' ? row.left : row.right
    if (cell) return Math.max(0, cell.line - skippedBeforeFirstLine)
    if (row.kind === 'skipped') skippedBeforeFirstLine += side === 'left' ? row.leftLines ?? 0 : row.rightLines ?? 0
  }
  return 1
}

function hasConsistentDiffHunkRange(hunk: ReviewDiffHunk) {
  const counts = diffRowSpanCounts(hunk.rows)
  return hunk.oldLines === counts.left
    && hunk.newLines === counts.right
    && hunk.oldStart === diffHunkSideStart(hunk.rows, 'left', counts.left)
    && hunk.newStart === diffHunkSideStart(hunk.rows, 'right', counts.right)
}

function isDiffHunk(value: unknown): value is ReviewDiffHunk {
  if (!value || typeof value !== 'object') return false
  const hunk = value as ReviewDiffHunk
  const hasStructuredRange = ['oldStart', 'oldLines', 'newStart', 'newLines'].every(key => {
    const number = hunk[key as 'oldStart' | 'oldLines' | 'newStart' | 'newLines']
    return Number.isInteger(number) && (number as number) >= 0
  })
  return typeof hunk.header === 'string'
    && hunk.header.length > 0
    && hasStructuredRange
    && Array.isArray(hunk.rows)
    && hunk.rows.every(isDiffRow)
    && hasConsistentDiffHunkRange(hunk)
    && (!hunk.commonContext || hunk.commonContext.every(isDiffRow))
}

function isDiffTextRange(value: unknown): value is NonNullable<ReviewDiffSyntaxBlock['range']> {
  const range = value as NonNullable<ReviewDiffSyntaxBlock['range']>
  return Boolean(value)
    && typeof value === 'object'
    && Number.isInteger(range.startLine)
    && Number.isInteger(range.startColumn)
    && Number.isInteger(range.endLine)
    && Number.isInteger(range.endColumn)
    && range.startLine >= 1
    && range.startColumn >= 1
    && range.endLine >= range.startLine
    && range.endColumn >= 1
}

function isDiffSyntaxBlock(value: unknown): value is ReviewDiffSyntaxBlock {
  const block = value as ReviewDiffSyntaxBlock
  return Boolean(value)
    && typeof value === 'object'
    && typeof block.name === 'string'
    && block.name.length > 0
    && (block.range === undefined || isDiffTextRange(block.range))
    && (block.children === undefined || (Array.isArray(block.children) && block.children.every(isDiffSyntaxBlock)))
}

function isDiffWebLink(value: unknown): value is ReviewDiffWebLink {
  const link = value as ReviewDiffWebLink
  return Boolean(value)
    && typeof value === 'object'
    && typeof link.name === 'string'
    && link.name.length > 0
    && typeof link.url === 'string'
    && link.url.length > 0
}

function isDiffFileMeta(value: unknown): value is ReviewDiffFileMeta {
  const meta = value as ReviewDiffFileMeta
  return Boolean(value)
    && typeof value === 'object'
    && typeof meta.name === 'string'
    && meta.name.length > 0
    && typeof meta.contentType === 'string'
    && meta.contentType.length > 0
    && isNonNegativeInteger(meta.lines)
    && (meta.language === undefined || typeof meta.language === 'string')
    && (meta.syntaxTree === undefined || (Array.isArray(meta.syntaxTree) && meta.syntaxTree.every(isDiffSyntaxBlock)))
    && (meta.webLinks === undefined || (Array.isArray(meta.webLinks) && meta.webLinks.every(isDiffWebLink)))
}

function isReviewFile(value: unknown): value is ReviewFile {
  if (!value || typeof value !== 'object') return false
  const file = value as ReviewFile
  return isReviewPath(file.path)
    && isNonNegativeInteger(file.added)
    && isNonNegativeInteger(file.removed)
    && (file.kind === 'added' || file.kind === 'copied' || file.kind === 'deleted' || file.kind === 'modified' || file.kind === 'renamed' || file.kind === 'rewritten' || file.kind === 'unmodified' || file.kind === 'reverted')
    && (file.binary === undefined || file.binary === true)
    && (file.diffLoaded === undefined || typeof file.diffLoaded === 'boolean')
    && (file.diffTooExpensive === undefined || typeof file.diffTooExpensive === 'boolean')
    && isOptionalString(file.newMode)
    && isOptionalString(file.newSha)
    && isOptionalString(file.oldMode)
    && isOptionalString(file.oldSha)
    && (file.previousPath === undefined || isReviewPath(file.previousPath))
    && (file.size === undefined || isNonNegativeInteger(file.size))
    && (file.sizeDelta === undefined || Number.isInteger(file.sizeDelta))
    && (file.status === undefined || isReviewFileStatus(file.status))
    && (file.truncated === undefined || typeof file.truncated === 'boolean')
    && Boolean(file.diff)
    && Array.isArray(file.diff.hunks)
    && (file.diff.diffHeader === undefined || (Array.isArray(file.diff.diffHeader) && file.diff.diffHeader.every(line => typeof line === 'string')))
    && (file.diff.intralineStatus === undefined || file.diff.intralineStatus === 'ERROR' || file.diff.intralineStatus === 'OK' || file.diff.intralineStatus === 'TIMEOUT')
    && (file.diff.leftMeta === undefined || isDiffFileMeta(file.diff.leftMeta))
    && (file.diff.rightMeta === undefined || isDiffFileMeta(file.diff.rightMeta))
    && (file.diff.truncated === undefined || typeof file.diff.truncated === 'boolean')
    && (file.diffLoaded !== false || file.diff.hunks.length === 0)
    && file.diff.hunks.every(isDiffHunk)
}

function isReviewCommitSummary(value: unknown) {
  if (!value || typeof value !== 'object') return false
  const commit = value as { authoredAt?: unknown; authorEmail?: unknown; authorName?: unknown; id?: unknown; message?: unknown }
  return isGitObjectId(commit.id)
    && typeof commit.authorName === 'string'
    && typeof commit.authorEmail === 'string'
    && typeof commit.authoredAt === 'string'
    && typeof commit.message === 'string'
    && commit.message.trim().length > 0
}

function isReviewComparison(value: unknown) {
  if (!value || typeof value !== 'object') return false
  const comparison = value as { base?: unknown; head?: unknown; workingTree?: unknown }
  return typeof comparison.workingTree === 'boolean'
    && (comparison.base === undefined || isReviewCommitSummary(comparison.base))
    && (comparison.head === undefined || isReviewCommitSummary(comparison.head))
}

function isLoadedReviewFileResponse(value: unknown): value is ReviewFile {
  if (!isReviewFile(value)) return false
  if (value.diffLoaded === false && !reviewFileHasLoadedNegativeDiff(value)) return false
  return true
}

function isExpectedReviewFileResponse(value: unknown, path: string): value is ReviewFile {
  return isLoadedReviewFileResponse(value) && value.path === path
}

function hasUniqueReviewFilePaths(files: readonly ReviewFile[]) {
  return new Set(files.map(file => file.path)).size === files.length
}

function normalizeSnapshotSource(value: unknown, expected: ReviewDiffSource): ReviewDiffSource | undefined {
  if (value === undefined) return expected
  return value === expected ? expected : undefined
}

function appendSnapshotOptions(params: URLSearchParams, request: ReviewDiffSnapshotRequest) {
  if (request.source === 'working-copy') {
    if (request.scope) params.set('scope', request.scope)
    if (request.scope === 'untracked' && request.modifiedWithinDays) params.set('modifiedWithinDays', String(request.modifiedWithinDays))
  }
  appendReviewLimit(params, request.limit)
  if (request.metadataOnly === true) {
    params.set('metadataOnly', '1')
    return
  }
  appendDiffContext(params, request.context)
  appendIgnoreWhitespace(params, request.ignoreWhitespace)
}

export function reviewSnapshotUrl(request: ReviewDiffSnapshotRequest) {
  const params = new URLSearchParams()
  appendReviewWorkspaceTarget(params, request)
  let pathname = '/api/reviews/working-copy'
  if (request.source === 'git-range') {
    const revisions = assertGitRangeRevisions(request.base, request.head)
    params.set('base', revisions.base)
    params.set('head', revisions.head)
    pathname = '/api/reviews/git-range'
  }
  appendSnapshotOptions(params, request)
  appendReviewSessionIdentity(params, request)
  return appPath(`${pathname}?${params.toString()}`)
}

export async function loadWorkingCopyReview(agentId: string, limit?: number, metadataOnly?: boolean, ignoreWhitespace?: ReviewPreferences['ignoreWhitespace'], context?: number): Promise<WorkingCopyReview> {
  const response = await fetch(reviewSnapshotUrl({ agentId, context, ignoreWhitespace, limit, metadataOnly, source: 'working-copy' }))
  const value: unknown = await response.json().catch(() => null)
  if (!response.ok || !value || typeof value !== 'object' || !Array.isArray((value as WorkingCopyReview).files)) {
    const message = value && typeof value === 'object' && typeof (value as { error?: unknown }).error === 'string'
      ? (value as { error: string }).error
      : 'working copy request failed'
    throw new ReviewApiError(message)
  }
  const review = value as WorkingCopyReview
  if (
    !review.files.every(isReviewFile)
    || !hasUniqueReviewFilePaths(review.files)
    || !isNonEmptyString(review.root)
    || !isNonEmptyString(review.reviewId)
    || !isNonEmptyString(review.patchset)
    || typeof review.isGitRepo !== 'boolean'
    || typeof review.truncated !== 'boolean'
    || (review.comparison !== undefined && !isReviewComparison(review.comparison))
    || !normalizeSnapshotSource(review.source, 'working-copy')
  ) {
    throw new ReviewApiError('working copy response is invalid')
  }
  return {
    ...review,
    basePatchset: typeof review.basePatchset === 'string' ? review.basePatchset : 'HEAD',
    source: 'working-copy',
  }
}

export async function loadGitRangeReview(agentId: string, base: string, head: string, limit?: number, metadataOnly?: boolean, ignoreWhitespace?: ReviewPreferences['ignoreWhitespace'], context?: number): Promise<ReviewDiffSnapshot> {
  const response = await fetch(reviewSnapshotUrl({ agentId, base, context, head, ignoreWhitespace, limit, metadataOnly, source: 'git-range' }))
  const value: unknown = await response.json().catch(() => null)
  if (!response.ok || !value || typeof value !== 'object' || !Array.isArray((value as WorkingCopyReview).files)) {
    const message = value && typeof value === 'object' && typeof (value as { error?: unknown }).error === 'string'
      ? (value as { error: string }).error
      : 'git range review request failed'
    throw new ReviewApiError(message)
  }
  const review = value as WorkingCopyReview
  if (
    !review.files.every(isReviewFile)
    || !hasUniqueReviewFilePaths(review.files)
    || !isNonEmptyString(review.root)
    || !isNonEmptyString(review.reviewId)
    || !isNonEmptyString(review.patchset)
    || (review.basePatchset !== undefined && !isNonEmptyString(review.basePatchset))
    || typeof review.isGitRepo !== 'boolean'
    || typeof review.truncated !== 'boolean'
    || (review.comparison !== undefined && !isReviewComparison(review.comparison))
    || !normalizeSnapshotSource(review.source, 'git-range')
  ) {
    throw new ReviewApiError('git range review response is invalid')
  }
  return { ...review, source: 'git-range' }
}

export async function loadWorkingCopyReviewFile(agentId: string, path: string, ignoreWhitespace?: ReviewPreferences['ignoreWhitespace'], context?: number): Promise<ReviewFile> {
  if (!isReviewPath(path)) throw new ReviewApiError('review file path is invalid')
  const params = new URLSearchParams({ agentId })
  appendDiffContext(params, context)
  appendIgnoreWhitespace(params, ignoreWhitespace)
  const response = await fetch(`${reviewWorkingCopyFileDiffPath(path)}?${params.toString()}`)
  const value: unknown = await response.json().catch(() => null)
  if (!response.ok || !isExpectedReviewFileResponse(value, path)) {
    throw new ReviewApiError(errorMessageFromValue(value, 'review file diff request failed'))
  }
  return value
}

export async function loadGitRangeReviewFile(agentId: string, base: string, head: string, path: string, ignoreWhitespace?: ReviewPreferences['ignoreWhitespace'], context?: number): Promise<ReviewFile> {
  if (!isReviewPath(path)) throw new ReviewApiError('review file path is invalid')
  const revisions = assertGitRangeRevisions(base, head)
  const params = new URLSearchParams({ agentId, base: revisions.base, head: revisions.head })
  appendDiffContext(params, context)
  appendIgnoreWhitespace(params, ignoreWhitespace)
  const response = await fetch(`${reviewGitRangeFileDiffPath(path)}?${params.toString()}`)
  const value: unknown = await response.json().catch(() => null)
  if (!response.ok || !isExpectedReviewFileResponse(value, path)) {
    throw new ReviewApiError(errorMessageFromValue(value, 'review git range file diff request failed'))
  }
  return value
}

export async function loadReviewDiffSnapshot(request: ReviewDiffSnapshotRequest): Promise<ReviewDiffSnapshot> {
  const response = await fetch(reviewSnapshotUrl(request))
  const value: unknown = await response.json().catch(() => null)
  const fallback = request.source === 'git-range' ? 'git range request failed' : 'working copy request failed'
  if (!response.ok || !value || typeof value !== 'object' || !Array.isArray((value as WorkingCopyReview).files)) {
    throw new ReviewApiError(errorMessageFromValue(value, fallback))
  }
  const review = value as WorkingCopyReview
  const valid = review.files.every(isReviewFile)
    && hasUniqueReviewFilePaths(review.files)
    && isNonEmptyString(review.root)
    && isNonEmptyString(review.reviewId)
    && isNonEmptyString(review.patchset)
    && typeof review.isGitRepo === 'boolean'
    && typeof review.truncated === 'boolean'
    && normalizeSnapshotSource(review.source, request.source)
    && (request.source !== 'git-range' || !request.reviewId || review.reviewId === request.reviewId)
    && (request.source === 'working-copy' || review.basePatchset === undefined || isNonEmptyString(review.basePatchset))
  if (!valid) throw new ReviewApiError(`${request.source === 'git-range' ? 'git range review' : 'working copy'} response is invalid`)
  return request.source === 'working-copy'
    ? { ...review, basePatchset: typeof review.basePatchset === 'string' ? review.basePatchset : 'HEAD', source: 'working-copy' }
    : { ...review, source: 'git-range' }
}

export function reviewFileDiffUrl(request: ReviewDiffSnapshotRequest, path: string) {
  assertReviewPath(path)
  const params = new URLSearchParams()
  appendReviewWorkspaceTarget(params, request)
  appendDiffContext(params, request.context)
  appendIgnoreWhitespace(params, request.ignoreWhitespace)
  appendReviewSessionIdentity(params, request)
  if (request.source === 'working-copy') {
    if (request.scope) params.set('scope', request.scope)
    if (request.scope === 'untracked' && request.modifiedWithinDays) params.set('modifiedWithinDays', String(request.modifiedWithinDays))
  }
  let pathname = reviewWorkingCopyFileDiffPath(path)
  if (request.source === 'git-range') {
    const revisions = assertGitRangeRevisions(request.base, request.head)
    params.set('base', revisions.base)
    params.set('head', revisions.head)
    pathname = reviewGitRangeFileDiffPath(path)
  }
  return `${pathname}?${params.toString()}`
}

export async function loadReviewFileDiff(request: ReviewDiffSnapshotRequest, path: string): Promise<ReviewFile> {
  const response = await fetch(reviewFileDiffUrl(request, path))
  const value: unknown = await response.json().catch(() => null)
  if (!response.ok || !isExpectedReviewFileResponse(value, path)) {
    throw new ReviewApiError(errorMessageFromValue(value, request.source === 'git-range' ? 'review git range file diff request failed' : 'review file diff request failed'))
  }
  return value
}

export type ReviewContextRange = {
  lines: number
  newStart: number
  oldStart: number
}

export type ReviewContextRows = {
  leftLines: number
  rightLines: number
  rows: ReviewDiffRow[]
}

function appendReviewContextRange(params: URLSearchParams, range: ReviewContextRange) {
  for (const [name, value] of Object.entries(range)) {
    if (!Number.isInteger(value) || value < 1) throw new ReviewApiError(`review context ${name} is invalid`)
    params.set(name, String(value))
  }
}

function isReviewContextRows(value: unknown): value is ReviewContextRows {
  if (!value || typeof value !== 'object') return false
  const context = value as ReviewContextRows
  return Number.isInteger(context.leftLines)
    && context.leftLines >= 0
    && Number.isInteger(context.rightLines)
    && context.rightLines >= 0
    && Array.isArray(context.rows)
    && context.rows.length > 0
    && context.rows.every(row => isDiffRow(row) && row.kind === 'context')
}

export function reviewFileContextUrl(request: ReviewDiffSnapshotRequest, path: string, range: ReviewContextRange) {
  assertReviewPath(path)
  const params = new URLSearchParams()
  appendReviewWorkspaceTarget(params, request)
  appendReviewSessionIdentity(params, request)
  appendReviewContextRange(params, range)
  if (request.source === 'working-copy') {
    if (request.scope) params.set('scope', request.scope)
    if (request.scope === 'untracked' && request.modifiedWithinDays) params.set('modifiedWithinDays', String(request.modifiedWithinDays))
    return `${reviewWorkingCopyFileContextPath(path)}?${params.toString()}`
  }
  const revisions = assertGitRangeRevisions(request.base, request.head)
  params.set('base', revisions.base)
  params.set('head', revisions.head)
  return `${reviewGitRangeFileContextPath(path)}?${params.toString()}`
}

export async function loadReviewFileContext(request: ReviewDiffSnapshotRequest, path: string, range: ReviewContextRange): Promise<ReviewContextRows> {
  const response = await fetch(reviewFileContextUrl(request, path, range))
  const value: unknown = await response.json().catch(() => null)
  if (!response.ok || !isReviewContextRows(value) || value.rows.length !== range.lines) {
    throw new ReviewApiError(errorMessageFromValue(value, 'review context request failed'))
  }
  return value
}

export type ReviewPatchText = {
  text: string
  truncated: boolean
}

export function reviewPatchUrl(request: ReviewDiffSnapshotRequest) {
  const params = new URLSearchParams()
  appendReviewWorkspaceTarget(params, request)
  appendReviewLimit(params, request.limit)
  appendDiffContext(params, request.context)
  appendIgnoreWhitespace(params, request.ignoreWhitespace)
  appendReviewSessionIdentity(params, request)
  if (request.source === 'working-copy') {
    if (request.scope) params.set('scope', request.scope)
    if (request.scope === 'untracked' && request.modifiedWithinDays) params.set('modifiedWithinDays', String(request.modifiedWithinDays))
  }
  let pathname = '/api/reviews/working-copy/patch'
  if (request.source === 'git-range') {
    const revisions = assertGitRangeRevisions(request.base, request.head)
    params.set('base', revisions.base)
    params.set('head', revisions.head)
    pathname = '/api/reviews/git-range/patch'
  }
  return appPath(`${pathname}?${params.toString()}`)
}

export async function loadReviewPatch(request: ReviewDiffSnapshotRequest): Promise<ReviewPatchText> {
  const response = await fetch(reviewPatchUrl(request))
  const text = await response.text()
  if (!response.ok) {
    try {
      const value = JSON.parse(text) as { error?: unknown }
      if (typeof value.error === 'string') throw new ReviewApiError(value.error)
    } catch (error) {
      if (error instanceof ReviewApiError) throw error
    }
    throw new ReviewApiError('review patch request failed')
  }
  return {
    text,
    truncated: response.headers.get('X-Farming-Review-Truncated') === 'true',
  }
}

export async function loadReviewPatchText(request: ReviewDiffSnapshotRequest): Promise<string> {
  return (await loadReviewPatch(request)).text
}
