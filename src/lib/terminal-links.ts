export interface TerminalPathOpenTarget {
  path: string
  lineNumber?: number
  column?: number
  endColumn?: number
}

export interface TerminalLinkMatch {
  kind: 'url' | 'path'
  startIndex: number
  length: number
  text: string
  pathTarget?: TerminalPathOpenTarget
}

export interface TerminalLinkHoverTarget {
  kind: 'url' | 'path'
  text: string
  pathTarget?: TerminalPathOpenTarget
}

interface TerminalLinkLogicalLine {
  startRow: number
  cols: number
}

const TERMINAL_PATH_TARGET_PATTERN = /(^|[\s"'`([{<])((?:\/|~\/|\.{1,2}\/)?[A-Za-z0-9_@.+~=-][^\s"'`<>{}()[\],;:]*(?:\/[^\s"'`<>{}()[\],;:]+)*):(\d+)(?::(\d+))?/g
const TERMINAL_FILE_TARGET_PATTERN = /(^|[\s"'`([{<])((?:\/|~\/|\.{1,2}\/)?[A-Za-z0-9_@.+~=-][^\s"'`<>{}()[\],;:]*(?:\/[^\s"'`<>{}()[\],;:]+)*)(?=$|[\s"'`)\]}>.,;:])/g
const TERMINAL_URL_PATTERN = /\bhttps?:\/\/[^\s<>"'`]+/g
const TERMINAL_URL_CONTINUATION_PATTERN = /^[A-Za-z0-9%/?#&=._~:+@!$'()*+,;-]+/
const TERMINAL_URL_STRONG_CONTINUATION_PATTERN = /^(?:[0-9A-Fa-f]{1,2})?%[0-9A-Fa-f]{2}|^[/?#&=._~:+@!$'()*+,;-]/
const TERMINAL_PATH_EXTENSIONLESS_NAMES = new Set([
  'Dockerfile',
  'Gemfile',
  'LICENSE',
  'Makefile',
  'README',
])

export function isValidTerminalUrl(url: string) {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

function hasFileLikeSignal(filePath: string) {
  const basename = filePath.split('/').filter(Boolean).pop() || filePath
  return filePath.includes('/') ||
    basename.includes('.') ||
    TERMINAL_PATH_EXTENSIONLESS_NAMES.has(basename) ||
    /^[A-Z][A-Za-z0-9_-]*file$/.test(basename)
}

function isLikelyTerminalPathTarget(filePath: string) {
  if (!filePath || filePath.includes('://')) return false
  if (filePath === '.' || filePath === '..') return false
  return hasFileLikeSignal(filePath)
}

export function parseTerminalPathTargetAtColumn(lineText: string, col: number): TerminalPathOpenTarget | null {
  TERMINAL_PATH_TARGET_PATTERN.lastIndex = 0

  for (;;) {
    const match = TERMINAL_PATH_TARGET_PATTERN.exec(lineText)
    if (!match) return null

    const prefix = match[1] || ''
    const rawPath = match[2] || ''
    const lineTextValue = match[3] || ''
    const columnTextValue = match[4] || ''
    const matchedTarget = `${rawPath}:${lineTextValue}${columnTextValue ? `:${columnTextValue}` : ''}`
    const targetStart = match.index + prefix.length
    const targetEnd = targetStart + matchedTarget.length
    if (col < targetStart || col >= targetEnd) continue

    const filePath = rawPath.replace(/^\.\/+/, '')
    if (!isLikelyTerminalPathTarget(filePath)) return null

    const lineNumber = Number(lineTextValue)
    const column = columnTextValue ? Number(columnTextValue) : undefined
    if (!Number.isFinite(lineNumber) || lineNumber <= 0) return null
    if (column !== undefined && (!Number.isFinite(column) || column <= 0)) return null

    return {
      path: filePath,
      lineNumber,
      ...(column !== undefined ? { column } : {}),
    }
  }
}

export function parseTerminalFileTargetAtColumn(lineText: string, col: number): TerminalPathOpenTarget | null {
  TERMINAL_FILE_TARGET_PATTERN.lastIndex = 0

  for (;;) {
    const match = TERMINAL_FILE_TARGET_PATTERN.exec(lineText)
    if (!match) return null

    const prefix = match[1] || ''
    const rawPath = match[2] || ''
    const targetStart = match.index + prefix.length
    const targetEnd = targetStart + rawPath.length
    if (col < targetStart || col >= targetEnd) continue

    const filePath = rawPath.replace(/^\.\/+/, '')
    if (!isLikelyTerminalPathTarget(filePath)) return null
    return { path: filePath }
  }
}

export function collectTerminalPathLinkMatches(lineText: string): TerminalLinkMatch[] {
  const matches: TerminalLinkMatch[] = []
  TERMINAL_PATH_TARGET_PATTERN.lastIndex = 0

  for (;;) {
    const match = TERMINAL_PATH_TARGET_PATTERN.exec(lineText)
    if (!match) break

    const prefix = match[1] || ''
    const rawPath = match[2] || ''
    const lineTextValue = match[3] || ''
    const columnTextValue = match[4] || ''
    const targetText = `${rawPath}:${lineTextValue}${columnTextValue ? `:${columnTextValue}` : ''}`
    const startIndex = match.index + prefix.length
    const filePath = rawPath.replace(/^\.\/+/, '')
    const lineNumber = Number(lineTextValue)
    const column = columnTextValue ? Number(columnTextValue) : undefined
    if (
      !isLikelyTerminalPathTarget(filePath) ||
      !Number.isFinite(lineNumber) ||
      lineNumber <= 0 ||
      (column !== undefined && (!Number.isFinite(column) || column <= 0))
    ) {
      continue
    }

    matches.push({
      kind: 'path',
      startIndex,
      length: targetText.length,
      text: targetText,
      pathTarget: {
        path: filePath,
        lineNumber,
        ...(column !== undefined ? { column } : {}),
      },
    })
  }

  TERMINAL_FILE_TARGET_PATTERN.lastIndex = 0
  for (;;) {
    const match = TERMINAL_FILE_TARGET_PATTERN.exec(lineText)
    if (!match) break

    const prefix = match[1] || ''
    const rawPath = match[2] || ''
    const startIndex = match.index + prefix.length
    const filePath = rawPath.replace(/^\.\/+/, '')
    if (!isLikelyTerminalPathTarget(filePath)) continue
    if (matches.some(existing => rangesOverlap(startIndex, rawPath.length, existing.startIndex, existing.length))) {
      continue
    }
    matches.push({
      kind: 'path',
      startIndex,
      length: rawPath.length,
      text: rawPath,
      pathTarget: { path: filePath },
    })
  }

  return matches
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
  let url = rawUrl.trim()
  while (/[.,;:!?]$/.test(url)) {
    url = url.slice(0, -1)
  }

  for (;;) {
    const last = url[url.length - 1]
    if (last !== ')' && last !== ']' && last !== '}') break

    const first = last === ')' ? '(' : last === ']' ? '[' : '{'
    const firstCount = [...url].filter(char => char === first).length
    const lastCount = [...url].filter(char => char === last).length
    if (lastCount <= firstCount) break
    url = url.slice(0, -1)
  }

  return url
}

export function findTerminalUrlEndingAtLineEnd(lineText: string) {
  TERMINAL_URL_PATTERN.lastIndex = 0

  let found: { rawUrl: string; url: string } | null = null
  for (;;) {
    const match = TERMINAL_URL_PATTERN.exec(lineText)
    if (!match) break

    const rawUrl = match[0] || ''
    const rawEnd = match.index + rawUrl.length
    const url = trimTerminalUrl(rawUrl)
    if (rawEnd === lineText.length && isValidTerminalUrl(url)) {
      found = { rawUrl, url }
    }
  }

  return found
}

export function isTerminalUrlTrimmedAtLineEnd(match: { rawUrl: string; url: string }) {
  return match.rawUrl !== match.url
}

function isLineLikelyHardWrapped(lineText: string, cols: number) {
  return lineText.length >= Math.max(20, cols - 2)
}

function isUrlTextLikelySplitAtEnd(urlText: string) {
  return /%[0-9A-Fa-f]?$/.test(urlText) || /[/?#&=._~:+@!$'()*+,;%-]$/.test(urlText)
}

export function shouldReadUrlContinuation(previousLineText: string, previousUrlText: string, cols: number) {
  return isLineLikelyHardWrapped(previousLineText, cols) ||
    /%[0-9A-Fa-f]?$/.test(previousUrlText) ||
    isUrlTextLikelySplitAtEnd(previousUrlText) ||
    /[?#=&/][A-Za-z0-9%._~:+@!$'()*+,;-]*$/.test(previousUrlText)
}

export function readUrlContinuationPrefix(lineText: string, previousUrlText: string) {
  const trimmed = lineText.trimStart()
  if (!trimmed || /^https?:\/\//i.test(trimmed)) return null

  const match = TERMINAL_URL_CONTINUATION_PATTERN.exec(trimmed)
  const text = match?.[0] || ''
  if (!text) return null

  const wholeLineContinuation = trimmed === text
  const previousLooksSplitInsideUrlToken = /[?#=&/][A-Za-z0-9%._~:+@!$'()*+,;-]*$/.test(previousUrlText)
  const strongContinuation = TERMINAL_URL_STRONG_CONTINUATION_PATTERN.test(text) ||
    isUrlTextLikelySplitAtEnd(previousUrlText) ||
    (wholeLineContinuation && previousLooksSplitInsideUrlToken)
  if (!strongContinuation) return null

  return {
    text,
    startCol: lineText.length - trimmed.length,
  }
}

export function parseTerminalUrlAtColumn(lineText: string, col: number) {
  TERMINAL_URL_PATTERN.lastIndex = 0

  for (;;) {
    const match = TERMINAL_URL_PATTERN.exec(lineText)
    if (!match) return null

    const rawUrl = match[0] || ''
    const targetStart = match.index
    const targetEnd = targetStart + rawUrl.length
    if (col < targetStart || col >= targetEnd) continue

    const url = trimTerminalUrl(rawUrl)
    return isValidTerminalUrl(url) ? url : null
  }
}

export function collectTerminalUrlLinkMatches(lineText: string): TerminalLinkMatch[] {
  const matches: TerminalLinkMatch[] = []
  TERMINAL_URL_PATTERN.lastIndex = 0

  for (;;) {
    const match = TERMINAL_URL_PATTERN.exec(lineText)
    if (!match) break

    const rawUrl = match[0] || ''
    const url = trimTerminalUrl(rawUrl)
    if (!isValidTerminalUrl(url)) continue
    matches.push({
      kind: 'url',
      startIndex: match.index,
      length: url.length,
      text: url,
    })
  }

  return matches
}

export function collectTerminalLinkMatches(lineText: string, includePaths: boolean): TerminalLinkMatch[] {
  const urlMatches = collectTerminalUrlLinkMatches(lineText)
  const pathMatches = includePaths
    ? collectTerminalPathLinkMatches(lineText).filter(pathMatch => (
        !urlMatches.some(urlMatch => rangesOverlap(pathMatch.startIndex, pathMatch.length, urlMatch.startIndex, urlMatch.length))
      ))
    : []
  return [...urlMatches, ...pathMatches].sort((a, b) => a.startIndex - b.startIndex)
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
