export type ReviewDiffMode = 'split' | 'unified'
export type ReviewCommentSide = 'left' | 'right' | 'unified'

export type ReviewPatchRange = {
  basePatchset: string
  patchset: string
}

export type ReviewDiffCell = {
  intraline?: Array<{ end: number; start: number }>
  line: number
  text: string
}

export type ReviewDiffRow = {
  dueToRebase?: boolean
  kind: 'added' | 'changed' | 'context' | 'deleted' | 'skipped'
  left?: ReviewDiffCell
  leftLines?: number
  moveDetails?: {
    changed: boolean
    range?: {
      end: number
      start: number
    }
  }
  right?: ReviewDiffCell
  rightLines?: number
  whitespaceOnly?: boolean
}

export type ReviewDiffHunk = {
  commonContext?: ReviewDiffRow[]
  header: string
  newLines: number
  newStart: number
  oldLines: number
  oldStart: number
  rows: ReviewDiffRow[]
}

export type ReviewDiffSyntaxBlock = {
  children?: ReviewDiffSyntaxBlock[]
  name: string
  range?: {
    endColumn: number
    endLine: number
    startColumn: number
    startLine: number
  }
}

export type ReviewDiffWebLink = {
  name: string
  url: string
}

export type ReviewDiffFileMeta = {
  contentType: string
  language?: string
  lines: number
  name: string
  syntaxTree?: ReviewDiffSyntaxBlock[]
  webLinks?: ReviewDiffWebLink[]
}

export type ReviewFileDiff = {
  diffHeader?: string[]
  hunks: ReviewDiffHunk[]
  intralineStatus?: 'ERROR' | 'OK' | 'TIMEOUT'
  leftMeta?: ReviewDiffFileMeta
  rightMeta?: ReviewDiffFileMeta
  truncated?: boolean
}

export type ReviewFileStatusCode = 'A' | 'C' | 'D' | 'M' | 'R' | 'U' | 'W' | 'X'

export type ReviewFile = {
  added: number
  binary?: true
  diff: ReviewFileDiff
  diffLoaded?: boolean
  diffTooExpensive?: boolean
  kind: 'modified' | 'added' | 'copied' | 'deleted' | 'renamed' | 'rewritten' | 'unmodified' | 'reverted'
  newMode?: string
  newSha?: string
  oldMode?: string
  oldSha?: string
  path: string
  previousPath?: string
  removed: number
  size?: number
  sizeDelta?: number
  status?: ReviewFileStatusCode
  truncated?: boolean
}

export function reviewFileHasLoadedNegativeDiff(file: Pick<ReviewFile, 'binary' | 'diff' | 'diffTooExpensive'>) {
  return file.binary === true || file.diffTooExpensive === true || file.diff.truncated === true
}

/** The persisted review state is deliberately separate from the diff payload. */
export type ReviewFileStatus = 'reviewed' | 'unreviewed' | 'unknown'

export type ReviewFileReviewState = {
  loaded: boolean
  pending: boolean
  status: ReviewFileStatus
}

export type ReviewStatusChange = {
  path: string
  reviewed: boolean
}

export type ReviewPatchsetSummary = {
  additions: number
  deletions: number
  fileCount: number
  reviewedStatusLoaded: boolean
  reviewedCount: number
  unreviewedCount: number
}

export type ReviewComment = {
  body: string
  id: string
  line: number
  patchset: string
  path: string
  range?: ReviewCommentRange
  side: ReviewCommentSide
  sourcePatchset?: string
  status?: 'open' | 'resolved' | 'outdated'
}

export type ReviewCommentRange = {
  end_character: number
  end_line: number
  start_character: number
  start_line: number
}

export type ReviewCommentDraft = Omit<ReviewComment, 'body' | 'id'> & {
  body: string
}

export type ReviewPreferences = {
  autoMarkReviewed: boolean
  context: number
  fitToScreen: boolean
  fontSize: number
  ignoreWhitespace: 'NONE' | 'TRAILING' | 'LEADING_AND_TRAILING' | 'ALL'
  intralineDifference: boolean
  lineLength: number
  showTabs: boolean
  showTrailingWhitespace: boolean
  syntaxHighlighting: boolean
  tabSize: number
}

export const DEFAULT_REVIEW_PREFERENCES: ReviewPreferences = {
  autoMarkReviewed: false,
  context: 10,
  fitToScreen: true,
  fontSize: 12,
  ignoreWhitespace: 'NONE',
  intralineDifference: true,
  lineLength: 120,
  showTabs: true,
  showTrailingWhitespace: true,
  syntaxHighlighting: true,
  tabSize: 8,
}

export function normalizeReviewDiffMode(mode: unknown): ReviewDiffMode {
  return mode === 'unified' ? 'unified' : 'split'
}

export type PatchsetReviewState = {
  autoReviewPaths: string[]
  diffLoadErrors: Record<string, string>
  expandedPaths: string[]
  pendingComment?: {
    id: string
    type: 'delete' | 'save'
  }
  pendingDiffPaths: string[]
  pendingReview?: {
    changes: ReviewStatusChange[]
  }
  revealedContextHunks: string[]
  reviewedLoaded: boolean
  reviewedRevision: number
  reviewedPaths: string[]
}

