import { useEffect, useRef, type RefObject } from 'react'

const FOCUSABLE_SELECTOR = [
  'button:not(:disabled)',
  'a[href]',
  'input:not(:disabled)',
  'select:not(:disabled)',
  'textarea:not(:disabled)',
  'summary',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

export function useModalFocusScope<TDialog extends HTMLElement = HTMLElement>({
  open,
  initialFocusRef,
  returnFocusRef,
  onEscape,
  escapeEnabled = true,
}: {
  open: boolean
  initialFocusRef: RefObject<HTMLElement | null>
  returnFocusRef: RefObject<HTMLElement | null>
  onEscape: () => void
  escapeEnabled?: boolean
}) {
  const dialogRef = useRef<TDialog | null>(null)
  const onEscapeRef = useRef(onEscape)
  const escapeEnabledRef = useRef(escapeEnabled)
  onEscapeRef.current = onEscape
  escapeEnabledRef.current = escapeEnabled

  useEffect(() => {
    if (!open) return undefined
    const appRoot = document.getElementById('root')
    const returnFocusTarget = returnFocusRef.current
    const previousInert = appRoot?.inert ?? false
    const previousAriaHidden = appRoot?.getAttribute('aria-hidden') ?? null
    if (appRoot) {
      appRoot.inert = true
      appRoot.setAttribute('aria-hidden', 'true')
    }
    initialFocusRef.current?.focus({ preventScroll: true })

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopImmediatePropagation()
        if (escapeEnabledRef.current) onEscapeRef.current()
        return
      }
      if (event.key !== 'Tab') return
      const focusable = Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR) ?? [],
      ).filter(element => element.getAttribute('aria-hidden') !== 'true')
      event.preventDefault()
      event.stopImmediatePropagation()
      if (focusable.length === 0) return
      const activeIndex = focusable.indexOf(document.activeElement as HTMLElement)
      const nextIndex = event.shiftKey
        ? (activeIndex <= 0 ? focusable.length - 1 : activeIndex - 1)
        : (activeIndex === -1 || activeIndex === focusable.length - 1 ? 0 : activeIndex + 1)
      focusable[nextIndex]?.focus({ preventScroll: true })
    }

    window.addEventListener('keydown', handleKeyDown, true)
    return () => {
      window.removeEventListener('keydown', handleKeyDown, true)
      if (appRoot) {
        appRoot.inert = previousInert
        if (previousAriaHidden === null) appRoot.removeAttribute('aria-hidden')
        else appRoot.setAttribute('aria-hidden', previousAriaHidden)
      }
      if (returnFocusTarget?.isConnected) returnFocusTarget.focus({ preventScroll: true })
    }
  }, [initialFocusRef, open, returnFocusRef])

  return dialogRef
}
