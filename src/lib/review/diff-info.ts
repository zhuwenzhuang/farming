import type { ReviewDiffCell, ReviewDiffFileMeta, ReviewDiffHunk, ReviewDiffRow, ReviewDiffSyntaxBlock, ReviewDiffWebLink, ReviewFile, ReviewFileDiff, ReviewFileStatusCode } from './state'
import type { GerritFileInfo } from './file-info'
import { isGerritReviewFileStatus, reviewFileFromGerritFileInfo } from './file-info'

export type GerritChangeType = 'ADDED' | 'COPIED' | 'DELETED' | 'MODIFIED' | 'RENAMED' | 'REWRITE'

export type GerritDiffSkipInfo = number | {
  left: number
  right: number
}

export type GerritDiffContent = {
  a?: unknown
  ab?: unknown
  b?: unknown
  common?: unknown
  due_to_rebase?: unknown
  edit_a?: unknown
  edit_b?: unknown
  move_details?: unknown
  skip?: unknown
}

export type GerritDiffIntralineInfo = [number, number]

export type GerritMoveDetails = {
  changed: boolean
  range?: {
    end: number
    start: number
  }
}

export type GerritWebLinkInfo = {
  name?: unknown
  url?: unknown
}

export type GerritTextRange = {
  end_column?: unknown
  end_line?: unknown
  start_column?: unknown
  start_line?: unknown
}

export type GerritSyntaxBlock = {
  children?: unknown
  name?: unknown
  range?: unknown
}

export type GerritDiffFileMetaInfo = {
  content_type?: unknown
  language?: unknown
  lines?: unknown
  name?: unknown
  syntax_tree?: unknown
  web_links?: unknown
}

export type GerritDiffInfo = {
  binary?: unknown
  change_type: unknown
  content?: unknown
  diff_header?: unknown
  intraline_status?: unknown
  meta_a?: unknown
  meta_b?: unknown
}

function lines(value: unknown): string[] {
  return Array.isArray(value) && value.every(line => typeof line === 'string') ? value : []
}

function diffHeader(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every(line => typeof line === 'string') ? value : undefined
}

function intralineStatus(value: unknown): ReviewFileDiff['intralineStatus'] | undefined {
  if (value === 'OK') return 'OK'
  if (value === 'ERROR' || value === 'Error') return 'ERROR'
  if (value === 'TIMEOUT' || value === 'Timeout') return 'TIMEOUT'
  return undefined
}

function textRange(value: unknown): ReviewDiffSyntaxBlock['range'] | undefined {
  if (!value || typeof value !== 'object') return undefined
  const range = value as GerritTextRange
  const startLine = range.start_line
  const startColumn = range.start_column
  const endLine = range.end_line
  const endColumn = range.end_column
  if (
    typeof startLine !== 'number'
    || typeof startColumn !== 'number'
    || typeof endLine !== 'number'
    || typeof endColumn !== 'number'
    || !Number.isInteger(startLine)
    || !Number.isInteger(startColumn)
    || !Number.isInteger(endLine)
    || !Number.isInteger(endColumn)
    || startLine < 1
    || startColumn < 1
    || endLine < startLine
    || endColumn < 1
  ) return undefined
  return {
    endColumn,
    endLine,
    startColumn,
    startLine,
  }
}

function syntaxBlock(value: unknown): ReviewDiffSyntaxBlock | undefined {
  if (!value || typeof value !== 'object') return undefined
  const block = value as GerritSyntaxBlock
  if (typeof block.name !== 'string' || !block.name) return undefined
  const children = Array.isArray(block.children)
    ? block.children.map(syntaxBlock).filter((child): child is ReviewDiffSyntaxBlock => Boolean(child))
    : []
  const range = textRange(block.range)
  return {
    ...(children.length ? { children } : {}),
    name: block.name,
    ...(range ? { range } : {}),
  }
}

function webLink(value: unknown): ReviewDiffWebLink | undefined {
  if (!value || typeof value !== 'object') return undefined
  const link = value as GerritWebLinkInfo
  if (typeof link.name !== 'string' || !link.name || typeof link.url !== 'string' || !link.url) return undefined
  return {
    name: link.name,
    url: link.url,
  }
}

