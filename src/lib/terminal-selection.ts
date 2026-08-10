import { isValidTerminalUrl, trimTerminalUrl } from '@/lib/terminal-links'
import type { FarmingTerminal } from '@/lib/terminal-engine'
import { getTerminalVisibleBufferBase } from '@/lib/terminal-viewport'

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

type TerminalBuffer = NonNullable<NonNullable<FarmingTerminal['buffer']>['active']>

export interface TerminalSelectionCell {
  col: number
  row: number
}

export interface TerminalLogicalLine {
  text: string
  col: number
  startRow: number
  endRow: number
  bufferRow: number
  cols: number
  buffer: TerminalBuffer
}

interface TerminalSelectionControllerPorts {
  terminal: FarmingTerminal
  hostEl: HTMLElement
  cellMetrics: () => { width: number; height: number } | null
  screenRect: () => DOMRect | null
}

interface TerminalDragSelection {
  start: TerminalSelectionCell
  active: boolean
  moved: boolean
  pointerId?: number
}

/** Owns terminal selection identity, drag state, and buffer-to-text projection. */
export class TerminalSelectionController {
  readonly #ports: TerminalSelectionControllerPorts
  #selectionChangeDisposable: (() => void) | null = null
  #cachedSelection = ''
  #lastNonEmptySelection = ''
  #contextMenuSelection = ''
  #dragSelection: TerminalDragSelection | null = null

  constructor(ports: TerminalSelectionControllerPorts) {
    this.#ports = ports
  }

