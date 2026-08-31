import { useLayoutEffect, type RefObject } from 'react'

/** Menu placement may start from an estimate; acceptance uses rendered geometry.
 * Supports fixed menus and anchored absolute submenus, without owning dismissal. */
export function useMenuViewportBounds(enabled: boolean, menuRef: RefObject<HTMLElement | null>, positionKey?: unknown) {
  useLayoutEffect(() => {
    const menu = menuRef.current
    if (!enabled || !menu) return
    const owner = menu.ownerDocument.defaultView
    if (!owner) return
    const visualViewport = owner.visualViewport
    const constrain = () => {
      const viewportLeft = visualViewport?.offsetLeft ?? 0
      const viewportTop = visualViewport?.offsetTop ?? 0
      const viewportWidth = visualViewport?.width ?? owner.innerWidth
      const viewportHeight = visualViewport?.height ?? owner.innerHeight
      menu.style.maxHeight = `${Math.max(0, viewportHeight - 16)}px`
      menu.style.maxWidth = `${Math.max(0, viewportWidth - 16)}px`
      if (menu.scrollHeight > viewportHeight - 16) menu.style.overflowY = 'auto'
      const rect = menu.getBoundingClientRect()
      const left = Math.max(viewportLeft + 8, Math.min(rect.left, viewportLeft + viewportWidth - rect.width - 8))
      const top = Math.max(viewportTop + 8, Math.min(rect.top, viewportTop + viewportHeight - rect.height - 8))
      // Apply the measured viewport correction in the menu's own coordinate
      // system. Absolute submenus have a positioned parent, unlike fixed menus.
      if (Math.abs(left - rect.left) > 0.5) {
        menu.style.left = `${menu.offsetLeft + left - rect.left}px`
        menu.style.right = 'auto'
      }
      if (Math.abs(top - rect.top) > 0.5) menu.style.top = `${menu.offsetTop + top - rect.top}px`
    }
    constrain()
    const observer = new ResizeObserver(constrain)
    observer.observe(menu)
    owner.addEventListener('resize', constrain)
    visualViewport?.addEventListener('resize', constrain)
    visualViewport?.addEventListener('scroll', constrain)
    return () => {
      observer.disconnect()
      owner.removeEventListener('resize', constrain)
      visualViewport?.removeEventListener('resize', constrain)
      visualViewport?.removeEventListener('scroll', constrain)
    }
  }, [enabled, menuRef, positionKey])
}
