import { Fragment, type ReactNode, useEffect, useRef, useState } from 'react'
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
  ArrowRightGlyph,
  ChevronDownGlyph,
  ChevronRightGlyph,
  CloseGlyph,
  CopyGlyph,
  DiffSplitGlyph,
  DiffUnifiedGlyph,
  SettingsGlyph,
} from '@/components/IconGlyphs'
import { completeReviewFileDiffLoad, failReviewFileDiffLoad } from '@/lib/review/effects'
import { reviewFileRowModel, type ReviewFileRowAction, type ReviewFileRowModel } from '@/lib/review/file-list'
import { reviewSnapshotRequestFromLocation } from '@/lib/review/route-target'
import { createReviewStateFromSnapshot, reviewCatalogFromSnapshot, reviewCatalogWithFile, reviewCatalogWithUnmodifiedPaths, type ReviewComparison, type ReviewDiffSnapshotRequest } from '@/lib/review/snapshot'
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
  type ReviewCommentSide,
  type ReviewDiffCell,
  type ReviewDiffMode,
  type ReviewDiffRow,
  type ReviewCatalog,
  type ReviewFile,
  type ReviewFileDiff,
  type ReviewPreferences,
  type ReviewState,
} from '@/lib/review/state'
import { createReviewSession, deleteReviewComment, loadReviewComments, loadReviewDiffSnapshot, loadReviewFileDiff, loadReviewedPatchsetState, loadReviewSession, refreshReviewSession, reviewRequestForSessionRevision, ReviewApiError, REVIEW_DEMO_ID, saveReviewComment, saveReviewedFilesStatus, updateReviewCommentStatus, type ReviewSessionRevision } from '@/lib/review/api'

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

type ReviewFileSeed = Omit<ReviewFile, 'diff'>

async function reloadReviewFiles(
  request: ReviewDiffSnapshotRequest,
  paths: string[],
): Promise<{ errors: Error[]; files: ReviewFile[] }> {
  const files: ReviewFile[] = []
  const errors: Error[] = []
  let cursor = 0
  await Promise.all(Array.from({ length: Math.min(4, paths.length) }, async () => {
    while (cursor < paths.length) {
      const path = paths[cursor++]
      if (!path) continue
      try {
        files.push(await loadReviewFileDiff(request, path))
      } catch (error) {
        errors.push(error instanceof Error ? error : new Error('review file diff request failed'))
      }
    }
  }))
  return { errors, files }
}

function createDemoDiff(file: ReviewFileSeed): ReviewFileDiff {
  const language = diffLanguageForPath(file.path)
  const isPython = language === 'python'
  const createdName = basename(file.path).replace(/\W/g, '_')
  const context = (line: number, text: string): ReviewDiffRow => ({
    kind: 'context',
    left: { line, text },
    right: { line, text },
  })
  const commonContext = Array.from({ length: 100 }, (_, index) => {
    const line = 29 + index
    const prefix = language === 'python' ? '#' : language === 'markdown' ? '<!--' : '//'
    const suffix = language === 'markdown' ? ' -->' : ''
    return context(line, `${index === 0 || index === 99 ? '\t' : ''}${prefix} unchanged review context ${index + 1}${suffix}`)
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
const DIFF_PREFERENCES_STORAGE_KEY = 'farming.review-demo.diff-preferences'

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

function initialReviewPatchset(request: ReviewDiffSnapshotRequest | null, demoMode = true) {
  if (!request) return demoMode ? 'Patchset 20' : INVALID_REVIEW_PATCHSET
  return request.source === 'git-range' ? request.head : WORKING_COPY_PATCHSET
}

function initialReviewBasePatchset(request: ReviewDiffSnapshotRequest | null, demoMode = true) {
  if (!request) return demoMode ? 'Base' : 'Base'
  return request.source === 'git-range' ? request.base : 'HEAD'
}

function initialReviewCatalog(request: ReviewDiffSnapshotRequest | null, demoMode = true): ReviewCatalog {
  if (!request) return demoMode ? PATCHSET_FILES : { [INVALID_REVIEW_PATCHSET]: [] }
  return { [initialReviewPatchset(request, demoMode)]: [] }
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
    <div className={`review-demo-review-status ${reviewed ? 'reviewed' : ''} ${pending ? 'pending' : ''}`}>
      {reviewedLabel ? <span className="review-demo-reviewed-label">{reviewedLabel}</span> : null}
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
        <span className="review-demo-review-loading">Reviewed status loading</span>
      )}
    </div>
  )
}

function ChangeBar({ file, maxChangeSize }: { file: ReviewFile; maxChangeSize: number }) {
  if (file.binary) return <span className="review-demo-change-bar binary" aria-label="Binary file" />
  const width = (value: number) => value === 0 ? 0 : Math.max(2, Math.round((value / maxChangeSize) * 72))
  return (
    <span className="review-demo-change-bar" aria-label={`+${file.added} −${file.removed}`}>
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
      <span className="review-demo-file-stats binary">
        {sizeDelta === null ? 'Binary' : formatBytes(sizeDelta)}
      </span>
    )
  }
  return <span className="review-demo-file-stats">{file.added ? <span className="added">+{file.added}</span> : null}{file.removed ? <span className="removed">−{file.removed}</span> : null}</span>
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