export type ReviewState = {
  commentDraft?: ReviewCommentDraft
  comments: ReviewComment[]
  diffMode: ReviewDiffMode
  patchRange: ReviewPatchRange
  patchsets: Record<string, PatchsetReviewState>
  preferences: ReviewPreferences
  reviewId?: string
}

export type ReviewEffect =
  | { changes: ReviewStatusChange[]; patchset: string; reviewId?: string; revision: number; type: 'save-reviewed-status' }
  | { patchset: string; path: string; reviewId?: string; type: 'load-file-diff' }
  | { comment: ReviewComment; reviewId?: string; type: 'save-comment' }
  | { comment: ReviewComment; reviewId?: string; type: 'delete-comment' }

export type ReviewAction =
  | { patchset: string; type: 'select-patchset' }
  | { mode: ReviewDiffMode; type: 'set-diff-mode' }
  | { path: string; type: 'toggle-file-expanded' }
  | { expanded: boolean; paths: string[]; type: 'set-all-files-expanded' }
  | { patchset: string; path: string; reviewId?: string; type: 'commit-file-diff-load' }
  | { error: string; patchset: string; path: string; reviewId?: string; type: 'fail-file-diff-load' }
  | { hunkIndex: number; path: string; type: 'toggle-common-context' }
  | { path: string; reviewed: boolean; type: 'set-file-reviewed' }
  | { changes: ReviewStatusChange[]; type: 'set-files-reviewed' }
  | { patchset: string; reviewedPaths: string[]; reviewId?: string; revision: number; type: 'hydrate-reviewed-status' }
  | { patchset: string; paths?: string[]; path?: string; reviewId?: string; revision: number; reviewedPaths?: string[]; type: 'commit-reviewed-status' }
  | { patchset: string; reviewedPaths: string[]; reviewId?: string; revision: number; type: 'restore-reviewed-status' }
  | { preferences: ReviewPreferences; type: 'set-preferences' }
  | { line: number; path: string; range?: ReviewCommentRange; side: ReviewCommentSide; type: 'start-comment' }
  | { body: string; type: 'update-comment-draft' }
  | { type: 'cancel-comment' }
  | { id: string; type: 'save-comment' }
  | { id: string; type: 'delete-comment' }
  | { comments: ReviewComment[]; patchset: string; reviewId?: string; type: 'hydrate-comments' }
  | { id: string; patchset: string; pendingType: 'delete' | 'save'; reviewId?: string; type: 'commit-comment' }
  | { comments: ReviewComment[]; id: string; patchset: string; pendingType: 'delete' | 'save'; reviewId?: string; type: 'restore-comments' }

export type ReviewTransition = {
  effects: ReviewEffect[]
  state: ReviewState
}

export type ReviewCatalog = Record<string, readonly ReviewFile[]>

function uniquePaths(paths: string[]) {
  return [...new Set(paths)]
}

export const REVIEW_SPECIAL_FILE_PATHS = ['/COMMIT_MSG', '/MERGE_LIST'] as const
export type ReviewSpecialFilePath = typeof REVIEW_SPECIAL_FILE_PATHS[number]

export function isReviewSpecialFilePath(path: unknown): path is ReviewSpecialFilePath {
  return path === '/COMMIT_MSG' || path === '/MERGE_LIST'
}

function validCommentSide(side: unknown): side is ReviewCommentSide {
  return side === 'left' || side === 'right' || side === 'unified'
}

export function validReviewCommentRange(value: unknown): value is ReviewCommentRange {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const range = value as Partial<ReviewCommentRange>
  if (
    !Number.isInteger(range.start_line) || (range.start_line ?? 0) < 1
    || !Number.isInteger(range.end_line) || (range.end_line ?? 0) < 1
    || !Number.isInteger(range.start_character) || (range.start_character ?? -1) < 0
    || !Number.isInteger(range.end_character) || (range.end_character ?? -1) < 0
  ) return false
  return (range.start_line as number) < (range.end_line as number)
    || ((range.start_line as number) === (range.end_line as number)
      && (range.start_character as number) < (range.end_character as number))
}

export function validReviewPath(path: unknown): path is string {
  if (isReviewSpecialFilePath(path)) return true
  return typeof path === 'string'
    && path.length > 0
    && path.length <= 4096
    && !path.includes('\0')
    && !path.startsWith('/')
    && !path.startsWith('\\')
    && path.split(/[\\/]/).every(segment => segment && segment !== '.' && segment !== '..')
}

export function reviewCommentPathsForFile(file: Pick<ReviewFile, 'path' | 'previousPath'>) {
  const paths = [file.path]
  if (file.previousPath && file.previousPath !== file.path && validReviewPath(file.previousPath)) {
    paths.push(file.previousPath)
  }
  return paths
}

export function reviewCommentPathForSide(file: Pick<ReviewFile, 'path' | 'previousPath'>, side: ReviewCommentSide) {
  if (side === 'left' && file.previousPath && file.previousPath !== file.path && validReviewPath(file.previousPath)) {
    return file.previousPath
  }
  return file.path
}

export function reviewCommentSideForUnifiedCell(
  kind: 'added' | 'context' | 'deleted',
  hasRightSide: boolean,
): Exclude<ReviewCommentSide, 'unified'> {
  if (kind === 'deleted') return 'left'
  if (kind === 'context' && !hasRightSide) return 'left'
  return 'right'
}

function patchsetCommentPathSet(catalog: ReviewCatalog, patchset: string) {
  return new Set(patchsetFiles(catalog, patchset).flatMap(reviewCommentPathsForFile))
}

