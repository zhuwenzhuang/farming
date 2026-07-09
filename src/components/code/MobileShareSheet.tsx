import { useCallback, useEffect, useState } from 'react'
import { writeTerminalClipboardText } from '@/lib/terminal-clipboard'
import type { CodeCopy } from './copy'

function isStandaloneWebApp() {
  if (typeof window === 'undefined') return false
  const iosNavigator = navigator as Navigator & { standalone?: boolean }
  return iosNavigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches
}

function ShareActionIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">
      <path d="M10 13V3m0 0L6.5 6.5M10 3l3.5 3.5M4 9v6.5A1.5 1.5 0 0 0 5.5 17h9a1.5 1.5 0 0 0 1.5-1.5V9" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function AddToHomeIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">
      <rect x="3" y="3" width="14" height="14" rx="3" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="M10 6.5v7M6.5 10h7" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  )
}

function CopyActionIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">
      <rect x="6.5" y="6.5" width="9" height="9" rx="2" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M13.5 6.5v-2A1.5 1.5 0 0 0 12 3H4.5A1.5 1.5 0 0 0 3 4.5V12A1.5 1.5 0 0 0 4.5 13.5h2" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}

export function MobileShareSheet({
  copy,
  title,
  url,
  onClose,
}: {
  copy: CodeCopy
  title: string
  url: string
  onClose: () => void
}) {
  const standalone = isStandaloneWebApp()
  const [copied, setCopied] = useState(false)
  const [copyFailed, setCopyFailed] = useState(false)

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  useEffect(() => {
    if (!copied && !copyFailed) return undefined
    const timer = window.setTimeout(() => {
      setCopied(false)
      setCopyFailed(false)
    }, 1800)
    return () => window.clearTimeout(timer)
  }, [copied, copyFailed])

  const copyLink = useCallback(async () => {
    const success = await writeTerminalClipboardText(url)
    setCopied(success)
    setCopyFailed(!success)
  }, [url])

  return (
    <div className="code-mobile-share-backdrop" data-testid="code-mobile-share-sheet" role="presentation" onPointerDown={onClose}>
      <section
        className="code-mobile-share-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="code-mobile-share-title"
        onPointerDown={event => event.stopPropagation()}
      >
        <header className="code-mobile-share-header">
          <h2 id="code-mobile-share-title">{copy.mobileShareTitle}</h2>
          <button type="button" aria-label={copy.cancel} onClick={onClose}>×</button>
        </header>
        <section className="code-mobile-share-choice code-mobile-share-forward">
          <div className="code-mobile-share-choice-copy">
            <h3>{copy.mobileForwardTitle}</h3>
            <p>{copy.mobileForwardHint}</p>
          </div>
          <div className="code-mobile-share-link-row">
            <span className="code-mobile-share-link" title={title}>{url}</span>
            <button type="button" data-testid="code-mobile-share-copy-action" onClick={() => void copyLink()}>
              <CopyActionIcon />
              <span>{copied ? copy.mobileShareCopied : copy.mobileShareCopyAction}</span>
            </button>
          </div>
          {copyFailed && <span className="code-mobile-share-status" role="status">{copy.copyFailed}</span>}
        </section>
        <section className="code-mobile-share-choice code-mobile-share-install-guide">
          <h3>{copy.mobileInstallTitle}</h3>
          {standalone ? (
            <p className="code-mobile-install-complete">{copy.mobileShareInstalled}</p>
          ) : (
            <>
            <p className="code-mobile-install-hint">{copy.mobileInstallChromeHint}</p>
            <div className="code-mobile-install-steps">
              <div className="code-mobile-install-step">
                <span className="code-mobile-install-controls" aria-hidden="true">
                  <span className="code-mobile-install-control"><ShareActionIcon /></span>
                  <span className="code-mobile-install-or">/</span>
                  <span className="code-mobile-install-control code-mobile-install-more">•••</span>
                </span>
                <span>{copy.mobileInstallShareStep}<small>{copy.mobileInstallMoreStep}</small></span>
              </div>
              <div className="code-mobile-install-step">
                <span className="code-mobile-install-controls" aria-hidden="true">
                  <span className="code-mobile-install-control"><AddToHomeIcon /></span>
                </span>
                <span>{copy.mobileInstallAddStep}<small>{copy.mobileInstallOpenStep}</small></span>
              </div>
            </div>
            </>
          )}
        </section>
      </section>
    </div>
  )
}
