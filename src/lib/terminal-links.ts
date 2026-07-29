import { LinkComputer } from 'monaco-editor/esm/vs/editor/common/languages/linkComputer.js'
import {
  detectTerminalPathLinks,
  type ParsedTerminalPathLink,
} from './terminal-link-parsing'

export interface TerminalPathOpenTarget {
  path: string
  lineNumber?: number
  column?: number
  endLineNumber?: number
  endColumn?: number
  globalRoot?: boolean
  exactExternal?: boolean
}

export interface TerminalLinkMatch {
  kind: 'url' | 'path' | 'search'
  startIndex: number
  length: number
  text: string
  pathTarget?: TerminalPathOpenTarget
}

export interface TerminalLinkHoverTarget {
  kind: 'url' | 'path' | 'search'
  text: string
  pathTarget?: TerminalPathOpenTarget
}

interface TerminalLinkLogicalLine {
  startRow: number
  cols: number
}

const MAX_TERMINAL_URL_LENGTH = 2048
const MAX_TERMINAL_PATH_LINE_LENGTH = 2000
const MAX_TERMINAL_PATH_LENGTH = 1024
const MAX_TERMINAL_PATH_LINKS_PER_LINE = 10
const MAX_TERMINAL_MULTILINE_SCAN_LINES = 100
const MAX_TERMINAL_SEARCH_WORD_LENGTH = 100
const TERMINAL_WORD_SEPARATOR_PATTERN = /[ ()[\]{}',"`─‘’“”|\uE0B0-\uE0BF]/gu
const TERMINAL_PATH_EXTENSIONLESS_NAMES = new Set([
  'Dockerfile',
  'Gemfile',
  'LICENSE',
  'Makefile',
  'README',
])

// VS Code applies these only when its primary local-link parser found no
// resolvable candidates. They intentionally cover diagnostics whose paths may
// contain spaces.
const TERMINAL_PATH_STRONG_FALLBACK_MATCHERS = [
  /^ *File (?<link>"(?<path>.+)"(?:, line (?<line>\d+)(?:, (?:col(?:umn)?|character) (?<col>\d+))?)?)/,
  /^ +FILE +(?<link>(?<path>.+)(?::(?<line>\d+)(?::(?<col>\d+))?)?)/,
  /^(?:PS\s+)?(?<link>(?<path>[^>]+))>/,
]
const TERMINAL_PATH_SPACE_DIAGNOSTIC_MATCHERS = [
  /^(?<link>(?<path>.+)\((?<line>\d+)(?:, ?(?<col>\d+))?\)) ?:/,
  /^(?<link>(?<path>.+):(?<line>\d+)(?::(?<col>\d+))?) ?:/,
]
const TERMINAL_PATH_WHOLE_LINE_FALLBACK = /^ *(?<link>(?<path>.+))/

export function isValidTerminalUrl(url: string) {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

function computeTerminalUrlLinkMatches(lineText: string): TerminalLinkMatch[] {
  const links = LinkComputer.computeLinks({
    getLineCount: () => 1,
    getLineContent: () => lineText,
  })
  const matches: TerminalLinkMatch[] = []
  for (const link of links) {
    const text = String(link.url || '')
    if (text.length > MAX_TERMINAL_URL_LENGTH || !isValidTerminalUrl(text)) continue
    matches.push({
      kind: 'url',
      startIndex: link.range.startColumn - 1,
      length: link.range.endColumn - link.range.startColumn,
      text,
    })
  }
  return matches
}

function hasFileLikeSignal(filePath: string) {
  const basename = filePath.split(/[\\/]/).filter(Boolean).pop() || filePath
  return filePath.includes('/') ||
    filePath.includes('\\') ||
    /^[A-Za-z]:/.test(filePath) ||
    basename.includes('.') ||
    TERMINAL_PATH_EXTENSIONLESS_NAMES.has(basename) ||
    /^[A-Z][A-Za-z0-9_-]*file$/.test(basename)
}

function isLikelyTerminalPathTarget(filePath: string) {
  if (!filePath) return false
  if (filePath.length > MAX_TERMINAL_PATH_LENGTH) return false
  if (filePath === '.' || filePath === '..') return false
  return hasFileLikeSignal(filePath)
}

function fileUrlToTerminalPath(rawPath: string) {
  if (!rawPath.startsWith('file://')) return rawPath
  try {
    const uri = new URL(rawPath)
    let filePath = decodeURIComponent(uri.pathname)
    if (uri.hostname) filePath = `//${uri.hostname}${filePath}`
    if (/^\/[A-Za-z]:\//.test(filePath)) filePath = filePath.slice(1)
    return filePath
  } catch {
    return rawPath
  }
}

function normalizeTerminalPathTarget(rawPath: string, lineText: string) {
  let filePath = fileUrlToTerminalPath(rawPath).replace(/^\.\/+/, '')
  if (
    /^\s*(?:---|\+\+\+)\s+[ab]\//.test(lineText) ||
    /^\s*diff --git\s+(?:a|b)\//.test(lineText)
  ) {
    filePath = filePath.replace(/^[ab]\//, '')
  }
  return filePath
}

function terminalPathMatchFromParsedLink(
  lineText: string,
  parsedLink: ParsedTerminalPathLink,
): TerminalLinkMatch | null {
  const filePath = normalizeTerminalPathTarget(parsedLink.path.text, lineText)
  if (!isLikelyTerminalPathTarget(filePath)) return null

  const startIndex = parsedLink.prefix?.index ?? parsedLink.path.index
  const endIndex = parsedLink.suffix
    ? parsedLink.suffix.range.index + parsedLink.suffix.range.text.length
    : parsedLink.path.index + parsedLink.path.text.length
  return {
    kind: 'path',
    startIndex,
    length: endIndex - startIndex,
    text: lineText.slice(startIndex, endIndex),
    pathTarget: {
      path: filePath,
      ...(parsedLink.suffix?.lineNumber !== undefined
        ? { lineNumber: parsedLink.suffix.lineNumber }
        : {}),
      ...(parsedLink.suffix?.column !== undefined
        ? { column: parsedLink.suffix.column }
        : {}),
      ...(parsedLink.suffix?.endLineNumber !== undefined
        ? { endLineNumber: parsedLink.suffix.endLineNumber }
        : {}),
      ...(parsedLink.suffix?.endColumn !== undefined
        ? { endColumn: parsedLink.suffix.endColumn }
        : {}),
    },
  }
}

function terminalPathFallbackMatch(lineText: string, matchers: readonly RegExp[]): TerminalLinkMatch | null {
  for (const matcher of matchers) {
    const match = lineText.match(matcher)
    const groups = match?.groups
    const link = groups?.link
    const rawPath = groups?.path
    if (!match || !link || !rawPath || link.length > MAX_TERMINAL_PATH_LENGTH) continue

    const filePath = normalizeTerminalPathTarget(rawPath, lineText)
    if (!isLikelyTerminalPathTarget(filePath)) continue
    const lineNumber = groups?.line ? Number.parseInt(groups.line, 10) : undefined
    const column = groups?.col ? Number.parseInt(groups.col, 10) : undefined
    if (lineNumber !== undefined && lineNumber <= 0) continue
    if (column !== undefined && column <= 0) continue

    const startIndex = match.index === undefined
      ? lineText.indexOf(link)
      : match.index + match[0].indexOf(link)
    return {
      kind: 'path',
      startIndex,
      length: link.length,
      text: link,
      pathTarget: {
        path: filePath,
        ...(lineNumber !== undefined ? { lineNumber } : {}),
        ...(column !== undefined ? { column } : {}),
      },
    }
  }
  return null
}

export function collectTerminalPathLinkMatches(lineText: string): TerminalLinkMatch[] {
  if (!lineText || lineText.length > MAX_TERMINAL_PATH_LINE_LENGTH) return []

  // Farming resolves candidates in the caller after this synchronous lexical
  // pass. Prefer VS Code's diagnostic fallbacks up front so a quoted path with
  // spaces is not split into two weaker path candidates before validation.
  const strongFallback = terminalPathFallbackMatch(lineText, TERMINAL_PATH_STRONG_FALLBACK_MATCHERS)
  if (strongFallback) return [strongFallback]
  const spaceDiagnosticFallback = terminalPathFallbackMatch(lineText, TERMINAL_PATH_SPACE_DIAGNOSTIC_MATCHERS)
  if (spaceDiagnosticFallback?.pathTarget?.path.match(/\s/)) return [spaceDiagnosticFallback]

  const parsedMatches: TerminalLinkMatch[] = []
  for (const parsedLink of detectTerminalPathLinks(lineText)) {
    if (parsedMatches.length >= MAX_TERMINAL_PATH_LINKS_PER_LINE) break
    const match = terminalPathMatchFromParsedLink(lineText, parsedLink)
    if (!match) continue
    if (parsedMatches.some(existing => rangesOverlap(
      match.startIndex,
      match.length,
      existing.startIndex,
      existing.length,
    ))) {
      continue
    }
    parsedMatches.push(match)
  }

  if (parsedMatches.length > 0) return parsedMatches.sort((a, b) => a.startIndex - b.startIndex)
  const fallback = terminalPathFallbackMatch(lineText, [TERMINAL_PATH_WHOLE_LINE_FALLBACK])
  return fallback ? [fallback] : []
}

export function collectTerminalMultiLinePathLinkMatches(
  lineText: string,
  previousLogicalLines: readonly string[],
): TerminalLinkMatch[] {
  if (!lineText || lineText.length > MAX_TERMINAL_PATH_LINE_LENGTH) return []

  const lineNumberMatch = lineText.match(/^ *(?<link>(?<line>\d+):(?<col>\d+)?)/)
  if (lineNumberMatch?.groups?.link && lineNumberMatch.groups.line) {
    const possiblePath = previousLogicalLines
      .slice(0, MAX_TERMINAL_MULTILINE_SCAN_LINES)
      .find(previousLine => !/^\s*\d/.test(previousLine))
      ?.trim()
    const filePath = possiblePath ? normalizeTerminalPathTarget(possiblePath, possiblePath) : ''
    if (isLikelyTerminalPathTarget(filePath)) {
      const lineNumber = Number.parseInt(lineNumberMatch.groups.line, 10)
      const column = lineNumberMatch.groups.col
        ? Number.parseInt(lineNumberMatch.groups.col, 10)
        : 1
      if (lineNumber > 0 && column > 0) {
        const startIndex = lineNumberMatch.index === undefined
          ? lineText.indexOf(lineNumberMatch.groups.link)
          : lineNumberMatch.index + lineNumberMatch[0].indexOf(lineNumberMatch.groups.link)
        return [{
          kind: 'path',
          startIndex,
          length: lineNumberMatch.groups.link.length,
          text: lineNumberMatch.groups.link,
          pathTarget: { path: filePath, lineNumber, column },
        }]
      }
    }
  }

  const gitHunkMatch = lineText.match(/^(?<link>@@ .+ \+(?<line>\d+),(?<count>\d+) @@)/)
  if (!gitHunkMatch?.groups?.link || !gitHunkMatch.groups.line) return []
  const pathMatch = previousLogicalLines
    .slice(0, MAX_TERMINAL_MULTILINE_SCAN_LINES)
    .map(previousLine => previousLine.match(/\+\+\+ b\/(?<path>.+)/))
    .find(Boolean)
  const filePath = pathMatch?.groups?.path
    ? normalizeTerminalPathTarget(pathMatch.groups.path, pathMatch.groups.path)
    : ''
  if (!isLikelyTerminalPathTarget(filePath)) return []

  const lineNumber = Number.parseInt(gitHunkMatch.groups.line, 10)
  const count = gitHunkMatch.groups.count
    ? Number.parseInt(gitHunkMatch.groups.count, 10)
    : 0
  if (lineNumber <= 0 || count < 0) return []
  return [{
    kind: 'path',
    startIndex: gitHunkMatch.index ?? 0,
    length: gitHunkMatch.groups.link.length,
    text: gitHunkMatch.groups.link,
    pathTarget: {
      path: filePath,
      lineNumber,
      column: 1,
      ...(count > 0 ? { endLineNumber: lineNumber + count } : {}),
    },
  }]
}

export function parseTerminalPathTargetAtColumn(lineText: string, col: number): TerminalPathOpenTarget | null {
  return parseTerminalPathLinkAtColumn(lineText, col)?.pathTarget ?? null
}

export function parseTerminalFileTargetAtColumn(lineText: string, col: number): TerminalPathOpenTarget | null {
  const target = parseTerminalPathLinkAtColumn(lineText, col)?.pathTarget
  return target?.lineNumber ? null : target ?? null
}

export function parseTerminalPathLinkAtColumn(lineText: string, col: number): TerminalLinkMatch | null {
  return collectTerminalPathLinkMatches(lineText).find(match => (
    col >= match.startIndex && col < match.startIndex + match.length
  )) ?? null
}

export function terminalTextColumnAtPixelOffset(offsetX: number, cellWidth: number, textLength: number) {
  if (!Number.isFinite(offsetX) || !Number.isFinite(cellWidth) || !Number.isFinite(textLength)) return null
  if (cellWidth <= 0 || textLength <= 0) return null
  const col = Math.floor(offsetX / cellWidth)
  return col >= 0 && col < textLength ? col : null
}

function rangesOverlap(aStart: number, aLength: number, bStart: number, bLength: number) {
  const aEnd = aStart + aLength
  const bEnd = bStart + bLength
  return aStart < bEnd && bStart < aEnd
}

export function trimTerminalUrl(rawUrl: string) {
  const trimmed = rawUrl.trim()
  return computeTerminalUrlLinkMatches(trimmed)
    .find(match => match.startIndex === 0)?.text ?? trimmed
}

export function parseTerminalUrlAtColumn(lineText: string, col: number) {
  return computeTerminalUrlLinkMatches(lineText).find(match => (
    col >= match.startIndex && col < match.startIndex + match.length
  ))?.text ?? null
}

export function collectTerminalUrlLinkMatches(lineText: string): TerminalLinkMatch[] {
  return computeTerminalUrlLinkMatches(lineText)
}

export function collectTerminalSearchLinkMatches(lineText: string): TerminalLinkMatch[] {
  if (!lineText || lineText.length > MAX_TERMINAL_PATH_LINE_LENGTH) return []
  const matches: TerminalLinkMatch[] = []
  let startIndex = 0
  TERMINAL_WORD_SEPARATOR_PATTERN.lastIndex = 0
  for (;;) {
    const separator = TERMINAL_WORD_SEPARATOR_PATTERN.exec(lineText)
    const endIndex = separator?.index ?? lineText.length
    let text = lineText.slice(startIndex, endIndex)
    let length = text.length
    if (text.endsWith(':')) {
      text = text.slice(0, -1)
      length -= 1
    }
    if (text && text.length <= MAX_TERMINAL_SEARCH_WORD_LENGTH) {
      matches.push({
        kind: 'search',
        startIndex,
        length,
        text,
      })
    }
    if (!separator) break
    startIndex = separator.index + separator[0].length
  }
  return matches
}

export function parseTerminalSearchAtColumn(lineText: string, col: number) {
  return collectTerminalSearchLinkMatches(lineText).find(match => (
    col >= match.startIndex && col < match.startIndex + match.length
  ))?.text ?? null
}

export function collectTerminalLinkMatches(
  lineText: string,
  includePaths: boolean,
  includeSearch = false,
): TerminalLinkMatch[] {
  const urlMatches = collectTerminalUrlLinkMatches(lineText)
  const pathMatches = includePaths
    ? collectTerminalPathLinkMatches(lineText).filter(pathMatch => (
        !urlMatches.some(urlMatch => rangesOverlap(pathMatch.startIndex, pathMatch.length, urlMatch.startIndex, urlMatch.length))
      ))
    : []
  const claimedMatches = [...urlMatches, ...pathMatches]
  const searchMatches = includeSearch
    ? collectTerminalSearchLinkMatches(lineText).filter(searchMatch => (
        !claimedMatches.some(match => rangesOverlap(
          searchMatch.startIndex,
          searchMatch.length,
          match.startIndex,
          match.length,
        ))
      ))
    : []
  return [...claimedMatches, ...searchMatches].sort((a, b) => a.startIndex - b.startIndex)
}

export function terminalLinkMatchRange(match: TerminalLinkMatch, logicalLine: TerminalLinkLogicalLine) {
  const startIndex = Math.max(0, match.startIndex)
  const endIndex = Math.max(startIndex, match.startIndex + match.length - 1)
  const startRow = logicalLine.startRow + Math.floor(startIndex / logicalLine.cols)
  const endRow = logicalLine.startRow + Math.floor(endIndex / logicalLine.cols)
  return {
    start: {
      x: (startIndex % logicalLine.cols) + 1,
      y: startRow + 1,
    },
    end: {
      x: (endIndex % logicalLine.cols) + 1,
      y: endRow + 1,
    },
  }
}
