import { useCallback, useEffect, useRef, useState } from 'react'
import { CheckGlyph, CopyGlyph } from '@/components/IconGlyphs'
import { writeClipboardText } from '@/lib/clipboard'
import type { CodeCopy } from './copy'

type CopyState = 'ready' | 'copying' | 'copied' | 'failed' | 'uncertain'

// The ticket owns link creation; this card owns only clipboard feedback.
// Remount for a new ticket so late writes cannot update its replacement.
export function ReadOnlyShareLinkCard({ url, expiresAt, copy }: {
  url: string
  expiresAt: number
  copy: CodeCopy
}) {
  const [state, setState] = useState<CopyState>('ready')
  const operation = useRef<AbortController | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const copyLink = useCallback(() => {
    if (operation.current) return
    const current = new AbortController()
    operation.current = current
    setState('copying')
    timer.current = setTimeout(() => {
      current.abort()
      operation.current = null
      setState('uncertain')
    }, 5000)
    // Invoke immediately on explicit clicks, with no intervening network request.
    void writeClipboardText(url, current.signal).then(copied => {
      if (current.signal.aborted) return
      clearTimeout(timer.current)
      operation.current = null
      setState(copied ? 'copied' : 'failed')
    })
  }, [url])

  useEffect(() => {
    copyLink()
    return () => {
      operation.current?.abort()
      operation.current = null
      clearTimeout(timer.current)
    }
  }, [copyLink])

  return (
    <div className="code-share-copy-status" data-testid="code-share-copy-status" data-copy-state={state}>
      <span className="code-share-copy-status-icon" aria-hidden="true">
        {state === 'copied' ? <CheckGlyph /> : <CopyGlyph />}
      </span>
      <span className="code-share-copy-status-copy" role="status" aria-live="polite">
        <strong>{state === 'copied' ? copy.copiedShareLink : copy.readOnlyShareLinkReady}</strong>
        <span>{copy.readOnlyShareExpires(expiresAt)}</span>
        {state === 'copying' && <span>{copy.codeBlockCopying}</span>}
        {state === 'failed' && <span>{copy.readOnlyShareCopyFailed}</span>}
        {state === 'uncertain' && <span>{copy.readOnlyShareCopyUncertain}</span>}
      </span>
      <div className="code-share-read-only-controls">
        <input
          className="code-field"
          aria-label={copy.readOnlyShareLinkReady}
          data-testid="code-share-read-only-url"
          value={url}
          readOnly
          spellCheck={false}
          onFocus={event => event.currentTarget.select()}
          onClick={event => event.currentTarget.select()}
        />
        <div className="code-content-toolbar">
          <button
            type="button"
            className="code-content-toolbar-text code-content-toolbar-labeled"
            data-testid="code-share-copy-read-only"
            aria-label={copy.copyReadOnlyShareLink}
            onClick={copyLink}
            disabled={state === 'copying'}
          >
            <CopyGlyph />
            <span>{copy.copy}</span>
          </button>
        </div>
      </div>
    </div>
  )
}
