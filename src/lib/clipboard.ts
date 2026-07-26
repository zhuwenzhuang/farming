export interface TerminalClipboardProvider {
  readText: (selection: string) => Promise<string> | string
  writeText: (selection: string, text: string) => Promise<void> | undefined
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
  textarea.style.left = '-9999px'
  textarea.style.top = '0'
  document.body.appendChild(textarea)
  textarea.focus()
  textarea.select()
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
    previousActiveElement?.focus()
  }
}

export async function writeClipboardText(text: string) {
  if (!text) return false

  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // Fall through to the textarea copy path.
  }

  return fallbackCopyText(text)
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
