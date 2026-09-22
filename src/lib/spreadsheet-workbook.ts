import * as XLSX from 'xlsx'

const MAX_SHEET_ROWS = 100_000
const MAX_SHEET_COLUMNS = 2_000
const MAX_SHEET_AREA = 1_000_000
const MAX_WORKBOOK_AREA = 1_500_000
const MAX_CELL_TEXT_LENGTH = 32_768

export interface SpreadsheetMergeRange {
  start: { column: number; row: number }
  end: { column: number; row: number }
}

export interface SpreadsheetFormula {
  formula: string
  missingCachedValue: boolean
}

export interface SpreadsheetSheetSnapshot {
  name: string
  hidden: boolean
  startRow: number
  startColumn: number
  rowCount: number
  columnCount: number
  rows: string[][]
  columnWidths: number[]
  merges: SpreadsheetMergeRange[]
  formulas: Record<string, SpreadsheetFormula>
  hiddenRows: number[]
  hiddenColumns: number[]
}

export interface SpreadsheetWorkbookSnapshot {
  sheets: SpreadsheetSheetSnapshot[]
  date1904: boolean
  warnings: SpreadsheetWarning[]
}

export type SpreadsheetWarning =
  | { kind: 'missing-formula-cache'; count: number }
  | { kind: 'hidden-content' }

function boundedCellText(value: unknown): string {
  const text = value == null ? '' : String(value)
  return text.length > MAX_CELL_TEXT_LENGTH
    ? `${text.slice(0, MAX_CELL_TEXT_LENGTH)}…`
    : text
}

function columnWidth(column: XLSX.ColInfo | undefined): number {
  if (!column) return 120
  if (Number.isFinite(column.wpx)) return Math.max(48, Math.min(480, Number(column.wpx)))
  if (Number.isFinite(column.wch)) return Math.max(48, Math.min(480, Math.round(Number(column.wch) * 8 + 16)))
  return 120
}

function cellDisplayValue(cell: XLSX.CellObject | undefined): string {
  if (!cell) return ''
  if (cell.w != null) return boundedCellText(cell.w)
  if (cell.f && cell.v == null) return '#NO CACHED VALUE'
  try {
    return boundedCellText(XLSX.utils.format_cell(cell))
  } catch {
    return boundedCellText(cell.v)
  }
}

function parseSheet(
  workbook: XLSX.WorkBook,
  name: string,
  index: number,
): SpreadsheetSheetSnapshot {
  const sheet = workbook.Sheets[name]
  if (!sheet) throw new Error(`Sheet “${name}” is missing.`)
  const decoded = sheet?.['!ref']
    ? XLSX.utils.decode_range(sheet['!ref'])
    : { s: { c: 0, r: 0 }, e: { c: -1, r: -1 } }
  const rowCount = decoded.e.r >= decoded.s.r ? decoded.e.r - decoded.s.r + 1 : 0
  const columnCount = decoded.e.c >= decoded.s.c ? decoded.e.c - decoded.s.c + 1 : 0
  const area = rowCount * columnCount
  if (
    rowCount > MAX_SHEET_ROWS
    || columnCount > MAX_SHEET_COLUMNS
    || area > MAX_SHEET_AREA
  ) {
    throw new Error(`Sheet “${name}” exceeds the preview limit (${rowCount} rows × ${columnCount} columns).`)
  }

  const rows: string[][] = []
  const formulas: Record<string, SpreadsheetFormula> = {}
  for (let row = decoded.s.r; row <= decoded.e.r; row += 1) {
    const values: string[] = []
    for (let column = decoded.s.c; column <= decoded.e.c; column += 1) {
      const address = XLSX.utils.encode_cell({ c: column, r: row })
      const cell = sheet[address]
      values.push(cellDisplayValue(cell))
      if (cell?.f) {
        formulas[address] = {
          formula: cell.f,
          missingCachedValue: cell.v == null,
        }
      }
    }
    rows.push(values)
  }

  const hiddenRows = (sheet?.['!rows'] ?? [])
    .flatMap((row, rowIndex) => row?.hidden ? [rowIndex - decoded.s.r] : [])
    .filter(row => row >= 0 && row < rowCount)
  const hiddenColumns = (sheet?.['!cols'] ?? [])
    .flatMap((column, columnIndex) => column?.hidden ? [columnIndex - decoded.s.c] : [])
    .filter(column => column >= 0 && column < columnCount)

  return {
    name,
    hidden: Boolean(workbook.Workbook?.Sheets?.[index]?.Hidden),
    startRow: decoded.s.r,
    startColumn: decoded.s.c,
    rowCount,
    columnCount,
    rows,
    columnWidths: Array.from({ length: columnCount }, (_, column) => (
      columnWidth(sheet?.['!cols']?.[column + decoded.s.c])
    )),
    merges: (sheet?.['!merges'] ?? []).map(merge => ({
      start: {
        column: merge.s.c - decoded.s.c,
        row: merge.s.r - decoded.s.r,
      },
      end: {
        column: merge.e.c - decoded.s.c,
        row: merge.e.r - decoded.s.r,
      },
    })).filter(merge => (
      merge.start.column >= 0
      && merge.start.row >= 0
      && merge.end.column < columnCount
      && merge.end.row < rowCount
    )),
    formulas,
    hiddenRows,
    hiddenColumns,
  }
}