function hasCommentPath(catalog: ReviewCatalog, patchset: string, path: string) {
  return patchsetCommentPathSet(catalog, patchset).has(path)
}

/**
 * Keep the client-side review model as strict as the review-state backend.
 * Hydration actions can originate from a failed or stale request, so they
 * must not be allowed to introduce malformed comments into the state tree.
 */
function normalizeReviewComment(value: unknown, patchset?: string): ReviewComment | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const candidate = value as Partial<ReviewComment>
  const body = typeof candidate.body === 'string' ? candidate.body.trim() : ''
  const line = typeof candidate.line === 'number' && Number.isInteger(candidate.line)
    ? candidate.line
    : null
  if (
    typeof candidate.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(candidate.id)
    || typeof candidate.patchset !== 'string' || !candidate.patchset.trim()
    || (patchset !== undefined && candidate.patchset !== patchset)
    || !validReviewPath(candidate.path)
    || line === null || line < 1 || line > 100000000
    || !validCommentSide(candidate.side)
    || !body || body.length > 20000
  ) return undefined
  return {
    body,
    id: candidate.id,
    line,
    patchset: candidate.patchset,
    path: candidate.path,
    ...(validReviewCommentRange(candidate.range) ? { range: candidate.range } : {}),
    side: candidate.side,
    ...(typeof candidate.sourcePatchset === 'string' && candidate.sourcePatchset.trim() ? { sourcePatchset: candidate.sourcePatchset } : {}),
    ...(candidate.status === 'open' || candidate.status === 'resolved' || candidate.status === 'outdated' ? { status: candidate.status } : {}),
  }
}

function normalizeReviewComments(value: unknown, catalog: ReviewCatalog, patchset?: string): ReviewComment[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const comments: ReviewComment[] = []
  for (const item of value) {
    const comment = normalizeReviewComment(item, patchset)
    const commentKey = comment ? `${comment.patchset}\0${comment.id}` : ''
    if (!comment || !hasCommentPath(catalog, comment.patchset, comment.path) || seen.has(commentKey)) continue
    seen.add(commentKey)
    comments.push(comment)
  }
  return comments
}

function boundedNumber(value: unknown, fallback: number, minimum: number, maximum: number) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.max(minimum, Math.min(maximum, Math.round(value)))
}

function booleanOr(value: unknown, fallback: boolean) {
  return typeof value === 'boolean' ? value : fallback
}

export function normalizeReviewPreferences(value: unknown): ReviewPreferences {
  const candidate = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Partial<ReviewPreferences>
    : {}
  const context = boundedNumber(candidate.context, DEFAULT_REVIEW_PREFERENCES.context, 3, 100)
  return {
    autoMarkReviewed: booleanOr(candidate.autoMarkReviewed, DEFAULT_REVIEW_PREFERENCES.autoMarkReviewed),
    context: [3, 10, 25, 100].includes(context) ? context : DEFAULT_REVIEW_PREFERENCES.context,
    fitToScreen: booleanOr(candidate.fitToScreen, DEFAULT_REVIEW_PREFERENCES.fitToScreen),
    fontSize: boundedNumber(candidate.fontSize, DEFAULT_REVIEW_PREFERENCES.fontSize, 10, 20),
    ignoreWhitespace: candidate.ignoreWhitespace === 'TRAILING' || candidate.ignoreWhitespace === 'LEADING_AND_TRAILING' || candidate.ignoreWhitespace === 'ALL' || candidate.ignoreWhitespace === 'NONE'
      ? candidate.ignoreWhitespace
      : DEFAULT_REVIEW_PREFERENCES.ignoreWhitespace,
    intralineDifference: booleanOr(candidate.intralineDifference, DEFAULT_REVIEW_PREFERENCES.intralineDifference),
    lineLength: boundedNumber(candidate.lineLength, DEFAULT_REVIEW_PREFERENCES.lineLength, 40, 240),
    showTabs: booleanOr(candidate.showTabs, DEFAULT_REVIEW_PREFERENCES.showTabs),
    showTrailingWhitespace: booleanOr(candidate.showTrailingWhitespace, DEFAULT_REVIEW_PREFERENCES.showTrailingWhitespace),
    syntaxHighlighting: booleanOr(candidate.syntaxHighlighting, DEFAULT_REVIEW_PREFERENCES.syntaxHighlighting),
    tabSize: boundedNumber(candidate.tabSize, DEFAULT_REVIEW_PREFERENCES.tabSize, 2, 16),
  }
}

function emptyPatchsetState(): PatchsetReviewState {
  return {
    autoReviewPaths: [],
    diffLoadErrors: {},
    expandedPaths: [],
    pendingDiffPaths: [],
    revealedContextHunks: [],
    reviewedLoaded: false,
    reviewedRevision: 0,
    reviewedPaths: [],
  }
}

function patchsetFiles(catalog: ReviewCatalog, patchset: string) {
  return catalog[patchset] ?? []
}

export function assertReviewCatalogFilePaths(catalog: ReviewCatalog): void {
  for (const [patchset, files] of Object.entries(catalog)) {
    const paths = new Set<string>()
    for (const file of files) {
      if (paths.has(file.path)) {
        throw new TypeError(`duplicate review file path in ${patchset}: ${file.path}`)
      }
      paths.add(file.path)
    }
  }
}

