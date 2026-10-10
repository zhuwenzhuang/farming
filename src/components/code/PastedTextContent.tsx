import { Fragment, memo } from 'react'
import type { ComposerContextReference } from './composer-message'

export const PastedTextContent = memo(function PastedTextContent({ reference }: { reference: ComposerContextReference }) {
  const text = reference.text || ''
  if (!reference.textFormats?.length) return text
  let end = 0
  const parts = reference.textFormats.map(run => {
    const gap = text.slice(end, run.start)
    end = run.end
    return <Fragment key={run.start}>{gap}<span style={{
      // Retain source hues while keeping dark-editor clipboard ink readable
      // on light appearances (and light-editor ink readable in Dark).
      color: run.color ? `light-dark(hsl(from ${run.color} h s min(l, 35)), hsl(from ${run.color} h s max(l, 75)))` : undefined,
      fontWeight: run.bold ? 700 : undefined,
      fontStyle: run.italic ? 'italic' : undefined,
      fontFamily: run.monospace ? 'var(--code-mono-font, ui-monospace, SFMono-Regular, Menlo, monospace)' : undefined,
    }}>{text.slice(run.start, run.end)}</span></Fragment>
  })
  return <>{parts}{text.slice(end)}</>
})
