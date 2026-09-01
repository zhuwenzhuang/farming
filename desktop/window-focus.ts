export interface DesktopFocusableWindow {
  focus(): void
  isDestroyed(): boolean
  isMinimized(): boolean
  restore(): void
  show(): void
}

/**
 * Focuses the existing primary window without allocating another Desktop
 * lifecycle owner. A minimized window must be restored before it can receive
 * keyboard focus.
 */
export function focusDesktopWindow(window: DesktopFocusableWindow | null) {
  if (!window || window.isDestroyed()) return false
  if (window.isMinimized()) window.restore()
  window.show()
  window.focus()
  return true
}