function CodeCell({
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
  if (preferences.showTabs) html = html.replace(/\t/g, '<span class="review-demo-tab-marker">⇥</span>')
  if (trailingWhitespace) {
    html += `<span class="review-demo-trailing-whitespace">${trailingWhitespace.replace(/[ \t]/g, '·')}</span>`
  }
  return <code {...commentAttributes} dangerouslySetInnerHTML={{ __html: html }} />
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
      html += `<span class="review-demo-intraline">${renderCodeHtml(sliceCodepoints(text, start, end), language, preferences)}</span>`
    }
    cursor = end
  }
  html += renderCodeHtml(sliceCodepoints(text, cursor), language, preferences)
  return html
}

function UnifiedRow({
  kind,
  intraline,
  language,
  line,
  side,
  text,
  preferences,
  renderAttachment,
}: {
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
      <div className={`review-demo-diff-row unified ${kind}`}><span>{line ?? ''}</span><CodeCell intraline={intraline} language={language} line={line} side={side} text={text} preferences={preferences} /></div>
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
  const line = rightLine ?? leftLine
  const sides = [
    ...(leftLine ? ['left' as const] : []),
    ...(rightLine ? ['right' as const] : []),
  ]
  return (
    <>
      <div className={`review-demo-diff-row ${kind}`}>
        <span>{leftLine ?? ''}</span><CodeCell intraline={leftIntraline} language={language} line={leftLine} side="left" text={leftText ?? ''} preferences={preferences} />
        <span>{rightLine ?? ''}</span><CodeCell intraline={rightIntraline} language={language} line={rightLine} side="right" text={rightText ?? ''} preferences={preferences} />
      </div>
      {line ? renderAttachment?.(line, sides) : null}
    </>
  )
}

function DiffRows({
  file,
  mode,
  preferences,
  revealedContextHunks,
  renderAttachment,
  onExpandContext,
  onToggleContext,
}: {
  file: ReviewFile
  mode: DiffMode
  preferences: DiffPreferences
  revealedContextHunks: Set<string>
  renderAttachment: (line: number, sides: CommentSide[]) => ReactNode
  onExpandContext: (hunkIndex: number, context: number) => void
  onToggleContext: (hunkIndex: number) => void
}) {
  const language = diffLanguageForPath(file.path)
  const renderSkippedRow = (row: ReviewDiffRow, key: string, hunkIndex: number) => {
    const skipped = Math.max(row.leftLines ?? 0, row.rightLines ?? 0)
    return <button type="button" key={key} className="review-demo-skipped-row" onClick={() => onExpandContext(hunkIndex, Math.min(10000, preferences.context + skipped))}>Show {skipped} common lines</button>
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
              return <UnifiedRow key={key} intraline={cell?.intraline} kind="context" language={language} line={cell?.line} side={reviewCommentSideForUnifiedCell('context', Boolean(row.right))} text={cell?.text ?? ''} preferences={preferences} renderAttachment={renderAttachment} />
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

  return (
    <>
      {file.diff.hunks.map((hunk, index) => {
        const hunkKey = `${file.path}:${index}`
        const previousHunk = file.diff.hunks[index - 1]
        const previousOldEnd = previousHunk ? previousHunk.oldStart + previousHunk.oldLines - 1 : 0
        const previousNewEnd = previousHunk ? previousHunk.newStart + previousHunk.newLines - 1 : 0
        const hiddenGaps = [
          hunk.oldStart > 0 ? hunk.oldStart - previousOldEnd - 1 : null,
          hunk.newStart > 0 ? hunk.newStart - previousNewEnd - 1 : null,
        ].filter((value): value is number => typeof value === 'number' && value >= 0)
        const inferredHiddenLineCount = hiddenGaps.length ? Math.min(...hiddenGaps) : 0
        const commonContext = hunk.commonContext ?? []
        const commonContextExpanded = revealedContextHunks.has(hunkKey)
        const compactContext = commonContext.slice(Math.max(0, commonContext.length - preferences.context))
        const localHiddenLineCount = commonContext.length - compactContext.length
        const hiddenCommonLineCount = localHiddenLineCount || inferredHiddenLineCount
        const renderedContext = commonContextExpanded ? commonContext : compactContext
        const contextLabel = commonContextExpanded && localHiddenLineCount > 0
          ? `Hide ${localHiddenLineCount} common lines`
          : `Show ${hiddenCommonLineCount} common lines`
        const expandContext = () => {
          if (localHiddenLineCount > 0) onToggleContext(index)
          else onExpandContext(index, Math.min(10000, preferences.context + inferredHiddenLineCount))
        }
        return (
          <Fragment key={`${hunk.header}:${index}`}>
            {hiddenCommonLineCount > 0 ? (
              <button type="button" className={`review-demo-diff-hunk interactive ${index > 0 ? 'secondary' : ''}`} aria-label={contextLabel} onClick={expandContext}>
                <span>{hunk.header}</span><span>{contextLabel}</span>
              </button>
            ) : <div className={`review-demo-diff-hunk ${index > 0 ? 'secondary' : ''}`}><span>{hunk.header}</span></div>}
            {renderRows(renderedContext, index, 'context')}
            {renderRows(hunk.rows, index, 'change')}
          </Fragment>
        )
      })}
    </>
  )
}

function DiffStatusMessage({ row }: { row: ReviewFileRowModel }) {
  if (row.diffLoadError) {
    return <div className="review-demo-diff-message error" role="alert">Could not load diff: {row.diffLoadError}</div>
  }
  if (row.diffLoadPending) {
    return <div className="review-demo-diff-message" role="status">Loading diff…</div>
  }
  if (row.diffStatus === 'binary') {
    return <div className="review-demo-diff-message">Binary file changed</div>
  }
  if (row.diffStatus === 'too-expensive') {
    return <div className="review-demo-diff-message">Diff too large to render</div>
  }
  if (row.diffStatus === 'not-loaded') {
    return <div className="review-demo-diff-message">Diff not loaded yet</div>
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
    <form className="review-demo-comment-editor" onSubmit={event => { event.preventDefault(); onSave() }}>
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
        placeholder="Leave a review comment…"
        value={draft}
        onChange={event => onDraftChange(event.target.value)}
      />
      <footer>
        <button type="button" onClick={onCancel}>CANCEL</button>
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
    <article className={`review-demo-comment-thread ${status}`}>
      <header>
        <span>{status === 'outdated' ? `Outdated · ${targetLabel}` : targetLabel}</span>
        <span className="review-demo-comment-actions">
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

export function ReviewDemoPage() {
  const demoMode = typeof window !== 'undefined' && /\/review-demo\/?$/.test(window.location.pathname)
  const [reviewRouteTarget] = useState(() => reviewSnapshotRequestFromLocation(typeof window === 'undefined' ? null : window.location))
  const captureRouteRequest = !demoMode && reviewRouteTarget.request
    && (reviewRouteTarget.request.source === 'working-copy' || reviewRouteTarget.request.head === 'now')
    ? reviewRouteTarget.request
    : null
  const [reviewRequestBase, setReviewRequestBase] = useState<ReviewDiffSnapshotRequest | null>(() => captureRouteRequest ? null : reviewRouteTarget.request)
  const [reviewSessionRevision, setReviewSessionRevision] = useState<ReviewSessionRevision | null>(null)
  const [reviewView, setReviewView] = useState<'final' | 'fixes'>('final')
  const [capturePending, setCapturePending] = useState(Boolean(captureRouteRequest))
  const routeTargetError = Boolean(reviewRouteTarget.error)
  const externalReview = !demoMode
  const workingCopy = reviewRequestBase?.source === 'working-copy'
  const gitRange = reviewRequestBase?.source === 'git-range'
  const [catalog, setCatalog] = useState<ReviewCatalog>(() => routeTargetError ? { [INVALID_REVIEW_PATCHSET]: [] } : initialReviewCatalog(reviewRequestBase, demoMode))
  const [reviewLoadError, setReviewLoadError] = useState(reviewRouteTarget.error ?? '')
  const [reviewComparison, setReviewComparison] = useState<ReviewComparison | null>(null)
  const [reviewState, setReviewState] = useState<ReviewState>(() => {
    const initialCatalog = routeTargetError ? { [INVALID_REVIEW_PATCHSET]: [] } : initialReviewCatalog(reviewRequestBase, demoMode)
    return createPageReviewState({
      basePatchset: routeTargetError ? 'Base' : initialReviewBasePatchset(reviewRequestBase, demoMode),
      catalog: initialCatalog,
      comments: [],
      initialPatchset: routeTargetError ? INVALID_REVIEW_PATCHSET : initialReviewPatchset(reviewRequestBase, demoMode),
      initiallyExpand: !externalReview,
      reviewId: externalReview ? undefined : REVIEW_DEMO_ID,
    })
  })
  const reviewStateRef = useRef(reviewState)
  const catalogRef = useRef(catalog)
  catalogRef.current = catalog
  const [draftPreferences, setDraftPreferences] = useState<DiffPreferences>(DEFAULT_DIFF_PREFERENCES)
  const [showPreferences, setShowPreferences] = useState(false)
  const [commitCopied, setCommitCopied] = useState(false)
  const [reviewStatusError, setReviewStatusError] = useState('')
  const [reviewCommentError, setReviewCommentError] = useState('')
  const [reviewingPath, setReviewingPath] = useState('')
  const [contextLoadPaths, setContextLoadPaths] = useState<string[]>([])
  const reviewId = externalReview ? reviewState.reviewId ?? '' : REVIEW_DEMO_ID
  const patchset = reviewState.patchRange.patchset
  const basePatch = reviewState.patchRange.basePatchset
  const patchsetState = reviewStateForPatchset(reviewState, patchset)
  const expandedPaths = new Set(patchsetState.expandedPaths)
  const revealedContextHunks = new Set(patchsetState.revealedContextHunks)
  const diffMode = reviewState.diffMode
  const reviewScope = reviewSessionRevision?.scope ?? (reviewRequestBase?.source === 'working-copy' ? reviewRequestBase.scope : undefined)
  const effectiveDiffMode: DiffMode = reviewScope === 'untracked' ? 'unified' : diffMode
  const diffPreferences = reviewState.preferences
  const reviewDiffRequest: ReviewDiffSnapshotRequest | null = reviewRequestBase
    ? { ...reviewRequestBase, context: diffPreferences.context, ignoreWhitespace: diffPreferences.ignoreWhitespace }
    : null
  const reviewDiffRequestRef = useRef(reviewDiffRequest)
  reviewDiffRequestRef.current = reviewDiffRequest
  const displayedComparison: ReviewComparison | null = reviewSessionRevision
    ? {
        ...(reviewComparison ?? { workingTree: true }),
        head: undefined,
        workingTree: true,
      }
    : reviewComparison
  const commentTarget = reviewState.commentDraft
  const commentDraft = reviewState.commentDraft?.body ?? ''
  const files = catalog[patchset] ?? []
  const maxChangeSize = Math.max(1, ...files.map(file => file.added + file.removed))
  const applyReviewAction = (action: Parameters<typeof transitionReviewState>[1]) => {
    const transition = transitionReviewState(reviewStateRef.current, action, catalogRef.current)
    if (transition.state === reviewStateRef.current) return
    reviewStateRef.current = transition.state
    setReviewState(transition.state)
    for (const effect of transition.effects) {
      if (effect.type === 'load-file-diff') {
        const request = reviewDiffRequestRef.current
        if (!request) {
          applyReviewAction(failReviewFileDiffLoad(effect, 'review file diff source is unavailable'))
          continue
        }
        void loadReviewFileDiff(request, effect.path)
          .then(file => {
            const completed = completeReviewFileDiffLoad(catalogRef.current, effect, file, { reviewId: reviewStateRef.current.reviewId })
            catalogRef.current = completed.catalog
            setCatalog(completed.catalog)
            applyReviewAction(completed.action)
          })
          .catch(error => applyReviewAction(failReviewFileDiffLoad(effect, error)))
      }
      if (effect.type === 'save-reviewed-status') {
        const effectReviewId = effect.reviewId ?? reviewId
        void saveReviewedFilesStatus({ ...effect, reviewId: effectReviewId })
          .then(saved => applyReviewAction({
            patchset: effect.patchset,
            paths: effect.changes.map(change => change.path),
            reviewedPaths: saved.reviewedPaths,
            ...(effect.reviewId ? { reviewId: effect.reviewId } : {}),
            revision: saved.revision,
            type: 'commit-reviewed-status',
          }))
          .catch(async error => {
            let restored = error instanceof ReviewApiError && error.state
              ? error.state
              : await loadReviewedPatchsetState(effectReviewId, effect.patchset).catch(() => null)
          if (!restored) {
            const current = reviewStateForPatchset(reviewStateRef.current, effect.patchset)
            const reviewedPaths = new Set(current.reviewedPaths)
            for (const change of effect.changes) {
              if (change.reviewed) reviewedPaths.delete(change.path)
              else reviewedPaths.add(change.path)
            }
            restored = { reviewedPaths: [...reviewedPaths], revision: effect.revision }
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
          .then(() => applyReviewAction({
            id: effect.comment.id,
            patchset: effect.comment.patchset,
            pendingType: 'save',
            ...(effect.reviewId ? { reviewId: effect.reviewId } : {}),
            type: 'commit-comment',
          }))
          .catch(async error => {
            const comments = await loadReviewComments(effectReviewId, effect.comment.patchset)
              .catch(() => reviewStateRef.current.comments.filter(comment => comment.id !== effect.comment.id))
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
          .then(() => applyReviewAction({
            id: effect.comment.id,
            patchset: effect.comment.patchset,
            pendingType: 'delete',
            ...(effect.reviewId ? { reviewId: effect.reviewId } : {}),
            type: 'commit-comment',
          }))
          .catch(async error => {
            const comments = await loadReviewComments(effectReviewId, effect.comment.patchset)
              .catch(() => [...reviewStateRef.current.comments, effect.comment])
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

  useEffect(() => {
    document.body.classList.add('review-demo-body')
    return () => document.body.classList.remove('review-demo-body')
  }, [])

  useEffect(() => {
    if (!captureRouteRequest) return
    let active = true
    setCapturePending(true)
    const target = 'root' in captureRouteRequest && typeof captureRouteRequest.root === 'string'
      ? { root: captureRouteRequest.root }
      : { agentId: captureRouteRequest.agentId }
    const base = captureRouteRequest.source === 'git-range' ? captureRouteRequest.base : 'HEAD'
    const captureOptions = captureRouteRequest.source === 'working-copy'
      ? { modifiedWithinDays: captureRouteRequest.modifiedWithinDays, scope: captureRouteRequest.scope }
      : undefined
    void createReviewSession(target, base, captureOptions)
      .then(revision => {
        if (!active) return
        const request = reviewRequestForSessionRevision(revision, 'final')
        const params = new URLSearchParams(window.location.search)
        params.delete('agentId')
        params.set('root', revision.root)
        params.set('base', request.base)
        params.set('head', request.head)
        params.set('reviewId', revision.reviewId)
        window.history.replaceState(null, '', `${window.location.pathname}?${params.toString()}`)
        setReviewSessionRevision(revision)
        setReviewView('final')
        setReviewRequestBase(request)
        setReviewLoadError('')
      })
      .catch(error => {
        if (!active) return
        setReviewLoadError(error instanceof Error ? error.message : 'review capture failed')
      })
      .finally(() => { if (active) setCapturePending(false) })
    return () => { active = false }
  }, [captureRouteRequest])

  useEffect(() => {
    if (captureRouteRequest || reviewRequestBase?.source !== 'git-range' || !reviewRequestBase.reviewId) return
    let active = true
    void loadReviewSession(reviewRequestBase.reviewId)
      .then(session => {
        if (!active) return
        const revision = session.revisions.find(item => item.head === reviewRequestBase.head) ?? session
        setReviewSessionRevision(revision)
        setReviewView(reviewRequestBase.base === revision.fixesBase && revision.fixesBase !== revision.base ? 'fixes' : 'final')
      })
      .catch(() => {
        // The diff endpoint still reports a precise session/range error if this lookup fails.
      })
    return () => { active = false }
  }, [captureRouteRequest, reviewRequestBase])

  useEffect(() => {
    if (!reviewRequestBase) return
    let active = true
    const preferences = readStoredDiffPreferences()
    void loadReviewDiffSnapshot({ ...reviewRequestBase, context: preferences.context, ignoreWhitespace: preferences.ignoreWhitespace, metadataOnly: true })
      .then(async review => {
        const [savedReviewState, loadedComments] = await Promise.all([
          loadReviewedPatchsetState(review.reviewId, review.patchset).catch(() => null),
          loadReviewComments(review.reviewId, review.patchset).catch(() => []),
        ])
        if (!active) return
        const nextCatalog = reviewCatalogWithUnmodifiedPaths(
          reviewCatalogFromSnapshot(review),
          review.patchset,
          loadedComments.map(comment => comment.path),
        )
        let nextState = createReviewStateFromSnapshot({
          comments: loadedComments,
          preferences,
          ...(savedReviewState ? { reviewedPaths: savedReviewState.reviewedPaths } : {}),
          snapshot: review,
        })
        if (savedReviewState) {
          nextState = transitionReviewState(nextState, {
            patchset: review.patchset,
            reviewedPaths: savedReviewState.reviewedPaths,
            reviewId: review.reviewId,
            revision: savedReviewState.revision,
            type: 'hydrate-reviewed-status',
          }, nextCatalog).state
        }
        reviewStateRef.current = nextState
        catalogRef.current = nextCatalog
        setReviewComparison(review.comparison ?? null)
        setCatalog(nextCatalog)
        setReviewState(nextState)
        setReviewLoadError('')
      })
      .catch(error => {
        if (!active) return
        setReviewLoadError(error instanceof Error ? error.message : 'review diff request failed')
      })
    return () => { active = false }
  }, [reviewRequestBase])

  useEffect(() => {
    if (!reviewStatusError) return
    const timer = window.setTimeout(() => setReviewStatusError(''), 4000)
    return () => window.clearTimeout(timer)
  }, [reviewStatusError])

  useEffect(() => {
    if (!reviewCommentError) return
    const timer = window.setTimeout(() => setReviewCommentError(''), 4000)
    return () => window.clearTimeout(timer)
  }, [reviewCommentError])

  useEffect(() => {
    try {
      window.localStorage.setItem(DIFF_PREFERENCES_STORAGE_KEY, JSON.stringify(diffPreferences))
    } catch {
      // Keep the in-memory diff settings usable when browser storage is unavailable.
    }
  }, [reviewState.preferences])

  useEffect(() => {
    if (externalReview || !reviewId || !catalogRef.current[patchset]) return
    let active = true
    void loadReviewedPatchsetState(reviewId, patchset)
      .then(saved => {
        if (!active) return
        applyReviewAction({
          patchset,
          reviewedPaths: saved.reviewedPaths,
          reviewId,
          revision: saved.revision,
          type: 'hydrate-reviewed-status',
        })
      })
      .catch(() => {
        // The seeded page remains usable if the review-state endpoint is temporarily unavailable.
      })
    void loadReviewComments(reviewId, patchset)
      .then(loadedComments => {
        if (!active) return
        const nextCatalog = reviewCatalogWithUnmodifiedPaths(catalogRef.current, patchset, loadedComments.map(comment => comment.path))
        if (nextCatalog !== catalogRef.current) {
          catalogRef.current = nextCatalog
          setCatalog(nextCatalog)
        }
        applyReviewAction({ comments: loadedComments, patchset, reviewId, type: 'hydrate-comments' })
      })
      .catch(() => {
        // Comments remain empty until their review-state endpoint is available.
      })
    return () => { active = false }
  }, [externalReview, patchset, reviewId])

  useEffect(() => {
    const updateReviewingPath = () => {
      let nextPath = ''
      for (const article of document.querySelectorAll<HTMLElement>('.review-demo-file-change.expanded[data-file-path]')) {
        const header = article.querySelector<HTMLElement>('.review-demo-file-change-header')
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
  }, [patchset, patchsetState.expandedPaths.join('\0')])

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
    applyReviewAction({ patchset: nextPatchset, type: 'select-patchset' })
  }

  const allVisibleExpanded = files.length > 0 && files.every(file => expandedPaths.has(file.path))
  const toggleExpanded = (path: string) => {
    applyReviewAction({ path, type: 'toggle-file-expanded' })
  }

  const openPreferences = () => {
    setDraftPreferences(diffPreferences)
    setShowPreferences(true)
  }
  const savePreferences = () => {
    const previous = diffPreferences
    const next = normalizeReviewPreferences(draftPreferences)
    applyReviewAction({ preferences: next, type: 'set-preferences' })
    setShowPreferences(false)
    if (
      !externalReview || !reviewRequestBase
      || (previous.context === next.context && previous.ignoreWhitespace === next.ignoreWhitespace)
    ) return
    const targetPatchset = patchset
    const filesByPath = new Map(files.map(file => [file.path, file]))
    const paths = patchsetState.expandedPaths.filter(path => {
      const file = filesByPath.get(path)
      return Boolean(file && file.kind !== 'unmodified' && !file.binary && !file.diffTooExpensive)
    })
    if (!paths.length) return
    setContextLoadPaths(current => [...new Set([...current, ...paths])])
    void reloadReviewFiles({ ...reviewRequestBase, context: next.context, ignoreWhitespace: next.ignoreWhitespace }, paths)
      .then(result => {
        if (reviewStateRef.current.patchRange.patchset !== targetPatchset) return
        let nextCatalog = catalogRef.current
        for (const file of result.files) nextCatalog = reviewCatalogWithFile(nextCatalog, targetPatchset, file)
        catalogRef.current = nextCatalog
        setCatalog(nextCatalog)
        const firstError = result.errors[0]
        if (firstError) setReviewLoadError(firstError.message)
      })
      .finally(() => setContextLoadPaths(current => current.filter(path => !paths.includes(path))))
  }
  const copyCommit = () => {
    if (navigator.clipboard) {
      void navigator.clipboard.writeText('34a15ae').catch(() => {})
    }
    setCommitCopied(true)
    window.setTimeout(() => setCommitCopied(false), 1200)
  }
  const toggleCommonContext = (path: string, hunkIndex: number) => {
    applyReviewAction({ hunkIndex, path, type: 'toggle-common-context' })
  }
  const expandRemoteContext = (path: string, context: number) => {
    const request = reviewDiffRequestRef.current
    if (!request || contextLoadPaths.includes(path)) return
    const targetPatchset = patchset
    setContextLoadPaths(current => [...current, path])
    void loadReviewFileDiff({ ...request, context }, path)
      .then(file => {
        const nextCatalog = reviewCatalogWithFile(catalogRef.current, targetPatchset, file)
        catalogRef.current = nextCatalog
        setCatalog(nextCatalog)
      })
      .catch(error => setReviewLoadError(error instanceof Error ? error.message : 'review context request failed'))
      .finally(() => setContextLoadPaths(current => current.filter(item => item !== path)))
  }
  const startComment = (path: string, line: number, side: CommentSide, range?: ReviewCommentRange) => {
    applyReviewAction({ line, path, range, side, type: 'start-comment' })
  }
  const saveComment = () => {
    if (!commentTarget || !commentDraft.trim()) return
    applyReviewAction({
      id: typeof crypto?.randomUUID === 'function'
        ? crypto.randomUUID()
        : `comment-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      type: 'save-comment',
    })
  }
  const changeCommentStatus = (comment: ReviewComment, status: 'open' | 'resolved') => {
    if (!reviewId) return
    void updateReviewCommentStatus(reviewId, comment.patchset, comment.id, status)
      .then(() => loadReviewComments(reviewId, comment.patchset))
      .then(comments => applyReviewAction({ comments, patchset: comment.patchset, reviewId, type: 'hydrate-comments' }))
      .catch(error => setReviewCommentError(error instanceof Error ? error.message : 'review comment status failed'))
  }
  const setSessionRequest = (revision: ReviewSessionRevision, view: 'final' | 'fixes') => {
    const request = reviewRequestForSessionRevision(revision, view)
    const params = new URLSearchParams(window.location.search)
    params.delete('agentId')
    params.set('root', revision.root)
    params.set('base', request.base)
    params.set('head', request.head)
    params.set('reviewId', revision.reviewId)
    window.history.replaceState(null, '', `${window.location.pathname}?${params.toString()}`)
    setReviewSessionRevision(revision)
    setReviewView(view)
    setReviewRequestBase(request)
  }
  const refreshCapturedReview = () => {
    if (!reviewSessionRevision || capturePending) return
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
  const workingCopyScope = reviewScope
  const filesLabel = workingCopyScope === 'tracked' ? 'Changes' : workingCopyScope === 'untracked' ? 'Untracked' : 'Files'
  const emptyReviewMessage = capturePending
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
    <main className="review-demo-root" data-testid="review-demo-page">
      <section className="review-demo-files" aria-label="Changed files">
        <header className="review-demo-files-toolbar">
          <div className="review-demo-patch-info">
            <strong>{filesLabel}</strong>
            <span className="review-demo-patch-static">{basePatch}</span>
            <ArrowRightGlyph />
            {externalReview ? <span className="review-demo-patch-static">{patchset}</span> : (
              <select aria-label="Patch set" value={patchset} onChange={event => selectPatchset(event.target.value)}>
                <option value="Patchset 20">Patchset 20</option>
                <option value="Patchset 19">Patchset 19</option>
              </select>
            )}
            {reviewSessionRevision ? <span className="review-demo-revision-label">Revision {reviewSessionRevision.number}</span> : null}
            {!externalReview ? <button type="button" className="review-demo-commit" onClick={copyCommit} title="Copy commit">
              {commitCopied ? 'Copied' : '34a15ae'}<CopyGlyph />
            </button> : null}
          </div>
          <div className="review-demo-files-actions">
            {reviewSessionRevision ? <>
              {reviewSessionRevision.number > 1 ? <button type="button" className={reviewView === 'fixes' ? 'active' : ''} onClick={() => selectReviewView('fixes')}>FIXES SINCE REVIEW</button> : null}
              <button type="button" disabled={capturePending} onClick={refreshCapturedReview}>{capturePending ? 'CAPTURING…' : 'REFRESH'}</button>
              <span className="review-demo-toolbar-separator" />
            </> : null}
            <button type="button" onClick={() => applyReviewAction({
              expanded: !allVisibleExpanded,
              paths: files.map(file => file.path),
              type: 'set-all-files-expanded',
            })}>{allVisibleExpanded ? 'COLLAPSE ALL' : 'EXPAND ALL'}</button>
            <span className="review-demo-toolbar-separator" />
            {reviewScope !== 'untracked' ? <>
              <span>Diff view:</span>
              <button type="button" className={`review-demo-icon-action ${diffMode === 'split' ? 'active' : ''}`} aria-label="Side-by-side diff" title="Side-by-side diff" onClick={() => applyReviewAction({ mode: 'split', type: 'set-diff-mode' })}><DiffSplitGlyph /></button>
              <button type="button" className={`review-demo-icon-action ${diffMode === 'unified' ? 'active' : ''}`} aria-label="Unified diff" title="Unified diff" onClick={() => applyReviewAction({ mode: 'unified', type: 'set-diff-mode' })}><DiffUnifiedGlyph /></button>
            </> : null}
            <button type="button" className="review-demo-icon-action" aria-label="Diff preferences" title="Diff preferences" onClick={openPreferences}><SettingsGlyph /></button>
          </div>
          {reviewStatusError || reviewCommentError ? <span className="review-demo-review-error" role="status">{reviewStatusError || reviewCommentError}</span> : null}
        </header>
        {externalReview && displayedComparison ? (
          <details className="review-demo-commit-message">
            <summary>
              <span>Commit message</span>
              <strong>{displayedComparison.workingTree ? 'Workspace changes' : displayedComparison.head?.message.split('\n')[0] || 'Commit details'}</strong>
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
                  <pre>Uncommitted workspace changes do not have a commit author or commit message yet.</pre>
                </>
              )}
            </div>
          </details>
        ) : null}
        <div className="review-demo-files-list">
          {reviewLoadError ? <p className="review-demo-working-copy-message" role="alert">{reviewLoadLabel}: {reviewLoadError}</p> : null}
          {externalReview && !reviewLoadError && files.length === 0 ? <p className="review-demo-working-copy-message" role="status">{emptyReviewMessage}</p> : null}
          {files.map(file => {
            const rowModel = reviewFileRowModel(reviewState, file, { mutationPending: reviewMutationPending })
            const fileComments = commentsForFilePaths(reviewState, rowModel.commentPaths)
            const outdatedComments = fileComments.filter(comment => comment.status === 'outdated')
            const commentPathForSide = (side: CommentSide) => reviewCommentPathForSide(file, side)
            const renderLineAttachment = (line: number, sides: CommentSide[]) => {
              const activeTarget = commentTarget
                && commentTarget.path === commentPathForSide(commentTarget.side)
                && commentTarget.line === line
                && sides.includes(commentTarget.side)
                ? commentTarget
                : null
              const lineComments = fileComments.filter(comment => {
                return comment.status !== 'outdated'
                  && comment.line === line
                  && sides.includes(comment.side)
                  && comment.path === commentPathForSide(comment.side)
              })
              if (!activeTarget && lineComments.length === 0) return null
              return (
                <div className="review-demo-line-attachment" data-review-comment-line={line}>
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
              <article className={`review-demo-file-change ${rowModel.expanded ? 'expanded' : ''} ${reviewingPath === file.path ? 'reviewing' : ''}`} key={file.path} data-testid="review-demo-file-row" data-change-kind={file.kind} data-file-path={file.path}>
                <header className="review-demo-file-change-header">
                  <button
                    type="button"
                    className="review-demo-file-select"
                    onClick={() => toggleExpanded(file.path)}
                  >
                    <span className="review-demo-file-status">{rowModel.changeLabel}</span>
                    <span className="review-demo-file-paths">
                      <span className="review-demo-file-name">{file.path}</span>
                      {file.previousPath ? <span className="review-demo-file-previous-path" title={`Previous path: ${file.previousPath}`}>{file.previousPath}</span> : null}
                    </span>
                    <ChangeBar file={file} maxChangeSize={maxChangeSize} />
                    <FileStats file={file} />
                  </button>
                  <ReviewStatus action={rowModel.action} pending={rowModel.pending} reviewed={rowModel.reviewed} reviewedLabel={rowModel.reviewedLabel} onToggle={() => {
                    if (!rowModel.action) return
                    toggleReviewed(file.path, rowModel.action.nextReviewed)
                  }} />
                  <button type="button" className="review-demo-file-expand" aria-label={rowModel.expanded ? 'Collapse file diff' : 'Expand file diff'} onClick={() => toggleExpanded(file.path)}>{rowModel.expanded ? <ChevronDownGlyph /> : <ChevronRightGlyph />}</button>
                </header>
                {rowModel.expanded ? (
                  <section className={`review-demo-inline-diff ${effectiveDiffMode} ${diffPreferences.fitToScreen ? 'fit-to-screen' : ''}`} aria-label={`Diff for ${file.path}`}>
                    {outdatedComments.length ? <div className="review-demo-outdated-comments">
                      {outdatedComments.map(comment => <CommentThread
                        comment={comment}
                        disabled={commentMutationPending}
                        key={comment.id}
                        onDelete={() => applyReviewAction({ id: comment.id, type: 'delete-comment' })}
                        onStatusChange={status => changeCommentStatus(comment, status)}
                      />)}
                    </div> : null}
                    <div className="review-demo-diff-columns"><span>File</span>{effectiveDiffMode === 'split' ? <span>File</span> : null}</div>
                    {rowModel.diffStatus !== 'loaded' || rowModel.diffLoadPending || rowModel.diffLoadError ? (
                      <DiffStatusMessage row={rowModel} />
                    ) : (
                      <>
                        <div
                          className="review-demo-diff-code"
                          style={{ fontSize: `${diffPreferences.fontSize}px`, tabSize: diffPreferences.tabSize, minWidth: diffPreferences.fitToScreen ? undefined : `${Math.round(diffPreferences.lineLength * diffPreferences.fontSize * 0.62)}px` }}
                          onClick={event => {
                            const selection = window.getSelection()
                            if (selection && !selection.isCollapsed) return
                            if (!(event.target instanceof Element)) return
                            const codeCell = event.target.closest<HTMLElement>('code[data-review-line][data-review-side]')
                            if (!codeCell) return
                            const line = Number(codeCell.dataset.reviewLine)
                            const side = codeCell.dataset.reviewSide
                            if (!Number.isFinite(line) || (side !== 'left' && side !== 'right' && side !== 'unified')) return
                            startComment(commentPathForSide(side), line, side)
                          }}
                          onMouseUp={event => {
                            const selected = commentRangeFromSelection(event.currentTarget)
                            if (!selected) return
                            startComment(commentPathForSide(selected.side), selected.line, selected.side, selected.range)
                          }}
                        >
                          <DiffRows file={file} mode={effectiveDiffMode} preferences={diffPreferences} revealedContextHunks={revealedContextHunks} renderAttachment={renderLineAttachment} onExpandContext={(_hunkIndex, context) => expandRemoteContext(file.path, context)} onToggleContext={hunkIndex => toggleCommonContext(file.path, hunkIndex)} />
                        </div>
                      </>
                    )}
                  </section>
                ) : null}
              </article>
            )
          })}
        </div>
      </section>
      {showPreferences ? (
        <div className="review-demo-preferences-backdrop" role="presentation" onMouseDown={() => setShowPreferences(false)}>
          <section className="review-demo-preferences" role="dialog" aria-modal="true" aria-labelledby="review-demo-preferences-title" onMouseDown={event => event.stopPropagation()}>
            <header><h2 id="review-demo-preferences-title">Diff Preferences</h2></header>
            <div className="review-demo-preferences-form">
              <label>Context<select aria-label="Context" value={draftPreferences.context} onChange={event => setDraftPreferences(current => ({ ...current, context: Number(event.target.value) }))}><option value={3}>3 lines</option><option value={10}>10 lines</option><option value={25}>25 lines</option><option value={100}>100 lines</option></select></label>
              <label className="checkbox-row">Fit to screen<input aria-label="Fit to screen" type="checkbox" checked={draftPreferences.fitToScreen} onChange={event => setDraftPreferences(current => ({ ...current, fitToScreen: event.target.checked }))} /></label>
              <label>Diff width<input aria-label="Diff width" type="number" autoComplete="off" data-form-type="other" min={40} max={240} value={draftPreferences.lineLength} onChange={event => setDraftPreferences(current => ({ ...current, lineLength: Number(event.target.value) || current.lineLength }))} /></label>
              <label>Tab width<input aria-label="Tab width" type="number" autoComplete="off" data-form-type="other" min={2} max={16} value={draftPreferences.tabSize} onChange={event => setDraftPreferences(current => ({ ...current, tabSize: Number(event.target.value) || current.tabSize }))} /></label>
              <label>Font size<input aria-label="Font size" type="number" autoComplete="off" data-form-type="other" min={10} max={20} value={draftPreferences.fontSize} onChange={event => setDraftPreferences(current => ({ ...current, fontSize: Number(event.target.value) || current.fontSize }))} /></label>
              <label className="checkbox-row">Intraline differences<input aria-label="Intraline differences" type="checkbox" checked={draftPreferences.intralineDifference} onChange={event => setDraftPreferences(current => ({ ...current, intralineDifference: event.target.checked }))} /></label>
              <label className="checkbox-row">Show tabs<input aria-label="Show tabs" type="checkbox" checked={draftPreferences.showTabs} onChange={event => setDraftPreferences(current => ({ ...current, showTabs: event.target.checked }))} /></label>
              <label className="checkbox-row">Show trailing whitespace<input aria-label="Show trailing whitespace" type="checkbox" checked={draftPreferences.showTrailingWhitespace} onChange={event => setDraftPreferences(current => ({ ...current, showTrailingWhitespace: event.target.checked }))} /></label>
              <label className="checkbox-row">Syntax highlighting<input aria-label="Syntax highlighting" type="checkbox" checked={draftPreferences.syntaxHighlighting} onChange={event => setDraftPreferences(current => ({ ...current, syntaxHighlighting: event.target.checked }))} /></label>
              <label>Ignore Whitespace<select aria-label="Ignore Whitespace" value={draftPreferences.ignoreWhitespace} onChange={event => setDraftPreferences(current => ({ ...current, ignoreWhitespace: event.target.value as IgnoreWhitespace }))}><option value="NONE">None</option><option value="TRAILING">Trailing</option><option value="LEADING_AND_TRAILING">Leading + trailing</option><option value="ALL">All</option></select></label>
            </div>
            <footer><button type="button" onClick={() => setShowPreferences(false)}>CANCEL</button><button type="button" onClick={savePreferences}>SAVE</button></footer>
          </section>
        </div>
      ) : null}
    </main>
  )
}
