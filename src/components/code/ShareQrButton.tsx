import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type qrcode from 'qrcode-generator'
import { appPath } from '@/lib/base-path'
import { QrGlyph } from '@/components/IconGlyphs'
import { writeTerminalClipboardText } from '@/lib/terminal-clipboard'
import {
  workspaceShareTargetKey,
  workspaceShareTargetWithCurrentReadingAnchor,
  type WorkspaceShareTarget,
} from '@/lib/workspace-share-target'
import type { CodeCopy } from './copy'

const CLOSE_DWELL_MS = 140
const POPOVER_WIDTH = 264
const POPOVER_HEIGHT = 340
const QR_QUIET_ZONE = 4

type ShareTicket = {
  code: string
  expiresAt: number
  ttlMs: number
  shortPath: string
  shortUrl: string
  longUrl: string
  tokenLabel: string
}

type QrCodeFactory = typeof qrcode
type QrCodeModule = {
  default?: unknown
  qrcode?: unknown
}

let qrCodeFactoryPromise: Promise<QrCodeFactory> | null = null

function resolveQrCodeFactory(module: QrCodeModule | QrCodeFactory) {
  if (typeof module === 'function') return module
  if (typeof module.default === 'function') return module.default as QrCodeFactory
  if (typeof module.qrcode === 'function') return module.qrcode as QrCodeFactory
  throw new Error('QR renderer failed to load')
}

function preloadQrCodeFactory() {
  if (!qrCodeFactoryPromise) {
    qrCodeFactoryPromise = import('qrcode-generator').then(module => resolveQrCodeFactory(module as QrCodeModule))
  }
  return qrCodeFactoryPromise
}

function formatCountdown(ms: number) {
  const seconds = Math.max(0, Math.ceil(ms / 1000))
  const minutes = Math.floor(seconds / 60)
  const remainder = seconds % 60
  return `${minutes}:${String(remainder).padStart(2, '0')}`
}

function shareTicketIsFresh(ticket: ShareTicket | null, now: number) {
  return Boolean(ticket && ticket.expiresAt > now + 1000)
}

function tokenDisplayLines(value: string) {
  const parts = value
    .split('-')
    .map(part => part.trim())
    .filter(Boolean)
  return parts
}

async function revokeShareTicket(ticket: ShareTicket | null) {
  if (!ticket?.code) return
  await fetch(appPath(`/api/share/qr-ticket/${encodeURIComponent(ticket.code)}`), { method: 'DELETE' }).catch(() => {})
}

function isFinderModule(row: number, column: number, moduleCount: number) {
  const inTop = row < 7
  const inLeft = column < 7
  const inRight = column >= moduleCount - 7
  const inBottom = row >= moduleCount - 7
  return (inTop && inLeft) || (inTop && inRight) || (inBottom && inLeft)
}

function isBadgeModule(row: number, column: number, moduleCount: number, badgeModules: number) {
  const start = Math.floor((moduleCount - badgeModules) / 2)
  const end = start + badgeModules
  return row >= start && row < end && column >= start && column < end
}

function moduleFill(row: number, column: number) {
  if ((row + column) % 11 === 0) return '#6d8a63'
  if ((row * 3 + column) % 17 === 0) return '#9b7a35'
  return '#263327'
}

function finderPattern(x: number, y: number, key: string) {
  return (
    <g key={key}>
      <rect x={x} y={y} width="7" height="7" rx="1.45" fill="#263327" />
      <rect x={x + 1} y={y + 1} width="5" height="5" rx="1" fill="#fbfaf2" />
      <rect x={x + 2} y={y + 2} width="3" height="3" rx="0.72" fill="#263327" />
      <rect x={x + 3.05} y={y + 3.05} width="0.9" height="0.9" rx="0.32" fill="#d9a735" />
    </g>
  )
}