function diffFileMeta(value: unknown): ReviewDiffFileMeta | undefined {
  if (!value || typeof value !== 'object') return undefined
  const meta = value as GerritDiffFileMetaInfo
  const lines = meta.lines
  if (
    typeof meta.name !== 'string'
    || !meta.name
    || typeof meta.content_type !== 'string'
    || !meta.content_type
    || typeof lines !== 'number'
    || !Number.isInteger(lines)
    || lines < 0
  ) return undefined
  const syntaxTree = Array.isArray(meta.syntax_tree)
    ? meta.syntax_tree.map(syntaxBlock).filter((block): block is ReviewDiffSyntaxBlock => Boolean(block))
    : []
  const webLinks = Array.isArray(meta.web_links)
    ? meta.web_links.map(webLink).filter((link): link is ReviewDiffWebLink => Boolean(link))
    : []
  return {
    contentType: meta.content_type,
    ...(typeof meta.language === 'string' && meta.language ? { language: meta.language } : {}),
    lines,
    name: meta.name,
    ...(syntaxTree.length ? { syntaxTree } : {}),
    ...(webLinks.length ? { webLinks } : {}),
  }
}

function skipLines(skip: unknown): { left: number; right: number } | undefined {
  if (Number.isInteger(skip) && (skip as number) > 0) return { left: skip as number, right: skip as number }
  if (!skip || typeof skip !== 'object') return undefined
  const candidate = skip as { left?: unknown; right?: unknown }
  const leftValue = candidate.left
  const rightValue = candidate.right
  const left = typeof leftValue === 'number' && Number.isInteger(leftValue) && leftValue > 0 ? leftValue : 0
  const right = typeof rightValue === 'number' && Number.isInteger(rightValue) && rightValue > 0 ? rightValue : 0
  return left || right ? { left, right } : undefined
}

function moveDetails(value: unknown): ReviewDiffRow['moveDetails'] | undefined {
  if (!value || typeof value !== 'object') return undefined
  const candidate = value as GerritMoveDetails
  if (typeof candidate.changed !== 'boolean') return undefined
  const range = candidate.range
  if (range === undefined) return { changed: candidate.changed }
  if (
    !Number.isInteger(range.start)
    || !Number.isInteger(range.end)
    || range.start < 1
    || range.end < range.start
  ) return { changed: candidate.changed }
  return {
    changed: candidate.changed,
    range: {
      end: range.end,
      start: range.start,
    },
  }
}

function chunkMetadata(chunk: GerritDiffContent): Pick<ReviewDiffRow, 'dueToRebase' | 'moveDetails'> {
  const normalizedMoveDetails = moveDetails(chunk.move_details)
  return {
    ...(chunk.due_to_rebase === true ? { dueToRebase: true } : {}),
    ...(normalizedMoveDetails ? { moveDetails: normalizedMoveDetails } : {}),
  }
}

function rowSpanCounts(rows: readonly ReviewDiffRow[]) {
  return rows.reduce((counts, row) => ({
    left: counts.left + (row.left ? 1 : 0) + (row.kind === 'skipped' ? row.leftLines ?? 0 : 0),
    right: counts.right + (row.right ? 1 : 0) + (row.kind === 'skipped' ? row.rightLines ?? 0 : 0),
  }), { left: 0, right: 0 })
}

function rowChangeCounts(rows: readonly ReviewDiffRow[]) {
  return rows.reduce((counts, row) => ({
    added: counts.added + (!row.whitespaceOnly && (row.kind === 'added' || row.kind === 'changed') ? 1 : 0),
    removed: counts.removed + (!row.whitespaceOnly && (row.kind === 'deleted' || row.kind === 'changed') ? 1 : 0),
  }), { added: 0, removed: 0 })
}

function stringLength(value: string) {
  return Array.from(value).length
}

function cell(line: number, text: string, intraline?: ReviewDiffCell['intraline']): ReviewDiffCell {
  return intraline && intraline.length ? { intraline, line, text } : { line, text }
}

function validIntralineInfo(value: unknown): value is GerritDiffIntralineInfo {
  return Array.isArray(value)
    && value.length === 2
    && Number.isInteger(value[0])
    && value[0] >= 0
    && Number.isInteger(value[1])
    && value[1] >= 0
}

function normalizedIntralineInfo(value: unknown): GerritDiffIntralineInfo[] | undefined {
  if (!Array.isArray(value) || !value.every(validIntralineInfo)) return undefined
  return value
}

