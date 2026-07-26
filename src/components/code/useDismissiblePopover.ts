import type { RefObject } from 'react'
import { useEffect } from 'react'

export function useDismissiblePopover(
  open: boolean,
  popoverRef: RefObject<HTMLElement | null>,
  anchorRef: RefObject<HTMLElement | null>,
  onDismiss: () => void,
) {
  useEffect(() => {
    if (!open) return
    const closeOnPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null
      if (target && (popoverRef.current?.contains(target) || anchorRef.current?.contains(target))) return
      onDismiss()
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      onDismiss()
      anchorRef.current?.focus()
    }
    window.addEventListener('pointerdown', closeOnPointerDown, true)
    window.addEventListener('keydown', closeOnEscape, true)
    return () => {
      window.removeEventListener('pointerdown', closeOnPointerDown, true)
      window.removeEventListener('keydown', closeOnEscape, true)
    }
  }, [anchorRef, onDismiss, open, popoverRef])
}