function FarmingQrCode({ value, badgeUrl, qrCodeFactory }: { value: string; badgeUrl: string; qrCodeFactory: QrCodeFactory }) {
  const rawId = useId().replace(/:/g, '')
  const qr = useMemo(() => {
    const next = qrCodeFactory(0, 'H')
    next.addData(value)
    next.make()
    return next
  }, [qrCodeFactory, value])
  const moduleCount = qr.getModuleCount()
  const size = moduleCount + QR_QUIET_ZONE * 2
  const badgeModules = Math.max(7, Math.min(11, Math.floor(moduleCount * 0.26) | 1))
  const badgeSize = badgeModules + 1.4
  const badgeX = QR_QUIET_ZONE + (moduleCount - badgeSize) / 2
  const badgeY = QR_QUIET_ZONE + (moduleCount - badgeSize) / 2
  const clipId = `farming-qr-badge-${rawId}`
  const modules = []

  for (let row = 0; row < moduleCount; row += 1) {
    for (let column = 0; column < moduleCount; column += 1) {
      if (!qr.isDark(row, column)) continue
      if (isFinderModule(row, column, moduleCount)) continue
      if (isBadgeModule(row, column, moduleCount, badgeModules)) continue
      modules.push(
        <rect
          key={`${row}-${column}`}
          x={QR_QUIET_ZONE + column + 0.14}
          y={QR_QUIET_ZONE + row + 0.14}
          width="0.72"
          height="0.72"
          rx="0.24"
          fill={moduleFill(row, column)}
        />,
      )
    }
  }

  return (
    <svg
      className="code-share-qr-svg"
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label="QR code"
      shapeRendering="geometricPrecision"
    >
      <defs>
        <clipPath id={clipId}>
          <rect x={badgeX + 0.55} y={badgeY + 0.55} width={badgeSize - 1.1} height={badgeSize - 1.1} rx="2.1" />
        </clipPath>
      </defs>
      <rect x="0" y="0" width={size} height={size} rx="4" fill="#fbfaf2" />
      {modules}
      {finderPattern(QR_QUIET_ZONE, QR_QUIET_ZONE, 'top-left')}
      {finderPattern(QR_QUIET_ZONE + moduleCount - 7, QR_QUIET_ZONE, 'top-right')}
      {finderPattern(QR_QUIET_ZONE, QR_QUIET_ZONE + moduleCount - 7, 'bottom-left')}
      <rect x={badgeX} y={badgeY} width={badgeSize} height={badgeSize} rx="2.6" fill="#fbfaf2" />
      <rect x={badgeX + 0.35} y={badgeY + 0.35} width={badgeSize - 0.7} height={badgeSize - 0.7} rx="2.25" fill="#ffffff" />
      <image
        href={badgeUrl}
        x={badgeX + 0.55}
        y={badgeY + 0.55}
        width={badgeSize - 1.1}
        height={badgeSize - 1.1}
        preserveAspectRatio="xMidYMid slice"
        clipPath={`url(#${clipId})`}
      />
    </svg>
  )
}

