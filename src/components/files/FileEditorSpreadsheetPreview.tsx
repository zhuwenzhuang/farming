import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ListTable } from '@visactor/vtable'
import type { CodeCopy } from '../code/copy'
import { writeClipboardText } from '@/lib/clipboard'
import type { OpenWorkspaceFile } from '@/lib/workspace-open-files'
import { rawWorkspaceFileUrl } from '@/lib/workspace-files'
import {
  spreadsheetSelectionQuote,
  spreadsheetSelectionText,
  spreadsheetColumnIndex,
  spreadsheetColumnLabel,
  type SpreadsheetSheetSnapshot,
  type SpreadsheetWorkbookSnapshot,
} from '@/lib/spreadsheet-workbook'

interface FileEditorSpreadsheetPreviewProps {
  activeTabDomId: string
  copy: CodeCopy
  openFile: OpenWorkspaceFile
  previewRefreshRevision: number
  onQuoteSelection?: (text: string) => void
}

interface SpreadsheetWorkerResponse {
  workbook?: SpreadsheetWorkbookSnapshot
  error?: string
}

interface SelectedSpreadsheetRange {
  startColumn: number
  startRow: number
  endColumn: number
  endRow: number
}

const SPREADSHEET_PARSE_TIMEOUT_MS = 15_000

function cssColor(style: CSSStyleDeclaration, name: string, fallback: string): string {
  return style.getPropertyValue(name).trim() || fallback
}

function spreadsheetTheme() {
  const style = getComputedStyle(document.body)
  const background = cssColor(style, '--code-bg-surface', '#ffffff')
  const header = cssColor(style, '--code-bg-muted', '#f3f4f6')
  const text = cssColor(style, '--code-text', '#1f2937')
  const muted = cssColor(style, '--code-text-muted', '#6b7280')
  const border = cssColor(style, '--code-border-subtle', '#d1d5db')
  const accent = cssColor(style, '--code-accent', '#2563eb')
  const selected = cssColor(style, '--code-accent-soft', 'rgba(37, 99, 235, 0.12)')
  const fontFamily = cssColor(style, '--font-sans', 'system-ui, sans-serif')
  const headerStyle = {
    color: muted,
    bgColor: header,
    borderColor: border,
    fontFamily,
    fontSize: 12,
    fontWeight: 500,
    padding: [6, 9, 6, 9],
    hover: { cellBgColor: selected },
  }
  return {
    underlayBackgroundColor: background,
    defaultStyle: { color: text, bgColor: background, borderColor: border, fontFamily, fontSize: 12 },
    headerStyle,
    rowHeaderStyle: headerStyle,
    cornerHeaderStyle: headerStyle,
    bodyStyle: {
      color: text,
      bgColor: background,
      borderColor: border,
      fontFamily,
      fontSize: 12,
      padding: [6, 9, 6, 9],
      hover: { cellBgColor: selected },
    },
    frameStyle: { borderColor: border, borderLineWidth: 1, cornerRadius: 0 },
    selectionStyle: { cellBgColor: selected, cellBorderColor: accent, cellBorderLineWidth: 2 },
    columnResize: { lineColor: accent, bgColor: selected, lineWidth: 1, width: 3 },
    scrollStyle: { scrollRailColor: 'transparent', scrollSliderColor: muted, width: 7 },
  }
}

function selectedRangeLabel(sheet: SpreadsheetSheetSnapshot, range: SelectedSpreadsheetRange): string {
  const start = `${spreadsheetColumnLabel(sheet.startColumn + range.startColumn)}${sheet.startRow + range.startRow + 1}`
  const end = `${spreadsheetColumnLabel(sheet.startColumn + range.endColumn)}${sheet.startRow + range.endRow + 1}`
  return start === end ? start : `${start}:${end}`
}

function errorFromResponseBody(body: string, status: number): string {
  try {
    const parsed = JSON.parse(body) as { error?: unknown }
    if (typeof parsed.error === 'string' && parsed.error) return parsed.error
  } catch {
    // The raw endpoint can return plain text through an upstream proxy.
  }
  return body.trim() || `Spreadsheet request failed (${status}).`
}

