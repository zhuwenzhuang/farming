import { useInteractionLayer } from '@/hooks/useInteractionLayer'
import { COMPACT_VIEWPORT_QUERY, isCompactViewport } from '@/lib/responsive-mode'
import { Fragment, memo, type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import hljs from 'highlight.js/lib/core'
import bash from 'highlight.js/lib/languages/bash'
import cpp from 'highlight.js/lib/languages/cpp'
import java from 'highlight.js/lib/languages/java'
import json from 'highlight.js/lib/languages/json'
import markdown from 'highlight.js/lib/languages/markdown'
import protobuf from 'highlight.js/lib/languages/protobuf'
import python from 'highlight.js/lib/languages/python'
import sql from 'highlight.js/lib/languages/sql'
import typescript from 'highlight.js/lib/languages/typescript'
import xml from 'highlight.js/lib/languages/xml'
import yaml from 'highlight.js/lib/languages/yaml'
import {
  CheckGlyph,
  ChevronDownGlyph,
  ChevronRightGlyph,
  CloseGlyph,
  CopyGlyph,
  DiffSplitGlyph,
  DiffUnifiedGlyph,
  SettingsGlyph,
} from '@/components/IconGlyphs'
import { CodeSelect } from '@/components/CodeSelect'
import { ReviewEndpointPicker } from './ReviewEndpointPicker'
import { useModalFocusScope } from '@/hooks/useModalFocusScope'
import { completeReviewFileDiffLoad, createReviewDiffQueue, failReviewFileDiffLoad } from '@/lib/review/effects'
import { reviewAdjacentFilePath, reviewAdjacentUnreviewedFilePath, reviewFileRowModel, type ReviewFileRowAction, type ReviewFileRowModel } from '@/lib/review/file-list'
import { acpReviewCaptureRequestFromSearch, reviewSnapshotRequestFromLocation } from '@/lib/review/route-target'
import { createReviewStateFromSnapshot, reviewCatalogFromSnapshot, reviewCatalogWithFile, reviewCatalogWithUnmodifiedPaths, reviewSnapshotRequestKey, type ReviewComparison, type ReviewDiffSnapshotRequest } from '@/lib/review/snapshot'
import {
  commentsForFilePaths,
  createReviewState,
  DEFAULT_REVIEW_PREFERENCES,
  normalizeReviewPreferences,
  reviewCommentPathForSide,
  reviewCommentSideForUnifiedCell,
  reviewStateForPatchset,
  transitionReviewState,
  type ReviewComment,
  type ReviewCommentRange,
  type ReviewCommentDraft,
  type ReviewCommentSide,
  type ReviewDiffCell,
  type ReviewDiffHunk,
  type ReviewDiffMode,
  type ReviewDiffRow,
  type ReviewCatalog,
  type ReviewFile,
  type ReviewFileDiff,
  type ReviewPreferences,
  type ReviewState,
} from '@/lib/review/state'
import { createAcpReviewSession, createReviewSession, deleteReviewComment, loadReviewComments, loadReviewComparisonSources, loadReviewDiffSnapshot, loadReviewFileContext, loadReviewFileDiff, loadReviewedPatchsetState, loadReviewSession, refreshReviewSession, reviewRequestForSessionRevision, ReviewApiError, REVIEW_FIXTURE_ID, saveReviewComment, saveReviewedFilesStatus, updateReviewCommentStatus, type ReviewComparisonSource, type ReviewComparisonSources, type ReviewContextRange, type ReviewSessionRevision } from '@/lib/review/api'

type DiffMode = ReviewDiffMode
type IgnoreWhitespace = ReviewPreferences['ignoreWhitespace']
type CommentSide = ReviewCommentSide
type Patchset = 'Patchset 20' | 'Patchset 19'
type CommentTarget = {
  line: number
  path: string
  range?: ReviewCommentRange
  side: CommentSide
}

type DiffPreferences = ReviewPreferences

type ContextGapDirection = 'above' | 'all' | 'below'
type ContextGapExpansion = {
  aboveRows: ReviewDiffRow[]
  belowRows: ReviewDiffRow[]
  error?: string
  pending?: ContextGapDirection
}

type ContextGapLocation = 'bottom' | 'middle' | 'top'

type ContextGapDescriptor = {
  availableRows: ReviewDiffRow[]
  baseAboveRows: ReviewDiffRow[]
  baseBelowRows: ReviewDiffRow[]
  expansion: ContextGapExpansion
  header: string
  hiddenLines: number
  key: string
  location: ContextGapLocation
  newHiddenStart: number
  oldHiddenStart: number
}

type ReviewFileSeed = Omit<ReviewFile, 'diff'>

function createDemoDiff(file: ReviewFileSeed): ReviewFileDiff {
  const language = diffLanguageForPath(file.path)
  const isPython = language === 'python'
  const createdName = basename(file.path).replace(/\W/g, '_')
  const context = (line: number, text: string): ReviewDiffRow => ({
    kind: 'context',
    left: { line, text },
    right: { line, text },
  })
  const commonContext = Array.from({ length: 128 }, (_, index) => {
    const line = index + 1
    const prefix = language === 'python' ? '#' : language === 'markdown' ? '<!--' : '//'
    const suffix = language === 'markdown' ? ' -->' : ''
    const label = line >= 29
      ? `unchanged review context ${line - 28}`
      : `unchanged review prelude ${line}`
    return context(line, `${line === 29 || line === 128 ? '\t' : ''}${prefix} ${label}${suffix}`)
  })

  if (file.kind === 'added') {
    const firstLine = isPython ? `${createdName} = create_review_snapshot()` : `export const ${createdName} = createReviewSnapshot()`
    const secondLine = isPython ? `__all__ = ["${createdName}"]` : `export default ${createdName}`
    return {
      hunks: [{
        header: `@@ -0,0 +1,2 @@ ${file.path}`,
        oldStart: 0,
        oldLines: 0,
        newStart: 1,
        newLines: 2,
        rows: [
          { kind: 'added', right: { line: 1, text: firstLine } },
          { kind: 'added', right: { line: 2, text: secondLine } },
        ],
      }],
    }
  }

  if (file.kind === 'deleted') {
    const firstLine = isPython ? 'def summarize_changes():' : 'export function summarizeChanges() {'
    const secondLine = isPython ? '    return "legacy summary"' : "  return 'legacy summary'"
    return {
      hunks: [{
        header: `@@ -1,2 +0,0 @@ ${file.path}`,
        oldStart: 1,
        oldLines: 2,
        newStart: 0,
        newLines: 0,
        rows: [
          { kind: 'deleted', left: { line: 1, text: firstLine } },
          { kind: 'deleted', left: { line: 2, text: secondLine } },
        ],
      }],
    }
  }

  const functionStart = isPython
    ? 'def create_change_set(input: ChangeInput) -> list[ReviewEntry]:'
    : 'export function createChangeSet(input: ChangeInput) {'
  const normalizeChanges = isPython ? '    return normalize_changes(input.files)' : '  return normalizeChanges(input.files)'
  const createReviewEntries = isPython ? '    return create_review_entries(input.files, input.base)' : '  return createReviewEntries(input.files, input.base)'
  const markReviewed = isPython ? 'def mark_reviewed(path: str) -> ReviewState:' : 'export function markReviewed(path: string) {'
  const reviewedResult = isPython ? '    return {"path": path, "reviewed_at": time.time()}' : '  return { path, reviewedAt: Date.now() }'
  const missingPath = isPython ? 'if not path:' : '  if (!path) return null'
  const snapshot = isPython ? '    return None' : '  const snapshot = readSnapshot(input.base)'
  const snapshotResult = isPython ? 'return {**snapshot, "files": input.files}' : '  return { ...snapshot, files: input.files }'
  const closing = isPython ? '' : '}'
  const whitespaceBefore = isPython ? '    return finalize_change_set(input)  ' : '  return finalizeChangeSet(input)  '

  return {
    hunks: [{
      commonContext,
      header: `@@ -129,7 +129,10 @@ ${file.path}`,
      oldStart: 129,
      oldLines: 7,
      newStart: 129,
      newLines: 10,
      rows: [
        context(129, functionStart),
        { kind: 'deleted', left: { line: 130, text: normalizeChanges } },
        { kind: 'added', right: { line: 130, text: createReviewEntries } },
        context(131, closing),
        { kind: 'added', right: { line: 133, text: markReviewed } },
        { kind: 'added', right: { line: 134, text: reviewedResult } },
        context(135, missingPath),
        context(136, snapshot),
        { kind: 'added', right: { line: 137, text: snapshotResult } },
        context(138, closing),
        { kind: 'deleted', left: { line: 139, text: whitespaceBefore }, whitespaceOnly: true },
        { kind: 'added', right: { line: 139, text: whitespaceBefore.trimEnd() }, whitespaceOnly: true },
      ],
    }],
  }
}

function withDemoDiff(file: ReviewFileSeed): ReviewFile {
  return { ...file, diff: createDemoDiff(file) }
}

const PATCHSET_FILE_SEEDS: Record<Patchset, ReviewFileSeed[]> = {
  'Patchset 20': [
  { path: 'clis/dataflow.py', kind: 'modified', added: 2, removed: 85 },
  { path: 'clis/diagnose.py', kind: 'modified', added: 8, removed: 11 },
  { path: 'clis/fetch_instance_log.py', kind: 'deleted', added: 0, removed: 573 },
  { path: 'clis/fetch_logview.py', kind: 'modified', added: 2, removed: 2 },
  { path: 'clis/fetch_meta_timeline.py', kind: 'modified', added: 0, removed: 2 },
  { path: 'clis/fetch_quota_snapshot.py', kind: 'deleted', added: 0, removed: 290 },
  { path: 'clis/hbo_plan_diagnose.py', kind: 'deleted', added: 0, removed: 119 },
  { path: 'clis/parse_logview.py', kind: 'modified', added: 6, removed: 2 },
  { path: 'clis/query_sls.py', kind: 'modified', added: 14, removed: 2 },
  { path: 'devclis/README.md', kind: 'added', added: 15, removed: 0 },
  { path: 'docs/cli/studio.md', kind: 'modified', added: 1, removed: 2 },
  {
    path: 'tests/review/change-set.spec.ts',
    kind: 'renamed',
    previousPath: 'tests/changes/change-summary.spec.ts',
    added: 28,
    removed: 6,
  },
  ],
  'Patchset 19': [
    { path: 'clis/dataflow.py', kind: 'modified', added: 1, removed: 52 },
    { path: 'clis/diagnose.py', kind: 'modified', added: 5, removed: 6 },
    { path: 'clis/fetch_instance_log.py', kind: 'deleted', added: 0, removed: 573 },
    { path: 'clis/fetch_logview.py', kind: 'modified', added: 1, removed: 2 },
    { path: 'clis/fetch_meta_timeline.py', kind: 'modified', added: 0, removed: 2 },
    { path: 'clis/hbo_plan_diagnose.py', kind: 'deleted', added: 0, removed: 119 },
    { path: 'clis/parse_logview.py', kind: 'modified', added: 4, removed: 2 },
    { path: 'clis/query_sls.py', kind: 'modified', added: 7, removed: 1 },
    { path: 'docs/cli/studio.md', kind: 'modified', added: 1, removed: 1 },
  ],
}

const PATCHSET_FILES = Object.fromEntries(
  Object.entries(PATCHSET_FILE_SEEDS).map(([patchset, files]) => [patchset, files.map(withDemoDiff)])
) as Record<Patchset, ReviewFile[]>

const WORKING_COPY_PATCHSET = 'Working copy'
const INVALID_REVIEW_PATCHSET = 'Review'

const DEFAULT_REVIEWED_PATHS: Record<Patchset, string[]> = {
  'Patchset 20': ['clis/dataflow.py', 'clis/fetch_instance_log.py'],
  'Patchset 19': ['clis/fetch_instance_log.py'],
}
const DEFAULT_DIFF_PREFERENCES: DiffPreferences = DEFAULT_REVIEW_PREFERENCES
const DIFF_PREFERENCES_STORAGE_KEY = 'farming.review.diff-preferences'

hljs.registerLanguage('typescript', typescript)
hljs.registerLanguage('python', python)
hljs.registerLanguage('sql', sql)
hljs.registerLanguage('markdown', markdown)
hljs.registerLanguage('cpp', cpp)
hljs.registerLanguage('java', java)
hljs.registerLanguage('protobuf', protobuf)
hljs.registerLanguage('json', json)
hljs.registerLanguage('yaml', yaml)
hljs.registerLanguage('bash', bash)
hljs.registerLanguage('xml', xml)

function readStoredDiffPreferences() {
  if (typeof window === 'undefined') return DEFAULT_DIFF_PREFERENCES
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(DIFF_PREFERENCES_STORAGE_KEY) || '{}')
    return normalizeReviewPreferences(value)
  } catch {
    return DEFAULT_DIFF_PREFERENCES
  }
}

function initialReviewPatchset(request: ReviewDiffSnapshotRequest | null, fixtureMode = true) {
  if (!request) return fixtureMode ? 'Patchset 20' : INVALID_REVIEW_PATCHSET
  return request.source === 'git-range' ? request.head : WORKING_COPY_PATCHSET
}

function initialReviewBasePatchset(request: ReviewDiffSnapshotRequest | null, fixtureMode = true) {
  if (!request) return fixtureMode ? 'Base' : 'Base'
  return request.source === 'git-range' ? request.base : 'HEAD'
}

function initialReviewCatalog(request: ReviewDiffSnapshotRequest | null, fixtureMode = true): ReviewCatalog {
  if (!request) return fixtureMode ? PATCHSET_FILES : { [INVALID_REVIEW_PATCHSET]: [] }
  return { [initialReviewPatchset(request, fixtureMode)]: [] }
}

function reviewRequestIdentityKey(request: ReviewDiffSnapshotRequest | null) {
  if (!request) return ''
  return reviewSnapshotRequestKey({ ...request, limit: undefined, metadataOnly: true })
}

function createPageReviewState({
  catalog,
  comments,
  initialPatchset,
  basePatchset,
  initiallyExpand,
  reviewId,
}: {
  basePatchset: string
  catalog: ReviewCatalog
  comments: ReviewComment[]
  initialPatchset: string
  initiallyExpand: boolean
  reviewId?: string
}) {
  const state = createReviewState({
    catalog,
    comments,
    patchRange: { basePatchset, patchset: initialPatchset },
    preferences: readStoredDiffPreferences(),
    reviewId,
    reviewedPathsByPatchset: initialPatchset === 'Patchset 20' || initialPatchset === 'Patchset 19' ? DEFAULT_REVIEWED_PATHS : {},
  })
  if (!initiallyExpand) return state
  return {
    ...state,
    patchsets: Object.fromEntries(Object.keys(catalog).map(patchset => {
      const patchsetFiles = catalog[patchset] ?? []
      const initiallyExpandedPath = patchsetFiles[1]?.path ?? patchsetFiles[0]?.path
      return [patchset, {
        ...reviewStateForPatchset(state, patchset),
        expandedPaths: initiallyExpandedPath ? [initiallyExpandedPath] : [],
      }]
    })) as ReviewState['patchsets'],
  }
}

function basename(path: string) {
  const segments = path.split('/')
  return segments[segments.length - 1] || path
}

function ReviewPath({ path, previous = false }: { path: string; previous?: boolean }) {
  const separator = path.lastIndexOf('/')
  return <span className={`${previous ? 'review-file-previous-path' : 'review-file-name'}${separator >= 0 ? ' review-path-with-directory' : ''}`} title={previous ? `Previous path: ${path}` : path} aria-label={path}>
    {separator >= 0 ? <span className="review-path-directory">{path.slice(0, separator)}</span> : null}
    <span className="review-path-basename">{separator >= 0 ? path.slice(separator) : path}</span>
  </span>
}