export function ShareQrButton({
  copy,
  sidebarCollapsed,
  shareTarget,
  openRequest = 0,
}: {
  copy: CodeCopy
  sidebarCollapsed: boolean
  shareTarget?: WorkspaceShareTarget | null
  openRequest?: number
}) {
  const [open, setOpen] = useState(false)
  const [pinned, setPinned] = useState(false)
  const [ticket, setTicket] = useState<ShareTicket | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const [placement, setPlacement] = useState({ x: 0, y: 0 })
  const rootRef = useRef<HTMLDivElement | null>(null)
  const buttonRef = useRef<HTMLButtonElement | null>(null)
  const tokenDisplayRef = useRef<HTMLSpanElement | null>(null)
  const tokenMeasureRef = useRef<HTMLSpanElement | null>(null)
  const closeTimerRef = useRef<number | null>(null)
  const requestSeqRef = useRef(0)
  const ticketRef = useRef<ShareTicket | null>(null)
  const copiedTimerRef = useRef<number | null>(null)
  const handledOpenRequestRef = useRef(0)
  const [singleLineTokenFits, setSingleLineTokenFits] = useState(true)
  const [qrCodeFactory, setQrCodeFactory] = useState<QrCodeFactory | null>(null)
  const badgeUrl = appPath('/farming-2/app-icon-v2-180.png')
  const shareTargetSignature = workspaceShareTargetKey(shareTarget)

  useEffect(() => {
    ticketRef.current = ticket
  }, [ticket])

  const clearCloseTimer = useCallback(() => {
    if (closeTimerRef.current === null) return
    window.clearTimeout(closeTimerRef.current)
    closeTimerRef.current = null
  }, [])

  const updatePlacement = useCallback(() => {
    const rect = buttonRef.current?.getBoundingClientRect()
    if (!rect) return
    const rightX = rect.right + 8
    const leftX = rect.left - POPOVER_WIDTH - 8
    const x = rightX + POPOVER_WIDTH + 10 <= window.innerWidth
      ? rightX
      : Math.max(8, leftX)
    const y = Math.max(8, Math.min(rect.top - 4, window.innerHeight - POPOVER_HEIGHT - 8))
    setPlacement({ x, y })
  }, [])

  const preloadQrRenderer = useCallback(() => {
    if (sidebarCollapsed) return
    void preloadQrCodeFactory()
      // React treats a function passed directly to a state setter as an
      // updater. Wrap the QR factory so it is stored as a value; otherwise
      // opening the popover invokes it as an updater and leaves a non-callable
      // QR object in state, which blanks the whole app on the next render.
      .then(factory => setQrCodeFactory(() => factory))
      .catch(() => setError(copy.shareLinkFailed))
  }, [copy.shareLinkFailed, sidebarCollapsed])

  const createTicket = useCallback(async (force = false) => {
    const current = ticketRef.current
    const currentNow = Date.now()
    if (!force && shareTicketIsFresh(current, currentNow)) {
      return current
    }

    const requestSeq = requestSeqRef.current + 1
    requestSeqRef.current = requestSeq
    setLoading(true)
    setError('')
    try {
      const target = workspaceShareTargetWithCurrentReadingAnchor(shareTarget)
      const response = await fetch(appPath('/api/share/qr-ticket'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(target ? { target } : {}),
      })
      const body = await response.json() as ShareTicket | { error?: string }
      if (!response.ok || !('shortUrl' in body)) {
        throw new Error('error' in body && body.error ? body.error : copy.shareLinkFailed)
      }
      if (requestSeq !== requestSeqRef.current) {
        await revokeShareTicket(body)
        return null
      }
      setTicket(body)
      setNow(Date.now())
      setCopied(false)
      return body
    } catch (caught) {
      if (requestSeq === requestSeqRef.current) {
        setError(caught instanceof Error ? caught.message : copy.shareLinkFailed)
      }
      return null
    } finally {
      if (requestSeq === requestSeqRef.current) {
        setLoading(false)
      }
    }
  }, [copy.shareLinkFailed, shareTarget, shareTargetSignature])

  const closePopover = useCallback(() => {
    clearCloseTimer()
    requestSeqRef.current += 1
    setOpen(false)
    setPinned(false)
    setError('')
    setCopied(false)
    setLoading(false)
    const current = ticketRef.current
    ticketRef.current = null
    setTicket(null)
    void revokeShareTicket(current)
  }, [clearCloseTimer])

  const openPopover = useCallback((nextPinned: boolean, force = false) => {
    clearCloseTimer()
    updatePlacement()
    setOpen(true)
    setPinned(nextPinned)
    preloadQrRenderer()
    void createTicket(force)
  }, [clearCloseTimer, createTicket, preloadQrRenderer, updatePlacement])

  useEffect(() => {
    if (!openRequest || handledOpenRequestRef.current === openRequest) return
    handledOpenRequestRef.current = openRequest
    openPopover(true, true)
  }, [openPopover, openRequest])

  const scheduleClose = useCallback(() => {
    if (!open || pinned) return
    clearCloseTimer()
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = null
      closePopover()
    }, CLOSE_DWELL_MS)
  }, [clearCloseTimer, closePopover, open, pinned])

  const handleButtonClick = useCallback(() => {
    if (open && pinned) {
      closePopover()
      return
    }
    openPopover(true, true)
  }, [closePopover, open, openPopover, pinned])

  const handleCopy = useCallback(async () => {
    const current = shareTicketIsFresh(ticketRef.current, Date.now())
      ? ticketRef.current
      : await createTicket(true)
    if (!current) return
    const ok = await writeTerminalClipboardText(current.longUrl)
    if (!ok) {
      setError(copy.copyFailed)
      return
    }
    setCopied(true)
    if (copiedTimerRef.current !== null) {
      window.clearTimeout(copiedTimerRef.current)
    }
    copiedTimerRef.current = window.setTimeout(() => {
      setCopied(false)
      copiedTimerRef.current = null
    }, 1800)
  }, [copy.copyFailed, createTicket])

  useLayoutEffect(() => {
    if (!open) return undefined
    updatePlacement()
    window.addEventListener('resize', updatePlacement)
    return () => window.removeEventListener('resize', updatePlacement)
  }, [open, updatePlacement])

  useEffect(() => {
    if (!open) return undefined
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [open])

  useEffect(() => {
    const current = ticketRef.current
    if (!current) return
    ticketRef.current = null
    setTicket(null)
    setCopied(false)
    void revokeShareTicket(current)
  }, [shareTargetSignature])

  useLayoutEffect(() => {
    if (!open) return undefined

    const updateTokenFit = () => {
      const display = tokenDisplayRef.current
      const measure = tokenMeasureRef.current
      if (!display || !measure) return
      setSingleLineTokenFits(measure.scrollWidth <= display.clientWidth + 1)
    }

    updateTokenFit()
    const observer = typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(updateTokenFit)
      : null
    if (observer && tokenDisplayRef.current) {
      observer.observe(tokenDisplayRef.current)
    }
    window.addEventListener('resize', updateTokenFit)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', updateTokenFit)
    }
  }, [open, ticket?.tokenLabel, ticket?.shortPath])

  useEffect(() => {
    if (!open) return undefined

    const closeSharePopoverOnOutsidePointerDown = (event: PointerEvent) => {
      const target = event.target
      if (target instanceof Node && rootRef.current?.contains(target)) return
      closePopover()
    }
    const closeSharePopoverOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closePopover()
    }

    document.addEventListener('pointerdown', closeSharePopoverOnOutsidePointerDown, true)
    document.addEventListener('keydown', closeSharePopoverOnEscape, true)
    return () => {
      document.removeEventListener('pointerdown', closeSharePopoverOnOutsidePointerDown, true)
      document.removeEventListener('keydown', closeSharePopoverOnEscape, true)
    }
  }, [closePopover, open])

  useEffect(() => () => {
    clearCloseTimer()
    if (copiedTimerRef.current !== null) {
      window.clearTimeout(copiedTimerRef.current)
    }
    requestSeqRef.current += 1
    void revokeShareTicket(ticketRef.current)
  }, [clearCloseTimer])

  const expired = Boolean(ticket && ticket.expiresAt <= now)
  const countdown = ticket ? formatCountdown(ticket.expiresAt - now) : ''
  const tokenLabel = ticket?.tokenLabel || ticket?.shortPath || copy.copyFullShareLink
  const tokenParts = tokenDisplayLines(tokenLabel)
  const tokenLines = singleLineTokenFits || tokenParts.length <= 1 ? [tokenLabel] : tokenParts

  return (
    <div
      ref={rootRef}
      className="code-share-root"
      onMouseEnter={preloadQrRenderer}
      onMouseLeave={scheduleClose}
      onFocus={() => {
        clearCloseTimer()
        preloadQrRenderer()
      }}
      onBlur={event => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null) && !pinned) {
          closePopover()
        }
      }}
    >
      <button
        ref={buttonRef}
        type="button"
        className="code-share-button"
        data-testid="code-share-button"
        aria-label={copy.sharePage}
        title={copy.sharePage}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={handleButtonClick}
      >
        <QrGlyph className="code-share-icon" />
      </button>
      {open && (
        <div
          className="code-share-popover"
          data-testid="code-share-popover"
          role="dialog"
          aria-label={copy.scanToOpenOnPhone}
          style={{ left: placement.x, top: placement.y }}
          onMouseEnter={() => {
            clearCloseTimer()
          }}
          onMouseLeave={scheduleClose}
          onKeyDown={event => {
            if (event.key === 'Escape') {
              closePopover()
              buttonRef.current?.focus()
            }
          }}
        >
          <div className="code-share-qr-frame" data-expired={expired ? 'true' : 'false'}>
            <div className="code-share-qr-canvas">
              {ticket && !loading && qrCodeFactory ? (
                <FarmingQrCode value={ticket.shortUrl} badgeUrl={badgeUrl} qrCodeFactory={qrCodeFactory} />
              ) : (
                <div className="code-share-qr-loading">{loading ? copy.loading : copy.shareLinkFailed}</div>
              )}
            </div>
            {ticket && (
              <div className="code-share-countdown">
                {expired ? copy.shareLinkExpired : countdown}
              </div>
            )}
            {expired && (
              <button type="button" className="code-share-refresh" onClick={() => void createTicket(true)}>
                {copy.refreshShareLink}
              </button>
            )}
          </div>
          <button
            type="button"
            className="code-share-copy-token"
            data-testid="code-share-copy-link"
            disabled={!ticket && loading}
            onClick={() => void handleCopy()}
          >
            <span
              ref={tokenDisplayRef}
              className={`code-share-token ${singleLineTokenFits ? 'single-line' : ''}`}
              aria-label={tokenLabel}
            >
              <span ref={tokenMeasureRef} className="code-share-token-measure" aria-hidden="true">{tokenLabel}</span>
              {tokenLines.map((line, index) => (
                <span key={`${index}-${line}`} className="code-share-token-line">{line}</span>
              ))}
            </span>
            <span className="code-share-copy-action">{copied ? copy.copiedShareLink : copy.copyFullShareLink}</span>
          </button>
          {error && <div className="code-share-error" role="status">{error}</div>}
        </div>
      )}
    </div>
  )
}
