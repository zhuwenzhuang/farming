export type TerminalImeCursor = {
  x: number
  y: number
}

export type TerminalImeRendererMetrics = {
  width: number
  height: number
}

export type TerminalImeOverlayStyle = {
  position: 'absolute'
  left: string
  top: string
  width: string
  height: string
  lineHeight: string
  fontSize: string
  fontFamily: string
  padding: '0'
  margin: '0'
  border: '0'
  outline: '0'
  background: 'transparent'
  clipPath: 'none'
  overflow: 'hidden'
  whiteSpace: 'pre'
  resize: 'none'
}

export function terminalImeOverlayStyle(
  cursor: TerminalImeCursor | null | undefined,
  metrics: TerminalImeRendererMetrics | null | undefined,
  fontSize: number,
  fontFamily: string,
): TerminalImeOverlayStyle | null {
  if (!cursor || !metrics) return null

  const left = Math.max(0, cursor.x * metrics.width)
  const top = Math.max(0, cursor.y * metrics.height)
  const height = Math.max(fontSize + 2, metrics.height)
  const width = Math.max(metrics.width * 8, 120)

  return {
    position: 'absolute',
    left: `${left}px`,
    top: `${top}px`,
    width: `${width}px`,
    height: `${height}px`,
    lineHeight: `${height}px`,
    fontSize: `${fontSize}px`,
    fontFamily,
    padding: '0',
    margin: '0',
    border: '0',
    outline: '0',
    background: 'transparent',
    clipPath: 'none',
    overflow: 'hidden',
    whiteSpace: 'pre',
    resize: 'none',
  }
}