  install() {
    if (this.#selectionChangeDisposable) return false
    const subscription = this.#ports.terminal.onSelectionChange?.(() => this.sync())
    this.#selectionChangeDisposable = subscription ? () => subscription.dispose() : () => {}
    return true
  }

  dispose() {
    if (!this.#selectionChangeDisposable) return false
    this.#selectionChangeDisposable()
    this.#selectionChangeDisposable = null
    this.clear()
    return true
  }

  get cachedSelection() {
    return this.#cachedSelection
  }

  get lastNonEmptySelection() {
    return this.#lastNonEmptySelection
  }

  get contextMenuSelection() {
    return this.#contextMenuSelection
  }

  set contextMenuSelection(selection: string) {
    this.#contextMenuSelection = selection
  }

  sync() {
    this.#cachedSelection = normalizeTerminalSelection(this.#ports.terminal)
    if (this.#cachedSelection) {
      this.#lastNonEmptySelection = normalizeTerminalSelectionForCopy(this.#cachedSelection)
    }
    return this.#cachedSelection
  }

  clearTransient() {
    this.#contextMenuSelection = ''
    this.#lastNonEmptySelection = ''
  }

  clear() {
    this.#cachedSelection = ''
    this.#contextMenuSelection = ''
    this.#lastNonEmptySelection = ''
    this.#dragSelection = null
    this.#ports.terminal.clearTerminalSelection?.()
    this.#clearNativeSelection()
  }

  selectionForCopy(options: { includeNativeFallback?: boolean } = {}) {
    const terminal = this.#ports.terminal
    const selection = terminal.__farmingTerminalEngine === 'xterm'
      ? normalizeTerminalSelectionForCopy(terminal.getSelection() || '')
      : normalizeTerminalSelectionForCopy(normalizeTerminalSelection(terminal))
    if (selection) return selection
    if (terminal.__farmingTerminalEngine !== 'xterm' && options.includeNativeFallback) {
      return normalizeTerminalSelectionForCopy(this.#nativeSelection())
    }
    return ''
  }

  selectContinuousTextAtCell(col: number, row: number) {
    const terminal = this.#ports.terminal
    const buffer = terminal.buffer?.active
    const cols = terminal.cols || 80
    if (!buffer || typeof buffer.getLine !== 'function' || typeof terminal.select !== 'function') return ''

    const bufferRow = getTerminalVisibleBufferBase(terminal) + row
    const originText = this.#cellTextAt(buffer, bufferRow, col)
    if (!isContinuousSelectionText(originText)) return ''

    let start = { row: bufferRow, col }
    for (;;) {
      const previous = this.#moveLeft(buffer, start.row, start.col, cols)
      if (!previous || !isContinuousSelectionText(this.#cellTextAt(buffer, previous.row, previous.col))) break
      start = previous
    }
    if (/^[#$%>]$/u.test(this.#cellTextAt(buffer, start.row, start.col))) {
      const afterPrompt = this.#moveRight(buffer, start.row, start.col, cols)
      if (afterPrompt) start = afterPrompt
    }

    let end = { row: bufferRow, col }
    for (;;) {
      const next = this.#moveRight(buffer, end.row, end.col, cols)
      if (!next || !isContinuousSelectionText(this.#cellTextAt(buffer, next.row, next.col))) break
      end = next
    }

    terminal.select(start.col, start.row, selectionLength(start, end, cols))
    return this.sync()
  }

  selectCellRange(startCell: TerminalSelectionCell, endCell: TerminalSelectionCell) {
    const terminal = this.#ports.terminal
    const buffer = terminal.buffer?.active
    const cols = terminal.cols || 80
    if (!buffer || typeof terminal.select !== 'function') return ''

    const visibleBase = getTerminalVisibleBufferBase(terminal)
    const start = { row: visibleBase + startCell.row, col: startCell.col }
    const end = { row: visibleBase + endCell.row, col: endCell.col }
    const ordered = start.row < end.row || (start.row === end.row && start.col <= end.col)
      ? { start, end }
      : { start: end, end: start }
    terminal.select(
      ordered.start.col,
      ordered.start.row,
      selectionLength(ordered.start, ordered.end, cols),
    )
    return this.sync()
  }

  selectBuffer() {
    const terminal = this.#ports.terminal
    const buffer = terminal.buffer?.active
    const cols = terminal.cols || 80
    if (!buffer || typeof buffer.getLine !== 'function' || typeof terminal.select !== 'function') return ''
    const rowCount = typeof buffer.length === 'number'
      ? buffer.length
      : getTerminalVisibleBufferBase(terminal) + (terminal.rows || 1)
    const endRow = Math.max(0, rowCount - 1)
    const endCol = this.#lineLastColumn(buffer.getLine(endRow), cols)
    terminal.select(0, 0, selectionLength({ row: 0, col: 0 }, { row: endRow, col: endCol }, cols))
    return this.sync()
  }

  cellFromEvent(event: Pick<MouseEvent, 'clientX' | 'clientY'>): TerminalSelectionCell | null {
    const metrics = this.#ports.cellMetrics()
    const rect = this.#ports.screenRect()
    if (!metrics || !rect) return null
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) return null
    return {
      col: Math.max(0, Math.min(Math.floor((event.clientX - rect.left) / metrics.width), (this.#ports.terminal.cols || 1) - 1)),
      row: Math.max(0, Math.min(Math.floor((event.clientY - rect.top) / metrics.height), (this.#ports.terminal.rows || 1) - 1)),
    }
  }

  startDrag(event: MouseEvent | PointerEvent, mobile: boolean, pointerId?: number) {
    if (mobile || event.button !== 0 || event.ctrlKey || event.metaKey || event.altKey) return false
    const cell = this.cellFromEvent(event)
    if (!cell) return false
    this.#dragSelection = { start: cell, active: true, moved: false, pointerId }
    return true
  }

  updateDrag(event: MouseEvent | PointerEvent) {
    const drag = this.#dragSelection
    if (!drag?.active) return false
    if ('pointerId' in event && drag.pointerId !== undefined && event.pointerId !== drag.pointerId) return false
    const cell = this.cellFromEvent(event)
    if (!cell || (cell.col === drag.start.col && cell.row === drag.start.row && !drag.moved)) return false
    drag.moved = true
    this.selectCellRange(drag.start, cell)
    event.preventDefault()
    event.stopPropagation()
    return true
  }

  finishDrag(event: MouseEvent | PointerEvent) {
    const drag = this.#dragSelection
    if (!drag?.active) return false
    if ('pointerId' in event && drag.pointerId !== undefined && event.pointerId !== drag.pointerId) return false
    this.#dragSelection = null
    if (!drag.moved) return false
    this.sync()
    event.preventDefault()
    event.stopPropagation()
    return true
  }

  hasDrag() {
    return this.#dragSelection !== null
  }

  eventInsideSelection(event: MouseEvent) {
    const terminal = this.#ports.terminal
    const position = terminal.getSelectionPosition?.()
    if (!position || !terminal.getSelection?.()) return false
    const cell = this.cellFromEvent(event)
    if (!cell) return false
    const { start, end } = orderedSelection(position)
    const point = { x: cell.col, y: getTerminalVisibleBufferBase(terminal) + cell.row }
    if (point.y < start.y || point.y > end.y) return false
    if (point.y === start.y && point.x < start.x) return false
    if (point.y === end.y && point.x > end.x) return false
    return true
  }

  logicalLineAtCell(cell: TerminalSelectionCell): TerminalLogicalLine | null {
    const bufferRow = getTerminalVisibleBufferBase(this.#ports.terminal) + cell.row
    return this.#logicalLine(bufferRow, cell.col)
  }

  logicalLineAtBufferRow(bufferRow: number) {
    return this.#logicalLine(bufferRow, 0)
  }

  previousLogicalLines(beforeBufferRow: number, limit = 100) {
    const lines: string[] = []
    let row = beforeBufferRow - 1
    while (row >= 0 && lines.length < limit) {
      const logicalLine = this.logicalLineAtBufferRow(row)
      if (!logicalLine) break
      lines.push(logicalLine.text)
      row = logicalLine.startRow - 1
    }
    return lines
  }

  #logicalLine(bufferRow: number, cellCol: number): TerminalLogicalLine | null {
    const terminal = this.#ports.terminal
    const buffer = terminal.buffer?.active
    if (!buffer || typeof buffer.getLine !== 'function' || !Number.isFinite(bufferRow) || bufferRow < 0) return null
    const cols = terminal.cols || 80
    let startRow = bufferRow
    while (startRow > 0 && buffer.getLine(startRow)?.isWrapped) startRow -= 1
    let endRow = bufferRow
    while (buffer.getLine(endRow + 1)?.isWrapped) endRow += 1
    const segments: string[] = []
    for (let row = startRow; row <= endRow; row += 1) {
      segments.push(this.#lineText(buffer, row, cols, row === endRow))
    }
    return {
      text: segments.join('').trimEnd(),
      col: ((bufferRow - startRow) * cols) + cellCol,
      startRow,
      endRow,
      bufferRow,
      cols,
      buffer,
    }
  }

  #lineText(buffer: TerminalBuffer, row: number, fallbackCols: number, trimEnd = true) {
    const line = buffer.getLine(row)
    if (!line || typeof line.getCell !== 'function') return ''
    const colCount = Math.max(0, typeof line.length === 'number' ? line.length : fallbackCols)
    let text = ''
    for (let col = 0; col < colCount; col += 1) text += readCellText(line.getCell(col)) || ' '
    return trimEnd ? text.trimEnd() : text
  }

  #lineLastColumn(line: ReturnType<TerminalBuffer['getLine']>, fallbackCols: number) {
    return Math.max(0, (typeof line?.length === 'number' ? line.length : fallbackCols) - 1)
  }

  #cellTextAt(buffer: TerminalBuffer, row: number, col: number) {
    return readCellText(buffer.getLine(row)?.getCell?.(col))
  }

  #moveLeft(buffer: TerminalBuffer, row: number, col: number, cols: number) {
    if (col > 0) return { row, col: col - 1 }
    if (row <= 0 || !buffer.getLine(row)?.isWrapped) return null
    return { row: row - 1, col: this.#lineLastColumn(buffer.getLine(row - 1), cols) }
  }

  #moveRight(buffer: TerminalBuffer, row: number, col: number, cols: number) {
    const lastCol = this.#lineLastColumn(buffer.getLine(row), cols)
    if (col < lastCol) return { row, col: col + 1 }
    return buffer.getLine(row + 1)?.isWrapped ? { row: row + 1, col: 0 } : null
  }

  #nativeSelection() {
    const selection = window.getSelection?.()
    if (!selection || selection.isCollapsed) return ''
    const anchorNode = selection.anchorNode
    const focusNode = selection.focusNode
    if ((anchorNode && !this.#ports.hostEl.contains(anchorNode)) || (focusNode && !this.#ports.hostEl.contains(focusNode))) return ''
    return selection.toString()
  }

  #clearNativeSelection() {
    const selection = window.getSelection?.()
    if (!selection || selection.rangeCount === 0) return
    const anchorNode = selection.anchorNode
    const focusNode = selection.focusNode
    if ((anchorNode && !this.#ports.hostEl.contains(anchorNode)) || (focusNode && !this.#ports.hostEl.contains(focusNode))) return
    selection.removeAllRanges()
  }
}
