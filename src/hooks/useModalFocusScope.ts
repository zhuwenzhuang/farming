import { useEffect, useRef, type RefObject } from 'react'
import { useInteractionLayer } from './useInteractionLayer'
import { isTopModalInteractionLayer, type InteractionDismissReason } from '@/lib/interaction-layer'

const modalIsolation = new WeakMap<HTMLElement, { count: number; inert: boolean; ariaHidden: string | null }>()

function isolateModalBackground(root: HTMLElement | null) {
  if (!root) return () => {}
  const state = modalIsolation.get(root) ?? { count: 0, inert: root.inert, ariaHidden: root.getAttribute('aria-hidden') }
  state.count += 1
  modalIsolation.set(root, state)
  root.inert = true
  root.setAttribute('aria-hidden', 'true')
  return () => {
    state.count -= 1
    if (state.count > 0) return
    root.inert = state.inert
    if (state.ariaHidden === null) root.removeAttribute('aria-hidden')
    else root.setAttribute('aria-hidden', state.ariaHidden)
    modalIsolation.delete(root)
  }
}

function isolateDialogBackground(dialog: HTMLElement | null) {
  const root = document.getElementById('root')
  if (!dialog || !root) return () => {}
  if (!root.contains(dialog)) return isolateModalBackground(root)
  // Legacy inline dialogs keep their ancestor path interactive. Isolate only
  // its sibling branches; portalled dialogs continue to isolate the whole root.
  const releases: Array<() => void> = []
  for (let branch: HTMLElement = dialog; branch !== root && branch.parentElement; branch = branch.parentElement) {
    for (const sibling of branch.parentElement.children) {
      if (sibling !== branch && sibling instanceof HTMLElement) releases.push(isolateModalBackground(sibling))
    }
  }
  return () => releases.reverse().forEach(release => release())
}

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
  dismissOnPointerOutside = false,
  dialogRef: suppliedDialogRef,
}: {
  open: boolean
  initialFocusRef?: RefObject<HTMLElement | null>
  returnFocusRef?: RefObject<HTMLElement | null>
  dialogRef?: RefObject<TDialog | null>
  onEscape: (reason: InteractionDismissReason) => void
  escapeEnabled?: boolean
  dismissOnPointerOutside?: boolean
}) {
  const localDialogRef = useRef<TDialog | null>(null)
  const dialogRef = suppliedDialogRef ?? localDialogRef
  const outsideDismissRef = useRef(false)

  useInteractionLayer({
    enabled: open,
    modal: true,
    elements: () => [dialogRef.current],
    dismissOnPointerOutside,
    dismissOnEscape: escapeEnabled,
    onDismiss: reason => {
      outsideDismissRef.current = reason === 'outside-pointer'
      onEscape(reason)
    },
  })

  useEffect(() => {
    if (!open) return undefined
    outsideDismissRef.current = false
    const returnFocusTarget = returnFocusRef?.current
    const releaseIsolation = isolateDialogBackground(dialogRef.current)
    if (initialFocusRef?.current) initialFocusRef.current.focus({ preventScroll: true })
    else if (!dialogRef.current?.contains(document.activeElement)) {
      dialogRef.current?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR)?.focus({ preventScroll: true })
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.key !== 'Tab' || !isTopModalInteractionLayer(dialogRef.current)) return
      const focusable = Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR) ?? [],
      ).filter(element => element.getAttribute('aria-hidden') !== 'true' && element.getClientRects().length > 0 && !element.closest('[inert]'))
      event.preventDefault()
      event.stopImmediatePropagation()
      if (focusable.length === 0) return
      const activeIndex = focusable.indexOf(document.activeElement as HTMLElement)
      const nextIndex = event.shiftKey
        ? (activeIndex <= 0 ? focusable.length - 1 : activeIndex - 1)
        : (activeIndex === -1 || activeIndex === focusable.length - 1 ? 0 : activeIndex + 1)
      focusable[nextIndex]?.focus({ preventScroll: true })
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      releaseIsolation()
      if (!outsideDismissRef.current && returnFocusTarget?.isConnected && !returnFocusTarget.closest('[inert]')) {
        returnFocusTarget.focus({ preventScroll: true })
      }
    }
  }, [dialogRef, initialFocusRef, open, returnFocusRef])

  return dialogRef
}