function hasFile(catalog: ReviewCatalog, patchset: string, path: string) {
  return patchsetFiles(catalog, patchset).some(file => file.path === path)
}

function activePatchsetState(state: ReviewState) {
  return state.patchsets[state.patchRange.patchset] ?? emptyPatchsetState()
}

function updateActivePatchset(state: ReviewState, update: (current: PatchsetReviewState) => PatchsetReviewState): ReviewState {
  const patchset = state.patchRange.patchset
  return {
    ...state,
    patchsets: {
      ...state.patchsets,
      [patchset]: update(activePatchsetState(state)),
    },
  }
}

function updatePatchset(state: ReviewState, patchset: string, update: (current: PatchsetReviewState) => PatchsetReviewState): ReviewState {
  return {
    ...state,
    patchsets: {
      ...state.patchsets,
      [patchset]: update(reviewStateForPatchset(state, patchset)),
    },
  }
}

function updatePathList(paths: string[], path: string, present: boolean) {
  const next = new Set(paths)
  if (present) next.add(path)
  else next.delete(path)
  return [...next]
}

function omitRecordKey(record: Record<string, string>, key: string) {
  if (!(key in record)) return record
  const next = { ...record }
  delete next[key]
  return next
}

function canLoadFileDiff(file: ReviewFile | undefined) {
  return Boolean(file)
    && file?.diffLoaded === false
    && !reviewFileHasLoadedNegativeDiff(file)
}

function pendingDiffLoadPaths(catalog: ReviewCatalog, patchset: string, current: PatchsetReviewState, paths: string[]) {
  const filesByPath = new Map(patchsetFiles(catalog, patchset).map(file => [file.path, file]))
  return uniquePaths(paths).filter(path => {
    const file = filesByPath.get(path)
    return canLoadFileDiff(file)
      && !current.pendingDiffPaths.includes(path)
  })
}

function loadFileDiffEffect(state: ReviewState, patchset: string, path: string): Extract<ReviewEffect, { type: 'load-file-diff' }> {
  return {
    patchset,
    path,
    ...(state.reviewId ? { reviewId: state.reviewId } : {}),
    type: 'load-file-diff',
  }
}

function saveReviewedStatusEffect(
  state: ReviewState,
  patchset: string,
  revision: number,
  changes: ReviewStatusChange[]
): Extract<ReviewEffect, { type: 'save-reviewed-status' }> {
  return {
    changes,
    patchset,
    ...(state.reviewId ? { reviewId: state.reviewId } : {}),
    revision,
    type: 'save-reviewed-status',
  }
}

function reviewCommentEffect(
  state: ReviewState,
  type: 'delete-comment' | 'save-comment',
  comment: ReviewComment
): Extract<ReviewEffect, { type: 'delete-comment' | 'save-comment' }> {
  return {
    comment,
    ...(state.reviewId ? { reviewId: state.reviewId } : {}),
    type,
  }
}

function matchesReviewIdentity(state: ReviewState, reviewId?: string) {
  return reviewId === undefined || reviewId === state.reviewId
}

function matchesPendingComment(
  pending: PatchsetReviewState['pendingComment'],
  action: { id: string; pendingType: 'delete' | 'save' }
) {
  return Boolean(pending && pending.id === action.id && pending.type === action.pendingType)
}

function normalizeReviewStatusChanges(catalog: ReviewCatalog, patchset: string, reviewedPaths: string[], changes: ReviewStatusChange[]) {
  if (!Array.isArray(changes)) return []
  const validPaths = new Set(patchsetFiles(catalog, patchset).map(file => file.path))
  const currentReviewed = new Set(reviewedPaths)
  const desired = new Map<string, boolean>()
  for (const change of changes) {
    if (!change || !validPaths.has(change.path) || typeof change.reviewed !== 'boolean') continue
    desired.set(change.path, change.reviewed)
  }
  return [...desired.entries()]
    .filter(([path, reviewed]) => currentReviewed.has(path) !== reviewed)
    .map(([path, reviewed]) => ({ path, reviewed }))
}

function applyReviewStatusChanges(reviewedPaths: string[], changes: ReviewStatusChange[]) {
  return changes.reduce(
    (paths, change) => updatePathList(paths, change.path, change.reviewed),
    reviewedPaths
  )
}

function contextHunkKey(path: string, hunkIndex: number) {
  return `${path}:${hunkIndex}`
}

function contextHunkPathAndIndex(key: string) {
  const separator = key.lastIndexOf(':')
  if (separator <= 0) return null
  const path = key.slice(0, separator)
  const hunkIndex = Number(key.slice(separator + 1))
  if (!Number.isInteger(hunkIndex) || hunkIndex < 0) return null
  return { hunkIndex, path }
}

function ignored(state: ReviewState): ReviewTransition {
  return { effects: [], state }
}

