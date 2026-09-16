import { useId, useLayoutEffect, type ReactNode, type RefObject } from 'react'
import { useInteractionLayer } from '@/hooks/useInteractionLayer'
import { isCompactViewport } from '@/lib/responsive-mode'

/** Read-only entity details. The caller owns visibility; this shell owns geometry. */
export function InfoCard({ surfaceRef: ref, anchor, testId, icon, title, meta, children, onKeepOpen, onLeave, onDismiss }: {
  surfaceRef: RefObject<HTMLDivElement | null>
  anchor: HTMLElement
  testId: string
  icon: ReactNode
  title: string
  meta?: ReactNode
  children: ReactNode
  onKeepOpen: () => void
  onLeave: () => void
  onDismiss: () => void
}) {
  const id = useId()
  useInteractionLayer({
    enabled: true,
    elements: () => [anchor, ref.current],
    onDismiss,
  })
  useLayoutEffect(() => {
    const card = ref.current
    const owner = anchor.ownerDocument.defaultView
    if (!card || !owner) return
    const viewport = owner.visualViewport
    const place = () => {
      if (isCompactViewport() || !anchor.isConnected || anchor.closest('[inert]') || !anchor.getClientRects().length) {
        onDismiss()
        return
      }
      const style = getComputedStyle(card)
      const gutter = parseFloat(style.getPropertyValue('--code-info-card-viewport-gap'))
      const gap = parseFloat(style.getPropertyValue('--code-info-card-anchor-gap'))
      const left = (viewport?.offsetLeft ?? 0) + gutter
      const top = (viewport?.offsetTop ?? 0) + gutter
      const right = left + (viewport?.width ?? owner.innerWidth) - gutter * 2
      const bottom = top + (viewport?.height ?? owner.innerHeight) - gutter * 2
      card.style.maxWidth = `${Math.max(0, right - left)}px`
      card.style.maxHeight = `${Math.max(0, bottom - top)}px`
      const target = anchor.getBoundingClientRect()
      const rect = card.getBoundingClientRect()
      const x = target.right + gap + rect.width <= right
        ? target.right + gap
        : target.left - gap - rect.width
      card.style.left = `${Math.max(left, Math.min(x, right - rect.width))}px`
      card.style.top = `${Math.max(top, Math.min(target.top, bottom - rect.height))}px`
    }
    const describedBy = anchor.getAttribute('aria-describedby')
    anchor.setAttribute('aria-describedby', [describedBy, id].filter(Boolean).join(' '))
    place()
    const observer = new ResizeObserver(place)
    observer.observe(card)
    observer.observe(anchor)
    owner.addEventListener('resize', place)
    owner.addEventListener('scroll', place, true)
    viewport?.addEventListener('resize', place)
    viewport?.addEventListener('scroll', place)
    return () => {
      const remaining = anchor.getAttribute('aria-describedby')?.split(' ').filter(value => value !== id).join(' ')
      if (remaining) anchor.setAttribute('aria-describedby', remaining)
      else anchor.removeAttribute('aria-describedby')
      observer.disconnect()
      owner.removeEventListener('resize', place)
      owner.removeEventListener('scroll', place, true)
      viewport?.removeEventListener('resize', place)
      viewport?.removeEventListener('scroll', place)
    }
  }, [anchor, id, onDismiss, ref])
  return (
    <div ref={ref} id={id} role="tooltip" className="code-info-card" data-testid={testId}
      onMouseEnter={onKeepOpen} onMouseDown={onKeepOpen} onMouseLeave={onLeave}>
      <div className="code-info-card-header">
        <span className="code-info-card-icon">{icon}</span>
        <strong>{title}</strong>
        {meta && <span className="code-info-card-meta">{meta}</span>}
      </div>
      {children}
    </div>
  )
}

export function InfoCardRow({ icon, children, secondary = false, testId }: {
  icon: ReactNode
  children: ReactNode
  secondary?: boolean
  testId?: string
}) {
  return (
    <div className={`code-info-card-row${secondary ? ' secondary' : ''}`} data-testid={testId}>
      <span className="code-info-card-icon">{icon}</span>
      <span>{children}</span>
    </div>
  )
}
