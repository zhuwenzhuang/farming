import type { TerminalPreviewCell, TerminalPreviewSnapshot } from '../types/agent.ts'
import { stripAnsi } from './format.ts'

const DEFAULT_CHAR_ASPECT_RATIO = 0.62
const DEFAULT_LINE_HEIGHT_RATIO = 1.2

const ATTR_BOLD = 0x01
const ATTR_ITALIC = 0x02
const ATTR_UNDERLINE = 0x04
const ATTR_DIM = 0x08
const ATTR_INVERSE = 0x10
const ATTR_INVISIBLE = 0x20
const ATTR_STRIKETHROUGH = 0x40

function escapeHtml(text: string) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function paletteIndexToCss(index: number) {
  const ansi16 = [
    '#000000', '#cd3131', '#0dbc79', '#e5e510',
    '#2472c8', '#bc3fbc', '#11a8cd', '#57606a',
    '#666666', '#f14c4c', '#23d18b', '#f5f543',
    '#3b8eea', '#d670d6', '#29b8db', '#24292f',
  ]

  if (index >= 0 && index < ansi16.length) {
    return ansi16[index]
  }

  if (index >= 16 && index <= 231) {
    const offset = index - 16
    const r = Math.floor(offset / 36)
    const g = Math.floor((offset % 36) / 6)
    const b = offset % 6
    const level = [0, 95, 135, 175, 215, 255]
    return `rgb(${level[r]}, ${level[g]}, ${level[b]})`
  }

  if (index >= 232 && index <= 255) {
    const level = 8 + (index - 232) * 10
    return `rgb(${level}, ${level}, ${level})`
  }

  return ''
}

function colorToCss(color?: number) {
  if (color === undefined || color < 0) return ''
  if (color <= 255) return paletteIndexToCss(color)

  const r = (color >> 16) & 0xff
  const g = (color >> 8) & 0xff
  const b = color & 0xff
  return `rgb(${r}, ${g}, ${b})`
}

function getCellStyle(cell: TerminalPreviewCell, isCursor: boolean) {
  const classes = ['terminal-char']
  const styles: string[] = []
  const attrs = cell.attributes || 0

  let fg = colorToCss(cell.fg)
  let bg = colorToCss(cell.bg)

  if (attrs & ATTR_INVERSE) {
    const nextFg = bg || 'var(--theme-panel-screen-bg, #0a0a0a)'
    const nextBg = fg || 'var(--theme-fg, #00ff00)'
    fg = nextFg
    bg = nextBg
  }

  if (fg) {
    styles.push(`color:${fg}`)
  }
  if (bg && !isCursor) {
    styles.push(`background-color:${bg}`)
  }

  if (attrs & ATTR_BOLD) classes.push('bold')
  if (attrs & ATTR_ITALIC) classes.push('italic')
  if (attrs & ATTR_UNDERLINE) classes.push('underline')
  if (attrs & ATTR_DIM) classes.push('dim')
  if (attrs & ATTR_STRIKETHROUGH) classes.push('strikethrough')
  if (attrs & ATTR_INVISIBLE) styles.push('opacity:0')
  if (isCursor) classes.push('cursor')

  return {
    className: classes.join(' '),
    style: styles.join(';'),
  }
}

export function buildTerminalPreviewLines(text: string, rows: number) {
  const normalized = stripAnsi(text || '').replace(/\r/g, '')
  const lines = normalized.split('\n')

  if (rows > 0) {
    return lines.slice(-rows)
  }

  return lines.length > 0 ? lines : ['']
}

export function calculateTerminalPreviewFontSize(
  width: number,
  height: number,
  cols: number,
  rows: number,
) {
  if (width <= 0 || height <= 0) return 10

  const safeCols = Math.max(cols, 1)
  const safeRows = Math.max(rows, 1)
  const byWidth = width / (safeCols * DEFAULT_CHAR_ASPECT_RATIO)
  const byHeight = height / (safeRows * DEFAULT_LINE_HEIGHT_RATIO)

  return Math.max(4, Math.min(16, Math.min(byWidth, byHeight)))
}

export function normalizeTerminalPreviewSnapshot(
  snapshot: TerminalPreviewSnapshot | null | undefined,
) {
  if (!snapshot) return null

  const rows = Math.max(snapshot.rows || 0, snapshot.cells.length, 1)
  const cells = Array.from({ length: rows }, (_unused, index) => {
    const row = snapshot.cells[index]
    return row && row.length > 0 ? row : [{ char: ' ', width: 1 }]
  })

  return {
    ...snapshot,
    rows,
    cells,
  }
}

export function renderTerminalPreviewLine(cells: TerminalPreviewCell[], cursorCol = -1) {
  let html = ''
  let currentChars = ''
  let currentClassName = ''
  let currentStyle = ''
  let column = 0

  const flush = () => {
    if (!currentChars) return
    const escapedChars = escapeHtml(currentChars)
    const styleAttribute = currentStyle ? ` style="${currentStyle}"` : ''
    html += `<span class="${currentClassName}"${styleAttribute}>${escapedChars}</span>`
    currentChars = ''
  }

  for (const cell of cells) {
    if (cell.width === 0) continue

    const { className, style } = getCellStyle(cell, column === cursorCol)
    if (className !== currentClassName || style !== currentStyle) {
      flush()
      currentClassName = className
      currentStyle = style
    }

    currentChars += cell.char
    column += cell.width
  }

  flush()
  return html || '<span class="terminal-char">&nbsp;</span>'
}
