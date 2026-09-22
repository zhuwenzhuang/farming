import assert from 'node:assert/strict'
import * as XLSX from 'xlsx'
import {
  parseSpreadsheetWorkbook,
  spreadsheetSelectionQuote,
  spreadsheetSelectionText,
  spreadsheetColumnIndex,
  spreadsheetColumnLabel,
} from '../../src/lib/spreadsheet-workbook'

function workbookBytes(workbook: XLSX.WorkBook): ArrayBuffer {
  const bytes = XLSX.write(workbook, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer
  return bytes.slice(0)
}

const workbook = XLSX.utils.book_new()
const sheet = XLSX.utils.aoa_to_sheet([
  ['Identifier', 'Amount', 'Formula'],
  ['00123', 0.25, null],
  ['00456', 10, null],
])
sheet.B2.z = '0%'
sheet.C2 = { t: 'n', f: 'B2*100', v: 25 }
sheet.C3 = { t: 'n', f: 'B3*100' }
sheet['!merges'] = [XLSX.utils.decode_range('A1:B1')]
sheet['!rows'] = [{}, { hidden: true }]
sheet['!cols'] = [{ wch: 18 }, { hidden: true }]
XLSX.utils.book_append_sheet(workbook, sheet, 'Data')

const parsed = parseSpreadsheetWorkbook(workbookBytes(workbook), 'sample.xlsx')
assert.equal(parsed.sheets.length, 1)
assert.equal(parsed.sheets[0]?.name, 'Data')
assert.equal(parsed.sheets[0]?.rows[1]?.[0], '00123')
assert.equal(parsed.sheets[0]?.rows[1]?.[1], '25%')
assert.equal(parsed.sheets[0]?.rows[1]?.[2], '25')
assert.equal(parsed.sheets[0]?.rows[2]?.[2], '#NO CACHED VALUE')
assert.deepEqual(parsed.sheets[0]?.merges, [{
  start: { column: 0, row: 0 },
  end: { column: 1, row: 0 },
}])
assert.deepEqual(parsed.sheets[0]?.hiddenRows, [1])
assert.deepEqual(parsed.sheets[0]?.hiddenColumns, [1])
assert.equal(parsed.sheets[0]?.formulas.C2?.formula, 'B2*100')
assert.equal(parsed.sheets[0]?.formulas.C3?.missingCachedValue, true)
assert(parsed.warnings.some(warning => warning.kind === 'missing-formula-cache' && warning.count === 1))
assert(parsed.warnings.some(warning => warning.kind === 'hidden-content'))

const csv = new TextEncoder().encode('name\tvalue\nalpha\t1\n').buffer
const parsedTsv = parseSpreadsheetWorkbook(csv, 'sample.tsv')
assert.deepEqual(parsedTsv.sheets[0]?.rows, [['name', 'value'], ['alpha', '1']])

assert.equal(spreadsheetColumnLabel(0), 'A')
assert.equal(spreadsheetColumnLabel(26), 'AA')
assert.equal(spreadsheetColumnIndex('A'), 0)
assert.equal(spreadsheetColumnIndex('AA'), 26)

// Delimited text has no type metadata: preserve identifiers and date-like text.
const identifiers = new TextEncoder().encode("id,date,amount\n00123,2026-09-19,1.00\n").buffer
assert.deepEqual(parseSpreadsheetWorkbook(identifiers, "sample.csv").sheets[0]?.rows[1], ["00123", "2026-09-19", "1.00"])

const rangeQuote = spreadsheetSelectionQuote('/workspace', 'sample.xlsx', 'version-1', parsed.sheets[0]!, {
  startColumn: 0, endColumn: 2, startRow: 1, endRow: 2,
})
assert(rangeQuote?.includes('Range: A2:C3'))
assert(rangeQuote?.includes('SHA-1: version-1'))
assert(rangeQuote?.includes('"00123"'))
assert(rangeQuote?.includes('#NO CACHED VALUE'))
assert.equal(spreadsheetSelectionQuote('/workspace', 'sample.xlsx', 'v1', parsed.sheets[0]!, {
  startColumn: 0, endColumn: 300, startRow: 0, endRow: 1,
}), null, 'oversized or invalid selections are never silently truncated')

assert.equal(spreadsheetSelectionText(parsed.sheets[0]!, { startColumn: 0, endColumn: 1, startRow: 1, endRow: 1 }), '00123\t25%')
assert.equal(spreadsheetSelectionText({ ...parsed.sheets[0]!, rows: [['line\nbreak', 'a"b']] },
  { startColumn: 0, endColumn: 1, startRow: 0, endRow: 0 }), '"line\nbreak"\t"a""b"')