export function reviewIntralineRangesFromGerrit(rows: readonly string[], intralineInfos?: readonly GerritDiffIntralineInfo[]) {
  if (!intralineInfos || intralineInfos.length === 0) return []
  const lineLengths = rows.map(row => stringLength(row) + 1)
  const rangesByLine: Array<Array<{ end: number; start: number }>> = rows.map(() => [])
  const pushRange = (line: number, start: number, end: number) => {
    const text = rows[line]
    const ranges = rangesByLine[line]
    if (text === undefined || ranges === undefined) return
    ranges.push({
      end: Math.min(end, stringLength(text)),
      start: Math.min(start, stringLength(text)),
    })
  }
  let rowIndex = 0
  let index = 0

  for (const [skipLength, markLength] of intralineInfos) {
    let lineLength = lineLengths[rowIndex]
    let skipped = 0
    while (skipped < skipLength && lineLength !== undefined) {
      if (index === lineLength) {
        index = 0
        lineLength = lineLengths[++rowIndex]
        continue
      }
      index += 1
      skipped += 1
    }

    let startLine = rowIndex
    let startIndex = index
    let marked = 0
    while (lineLength !== undefined && marked < markLength) {
      if (index === lineLength) {
        pushRange(startLine, startIndex, index)
        index = 0
        lineLength = lineLengths[++rowIndex]
        startLine = rowIndex
        startIndex = index
        continue
      }
      index += 1
      marked += 1
    }
    pushRange(startLine, startIndex, index)
  }

  return rangesByLine.map(ranges => ranges.filter(range => range.end > range.start))
}

function hunkSideStart(rows: readonly ReviewDiffRow[], side: 'left' | 'right', lineCount: number) {
  if (lineCount === 0) return 0
  let skippedBeforeFirstLine = 0
  for (const row of rows) {
    const cell = side === 'left' ? row.left : row.right
    if (cell) return Math.max(0, cell.line - skippedBeforeFirstLine)
    if (row.kind === 'skipped') skippedBeforeFirstLine += side === 'left' ? row.leftLines ?? 0 : row.rightLines ?? 0
  }
  return 1
}

function hunkBounds(rows: readonly ReviewDiffRow[]): Pick<ReviewDiffHunk, 'newLines' | 'newStart' | 'oldLines' | 'oldStart'> {
  const counts = rowSpanCounts(rows)
  return {
    newLines: counts.right,
    newStart: hunkSideStart(rows, 'right', counts.right),
    oldLines: counts.left,
    oldStart: hunkSideStart(rows, 'left', counts.left),
  }
}

function hunkHeader(bounds: Pick<ReviewDiffHunk, 'newLines' | 'newStart' | 'oldLines' | 'oldStart'>) {
  return `@@ -${bounds.oldStart},${bounds.oldLines} +${bounds.newStart},${bounds.newLines} @@`
}

export function isGerritChangeType(changeType: unknown): changeType is GerritChangeType {
  return changeType === 'ADDED'
    || changeType === 'COPIED'
    || changeType === 'DELETED'
    || changeType === 'MODIFIED'
    || changeType === 'RENAMED'
    || changeType === 'REWRITE'
}

export function reviewKindFromGerritChangeType(changeType: unknown): ReviewFile['kind'] {
  if (changeType === 'ADDED') return 'added'
  if (changeType === 'COPIED') return 'copied'
  if (changeType === 'DELETED') return 'deleted'
  if (changeType === 'RENAMED') return 'renamed'
  if (changeType === 'REWRITE') return 'rewritten'
  return 'modified'
}

export function reviewStatusFromGerritChangeType(changeType: unknown): ReviewFileStatusCode {
  if (changeType === 'ADDED') return 'A'
  if (changeType === 'COPIED') return 'C'
  if (changeType === 'DELETED') return 'D'
  if (changeType === 'RENAMED') return 'R'
  if (changeType === 'REWRITE') return 'W'
  return 'M'
}

