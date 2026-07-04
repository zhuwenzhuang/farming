/**
 * Terminal key sequence mapping and browser shortcut detection.
 * Pure functions, no React dependencies.
 */

const IS_MAC = typeof navigator !== 'undefined'
  && navigator.platform.toLowerCase().includes('mac')

export function isBrowserShortcut(e: KeyboardEvent): boolean {
  const pressed = e.key.toLowerCase()
  const primary = IS_MAC ? e.metaKey : e.ctrlKey
  const wrongPrimary = IS_MAC ? e.ctrlKey : e.metaKey

  if (wrongPrimary || !primary) {
    if (!IS_MAC && e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && pressed === 'f4') {
      return true
    }
    return false
  }

  const noMod = !e.shiftKey && !e.altKey
  const withShift = e.shiftKey && !e.altKey
  const withAlt = e.altKey && !e.shiftKey

  const baseKeys = IS_MAC
    ? ['t', 'n', 'w', 'q', 'h', 'm', ',']
    : ['t', 'n', 'w', 'h']
  const shiftKeys = IS_MAC
    ? ['t', 'n', 'a', 'z', ']', '[', 'j', 'c']
    : ['t', 'n', 'j', 'c']
  const altKeys = IS_MAC ? ['w'] : []

  if (noMod && (baseKeys.includes(pressed) || /^[0-9]$/.test(e.key) || ['c', 'x', 'v'].includes(pressed))) {
    return true
  }
  if (withShift && shiftKeys.includes(pressed)) return true
  if (withAlt && altKeys.includes(pressed)) return true

  return false
}

export function isPrimaryModifier(e: KeyboardEvent): boolean {
  return IS_MAC ? e.metaKey : e.ctrlKey
}

export function isCopyShortcut(e: KeyboardEvent): boolean {
  return isPrimaryModifier(e) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'c'
}

export function isPasteShortcut(e: KeyboardEvent): boolean {
  return isPrimaryModifier(e) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'v'
}

export function getControlChar(key: string): string | null {
  const lower = key.toLowerCase()
  if (!/^[a-z]$/.test(lower)) return null
  return String.fromCharCode(lower.charCodeAt(0) - 96)
}

export function getTerminalSequenceForKey(e: KeyboardEvent): string | null {
  const { key, shiftKey, altKey, ctrlKey, metaKey } = e

  if (metaKey) return null

  if (altKey && !ctrlKey) {
    if (key === 'ArrowLeft') return '\x1bb'
    if (key === 'ArrowRight') return '\x1bf'
    if (key === 'Backspace') return '\x17'
  }

  switch (key) {
    case 'Enter': return '\r'
    case 'Backspace': return '\x7f'
    case 'Tab': return shiftKey ? '\x1b[Z' : '\t'
    case 'Delete': return '\x1b[3~'
    case 'ArrowUp': return '\x1b[A'
    case 'ArrowDown': return '\x1b[B'
    case 'ArrowRight': return '\x1b[C'
    case 'ArrowLeft': return '\x1b[D'
    case 'Home': return '\x1b[H'
    case 'End': return '\x1b[F'
    case 'PageUp': return '\x1b[5~'
    case 'PageDown': return '\x1b[6~'
    default: return null
  }
}
