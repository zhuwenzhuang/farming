import type { TerminalPreviewSnapshot } from '@/types/agent'

export interface SessionDataPayload {
  session?: {
    output?: string
    outputSeq?: number | null
    renderOutput?: string
    previewSnapshot?: TerminalPreviewSnapshot | null
    previewCols?: number | null
    previewRows?: number | null
    cols?: number | null
    rows?: number | null
  } | string
  output?: string
  outputSeq?: number | null
  renderOutput?: string
  previewSnapshot?: TerminalPreviewSnapshot | null
  previewCols?: number | null
  previewRows?: number | null
  cols?: number | null
  rows?: number | null
}

export interface TerminalCursorPosition {
  x: number
  y: number
  cols: number
  rows: number
}

export interface SessionBootstrapState {
  output: string
  textOutput: string
  cursor: TerminalCursorPosition | null
  outputSeq: number | null
  cols: number | null
  rows: number | null
}

export function parseSessionOutput(data: SessionDataPayload) {
  if (data.session && typeof data.session === 'object') {
    return data.session.renderOutput ?? data.session.output ?? ''
  }
  if (typeof data.session === 'string') {
    return data.session
  }
  if (typeof data.renderOutput === 'string') {
    return data.renderOutput
  }
  return data.output ?? ''
}

export function parseSessionOutputSeq(data: SessionDataPayload) {
  const raw = data.session && typeof data.session === 'object'
    ? data.session.outputSeq
    : data.outputSeq
  const seq = Number(raw)
  return Number.isFinite(seq) && seq >= 0 ? seq : null
}

export function trimLeadingBlankBootstrapRows(output: string) {
  return output.replace(/^(?:[ \t]*\r?\n)+/, '')
}

export function countLeadingBlankBootstrapRows(output: string) {
  const lines = output.split(/\r?\n/)
  let count = 0
  for (let index = 0; index < lines.length - 1; index += 1) {
    if ((lines[index] ?? '').trim() !== '') break
    count += 1
  }
  return count
}

export function parseSessionSnapshot(data: SessionDataPayload): TerminalPreviewSnapshot | null {
  const snapshot = data.session && typeof data.session === 'object'
    ? data.session.previewSnapshot
    : data.previewSnapshot
  if (!snapshot || !Array.isArray(snapshot.cells)) return null
  return snapshot
}

function positiveInteger(value: unknown) {
  const n = Math.floor(Number(value))
  return Number.isFinite(n) && n > 0 ? n : null
}

export function parseSessionDimensions(data: SessionDataPayload) {
  const session = data.session && typeof data.session === 'object' ? data.session : null
  return {
    cols: positiveInteger(session?.previewCols ?? session?.cols ?? data.previewCols ?? data.cols),
    rows: positiveInteger(session?.previewRows ?? session?.rows ?? data.previewRows ?? data.rows),
  }
}

export function snapshotRowToText(row: TerminalPreviewSnapshot['cells'][number]) {
  return row.map(cell => cell.char || ' ').join('').replace(/[ \t]+$/g, '')
}

export function countLeadingBlankSnapshotRows(snapshot: TerminalPreviewSnapshot | null) {
  if (!snapshot) return 0
  let count = 0
  for (const row of snapshot.cells) {
    if (snapshotRowToText(row).trim() !== '') break
    count += 1
  }
  return count
}

export function sessionSnapshotToBootstrapText(snapshot: TerminalPreviewSnapshot | null) {
  if (!snapshot) return ''

  const rows = snapshot.cells.map(snapshotRowToText)
  while (rows.length > 0 && (rows[0] ?? '').trim() === '') {
    rows.shift()
  }
  while (rows.length > 0 && (rows[rows.length - 1] ?? '').trim() === '') {
    rows.pop()
  }

  return rows.join('\r\n')
}

export function normalizedBootstrapRows(output: string) {
  const rows = output.split(/\r?\n/).map(row => row.replace(/[ \t]+$/g, ''))
  while (rows.length > 0 && (rows[0] ?? '').trim() === '') {
    rows.shift()
  }
  while (rows.length > 0 && (rows[rows.length - 1] ?? '').trim() === '') {
    rows.pop()
  }
  return rows
}

export function bootstrapCursorMatchesOutput(output: string, snapshotOutput: string) {
  if (!output || !snapshotOutput) return false
  const outputRows = normalizedBootstrapRows(output)
  const snapshotRows = normalizedBootstrapRows(snapshotOutput)
  if (outputRows.length !== snapshotRows.length) return false
  return outputRows.every((row, index) => row === snapshotRows[index])
}

export function snapshotCursorPosition(snapshot: TerminalPreviewSnapshot | null): TerminalCursorPosition | null {
  if (!snapshot) return null
  const cursorX = Math.floor(Number(snapshot.cursorX))
  const cursorY = Math.floor(Number(snapshot.cursorY))
  const cols = Math.floor(Number(snapshot.cols))
  const rows = Math.floor(Number(snapshot.rows))
  if (!Number.isFinite(cursorX) || !Number.isFinite(cursorY)) return null
  if (!Number.isFinite(cols) || !Number.isFinite(rows) || cols <= 0 || rows <= 0) return null

  return {
    x: Math.max(0, Math.min(cols - 1, cursorX)),
    y: Math.max(0, Math.min(rows - 1, cursorY)),
    cols,
    rows,
  }
}

export function shiftSnapshotCursor(cursor: TerminalCursorPosition | null, removedLeadingRows: number) {
  if (!cursor || removedLeadingRows <= 0) return cursor
  return {
    ...cursor,
    y: Math.max(0, cursor.y - removedLeadingRows),
  }
}

export function sessionBootstrapStateFromPayload(data: SessionDataPayload): SessionBootstrapState {
  const snapshot = parseSessionSnapshot(data)
  const rawOutput = parseSessionOutput(data)
  const rawTextOutput = data.session && typeof data.session === 'object'
    ? data.session.output ?? ''
    : data.output ?? ''
  const trimmedOutput = trimLeadingBlankBootstrapRows(rawOutput)
  const trimmedTextOutput = trimLeadingBlankBootstrapRows(rawTextOutput)
  const snapshotOutput = sessionSnapshotToBootstrapText(snapshot)
  const dimensions = parseSessionDimensions(data)
  const removedLeadingRows = trimmedOutput
    ? countLeadingBlankBootstrapRows(rawOutput)
    : countLeadingBlankSnapshotRows(snapshot)
  const cursor = !trimmedOutput || bootstrapCursorMatchesOutput(trimmedOutput, snapshotOutput)
    ? shiftSnapshotCursor(snapshotCursorPosition(snapshot), removedLeadingRows)
    : null
  return {
    output: trimmedOutput || snapshotOutput,
    textOutput: trimmedTextOutput,
    cursor,
    outputSeq: parseSessionOutputSeq(data),
    cols: dimensions.cols,
    rows: dimensions.rows,
  }
}

export function isSequencedOutputCovered(outputSeq: number | null | undefined, checkpointSeq: number | null) {
  return typeof outputSeq === 'number'
    && Number.isFinite(outputSeq)
    && checkpointSeq !== null
    && outputSeq <= checkpointSeq
}