function comparisonLabel(id: string) {
  if (id === 'custom-range') return 'Custom comparison'
  if (id === 'unstaged') return 'Unstaged'
  if (id === 'staged') return 'Staged'
  if (id === 'working-copy') return 'Working copy'
  if (id === 'untracked') return 'Untracked'
  if (id === 'agent-changes') return 'Agent changes'
  return 'Changes'
}

function formatBytes(value: number) {
  const absolute = Math.abs(value)
  if (absolute < 1024) return `${value} B`
  if (absolute < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character] ?? character))
}

function sliceCodepoints(value: string, start: number, end?: number) {
  return Array.from(value).slice(start, end).join('')
}

function ReviewStatus({
  action,
  pending,
  reviewed,
  reviewedLabel,
  onToggle,
}: {
  action: ReviewFileRowAction | null
  pending: boolean
  reviewed: boolean | null
  reviewedLabel: 'Reviewed' | null
  onToggle: () => void
}) {
  return (
    <div className={`review-review-status ${reviewed ? 'reviewed' : ''} ${pending ? 'pending' : ''}`}>
      {reviewedLabel ? <span className="review-reviewed-label">{reviewedLabel}</span> : null}
      {action ? (
        <button
          type="button"
          aria-checked={reviewed === true}
          aria-label="Reviewed"
          data-action-visibility={action.visibility}
          disabled={action.disabled}
          role="switch"
          title={pending ? 'Saving review status' : action.ariaLabel}
          onClick={onToggle}
        >
          {pending ? 'SAVING…' : action.label}
        </button>
      ) : (
        <span className="review-review-loading">Reviewed status loading</span>
      )}
    </div>
  )
}

function ChangeBar({ file, maxChangeSize }: { file: ReviewFile; maxChangeSize: number }) {
  if (file.binary) return <span className="review-change-bar binary" aria-label="Binary file" />
  const width = (value: number) => value === 0 ? 0 : Math.max(2, Math.round((value / maxChangeSize) * 72))
  return (
    <span className="review-change-bar" aria-label={`+${file.added} −${file.removed}`}>
      <i className="added" style={{ width: `${width(file.added)}px` }} />
      <i className="deleted" style={{ width: `${width(file.removed)}px` }} />
    </span>
  )
}

function FileStats({ file }: { file: ReviewFile }) {
  if (file.binary) {
    const sizeDelta = typeof file.sizeDelta === 'number' && Number.isInteger(file.sizeDelta)
      ? file.sizeDelta
      : null
    return (
      <span className="review-file-stats binary">
        {sizeDelta === null ? 'Binary' : formatBytes(sizeDelta)}
      </span>
    )
  }
  return <span className="review-file-stats">{file.added ? <span className="added">+{file.added}</span> : null}{file.removed ? <span className="removed">−{file.removed}</span> : null}</span>
}

export function diffLanguageForPath(path: string) {
  const normalizedPath = path.toLowerCase()
  if (normalizedPath.endsWith('.osql') || normalizedPath.endsWith('.odpsql')) return 'sql'
  if (normalizedPath.endsWith('.py')) return 'python'
  if (normalizedPath.endsWith('.md') || normalizedPath.endsWith('.mdx')) return 'markdown'
  if (/\.(c|cc|cpp|cxx|h|hh|hpp|hxx)$/.test(normalizedPath)) return 'cpp'
  if (normalizedPath.endsWith('.java')) return 'java'
  if (normalizedPath.endsWith('.proto')) return 'protobuf'
  if (normalizedPath.endsWith('.json')) return 'json'
  if (normalizedPath.endsWith('.yaml') || normalizedPath.endsWith('.yml')) return 'yaml'
  if (/\.(bash|sh|zsh)$/.test(normalizedPath)) return 'bash'
  if (/\.(html|htm|xml)$/.test(normalizedPath)) return 'xml'
  return 'typescript'
}

// Selection UI must not rewrite highlighted DOM nodes while the user selects them.
const CodeCell = memo(function CodeCell({
  intraline,
  language,
  line,
  side,
  text,
  preferences,
}: {
  intraline?: ReviewDiffCell['intraline']
  language: string
  line?: number
  side?: CommentSide
  text: string
  preferences: DiffPreferences
}) {
  const commentAttributes = line && side
    ? { 'data-review-line': line, 'data-review-side': side }
    : {}
  const trailingWhitespace = preferences.showTrailingWhitespace ? text.match(/[ \t]+$/)?.[0] : undefined
  const source = trailingWhitespace ? text.slice(0, -trailingWhitespace.length) : text
  const activeIntraline = preferences.intralineDifference ? intraline : undefined
  let html = activeIntraline?.length
    ? renderIntralineHtml(source, activeIntraline, language, preferences)
    : renderCodeHtml(source, language, preferences)
  if (preferences.showTabs) html = html.replace(/\t/g, '<span class="review-tab-marker">⇥</span>')
  if (trailingWhitespace) {
    html += `<span class="review-trailing-whitespace">${trailingWhitespace.replace(/[ \t]/g, '·')}</span>`
  }
  return <code {...commentAttributes} data-review-text={text} dangerouslySetInnerHTML={{ __html: html }} />
})

function LineNumber({ line, side }: { line?: number; side: CommentSide }) {
  return line ? <button type="button" className="review-line-number" data-review-line={line} data-review-side={side} aria-label={`Comment on ${side === 'left' ? 'base' : 'patchset'} line ${line}`}>{line}</button> : <span />
}

function renderCodeHtml(text: string, language: string, preferences: DiffPreferences) {
  return preferences.syntaxHighlighting && text
    ? hljs.highlight(text, { language, ignoreIllegals: true }).value
    : escapeHtml(text)
}

function renderIntralineHtml(text: string, ranges: NonNullable<ReviewDiffCell['intraline']>, language: string, preferences: DiffPreferences) {
  let html = ''
  let cursor = 0
  const length = Array.from(text).length
  for (const range of ranges) {
    const start = Math.max(cursor, Math.min(range.start, length))
    const end = Math.max(start, Math.min(range.end, length))
    html += renderCodeHtml(sliceCodepoints(text, cursor, start), language, preferences)
    if (end > start) {
      html += `<span class="review-intraline">${renderCodeHtml(sliceCodepoints(text, start, end), language, preferences)}</span>`
    }
    cursor = end
  }
  html += renderCodeHtml(sliceCodepoints(text, cursor), language, preferences)
  return html
}

function UnifiedRow({
  baseLine,
  kind,
  intraline,
  language,
  line,
  side,
  text,
  preferences,
  renderAttachment,
}: {
  baseLine?: number
  kind: 'added' | 'changed' | 'deleted' | 'context'
  intraline?: ReviewDiffCell['intraline']
  language: string
  line?: number
  side: CommentSide
  text: string
  preferences: DiffPreferences
  renderAttachment?: (line: number, sides: CommentSide[]) => ReactNode
}) {
  return (
    <>
      <div className={`review-diff-row unified ${kind}`}>
        <LineNumber line={side === 'left' ? line : baseLine} side="left" />
        <LineNumber line={side === 'left' ? undefined : line} side="right" />
        <span className="review-diff-sign" aria-hidden="true">{kind === 'added' ? '+' : kind === 'deleted' ? '−' : ''}</span>
        <CodeCell intraline={intraline} language={language} line={line} side={side} text={text} preferences={preferences} />
      </div>
      {baseLine && side !== 'left' ? renderAttachment?.(baseLine, ['left']) : null}
      {line ? renderAttachment?.(line, [side]) : null}
    </>
  )
}

function SplitRow({
  kind,
  language,
  leftLine,
  leftIntraline,
  leftText,
  rightLine,
  rightIntraline,
  rightText,
  preferences,
  renderAttachment,
}: {
  kind: 'added' | 'changed' | 'deleted' | 'context'
  language: string
  leftIntraline?: ReviewDiffCell['intraline']
  leftLine?: number
  leftText?: string
  rightIntraline?: ReviewDiffCell['intraline']
  rightLine?: number
  rightText?: string
  preferences: DiffPreferences
  renderAttachment?: (line: number, sides: CommentSide[]) => ReactNode
}) {
  return (
    <>
      <div className={`review-diff-row ${kind}`}>
        <LineNumber line={leftLine} side="left" /><CodeCell intraline={leftIntraline} language={language} line={leftLine} side="left" text={leftText ?? ''} preferences={preferences} />
        <LineNumber line={rightLine} side="right" /><CodeCell intraline={rightIntraline} language={language} line={rightLine} side="right" text={rightText ?? ''} preferences={preferences} />
      </div>
      {leftLine ? renderAttachment?.(leftLine, leftLine === rightLine ? ['left', 'right'] : ['left']) : null}
      {rightLine && rightLine !== leftLine ? renderAttachment?.(rightLine, ['right']) : null}
    </>
  )
}

function splitOuterContext(rows: ReviewDiffRow[]) {
  const firstChange = rows.findIndex(row => row.kind !== 'context')
  if (firstChange < 0) return { body: rows, leading: [] as ReviewDiffRow[], trailing: [] as ReviewDiffRow[] }
  let lastChange = rows.length - 1
  while (lastChange > firstChange && rows[lastChange]?.kind === 'context') lastChange -= 1
  return {
    body: rows.slice(firstChange, lastChange + 1),
    leading: rows.slice(0, firstChange),
    trailing: rows.slice(lastChange + 1),
  }
}

function changedBoundaryLine(rows: ReviewDiffRow[], edge: 'first' | 'last', side: 'left' | 'right') {
  const changes = rows.filter(row => row.kind !== 'context' && row.kind !== 'skipped')
  const ordered = edge === 'first' ? changes : [...changes].reverse()
  const changedLine = ordered.find(row => row[side]?.line)?.[side]?.line
  if (changedLine !== undefined) return changedLine
  // A pure insertion/deletion has no changed cell on its opposite side.
  // Its boundary lies between the adjacent common lines on that side.
  const outer = splitOuterContext(rows)
  const before = outer.leading[outer.leading.length - 1]?.[side]?.line
  const after = outer.trailing[0]?.[side]?.line
  return edge === 'first'
    ? before !== undefined ? before + 1 : after
    : after !== undefined ? after - 1 : before
}

function embeddedCommonLinesBeforeHunk(hunks: ReviewDiffHunk[], index: number) {
  const currentRows = hunks[index]?.rows ?? []
  const previousRows = hunks[index - 1]?.rows ?? []
  const gaps = (['left', 'right'] as const).flatMap(side => {
    const currentLine = changedBoundaryLine(currentRows, 'first', side)
    if (!currentLine) return []
    const previousLine = changedBoundaryLine(previousRows, 'last', side)
    return [Math.max(0, currentLine - (previousLine ?? 0) - 1)]
  })
  return gaps.length ? Math.min(...gaps) : 0
}

function commonLinesBeforeHunk(hunks: ReviewDiffHunk[], index: number) {
  const current = hunks[index]
  if (!current) return 0
  const previous = hunks[index - 1]
  const oldPreviousEnd = previous ? previous.oldStart + previous.oldLines - 1 : 0
  const newPreviousEnd = previous ? previous.newStart + previous.newLines - 1 : 0
  return Math.max(0, Math.min(
    current.oldStart - oldPreviousEnd - 1,
    current.newStart - newPreviousEnd - 1,
  ))
}

function commonLinesAfterFile(file: ReviewFile, usesEmbeddedContext: boolean) {
  const lastHunk = file.diff.hunks[file.diff.hunks.length - 1]
  const leftLines = file.diff.leftMeta?.lines
  const rightLines = file.diff.rightMeta?.lines
  if (!lastHunk || !Number.isInteger(leftLines) || !Number.isInteger(rightLines)) return 0
  const lastLeft = (usesEmbeddedContext ? changedBoundaryLine(lastHunk.rows, 'last', 'left') : undefined)
    ?? lastHunk.oldStart + lastHunk.oldLines - 1
  const lastRight = (usesEmbeddedContext ? changedBoundaryLine(lastHunk.rows, 'last', 'right') : undefined)
    ?? lastHunk.newStart + lastHunk.newLines - 1
  return Math.max(0, Math.min((leftLines ?? 0) - lastLeft, (rightLines ?? 0) - lastRight))
}

function contextGapKey(prefix: string, path: string, hunks: ReviewDiffHunk[], index: number) {
  const previousHunk = hunks[index - 1]
  const currentHunk = hunks[index]
  const previous = previousHunk
    ? `${previousHunk.oldStart + previousHunk.oldLines - 1}:${previousHunk.newStart + previousHunk.newLines - 1}`
    : '0:0'
  const current = currentHunk ? `${currentHunk.oldStart}:${currentHunk.newStart}` : '0:0'
  return `${prefix}:${path}:${previous}>${current}`
}

function bottomContextGapKey(prefix: string, file: ReviewFile) {
  const lastHunk = file.diff.hunks[file.diff.hunks.length - 1]
  const previous = lastHunk
    ? `${lastHunk.oldStart + lastHunk.oldLines - 1}:${lastHunk.newStart + lastHunk.newLines - 1}`
    : '0:0'
  return `${prefix}:${file.path}:${previous}>eof:${file.diff.leftMeta?.lines ?? 0}:${file.diff.rightMeta?.lines ?? 0}`
}

function emptyContextGapExpansion(): ContextGapExpansion {
  return { aboveRows: [], belowRows: [] }
}

function contextGapBeforeHunk(
  contextKeyPrefix: string,
  contextGapExpansions: Record<string, ContextGapExpansion>,
  file: ReviewFile,
  hunkIndex: number,
  context: number,
): ContextGapDescriptor {
  const hunk = file.diff.hunks[hunkIndex]
  const previousHunk = file.diff.hunks[hunkIndex - 1]
  const outerContext = splitOuterContext(hunk?.rows ?? [])
  const previousOuterContext = previousHunk ? splitOuterContext(previousHunk.rows) : null
  const commonContext = [...(hunk?.commonContext ?? []), ...outerContext.leading]
  const usesEmbeddedContext = Boolean(commonContext.length || previousOuterContext?.trailing.length)
  const totalLines = usesEmbeddedContext
    ? embeddedCommonLinesBeforeHunk(file.diff.hunks, hunkIndex)
    : commonLinesBeforeHunk(file.diff.hunks, hunkIndex)
  const key = contextGapKey(contextKeyPrefix, file.path, file.diff.hunks, hunkIndex)
  const expansion = contextGapExpansions[key] ?? emptyContextGapExpansion()
  const baseAboveRows = previousOuterContext?.trailing.slice(0, hunkIndex > 0 ? Math.min(totalLines, context) : 0) ?? []
  const baseBelowCount = Math.min(Math.max(0, totalLines - baseAboveRows.length), context)
  const baseBelowRows = baseBelowCount > 0 ? commonContext.slice(-baseBelowCount) : []
  const hiddenLines = Math.max(0, totalLines
    - (usesEmbeddedContext ? baseAboveRows.length + baseBelowRows.length : 0)
    - expansion.aboveRows.length
    - expansion.belowRows.length)
  const previousLeft = usesEmbeddedContext
    ? changedBoundaryLine(previousHunk?.rows ?? [], 'last', 'left') ?? 0
    : previousHunk ? previousHunk.oldStart + previousHunk.oldLines - 1 : 0
  const previousRight = usesEmbeddedContext
    ? changedBoundaryLine(previousHunk?.rows ?? [], 'last', 'right') ?? 0
    : previousHunk ? previousHunk.newStart + previousHunk.newLines - 1 : 0
  const oldHiddenStart = previousLeft + (usesEmbeddedContext ? baseAboveRows.length : 0) + expansion.aboveRows.length + 1
  const newHiddenStart = previousRight + (usesEmbeddedContext ? baseAboveRows.length : 0) + expansion.aboveRows.length + 1
  const candidateRows = [...(previousOuterContext?.trailing ?? []), ...(hunk?.commonContext ?? []), ...outerContext.leading]
  return {
    availableRows: candidateRows.filter(row => {
      const oldLine = row.left?.line
      const newLine = row.right?.line
      return oldLine !== undefined && newLine !== undefined
        && oldLine >= oldHiddenStart && oldLine < oldHiddenStart + hiddenLines
        && newLine >= newHiddenStart && newLine < newHiddenStart + hiddenLines
    }),
    baseAboveRows,
    baseBelowRows,
    expansion,
    header: hunk?.header ?? '',
    hiddenLines,
    key,
    location: hunkIndex === 0 ? 'top' : 'middle',
    newHiddenStart,
    oldHiddenStart,
  }
}

