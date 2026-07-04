import { useEffect } from 'react'

export interface Shortcut {
  key: string
  ctrl?: boolean
  meta?: boolean
  shift?: boolean
  allowInInput?: boolean
  allowInTerminal?: boolean
  allowInOverlay?: boolean
  handler: (e: KeyboardEvent) => void
}

export function isTerminalShortcutTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false
  return Boolean(target.closest('.terminal-session-host, .code-terminal-container'))
}

export function isTextEditingShortcutTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false
  return target.tagName === 'INPUT'
    || target.tagName === 'TEXTAREA'
    || target.isContentEditable
    || Boolean(target.closest('.code-file-editor, .monaco-editor'))
}

export function isDialogShortcutTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false
  return Boolean(target.closest('[role="dialog"]'))
}

export function isMenuShortcutTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false
  return Boolean(target.closest('[role="menu"]'))
}

export function isOverlayShortcutTarget(target: EventTarget | null) {
  return isDialogShortcutTarget(target) || isMenuShortcutTarget(target)
}

export function hasOpenOverlayShortcutTarget() {
  return Boolean(document.querySelector('[role="dialog"], [role="menu"], .code-context-menu, .code-file-context-menu'))
}

/**
 * Register global keyboard shortcuts.
 * Shortcuts are only active when `enabled` is true.
 * Each shortcut can optionally require ctrl/meta/shift modifiers.
 */
export function useKeyboard(shortcuts: Shortcut[], enabled: boolean = true) {
  useEffect(() => {
    if (!enabled) return

    function handleKeyDown(e: KeyboardEvent) {
      // Don't intercept when typing in input/textarea
      const target = e.target
      const isTypingTarget = isTextEditingShortcutTarget(target)
      const isTerminalTarget = isTerminalShortcutTarget(target)
      const isOverlayTarget = isOverlayShortcutTarget(target) || hasOpenOverlayShortcutTarget()

      for (const shortcut of shortcuts) {
        if (isOverlayTarget && !shortcut.allowInOverlay) continue
        if (isTypingTarget && !shortcut.allowInInput) continue
        if (isTerminalTarget && !shortcut.allowInTerminal) continue

        const keyMatch = e.key.toLowerCase() === shortcut.key.toLowerCase()
        const modifierMatch = shortcut.meta
          ? e.metaKey && !e.ctrlKey
          : shortcut.ctrl
            ? (e.ctrlKey || e.metaKey)
            : !(e.ctrlKey || e.metaKey)
        const shiftMatch = shortcut.shift ? e.shiftKey : !e.shiftKey
        const altMatch = !e.altKey

        if (keyMatch && modifierMatch && shiftMatch && altMatch) {
          e.preventDefault()
          shortcut.handler(e)
          return
        }
      }
    }

    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [shortcuts, enabled])
}
