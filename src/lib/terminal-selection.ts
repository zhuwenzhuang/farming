import { isValidTerminalUrl, trimTerminalUrl } from '@/lib/terminal-links'

export interface TerminalSelectionPoint {
  x: number
  y: number
}

export interface TerminalSelectionPosition {
  start: TerminalSelectionPoint
  end: TerminalSelectionPoint
}

export interface TerminalCellLike {
  getChars?: () => string
  getCode?: () => number
  getWidth?: () => number
}

export interface TerminalLineLike {
  length?: number
  isWrapped?: boolean
  getCell?: (col: number) => TerminalCellLike | undefined
}

export interface TerminalBufferLike {
  getLine?: (row: number) => TerminalLineLike | undefined
}

export interface TerminalSelectionHost {
  getSelection?: () => string
  getSelectionPosition?: () => TerminalSelectionPosition | undefined
  buffer?: {
    active?: TerminalBufferLike
  }
}

export function orderedSelection(position: TerminalSelectionPosition) {
  const start = { ...position.start }
  const end = { ...position.end }
  if (start.y > end.y || (start.y === end.y && start.x > end.x)) {
    return { start: end, end: start }
  }
  return { start, end }
}

export function readCellText(cell: TerminalCellLike | undefined) {
  if (!cell) return ''
  const width = typeof cell.getWidth === 'function' ? cell.getWidth() : 1
  if (width === 0) return ''

  if (typeof cell.getChars === 'function') {
    return cell.getChars()
  }

  const code = typeof cell.getCode === 'function' ? cell.getCode() : 0
  return code > 0 ? String.fromCodePoint(code) : ''
}

export function isZeroWidthCell(cell: TerminalCellLike | undefined) {
  return Boolean(cell && typeof cell.getWidth === 'function' && cell.getWidth() === 0)
}

export function readLineSelectionText(
  line: TerminalLineLike | undefined,
  startCol: number,
  endCol: number,
) {
  if (!line || typeof line.getCell !== 'function') return null

  let text = ''
  const maxCol = Math.max(startCol, endCol)
  for (let col = Math.max(0, startCol); col <= maxCol; col += 1) {
    const cell = line.getCell(col)
    if (!cell) continue

    text += readCellText(cell)
  }

  return text.trimEnd()
}

export function rebuildSelectionFromBuffer(position: TerminalSelectionPosition, buffer: TerminalBufferLike) {
  if (typeof buffer.getLine !== 'function') return null

  const { start, end } = orderedSelection(position)
  const rows: string[] = []
  for (let row = start.y; row <= end.y; row += 1) {
    const line = buffer.getLine(row)
    const startCol = row === start.y ? start.x : 0
    const fallbackEndCol = typeof line?.length === 'number' ? line.length - 1 : end.x
    const endCol = row === end.y ? end.x : fallbackEndCol
    const text = readLineSelectionText(line, startCol, endCol)
    if (text === null) return null

    const separator = row === start.y ? '' : line?.isWrapped ? '' : '\n'
    rows.push(`${separator}${text}`)
  }

  return rows.join('')
}

export function normalizeSoftWrapNewlines(
  selection: string,
  position: TerminalSelectionPosition,
  buffer: TerminalBufferLike,
) {
  if (!selection.includes('\n')) return selection

  const { start } = orderedSelection(position)
  const parts = selection.split('\n')
  if (parts.length <= 1) return selection

  return parts.reduce((text, part, index) => {
    if (index === 0) return part

    const currentRow = start.y + index
    const currentLine = buffer.getLine?.(currentRow)
    const separator = currentLine?.isWrapped ? '' : '\n'
    return `${text}${separator}${part}`
  }, '')
}

export function normalizeTerminalSelection(terminal: TerminalSelectionHost) {
  const selection = terminal.getSelection?.() || ''
  const position = terminal.getSelectionPosition?.()
  const buffer = terminal.buffer?.active
  if (!position || !buffer || typeof buffer.getLine !== 'function') {
    return selection
  }

  const rebuiltSelection = rebuildSelectionFromBuffer(position, buffer)
  if (rebuiltSelection !== null) {
    return rebuiltSelection
  }

  return normalizeSoftWrapNewlines(selection, position, buffer)
}

export function normalizeTerminalSelectionForCopy(selection: string) {
  if (!selection.includes('\n')) return selection

  const compacted = selection
    .split(/\r?\n/)
    .map((part, index) => index === 0 ? part.trimEnd() : part.trim())
    .join('')
  const url = trimTerminalUrl(compacted)
  return isValidTerminalUrl(url) ? url : selection
}

export function isContinuousSelectionText(value: string) {
  return value.length > 0 && !/\s/u.test(value)
}

export function selectionLength(start: { row: number; col: number }, end: { row: number; col: number }, cols: number) {
  return Math.max(1, ((end.row - start.row) * cols) + (end.col - start.col) + 1)
}