export function createReviewState({
  catalog,
  comments = [],
  diffMode = 'split',
  patchRange,
  preferences,
  reviewId,
  reviewedPathsByPatchset = {},
}: {
  catalog: ReviewCatalog
  comments?: ReviewComment[]
  diffMode?: ReviewDiffMode
  patchRange: ReviewPatchRange
  preferences: ReviewPreferences
  reviewId?: string
  reviewedPathsByPatchset?: Partial<Record<string, string[]>>
}): ReviewState {
  assertReviewCatalogFilePaths(catalog)
  if (!catalog[patchRange.patchset]) {
    throw new TypeError(`review patchset is not present in catalog: ${patchRange.patchset}`)
  }
  const patchsets = Object.fromEntries(
    Object.keys(catalog).map(patchset => {
      const paths = new Set(patchsetFiles(catalog, patchset).map(file => file.path))
      const reviewedLoaded = Object.prototype.hasOwnProperty.call(reviewedPathsByPatchset, patchset)
      const reviewedPaths = reviewedLoaded ? reviewedPathsByPatchset[patchset] ?? [] : []
      return [patchset, {
        ...emptyPatchsetState(),
        reviewedLoaded,
        reviewedPaths: uniquePaths(reviewedPaths.filter(path => paths.has(path))),
      }]
    })
  ) as Record<string, PatchsetReviewState>

  return {
    comments: normalizeReviewComments(comments, catalog),
    diffMode: normalizeReviewDiffMode(diffMode),
    patchRange,
    patchsets,
    preferences: normalizeReviewPreferences(preferences),
    ...(typeof reviewId === 'string' && reviewId ? { reviewId } : {}),
  }
}

function reconcilePatchsetReviewState(
  current: PatchsetReviewState,
  files: readonly ReviewFile[],
  comments: readonly ReviewComment[]
): PatchsetReviewState {
  const validPaths = new Set(files.map(file => file.path))
  const validPath = (path: string) => validPaths.has(path)
  const filesByPath = new Map(files.map(file => [file.path, file]))
  const canStillLoadDiff = (path: string) => canLoadFileDiff(filesByPath.get(path))
  const pendingReview = current.pendingReview && current.pendingReview.changes.every(change => validPath(change.path))
    ? current.pendingReview
    : undefined
  const pendingComment = current.pendingComment && (
    current.pendingComment.type === 'delete'
    || comments.some(comment => comment.id === current.pendingComment?.id)
  )
    ? current.pendingComment
    : undefined
  return {
    ...current,
    autoReviewPaths: current.autoReviewPaths.filter(validPath),
    diffLoadErrors: Object.fromEntries(Object.entries(current.diffLoadErrors).filter(([path]) => canStillLoadDiff(path))),
    expandedPaths: current.expandedPaths.filter(validPath),
    pendingComment,
    pendingDiffPaths: current.pendingDiffPaths.filter(canStillLoadDiff),
    pendingReview,
    revealedContextHunks: current.revealedContextHunks.filter(key => {
      const parsed = contextHunkPathAndIndex(key)
      if (!parsed || !validPath(parsed.path)) return false
      return Boolean(files.find(file => file.path === parsed.path)?.diff.hunks[parsed.hunkIndex]?.commonContext?.length)
    }),
    reviewedPaths: current.reviewedPaths.filter(validPath),
  }
}

export function reconcileReviewStateWithCatalog(state: ReviewState, catalog: ReviewCatalog): ReviewState {
  assertReviewCatalogFilePaths(catalog)
  const patchsets = Object.keys(catalog)
  const patchset = catalog[state.patchRange.patchset] ? state.patchRange.patchset : patchsets[0] ?? state.patchRange.patchset
  const comments = normalizeReviewComments(state.comments, catalog)
  const nextPatchsets = Object.fromEntries(patchsets.map(patchset => {
    const patchsetComments = comments.filter(comment => comment.patchset === patchset)
    return [patchset, reconcilePatchsetReviewState(reviewStateForPatchset(state, patchset), patchsetFiles(catalog, patchset), patchsetComments)]
  })) as Record<string, PatchsetReviewState>
  const commentDraft = state.commentDraft && hasCommentPath(catalog, state.commentDraft.patchset, state.commentDraft.path)
    ? state.commentDraft
    : undefined
  return {
    ...state,
    ...(commentDraft ? { commentDraft } : { commentDraft: undefined }),
    comments,
    patchRange: { ...state.patchRange, patchset },
    patchsets: nextPatchsets,
  }
}

export function reviewStateForPatchset(state: ReviewState, patchset: string): PatchsetReviewState {
  return state.patchsets[patchset] ?? emptyPatchsetState()
}

export function isFileReviewed(state: ReviewState, path: string, patchset = state.patchRange.patchset) {
  const patchsetState = reviewStateForPatchset(state, patchset)
  return patchsetState.reviewedLoaded && patchsetState.reviewedPaths.includes(path)
}

/**
 * Single source of truth for the row status shown by the file list.  Consumers
 * should use this selector instead of reading `reviewedPaths` directly so an
 * optimistic mutation cannot be rendered as a second, conflicting status.
 */
export function reviewFileState(state: ReviewState, path: string, patchset = state.patchRange.patchset): ReviewFileReviewState {
  const patchsetState = reviewStateForPatchset(state, patchset)
  const loaded = patchsetState.reviewedLoaded
  return {
    loaded,
    pending: patchsetState.pendingReview?.changes.some(change => change.path === path) ?? false,
    status: loaded ? (patchsetState.reviewedPaths.includes(path) ? 'reviewed' : 'unreviewed') : 'unknown',
  }
}

export function isReviewFileDiffLoading(state: ReviewState, path: string, patchset = state.patchRange.patchset) {
  return reviewStateForPatchset(state, patchset).pendingDiffPaths.includes(path)
}

