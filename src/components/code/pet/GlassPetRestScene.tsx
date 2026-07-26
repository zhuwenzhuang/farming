import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

interface GlassPetRestSceneProps {
  title: string
  body: string
  endLabel: string
  restUntil: number
  active: boolean
  onEnd: () => void
}

function formatRemainingTime(restUntil: number, now: number) {
  const remainingSeconds = Math.max(0, Math.ceil((restUntil - now) / 1000))
  const minutes = Math.floor(remainingSeconds / 60)
  const seconds = remainingSeconds % 60
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

export function GlassPetRestScene({
  title,
  body,
  endLabel,
  restUntil,
  active,
  onEnd,
}: GlassPetRestSceneProps) {
  const [now, setNow] = useState(Date.now)
  const endButtonRef = useRef<HTMLButtonElement>(null)
  const descriptionId = `code-pet-glass-rest-${useId().replace(/:/g, '')}`

  useEffect(() => {
    if (!active) return undefined
    setNow(Date.now())
    const interval = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(interval)
  }, [active, restUntil])

  useEffect(() => {
    const appRoot = document.getElementById('root')
    const previousFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null
    const previousInert = appRoot?.inert ?? false
    const previousAriaHidden = appRoot?.getAttribute('aria-hidden') ?? null
    if (appRoot) {
      appRoot.inert = true
      appRoot.setAttribute('aria-hidden', 'true')
    }
    const focusFrame = window.requestAnimationFrame(() => {
      endButtonRef.current?.focus({ preventScroll: true })
    })
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopImmediatePropagation()
      onEnd()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => {
      window.cancelAnimationFrame(focusFrame)
      window.removeEventListener('keydown', onKeyDown, true)
      if (appRoot) {
        appRoot.inert = previousInert
        if (previousAriaHidden === null) appRoot.removeAttribute('aria-hidden')
        else appRoot.setAttribute('aria-hidden', previousAriaHidden)
      }
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true })
    }
  }, [onEnd])

  if (typeof document === 'undefined') return null

  return createPortal(
    <section
      className="code-pet-glass-rest-overlay"
      data-pet-ui
      data-testid="pet-rest-scene"
      data-pet-appearance="glass"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      aria-describedby={descriptionId}
    >
      <div className="code-pet-glass-rest-content">
        <time className="code-pet-glass-rest-time">
          {formatRemainingTime(restUntil, now)}
        </time>
        <strong>{title}</strong>
        <p id={descriptionId}>{body}</p>
        <div className="code-pet-glass-rest-actions">
          <button ref={endButtonRef} type="button" onClick={onEnd}>{endLabel}</button>
        </div>
      </div>
    </section>,
    document.body,
  )
}
