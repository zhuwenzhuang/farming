import { useEffect, useMemo, useRef, useState } from 'react'
import type { TerminalPreviewSnapshot } from '@/types/agent'
import {
  buildTerminalPreviewLines,
  calculateTerminalPreviewFontSize,
  normalizeTerminalPreviewSnapshot,
  renderTerminalPreviewLine,
} from '@/lib/terminal-preview'

interface TerminalSnapshotPreviewProps {
  text: string
  cols?: number
  rows?: number
  snapshot?: TerminalPreviewSnapshot | null
  emptyText?: string
}

export function TerminalSnapshotPreview({
  text,
  cols = 80,
  rows = 24,
  snapshot,
  emptyText = 'No output yet...',
}: TerminalSnapshotPreviewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [fontSize, setFontSize] = useState(10)

  const normalizedSnapshot = useMemo(
    () => normalizeTerminalPreviewSnapshot(snapshot),
    [snapshot],
  )

  const lines = useMemo(() => buildTerminalPreviewLines(text, rows), [text, rows])
  const renderedText = useMemo(() => {
    const joined = lines.join('\n')
    return joined.trim() ? joined : emptyText
  }, [emptyText, lines])

  const htmlRows = useMemo(() => {
    if (!normalizedSnapshot) return []

    return normalizedSnapshot.cells.map((rowCells) => (
      renderTerminalPreviewLine(rowCells)
    ))
  }, [normalizedSnapshot])

  const previewCols = normalizedSnapshot?.cols || cols
  const previewRows = normalizedSnapshot?.rows || (text.trim() ? Math.max(rows, lines.length) : 1)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const updateMetrics = () => {
      const nextFontSize = calculateTerminalPreviewFontSize(
        container.clientWidth,
        container.clientHeight,
        previewCols,
        previewRows,
      )
      setFontSize(nextFontSize)
    }

    updateMetrics()
    const observer = new ResizeObserver(updateMetrics)
    observer.observe(container)
    return () => observer.disconnect()
  }, [previewCols, previewRows, renderedText, htmlRows.length])

  return (
    <div ref={containerRef} className="terminal-snapshot-preview" aria-hidden="true">
      <div
        className="terminal-snapshot-screen"
        style={{
          fontSize: `${fontSize}px`,
          lineHeight: `${fontSize * 1.2}px`,
        }}
      >
        {normalizedSnapshot ? (
          htmlRows.map((rowHtml, index) => (
            <div
              key={index}
              className="terminal-snapshot-row"
              dangerouslySetInnerHTML={{ __html: rowHtml }}
            />
          ))
        ) : (
          <pre className="terminal-snapshot-fallback">{renderedText}</pre>
        )}
      </div>
    </div>
  )
}
