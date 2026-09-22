import { useEffect, useRef, useState, type ComponentProps } from 'react'
import { CheckGlyph, CopyGlyph } from './IconGlyphs'
import type { CodeCopy } from './code/copy'
import { writeClipboardText } from '@/lib/clipboard'
import { codeBlockLanguage, markdownTextContent } from '@/lib/react-markdown-content'

type CopyState = 'idle' | 'copying' | 'copied' | 'copiedCurrent' | 'failed' | 'uncertain'

export function MarkdownCodeBlock({ children, copy, streaming = false, ...props }: ComponentProps<'pre'> & {
  copy: CodeCopy
  streaming?: boolean
}) {
  const [state, setState] = useState<CopyState>('idle')
  const operation = useRef(0)
  const busy = useRef(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => {
    operation.current += 1
    clearTimeout(timer.current)
  }, [])

  const labels: Record<CopyState, string> = {
    idle: copy.copy,
    copying: copy.codeBlockCopying,
    copied: copy.codeBlockCopied,
    copiedCurrent: copy.codeBlockCopiedCurrent,
    failed: copy.codeBlockCopyFailed,
    uncertain: copy.codeBlockCopyUncertain,
  }
  const succeeded = state === 'copied' || state === 'copiedCurrent'

  function handleCopy() {
    if (busy.current) return
    // Snapshot the source at activation, independently of subsequent stream updates.
    const source = markdownTextContent(children)
    const currentOperation = ++operation.current
    busy.current = true
    clearTimeout(timer.current)
    setState('copying')
    timer.current = setTimeout(() => {
      operation.current += 1
      busy.current = false
      setState('uncertain')
    }, 5000)
    void writeClipboardText(source).then(copied => {
      if (operation.current !== currentOperation) return
      clearTimeout(timer.current)
      busy.current = false
      setState(copied ? streaming ? 'copiedCurrent' : 'copied' : 'failed')
      timer.current = setTimeout(() => setState('idle'), copied ? 1500 : 4000)
    })
  }

  return (
    <div className="code-markdown-code-block" data-copy-state={state}>
      <div className="code-markdown-code-toolbar code-content-toolbar">
        <span className="code-markdown-code-language">{codeBlockLanguage(children)}</span>
        <button
          type="button"
          className="code-content-toolbar-text code-content-toolbar-labeled code-markdown-code-copy"
          onClick={handleCopy}
          disabled={state === 'copying'}
          aria-label={state === 'idle' ? copy.codeBlockCopy : labels[state]}
          title={state === 'idle' ? copy.codeBlockCopy : labels[state]}
        >
          {succeeded ? <CheckGlyph /> : <CopyGlyph />}
          <span>{labels[state]}</span>
          <span className="code-markdown-copy-reserve" aria-hidden="true">{copy.codeBlockCopied}</span>
        </button>
        <span className="code-markdown-copy-status" role="status">{state === 'idle' ? '' : labels[state]}</span>
      </div>
      <pre {...props}>{children}</pre>
    </div>
  )
}
