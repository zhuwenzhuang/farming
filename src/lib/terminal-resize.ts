export const MIN_TERMINAL_RESIZE_COLS = 40
export const MIN_TERMINAL_RESIZE_ROWS = 10

export interface TerminalResizeDimensions {
  cols: number
  rows: number
}

export interface TerminalResizeFitAddon {
  proposeDimensions: () => TerminalResizeDimensions | undefined
}

export function normalizeTerminalResizeDimensions(cols: number, rows: number): TerminalResizeDimensions | null {
  const nextCols = Math.floor(Number(cols))
  const nextRows = Math.floor(Number(rows))
  if (!Number.isFinite(nextCols) || !Number.isFinite(nextRows)) return null
  if (nextCols < MIN_TERMINAL_RESIZE_COLS || nextRows < MIN_TERMINAL_RESIZE_ROWS) return null
  return { cols: nextCols, rows: nextRows }
}

export function proposeTerminalResizeDimensions(
  hostEl: HTMLElement,
  fitAddon: TerminalResizeFitAddon,
): TerminalResizeDimensions | null {
  const hostRect = hostEl.getBoundingClientRect()
  if (hostRect.width <= 0 || hostRect.height <= 0) return null

  const dimensions = fitAddon.proposeDimensions()
  if (!dimensions) return null
  return normalizeTerminalResizeDimensions(dimensions.cols, dimensions.rows)
}