function contextGapAfterFile(
  contextKeyPrefix: string,
  contextGapExpansions: Record<string, ContextGapExpansion>,
  file: ReviewFile,
  context: number,
): ContextGapDescriptor | null {
  const lastHunk = file.diff.hunks[file.diff.hunks.length - 1]
  if (!lastHunk) return null
  const key = bottomContextGapKey(contextKeyPrefix, file)
  const expansion = contextGapExpansions[key] ?? emptyContextGapExpansion()
  const trailingRows = splitOuterContext(lastHunk.rows).trailing
  const usesEmbeddedContext = trailingRows.length > 0
  const totalLines = commonLinesAfterFile(file, usesEmbeddedContext)
  const baseAboveRows = trailingRows.slice(0, Math.min(totalLines, context))
  const hiddenLines = Math.max(0, totalLines - baseAboveRows.length - expansion.aboveRows.length)
  const previousLeft = (usesEmbeddedContext ? changedBoundaryLine(lastHunk.rows, 'last', 'left') : undefined)
    ?? lastHunk.oldStart + lastHunk.oldLines - 1
  const previousRight = (usesEmbeddedContext ? changedBoundaryLine(lastHunk.rows, 'last', 'right') : undefined)
    ?? lastHunk.newStart + lastHunk.newLines - 1
  const oldHiddenStart = previousLeft + baseAboveRows.length + expansion.aboveRows.length + 1
  const newHiddenStart = previousRight + baseAboveRows.length + expansion.aboveRows.length + 1
  return {
    availableRows: trailingRows.filter(row => {
      const oldLine = row.left?.line
      const newLine = row.right?.line
      return oldLine !== undefined && newLine !== undefined
        && oldLine >= oldHiddenStart
        && newLine >= newHiddenStart
    }),
    baseAboveRows,
    baseBelowRows: [],
    expansion,
    header: '',
    hiddenLines,
    key,
    location: 'bottom',
    newHiddenStart,
    oldHiddenStart,
  }
}

function ContextGapControl({
  gap,
  onExpand,
}: {
  gap: ContextGapDescriptor
  onExpand: (direction: ContextGapDirection) => void
}) {
  const showPartial = gap.hiddenLines > 10
  const disabled = Boolean(gap.expansion.pending)
  return (
    <div className="review-diff-hunk interactive" role="group" aria-label={`${gap.hiddenLines} hidden common lines`}>
      <span>{gap.header}</span>
      <span className="review-context-controls">
        {showPartial && gap.location !== 'top' ? <button type="button" disabled={disabled} aria-label="Show 10 lines above" onClick={() => onExpand('above')}>+10↑</button> : null}
        {showPartial && gap.location !== 'top' ? <span aria-hidden="true">−</span> : null}
        <button type="button" disabled={disabled} aria-label={`Show all ${gap.hiddenLines} common lines`} onClick={() => onExpand('all')}>+{gap.hiddenLines} common {gap.hiddenLines === 1 ? 'line' : 'lines'}</button>
        {showPartial && gap.location !== 'bottom' ? <span aria-hidden="true">−</span> : null}
        {showPartial && gap.location !== 'bottom' ? <button type="button" disabled={disabled} aria-label="Show 10 lines below" onClick={() => onExpand('below')}>+10↓</button> : null}
      </span>
      {gap.expansion.error ? <span className="review-context-error" role="alert">{gap.expansion.error}</span> : null}
    </div>
  )
}

function DiffRows({
  contextKeyPrefix,
  contextGapExpansions,
  file,
  mode,
  preferences,
  renderAttachment,
  onExpandContext,
  onExpandSkippedContext,
}: {
  contextKeyPrefix: string
  contextGapExpansions: Record<string, ContextGapExpansion>
  file: ReviewFile
  mode: DiffMode
  preferences: DiffPreferences
  renderAttachment: (line: number, sides: CommentSide[]) => ReactNode
  onExpandContext: (gap: ContextGapDescriptor, direction: ContextGapDirection, range: ReviewContextRange) => void
  onExpandSkippedContext: (gapKey: string, hunkIndex: number, context: number) => void
}) {
  const language = diffLanguageForPath(file.path)
  const missingNewline = file.diff.hunks.reduce((result, hunk) => {
    for (const row of [...(hunk.commonContext ?? []), ...hunk.rows]) {
      if (row.left?.missingNewlineAtEnd) result.left = true
      if (row.right?.missingNewlineAtEnd) result.right = true
    }
    return result
  }, { left: false, right: false })
  const renderSkippedRow = (row: ReviewDiffRow, key: string, hunkIndex: number) => {
    const skipped = Math.max(row.leftLines ?? 0, row.rightLines ?? 0)
    const gapKey = contextGapKey(contextKeyPrefix, file.path, file.diff.hunks, hunkIndex)
    const currentContext = preferences.context
    const step = Math.min(10, skipped)
    return <button type="button" key={key} className="review-skipped-row" onClick={() => onExpandSkippedContext(gapKey, hunkIndex, Math.min(10000, currentContext + step))}>Show {step} more common lines ({skipped} hidden)</button>
  }
  const renderRows = (rows: ReviewDiffRow[], hunkIndex: number, section: 'change' | 'context') => {
    const visibleRows = preferences.ignoreWhitespace === 'NONE'
      ? rows
      : rows.filter(row => !row.whitespaceOnly)
    return (
      <>
        {visibleRows.map((row, index) => {
          const key = `${section}:${hunkIndex}:${row.left?.line ?? ''}:${row.right?.line ?? ''}:${index}`
          if (mode === 'unified') {
            if (row.kind === 'skipped') return renderSkippedRow(row, key, hunkIndex)
            if (row.kind === 'context') {
              const cell = row.right ?? row.left
              return <UnifiedRow key={key} baseLine={row.left?.line} intraline={cell?.intraline} kind="context" language={language} line={cell?.line} side={reviewCommentSideForUnifiedCell('context', Boolean(row.right))} text={cell?.text ?? ''} preferences={preferences} renderAttachment={renderAttachment} />
            }
            if (row.kind === 'changed') {
              return <Fragment key={key}>
                <UnifiedRow intraline={row.left?.intraline} kind="deleted" language={language} line={row.left?.line} side={reviewCommentSideForUnifiedCell('deleted', false)} text={row.left?.text ?? ''} preferences={preferences} renderAttachment={renderAttachment} />
                <UnifiedRow intraline={row.right?.intraline} kind="added" language={language} line={row.right?.line} side={reviewCommentSideForUnifiedCell('added', true)} text={row.right?.text ?? ''} preferences={preferences} renderAttachment={renderAttachment} />
              </Fragment>
            }
            if (row.left) {
              return <UnifiedRow key={key} intraline={row.left.intraline} kind="deleted" language={language} line={row.left.line} side={reviewCommentSideForUnifiedCell('deleted', false)} text={row.left.text} preferences={preferences} renderAttachment={renderAttachment} />
            }
            return <UnifiedRow key={key} intraline={row.right?.intraline} kind="added" language={language} line={row.right?.line} side={reviewCommentSideForUnifiedCell('added', Boolean(row.right))} text={row.right?.text ?? ''} preferences={preferences} renderAttachment={renderAttachment} />
          }
          if (row.kind === 'skipped') return renderSkippedRow(row, key, hunkIndex)
          return <SplitRow key={key} kind={row.kind} language={language} leftIntraline={row.left?.intraline} leftLine={row.left?.line} leftText={row.left?.text} rightIntraline={row.right?.intraline} rightLine={row.right?.line} rightText={row.right?.text} preferences={preferences} renderAttachment={renderAttachment} />
        })}
      </>
    )
  }

  const gapsBefore = file.diff.hunks.map((_, index) => contextGapBeforeHunk(contextKeyPrefix, contextGapExpansions, file, index, preferences.context))
  const bottomGap = contextGapAfterFile(contextKeyPrefix, contextGapExpansions, file, preferences.context)
  const allGaps = [...gapsBefore, ...(bottomGap ? [bottomGap] : [])]
  const autoExpandGaps = allGaps.filter(gap => gap.hiddenLines > 0 && gap.hiddenLines <= 3 && !gap.expansion.pending && !gap.expansion.error)
  const autoExpandSignature = autoExpandGaps.map(gap => `${gap.key}:${gap.hiddenLines}:${gap.oldHiddenStart}:${gap.newHiddenStart}`).join('|')
  const onExpandContextRef = useRef(onExpandContext)
  onExpandContextRef.current = onExpandContext
  // Read the gaps through a ref: autoExpandGaps is a fresh filtered array every
  // render, so the effect triggers on the stable signature and reads latest gaps.
  const autoExpandGapsRef = useRef(autoExpandGaps)
  autoExpandGapsRef.current = autoExpandGaps
  useEffect(() => {
    for (const gap of autoExpandGapsRef.current) {
      onExpandContextRef.current(gap, 'all', {
        lines: gap.hiddenLines,
        newStart: gap.newHiddenStart,
        oldStart: gap.oldHiddenStart,
      })
    }
  }, [autoExpandSignature])

  const expandGap = (gap: ContextGapDescriptor, direction: ContextGapDirection) => {
    const lines = direction === 'all' ? gap.hiddenLines : Math.min(10, gap.hiddenLines)
    const offset = direction === 'below' ? gap.hiddenLines - lines : 0
    onExpandContext(gap, direction, {
      lines,
      newStart: gap.newHiddenStart + offset,
      oldStart: gap.oldHiddenStart + offset,
    })
  }
  const renderGap = (gap: ContextGapDescriptor, hunkIndex: number) => {
    const expanded = gap.expansion.aboveRows.length > 0 || gap.expansion.belowRows.length > 0
    const showControl = gap.hiddenLines > 3 || Boolean(gap.expansion.error)
    return <>
      {renderRows(gap.baseAboveRows, hunkIndex, 'context')}
      {renderRows(gap.expansion.aboveRows, hunkIndex, 'context')}
      {showControl ? <ContextGapControl gap={gap} onExpand={direction => expandGap(gap, direction)} /> : null}
      {!showControl && gap.hiddenLines > 0 ? <div className="review-diff-hunk interactive loading" role="status"><span>{gap.header}</span><span>Loading {gap.hiddenLines} common {gap.hiddenLines === 1 ? 'line' : 'lines'}…</span></div> : null}
      {!showControl && gap.hiddenLines === 0 && !expanded && gap.location !== 'bottom' ? <div className={`review-diff-hunk ${hunkIndex > 0 ? 'secondary' : ''}`}><span>{gap.header}</span></div> : null}
      {renderRows(gap.expansion.belowRows, hunkIndex, 'context')}
      {renderRows(gap.baseBelowRows, hunkIndex, 'context')}
    </>
  }

  return (
    <>
      {file.diff.hunks.map((hunk, index) => (
        <Fragment key={`${hunk.header}:${index}`}>
          {renderGap(gapsBefore[index]!, index)}
          <div tabIndex={-1} data-review-hunk={index}>{renderRows(splitOuterContext(hunk.rows).body, index, 'change')}</div>
        </Fragment>
      ))}
      {bottomGap ? renderGap(bottomGap, file.diff.hunks.length) : null}
      {missingNewline.left || missingNewline.right ? (
        <div className="review-newline-warning" role="note">
          {[
            missingNewline.left ? 'No newline at end of left file.' : '',
            missingNewline.right ? 'No newline at end of right file.' : '',
          ].filter(Boolean).join(' — ')}
        </div>
      ) : null}
    </>
  )
}

function DiffStatusMessage({ row, onRetry }: { row: ReviewFileRowModel; onRetry: () => void }) {
  if (row.diffLoadError) {
    return <div className="review-diff-message error" role="alert">Could not load diff: {row.diffLoadError} <button type="button" className="code-rich-content-retry" onClick={onRetry}>RETRY</button></div>
  }
  if (row.diffLoadPending) {
    return <div className="review-diff-message" role="status">Loading diff…</div>
  }
  if (row.diffStatus === 'binary') {
    return <div className="review-diff-message">Binary file changed</div>
  }
  if (row.diffStatus === 'too-expensive') {
    return <div className="review-diff-message">Diff too large to render</div>
  }
  if (row.diffStatus === 'not-loaded') {
    return <div className="review-diff-message">Diff not loaded yet</div>
  }
  return null
}

function CommentEditor({
  disabled,
  draft,
  target,
  onCancel,
  onDraftChange,
  onSave,
}: {
  disabled: boolean
  draft: string
  target: CommentTarget
  onCancel: () => void
  onDraftChange: (value: string) => void
  onSave: () => void
}) {
  const targetName = target.side === 'right' ? 'Patchset' : target.side === 'left' ? 'Base' : 'file'
  const targetLabel = target.range
    ? target.range.start_line === target.range.end_line
      ? `${targetName} line ${target.range.start_line}, columns ${target.range.start_character + 1}–${target.range.end_character}`
      : `${targetName} lines ${target.range.start_line}–${target.range.end_line}`
    : `${targetName} line ${target.line}`
  return (
    <form className="review-comment-editor" onSubmit={event => { event.preventDefault(); onSave() }}>
      <header>Comment on {targetLabel}</header>
      <textarea
        aria-label="Review comment"
        name="farming-review-comment"
        inputMode="text"
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="none"
        spellCheck={false}
        enterKeyHint="done"
        data-lpignore="true"
        data-1p-ignore="true"
        data-bwignore="true"
        data-form-type="other"
        autoFocus
        maxLength={20000}
        disabled={disabled}
        placeholder="Leave a review comment…"
        value={draft}
        onChange={event => onDraftChange(event.target.value)}
      />
      <footer>
        <button type="button" disabled={disabled} onClick={onCancel}>DISCARD</button>
        <button type="submit" disabled={disabled || !draft.trim()}>{disabled ? 'SAVING…' : 'SAVE COMMENT'}</button>
      </footer>
    </form>
  )
}

