import { useMenuViewportBounds } from '@/hooks/useMenuViewportBounds'
import { useInteractionLayer } from '@/hooks/useInteractionLayer'
import { useCallback, useEffect, useLayoutEffect, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from 'react'

interface UseWorkspaceMenuKeyboardOptions {
  menuOpen: boolean
  positionKey?: unknown
  menuRef: RefObject<HTMLElement | null>
  onClose: () => void
  onCloseWithFocusRestore?: () => void
  focusFirstItem?: boolean
}

function focusFirstWorkspaceMenuItem(menu: HTMLElement | null) {
  if (!menu) return
  const activeElement = document.activeElement
  if (
    activeElement instanceof HTMLButtonElement &&
    menu.contains(activeElement) &&
    activeElement.matches('button[role="menuitem"]:not(:disabled)')
  ) return
  menu.querySelector<HTMLButtonElement>('button[role="menuitem"]:not(:disabled)')?.focus()
}

export function useWorkspaceMenuKeyboard({
  menuOpen,
  positionKey,
  menuRef,
  onClose,
  onCloseWithFocusRestore = onClose,
  focusFirstItem = false,
}: UseWorkspaceMenuKeyboardOptions) {
  useMenuViewportBounds(menuOpen, menuRef, positionKey)
  const handleMenuKeyDown = useCallback((event: ReactKeyboardEvent<HTMLElement>) => {
    const isNavigationKey = event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Home' || event.key === 'End'
    if (!isNavigationKey) return

    const menuItems = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]:not(:disabled)') ?? [])
    if (menuItems.length === 0) return
    const currentIndex = menuItems.indexOf(document.activeElement as HTMLButtonElement)
    const nextIndex = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? menuItems.length - 1
        : event.key === 'ArrowUp'
          ? (currentIndex - 1 + menuItems.length) % menuItems.length
          : (currentIndex + 1) % menuItems.length

    event.preventDefault()
    event.stopPropagation()
    menuItems[nextIndex]?.focus()
  }, [menuRef])

  useInteractionLayer({
    enabled: menuOpen,
    elements: () => [menuRef.current],
    onDismiss: reason => {
      if (reason === 'escape') onCloseWithFocusRestore()
      else onClose()
    },
  })

  useEffect(() => {
    if (!menuOpen) return undefined

    const focusFirstMenuItem = () => focusFirstWorkspaceMenuItem(menuRef.current)
    const frameId = focusFirstItem ? window.requestAnimationFrame(focusFirstMenuItem) : undefined
    const timeoutId = focusFirstItem ? window.setTimeout(focusFirstMenuItem, 120) : undefined
    const lateTimeoutId = focusFirstItem ? window.setTimeout(focusFirstMenuItem, 260) : undefined
    return () => {
      if (frameId !== undefined) window.cancelAnimationFrame(frameId)
      if (timeoutId !== undefined) window.clearTimeout(timeoutId)
      if (lateTimeoutId !== undefined) window.clearTimeout(lateTimeoutId)
    }
  }, [focusFirstItem, menuOpen, menuRef])

  useLayoutEffect(() => {
    if (!menuOpen || !focusFirstItem) return
    menuRef.current?.querySelector<HTMLButtonElement>('button[role="menuitem"]:not(:disabled)')?.focus()
  }, [focusFirstItem, menuOpen, menuRef])

  return handleMenuKeyDown
}
