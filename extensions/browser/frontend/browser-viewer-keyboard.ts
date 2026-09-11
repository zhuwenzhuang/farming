import type { BrowserViewerInputMessage } from '../../../shared/browser-viewer-input'

interface KeyInput {
  key: string
  code: string
  altKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
  repeat: boolean
  location: number
  isComposing?: boolean
}

export function browserInputModifiers(event: Pick<KeyInput, 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey'>) {
  return (event.altKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) | (event.metaKey ? 4 : 0) | (event.shiftKey ? 8 : 0)
}

/** Focus/composition and the matching physical release have one local owner. */
export class BrowserViewerKeyboard {
  private pressed = new Map<string, string>()

  key(event: KeyInput, action: 'down' | 'up'): BrowserViewerInputMessage | null {
    const identity = event.code || event.key
    if (action === 'up') {
      const key = this.pressed.get(identity)
      if (!key) return null
      this.pressed.delete(identity)
      return { type: 'key', action, key, code: event.code, modifiers: browserInputModifiers(event), location: event.location }
    }
    if (event.isComposing || ['Process', 'Dead', 'Unidentified'].includes(event.key)) return null
    // Native paste supplies text; copy/cut use the explicit selection transfer.
    if ((event.ctrlKey || event.metaKey) && ['c', 'x', 'v'].includes(event.key.toLowerCase())) return null
    this.pressed.set(identity, event.key)
    return {
      type: 'key', action, key: event.key, code: event.code,
      modifiers: browserInputModifiers(event), repeat: event.repeat, location: event.location,
      text: event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey ? event.key : '',
    }
  }

  reset() { this.pressed.clear() }
}

export class BrowserViewerClicks {
  private last = { button: -1, x: 0, y: 0, time: -Infinity, count: 0 }
  down(button: number, x: number, y: number, time: number) {
    const repeated = button === this.last.button && time - this.last.time < 500
      && Math.hypot(x - this.last.x, y - this.last.y) < 5
    this.last = { button, x, y, time, count: repeated ? this.last.count % 3 + 1 : 1 }
    return this.last.count
  }
  get count() { return this.last.count || 1 }
}

export async function writeBrowserClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text)
    return
  }
  // HTTP deployments cannot use the secure-context Clipboard API. This still
  // requires browser-granted user activation and fails explicitly if denied.
  const previous = document.activeElement
  const field = document.createElement('textarea')
  field.value = text
  field.setAttribute('aria-label', 'Copy selected browser text')
  field.style.cssText = 'position:fixed;left:-10000px;top:0'
  document.body.append(field)
  try {
    field.select()
    if (!document.execCommand('copy')) throw new Error('Clipboard access was denied by this browser.')
  } finally {
    field.remove()
    if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true })
  }
}
