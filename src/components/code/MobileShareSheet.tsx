import { useModalFocusScope } from '@/hooks/useModalFocusScope'
import { createPortal } from 'react-dom'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'
import { appPath } from '@/lib/base-path'
import { writeClipboardText } from '@/lib/clipboard'
import type { QrShareTicket } from '@/lib/qr-share-ticket'
import type { CodeCopy } from './copy'
import { FarmingQrCode, formatCountdown, preloadQrCodeFactory } from './ShareQrButton'

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

export function MobileQrLoadStatus({
  failed,
  loadingLabel,
  failedLabel,
  retryLabel,
  onRetry,
}: {
  failed: boolean
  loadingLabel: string
  failedLabel: string
  retryLabel: string
  onRetry: () => void
}) {
  if (!failed) {
    return <div className="code-share-qr-loading" role="status">{loadingLabel}</div>
  }

  return (
    <div className="code-share-qr-retry">
      <span role="status">{failedLabel}</span>
      <button type="button" data-testid="code-mobile-share-qr-retry" onClick={onRetry}>
        {retryLabel}
      </button>
    </div>
  )
}

export function MobileShareSheet({
  copy,
  title,
  ticket,
  onClose,
  returnFocusRef,
}: {
  copy: CodeCopy
  title: string
  ticket: QrShareTicket
  onClose: () => void
  returnFocusRef: RefObject<HTMLElement | null>
}) {
  const standalone = isStandaloneWebApp()
  const [copied, setCopied] = useState<'read-only' | 'full-control' | null>(null)
  const [copyFailed, setCopyFailed] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const [qrCodeFactory, setQrCodeFactory] = useState<Awaited<ReturnType<typeof preloadQrCodeFactory>> | null>(null)
  const [qrCodeFailed, setQrCodeFailed] = useState(false)
  const closeButtonRef = useRef<HTMLButtonElement | null>(null)
  const qrRequestSeqRef = useRef(0)

  const dialogRef = useModalFocusScope<HTMLElement>({
    open: true,
    initialFocusRef: closeButtonRef,
    returnFocusRef,
    onEscape: onClose,
    dismissOnPointerOutside: true,
  })

  const loadQrRenderer = useCallback(() => {
    const requestSeq = qrRequestSeqRef.current + 1
    qrRequestSeqRef.current = requestSeq
    setQrCodeFactory(null)
    setQrCodeFailed(false)
    void preloadQrCodeFactory()
      .then(factory => {
        if (requestSeq === qrRequestSeqRef.current) {
          setQrCodeFactory(() => factory)
        }
      })
      .catch(() => {
        if (requestSeq === qrRequestSeqRef.current) {
          setQrCodeFailed(true)
        }
      })
  }, [])

  useEffect(() => {
    loadQrRenderer()
    return () => { qrRequestSeqRef.current += 1 }
  }, [loadQrRenderer])

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    if (!copied && !copyFailed) return undefined
    const timer = window.setTimeout(() => {
      setCopied(null)
      setCopyFailed(false)
    }, 1800)
    return () => window.clearTimeout(timer)
  }, [copied, copyFailed])

  const copyLink = useCallback(async (url: string, mode: 'read-only' | 'full-control') => {
    const success = await writeClipboardText(url)
    setCopied(success ? mode : null)
    setCopyFailed(!success)
  }, [])

  const expired = ticket.expiresAt <= now
  const countdown = formatCountdown(ticket.expiresAt - now)
  const badgeUrl = appPath('/farming-2/app-icon-v2-180.png')

  return createPortal(
    <div className="code-mobile-share-backdrop" data-testid="code-mobile-share-sheet" role="presentation">
      <section
        ref={dialogRef}
        className="code-mobile-share-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="code-mobile-share-title"
      >
        <header className="code-mobile-share-header">
          <h2 id="code-mobile-share-title">{copy.mobileShareTitle}</h2>
          <button ref={closeButtonRef} type="button" aria-label={copy.cancel} onClick={onClose}>×</button>
        </header>
        <section className="code-mobile-share-choice code-mobile-share-forward">
          <div className="code-mobile-share-choice-copy">
            <h3>{copy.copyReadOnlyShareLink}</h3>
            <p>{copy.shareLinkVisibility}</p>
          </div>
          <div className="code-mobile-share-link-row">
            <span className="code-mobile-share-link" title={title}>{ticket.longUrl}</span>
            <button type="button" data-testid="code-mobile-share-copy-action" onClick={() => void copyLink(ticket.longUrl, 'read-only')}>
              <CopyActionIcon />
              <span>{copied === 'read-only' ? copy.mobileShareCopied : copy.mobileShareCopyAction}</span>
            </button>
          </div>
          {copyFailed && <span className="code-mobile-share-status" role="status">{copy.copyFailed}</span>}
        </section>
        <section className="code-mobile-share-choice code-mobile-share-qr-choice">
          <div className="code-mobile-share-choice-copy">
            <h3>{copy.scanToOpenOnPhone}</h3>
            <p>{ticket.shortUrlAccessMode === 'owner' ? copy.shareQrFullAccessWarning : copy.shareQrReadOnlyWarning}</p>
          </div>
          <div className="code-share-qr-frame code-mobile-share-qr-frame" data-expired={expired ? 'true' : 'false'}>
            <div className="code-share-qr-canvas" data-testid="code-mobile-share-qr">
              {qrCodeFactory ? (
                <FarmingQrCode value={ticket.shortUrl} badgeUrl={badgeUrl} qrCodeFactory={qrCodeFactory} />
              ) : (
                <MobileQrLoadStatus
                  failed={qrCodeFailed}
                  loadingLabel={copy.loading}
                  failedLabel={copy.shareLinkFailed}
                  retryLabel={copy.retry}
                  onRetry={loadQrRenderer}
                />
              )}
            </div>
            <div className="code-share-countdown">{expired ? copy.shareLinkExpired : countdown}</div>
            <div className="code-share-qr-access-note" data-access-mode={ticket.shortUrlAccessMode}>
              {ticket.shortUrlAccessMode === 'owner' ? copy.shareQrFullAccessWarning : copy.shareQrReadOnlyWarning}
            </div>
          </div>
        </section>
        {ticket.shortUrlAccessMode === 'owner' && (
          <section className="code-mobile-share-choice code-mobile-share-full-control">
            <div className="code-mobile-share-choice-copy">
              <h3>{copy.copyFullAccessShareLink}</h3>
              <p>{copy.shareQrFullAccessWarning}</p>
            </div>
            <div className="code-mobile-share-link-row">
              <span className="code-mobile-share-link" title={ticket.tokenLabel || title}>{ticket.fullAccessUrl}</span>
              <button type="button" data-testid="code-mobile-share-full-control-action" onClick={() => void copyLink(ticket.fullAccessUrl, 'full-control')}>
                <CopyActionIcon />
                <span>{copied === 'full-control' ? copy.mobileShareCopied : copy.mobileShareCopyAction}</span>
              </button>
            </div>
          </section>
        )}
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
    </div>,
    document.body,
  )
}