export function reviewFileDiffLoadError(state: ReviewState, path: string, patchset = state.patchRange.patchset) {
  return reviewStateForPatchset(state, patchset).diffLoadErrors[path]
}

export function reviewPatchsetSummary(state: ReviewState, catalog: ReviewCatalog, patchset = state.patchRange.patchset): ReviewPatchsetSummary {
  const files = patchsetFiles(catalog, patchset)
  const patchsetState = reviewStateForPatchset(state, patchset)
  const reviewedPaths = new Set(patchsetState.reviewedPaths)
  return files.reduce((summary, file) => ({
    additions: summary.additions + (isReviewSpecialFilePath(file.path) ? 0 : file.added),
    deletions: summary.deletions + (isReviewSpecialFilePath(file.path) ? 0 : file.removed),
    fileCount: summary.fileCount + 1,
    reviewedStatusLoaded: patchsetState.reviewedLoaded,
    reviewedCount: summary.reviewedCount + (patchsetState.reviewedLoaded && reviewedPaths.has(file.path) ? 1 : 0),
    unreviewedCount: summary.unreviewedCount + (patchsetState.reviewedLoaded && !reviewedPaths.has(file.path) ? 1 : 0),
  }), {
    additions: 0,
    deletions: 0,
    fileCount: 0,
    reviewedStatusLoaded: patchsetState.reviewedLoaded,
    reviewedCount: 0,
    unreviewedCount: 0,
  })
}

export function isReviewStatusPending(state: ReviewState, path: string, patchset = state.patchRange.patchset) {
  return reviewFileState(state, path, patchset).pending
}

export function commentsForFile(state: ReviewState, path: string, patchset = state.patchRange.patchset) {
  return state.comments.filter(comment => comment.patchset === patchset && comment.path === path)
}

export function commentsForFilePaths(state: ReviewState, paths: readonly string[], patchset = state.patchRange.patchset) {
  const pathSet = new Set(paths)
  return state.comments.filter(comment => comment.patchset === patchset && pathSet.has(comment.path))
}

