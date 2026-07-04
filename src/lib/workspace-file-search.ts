import type { WorkspaceFileSearchMatch } from './workspace-files'
import type { WorkspaceFileOpenTarget } from './workspace-open-files'

export const FUZZY_PATH_HIGHLIGHT_LIMIT = 6

export type { WorkspaceFileOpenTarget } from './workspace-open-files'

export interface WorkspaceFileJumpQuery {
  path: string
  lineNumber: number
  column?: number
}

export interface WorkspaceFileSearchOpenRequest {
  path: string
  target?: WorkspaceFileOpenTarget
}

export interface TextRange {
  start: number
  end: number
}

export function parseWorkspaceFileJumpQuery(query: string): WorkspaceFileJumpQuery | null {
  const value = query.trim().replace(/^\.\/+/, '')
  if (!value) return null

  const hashMatch = value.match(/^(.+?)#L(\d+)(?:C(\d+))?$/i)
  if (hashMatch) {
    return {
      path: hashMatch[1] || '',
      lineNumber: Number(hashMatch[2]),
      column: hashMatch[3] ? Number(hashMatch[3]) : undefined,
    }
  }

  const colonMatch = value.match(/^(.+?):(\d+)(?::(\d+))?$/)
  if (!colonMatch) return null
  return {
    path: colonMatch[1] || '',
    lineNumber: Number(colonMatch[2]),
    column: colonMatch[3] ? Number(colonMatch[3]) : undefined,
  }
}

export function targetForWorkspaceFileSearchMatch(match: WorkspaceFileSearchMatch): WorkspaceFileOpenTarget {
  const range = match.ranges[0]
  if (!range) return { lineNumber: match.lineNumber }
  return {
    lineNumber: match.lineNumber,
    column: range.start + 1,
    endColumn: Math.max(range.start + 1, range.end + 1),
  }
}

export function openRequestForWorkspaceFileSearchMatch(
  match: WorkspaceFileSearchMatch
): WorkspaceFileSearchOpenRequest {
  if (match.kind === 'path') return { path: match.path }
  return {
    path: match.path,
    target: targetForWorkspaceFileSearchMatch(match),
  }
}

export function openRequestForWorkspaceFileJumpQuery(query: string): WorkspaceFileSearchOpenRequest | null {
  const jump = parseWorkspaceFileJumpQuery(query)
  if (!jump) return null
  return {
    path: jump.path,
    target: {
      lineNumber: jump.lineNumber,
      column: jump.column,
    },
  }
}

export function workspaceFileSearchActiveOptionId({
  active,
  activeMatchIndex,
  jumpTarget,
  listboxId,
}: {
  active: boolean
  activeMatchIndex: number
  jumpTarget: WorkspaceFileJumpQuery | null
  listboxId: string
}) {
  if (!active) return undefined
  if (jumpTarget) return `${listboxId}-jump`
  return activeMatchIndex >= 0 ? `${listboxId}-${activeMatchIndex}` : undefined
}

export function queryTextRange(text: string, query: string): TextRange | null {
  const normalizedQuery = query.trim().replace(/^\.\/+/, '').toLowerCase()
  if (!text || !normalizedQuery) return null
  const index = text.toLowerCase().indexOf(normalizedQuery)
  if (index === -1) return null
  return { start: index, end: index + normalizedQuery.length }
}

function isPathWordBoundary(text: string, index: number) {
  if (index === 0) return true
  const previous = text[index - 1] ?? ''
  const current = text[index] ?? ''
  if (/[-_\s./\\]/.test(previous)) return true
  return /[a-z0-9]/.test(previous) && /[A-Z]/.test(current)
}

export function fuzzyTextRanges(text: string, normalizedQuery: string, boundariesOnly: boolean): TextRange[] {
  const ranges: TextRange[] = []
  let queryIndex = 0

  for (let textIndex = 0; textIndex < text.length && queryIndex < normalizedQuery.length; textIndex += 1) {
    if (boundariesOnly && !isPathWordBoundary(text, textIndex)) continue
    if (text[textIndex]?.toLowerCase() !== normalizedQuery[queryIndex]) continue
    ranges.push({ start: textIndex, end: textIndex + 1 })
    queryIndex += 1
  }

  return queryIndex === normalizedQuery.length ? ranges : []
}

export function fuzzyPathTextRanges(text: string, query: string): TextRange[] {
  const normalizedQuery = query.trim().replace(/^\.\/+/, '').toLowerCase()
  if (!text || !normalizedQuery || normalizedQuery.length > FUZZY_PATH_HIGHLIGHT_LIMIT) return []
  const boundaryRanges = fuzzyTextRanges(text, normalizedQuery, true)
  return boundaryRanges.length > 0 ? boundaryRanges : fuzzyTextRanges(text, normalizedQuery, false)
}

export function normalizeTextRanges(text: string, ranges: readonly TextRange[]): TextRange[] {
  const normalizedRanges: TextRange[] = []
  ranges
    .map(range => ({
      start: Math.max(0, Math.min(text.length, range.start)),
      end: Math.max(0, Math.min(text.length, range.end)),
    }))
    .filter(range => range.end > range.start)
    .sort((a, b) => a.start - b.start || a.end - b.end)
    .forEach(range => {
      const previous = normalizedRanges[normalizedRanges.length - 1]
      if (previous && range.start <= previous.end) {
        previous.end = Math.max(previous.end, range.end)
        return
      }
      normalizedRanges.push(range)
    })

  return normalizedRanges
}

export function pathSearchTextRanges(pathText: string, query: string): TextRange[] {
  const range = queryTextRange(pathText, query)
  return range ? [range] : fuzzyPathTextRanges(pathText, query)
}
