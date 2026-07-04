import { useCallback, useEffect, useLayoutEffect, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from 'react'

interface UseWorkspaceMenuKeyboardOptions {
  menuOpen: boolean
  menuRef: RefObject<HTMLElement | null>
  onClose: () => void
  onCloseWithFocusRestore?: () => void
}

function focusFirstWorkspaceMenuItem(menu: HTMLElement | null) {
  if (!menu || menu.contains(document.activeElement)) return
  menu.querySelector<HTMLButtonElement>('button[role="menuitem"]:not(:disabled)')?.focus()
}

export function useWorkspaceMenuKeyboard({
  menuOpen,
  menuRef,
  onClose,
  onCloseWithFocusRestore = onClose,
}: UseWorkspaceMenuKeyboardOptions) {
  const handleMenuKeyDown = useCallback((event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      onCloseWithFocusRestore()
      return
    }

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
  }, [menuRef, onCloseWithFocusRestore])

  useEffect(() => {
    if (!menuOpen) return undefined

    const focusFirstMenuItem = () => focusFirstWorkspaceMenuItem(menuRef.current)
    const frameId = window.requestAnimationFrame(focusFirstMenuItem)
    const timeoutId = window.setTimeout(focusFirstMenuItem, 120)
    const lateTimeoutId = window.setTimeout(focusFirstMenuItem, 260)
    const closeMenu = (event: PointerEvent) => {
      if (menuRef.current?.contains(event.target as Node)) return
      onClose()
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCloseWithFocusRestore()
    }

    document.addEventListener('pointerdown', closeMenu)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      window.cancelAnimationFrame(frameId)
      window.clearTimeout(timeoutId)
      window.clearTimeout(lateTimeoutId)
      document.removeEventListener('pointerdown', closeMenu)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [menuOpen, menuRef, onClose, onCloseWithFocusRestore])

  useLayoutEffect(() => {
    if (!menuOpen) return
    menuRef.current?.querySelector<HTMLButtonElement>('button[role="menuitem"]:not(:disabled)')?.focus()
  }, [menuOpen, menuRef])

  return handleMenuKeyDown
}