export function FileEditorSpreadsheetPreview({
  activeTabDomId,
  copy,
  onQuoteSelection,
  openFile,
  previewRefreshRevision,
}: FileEditorSpreadsheetPreviewProps) {
  const [workbook, setWorkbook] = useState<SpreadsheetWorkbookSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [activeSheetIndex, setActiveSheetIndex] = useState(0)
  const [selectedRange, setSelectedRange] = useState<SelectedSpreadsheetRange | null>(null)
  const [address, setAddress] = useState('A1')
  const [query, setQuery] = useState('')
  const [findStatus, setFindStatus] = useState('')
  const [copied, setCopied] = useState(false)
  const [tableReady, setTableReady] = useState(false)
  const [actionError, setActionError] = useState('')
  const [manualCopy, setManualCopy] = useState('')
  const [snapshotSha1, setSnapshotSha1] = useState('')
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => { if (copiedTimer.current) clearTimeout(copiedTimer.current) }, [])
  const tableHostRef = useRef<HTMLDivElement | null>(null)
  const tableRef = useRef<ListTable | null>(null)
  const searchCursorRef = useRef({ query: '', index: -1 })

  const sourceUrl = useMemo(() => (
    `${rawWorkspaceFileUrl(openFile.agentId, openFile.file.path, openFile.file.sha1, {
      exactExternal: openFile.exactExternal,
    })}&previewRefresh=${previewRefreshRevision}`
  ), [openFile, previewRefreshRevision])

  useEffect(() => {
    const controller = new AbortController()
    let worker: Worker | null = null
    let settled = false
    let fetchTimedOut = false
    let timeout = 0
    const fetchTimeout = window.setTimeout(() => {
      if (settled) return
      fetchTimedOut = true
      controller.abort()
      setError('Spreadsheet loading timed out.')
    }, SPREADSHEET_PARSE_TIMEOUT_MS)
    setWorkbook(null)
    setSnapshotSha1('')
    setActionError('')
    setManualCopy('')
    setError(null)
    setActiveSheetIndex(0)
    setSelectedRange(null)
    setFindStatus('')
    searchCursorRef.current = { query: '', index: -1 }

    void fetch(sourceUrl, { cache: 'no-store', signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error(errorFromResponseBody(await response.text(), response.status))
      const sha1 = response.headers.get('X-Workspace-File-Sha1') || ''
      const buffer = await response.arrayBuffer()
      window.clearTimeout(fetchTimeout)
      if (controller.signal.aborted) return
      worker = new Worker(new URL('../../workers/spreadsheet-preview.worker.ts', import.meta.url), { type: 'module' })
      timeout = window.setTimeout(() => {
        if (settled) return
        settled = true
        worker?.terminate()
        setError('Spreadsheet parsing timed out.')
      }, SPREADSHEET_PARSE_TIMEOUT_MS)
      worker.onmessage = (event: MessageEvent<SpreadsheetWorkerResponse>) => {
        if (settled) return
        settled = true
        window.clearTimeout(timeout)
        worker?.terminate()
        if (event.data.workbook) { setWorkbook(event.data.workbook); setSnapshotSha1(sha1) }
        else setError(event.data.error || copy.spreadsheetParseFailed)
      }
      worker.onerror = () => {
        if (settled) return
        settled = true
        window.clearTimeout(timeout)
        worker?.terminate()
        setError(copy.spreadsheetParseFailed)
      }
      worker.postMessage({ buffer, fileName: openFile.file.path }, [buffer])
    }).catch(caught => {
      window.clearTimeout(fetchTimeout)
      if (controller.signal.aborted || fetchTimedOut) return
      setError(caught instanceof Error ? caught.message : copy.spreadsheetParseFailed)
    })

    return () => {
      settled = true
      controller.abort()
      window.clearTimeout(fetchTimeout)
      window.clearTimeout(timeout)
      worker?.terminate()
    }
  }, [copy.spreadsheetParseFailed, openFile.file.path, sourceUrl])

  const sheet = workbook?.sheets[activeSheetIndex] ?? null

  useEffect(() => {
    const container = tableHostRef.current
    setTableReady(false)
    if (!container || !sheet) return
    let disposed = false
    let table: ListTable | null = null
    let resizeObserver: ResizeObserver | null = null
    let appearanceObserver: MutationObserver | null = null

    void import('@visactor/vtable').then(({ ListTable: VTableListTable, TABLE_EVENT_TYPE }) => {
      if (disposed) return
      const customMergeCell = sheet.merges.map(merge => ({
        range: {
          start: { col: merge.start.column + 1, row: merge.start.row + 1 },
          end: { col: merge.end.column + 1, row: merge.end.row + 1 },
        },
        text: sheet.rows[merge.start.row]?.[merge.start.column] ?? '',
      }))
      table = new VTableListTable(container, {
        records: sheet.rows,
        columns: Array.from({ length: sheet.columnCount }, (_, column) => ({
          field: column,
          title: `${spreadsheetColumnLabel(sheet.startColumn + column)}${sheet.hiddenColumns.includes(column) ? ' ◌' : ''}`,
          width: sheet.columnWidths[column],
        })),
        rowSeriesNumber: {
          title: '',
          width: 48,
          format: (_column, row) => row == null
            ? ''
            : `${sheet.startRow + row}${sheet.hiddenRows.includes(row - 1) ? ' ◌' : ''}`,
          disableColumnResize: true,
        },
        customMergeCell,
        defaultRowHeight: 28,
        defaultHeaderRowHeight: 28,
        frozenRowCount: 1,
        columnResizeMode: 'all',
        rowResizeMode: 'none',
        keyboardOptions: {
          copySelected: true,
          moveSelectedCellOnArrowKeys: true,
          shiftMultiSelect: true,
          ctrlMultiSelect: true,
          selectAllOnCtrlA: { disableHeaderSelect: true, disableRowSeriesNumberSelect: true },
        },
        select: {
          highlightMode: 'cell',
          disableHeaderSelect: true,
          blankAreaClickDeselect: true,
          outsideClickDeselect: false,
        },
        tooltip: { renderMode: 'html', isShowOverflowTextTooltip: true, confine: true },
        theme: spreadsheetTheme(),
      })
      tableRef.current = table
      const updateSelection = () => {
        const ranges = table?.getSelectedCellRanges() ?? []
        const range = ranges[ranges.length - 1]
        if (!range) return
        const startColumn = Math.max(0, Math.min(range.start.col, range.end.col) - 1)
        const endColumn = Math.min(sheet.columnCount - 1, Math.max(range.start.col, range.end.col) - 1)
        const startRow = Math.max(0, Math.min(range.start.row, range.end.row) - 1)
        const endRow = Math.min(sheet.rowCount - 1, Math.max(range.start.row, range.end.row) - 1)
        if (endColumn < startColumn || endRow < startRow) return
        setSelectedRange({ startColumn, startRow, endColumn, endRow })
        setAddress(`${spreadsheetColumnLabel(sheet.startColumn + startColumn)}${sheet.startRow + startRow + 1}`)
      }
      table.on(TABLE_EVENT_TYPE.SELECTED_CHANGED, updateSelection)
      if (sheet.rowCount > 0 && sheet.columnCount > 0) {
        table.selectCell(1, 1, false, false, true)
        updateSelection()
      }
      setTableReady(true)
      resizeObserver = new ResizeObserver(() => table?.resize())
      resizeObserver.observe(container)
      appearanceObserver = new MutationObserver(() => table?.updateTheme(spreadsheetTheme()))
      appearanceObserver.observe(document.body, { attributes: true, attributeFilter: ['class', 'data-appearance', 'data-theme', 'style'] })
      appearanceObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-appearance', 'data-theme', 'style'] })
    }).catch(caught => {
      if (!disposed) setError(caught instanceof Error ? caught.message : copy.spreadsheetParseFailed)
    })

    return () => {
      disposed = true
      resizeObserver?.disconnect()
      appearanceObserver?.disconnect()
      if (tableRef.current === table) tableRef.current = null
      table?.release()
      container.replaceChildren()
    }
  }, [copy.spreadsheetParseFailed, sheet])

  const selectCell = useCallback((column: number, row: number) => {
    if (!tableRef.current || !sheet || column < 0 || row < 0 || column >= sheet.columnCount || row >= sheet.rowCount) return false
    tableRef.current?.selectCell(column + 1, row + 1, false, false, true)
    tableRef.current?.scrollToCell({ col: column + 1, row: row + 1 })
    setSelectedRange({ startColumn: column, startRow: row, endColumn: column, endRow: row })
    setAddress(`${spreadsheetColumnLabel(sheet.startColumn + column)}${sheet.startRow + row + 1}`)
    return true
  }, [sheet])

  const goToAddress = useCallback(() => {
    if (!sheet) return
    const match = /^([A-Za-z]+)([1-9]\d*)$/.exec(address.trim())
    if (!match) return
    const column = spreadsheetColumnIndex(match[1] || '') - sheet.startColumn
    const row = Number(match[2]) - 1 - sheet.startRow
    selectCell(column, row)
  }, [address, selectCell, sheet])

  const findNext = useCallback(() => {
    if (!sheet) return
    const normalized = query.trim().toLocaleLowerCase()
    if (!normalized) return
    const total = sheet.rowCount * sheet.columnCount
    const previous = searchCursorRef.current.query === normalized ? searchCursorRef.current.index : -1
    for (let offset = 1; offset <= total; offset += 1) {
      const index = (previous + offset) % total
      const row = Math.floor(index / sheet.columnCount)
      const column = index % sheet.columnCount
      if ((sheet.rows[row]?.[column] ?? '').toLocaleLowerCase().includes(normalized)) {
        searchCursorRef.current = { query: normalized, index }
        selectCell(column, row)
        setFindStatus('')
        return
      }
    }
    setFindStatus(copy.spreadsheetNoMatch)
  }, [copy.spreadsheetNoMatch, query, selectCell, sheet])

  const copySelection = useCallback(async () => {
    const value = sheet && selectedRange ? spreadsheetSelectionText(sheet, selectedRange) : ''
    if (!value) return
    setActionError('')
    setManualCopy('')
    if (!await writeClipboardText(value)) {
      setCopied(false)
      setActionError(copy.spreadsheetCopyFailed)
      setManualCopy(value)
      return
    }
    setCopied(true)
    if (copiedTimer.current) clearTimeout(copiedTimer.current)
    copiedTimer.current = setTimeout(() => setCopied(false), 1_200)
  }, [copy.spreadsheetCopyFailed, sheet, selectedRange])

  const quoteSelection = () => {
    if (!sheet || !selectedRange || !onQuoteSelection) return
    setActionError('')
    if (!snapshotSha1) { setActionError(copy.spreadsheetQuoteUnavailable); return }
    const quote = spreadsheetSelectionQuote(openFile.workspaceRoot, openFile.file.path, snapshotSha1, sheet, selectedRange)
    if (!quote) { setActionError(copy.spreadsheetQuoteTooLarge); return }
    onQuoteSelection(quote)
  }

  const selectedAddress = sheet && selectedRange ? selectedRangeLabel(sheet, selectedRange) : ''
  const selectedCellAddress = sheet && selectedRange
    ? `${spreadsheetColumnLabel(sheet.startColumn + selectedRange.startColumn)}${sheet.startRow + selectedRange.startRow + 1}`
    : ''
  const selectedFormula = sheet && selectedCellAddress ? sheet.formulas[selectedCellAddress] : null
  const selectedValue = sheet && selectedRange
    ? sheet.rows[selectedRange.startRow]?.[selectedRange.startColumn] ?? ''
    : ''

  return (
    <section
      className="code-file-preview-panel spreadsheet"
      data-testid="code-file-preview-panel"
      role="tabpanel"
      aria-labelledby={activeTabDomId}
      tabIndex={-1}
    >
      {!workbook && !error && (
        <div className="code-spreadsheet-state" role="status">{copy.spreadsheetLoading}</div>
      )}
      {error && (
        <div className="code-spreadsheet-state error" role="alert">
          <strong>{copy.spreadsheetParseFailed}</strong>
          <span>{error}</span>
        </div>
      )}
      {workbook && sheet && !error && (
        <div className="code-spreadsheet-shell" data-testid="code-spreadsheet-preview">
          <div className="code-spreadsheet-toolbar">
            <label>
              <span>{copy.spreadsheetSheet}</span>
              <select
                data-testid="code-spreadsheet-sheet-select"
                value={activeSheetIndex}
                onChange={event => {
                  setTableReady(false)
                  setActiveSheetIndex(Number(event.currentTarget.value))
                  setSelectedRange(null)
                  setFindStatus('')
                  searchCursorRef.current = { query: '', index: -1 }
                }}
              >
                {workbook.sheets.map((candidate, index) => (
                  <option key={`${candidate.name}-${index}`} value={index}>
                    {candidate.name}{candidate.hidden ? ` · ${copy.spreadsheetHidden}` : ''}
                  </option>
                ))}
              </select>
            </label>
            <form className="code-spreadsheet-find" onSubmit={event => { event.preventDefault(); findNext() }}>
              <input
                disabled={!tableReady}
                aria-label={copy.spreadsheetFind}
                placeholder={copy.spreadsheetFindPlaceholder}
                value={query}
                onChange={event => { setQuery(event.currentTarget.value); setFindStatus('') }}
              />
              <button type="submit" disabled={!tableReady}>{copy.spreadsheetFind}</button>
              {findStatus && <span role="status">{findStatus}</span>}
            </form>
            <form className="code-spreadsheet-address" onSubmit={event => { event.preventDefault(); goToAddress() }}>
              <input
                disabled={!tableReady}
                aria-label={copy.spreadsheetAddress}
                value={address}
                onChange={event => setAddress(event.currentTarget.value)}
              />
            </form>
            <button type="button" onClick={() => void copySelection()} disabled={!tableReady || !selectedRange}>
              {copied ? copy.spreadsheetCopied : copy.spreadsheetCopy}
            </button>
            {onQuoteSelection ? <button type="button" onClick={quoteSelection} disabled={!tableReady || !selectedRange}>
              {copy.quoteSelection}
            </button> : null}
            <span className="code-spreadsheet-size">
              {copy.spreadsheetRowsColumns(sheet.rowCount, sheet.columnCount)}
            </span>
          </div>
          {actionError ? <div className="code-spreadsheet-warning" role="alert">{actionError}</div> : null}
          {manualCopy ? <textarea aria-label={copy.spreadsheetCopy} readOnly value={manualCopy} onFocus={event => event.currentTarget.select()} /> : null}
          {workbook.warnings.length > 0 && (
            <div className="code-spreadsheet-warning" role="status">
              {workbook.warnings.map(warning => warning.kind === 'missing-formula-cache'
                ? copy.spreadsheetMissingFormulaCaches(warning.count)
                : copy.spreadsheetHiddenContent).join(' ')}
            </div>
          )}
          <div
            ref={tableHostRef}
            className="code-spreadsheet-grid"
            data-testid="code-spreadsheet-grid"
            aria-label={`${sheet.name}, ${copy.spreadsheetRowsColumns(sheet.rowCount, sheet.columnCount)}`}
          />
          <div className="code-spreadsheet-inspector" aria-live="polite">
            <strong>{selectedAddress}</strong>
            {selectedFormula
              ? <span>{`=${selectedFormula.formula}`}{selectedFormula.missingCachedValue ? ` · ${copy.spreadsheetFormulaNoCache}` : ` → ${selectedValue}`}</span>
              : <span>{selectedValue}</span>}
          </div>
        </div>
      )}
    </section>
  )
}