function CommentThread({
  comment,
  disabled,
  onDelete,
  onStatusChange,
}: {
  comment: ReviewComment
  disabled: boolean
  onDelete: () => void
  onStatusChange: (status: 'open' | 'resolved') => void
}) {
  const targetName = comment.side === 'right' ? 'Patchset' : comment.side === 'left' ? 'Base' : 'File'
  const status = comment.status || 'open'
  const targetLabel = comment.range
    ? comment.range.start_line === comment.range.end_line
      ? `${targetName} line ${comment.range.start_line}, columns ${comment.range.start_character + 1}–${comment.range.end_character}`
      : `${targetName} lines ${comment.range.start_line}–${comment.range.end_line}`
    : `${targetName} line ${comment.line}`
  return (
    <article tabIndex={-1} className={`review-comment-thread ${status}${comment.outdated ? ' outdated' : ''}`}>
      <header>
        <span>{comment.outdated ? `Outdated · ${targetLabel}` : targetLabel}</span>
        <span className="review-comment-actions">
          <button type="button" disabled={disabled} onClick={() => onStatusChange(status === 'resolved' ? 'open' : 'resolved')}>{status === 'resolved' ? 'REOPEN' : 'RESOLVE'}</button>
          <button type="button" aria-label={`Delete comment on line ${comment.line}`} disabled={disabled} onClick={onDelete}><CloseGlyph /></button>
        </span>
      </header>
      <p>{comment.body}</p>
    </article>
  )
}

function codeCellForSelectionNode(node: Node | null, container: HTMLElement) {
  const element = node instanceof Element ? node : node?.parentElement
  const cell = element?.closest<HTMLElement>('code[data-review-line][data-review-side]') ?? null
  return cell && container.contains(cell) ? cell : null
}

function characterOffsetInCell(cell: HTMLElement, node: Node, offset: number) {
  const range = document.createRange()
  range.selectNodeContents(cell)
  try {
    range.setEnd(node, offset)
  } catch {
    return 0
  }
  return range.toString().length
}

function selectedDiffText(container: HTMLElement, mode: DiffMode) {
  const selection = window.getSelection()
  if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return null
  const range = selection.getRangeAt(0)
  const start = codeCellForSelectionNode(range.startContainer, container)
  const end = codeCellForSelectionNode(range.endContainer, container)
  if (!start || !end || (mode === 'split' && start.dataset.reviewSide !== end.dataset.reviewSide)) return null
  const cells = Array.from(container.querySelectorAll<HTMLElement>('code[data-review-line]'))
    .filter(cell => range.intersectsNode(cell) && (mode === 'unified' || cell.dataset.reviewSide === start.dataset.reviewSide))
  return cells.map(cell => {
    const text = cell.dataset.reviewText ?? ''
    const from = cell === start ? characterOffsetInCell(cell, range.startContainer, range.startOffset) : 0
    const to = cell === end ? characterOffsetInCell(cell, range.endContainer, range.endOffset) : text.length
    return text.slice(from, to)
  }).join('\n')
}

function commentRangeFromSelection(container: HTMLElement): { line: number; range: ReviewCommentRange; side: CommentSide } | null {
  const selection = window.getSelection()
  if (!selection || selection.isCollapsed || !selection.anchorNode || !selection.focusNode) return null
  const anchorCell = codeCellForSelectionNode(selection.anchorNode, container)
  const focusCell = codeCellForSelectionNode(selection.focusNode, container)
  if (!anchorCell || !focusCell) return null
  const anchorSide = anchorCell.dataset.reviewSide
  const focusSide = focusCell.dataset.reviewSide
  if (anchorSide !== focusSide || (anchorSide !== 'left' && anchorSide !== 'right' && anchorSide !== 'unified')) return null
  const anchorLine = Number(anchorCell.dataset.reviewLine)
  const focusLine = Number(focusCell.dataset.reviewLine)
  if (!Number.isInteger(anchorLine) || !Number.isInteger(focusLine)) return null
  const anchor = { character: characterOffsetInCell(anchorCell, selection.anchorNode, selection.anchorOffset), line: anchorLine }
  const focus = { character: characterOffsetInCell(focusCell, selection.focusNode, selection.focusOffset), line: focusLine }
  const anchorFirst = anchor.line < focus.line || (anchor.line === focus.line && anchor.character <= focus.character)
  const start = anchorFirst ? anchor : focus
  const end = anchorFirst ? focus : anchor
  if (start.line === end.line && start.character === end.character) return null
  return {
    line: end.line,
    range: {
      end_character: end.character,
      end_line: end.line,
      start_character: start.character,
      start_line: start.line,
    },
    side: anchorSide,
  }
}

function textPosition(cell: HTMLElement, offset: number): [Node, number] {
  const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT)
  let node = walker.nextNode()
  while (node) {
    const length = node.textContent?.length ?? 0
    if (offset <= length) return [node, offset]
    offset -= length
    node = walker.nextNode()
  }
  return [cell, cell.childNodes.length]
}

function reviewDraftKey(reviewId: string, patchset: string) {
  return `farming:review-draft:${reviewId}:${patchset}`
}