export function transitionReviewState(state: ReviewState, action: ReviewAction, catalog: ReviewCatalog): ReviewTransition {
  const patchset = state.patchRange.patchset
  const patchsetState = activePatchsetState(state)

  switch (action.type) {
    case 'select-patchset': {
      if (!catalog[action.patchset] || action.patchset === patchset) return ignored(state)
      return {
        effects: [],
        state: {
          ...state,
          commentDraft: undefined,
          patchRange: { ...state.patchRange, patchset: action.patchset },
        },
      }
    }
    case 'set-diff-mode': {
      const diffMode = normalizeReviewDiffMode(action.mode)
      return diffMode === state.diffMode ? ignored(state) : { effects: [], state: { ...state, diffMode } }
    }
    case 'set-preferences':
      return { effects: [], state: { ...state, preferences: normalizeReviewPreferences(action.preferences) } }
    case 'toggle-file-expanded': {
      if (!hasFile(catalog, patchset, action.path)) return ignored(state)
      const expanded = !patchsetState.expandedPaths.includes(action.path)
      const diffLoadPaths = expanded ? pendingDiffLoadPaths(catalog, patchset, patchsetState, [action.path]) : []
      const status = reviewFileState(state, action.path)
      const next = updateActivePatchset(state, current => ({
        ...current,
        autoReviewPaths: expanded && !status.loaded
          ? updatePathList(current.autoReviewPaths, action.path, true)
          : updatePathList(current.autoReviewPaths, action.path, false),
        diffLoadErrors: expanded ? omitRecordKey(current.diffLoadErrors, action.path) : current.diffLoadErrors,
        expandedPaths: updatePathList(current.expandedPaths, action.path, expanded),
        pendingDiffPaths: uniquePaths([...current.pendingDiffPaths, ...diffLoadPaths]),
      }))
      const effects: ReviewEffect[] = diffLoadPaths.map(path => loadFileDiffEffect(state, patchset, path))
      if (!expanded || !status.loaded || status.status === 'reviewed') {
        return { effects, state: next }
      }
      const reviewedTransition = transitionReviewState(next, {
        path: action.path,
        reviewed: true,
        type: 'set-file-reviewed',
      }, catalog)
      return {
        effects: [...effects, ...reviewedTransition.effects],
        state: reviewedTransition.state,
      }
    }
    case 'set-all-files-expanded': {
      if (typeof action.expanded !== 'boolean' || !Array.isArray(action.paths)) return ignored(state)
      const validPaths = uniquePaths(action.paths.filter(path => hasFile(catalog, patchset, path)))
      const diffLoadPaths = action.expanded ? pendingDiffLoadPaths(catalog, patchset, patchsetState, validPaths) : []
      return {
        effects: diffLoadPaths.map(path => loadFileDiffEffect(state, patchset, path)),
        state: updateActivePatchset(state, current => ({
          ...current,
          diffLoadErrors: action.expanded
            ? validPaths.reduce((errors, path) => omitRecordKey(errors, path), current.diffLoadErrors)
            : current.diffLoadErrors,
          expandedPaths: action.expanded ? validPaths : [],
          autoReviewPaths: action.expanded ? current.autoReviewPaths : [],
          pendingDiffPaths: uniquePaths([...current.pendingDiffPaths, ...diffLoadPaths]),
        })),
      }
    }
    case 'commit-file-diff-load': {
      if (!catalog[action.patchset] || !hasFile(catalog, action.patchset, action.path)) return ignored(state)
      if (!matchesReviewIdentity(state, action.reviewId)) return ignored(state)
      const current = reviewStateForPatchset(state, action.patchset)
      if (!current.pendingDiffPaths.includes(action.path)) return ignored(state)
      return {
        effects: [],
        state: updatePatchset(state, action.patchset, patchsetState => ({
          ...patchsetState,
          diffLoadErrors: omitRecordKey(patchsetState.diffLoadErrors, action.path),
          pendingDiffPaths: updatePathList(patchsetState.pendingDiffPaths, action.path, false),
        })),
      }
    }
    case 'fail-file-diff-load': {
      if (!catalog[action.patchset] || !hasFile(catalog, action.patchset, action.path)) return ignored(state)
      if (!matchesReviewIdentity(state, action.reviewId)) return ignored(state)
      const current = reviewStateForPatchset(state, action.patchset)
      if (!current.pendingDiffPaths.includes(action.path)) return ignored(state)
      const message = action.error.trim() || 'review file diff request failed'
      return {
        effects: [],
        state: updatePatchset(state, action.patchset, patchsetState => ({
          ...patchsetState,
          diffLoadErrors: { ...patchsetState.diffLoadErrors, [action.path]: message },
          pendingDiffPaths: updatePathList(patchsetState.pendingDiffPaths, action.path, false),
        })),
      }
    }
    case 'toggle-common-context': {
      const file = patchsetFiles(catalog, patchset).find(item => item.path === action.path)
      const commonContext = file?.diff.hunks[action.hunkIndex]?.commonContext
      if (!file || !Number.isInteger(action.hunkIndex) || action.hunkIndex < 0 || !commonContext?.length) return ignored(state)
      const hunkKey = contextHunkKey(action.path, action.hunkIndex)
      return {
        effects: [],
        state: updateActivePatchset(state, current => ({
          ...current,
          revealedContextHunks: updatePathList(
            current.revealedContextHunks,
            hunkKey,
            !current.revealedContextHunks.includes(hunkKey)
          ),
        })),
      }
    }
    case 'set-file-reviewed': {
      return transitionReviewState(state, {
        changes: [{ path: action.path, reviewed: action.reviewed }],
        type: 'set-files-reviewed',
      }, catalog)
    }
    case 'set-files-reviewed': {
      if (!patchsetState.reviewedLoaded || patchsetState.pendingReview) return ignored(state)
      const changes = normalizeReviewStatusChanges(catalog, patchset, patchsetState.reviewedPaths, action.changes)
      if (!changes.length) return ignored(state)
      return {
        effects: [saveReviewedStatusEffect(state, patchset, patchsetState.reviewedRevision, changes)],
        state: updateActivePatchset(state, current => ({
          ...current,
          autoReviewPaths: changes.reduce((paths, change) => updatePathList(paths, change.path, false), current.autoReviewPaths),
          pendingReview: { changes },
          reviewedPaths: applyReviewStatusChanges(current.reviewedPaths, changes),
        })),
      }
    }
    case 'hydrate-reviewed-status': {
      if (!catalog[action.patchset] || !Array.isArray(action.reviewedPaths) || !Number.isInteger(action.revision) || action.revision < 0) return ignored(state)
      if (!matchesReviewIdentity(state, action.reviewId)) return ignored(state)
      const current = reviewStateForPatchset(state, action.patchset)
      // Hydration may race with an earlier response. Never replace a newer
      // revision with an older snapshot, and never overwrite optimistic state
      // while a mutation is still in flight.
      if (current.pendingReview || action.revision < current.reviewedRevision) return ignored(state)
      const validPaths = new Set(patchsetFiles(catalog, action.patchset).map(file => file.path))
      const reviewedPaths = uniquePaths(action.reviewedPaths.filter(path => validPaths.has(path)))
      const autoReviewChanges = normalizeReviewStatusChanges(
        catalog,
        action.patchset,
        reviewedPaths,
        current.autoReviewPaths.map(path => ({ path, reviewed: true }))
      )
      const patchsetState = {
        ...current,
        autoReviewPaths: [],
        ...(autoReviewChanges.length ? { pendingReview: { changes: autoReviewChanges } } : {}),
        reviewedLoaded: true,
        reviewedPaths: autoReviewChanges.length ? applyReviewStatusChanges(reviewedPaths, autoReviewChanges) : reviewedPaths,
        reviewedRevision: action.revision,
      }
      return {
        effects: autoReviewChanges.length
          ? [saveReviewedStatusEffect(state, action.patchset, action.revision, autoReviewChanges)]
          : [],
        state: {
          ...state,
          patchsets: {
            ...state.patchsets,
            [action.patchset]: patchsetState,
          },
        },
      }
    }
    case 'commit-reviewed-status': {
      if (!catalog[action.patchset] || !Number.isInteger(action.revision) || action.revision < 0) return ignored(state)
      if (!matchesReviewIdentity(state, action.reviewId)) return ignored(state)
      const current = reviewStateForPatchset(state, action.patchset)
      const pending = current.pendingReview
      const paths = action.paths ?? (action.path ? [action.path] : [])
      const pendingPaths = pending?.changes.map(change => change.path) ?? []
      if (
        !pending
        || paths.length !== pendingPaths.length
        || paths.some(path => !pendingPaths.includes(path))
        || action.revision < current.reviewedRevision
      ) {
        return ignored(state)
      }
      const reviewedPaths = Array.isArray(action.reviewedPaths)
        ? uniquePaths(action.reviewedPaths.filter(path => hasFile(catalog, action.patchset, path)))
        : current.reviewedPaths
      return {
        effects: [],
        state: {
          ...state,
          patchsets: {
            ...state.patchsets,
            [action.patchset]: {
              ...current,
              autoReviewPaths: pendingPaths.reduce((paths, path) => updatePathList(paths, path, false), current.autoReviewPaths),
              pendingReview: undefined,
              reviewedLoaded: true,
              reviewedPaths,
              reviewedRevision: action.revision,
            },
          },
        },
      }
    }
    case 'restore-reviewed-status': {
      if (!catalog[action.patchset] || !Array.isArray(action.reviewedPaths) || !Number.isInteger(action.revision) || action.revision < 0) return ignored(state)
      if (!matchesReviewIdentity(state, action.reviewId)) return ignored(state)
      const current = reviewStateForPatchset(state, action.patchset)
      if (!current.pendingReview || action.revision < current.reviewedRevision) return ignored(state)
      const validPaths = new Set(patchsetFiles(catalog, action.patchset).map(file => file.path))
      const reviewedPaths = uniquePaths(action.reviewedPaths.filter(path => validPaths.has(path)))
      return {
        effects: [],
        state: {
          ...state,
          patchsets: {
            ...state.patchsets,
            [action.patchset]: {
              ...current,
              autoReviewPaths: [],
              pendingReview: undefined,
              reviewedLoaded: true,
              reviewedPaths,
              reviewedRevision: action.revision,
            },
          },
        },
      }
    }
    case 'start-comment':
      if (
        !hasCommentPath(catalog, patchset, action.path)
        || !Number.isInteger(action.line) || action.line < 1
        || !validCommentSide(action.side)
        || (action.range !== undefined && !validReviewCommentRange(action.range))
      ) return ignored(state)
      return {
        effects: [],
        state: {
          ...state,
          commentDraft: {
            body: '',
            line: action.line,
            patchset,
            path: action.path,
            ...(action.range ? { range: action.range } : {}),
            side: action.side,
          },
        },
      }
    case 'update-comment-draft':
      return state.commentDraft ? { effects: [], state: { ...state, commentDraft: { ...state.commentDraft, body: action.body } } } : ignored(state)
    case 'cancel-comment':
      return state.commentDraft ? { effects: [], state: { ...state, commentDraft: undefined } } : ignored(state)
    case 'save-comment': {
      const draft = state.commentDraft
      const body = draft?.body.trim()
      if (
        !draft || !body || patchsetState.pendingComment
        || typeof action.id !== 'string' || !action.id.trim()
        || state.comments.some(comment => comment.patchset === patchset && comment.id === action.id)
      ) return ignored(state)
      const comment: ReviewComment = { ...draft, body, id: action.id }
      return {
        effects: [reviewCommentEffect(state, 'save-comment', comment)],
        state: updateActivePatchset({
          ...state,
          commentDraft: undefined,
          comments: [...state.comments, comment],
        }, current => ({ ...current, pendingComment: { id: comment.id, type: 'save' } })),
      }
    }
    case 'delete-comment': {
      const comment = state.comments.find(item => item.patchset === patchset && item.id === action.id)
      if (!comment || patchsetState.pendingComment) return ignored(state)
      return {
        effects: [reviewCommentEffect(state, 'delete-comment', comment)],
        state: updateActivePatchset({
          ...state,
          comments: state.comments.filter(item => item.patchset !== patchset || item.id !== action.id),
        }, current => ({ ...current, pendingComment: { id: comment.id, type: 'delete' } })),
      }
    }
    case 'hydrate-comments': {
      if (!catalog[action.patchset] || reviewStateForPatchset(state, action.patchset).pendingComment) return ignored(state)
      if (!matchesReviewIdentity(state, action.reviewId)) return ignored(state)
      const comments = normalizeReviewComments(action.comments, catalog, action.patchset)
      return {
        effects: [],
        state: {
          ...state,
          comments: [...state.comments.filter(comment => comment.patchset !== action.patchset), ...comments],
        },
      }
    }
    case 'commit-comment': {
      if (!catalog[action.patchset]) return ignored(state)
      if (!matchesReviewIdentity(state, action.reviewId)) return ignored(state)
      const current = reviewStateForPatchset(state, action.patchset)
      if (!matchesPendingComment(current.pendingComment, action)) return ignored(state)
      return {
        effects: [],
        state: updatePatchset(state, action.patchset, patchsetState => ({ ...patchsetState, pendingComment: undefined })),
      }
    }
    case 'restore-comments': {
      if (!catalog[action.patchset]) return ignored(state)
      if (!matchesReviewIdentity(state, action.reviewId)) return ignored(state)
      const current = reviewStateForPatchset(state, action.patchset)
      if (!matchesPendingComment(current.pendingComment, action)) return ignored(state)
      const comments = normalizeReviewComments(action.comments, catalog, action.patchset)
      return {
        effects: [],
        state: updatePatchset({
          ...state,
          comments: [...state.comments.filter(comment => comment.patchset !== action.patchset), ...comments],
        }, action.patchset, patchsetState => ({ ...patchsetState, pendingComment: undefined })),
      }
    }
  }
}