export function parseSpreadsheetWorkbook(data: ArrayBuffer, fileName: string): SpreadsheetWorkbookSnapshot {
  const tabSeparated = fileName.toLowerCase().endsWith('.tsv')
  const workbook = XLSX.read(data, {
    type: 'array',
    cellFormula: true,
    cellNF: true,
    cellStyles: true,
    cellText: true,
    raw: true,
    ...(tabSeparated ? { FS: '\t' } : {}),
  })
  if (!workbook.SheetNames.length) throw new Error('The workbook does not contain any sheets.')

  const sheets: SpreadsheetSheetSnapshot[] = []
  let workbookArea = 0
  workbook.SheetNames.forEach((name, index) => {
    const sheet = parseSheet(workbook, name, index)
    workbookArea += sheet.rowCount * sheet.columnCount
    if (workbookArea > MAX_WORKBOOK_AREA) {
      throw new Error('The workbook exceeds the total preview cell limit.')
    }
    sheets.push(sheet)
  })

  const missingFormulaCaches = sheets.reduce((total, sheet) => (
    total + Object.values(sheet.formulas).filter(formula => formula.missingCachedValue).length
  ), 0)
  const warnings: SpreadsheetWarning[] = []
  if (missingFormulaCaches > 0) {
    warnings.push({ kind: 'missing-formula-cache', count: missingFormulaCaches })
  }
  if (sheets.some(sheet => sheet.hidden || sheet.hiddenRows.length > 0 || sheet.hiddenColumns.length > 0)) {
    warnings.push({ kind: 'hidden-content' })
  }

  return {
    sheets,
    date1904: Boolean(workbook.Workbook?.WBProps?.date1904),
    warnings,
  }
}

export function spreadsheetColumnLabel(column: number): string {
  let value = column + 1
  let label = ''
  while (value > 0) {
    value -= 1
    label = String.fromCharCode(65 + (value % 26)) + label
    value = Math.floor(value / 26)
  }
  return label
}

export function spreadsheetColumnIndex(label: string): number {
  let value = 0
  for (const character of label.toUpperCase()) {
    if (character < 'A' || character > 'Z') return -1
    value = value * 26 + character.charCodeAt(0) - 64
  }
  return value - 1
}

/** Quote the displayed snapshot without silently sampling or coercing cell values. */
export function spreadsheetSelectionQuote(
  workspace: string | undefined, path: string, sha1: string, sheet: SpreadsheetSheetSnapshot,
  range: { startColumn: number; endColumn: number; startRow: number; endRow: number },
): string | null {
  const { startColumn, endColumn, startRow, endRow } = range
  if (startColumn < 0 || startRow < 0 || endColumn >= sheet.columnCount || endRow >= sheet.rowCount
    || endColumn < startColumn || endRow < startRow || (endColumn - startColumn + 1) * (endRow - startRow + 1) > 200) return null
  const address = (column: number, row: number) => `${spreadsheetColumnLabel(sheet.startColumn + column)}${sheet.startRow + row + 1}`
  const label = `${address(startColumn, startRow)}:${address(endColumn, endRow)}`
  const rows = sheet.rows.slice(startRow, endRow + 1).map(row => row.slice(startColumn, endColumn + 1))
  const quote = `File: ${JSON.stringify(path)}\nWorkspace: ${JSON.stringify(workspace || '')}\nSHA-1: ${sha1}\nSheet: ${JSON.stringify(sheet.name)}\nRange: ${label}\nDisplayed cell values (JSON):\n${JSON.stringify(rows)}`
  return quote.length <= 5600 ? quote : null
}

/** Use the same selection snapshot for the inspector, copy and Chat quotes. */
export function spreadsheetSelectionText(
  sheet: SpreadsheetSheetSnapshot,
  range: { startColumn: number; endColumn: number; startRow: number; endRow: number },
): string {
  const { startColumn, endColumn, startRow, endRow } = range
  if (startColumn < 0 || startRow < 0 || endColumn >= sheet.columnCount || endRow >= sheet.rowCount
    || endColumn < startColumn || endRow < startRow) return ''
  const escapeCell = (value: string) => /["\t\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
  return sheet.rows.slice(startRow, endRow + 1)
    .map(row => row.slice(startColumn, endColumn + 1).map(escapeCell).join('\t')).join('\n')
}