export function ReviewPage() {
  const [compact, setCompact] = useState(isCompactViewport)
  useEffect(() => {
    const query = window.matchMedia(COMPACT_VIEWPORT_QUERY)
    const sync = () => setCompact(query.matches)
    sync()
    query.addEventListener('change', sync)
    return () => query.removeEventListener('change', sync)
  }, [])
  const fixtureMode = typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('fixture') === '1'
  const [acpCaptureTarget] = useState(() => {
    const search = typeof window === 'undefined' ? '' : window.location.search
    return {
      requested: new URLSearchParams(search).has('acpItem'),
      route: acpReviewCaptureRequestFromSearch(search),
    }
  })
  const acpCaptureRoute = acpCaptureTarget.route
  const [reviewRouteTarget] = useState(() => reviewSnapshotRequestFromLocation(typeof window === 'undefined' ? null : window.location))
  const captureRouteRequest = !fixtureMode && !acpCaptureTarget.requested && reviewRouteTarget.request
    && (reviewRouteTarget.request.source === 'working-copy' || reviewRouteTarget.request.head === 'now')
    ? reviewRouteTarget.request
    : null
  const [reviewRequestBase, setReviewRequestBase] = useState<ReviewDiffSnapshotRequest | null>(() => (
    captureRouteRequest || acpCaptureTarget.requested ? null : reviewRouteTarget.request
  ))
  const [reviewSessionRevision, setReviewSessionRevision] = useState<ReviewSessionRevision | null>(null)
  const [sessionRevisions, setSessionRevisions] = useState<ReviewSessionRevision[]>([])
  const [snapshotPending, setSnapshotPending] = useState(false)
  const [snapshotRetry, setSnapshotRetry] = useState(0)
  const [stateRetry, setStateRetry] = useState(0)
  const [reviewView, setReviewView] = useState<'final' | 'fixes'>('final')
  const [capturePending, setCapturePending] = useState(Boolean(captureRouteRequest || acpCaptureRoute))
  const routeTargetError = acpCaptureTarget.requested
    ? !acpCaptureRoute
    : Boolean(reviewRouteTarget.error)
  const externalReview = !fixtureMode
  const workingCopy = reviewRequestBase?.source === 'working-copy'
  const gitRange = reviewRequestBase?.source === 'git-range'
  const [catalog, setCatalog] = useState<ReviewCatalog>(() => routeTargetError ? { [INVALID_REVIEW_PATCHSET]: [] } : initialReviewCatalog(reviewRequestBase, fixtureMode))
  const [reviewLoadError, setReviewLoadError] = useState(
    acpCaptureTarget.requested
      ? acpCaptureRoute ? '' : 'ACP review target is invalid'
      : (reviewRouteTarget.error ?? ''),
  )
  const [reviewComparison, setReviewComparison] = useState<ReviewComparison | null>(null)
  const [reviewState, setReviewState] = useState<ReviewState>(() => {
    const initialCatalog = routeTargetError ? { [INVALID_REVIEW_PATCHSET]: [] } : initialReviewCatalog(reviewRequestBase, fixtureMode)
    return createPageReviewState({
      basePatchset: routeTargetError ? 'Base' : initialReviewBasePatchset(reviewRequestBase, fixtureMode),
      catalog: initialCatalog,
      comments: [],
      initialPatchset: routeTargetError ? INVALID_REVIEW_PATCHSET : initialReviewPatchset(reviewRequestBase, fixtureMode),
      initiallyExpand: !externalReview,
      reviewId: externalReview ? undefined : REVIEW_FIXTURE_ID,
    })
  })
  const [enqueueDiff] = useState(() => createReviewDiffQueue())
  const mountedRef = useRef(true)
  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false } }, [])
  const uncertainCommentRef = useRef<string | null>(null)
  const reviewStateRef = useRef(reviewState)
  const catalogRef = useRef(catalog)
  const reviewRequestIdentityRef = useRef(reviewRequestIdentityKey(reviewRequestBase))
  catalogRef.current = catalog
  const replaceReviewRequest = (request: ReviewDiffSnapshotRequest | null) => {
    const nextIdentity = reviewRequestIdentityKey(request)
    if (nextIdentity !== reviewRequestIdentityRef.current) {
      reviewRequestIdentityRef.current = nextIdentity
      const nextCatalog = initialReviewCatalog(request, fixtureMode)
      const nextState = createPageReviewState({
        basePatchset: initialReviewBasePatchset(request, fixtureMode),
        catalog: nextCatalog,
        comments: [],
        initialPatchset: initialReviewPatchset(request, fixtureMode),
        initiallyExpand: !externalReview,
        reviewId: undefined,
      })
      nextState.diffMode = reviewStateRef.current.diffMode
      nextState.preferences = reviewStateRef.current.preferences
      reviewStateRef.current = nextState
      catalogRef.current = nextCatalog
      setReviewState(nextState)
      setCatalog(nextCatalog)
      setReviewComparison(null)
      setReviewLoadError('')
      setReviewStatusError('')
      setReviewCommentError('')
      setCommentsLoadState('loading')
      uncertainCommentRef.current = null
      setContextLoadPaths([])
      setContextGapExpansions({})
      setReviewingPath('')
      setSelectedPath('')
      if (scrollTailRef.current) scrollTailRef.current.style.height = '0px'
      reviewScrollerRef.current = null
      collapseAnchorRef.current = null
    }
    setReviewRequestBase(request)
  }
  const [draftPreferences, setDraftPreferences] = useState<DiffPreferences>(DEFAULT_DIFF_PREFERENCES)
  const replaceReviewRequestRef = useRef(replaceReviewRequest)
  replaceReviewRequestRef.current = replaceReviewRequest
  const [showPreferences, setShowPreferences] = useState(false)
  const preferencesTriggerRef = useRef<HTMLButtonElement | null>(null)
  const preferencesCancelRef = useRef<HTMLButtonElement | null>(null)
  const preferencesDialogRef = useModalFocusScope<HTMLElement>({
    dismissOnPointerOutside: true,
    open: showPreferences,
    initialFocusRef: preferencesCancelRef,
    returnFocusRef: preferencesTriggerRef,
    onEscape: () => setShowPreferences(false),
  })
  const [commitCopied, setCommitCopied] = useState(false)
  const [reviewStatusError, setReviewStatusError] = useState('')
  const [reviewCommentError, setReviewCommentError] = useState('')
  const [commentsLoadState, setCommentsLoadState] = useState<'loading' | 'loaded' | 'error'>('loading')
  const [reviewingPath, setReviewingPath] = useState('')
  const [selectedPath, setSelectedPath] = useState('')
  const collapseAnchorRef = useRef<{ header: HTMLElement; top: number; scroller: HTMLElement } | null>(null)
  const scrollTailRef = useRef<HTMLDivElement>(null)
  const reviewScrollerRef = useRef<HTMLElement | null>(null)
  const [contextLoadPaths, setContextLoadPaths] = useState<string[]>([])
  const [contextGapExpansions, setContextGapExpansions] = useState<Record<string, ContextGapExpansion>>({})
  const [selectedCommentTarget, setSelectedCommentTarget] = useState<CommentTarget | null>(null)
  const selectionActionRef = useRef<HTMLButtonElement>(null)
  const [comparisonSources, setComparisonSources] = useState<ReviewComparisonSources | null>(null)
  const [comparisonSourceError, setComparisonSourceError] = useState('')
  const [comparisonSourcesPending, setComparisonSourcesPending] = useState(false)
  const [comparisonSourceId, setComparisonSourceId] = useState(() => new URLSearchParams(window.location.search).get('comparison') || '')
  // Capture freezes a comparison; it does not turn workspace edits into an Agent turn.
  // Legacy last-turn links have no evidence of an Agent origin, so use Changes.
  const [capturedSourceId, setCapturedSourceId] = useState(() => {
    if (acpCaptureRoute) return 'agent-changes'
    const source = new URLSearchParams(window.location.search).get('comparison')
    if (source && source !== 'last-turn') return source
    const request = reviewRouteTarget.request
    if (request?.source === 'working-copy' && request.scope === 'untracked') return 'untracked'
    if (request?.source === 'working-copy' && request.scope === 'tracked') return 'changes'
    return request?.source === 'working-copy' ? 'working-copy' : 'changes'
  })
  const initialCapturedSourceId = useRef(capturedSourceId).current
  const [showComparisonSources, setShowComparisonSources] = useState(false)
  const comparisonSourceRef = useRef<HTMLDivElement>(null)
  const reviewId = externalReview ? reviewState.reviewId ?? '' : REVIEW_FIXTURE_ID
  const patchset = reviewState.patchRange.patchset
  const basePatch = reviewState.patchRange.basePatchset
  const patchsetState = reviewStateForPatchset(reviewState, patchset)
  const expandedPaths = new Set(patchsetState.expandedPaths)
  const diffMode = reviewState.diffMode
  const reviewSessionActive = Boolean(
    reviewSessionRevision
    && reviewRequestBase?.source === 'git-range'
    && reviewRequestBase.reviewId === reviewSessionRevision.reviewId
    && reviewRequestBase.head === reviewSessionRevision.head
  )
  const reviewScope = reviewSessionActive ? reviewSessionRevision?.scope : (reviewRequestBase?.source === 'working-copy' ? reviewRequestBase.scope : undefined)
  const effectiveDiffMode: DiffMode = compact || reviewScope === 'untracked' ? 'unified' : diffMode
  useEffect(() => setSelectedCommentTarget(null), [reviewId, patchset, effectiveDiffMode, compact])
  const diffPreferences = reviewState.preferences
  const fitDiffToScreen = compact || diffPreferences.fitToScreen
  const reviewDiffRequest: ReviewDiffSnapshotRequest | null = reviewRequestBase
    ? { ...reviewRequestBase, context: diffPreferences.context, ignoreWhitespace: diffPreferences.ignoreWhitespace }
    : null
  const diffGenerationRef = useRef(0)
  const reviewDiffRequestRef = useRef(reviewDiffRequest)
  reviewDiffRequestRef.current = reviewDiffRequest
  const displayedComparison: ReviewComparison | null = reviewSessionActive
    ? {
        ...(reviewComparison ?? { workingTree: true }),
        head: undefined,
        workingTree: true,
      }
    : reviewComparison
  const commentTarget = reviewState.commentDraft
  const commentDraft = reviewState.commentDraft?.body ?? ''
  const files = catalog[patchset] ?? []
  useEffect(() => setSelectedPath(''), [patchset])
  useEffect(() => {
    setSelectedPath(current => catalog[patchset]?.some(file => file.path === current) ? current : '')
  }, [catalog, patchset])
  const totalAdded = files.reduce((total, file) => total + file.added, 0)
  const totalRemoved = files.reduce((total, file) => total + file.removed, 0)
  const maxChangeSize = Math.max(1, ...files.map(file => file.added + file.removed))
  const applyReviewAction = (action: Parameters<typeof transitionReviewState>[1]) => {
    const transition = transitionReviewState(reviewStateRef.current, action, catalogRef.current)
    if (transition.state === reviewStateRef.current) return
    reviewStateRef.current = transition.state
    setReviewState(transition.state)
    if (transition.state.reviewId && ['start-comment', 'update-comment-draft', 'cancel-comment', 'save-comment', 'commit-comment', 'restore-comments'].includes(action.type)) {
      try {
        const key = reviewDraftKey(transition.state.reviewId, transition.state.patchRange.patchset)
        if (transition.state.commentDraft) window.localStorage.setItem(key, JSON.stringify(transition.state.commentDraft))
        else window.localStorage.removeItem(key)
      } catch { setReviewCommentError('Draft is kept in this page, but browser storage is unavailable. Save before closing.') }
    }
    for (const effect of transition.effects) {
      const effectRequestIdentity = reviewRequestIdentityRef.current
      if (effect.type === 'load-file-diff') {
        const generation = diffGenerationRef.current
        const request = reviewDiffRequestRef.current
        if (!request) {
          applyReviewAction(failReviewFileDiffLoad(effect, 'review file diff source is unavailable'))
          continue
        }
        enqueueDiff(() => loadReviewFileDiff(request, effect.path)
          .then(file => {
            if (reviewRequestIdentityRef.current !== effectRequestIdentity || diffGenerationRef.current !== generation) return
            const completed = completeReviewFileDiffLoad(catalogRef.current, effect, file, { reviewId: reviewStateRef.current.reviewId })
            catalogRef.current = completed.catalog
            setCatalog(completed.catalog)
            applyReviewAction(completed.action)
          })
          .catch(error => {
            if (reviewRequestIdentityRef.current !== effectRequestIdentity || diffGenerationRef.current !== generation) return
            applyReviewAction(failReviewFileDiffLoad(effect, error))
          }), () => mountedRef.current && reviewRequestIdentityRef.current === effectRequestIdentity && diffGenerationRef.current === generation)
      }
      if (effect.type === 'save-reviewed-status') {
        const effectReviewId = effect.reviewId ?? reviewId
        void saveReviewedFilesStatus({ ...effect, reviewId: effectReviewId })
          .then(saved => {
            if (reviewRequestIdentityRef.current !== effectRequestIdentity) return
            applyReviewAction({
              patchset: effect.patchset,
              paths: effect.changes.map(change => change.path),
              reviewedPaths: saved.reviewedPaths,
              ...(effect.reviewId ? { reviewId: effect.reviewId } : {}),
              revision: saved.revision,
              type: 'commit-reviewed-status',
            })
          })
          .catch(async error => {
            if (reviewRequestIdentityRef.current !== effectRequestIdentity) return
            const restored = error instanceof ReviewApiError && error.state
              ? error.state
              : await loadReviewedPatchsetState(effectReviewId, effect.patchset).catch(() => null)
            if (reviewRequestIdentityRef.current !== effectRequestIdentity) return
            if (!restored) {
              applyReviewAction({ patchset: effect.patchset, reviewId: effect.reviewId, type: 'invalidate-reviewed-status' })
              setReviewStatusError('Reviewed save outcome is unknown. Reload review state before continuing.')
              return
            }
            applyReviewAction({
              patchset: effect.patchset,
              reviewedPaths: restored.reviewedPaths,
              ...(effect.reviewId ? { reviewId: effect.reviewId } : {}),
              revision: restored.revision,
              type: 'restore-reviewed-status',
            })
            setReviewStatusError(error instanceof Error ? `Could not save Reviewed: ${error.message}` : 'Could not save Reviewed status')
          })
      }
      if (effect.type === 'save-comment') {
        const effectReviewId = effect.reviewId ?? reviewId
        void saveReviewComment(effectReviewId, effect.comment)
          .then(() => {
            if (reviewRequestIdentityRef.current !== effectRequestIdentity) return
            applyReviewAction({
              id: effect.comment.id,
              patchset: effect.comment.patchset,
              pendingType: 'save',
              ...(effect.reviewId ? { reviewId: effect.reviewId } : {}),
              type: 'commit-comment',
            })
          })
          .catch(async error => {
            if (reviewRequestIdentityRef.current !== effectRequestIdentity) return
            const comments = await loadReviewComments(effectReviewId, effect.comment.patchset).catch(() => null)
            if (!comments) {
              if (reviewRequestIdentityRef.current === effectRequestIdentity) {
                uncertainCommentRef.current = effect.comment.id
                setReviewCommentError('Comment save outcome is unknown. Reload review state to reconcile; your draft is retained.')
              }
              return
            }
            if (reviewRequestIdentityRef.current !== effectRequestIdentity) return
            applyReviewAction({
              comments,
              id: effect.comment.id,
              patchset: effect.comment.patchset,
              pendingType: 'save',
              ...(effect.reviewId ? { reviewId: effect.reviewId } : {}),
              type: 'restore-comments',
            })
            setReviewCommentError(error instanceof Error ? `Could not save comment: ${error.message}` : 'Could not save comment')
          })
      }
      if (effect.type === 'delete-comment') {
        const effectReviewId = effect.reviewId ?? reviewId
        void deleteReviewComment(effectReviewId, effect.comment.patchset, effect.comment.id)
          .then(() => {
            if (reviewRequestIdentityRef.current !== effectRequestIdentity) return
            applyReviewAction({
              id: effect.comment.id,
              patchset: effect.comment.patchset,
              pendingType: 'delete',
              ...(effect.reviewId ? { reviewId: effect.reviewId } : {}),
              type: 'commit-comment',
            })
          })
          .catch(async error => {
            if (reviewRequestIdentityRef.current !== effectRequestIdentity) return
            const comments = await loadReviewComments(effectReviewId, effect.comment.patchset)
              .catch(() => [...reviewStateRef.current.comments, effect.comment])
            if (reviewRequestIdentityRef.current !== effectRequestIdentity) return
            applyReviewAction({
              comments,
              id: effect.comment.id,
              patchset: effect.comment.patchset,
              pendingType: 'delete',
              ...(effect.reviewId ? { reviewId: effect.reviewId } : {}),
              type: 'restore-comments',
            })
            setReviewCommentError(error instanceof Error ? `Could not delete comment: ${error.message}` : 'Could not delete comment')
          })
      }
    }
  }

  // applyReviewAction is a fresh closure every render; the hydration effect below
  // reads it through a ref so it does not refetch on every render.
  const applyReviewActionRef = useRef(applyReviewAction)
  applyReviewActionRef.current = applyReviewAction

  useEffect(() => {
    document.body.classList.add('review-body')
    return () => document.body.classList.remove('review-body')
  }, [])

  useInteractionLayer({
    enabled: showComparisonSources,
    elements: () => [comparisonSourceRef.current],
    onDismiss: () => setShowComparisonSources(false),
    returnFocus: () => comparisonSourceRef.current?.querySelector('button'),
  })

  useInteractionLayer({
    enabled: Boolean(selectedCommentTarget),
    elements: () => [selectionActionRef.current],
    onDismiss: () => setSelectedCommentTarget(null),
  })

  useEffect(() => {
    if (!captureRouteRequest && !acpCaptureRoute) return
    let active = true
    setCapturePending(true)
    const capture = acpCaptureRoute
      ? createAcpReviewSession(acpCaptureRoute.agentId, acpCaptureRoute.itemIds)
      : (() => {
          const request = captureRouteRequest!
          const target = 'root' in request && typeof request.root === 'string'
            ? { root: request.root }
            : { agentId: request.agentId }
          const base = request.source === 'git-range' ? request.base : 'HEAD'
          const captureOptions = request.source === 'working-copy'
            ? {
                modifiedWithinDays: request.modifiedWithinDays,
                paths: request.paths,
                scope: request.scope,
              }
            : undefined
          return createReviewSession(target, base, captureOptions)
        })()
    void capture
      .then(revision => {
        if (!active) return
        const request = reviewRequestForSessionRevision(revision, 'final')
        const params = new URLSearchParams(window.location.search)
        params.delete('agentId')
        params.delete('acpItem')
        params.set('root', revision.root)
        params.set('base', request.base)
        params.set('head', request.head)
        params.set('reviewId', revision.reviewId)
        params.set('comparison', initialCapturedSourceId)
        window.history.replaceState(null, '', `${window.location.pathname}?${params.toString()}`)
        setSessionRevisions([revision])
        setReviewSessionRevision(revision)
        setReviewView('final')
        setComparisonSourceId(initialCapturedSourceId)
        replaceReviewRequestRef.current(request)
        setReviewLoadError('')
      })
      .catch(error => {
        if (!active) return
        setReviewLoadError(error instanceof Error ? error.message : 'review capture failed')
      })
      .finally(() => { if (active) setCapturePending(false) })
    return () => { active = false }
  }, [acpCaptureRoute, captureRouteRequest, initialCapturedSourceId])

  useEffect(() => {
    if (reviewRequestBase?.source !== 'git-range' || !reviewRequestBase.reviewId) return
    let active = true
    void loadReviewSession(reviewRequestBase.reviewId)
      .then(session => {
        if (!active) return
        setSessionRevisions(session.revisions)
        const revision = session.revisions.find(item => item.head === reviewRequestBase.head) ?? session
        setReviewSessionRevision(revision)
        setComparisonSourceId(current => current || capturedSourceId)
        setReviewView(reviewRequestBase.base === revision.fixesBase && revision.fixesBase !== revision.base ? 'fixes' : 'final')
      })
      .catch(() => {
        // The diff endpoint still reports a precise session/range error if this lookup fails.
      })
    return () => { active = false }
  }, [acpCaptureRoute, captureRouteRequest, capturedSourceId, reviewRequestBase])

  useEffect(() => {
    if (!reviewRequestBase) return
    let active = true
    const requestIdentity = reviewRequestIdentityKey(reviewRequestBase)
    const preferences = readStoredDiffPreferences()
    setSnapshotPending(true)
    void loadReviewDiffSnapshot({ ...reviewRequestBase, context: preferences.context, ignoreWhitespace: preferences.ignoreWhitespace, metadataOnly: true })
      .then(review => {
        if (review.truncated) throw new Error('Review file list exceeds its limit. Narrow the comparison before reviewing.')
        const loadedComments: ReviewComment[] = []
        if (!active || reviewRequestIdentityRef.current !== requestIdentity) return
        if (reviewRequestBase.source === 'git-range' && !review.basePatchset) throw new Error('Review base is unavailable')
        if (reviewRequestBase.source === 'git-range' && review.basePatchset
          && (reviewRequestBase.base !== review.basePatchset || reviewRequestBase.head !== review.patchset
            || !('root' in reviewRequestBase) || reviewRequestBase.root !== review.root)) {
          // Admit no catalog or review state under symbolic refs. Every later
          // file/context request and reopening uses these exact endpoints.
          const request: ReviewDiffSnapshotRequest = {
            source: 'git-range', root: review.root, base: review.basePatchset, head: review.patchset,
            ...(reviewRequestBase.reviewId ? { reviewId: reviewRequestBase.reviewId } : {}),
            metadataOnly: true,
          }
          const params = new URLSearchParams(window.location.search)
          params.delete('agentId')
          params.set('root', review.root)
          params.set('base', review.basePatchset)
          params.set('head', review.patchset)
          window.history.replaceState(null, '', `${window.location.pathname}?${params}`)
          replaceReviewRequestRef.current(request)
          return
        }
        const nextCatalog = reviewCatalogWithUnmodifiedPaths(
          reviewCatalogFromSnapshot(review),
          review.patchset,
          loadedComments.map(comment => comment.path),
        )
        const nextState = createReviewStateFromSnapshot({
          comments: loadedComments,
          preferences,
          snapshot: review,
        })
        reviewStateRef.current = nextState
        catalogRef.current = nextCatalog
        setReviewComparison(review.comparison ?? null)
        setCatalog(nextCatalog)
        setReviewState(nextState)
        // Retrying the same range also replaces local state. Rehydrate even
        // when its review and patchset identities have not changed.
        setStateRetry(value => value + 1)
        setReviewLoadError('')
      })
      .catch(error => {
        if (!active || reviewRequestIdentityRef.current !== requestIdentity) return
        setReviewLoadError(error instanceof Error ? error.message : 'review diff request failed')
      })
      .finally(() => { if (active) setSnapshotPending(false) })
    return () => { active = false }
  }, [reviewRequestBase, snapshotRetry])

  useEffect(() => {
    try {
      window.localStorage.setItem(DIFF_PREFERENCES_STORAGE_KEY, JSON.stringify(diffPreferences))
    } catch {
      // Keep the in-memory diff settings usable when browser storage is unavailable.
    }
  }, [diffPreferences])

  useEffect(() => {
    if (!reviewId || !catalogRef.current[patchset]) return
    let active = true
    const requestIdentity = reviewRequestIdentityRef.current
    void loadReviewedPatchsetState(reviewId, patchset)
      .then(saved => {
        if (!active || reviewRequestIdentityRef.current !== requestIdentity) return
        setReviewStatusError('')
        applyReviewActionRef.current({
          patchset,
          reviewedPaths: saved.reviewedPaths,
          reviewId,
          revision: saved.revision,
          type: 'hydrate-reviewed-status',
        })
      })
      .catch(error => { if (active) setReviewStatusError(`Could not load Reviewed: ${error instanceof Error ? error.message : 'request failed'}`) })
    setCommentsLoadState('loading')
    const uncertainCommentAtRead = uncertainCommentRef.current
    void loadReviewComments(reviewId, patchset)
      .then(loadedComments => {
        if (!active || reviewRequestIdentityRef.current !== requestIdentity) return
        setReviewCommentError('')
        setCommentsLoadState('loaded')
        const nextCatalog = reviewCatalogWithUnmodifiedPaths(catalogRef.current, patchset, loadedComments.map(comment => comment.path))
        if (nextCatalog !== catalogRef.current) {
          catalogRef.current = nextCatalog
          setCatalog(nextCatalog)
        }
        const pending = reviewStateForPatchset(reviewStateRef.current, patchset).pendingComment
        if (pending && pending.id === uncertainCommentAtRead) {
          applyReviewActionRef.current({ comments: loadedComments, patchset, reviewId, id: pending.id, pendingType: pending.type, type: 'restore-comments' })
          uncertainCommentRef.current = null
        }
        else applyReviewActionRef.current({ comments: loadedComments, patchset, reviewId, type: 'hydrate-comments' })
        if (!reviewStateRef.current.commentDraft) {
          try {
            const raw: unknown = JSON.parse(window.localStorage.getItem(reviewDraftKey(reviewId, patchset)) || 'null')
            if (raw && typeof raw === 'object') {
              const draft = raw as ReviewCommentDraft
              if (loadedComments.some(comment => comment.id === draft.id)) {
                window.localStorage.removeItem(reviewDraftKey(reviewId, patchset))
              } else if (draft.patchset === patchset && typeof draft.body === 'string' && typeof draft.path === 'string') {
                applyReviewActionRef.current({ ...draft, type: 'start-comment' })
                if (reviewStateRef.current.commentDraft) {
                  // The persisted id makes a retry use the same server-side identity.
                  applyReviewActionRef.current({ body: draft.body, type: 'update-comment-draft' })
                  const file = catalogRef.current[patchset]?.find(file => file.path === draft.path || file.previousPath === draft.path)
                  if (file && !reviewStateForPatchset(reviewStateRef.current, patchset).expandedPaths.includes(file.path)) applyReviewActionRef.current({ path: file.path, type: 'toggle-file-expanded' })
                }
              }
            }
          } catch { setReviewCommentError('Could not restore the locally saved comment draft.') }
        }
      })
      .catch(error => { if (active) { setCommentsLoadState('error'); setReviewCommentError(`Could not load comments: ${error instanceof Error ? error.message : 'request failed'}`) } })
    return () => { active = false }
  }, [patchset, reviewId, stateRetry])

  useEffect(() => {
    if (!CSS.highlights || typeof Highlight === 'undefined') return
    const ranges: Range[] = []
    for (const row of document.querySelectorAll<HTMLElement>('.review-file-change[data-file-path]')) {
      const file = catalog[patchset]?.find(file => file.path === row.dataset.filePath)
      if (!file) continue
      for (const comment of reviewState.comments) {
        if (!comment.range || comment.outdated || comment.patchset !== patchset
          || comment.path !== reviewCommentPathForSide(file, comment.side)
          || (reviewSessionActive && reviewView === 'fixes' && comment.side === 'left')) continue
        for (const cell of row.querySelectorAll<HTMLElement>('code[data-review-line]')) {
          const line = Number(cell.dataset.reviewLine)
          if (cell.dataset.reviewSide !== comment.side || line < comment.range.start_line || line > comment.range.end_line) continue
          const range = document.createRange()
          range.setStart(...textPosition(cell, line === comment.range.start_line ? comment.range.start_character : 0))
          range.setEnd(...textPosition(cell, line === comment.range.end_line ? comment.range.end_character : cell.textContent?.length ?? 0))
          ranges.push(range)
        }
      }
    }
    CSS.highlights.set('review-comment-range', new Highlight(...ranges))
    return () => { CSS.highlights.delete('review-comment-range') }
  }, [catalog, patchset, reviewState.comments, patchsetState.expandedPaths, diffPreferences, effectiveDiffMode, contextGapExpansions, reviewSessionActive, reviewView])

  const expandedPathsSignature = patchsetState.expandedPaths.join('\0')
  useLayoutEffect(() => {
    const anchor = collapseAnchorRef.current
    collapseAnchorRef.current = null
    const tail = scrollTailRef.current
    const scroller = anchor?.scroller ?? reviewScrollerRef.current
    if (!tail || !scroller) return
    if (anchor && !anchor.header.isConnected) return
    // Measure after collapse, before paint. This also handles a formerly sticky
    // header returning to its ordinary position far above the viewport.
    const scrollTop = scroller.scrollTop + (anchor ? anchor.header.getBoundingClientRect().top - anchor.top : 0)
    const contentHeight = tail.getBoundingClientRect().top + scroller.scrollTop
    tail.style.height = `${Math.max(0, scrollTop + scroller.clientHeight - contentHeight)}px`
    scroller.scrollTop = scrollTop
  }, [expandedPathsSignature, catalog])
  useEffect(() => {
    const updateReviewingPath = () => {
      let nextPath = ''
      for (const article of document.querySelectorAll<HTMLElement>('.review-file-change.expanded[data-file-path]')) {
        const header = article.querySelector<HTMLElement>('.review-file-change-header')
        if (!header) continue
        const articleRect = article.getBoundingClientRect()
        const headerRect = header.getBoundingClientRect()
        if (headerRect.top <= 1 && articleRect.bottom > headerRect.bottom) {
          nextPath = article.dataset.filePath ?? ''
        }
      }
      setReviewingPath(current => current === nextPath ? current : nextPath)
    }
    updateReviewingPath()
    window.addEventListener('scroll', updateReviewingPath, { passive: true })
    document.body.addEventListener('scroll', updateReviewingPath, { passive: true })
    window.addEventListener('resize', updateReviewingPath)
    return () => {
      window.removeEventListener('scroll', updateReviewingPath)
      document.body.removeEventListener('scroll', updateReviewingPath)
      window.removeEventListener('resize', updateReviewingPath)
    }
  }, [expandedPathsSignature, patchset])

  const reviewMutationPending = Boolean(patchsetState.pendingReview)
  const commentMutationPending = Boolean(patchsetState.pendingComment)
  const toggleReviewed = (path: string, reviewed: boolean) => {
    applyReviewAction({
      path,
      reviewed,
      type: 'set-file-reviewed',
    })
  }

  const selectPatchset = (nextPatchset: string) => {
    if (nextPatchset === patchset || guardDraft()) return
    if (scrollTailRef.current) scrollTailRef.current.style.height = '0px'
    reviewScrollerRef.current = null
    collapseAnchorRef.current = null
    applyReviewAction({ patchset: nextPatchset, type: 'select-patchset' })
  }

  const allVisibleExpanded = files.length > 0 && files.every(file => expandedPaths.has(file.path))
  const toggleExpanded = (path: string, control: HTMLElement) => {
    if (reviewStateForPatchset(reviewStateRef.current, patchset).expandedPaths.includes(path)) {
      const header = control.closest<HTMLElement>('.review-file-change-header')
      if (header) {
        const scroller = document.scrollingElement
        if (scroller instanceof HTMLElement) {
          reviewScrollerRef.current = scroller
          collapseAnchorRef.current = { header, scroller, top: header.getBoundingClientRect().top }
        }
      }
    }
    setSelectedPath(path)
    applyReviewAction({ path, type: 'toggle-file-expanded' })
  }

  const openPreferences = () => {
    setDraftPreferences(diffPreferences)
    setShowPreferences(true)
  }
  const savePreferences = () => {
    const previous = diffPreferences
    const next = normalizeReviewPreferences(draftPreferences)
    const diffShapeChanged = previous.context !== next.context
      || previous.ignoreWhitespace !== next.ignoreWhitespace
    applyReviewAction({ preferences: next, type: 'set-preferences' })
    setShowPreferences(false)
    if (diffShapeChanged) setContextGapExpansions({})
    if (
      !externalReview || !reviewRequestBase
      || !diffShapeChanged
    ) return
    // Invalidate every cached shape, including collapsed files. The same loader
    // owns reloads, failures and retries; superseded results cannot reenter it.
    diffGenerationRef.current += 1
    reviewDiffRequestRef.current = { ...reviewRequestBase, context: next.context, ignoreWhitespace: next.ignoreWhitespace }
    setContextLoadPaths([])
    const nextCatalog = { ...catalogRef.current, [patchset]: files.map(file =>
      file.kind === 'unmodified' || file.binary || file.diffTooExpensive ? file
        : { ...file, diffLoaded: false, diff: { ...file.diff, hunks: [] } }) }
    catalogRef.current = nextCatalog
    setCatalog(nextCatalog)
    applyReviewAction({ type: 'invalidate-file-diffs' })
  }

  const copyCommit = () => {
    if (navigator.clipboard) {
      void navigator.clipboard.writeText('34a15ae').catch(() => {})
    }
    setCommitCopied(true)
    window.setTimeout(() => setCommitCopied(false), 1200)
  }
  const expandRemoteContext = (path: string, context: number) => {
    const request = reviewDiffRequestRef.current
    if (!request || contextLoadPaths.includes(path)) return
    const requestIdentity = reviewRequestIdentityRef.current
    const generation = diffGenerationRef.current
    const targetPatchset = patchset
    setContextLoadPaths(current => [...current, path])
    void loadReviewFileDiff({ ...request, context }, path)
      .then(file => {
        if (reviewRequestIdentityRef.current !== requestIdentity || diffGenerationRef.current !== generation) return
        const nextCatalog = reviewCatalogWithFile(catalogRef.current, targetPatchset, file)
        catalogRef.current = nextCatalog
        setCatalog(nextCatalog)
      })
      .catch(error => {
        if (reviewRequestIdentityRef.current !== requestIdentity || diffGenerationRef.current !== generation) return
        setReviewLoadError(error instanceof Error ? error.message : 'review context request failed')
      })
      .finally(() => {
        if (reviewRequestIdentityRef.current !== requestIdentity || diffGenerationRef.current !== generation) return
        setContextLoadPaths(current => current.filter(item => item !== path))
      })
  }
  const expandFileContext = (file: ReviewFile, gap: ContextGapDescriptor, direction: ContextGapDirection, range: ReviewContextRange) => {
    const request = reviewDiffRequestRef.current
    if (gap.expansion.pending || range.lines < 1) return
    const requestIdentity = reviewRequestIdentityRef.current
    const generation = diffGenerationRef.current
    const commitRows = (rows: ReviewDiffRow[]) => {
      if (reviewRequestIdentityRef.current !== requestIdentity || diffGenerationRef.current !== generation) return
      setContextGapExpansions(current => {
        const previous = current[gap.key] ?? emptyContextGapExpansion()
        return {
          ...current,
          [gap.key]: direction === 'below'
            ? { ...previous, belowRows: [...rows, ...previous.belowRows], error: undefined, pending: undefined }
            : { ...previous, aboveRows: [...previous.aboveRows, ...rows], error: undefined, pending: undefined },
        }
      })
    }
    const failRows = (error: unknown) => {
      if (reviewRequestIdentityRef.current !== requestIdentity || diffGenerationRef.current !== generation) return
      const message = error instanceof Error ? error.message : 'review context request failed'
      setContextGapExpansions(current => {
        const previous = current[gap.key] ?? emptyContextGapExpansion()
        return { ...current, [gap.key]: { ...previous, error: message, pending: undefined } }
      })
    }
    setContextGapExpansions(current => {
      const previous = current[gap.key] ?? emptyContextGapExpansion()
      return {
        ...current,
        [gap.key]: { ...previous, error: undefined, pending: direction },
      }
    })
    if (!request) {
      const rows = gap.availableRows.filter(row => {
        const oldLine = row.left?.line
        const newLine = row.right?.line
        return oldLine !== undefined && newLine !== undefined
          && oldLine >= range.oldStart && oldLine < range.oldStart + range.lines
          && newLine >= range.newStart && newLine < range.newStart + range.lines
      })
      if (rows.length === range.lines) commitRows(rows)
      else failRows(new Error('review context is unavailable'))
      return
    }
    void loadReviewFileContext(request, file.path, range)
      .then(result => commitRows(result.rows))
      .catch(failRows)
  }
  const startComment = (path: string, line: number, side: CommentSide, range?: ReviewCommentRange) => {
    if (guardDraft()) return
    if (reviewSessionActive && reviewView === 'fixes' && side === 'left') {
      setReviewCommentError('Switch to Final change to comment on the original base. In this view, comment on the current revision on the right.')
      return
    }
    setSelectedCommentTarget(null)
    setReviewCommentError('')
    applyReviewAction({ line, path, range, side, type: 'start-comment' })
  }
  const guardDraft = () => {
    if (!reviewStateRef.current.commentDraft?.body.trim() && !reviewStateForPatchset(reviewStateRef.current, reviewStateRef.current.patchRange.patchset).pendingComment) return false
    setReviewCommentError('Save or discard the current comment before changing its location or comparison.')
    document.querySelector<HTMLTextAreaElement>('.review-comment-editor textarea')?.focus()
    return true
  }
  const saveComment = () => {
    if (!commentTarget || !commentDraft.trim()) return
    applyReviewAction({
      id: commentTarget.id ?? (typeof crypto?.randomUUID === 'function'
        ? crypto.randomUUID()
        : `comment-${Date.now()}-${Math.random().toString(36).slice(2)}`),
      type: 'save-comment',
    })
  }
  const changeCommentStatus = (comment: ReviewComment, status: 'open' | 'resolved') => {
    if (!reviewId) return
    const requestIdentity = reviewRequestIdentityRef.current
    void updateReviewCommentStatus(reviewId, comment.patchset, comment.id, status)
      .then(() => loadReviewComments(reviewId, comment.patchset))
      .then(comments => {
        if (reviewRequestIdentityRef.current !== requestIdentity) return
        applyReviewAction({ comments, patchset: comment.patchset, reviewId, type: 'hydrate-comments' })
      })
      .catch(error => {
        if (reviewRequestIdentityRef.current !== requestIdentity) return
        setReviewCommentError(error instanceof Error ? error.message : 'review comment status failed')
      })
  }
  const setSessionRequest = (revision: ReviewSessionRevision, view: 'final' | 'fixes', sourceId = capturedSourceId) => {
    if (guardDraft()) return
    const request = reviewRequestForSessionRevision(revision, view)
    const params = new URLSearchParams(window.location.search)
    for (const key of ['agentId', 'acpItem', 'scope', 'path', 'modifiedWithinDays']) params.delete(key)
    params.set('root', revision.root)
    params.set('base', request.base)
    params.set('head', request.head)
    params.set('reviewId', revision.reviewId)
    params.set('comparison', sourceId)
    window.history.replaceState(null, '', `${window.location.pathname}?${params.toString()}`)
    setSessionRevisions(current => [...current.filter(item => item.reviewId === revision.reviewId && item.head !== revision.head), revision].sort((a, b) => a.number - b.number))
    setReviewSessionRevision(revision)
    setReviewView(view)
    setCapturedSourceId(sourceId)
    setComparisonSourceId(sourceId)
    setShowComparisonSources(false)
    replaceReviewRequest(request)
  }
  const reviewWorkspaceTarget = (() => {
    if (reviewRequestBase && 'root' in reviewRequestBase && reviewRequestBase.root) return { root: reviewRequestBase.root }
    if (reviewRequestBase && 'agentId' in reviewRequestBase && reviewRequestBase.agentId) return { agentId: reviewRequestBase.agentId }
    if (reviewSessionRevision) return { root: reviewSessionRevision.root }
    if (comparisonSources) return { root: comparisonSources.root }
    return null
  })()
  const openComparisonSources = () => {
    const nextOpen = !showComparisonSources
    setShowComparisonSources(nextOpen)
    if (!nextOpen || comparisonSourcesPending || !reviewWorkspaceTarget) return
    setComparisonSources(null)
    setComparisonSourcesPending(true)
    setComparisonSourceError('')
    void loadReviewComparisonSources(reviewWorkspaceTarget)
      .then(setComparisonSources)
      .catch(error => setComparisonSourceError(error instanceof Error ? error.message : 'Comparison sources could not be loaded'))
      .finally(() => setComparisonSourcesPending(false))
  }
  const selectComparisonSource = (source: ReviewComparisonSource, root = comparisonSources?.root) => {
    if (!root || source.available === false || !source.base || !source.head || capturePending || guardDraft()) return
    if (source.head === 'now') {
      setCapturePending(true)
      setReviewLoadError('')
      setShowComparisonSources(false)
      void createReviewSession({ root }, source.base)
        .then(revision => { setSessionRevisions([revision]); setSessionRequest(revision, 'final', source.id) })
        .catch(error => setReviewLoadError(error instanceof Error ? error.message : 'review capture failed'))
        .finally(() => setCapturePending(false))
      return
    }
    const request: ReviewDiffSnapshotRequest = {
      base: source.base,
      head: source.head,
      metadataOnly: true,
      root,
      source: 'git-range',
    }
    const params = new URLSearchParams(window.location.search)
    params.delete('agentId')
    params.delete('reviewId')
    params.delete('path')
    params.delete('scope')
    params.delete('modifiedWithinDays')
    params.set('root', root)
    params.set('base', source.base)
    params.set('head', source.head)
    params.set('comparison', source.id)
    window.history.replaceState(null, '', `${window.location.pathname}?${params.toString()}`)
    setComparisonSourceId(source.id)
    setShowComparisonSources(false)
    setReviewView('final')
    replaceReviewRequest(request)
  }
  const endpointRequest = reviewRequestBase?.source === 'git-range' && reviewRequestBase.root
    ? { ...reviewRequestBase, root: reviewRequestBase.root }
    : null
  const endpointLabel = (side: 'base' | 'head') => {
    const revision = endpointRequest?.[side] ?? ''
    if (side === 'head' && reviewSessionActive && reviewSessionRevision) {
      const source = capturedSourceId === 'agent-changes' ? 'Agent changes' : 'working tree'
      return `Captured ${source} · Revision ${reviewSessionRevision.number} · ${revision.slice(0, 12)}`
    }
    const commit = reviewComparison?.[side]
    if (commit?.id === revision) return `${revision.slice(0, 12)} · ${commit.message.split('\n')[0]}`
    if ((side === 'head' && comparisonSourceId === 'staged') || (side === 'base' && comparisonSourceId === 'unstaged')) {
      return `Index snapshot · ${revision.slice(0, 12)}`
    }
    return `Revision · ${revision.slice(0, 12)}`
  }
  const selectEndpoint = (side: 'base' | 'head', revision: string) => {
    if (!endpointRequest || revision === endpointRequest[side]) return
    selectComparisonSource({
      base: side === 'base' ? revision : endpointRequest.base,
      head: side === 'head' ? revision : endpointRequest.head,
      id: 'custom-range',
      label: 'Custom comparison',
    }, endpointRequest.root)
  }
  const refreshCapturedReview = () => {
    if (!reviewSessionRevision || capturePending || guardDraft()) return
    setCapturePending(true)
    void refreshReviewSession(reviewSessionRevision.reviewId)
      .then(revision => {
        setSessionRequest(revision, revision.number > 1 ? 'fixes' : 'final')
        setReviewLoadError('')
      })
      .catch(error => setReviewLoadError(error instanceof Error ? error.message : 'review refresh failed'))
      .finally(() => setCapturePending(false))
  }
  const selectReviewView = (view: 'final' | 'fixes') => {
    if (!reviewSessionRevision || view === reviewView) return
    setSessionRequest(reviewSessionRevision, view)
  }
  const navigationPath = selectedPath || reviewingPath || files[0]?.path || ''
  const previousFile = reviewAdjacentFilePath(files, navigationPath, 'previous')
  const nextFile = reviewAdjacentFilePath(files, navigationPath, 'next')
  const nextUnreviewedFile = patchsetState.reviewedLoaded && reviewAdjacentUnreviewedFilePath(reviewState, files, navigationPath)
  const navigateFile = (direction: 'next' | 'previous', unreviewed = false) => {
    const current = selectedPath || reviewingPath || document.activeElement?.closest<HTMLElement>('[data-file-path]')?.dataset.filePath || files[0]?.path
    if (!current) return
    const path = unreviewed
      ? reviewAdjacentUnreviewedFilePath(reviewStateRef.current, files, current, direction)
      : reviewAdjacentFilePath(files, current, direction)
    if (!path) return
    if (!expandedPaths.has(path)) applyReviewAction({ path, type: 'toggle-file-expanded' })
    const row = Array.from(document.querySelectorAll<HTMLElement>('.review-file-change')).find(row => row.dataset.filePath === path)
    row?.scrollIntoView({ block: 'start' })
    row?.querySelector<HTMLButtonElement>('.review-file-expand')?.focus({ preventScroll: true })
    setSelectedPath(path)
  }
  const navigateContent = (kind: 'hunk' | 'comment', direction: 'next' | 'previous') => {
    const elements = Array.from(document.querySelectorAll<HTMLElement>(kind === 'hunk' ? '[data-review-hunk]' : '.review-comment-thread'))
    const target = direction === 'next' ? elements.find(element => element.getBoundingClientRect().top > 60)
      : elements.reverse().find(element => element.getBoundingClientRect().top < 0)
    target?.scrollIntoView({ block: 'start' })
    target?.focus({ preventScroll: true })
  }
  const workingCopyScope = reviewScope
  const filesLabel = workingCopyScope === 'tracked' ? 'Changes' : workingCopyScope === 'untracked' ? 'Untracked' : 'Files'
  const selectedComparisonSource = comparisonSources
    ? [comparisonSources.unstaged, comparisonSources.staged, ...comparisonSources.commits, ...comparisonSources.branches]
      .find(source => source.id === comparisonSourceId)
    : null
  const comparisonSourceLabel = reviewSessionActive
    ? comparisonLabel(capturedSourceId)
    : selectedComparisonSource?.id.startsWith('commit:')
      ? `Commit · ${selectedComparisonSource.label}`
      : selectedComparisonSource?.id.startsWith('branch:')
        ? `Branch · ${selectedComparisonSource.label}`
        : selectedComparisonSource?.label
          ?? (comparisonSourceId ? comparisonLabel(comparisonSourceId) : workingCopy ? 'Working copy' : gitRange ? 'Changes' : filesLabel)
  const comparisonMessageTitle = comparisonSourceId === 'staged'
    ? 'Staged changes'
    : displayedComparison?.workingTree
      ? 'Workspace changes'
      : displayedComparison?.head?.message.split('\n')[0] || 'Commit details'
  const comparisonMessageLabel = displayedComparison?.head
    ? 'Commit message'
    : comparisonSourceId === 'staged'
      ? 'Index summary'
      : 'Change summary'
  const comparisonMessageFallback = comparisonSourceId === 'staged'
    ? 'Staged changes are stored in the Git index and do not have a commit author or commit message yet.'
    : 'Uncommitted workspace changes do not have a commit author or commit message yet.'
  const emptyReviewMessage = snapshotPending ? 'Loading review…' : capturePending
    ? 'Capturing an immutable workspace revision…'
    : !reviewRequestBase
      ? 'Open a real review with: farming review <git-dir> <base> <head|now>'
      : workingCopy
        ? workingCopyScope === 'tracked'
          ? 'No tracked changes in this workspace.'
          : workingCopyScope === 'untracked'
            ? `No untracked files modified in the last ${reviewRequestBase.modifiedWithinDays ?? 3} days.`
            : 'No uncommitted files in this workspace.'
        : 'No changed files in this range.'
  const reviewLoadLabel = routeTargetError ? 'Could not load review target' : gitRange ? 'Could not load git range' : 'Could not load working copy'

  return (
    <main className="review-root" data-testid="review-page" onKeyDown={event => {
      if (event.ctrlKey || event.metaKey || event.altKey || event.nativeEvent.isComposing
        || (event.target instanceof HTMLElement && event.target.closest('input, textarea, select, [contenteditable="true"], [role="dialog"], [role="menu"], [role="listbox"]'))) return
      if (event.key === ']') { event.preventDefault(); navigateFile('next') }
      if (event.key === '[') { event.preventDefault(); navigateFile('previous') }
      if (event.key.toLowerCase() === 'n' || event.key.toLowerCase() === 'p') { event.preventDefault(); navigateContent(event.shiftKey ? 'comment' : 'hunk', event.key.toLowerCase() === 'n' ? 'next' : 'previous') }
    }}>
      <section className="review-files" aria-label="Changed files">
        <header className="review-files-toolbar">
          <div className="review-patch-info">
            <div className="review-source-control" ref={comparisonSourceRef}>
              <button type="button" className="review-source-trigger" aria-expanded={showComparisonSources} disabled={capturePending} onClick={openComparisonSources}>
                <strong>{comparisonSourceLabel}</strong><ChevronDownGlyph />
              </button>
              {showComparisonSources ? <div className="code-menu-surface code-menu-list review-source-menu" role="menu" aria-label="Compare changes from">
                {comparisonSourcesPending ? <p>Loading comparisons…</p> : null}
                {comparisonSourceError ? <p className="error">{comparisonSourceError}</p> : null}
                {comparisonSources ? <>
                  {comparisonSources.staged.unavailableReason ? <p role="status">{comparisonSources.staged.unavailableReason}</p> : null}
                  <button type="button" role="menuitemradio" aria-checked={!reviewSessionActive && comparisonSourceId === 'unstaged'} disabled={!comparisonSources.unstaged.available} onClick={() => selectComparisonSource(comparisonSources.unstaged)}>
                    <span>Unstaged</span>{!reviewSessionActive && comparisonSourceId === 'unstaged' ? <CheckGlyph /> : null}
                  </button>
                  <button type="button" role="menuitemradio" aria-checked={comparisonSourceId === 'staged'} disabled={!comparisonSources.staged.available} onClick={() => selectComparisonSource(comparisonSources.staged)}>
                    <span>Staged</span>{comparisonSourceId === 'staged' ? <CheckGlyph /> : null}
                  </button>
                  <details className="review-source-submenu">
                    <summary>Commit <ChevronRightGlyph /></summary>
                    <div tabIndex={0} aria-label="Commit comparisons">{comparisonSources.commits.length ? comparisonSources.commits.map(source => (
                      <button type="button" role="menuitemradio" title={source.label} aria-checked={comparisonSourceId === source.id} key={source.id} onClick={() => selectComparisonSource(source)}>
                        <span>{source.label}</span>{comparisonSourceId === source.id ? <CheckGlyph /> : null}
                      </button>
                    )) : <p>No commits available</p>}</div>
                  </details>
                  <details className="review-source-submenu">
                    <summary>Branch <ChevronRightGlyph /></summary>
                    <div tabIndex={0} aria-label="Branch comparisons">{comparisonSources.branches.length ? comparisonSources.branches.map(source => (
                      <button type="button" role="menuitemradio" title={source.label} aria-checked={comparisonSourceId === source.id} key={source.id} onClick={() => selectComparisonSource(source)}>
                        <span>{source.label}</span>{comparisonSourceId === source.id ? <CheckGlyph /> : null}
                      </button>
                    )) : <p>No other branches</p>}</div>
                  </details>
                  {reviewSessionRevision ? <button type="button" role="menuitemradio" aria-checked={reviewSessionActive} onClick={() => setSessionRequest(reviewSessionRevision, reviewView)}>
                    <span>Captured · {comparisonLabel(capturedSourceId)}</span>{reviewSessionActive ? <CheckGlyph /> : null}
                  </button> : null}
                </> : null}
              </div> : null}
            </div>
            <span className="review-total-stats"><b>+{totalAdded}</b><i>−{totalRemoved}</i></span>
            {!externalReview ? <>
              <CodeSelect
                density="toolbar"
                ariaLabel="Patch set"
                className="review-patch-select"
                value={patchset}
                options={[
                  { value: 'Patchset 20', label: 'Patchset 20' },
                  { value: 'Patchset 19', label: 'Patchset 19' },
                ]}
                onChange={selectPatchset}
              />
              <button type="button" className="review-commit" onClick={copyCommit} title="Copy commit">
                {commitCopied ? 'Copied' : '34a15ae'}<CopyGlyph />
              </button>
            </> : null}
            {reviewSessionActive && reviewSessionRevision ? <CodeSelect density="toolbar" disabled={capturePending} ariaLabel="Revision" value={reviewSessionRevision.head}
              options={(sessionRevisions.length ? sessionRevisions : [reviewSessionRevision]).map(revision => ({ value: revision.head, label: `Revision ${revision.number}` }))}
              onChange={head => { const revision = sessionRevisions.find(item => item.head === head); if (revision) setSessionRequest(revision, 'final') }} /> : null}
          </div>
          <div className="review-files-actions">
            {reviewSessionActive && reviewSessionRevision ? <>
              {reviewSessionRevision.number > 1 ? <CodeSelect density="toolbar" disabled={capturePending} ariaLabel="Comparison view" value={reviewView}
                options={[{ value: 'final', label: 'Final change' }, { value: 'fixes', label: 'Fixes since review' }]}
                onChange={value => selectReviewView(value as 'final' | 'fixes')} /> : null}
              <button type="button" disabled={capturePending} onClick={refreshCapturedReview}>{capturePending ? 'CAPTURING…' : 'REFRESH'}</button>
              <span className="review-toolbar-separator" />
            </> : null}
            <button type="button" onClick={() => applyReviewAction({
              expanded: !allVisibleExpanded,
              paths: files.map(file => file.path),
              type: 'set-all-files-expanded',
            })}>{allVisibleExpanded ? 'COLLAPSE ALL' : 'EXPAND ALL'}</button>
            <span className="review-toolbar-separator" />
            {reviewScope !== 'untracked' && !compact ? <>
              <span>Diff view:</span>
              <button type="button" className={`review-icon-action ${diffMode === 'split' ? 'active' : ''}`} aria-pressed={diffMode === 'split'} aria-label="Side-by-side diff" title="Side-by-side diff" onClick={() => applyReviewAction({ mode: 'split', type: 'set-diff-mode' })}><DiffSplitGlyph /></button>
              <button type="button" className={`review-icon-action ${diffMode === 'unified' ? 'active' : ''}`} aria-pressed={diffMode === 'unified'} aria-label="Unified diff" title="Unified diff" onClick={() => applyReviewAction({ mode: 'unified', type: 'set-diff-mode' })}><DiffUnifiedGlyph /></button>
            </> : null}
            <button ref={preferencesTriggerRef} type="button" className="review-icon-action" aria-label="Diff preferences" title="Diff preferences" onClick={openPreferences}><SettingsGlyph /></button>
          </div>
        </header>
        {reviewStatusError || reviewCommentError ? <div className="review-review-error code-content-toolbar" role="status"><span>{reviewStatusError || reviewCommentError}</span><button type="button" className="code-content-toolbar-text" onClick={() => setStateRetry(value => value + 1)}>RELOAD REVIEW STATE</button></div> : null}
        {externalReview && endpointRequest ? <div className="review-comparison-endpoints" aria-label="Comparison versions">
          <ReviewEndpointPicker disabled={capturePending} label={endpointLabel('base')} revision={endpointRequest.base} root={endpointRequest.root} side="base" onSelect={revision => selectEndpoint('base', revision)} />
          <span aria-hidden="true">→</span>
          <ReviewEndpointPicker disabled={capturePending} label={endpointLabel('head')} revision={endpointRequest.head} root={endpointRequest.root} side="head" onSelect={revision => selectEndpoint('head', revision)} />
        </div> : null}
        {externalReview && displayedComparison ? (
          <details className="review-commit-message">
            <summary>
              <span>{comparisonMessageLabel}</span>
              <strong>{comparisonMessageTitle}</strong>
              <ChevronRightGlyph />
            </summary>
            <div>
              {displayedComparison.head ? (
                <>
                  <p><span>Author</span><strong>{displayedComparison.head.authorName}</strong>{displayedComparison.head.authorEmail ? ` <${displayedComparison.head.authorEmail}>` : ''}</p>
                  {displayedComparison.head.authoredAt ? <p><span>Date</span>{new Date(displayedComparison.head.authoredAt).toLocaleString()}</p> : null}
                  <pre>{displayedComparison.head.message}</pre>
                </>
              ) : (
                <>
                  <p><span>Based on</span><strong>{displayedComparison.base?.message.split('\n')[0] || basePatch}</strong></p>
                  {displayedComparison.base ? <p><span>Base author</span>{displayedComparison.base.authorName}{displayedComparison.base.authorEmail ? ` <${displayedComparison.base.authorEmail}>` : ''}</p> : null}
                  <pre>{comparisonMessageFallback}</pre>
                </>
              )}
            </div>
          </details>
        ) : null}
        <div className="review-navigation code-content-toolbar" aria-label="Review navigation">
          <span>{patchsetState.reviewedLoaded ? `${patchsetState.reviewedPaths.length}/${files.length} reviewed` : 'Reviewed status unavailable'} · {commentsLoadState === 'loaded' ? `${reviewState.comments.filter(comment => !comment.status || comment.status === 'open').length} unresolved` : commentsLoadState === 'loading' ? 'Comments loading…' : 'Comments unavailable'}</span>
          <button type="button" className="code-content-toolbar-text" disabled={!previousFile} onClick={() => navigateFile('previous')} title="Previous file ([)">PREVIOUS FILE</button>
          <button type="button" className="code-content-toolbar-text" disabled={!nextFile} onClick={() => navigateFile('next')} title="Next file (])">NEXT FILE</button>
          <button type="button" className="code-content-toolbar-text" disabled={!nextUnreviewedFile} onClick={() => navigateFile('next', true)}>NEXT UNREVIEWED</button>
          <button type="button" className="code-content-toolbar-text" onClick={() => navigateContent('hunk', 'next')} title="Next change (n), previous (p)">NEXT CHANGE</button>
          <button type="button" className="code-content-toolbar-text" disabled={!reviewState.comments.length} onClick={() => navigateContent('comment', 'next')}>NEXT COMMENT</button>
          <CodeSelect className="review-navigation-select" density="toolbar" ariaLabel="Review navigation" value=""
            options={[
              { value: '', label: 'Navigate…', disabled: true },
              { value: 'previous', label: 'Previous file', disabled: !previousFile },
              { value: 'next', label: 'Next file', disabled: !nextFile },
              { value: 'unreviewed', label: 'Next unreviewed', disabled: !nextUnreviewedFile },
              { value: 'hunk', label: 'Next change' },
              { value: 'comment', label: 'Next comment', disabled: !reviewState.comments.length },
            ]}
            onChange={value => { if (value === 'previous' || value === 'next') navigateFile(value); else if (value === 'unreviewed') navigateFile('next', true); else if (value === 'hunk' || value === 'comment') navigateContent(value, 'next') }} />
        </div>
        <div className="review-files-list">
          {reviewLoadError ? <p className="review-working-copy-message" role="alert">{reviewLoadLabel}: {reviewLoadError} {reviewRequestBase ? <button type="button" className="code-rich-content-retry" onClick={() => { if (!guardDraft()) setSnapshotRetry(value => value + 1) }}>RETRY</button> : null}</p> : null}
          {externalReview && !reviewLoadError && files.length === 0 ? <p className="review-working-copy-message" role="status">{emptyReviewMessage}</p> : null}
          {files.map(file => {
            const rowModel = reviewFileRowModel(reviewState, file, { mutationPending: reviewMutationPending })
            const fileComments = commentsForFilePaths(reviewState, rowModel.commentPaths)
            const outdatedComments = fileComments.filter(comment => comment.outdated || (reviewSessionActive && reviewView === 'fixes' && comment.side === 'left'))
            const commentPathForSide = (side: CommentSide) => reviewCommentPathForSide(file, side)
            const renderLineAttachment = (line: number, sides: CommentSide[]) => {
              const selectedTarget = selectedCommentTarget
                && selectedCommentTarget.path === commentPathForSide(selectedCommentTarget.side)
                && selectedCommentTarget.line === line
                && sides.includes(selectedCommentTarget.side)
                ? selectedCommentTarget : null
              const activeTarget = commentTarget
                && commentTarget.path === commentPathForSide(commentTarget.side)
                && commentTarget.line === line
                && sides.includes(commentTarget.side)
                ? commentTarget
                : null
              const lineComments = fileComments.filter(comment => {
                return !(reviewSessionActive && reviewView === 'fixes' && comment.side === 'left') && !(commentMutationPending && patchsetState.pendingComment?.type === 'save' && patchsetState.pendingComment.id === comment.id) && !comment.outdated
                  && comment.line === line
                  && sides.includes(comment.side)
                  && comment.path === commentPathForSide(comment.side)
              })
              if (!activeTarget && !selectedTarget && lineComments.length === 0) return null
              return (
                <div className={!activeTarget && lineComments.length === 0 ? 'review-selection-attachment' : 'review-line-attachment'} data-review-comment-line={line}>
                  {selectedTarget ? <span className="code-content-toolbar review-selection-toolbar" data-review-side={selectedTarget.side}><button ref={selectionActionRef} type="button" className="code-content-toolbar-text review-selection-comment" onClick={() => startComment(selectedTarget.path, selectedTarget.line, selectedTarget.side, selectedTarget.range)}>Comment on selection</button></span> : null}
                  {activeTarget ? (
                    <CommentEditor
                      disabled={commentMutationPending}
                      draft={commentDraft}
                      target={activeTarget}
                      onCancel={() => applyReviewAction({ type: 'cancel-comment' })}
                      onDraftChange={body => applyReviewAction({ body, type: 'update-comment-draft' })}
                      onSave={saveComment}
                    />
                  ) : null}
                  {lineComments.map(comment => (
                    <CommentThread
                      comment={comment}
                      disabled={commentMutationPending}
                      key={comment.id}
                      onDelete={() => applyReviewAction({ id: comment.id, type: 'delete-comment' })}
                      onStatusChange={status => changeCommentStatus(comment, status)}
                    />
                  ))}
                </div>
              )
            }
            return (
              <article className={`review-file-change ${rowModel.expanded ? 'expanded' : ''} ${reviewingPath === file.path ? 'reviewing' : ''} ${selectedPath === file.path ? 'selected' : ''}`} key={file.path} data-testid="review-file-row" data-change-kind={file.kind} data-file-path={file.path}>
                <header className="review-file-change-header" onFocusCapture={() => setSelectedPath(file.path)}>
                  <button
                    type="button"
                    className="review-file-select"
                    aria-current={selectedPath === file.path ? 'true' : undefined}
                    onCopy={event => {
                      const selection = window.getSelection()
                      if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return
                      const range = selection.getRangeAt(0)
                      const ancestor = range.commonAncestorContainer
                      const element = ancestor instanceof Element ? ancestor : ancestor.parentElement
                      const path = element?.closest('.review-file-name, .review-file-previous-path')
                      if (!path || !event.currentTarget.contains(path)) return
                      // Flex layout inserts a visual line break between directory and basename.
                      // Copy the selected text nodes, not those layout separators.
                      event.clipboardData.setData('text/plain', range.toString())
                      event.preventDefault()
                    }}
                    onClick={event => {
                      const selection = window.getSelection()
                      if (selection && !selection.isCollapsed) return
                      toggleExpanded(file.path, event.currentTarget)
                    }}
                  >
                    <span className="review-file-status">{rowModel.changeLabel}</span>
                    <span className="review-file-paths">
                      <ReviewPath path={file.path} />
                      {file.previousPath ? <ReviewPath path={file.previousPath} previous /> : null}
                    {file.oldMode && file.newMode && file.oldMode !== file.newMode ? <span className="review-file-metadata" title="File mode changed">{file.oldMode} → {file.newMode}</span> : null}
                  {fileComments.length ? <span className="review-file-metadata" title={`${fileComments.length} comments`}>{fileComments.filter(comment => !comment.status || comment.status === 'open').length} unresolved · {fileComments.length} comments</span> : null}
                    </span>
                    <ChangeBar file={file} maxChangeSize={maxChangeSize} />
                    <FileStats file={file} />
                  </button>
                  <ReviewStatus action={rowModel.action} pending={rowModel.pending} reviewed={rowModel.reviewed} reviewedLabel={rowModel.reviewedLabel} onToggle={() => {
                    if (!rowModel.action) return
                    toggleReviewed(file.path, rowModel.action.nextReviewed)
                  }} />
                  <button type="button" className="review-file-expand" aria-label={rowModel.expanded ? 'Collapse file diff' : 'Expand file diff'} onClick={event => toggleExpanded(file.path, event.currentTarget)}>{rowModel.expanded ? <ChevronDownGlyph /> : <ChevronRightGlyph />}</button>
                </header>
                {rowModel.expanded ? (
                  <section className={`review-inline-diff ${effectiveDiffMode} ${fitDiffToScreen ? 'fit-to-screen' : ''}`} aria-label={`Diff for ${file.path}`}>
                    {outdatedComments.length ? <div className="review-outdated-comments">
                      {reviewView === 'fixes' && outdatedComments.some(comment => comment.side === 'left') ? <p>Comments on the original base (see Final change)</p> : null}
                      {outdatedComments.map(comment => <CommentThread
                        comment={comment}
                        disabled={commentMutationPending}
                        key={comment.id}
                        onDelete={() => applyReviewAction({ id: comment.id, type: 'delete-comment' })}
                        onStatusChange={status => changeCommentStatus(comment, status)}
                      />)}
                    </div> : null}
                    {file.submoduleError ? <div className="review-diff-status" role="alert">{file.submoduleError}</div> : null}
                    <div className="review-diff-columns"><span>{effectiveDiffMode === 'split' ? reviewSessionActive && reviewView === 'fixes' ? 'Previous revision' : 'Base' : 'Change'}</span>{effectiveDiffMode === 'split' ? <span>{reviewSessionActive ? `Revision ${reviewSessionRevision?.number}` : 'Candidate'}</span> : null}</div>
                    {rowModel.diffStatus !== 'loaded' || rowModel.diffLoadPending || rowModel.diffLoadError ? (
                      <DiffStatusMessage row={rowModel} onRetry={() => applyReviewAction({ path: file.path, type: 'retry-file-diff' })} />
                    ) : (
                      <>
                        <div
                          className="review-diff-code"
                          tabIndex={0}
                          style={{ fontSize: `${diffPreferences.fontSize}px`, tabSize: diffPreferences.tabSize, minWidth: fitDiffToScreen ? undefined : `${Math.round(diffPreferences.lineLength * diffPreferences.fontSize * 0.62)}px` }}
                          onMouseDown={event => {
                            const cell = codeCellForSelectionNode(event.target as Node, event.currentTarget)
                            if (cell) event.currentTarget.dataset.selectionSide = cell.dataset.reviewSide
                          }}
                          onCopy={event => {
                            if (event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLInputElement) return
                            const text = selectedDiffText(event.currentTarget, effectiveDiffMode)
                            if (text === null) return
                            event.clipboardData.setData('text/plain', text)
                            event.preventDefault()
                          }}
                          onKeyDown={event => {
                            if (event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLInputElement) return
                            if (event.key !== 'c' || event.metaKey || event.ctrlKey || event.altKey) return
                            const selected = commentRangeFromSelection(event.currentTarget)
                            if (!selected) return
                            event.preventDefault()
                            startComment(commentPathForSide(selected.side), selected.line, selected.side, selected.range)
                          }}
                          onClick={event => {
                            if (!(event.target instanceof Element)) return
                            const codeCell = event.target.closest<HTMLElement>('.review-line-number')
                            if (!codeCell) return
                            const line = Number(codeCell.dataset.reviewLine)
                            const side = codeCell.dataset.reviewSide
                            if (!Number.isFinite(line) || (side !== 'left' && side !== 'right' && side !== 'unified')) return
                            startComment(commentPathForSide(side), line, side)
                          }}
                          onMouseUp={event => {
                            const selected = commentRangeFromSelection(event.currentTarget)
                            if (!selected) return
                            setSelectedCommentTarget({ ...selected, path: commentPathForSide(selected.side) })
                          }}
                        >
                          <DiffRows contextKeyPrefix={`${reviewId}:${patchset}`} contextGapExpansions={contextGapExpansions} file={file} mode={effectiveDiffMode} preferences={diffPreferences} renderAttachment={renderLineAttachment} onExpandContext={(gap, direction, range) => expandFileContext(file, gap, direction, range)} onExpandSkippedContext={(_gapKey, _hunkIndex, context) => expandRemoteContext(file.path, context)} />
                        </div>
                      </>
                    )}
                  </section>
                ) : null}
              </article>
            )
          })}
        </div>
        <div ref={scrollTailRef} className="review-scroll-tail" aria-hidden="true" />
      </section>
      {showPreferences ? createPortal(
        <div className="review-preferences-backdrop" role="presentation">
          <section ref={preferencesDialogRef} className="review-preferences" role="dialog" aria-modal="true" aria-labelledby="review-preferences-title">
            <header><h2 id="review-preferences-title">Diff Preferences</h2></header>
            <div className="review-preferences-form">
              <CodeSelect
                className="review-preferences-select"
                label="Context"
                value={String(draftPreferences.context)}
                options={[
                  { value: '3', label: '3 lines' },
                  { value: '10', label: '10 lines' },
                  { value: '25', label: '25 lines' },
                  { value: '100', label: '100 lines' },
                ]}
                onChange={value => setDraftPreferences(current => ({ ...current, context: Number(value) }))}
              />
              <label className="checkbox-row">Fit to screen<input aria-label="Fit to screen" type="checkbox" checked={compact || draftPreferences.fitToScreen} disabled={compact} onChange={event => setDraftPreferences(current => ({ ...current, fitToScreen: event.target.checked }))} /></label>
              <label>Diff width<input className="code-field" aria-label="Diff width" type="number" autoComplete="off" data-form-type="other" disabled={compact} min={40} max={240} value={draftPreferences.lineLength} onChange={event => setDraftPreferences(current => ({ ...current, lineLength: Number(event.target.value) || current.lineLength }))} /></label>
              <label>Tab width<input className="code-field" aria-label="Tab width" type="number" autoComplete="off" data-form-type="other" min={2} max={16} value={draftPreferences.tabSize} onChange={event => setDraftPreferences(current => ({ ...current, tabSize: Number(event.target.value) || current.tabSize }))} /></label>
              <label>Font size<input className="code-field" aria-label="Font size" type="number" autoComplete="off" data-form-type="other" min={10} max={20} value={draftPreferences.fontSize} onChange={event => setDraftPreferences(current => ({ ...current, fontSize: Number(event.target.value) || current.fontSize }))} /></label>
              <label className="checkbox-row">Automatically mark opened files reviewed<input aria-label="Automatically mark opened files reviewed" type="checkbox" checked={draftPreferences.autoMarkReviewed} onChange={event => setDraftPreferences(current => ({ ...current, autoMarkReviewed: event.target.checked }))} /></label>
              <label className="checkbox-row">Intraline differences<input aria-label="Intraline differences" type="checkbox" checked={draftPreferences.intralineDifference} onChange={event => setDraftPreferences(current => ({ ...current, intralineDifference: event.target.checked }))} /></label>
              <label className="checkbox-row">Show tabs<input aria-label="Show tabs" type="checkbox" checked={draftPreferences.showTabs} onChange={event => setDraftPreferences(current => ({ ...current, showTabs: event.target.checked }))} /></label>
              <label className="checkbox-row">Show trailing whitespace<input aria-label="Show trailing whitespace" type="checkbox" checked={draftPreferences.showTrailingWhitespace} onChange={event => setDraftPreferences(current => ({ ...current, showTrailingWhitespace: event.target.checked }))} /></label>
              <label className="checkbox-row">Syntax highlighting<input aria-label="Syntax highlighting" type="checkbox" checked={draftPreferences.syntaxHighlighting} onChange={event => setDraftPreferences(current => ({ ...current, syntaxHighlighting: event.target.checked }))} /></label>
              <CodeSelect
                className="review-preferences-select"
                label="Ignore Whitespace"
                value={draftPreferences.ignoreWhitespace}
                options={[
                  { value: 'NONE', label: 'None' },
                  { value: 'TRAILING', label: 'Trailing' },
                  { value: 'LEADING_AND_TRAILING', label: 'Leading + trailing' },
                  { value: 'ALL', label: 'All' },
                ]}
                onChange={value => setDraftPreferences(current => ({ ...current, ignoreWhitespace: value as IgnoreWhitespace }))}
              />
            </div>
            <footer className="code-dialog-actions"><button ref={preferencesCancelRef} type="button" onClick={() => setShowPreferences(false)}>CANCEL</button><button className="primary" type="button" onClick={savePreferences}>SAVE</button></footer>
          </section>
        </div>, document.body,
      ) : null}
    </main>
  )
}
