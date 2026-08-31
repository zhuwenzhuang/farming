import { useLayoutEffect, type RefObject } from 'react'

/** Menu placement may start from an estimate; acceptance uses rendered geometry.
 * Only fixed menus opt in. This does not own dismissal or selection state. */
export function useMenuViewportBounds(enabled: boolean, menuRef: RefObject<HTMLElement | null>, positionKey?: unknown) {
  useLayoutEffect(() => {
    const menu = menuRef.current
    if (!enabled || !menu) return
    const owner = menu.ownerDocument.defaultView
    if (!owner) return
    const constrain = () => {
      menu.style.maxHeight = `${Math.max(0, owner.innerHeight - 16)}px`
      menu.style.maxWidth = `${Math.max(0, owner.innerWidth - 16)}px`
      if (menu.scrollHeight > owner.innerHeight - 16) menu.style.overflowY = 'auto'
      const rect = menu.getBoundingClientRect()
      const left = Math.max(8, Math.min(rect.left, owner.innerWidth - rect.width - 8))
      const top = Math.max(8, Math.min(rect.top, owner.innerHeight - rect.height - 8))
      if (Math.abs(left - rect.left) > 0.5) menu.style.left = `${left}px`
      if (Math.abs(top - rect.top) > 0.5) menu.style.top = `${top}px`
    }
    constrain()
    const observer = new ResizeObserver(constrain)
    observer.observe(menu)
    owner.addEventListener('resize', constrain)
    return () => {
      observer.disconnect()
      owner.removeEventListener('resize', constrain)
    }
  }, [enabled, menuRef, positionKey])
}