function diffContentChunks(content: unknown): GerritDiffContent[] {
  return Array.isArray(content)
    ? content.filter((chunk): chunk is GerritDiffContent => Boolean(chunk) && typeof chunk === 'object')
    : []
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function gerritDiffInfoRecord(diff: unknown): Record<string, unknown> {
  const source = objectRecord(diff)
  if (!source) throw new TypeError('invalid Gerrit DiffInfo')
  return source
}

export function reviewDiffRowsFromGerritContent(content: unknown): ReviewDiffRow[] {
  const rows: ReviewDiffRow[] = []
  let leftLine = 1
  let rightLine = 1

  for (const chunk of diffContentChunks(content)) {
    const skip = skipLines(chunk.skip)
    if (skip) {
      rows.push({ kind: 'skipped', leftLines: skip.left, rightLines: skip.right })
      leftLine += skip.left
      rightLine += skip.right
    }
    const metadata = chunkMetadata(chunk)

    for (const text of lines(chunk.ab)) {
      rows.push({ ...metadata, kind: 'context', left: { line: leftLine++, text }, right: { line: rightLine++, text } })
    }

    const left = lines(chunk.a)
    const right = lines(chunk.b)
    const leftIntraline = reviewIntralineRangesFromGerrit(left, normalizedIntralineInfo(chunk.edit_a))
    const rightIntraline = reviewIntralineRangesFromGerrit(right, normalizedIntralineInfo(chunk.edit_b))
    const pairCount = Math.min(left.length, right.length)
    for (let index = 0; index < pairCount; index += 1) {
      rows.push({
        ...metadata,
        kind: 'changed',
        left: cell(leftLine++, left[index] ?? '', leftIntraline[index]),
        right: cell(rightLine++, right[index] ?? '', rightIntraline[index]),
        ...(chunk.common === true ? { whitespaceOnly: true } : {}),
      })
    }
    for (let index = pairCount; index < left.length; index += 1) {
      rows.push({
        ...metadata,
        kind: 'deleted',
        left: cell(leftLine++, left[index] ?? '', leftIntraline[index]),
        ...(chunk.common === true ? { whitespaceOnly: true } : {}),
      })
    }
    for (let index = pairCount; index < right.length; index += 1) {
      rows.push({
        ...metadata,
        kind: 'added',
        right: cell(rightLine++, right[index] ?? '', rightIntraline[index]),
        ...(chunk.common === true ? { whitespaceOnly: true } : {}),
      })
    }
  }

  return rows
}

export function reviewFileDiffFromGerritDiffInfo(diff: unknown): ReviewFileDiff {
  const source = gerritDiffInfoRecord(diff)
  const rows = reviewDiffRowsFromGerritContent(source.content)
  const bounds = hunkBounds(rows)
  const hunk: ReviewDiffHunk = {
    ...bounds,
    header: hunkHeader(bounds),
    rows,
  }
  return {
    ...(diffHeader(source.diff_header) ? { diffHeader: diffHeader(source.diff_header) } : {}),
    hunks: rows.length ? [hunk] : [],
    ...(intralineStatus(source.intraline_status) ? { intralineStatus: intralineStatus(source.intraline_status) } : {}),
    ...(diffFileMeta(source.meta_a) ? { leftMeta: diffFileMeta(source.meta_a) } : {}),
    ...(diffFileMeta(source.meta_b) ? { rightMeta: diffFileMeta(source.meta_b) } : {}),
  }
}

export function reviewFileFromGerritDiffInfo(
  path: string,
  diff: unknown,
  options: {
    added?: number
    previousPath?: string
    removed?: number
    size?: number
    sizeDelta?: number
  } = {}
): ReviewFile {
  const source = gerritDiffInfoRecord(diff)
  const reviewDiff = reviewFileDiffFromGerritDiffInfo(diff)
  const counts = rowChangeCounts(reviewDiff.hunks.flatMap(hunk => hunk.rows))
  const kind = reviewKindFromGerritChangeType(source.change_type)
  return {
    added: options.added ?? counts.added,
    ...(source.binary === true ? { binary: true } : {}),
    diff: reviewDiff,
    diffLoaded: true,
    kind,
    path,
    ...(options.previousPath ? { previousPath: options.previousPath } : {}),
    removed: options.removed ?? counts.removed,
    ...(Number.isInteger(options.size) ? { size: options.size } : {}),
    ...(Number.isInteger(options.sizeDelta) ? { sizeDelta: options.sizeDelta } : {}),
    status: reviewStatusFromGerritChangeType(source.change_type),
  }
}

export function reviewFileFromGerritFileAndDiffInfo(
  path: string,
  fileInfo: GerritFileInfo = {},
  diffInfo?: unknown
): ReviewFile {
  const file = reviewFileFromGerritFileInfo(path, fileInfo)
  if (diffInfo === undefined) return file
  const hasAdded = typeof fileInfo.lines_inserted === 'number' && Number.isInteger(fileInfo.lines_inserted) && fileInfo.lines_inserted >= 0
  const hasRemoved = typeof fileInfo.lines_deleted === 'number' && Number.isInteger(fileInfo.lines_deleted) && fileInfo.lines_deleted >= 0
  const diffFile = reviewFileFromGerritDiffInfo(path, diffInfo, {
    ...(hasAdded ? { added: file.added } : {}),
    previousPath: file.previousPath,
    ...(hasRemoved ? { removed: file.removed } : {}),
    size: file.size,
    sizeDelta: file.sizeDelta,
  })
  return {
    ...file,
    ...(file.binary === true || diffFile.binary === true ? { binary: true } : {}),
    diff: diffFile.diff,
    diffLoaded: true,
    kind: isGerritReviewFileStatus(fileInfo.status) ? file.kind : diffFile.kind,
    status: isGerritReviewFileStatus(fileInfo.status) ? file.status : diffFile.status,
    ...(!hasAdded ? { added: diffFile.added } : {}),
    ...(!hasRemoved ? { removed: diffFile.removed } : {}),
  }
}
