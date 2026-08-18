import type { MouseEvent as ReactMouseEvent } from 'react'

export interface ShareNoticeAnchor {
  x: number
  y: number
  placement: 'above' | 'below'
  alignment: 'center' | 'right'
}

export function shareNoticeAnchor(event: ReactMouseEvent<HTMLElement>): ShareNoticeAnchor {
  const bounds = event.currentTarget.getBoundingClientRect()
  const x = bounds.left + bounds.width / 2
  const placement = bounds.top < 64 ? 'below' : 'above'
  const y = placement === 'above' ? bounds.top : bounds.bottom
  const alignment = x > window.innerWidth - 180 ? 'right' : 'center'
  return { x, y, placement, alignment }
}
