import type {} from '../types/desktop'

export interface TerminalClipboardProvider {
  readText: (selection: string) => Promise<string> | string
  writeText: (selection: string, text: string) => Promise<void> | undefined
}

const RECENT_CLIPBOARD_WRITE_TTL_MS = 2 * 60 * 1000
let recentClipboardWrite: { text: string, writtenAt: number } | null = null

export function readRecentClipboardWrite(now = Date.now()) {
  if (!recentClipboardWrite || now - recentClipboardWrite.writtenAt > RECENT_CLIPBOARD_WRITE_TTL_MS) return ''
  return recentClipboardWrite.text
}

export async function readClipboardText() {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.readText) {
      return await navigator.clipboard.readText()
    }
  } catch {
    return ''
  }
  return ''
}

export async function readDesktopClipboardImage() {
  const bytes = await window.farmingDesktop?.readClipboardImage?.()
  if (!bytes) return null
  const data = new DataTransfer()
  data.items.add(new File([new Uint8Array(bytes)], 'Pasted image.png', { type: 'image/png' }))
  return data
}

/** The terminal menu has no browser paste event, so read its image and text together. */
export async function readTerminalMenuPaste(): Promise<string | DataTransfer> {
  if (navigator.clipboard?.read) {
    try {
      const items = await navigator.clipboard.read()
      const data = new DataTransfer()
      for (const item of items) {
        const type = item.types.find(type => type.startsWith('image/'))
        if (type) data.items.add(new File([await item.getType(type)], 'Pasted image.' + type.slice(6), { type }))
        if (item.types.includes('text/plain')) data.setData('text/plain', await (await item.getType('text/plain')).text())
      }
      return data.files.length ? data : data.getData('text/plain')
    } catch {
      // Some browsers grant text-only clipboard access.
    }
  }
  const text = await readClipboardText()
  return text || await readDesktopClipboardImage().catch(() => null) || ''
}

export function fallbackCopyText(text: string) {
  if (typeof document === 'undefined' || !text) return false

  const previousActiveElement = document.activeElement instanceof HTMLElement
    ? document.activeElement
    : null
  const selection = document.getSelection()
  const ranges = selection
    ? Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index))
    : []
  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.setAttribute('readonly', 'true')
  textarea.setAttribute('autocomplete', 'off')
  textarea.setAttribute('autocorrect', 'off')
  textarea.setAttribute('autocapitalize', 'none')
  textarea.setAttribute('spellcheck', 'false')
  textarea.setAttribute('data-lpignore', 'true')
  textarea.setAttribute('data-1p-ignore', 'true')
  textarea.setAttribute('data-bwignore', 'true')
  textarea.setAttribute('data-form-type', 'other')
  textarea.style.position = 'fixed'
  textarea.style.left = '0'
  textarea.style.top = '0'
  textarea.style.width = '1px'
  textarea.style.height = '1px'
  textarea.style.opacity = '0'
  textarea.style.fontSize = '16px'
  textarea.style.pointerEvents = 'none'
  document.body.appendChild(textarea)
  textarea.focus({ preventScroll: true })
  textarea.select()
  textarea.setSelectionRange(0, text.length)
  try {
    return document.execCommand('copy')
  } catch {
    return false
  } finally {
    textarea.remove()
    if (selection) {
      selection.removeAllRanges()
      ranges.forEach(range => selection.addRange(range))
    }
    previousActiveElement?.focus({ preventScroll: true })
  }
}

export async function writeClipboardText(text: string, signal?: AbortSignal) {
  if (!text || signal?.aborted) return false

  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      if (signal?.aborted) return false
      recentClipboardWrite = { text, writtenAt: Date.now() }
      return true
    }
  } catch {
    // Fall through to the textarea copy path.
  }

  // Native clipboard writes cannot be cancelled, but an obsolete operation
  // must not initiate another write through the fallback after it settles.
  if (signal?.aborted) return false
  const copied = fallbackCopyText(text)
  if (copied) recentClipboardWrite = { text, writtenAt: Date.now() }
  return copied
}

export async function writeClipboardRichText(text: string, html: string) {
  try {
    if (navigator.clipboard?.write && typeof ClipboardItem !== 'undefined') {
      await navigator.clipboard.write([new ClipboardItem({
        'text/plain': new Blob([text], { type: 'text/plain' }),
        'text/html': new Blob([html], { type: 'text/html' }),
      })])
      recentClipboardWrite = { text, writtenAt: Date.now() }
      return true
    }
  } catch {
    // Preserve the text payload if the browser rejects HTML clipboard writes.
  }
  return writeClipboardText(text)
}

export function createTerminalClipboardProvider(): TerminalClipboardProvider {
  return {
    readText(selection) {
      return selection === 'c' ? readClipboardText() : ''
    },
    writeText(selection, text) {
      return selection === 'c' ? writeClipboardText(text).then(() => undefined) : undefined
    },
  }
}
